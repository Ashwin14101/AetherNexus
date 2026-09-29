import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { MongoClient, Db } from 'mongodb';
import dotenv from 'dotenv';
import fetch from 'node-fetch';

// NOTE: mcpServer.js is deprecated. The system utilizes the inline dispatchMcpToolCall in orchestrator.js.
import {
  recalculateRouting,
  getDistributionMap,
  normalizeRegion,
  TrafficDistributionMap
} from './loadbalancer';
// @ts-ignore - Bypassing TS strict mode for compiled JS module
import { bootOrchestrator, executeEvaluationCycle, getTokenUsage, resumeSystem, getSystemPausedState } from './dist/orchestrator.js';
// @ts-ignore - Bypassing TS strict mode for patched JS export
import { setSharedSocket, setSharedDb } from './dist/egressBroadcaster.js';

type Region = 'usEastCluster' | 'euWestCluster' | 'apSouthCluster';

// IMP-02: Typed connection state instead of a bare boolean
type DbState = 'disconnected' | 'connecting' | 'connected' | 'error';

dotenv.config();

const app = express();
const httpServer = http.createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});
setSharedSocket(io);

const PORT = process.env.PORT || 4000;
const MONGODB_URI = process.env.MONGODB_URI;

// IMP-04: Chaos API token (optional in dev, required in prod)
const CHAOS_API_TOKEN = process.env.CHAOS_API_TOKEN;

// Microservice URLs
const MICROSERVICE_URLS: Record<string, string> = {
  usEastCluster: process.env.US_EAST_URL || 'http://localhost:3001',
  euWestCluster: process.env.EU_WEST_URL || 'http://localhost:3002',
  apSouthCluster: process.env.AP_SOUTH_URL || 'http://localhost:3004',
};

// Region name → JSON key mapping
const REGION_TO_KEY: Record<string, string> = {
  'US-East': 'usEastCluster',
  'EU-West': 'euWestCluster',
  'AP-South': 'apSouthCluster',
};

// Domain 2 camelCase cluster identifier → server_health region name mapping
const CLUSTER_ID_TO_REGION: Record<string, string> = {
  usEastCluster: 'US-East',
  euWestCluster: 'EU-West',
  apSouthCluster: 'AP-South',
};

// ── DISTRIBUTED NETWORK BRIDGES ──────────────────────────────────────────
async function mitigateCluster(region: Region): Promise<{ success: boolean; error?: string }> {
  const targetUrl = MICROSERVICE_URLS[region];
  console.log(`[Gateway] Routing mitigation command across the internet to ${targetUrl}`);
  try {
    const res = await fetch(`${targetUrl}/mitigate`, { method: 'POST' });
    if (!res.ok) throw new Error(`Node responded ${res.status}`);
    return { success: true };
  } catch (err: any) {
    console.error(`[Gateway] Failed to reach ${region} at ${targetUrl}: ${err.message}`);
    // IMP-09: Return failure instead of swallowing it
    return { success: false, error: err.message };
  }
}

async function injectFault(region: Region, faultType: string) {
  const targetUrl = MICROSERVICE_URLS[region];
  console.log(`[Gateway] Routing chaos command across the internet to ${targetUrl}`);
  try {
    await fetch(`${targetUrl}/inject-fault`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetClusterRegion: region, faultType })
    });
  } catch (err: any) {
    console.error(`[Gateway] Failed to reach ${region} at ${targetUrl}: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// IMP-04: Optional bearer token auth for chaos endpoints
function chaosAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!CHAOS_API_TOKEN) return next(); // no token configured → open in dev
  const auth = req.headers['authorization'] || '';
  if (auth === `Bearer ${CHAOS_API_TOKEN}`) return next();
  return res.status(401).json({ error: 'Unauthorized: invalid or missing CHAOS_API_TOKEN' });
}

// IMP-04: CORS — allow configured origins or wildcard in dev
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : ['*'];

app.use(cors({
  origin: allowedOrigins.includes('*') ? '*' : allowedOrigins,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json());

// ── IMP-02: Typed DB state machine ────────────────────────────────────────────
let db: Db;
let mongoClient: MongoClient | null = null;
let dbState: DbState = 'disconnected';
let dbConnectAttempt: Promise<void> | null = null;

// IMP-01: Create MongoDB indexes on startup
async function ensureIndexes(database: Db) {
  try {
    await database.collection('node_states').createIndex({ nodeId: 1 }, { unique: true });
    await database.collection('chaos_locks').createIndex({ region: 1 });
    await database.collection('server_health').createIndex({ region: 1, timestamp: -1 });
    await database.collection('ai_logs').createIndex({ timestamp: -1 });
    await database.collection('incident_log').createIndex({ eventTimestamp: -1 });
    await database.collection('chaos_audit_log').createIndex({ timestamp: -1 });
    await database.collection('sla_events').createIndex({ clusterId: 1, timestamp: -1 });
    console.log('[server] MongoDB indexes ensured.');
  } catch (err: any) {
    console.error('[server] Index creation error (non-fatal):', err.message);
  }
}

// IMP-08: adaptive broadcast interval state
let lastKnownThreatLevel: 'NOMINAL' | 'WARNING' | 'CRITICAL' = 'NOMINAL';
let broadcastIntervalHandle: NodeJS.Timeout | null = null;

function getAdaptiveIntervalMs(): number {
  if (lastKnownThreatLevel === 'CRITICAL') return 2000;
  if (lastKnownThreatLevel === 'WARNING') return 3000;
  return 8000; // NOMINAL — relax polling
}

async function startAdaptiveBroadcastLoop() {
  const tick = async () => {
    try {
      await ensureDbConnection();
      const liveData = await getLatestMetrics();
      if (liveData) {
        // Update threat level for adaptive interval
        const statuses = Object.values(liveData).map((m: any) => m.clusterOperationalStatus || m.status || 'STABLE');
        if (statuses.some(s => s === 'CRITICAL' || s === 'CRITICAL_NETWORK_DOWN')) lastKnownThreatLevel = 'CRITICAL';
        else if (statuses.some(s => s === 'DEGRADED')) lastKnownThreatLevel = 'WARNING';
        else lastKnownThreatLevel = 'NOMINAL';
        io.emit('live-metrics-stream', liveData);
      }
    } catch (err: any) {
      dbState = 'disconnected';
      console.error('[Socket] Broadcast error:', err.message);
    }
    // Reschedule at adaptive interval
    broadcastIntervalHandle = setTimeout(tick, getAdaptiveIntervalMs());
  };
  broadcastIntervalHandle = setTimeout(tick, 2000);
}

// Connect to MongoDB Atlas
async function connectDb(): Promise<void> {
  if (dbState === 'connected') return;
  if (dbState === 'connecting' && dbConnectAttempt) return dbConnectAttempt;

  if (!MONGODB_URI) {
    console.error('[server] Error: MONGODB_URI is not set in environment variables!');
    process.exit(1);
  }

  dbState = 'connecting';
  dbConnectAttempt = (async () => {
    try {
      // IMP-08: Close previous client before creating a new one (connection leak fix BUG-A08)
      if (mongoClient) {
        try { await mongoClient.close(); } catch (_) {}
        mongoClient = null;
      }
      mongoClient = new MongoClient(MONGODB_URI!);
      await mongoClient.connect();
      db = mongoClient.db();
      setSharedDb(db);
      dbState = 'connected';
      console.log('[server] Connected to MongoDB Atlas successfully.');

      // IMP-01: Ensure indexes
      await ensureIndexes(db);

      // Initialize routing table
      await recalculateRouting(db);

      // Boot AI engine
      await bootOrchestrator();
      console.log('[server] AI Orchestrator engine initialized and running.');

      // IMP-08: Start adaptive broadcast loop
      await startAdaptiveBroadcastLoop();

    } catch (err: any) {
      dbState = 'error';
      console.error('[server] MongoDB connection failed:', err.message);
      process.exit(1);
    }
  })();

  return dbConnectAttempt;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function ensureDbConnection(): Promise<boolean> {
  if (dbState !== 'connected') {
    await connectDb();
  }
  return dbState === 'connected';
}

async function getLatestMetrics() {
  if (!await ensureDbConnection()) return null;

  const results = await db.collection<any>('node_states').find({}).toArray();

  const infrastructureState: Record<string, any> = {
    usEastCluster: {
      currentLoadPercentage: 0,
      computeLoadPercentage: 0,  // BUG-A15/A16 FIX: Include all dual-schema fields
      metrics: { cpu: 0, ram: 0, activeConnections: 0, responseTimeMs: 0, timestamp: new Date().toISOString() },
      status: 'STABLE',
      clusterOperationalStatus: 'STABLE',
      volatileMemoryAllocationGb: 0,
    },
    euWestCluster: {
      currentLoadPercentage: 0,
      computeLoadPercentage: 0,
      metrics: { cpu: 0, ram: 0, activeConnections: 0, responseTimeMs: 0, timestamp: new Date().toISOString() },
      status: 'STABLE',
      clusterOperationalStatus: 'STABLE',
      volatileMemoryAllocationGb: 0,
    },
    apSouthCluster: {
      currentLoadPercentage: 0,
      computeLoadPercentage: 0,
      metrics: { cpu: 0, ram: 0, activeConnections: 0, responseTimeMs: 0, timestamp: new Date().toISOString() },
      status: 'STABLE',
      clusterOperationalStatus: 'STABLE',
      volatileMemoryAllocationGb: 0,
    },
  };

  for (const doc of results) {
    const key = doc.nodeId;
    if (key && infrastructureState[key]) {
      // BUG-A15/A16 FIX: Emit both schema variants for full compatibility
      infrastructureState[key] = {
        currentLoadPercentage: doc.currentLoadPercentage,
        computeLoadPercentage: doc.currentLoadPercentage,
        metrics: doc.metrics || { cpu: doc.currentLoadPercentage || 0, ram: 0, activeConnections: 0, responseTimeMs: 0, timestamp: new Date().toISOString() },
        status: doc.status,
        clusterOperationalStatus: doc.status,
        volatileMemoryAllocationGb: (doc.metrics?.ram || 0) / 1024,
        isQuarantined: doc.isQuarantined || false,
      };
    }
  }

  return infrastructureState;
}

// ── PWR-13: Kubernetes-Ready Health Probes ──────────────────────────────────

app.get('/healthz', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'alive', timestamp: new Date().toISOString() });
});

app.get('/readyz', async (_req: Request, res: Response) => {
  if (dbState !== 'connected') {
    return res.status(503).json({ status: 'not-ready', reason: 'MongoDB not connected', dbState });
  }
  return res.status(200).json({ status: 'ready', dbState, timestamp: new Date().toISOString() });
});

app.get('/metrics', (_req: Request, res: Response) => {
  // Prometheus text format
  res.setHeader('Content-Type', 'text/plain');
  res.send([
    `# HELP aethernexus_db_state 1 if connected, 0 otherwise`,
    `aethernexus_db_connected ${dbState === 'connected' ? 1 : 0}`,
    `# HELP aethernexus_threat_level Current threat level (0=nominal,1=warning,2=critical)`,
    `aethernexus_threat_level ${lastKnownThreatLevel === 'CRITICAL' ? 2 : lastKnownThreatLevel === 'WARNING' ? 1 : 0}`,
  ].join('\n'));
});

// ── IMP-14: GET /api/status ─────────────────────────────────────────────────

app.get('/api/status', async (_req: Request, res: Response) => {
  try {
    const metrics = await getLatestMetrics();
    const distribution = dbState === 'connected' ? await getDistributionMap(db) : null;
    const tokenUsage = getTokenUsage ? getTokenUsage() : null;
    return res.json({
      dbState,
      threatLevel: lastKnownThreatLevel,
      clusters: metrics,
      trafficDistribution: distribution,
      tokenUsage,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ── PWR-19: AI Token Usage ──────────────────────────────────────────────────
app.get('/api/ai/usage', (_req: Request, res: Response) => {
  const usage = getTokenUsage ? getTokenUsage() : { promptTokens: 0, completionTokens: 0, cycles: 0, estimatedCostUSD: 0 };
  return res.json(usage);
});

// ── PWR-03: System Resume endpoint ─────────────────────────────────────────
app.post('/api/system/resume', async (_req: Request, res: Response) => {
  // Signal resume by clearing the paused state via a MongoDB flag
  try {
    if (await ensureDbConnection()) {
      await db.collection<any>('orchestrator_state').updateOne(
        { _id: 'system' as any },
        { $set: { isSystemPaused: false, resumedAt: new Date() } },
        { upsert: true }
      );
      // Clear the in-memory orchestrator pause flag
      resumeSystem();
    }
    return res.json({ success: true, message: 'System resume signal sent. AI will resume on next cycle.' });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Telemetry API ───────────────────────────────────────────────────────────

app.get('/api/telemetry', async (req: Request, res: Response) => {
  try {
    const infrastructureState = await getLatestMetrics();
    if (!infrastructureState) {
      return res.status(503).json({ error: 'MongoDB connection not ready' });
    }
    const isSystemPaused = getSystemPausedState ? getSystemPausedState() : false;
    return res.json({ infrastructureState, isSystemPaused });
  } catch (err: any) {
    console.error('[server] Telemetry fetch error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch telemetry' });
  }
});

// ── Mitigate ────────────────────────────────────────────────────────────────

app.post('/api/mitigate', async (req: Request, res: Response) => {
  const { targetClusterRegion, cacheLayerNamespace } = req.body || {};

  if (!targetClusterRegion || !cacheLayerNamespace) {
    return res.status(400).json({
      success: false,
      message: 'Missing targetClusterRegion or cacheLayerNamespace',
    });
  }

  try {
    // BUG-A06 FIX: Always normalize to camelCase before writing nodeId
    let clusterId: string = targetClusterRegion;
    const rLow = (clusterId || '').toLowerCase();
    if (rLow.includes('east')) clusterId = 'usEastCluster';
    else if (rLow.includes('west')) clusterId = 'euWestCluster';
    else if (rLow.includes('south')) clusterId = 'apSouthCluster';

    let normRegion: string;
    if (clusterId === 'usEastCluster') normRegion = 'US-East';
    else if (clusterId === 'euWestCluster') normRegion = 'EU-West';
    else normRegion = 'AP-South';

    if (await ensureDbConnection()) {
      const existingNode = await db.collection<any>('node_states').findOne({ nodeId: clusterId });
      if (existingNode?.status === 'HEALING' && existingNode?.currentAction === 'CLEAR_CACHE') {
        return res.json({ success: true, message: 'Mitigation already running. Duplicate suppressed.' });
      }
      await db.collection<any>('node_states').updateOne(
        { nodeId: clusterId },
        { $set: { status: 'HEALING', currentAction: 'CLEAR_CACHE', isQuarantined: false, updatedAt: new Date() } },
        { upsert: true }
      );
    }

    // Clear chaos lock
    if (await ensureDbConnection()) {
      await db.collection<any>('chaos_locks').deleteOne({ region: normRegion });
    }

    // IMP-09: Propagate mitigateCluster failure
    const mitigateResult = await mitigateCluster(clusterId as Region);

    if (await ensureDbConnection()) {
      if (mitigateResult.success) {
        await db.collection<any>('node_states').updateOne(
          { nodeId: clusterId },
          { $set: { status: 'STABLE', currentAction: null, isQuarantined: false, currentLoadPercentage: 25.0, metrics: { cpu: 25.0, ram: 4500, activeConnections: 150, responseTimeMs: 20, timestamp: new Date().toISOString() }, updatedAt: new Date() } },
          { upsert: true }
        );
      } else {
        // Node unreachable — mark as error, don't falsely report STABLE
        await db.collection<any>('node_states').updateOne(
          { nodeId: clusterId },
          { $set: { status: 'CRITICAL', currentAction: null, isQuarantined: true, updatedAt: new Date() } },
          { upsert: true }
        );
      }
      await recalculateRouting(db);
    }

    // PWR-15: Audit log
    if (await ensureDbConnection()) {
      await db.collection<any>('chaos_audit_log').insertOne({
        timestamp: new Date(), endpoint: '/api/mitigate', region: clusterId,
        faultType: 'MITIGATE', originIp: req.ip, result: mitigateResult.success ? 'success' : 'node_unreachable',
      });
    }

    return res.json({
      success: mitigateResult.success,
      message: mitigateResult.success
        ? `Mitigation successful on ${targetClusterRegion}.`
        : `Mitigation command sent but node was unreachable: ${mitigateResult.error}`,
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: `Internal error: ${err.message}` });
  }
});

// ── Rebalance ───────────────────────────────────────────────────────────────

app.post('/api/rebalance', async (req: Request, res: Response) => {
  const { sourceRegion, targetRegion, trafficShiftPercentage } = req.body || {};

  if (!sourceRegion || !targetRegion || typeof trafficShiftPercentage !== 'number') {
    return res.status(400).json({ success: false, message: 'Missing or invalid payload.' });
  }

  if (sourceRegion === targetRegion) {
    return res.status(400).json({ success: false, message: 'sourceRegion and targetRegion cannot be the same' });
  }

  const resolvedSourceRegion = CLUSTER_ID_TO_REGION[sourceRegion];
  const resolvedTargetRegion = CLUSTER_ID_TO_REGION[targetRegion];

  if (!resolvedSourceRegion || !resolvedTargetRegion) {
    return res.status(400).json({
      success: false,
      message: `Unrecognized cluster identifier. Valid values: usEastCluster, euWestCluster, apSouthCluster.`,
    });
  }

  if (trafficShiftPercentage < 1 || trafficShiftPercentage > 100) {
    return res.status(400).json({ success: false, message: `trafficShiftPercentage must be between 1 and 100.` });
  }

  try {
    const currentDistribution = await getDistributionMap(db);
    const regionToDistKey: Record<string, keyof typeof currentDistribution> = {
      'US-East': 'US-East-1', 'EU-West': 'EU-West-1', 'AP-South': 'AP-South-1',
    };
    const sourceDistKey = regionToDistKey[resolvedSourceRegion];
    const targetDistKey = regionToDistKey[resolvedTargetRegion];

    // IMP-18: Pre-flight validation — shift can't exceed current source weight
    if (trafficShiftPercentage > currentDistribution[sourceDistKey]) {
      return res.status(400).json({
        success: false,
        message: `trafficShiftPercentage (${trafficShiftPercentage}) exceeds current source weight (${currentDistribution[sourceDistKey]}). Cannot shift more traffic than the source currently handles.`,
      });
    }

    const updatedDistribution = { ...currentDistribution };
    const shiftAmount = Math.min(trafficShiftPercentage, updatedDistribution[sourceDistKey]);
    const mutatedSourceWeight = parseFloat(Math.max(0, updatedDistribution[sourceDistKey] - shiftAmount).toFixed(4));
    const mutatedTargetWeight = parseFloat(Math.min(100, updatedDistribution[targetDistKey] + shiftAmount).toFixed(4));
    const availableKeys = (Object.keys(updatedDistribution) as Array<keyof typeof updatedDistribution>).filter(k => k !== sourceDistKey && k !== targetDistKey);
    const thirdDistKey = availableKeys[0];
    const derivedThirdWeight = parseFloat((100 - mutatedSourceWeight - mutatedTargetWeight).toFixed(4));

    updatedDistribution[sourceDistKey] = mutatedSourceWeight;
    updatedDistribution[targetDistKey] = mutatedTargetWeight;
    updatedDistribution[thirdDistKey] = Math.max(0, derivedThirdWeight); // clamp to 0

    if (await ensureDbConnection()) {
      await db.collection<any>('load_balancer_state').updateOne(
        { _id: 'current_state' },
        { $set: { traffic_distribution_map: updatedDistribution, updatedAt: new Date() } },
        { upsert: true }
      );
    }

    return res.json({ success: true, message: `Traffic rebalanced.`, traffic_distribution_map: updatedDistribution });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: 'Internal error applying rebalance directive.' });
  }
});

// ── Chaos Endpoints ──────────────────────────────────────────────────────────

// PWR-15: Helper to write chaos audit log
async function writeChaosAudit(endpoint: string, region: string, faultType: string, originIp: string, result: string) {
  if (dbState !== 'connected') return;
  try {
    await db.collection<any>('chaos_audit_log').insertOne({ timestamp: new Date(), endpoint, region, faultType, originIp, result });
  } catch (_) {}
}

app.post('/api/chaos/inject-fault', chaosAuthMiddleware, async (req: Request, res: Response) => {
  const { targetClusterRegion, faultType } = req.body;
  if (!targetClusterRegion || !faultType) {
    return res.status(400).json({ error: 'Missing targetClusterRegion or faultType' });
  }

  // BUG-A06 FIX: Always normalize targetClusterRegion to camelCase ID before writing nodeId
  let clusterId = targetClusterRegion as string;
  const rLow = clusterId.toLowerCase();
  if (rLow.includes('east')) clusterId = 'usEastCluster';
  else if (rLow.includes('west')) clusterId = 'euWestCluster';
  else if (rLow.includes('south')) clusterId = 'apSouthCluster';

  try {
    await injectFault(clusterId as Region, faultType);
    if (await ensureDbConnection()) {
      let metricDoc: any = {
        timestamp: new Date(),
        region: normalizeRegion(targetClusterRegion) ?? targetClusterRegion,
      };
      if (faultType === 'NETWORK_DROPOUT') {
        metricDoc = { ...metricDoc, computeLoadPercentage: 0.0, volatileMemoryAllocationGb: 0.0, networkPackets: 0, clusterOperationalStatus: 'CRITICAL_NETWORK_DOWN' };
      } else if (faultType === 'MODERATE_LOAD') {
        metricDoc = { ...metricDoc, computeLoadPercentage: 82.0, volatileMemoryAllocationGb: 8.5, clusterOperationalStatus: 'DEGRADED' };
      } else {
        metricDoc = { ...metricDoc, computeLoadPercentage: 98.0, volatileMemoryAllocationGb: 14.0, clusterOperationalStatus: 'CRITICAL' };
      }
      await db.collection<any>('node_states').updateOne(
        { nodeId: clusterId },  // BUG-A06 FIX: use normalized clusterId
        { $set: { status: metricDoc.clusterOperationalStatus, isQuarantined: true, currentLoadPercentage: metricDoc.computeLoadPercentage, metrics: { cpu: metricDoc.computeLoadPercentage, ram: metricDoc.volatileMemoryAllocationGb * 1024, activeConnections: metricDoc.networkPackets ? 150 : 0, responseTimeMs: 20, timestamp: new Date().toISOString() }, updatedAt: new Date() } },
        { upsert: true }
      );
      await recalculateRouting(db);

      // PWR-15: Audit log
      await writeChaosAudit('/api/chaos/inject-fault', clusterId, faultType, req.ip ?? '', 'success');
    }

    executeEvaluationCycle(true).catch((err: any) => console.error('[AI] Forced evaluation failed:', err));
    return res.json({ success: true, message: `Successfully injected ${faultType} into ${clusterId}` });
  } catch (err: any) {
    return res.status(500).json({ error: 'Failed to inject fault' });
  }
});

app.post('/api/chaos/spike-cpu', chaosAuthMiddleware, async (req: Request, res: Response) => {
  if (!await ensureDbConnection()) return res.status(503).json({ error: 'Database connection not ready' });

  const { region } = req.body;
  if (!region) return res.status(400).json({ error: 'Missing "region" parameter in request body' });

  // BUG-A05 FIX: Handle null return from normalizeRegion
  const normRegion = normalizeRegion(region);
  if (!normRegion) return res.status(400).json({ error: `Unrecognized region: ${region}` });

  try {
    const metricDoc = { timestamp: new Date(), region: normRegion, computeLoadPercentage: 99.8, volatileMemoryAllocationGb: 12.0, clusterOperationalStatus: 'CRITICAL' };
    await db.collection<any>('chaos_locks').updateOne(
      { region: normRegion },
      { $set: { type: 'cpu_lock', computeLoadPercentage: 99.8, updatedAt: new Date() } },
      { upsert: true }
    );

    const clusterId = normRegion === 'US-East' ? 'usEastCluster' : normRegion === 'EU-West' ? 'euWestCluster' : 'apSouthCluster';
    await db.collection<any>('node_states').updateOne(
      { nodeId: clusterId },
      { $set: { status: 'CRITICAL', currentLoadPercentage: 99.8, metrics: { cpu: 99.8, ram: 12.0 * 1024, activeConnections: 150, responseTimeMs: 20, timestamp: new Date().toISOString() }, isQuarantined: true, updatedAt: new Date() } },
      { upsert: true }
    );

    const distribution = await recalculateRouting(db);
    await writeChaosAudit('/api/chaos/spike-cpu', clusterId, 'CPU_SPIKE', req.ip ?? '', 'success');

    executeEvaluationCycle(true).catch((err: any) => console.error('[AI] Forced evaluation failed:', err));
    return res.json({ success: true, message: `CPU spiked to 99.8% for region ${normRegion}`, latestMetric: metricDoc, traffic_distribution_map: distribution });
  } catch (err: any) {
    return res.status(500).json({ error: 'Failed to apply CPU spike' });
  }
});

app.post('/api/chaos/kill-network', chaosAuthMiddleware, async (req: Request, res: Response) => {
  if (!await ensureDbConnection()) return res.status(503).json({ error: 'Database connection not ready' });

  const { region = 'US-East-1' } = req.body;

  // BUG-A05 FIX: Handle null return
  const normRegion = normalizeRegion(region);
  if (!normRegion) return res.status(400).json({ error: `Unrecognized region: ${region}` });

  try {
    const metricDoc = { timestamp: new Date(), region: normRegion, computeLoadPercentage: 0.0, volatileMemoryAllocationGb: 0.0, networkPackets: 0, clusterOperationalStatus: 'CRITICAL_NETWORK_DOWN' };
    await db.collection<any>('chaos_locks').updateOne(
      { region: normRegion },
      { $set: { type: 'network_lock', networkPackets: 0, clusterOperationalStatus: 'CRITICAL_NETWORK_DOWN', updatedAt: new Date() } },
      { upsert: true }
    );

    const clusterId = normRegion === 'US-East' ? 'usEastCluster' : normRegion === 'EU-West' ? 'euWestCluster' : 'apSouthCluster';
    await db.collection<any>('node_states').updateOne(
      { nodeId: clusterId },
      { $set: { status: 'CRITICAL_NETWORK_DOWN', currentLoadPercentage: 0, metrics: { cpu: 0, ram: 0, activeConnections: 0, responseTimeMs: 20, timestamp: new Date().toISOString() }, isQuarantined: true, updatedAt: new Date() } },
      { upsert: true }
    );

    const distribution = await recalculateRouting(db);
    await writeChaosAudit('/api/chaos/kill-network', clusterId, 'NETWORK_KILL', req.ip ?? '', 'success');

    executeEvaluationCycle(true).catch((err: any) => console.error('[AI] Forced evaluation failed:', err));
    return res.json({ success: true, message: `Network killed for region ${normRegion}.`, latestMetric: metricDoc, traffic_distribution_map: distribution });
  } catch (err: any) {
    return res.status(500).json({ error: 'Failed to kill network' });
  }
});

// ── PWR-05: Cascade Chaos Endpoint ──────────────────────────────────────────

app.post('/api/chaos/cascade', chaosAuthMiddleware, async (req: Request, res: Response) => {
  const { scenario, steps } = req.body;

  // Named scenario presets
  const namedScenarios: Record<string, Array<{ region: string; faultType: string; delayMs: number }>> = {
    'full-cascade': [
      { region: 'US-East-1', faultType: 'CPU_SPIKE', delayMs: 0 },
      { region: 'EU-West-1', faultType: 'NETWORK_KNOCKOUT', delayMs: 5000 },
      { region: 'AP-South-1', faultType: 'CPU_SPIKE', delayMs: 10000 },
    ],
    'rolling-degradation': [
      { region: 'US-East-1', faultType: 'MODERATE_LOAD', delayMs: 0 },
      { region: 'EU-West-1', faultType: 'MODERATE_LOAD', delayMs: 8000 },
    ],
  };

  const chaosSteps = scenario && namedScenarios[scenario] ? namedScenarios[scenario] : steps;

  if (!Array.isArray(chaosSteps) || chaosSteps.length === 0) {
    return res.status(400).json({ error: 'Provide a named "scenario" or a "steps" array.' });
  }

  res.json({ success: true, message: `Cascade scenario started: ${chaosSteps.length} steps queued.`, steps: chaosSteps });

  // Execute steps in the background
  (async () => {
    for (const step of chaosSteps) {
      await new Promise(r => setTimeout(r, step.delayMs));
      try {
        const normRegion = normalizeRegion(step.region) ?? step.region;
        const clusterId = normRegion === 'US-East' ? 'usEastCluster' : normRegion === 'EU-West' ? 'euWestCluster' : 'apSouthCluster';
        if (await ensureDbConnection()) {
          await db.collection<any>('chaos_locks').updateOne({ region: normRegion }, { $set: { type: 'cascade_lock', updatedAt: new Date() } }, { upsert: true });
          await db.collection<any>('node_states').updateOne(
            { nodeId: clusterId },
            { $set: { status: 'CRITICAL', currentLoadPercentage: 99.8, isQuarantined: true, metrics: { cpu: 99.8, ram: 12000, activeConnections: 0, responseTimeMs: 20, timestamp: new Date().toISOString() }, updatedAt: new Date() } },
            { upsert: true }
          );
          await recalculateRouting(db);
        }
        executeEvaluationCycle(true).catch(() => {});
        console.log(`[cascade] Step fired: ${step.faultType} on ${step.region}`);
      } catch (e: any) {
        console.error(`[cascade] Step failed: ${e.message}`);
      }
    }
  })();
});

// ── PWR-08: Chaos Scheduling ─────────────────────────────────────────────────

app.post('/api/chaos/schedule', chaosAuthMiddleware, async (req: Request, res: Response) => {
  const { region, faultType, cronExpression, description } = req.body;
  if (!region || !faultType || !cronExpression) {
    return res.status(400).json({ error: 'Missing required fields: region, faultType, cronExpression' });
  }
  try {
    if (await ensureDbConnection()) {
      const result = await db.collection<any>('chaos_schedules').insertOne({
        region, faultType, cronExpression, description: description || '',
        createdAt: new Date(), active: true,
      });
      return res.json({ success: true, scheduleId: result.insertedId, message: 'Chaos schedule saved. Implement a cron runner to activate it.' });
    }
    return res.status(503).json({ error: 'DB not ready' });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ── PWR-15: Chaos Audit Log endpoint ────────────────────────────────────────

app.get('/api/chaos/audit', async (_req: Request, res: Response) => {
  if (!await ensureDbConnection()) return res.status(503).json({ error: 'DB not ready' });
  try {
    const logs = await db.collection<any>('chaos_audit_log').find({}).sort({ timestamp: -1 }).limit(100).toArray();
    return res.json({ logs });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ── PWR-09: SLA endpoint ─────────────────────────────────────────────────────

app.get('/api/sla', async (_req: Request, res: Response) => {
  if (!await ensureDbConnection()) return res.status(503).json({ error: 'DB not ready' });
  try {
    const clusters = ['usEastCluster', 'euWestCluster', 'apSouthCluster'];
    const now = Date.now();
    const windows = { '24h': 24 * 3600 * 1000, '7d': 7 * 24 * 3600 * 1000, '30d': 30 * 24 * 3600 * 1000 };
    const sla: Record<string, any> = {};

    for (const clusterId of clusters) {
      sla[clusterId] = {};
      for (const [label, ms] of Object.entries(windows)) {
        const events = await db.collection<any>('sla_events')
          .find({ clusterId, timestamp: { $gte: new Date(now - ms) } }).toArray();
        const downMs = events.filter((e: any) => e.type === 'down').reduce((acc: number, e: any) => acc + (e.durationMs || 0), 0);
        const uptime = Math.max(0, ((ms - downMs) / ms) * 100);
        sla[clusterId][label] = parseFloat(uptime.toFixed(3));
      }
    }

    return res.json({ sla, timestamp: new Date().toISOString() });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ── PWR-01: Incident Timeline ────────────────────────────────────────────────

app.get('/api/incidents', async (req: Request, res: Response) => {
  if (!await ensureDbConnection()) return res.status(503).json({ error: 'DB not ready' });
  try {
    const { from, to, limit = '100' } = req.query as Record<string, string>;
    const filter: Record<string, any> = {};
    if (from) filter.eventTimestamp = { $gte: new Date(from) };
    if (to) filter.eventTimestamp = { ...(filter.eventTimestamp || {}), $lte: new Date(to) };
    const incidents = await db.collection<any>('incident_log')
      .find(filter).sort({ eventTimestamp: -1 }).limit(parseInt(limit, 10)).toArray();
    return res.json({ incidents });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Chaos Reset ───────────────────────────────────────────────────────────────

app.post('/api/chaos/reset', chaosAuthMiddleware, async (req: Request, res: Response) => {
  if (!await ensureDbConnection()) return res.status(503).json({ error: 'Database connection not ready' });
  try {
    await db.collection<any>('chaos_locks').deleteMany({});
    const regions = ['US-East', 'EU-West', 'AP-South'];
    for (const r of regions) {
      const clusterId = r === 'US-East' ? 'usEastCluster' : r === 'EU-West' ? 'euWestCluster' : 'apSouthCluster';
      await db.collection<any>('node_states').updateOne(
        { nodeId: clusterId },
        { $set: { status: 'STABLE', currentLoadPercentage: 25.0, metrics: { cpu: 25.0, ram: 4500, activeConnections: 150, responseTimeMs: 20, timestamp: new Date().toISOString() }, isQuarantined: false, updatedAt: new Date() } },
        { upsert: true }
      );
    }
    const distribution = await recalculateRouting(db);
    await writeChaosAudit('/api/chaos/reset', 'all', 'RESET', req.ip ?? '', 'success');
    return res.json({ success: true, message: 'All system chaos locks reset.', traffic_distribution_map: distribution });
  } catch (err: any) {
    return res.status(500).json({ error: 'Failed to reset chaos status' });
  }
});

// ── PWR-17: Gateway Routing Policy ───────────────────────────────────────────

app.post('/api/gateway/routing-policy', chaosAuthMiddleware, async (req: Request, res: Response) => {
  const { policy, blueRegion, greenRegion, canaryPercentage } = req.body;
  const validPolicies = ['auto', 'blue-green', 'canary', 'weighted'];
  if (!policy || !validPolicies.includes(policy)) {
    return res.status(400).json({ error: `Invalid policy. Valid: ${validPolicies.join(', ')}` });
  }

  if (!await ensureDbConnection()) return res.status(503).json({ error: 'DB not ready' });

  let distribution: TrafficDistributionMap = { 'US-East-1': 33.3, 'EU-West-1': 33.3, 'AP-South-1': 33.4 };

  if (policy === 'blue-green' && blueRegion) {
    // 100% to blue, 0% to others
    distribution = { 'US-East-1': 0, 'EU-West-1': 0, 'AP-South-1': 0 };
    const normBlue = normalizeRegion(blueRegion);
    const blueKey = normBlue === 'US-East' ? 'US-East-1' : normBlue === 'EU-West' ? 'EU-West-1' : 'AP-South-1';
    distribution[blueKey] = 100;
  } else if (policy === 'canary' && blueRegion && greenRegion) {
    distribution = { 'US-East-1': 0, 'EU-West-1': 0, 'AP-South-1': 0 };
    const pct = Math.min(Math.max(canaryPercentage || 5, 1), 99);
    const normBlue = normalizeRegion(blueRegion);
    const normGreen = normalizeRegion(greenRegion);
    const blueKey = normBlue === 'US-East' ? 'US-East-1' : normBlue === 'EU-West' ? 'EU-West-1' : 'AP-South-1';
    const greenKey = normGreen === 'US-East' ? 'US-East-1' : normGreen === 'EU-West' ? 'EU-West-1' : 'AP-South-1';
    distribution[greenKey] = pct;
    distribution[blueKey] = 100 - pct;
  }

  await db.collection<any>('load_balancer_state').updateOne(
    { _id: 'current_state' },
    { $set: { traffic_distribution_map: distribution, policy, updatedAt: new Date() } },
    { upsert: true }
  );

  return res.json({ success: true, policy, distribution });
});

// ── Infrastructure Telemetry ──────────────────────────────────────────────────

app.get('/api/infrastructure/telemetry', async (req: Request, res: Response) => {
  if (!await ensureDbConnection()) return res.status(503).json({ error: 'Database connection not ready' });
  try {
    const regionKeys = ['US-East', 'EU-West', 'AP-South'];
    const telemetryArrays: Record<string, any[]> = {};
    for (const r of regionKeys) {
      const records = await db.collection<any>('server_health')
        .find({ region: r }).sort({ timestamp: -1 }).limit(10).toArray();
      const outputKey = r === 'US-East' ? 'US-East-1' : r === 'EU-West' ? 'EU-West-1' : 'AP-South-1';
      telemetryArrays[outputKey] = records.reverse();
    }
    const distribution = await getDistributionMap(db);
    return res.json({ telemetry: telemetryArrays, traffic_distribution_map: distribution });
  } catch (err: any) {
    return res.status(500).json({ error: 'Failed to fetch telemetry' });
  }
});

// ── IMP-07: Graceful Shutdown ────────────────────────────────────────────────

async function gracefulShutdown(signal: string) {
  console.log(`[server] ${signal} received — initiating graceful shutdown...`);
  if (broadcastIntervalHandle) clearTimeout(broadcastIntervalHandle);
  io.emit('aethernexus-telemetry-broadcast', {
    eventTimestamp: new Date().toISOString(),
    principalArchitect: 'AetherNexus-Core',
    executedMitigationAction: 'Server shutting down — connection will close.',
    incidentThreatLevelColor: 'WARNING_AMBER',
  });
  httpServer.close(() => console.log('[server] HTTP server closed.'));
  if (mongoClient) {
    await mongoClient.close();
    console.log('[server] MongoDB connection closed.');
  }
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ── Boot ──────────────────────────────────────────────────────────────────────

async function start() {
  await connectDb();
  httpServer.listen(PORT, () => {
    console.log(`[chaos-server] Unified Admin & Telemetry server running on port ${PORT}`);
  });
}

start();
