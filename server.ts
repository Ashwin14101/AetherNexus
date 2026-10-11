
// Max documents retained per collection in the in-memory fallback store
// (prevents unbounded memory growth from the 1.5s telemetry broadcast loop)
const IN_MEMORY_COLLECTION_CAPS: Record<string, number> = {
  server_health: 2400, // ~13min of 1.5s snapshots per region
  ai_logs: 500,
  chaos_audit_log: 500,
  incident_log: 500,
  sla_events: 500,
};

// Match helper supporting a subset of MongoDB query operators used by this app
function matchQuery(doc: any, query: any): boolean {
  for (const [k, v] of Object.entries(query)) {
    if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
      const ops = v as any;
      if ('$gte' in ops && !(doc[k] >= (ops.$gte as any))) return false;
      if ('$lte' in ops && !(doc[k] <= (ops.$lte as any))) return false;
      if ('$ne' in ops && doc[k] === ops.$ne) return false;
      if (!('$gte' in ops) && !('$lte' in ops) && !('$ne' in ops) && doc[k] !== v) return false;
      continue;
    }
    if (doc[k] !== v) return false;
  }
  return true;
}

function createInMemoryDb(): any {
  const store: Record<string, any[]> = {
    node_states: [
      {
        nodeId: "usEastCluster",
        currentLoadPercentage: 25.0,
        status: "STABLE",
        clusterOperationalStatus: "STABLE",
        isQuarantined: false,
        metrics: { cpu: 25.0, ram: 4096, activeConnections: 120, responseTimeMs: 15, timestamp: new Date().toISOString() },
        updatedAt: new Date(),
      },
      {
        nodeId: "euWestCluster",
        currentLoadPercentage: 28.0,
        status: "STABLE",
        clusterOperationalStatus: "STABLE",
        isQuarantined: false,
        metrics: { cpu: 28.0, ram: 4200, activeConnections: 110, responseTimeMs: 18, timestamp: new Date().toISOString() },
        updatedAt: new Date(),
      },
      {
        nodeId: "apSouthCluster",
        currentLoadPercentage: 22.0,
        status: "STABLE",
        clusterOperationalStatus: "STABLE",
        isQuarantined: false,
        metrics: { cpu: 22.0, ram: 3800, activeConnections: 95, responseTimeMs: 12, timestamp: new Date().toISOString() },
        updatedAt: new Date(),
      },
    ],
    load_balancer_state: [
      {
        _id: "current_state",
        traffic_distribution_map: { "US-East-1": 33.3, "EU-West-1": 33.3, "AP-South-1": 33.4 },
        updatedAt: new Date(),
      },
    ],
    chaos_locks: [],
    server_health: [],
    ai_logs: [],
    incident_log: [],
    chaos_audit_log: [],
    sla_events: [],
  };

  return {
    collection(name: string) {
      if (!store[name]) store[name] = [];
      const col = store[name];
      return {
        createIndex: async () => {},
        find: (query: any = {}) => {
          let cached: any[] | null = null;
          const materialize = () => {
            if (!cached) cached = col.filter((doc) => matchQuery(doc, query));
            return cached;
          };
          const cursor = {
            sort: function (spec: any = {}) {
              const entries = Object.entries(spec);
              if (entries.length > 0) {
                const [key, dir] = entries[0];
                materialize().sort((a: any, b: any) => {
                  const cmp = a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0;
                  return dir === -1 ? -cmp : cmp;
                });
              }
              return cursor;
            },
            limit: function (n: number) { cached = materialize().slice(0, n); return cursor; },
            toArray: async () => materialize(),
          };
          return cursor;
        },
        findOne: async (query: any = {}) => {
          return col.find((doc) => matchQuery(doc, query)) || null;
        },
        updateOne: async (query: any, update: any, options: any = {}) => {
          let item = col.find((doc) => matchQuery(doc, query));
          if (!item && options.upsert) {
            item = { ...query };
            col.push(item);
          }
          if (item && update.$set) {
            Object.assign(item, update.$set);
          }
          return { acknowledged: true, modifiedCount: item ? 1 : 0 };
        },
        insertOne: async (doc: any) => {
          col.push({ ...doc, _id: doc._id || String(Date.now() + Math.random()) });
          const capLimit = IN_MEMORY_COLLECTION_CAPS[name];
          if (capLimit && col.length > capLimit) col.splice(0, col.length - capLimit);
          return { acknowledged: true, insertedId: doc._id };
        },
        insertMany: async (docs: any[]) => {
          docs.forEach((d) => col.push(d));
          return { acknowledged: true };
        },
        deleteOne: async (query: any = {}) => {
          const idx = col.findIndex((doc) => matchQuery(doc, query));
          if (idx !== -1) col.splice(idx, 1);
          return { acknowledged: true, deletedCount: idx !== -1 ? 1 : 0 };
        },
        deleteMany: async (query: any = {}) => {
          if (Object.keys(query).length === 0) {
            col.length = 0;
          } else {
            for (let i = col.length - 1; i >= 0; i--) {
              if (matchQuery(col[i], query)) col.splice(i, 1);
            }
          }
          return { acknowledged: true };
        },
        aggregate: (pipeline: any[] = []) => ({
          toArray: async () => col.slice(-10),
        }),
      };
    },
  };
}

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import http from 'http';
import path from 'path';
import fs from 'fs';
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
  console.log(`[Gateway] Routing mitigation command to ${targetUrl}`);
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000); // 3s timeout
    const res = await fetch(`${targetUrl}/mitigate`, { method: 'POST', signal: controller.signal as any });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`Node responded ${res.status}`);
    return { success: true };
  } catch (err: any) {
    console.error(`[Gateway] Failed to reach ${region} at ${targetUrl}: ${err.message}`);
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

// ── PWR-01/PWR-09: Incident timeline + SLA outage tracking ─────────────────────
// These were dead data flows: incident_log and sla_events were queried by
// /api/incidents and /api/sla but never written. Now every fault injection
// opens an outage record and writes an incident; reset/mitigate closes them.
async function recordIncident(clusterId: string, region: string, faultType: string, severity: 'WARNING_AMBER' | 'CRITICAL_RED' | 'NOMINAL_GREEN', action: string) {
  if (dbState !== 'connected') return;
  try {
    await db.collection<any>('incident_log').insertOne({
      eventTimestamp: new Date(),
      clusterId,
      region,
      faultType,
      severity,
      action,
    });
  } catch (_) {}
}

async function openSlaOutage(clusterId: string, region: string, faultType: string) {
  if (dbState !== 'connected') return;
  try {
    await db.collection<any>('sla_events').insertOne({
      clusterId,
      region,
      type: 'down',
      faultType,
      timestamp: new Date(),
      resolvedAt: null,
      durationMs: null, // set when the outage is closed by reset/mitigation
    });
  } catch (_) {}
}

async function closeOpenOutages(clusterId: string | null, reason: string) {
  if (dbState !== 'connected') return;
  try {
    const filter: Record<string, any> = { resolvedAt: null };
    if (clusterId) filter.clusterId = clusterId;
    const openOutages = await db.collection<any>('sla_events').find(filter).toArray();
    const now = Date.now();
    for (const outage of openOutages) {
      const started = outage.timestamp ? new Date(outage.timestamp).getTime() : now;
      await db.collection<any>('sla_events').updateOne(
        { _id: outage._id },
        { $set: { resolvedAt: new Date(), durationMs: Math.max(0, now - started), resolution: reason } }
      );
    }
  } catch (_) {}
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
  if (lastKnownThreatLevel === 'CRITICAL') return 800;
  if (lastKnownThreatLevel === 'WARNING') return 1200;
  return 1500; // Fast 1.5s updates so logs & dashboard never lag!
}

export async function broadcastLiveMetricsNow() {
  try {
    if (await ensureDbConnection()) {
      const liveData = await getLatestMetrics();
      if (liveData) {
        io.emit('live-metrics-stream', liveData);
      }
    }
  } catch (_) {}
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

        // Record health snapshot into server_health for live diagnostics charts
        const regionMap: Record<string, string> = { usEastCluster: 'US-East', euWestCluster: 'EU-West', apSouthCluster: 'AP-South' };
        for (const [nodeId, node] of Object.entries(liveData) as any) {
          const region = regionMap[nodeId];
          if (region) {
            await db.collection<any>('server_health').insertOne({
              region,
              computeLoadPercentage: node.computeLoadPercentage ?? node.currentLoadPercentage ?? 25,
              volatileMemoryAllocationGb: node.volatileMemoryAllocationGb ?? 4,
              clusterOperationalStatus: node.clusterOperationalStatus ?? node.status ?? 'STABLE',
              timestamp: new Date()
            });
          }
        }
      }
    } catch (err: any) {
      dbState = 'disconnected';
      console.error('[Socket] Broadcast error:', err.message);
    }
    // Reschedule at adaptive interval
    broadcastIntervalHandle = setTimeout(tick, getAdaptiveIntervalMs());
  };
  broadcastIntervalHandle = setTimeout(tick, 1000);
}

// Connect to MongoDB Atlas
async function connectDb(): Promise<void> {
  if (dbState === 'connected') return;
  if (dbState === 'connecting' && dbConnectAttempt) return dbConnectAttempt;

  if (!MONGODB_URI) {
    console.warn('[server] MONGODB_URI is not set — starting in In-Memory High-Performance Telemetry Store mode (no persistence across restarts).');
    db = createInMemoryDb();
    setSharedDb(db);
    dbState = 'connected';
    try {
      await ensureIndexes(db);
      await recalculateRouting(db);
      await bootOrchestrator();
      console.log('[server] AI Orchestrator initialized (In-Memory mode).');
      await startAdaptiveBroadcastLoop();
    } catch (innerErr: any) {
      console.error('[server] In-memory init error:', innerErr.message);
    }
    dbConnectAttempt = Promise.resolve();
    return dbConnectAttempt;
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
      console.warn('[server] MongoDB Atlas unavailable (' + err.message + '). Switching to In-Memory High-Performance Telemetry Store.');
      db = createInMemoryDb();
      setSharedDb(db);
      dbState = 'connected';
      try {
        await ensureIndexes(db);
        await recalculateRouting(db);
        await bootOrchestrator();
        console.log('[server] AI Orchestrator initialized (In-Memory mode).');
        await startAdaptiveBroadcastLoop();
      } catch (innerErr: any) {
        console.error('[server] Fallback init error:', innerErr.message);
      }
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

// ── PWR-19b: AI reasoning log feed (powers Diagnostics panel with real data) ─
app.get('/api/ai/logs', async (req: Request, res: Response) => {
  if (!await ensureDbConnection()) return res.status(503).json({ error: 'DB not ready' });
  try {
    const limit = Math.min(parseInt(String(req.query.limit || '100'), 10) || 100, 500);
    const logs = await db.collection<any>('ai_logs').find({}).sort({ timestamp: -1 }).limit(limit).toArray();
    return res.json({ logs });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
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
        { $set: { status: 'HEALING', currentAction: 'CLEAR_CACHE', isQuarantined: false, currentLoadPercentage: 50.0, updatedAt: new Date() } },
        { upsert: true }
      );
    }

    // Clear chaos lock
    if (await ensureDbConnection()) {
      await db.collection<any>('chaos_locks').deleteOne({ region: normRegion });
    }

    // IMP-09: Propagate mitigateCluster
    const mitigateResult = await mitigateCluster(clusterId as Region);

    // PWR-09: close open SLA outages — mitigation resolved the incident
    await closeOpenOutages(clusterId, 'mitigation');
    await recordIncident(clusterId, normRegion, 'MITIGATE', 'NOMINAL_GREEN', 'Manual mitigation executed — self-healing sequence completed');

    if (await ensureDbConnection()) {
      await db.collection<any>('node_states').updateOne(
        { nodeId: clusterId },
        { $set: { status: 'HEALING', currentAction: 'CLEAR_CACHE', isQuarantined: false, currentLoadPercentage: 45.0, updatedAt: new Date() } },
        { upsert: true }
      );
      await recalculateRouting(db);
    }

    // PWR-15: Audit log
    if (await ensureDbConnection()) {
      await db.collection<any>('chaos_audit_log').insertOne({
        timestamp: new Date(), endpoint: '/api/mitigate', region: clusterId,
        faultType: 'MITIGATE', originIp: req.ip, result: mitigateResult.success ? 'success' : 'node_unreachable',
      });
    }

    await broadcastLiveMetricsNow();
    io.emit('aethernexus-telemetry-broadcast', {
      eventTimestamp: new Date().toISOString(),
      principalArchitect: 'AetherNexus-Core',
      executedMitigationAction: `Mitigation initiated on ${normRegion}. Self-healing sequence in progress.`,
      incidentThreatLevelColor: 'HEALING',
      targetClusterRegion: clusterId
    });

    return res.json({
      success: true,
      message: `Mitigation successful on ${targetClusterRegion}.`,
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
  const targetClusterRegion = req.body.targetClusterRegion || req.body.region;
  const faultType = req.body.faultType;
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

      // PWR-01/PWR-09: incident timeline + SLA outage records
      const normForIncident = normalizeRegion(targetClusterRegion) ?? 'US-East';
      await recordIncident(clusterId, normForIncident, faultType, 'CRITICAL_RED', `Chaos fault injected: ${faultType}`);
      await openSlaOutage(clusterId, normForIncident, faultType);

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
    await recordIncident(clusterId, normRegion, 'CPU_SPIKE', 'CRITICAL_RED', 'Chaos fault injected: CPU spike to 99.8%');
    await openSlaOutage(clusterId, normRegion, 'CPU_SPIKE');

    await broadcastLiveMetricsNow();
    io.emit('aethernexus-telemetry-broadcast', {
      eventTimestamp: new Date().toISOString(),
      principalArchitect: 'AetherNexus-Core',
      executedMitigationAction: `Chaos fault injected: CPU Spike (99.8%) on ${normRegion}`,
      incidentThreatLevelColor: 'CRITICAL_RED',
      targetClusterRegion: clusterId,
      trafficDistribution: distribution
    });
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
    await recordIncident(clusterId, normRegion, 'NETWORK_KILL', 'CRITICAL_RED', 'Chaos fault injected: network knockout');
    await openSlaOutage(clusterId, normRegion, 'NETWORK_KILL');

    await broadcastLiveMetricsNow();
    io.emit('aethernexus-telemetry-broadcast', {
      eventTimestamp: new Date().toISOString(),
      principalArchitect: 'AetherNexus-Core',
      executedMitigationAction: `Chaos fault injected: Network Killed on ${normRegion}`,
      incidentThreatLevelColor: 'CRITICAL_RED',
      targetClusterRegion: clusterId,
      trafficDistribution: distribution
    });
    executeEvaluationCycle(true).catch((err: any) => console.error('[AI] Forced evaluation failed:', err));
    return res.json({ success: true, message: `Network killed for region ${normRegion}.`, latestMetric: metricDoc, traffic_distribution_map: distribution });
  } catch (err: any) {
    return res.status(500).json({ error: 'Failed to kill network' });
  }
});

// ── PWR-05: Cascade Chaos Endpoint ──────────────────────────────────────────

app.post('/api/chaos/cascade', chaosAuthMiddleware, async (req: Request, res: Response) => {
  const { scenario, steps } = req.body;

  // Named scenario presets with punchy, realistic demonstration delays
  const namedScenarios: Record<string, Array<{ region: string; faultType: string; delayMs: number }>> = {
    'full-cascade': [
      { region: 'US-East-1', faultType: 'CPU_SPIKE', delayMs: 400 },
      { region: 'EU-West-1', faultType: 'NETWORK_KNOCKOUT', delayMs: 2000 },
      { region: 'AP-South-1', faultType: 'CPU_SPIKE', delayMs: 2000 },
    ],
    'rolling-degradation': [
      { region: 'US-East-1', faultType: 'MODERATE_LOAD', delayMs: 400 },
      { region: 'EU-West-1', faultType: 'MODERATE_LOAD', delayMs: 2500 },
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
          await recordIncident(clusterId, normRegion, step.faultType, 'CRITICAL_RED', `Cascade step applied: ${step.faultType}`);
          await openSlaOutage(clusterId, normRegion, step.faultType);
        }
        await broadcastLiveMetricsNow();
        io.emit('aethernexus-telemetry-broadcast', {
          eventTimestamp: new Date().toISOString(),
          principalArchitect: 'AetherNexus-Core',
          executedMitigationAction: `Cascade step applied: ${step.faultType} on ${normRegion}`,
          incidentThreatLevelColor: 'CRITICAL_RED',
          targetClusterRegion: clusterId
        });
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
      return res.json({ success: true, scheduleId: result.insertedId, message: 'Chaos schedule saved and registered with the cron runner.' });
    }
    return res.status(503).json({ error: 'DB not ready' });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ── PWR-08b: Minimal cron runner for chaos schedules ─────────────────────────
// Supports standard 5-field cron: minute hour day-of-month month day-of-week
// with *, comma lists, ranges (a-b), and steps (*/n, a-b/n).
function cronFieldMatches(field: string, value: number): boolean {
  return field.split(',').some((part) => {
    if (part === '*') return true;
    const stepMatch = part.match(/^(\*|(\d+)-(\d+))\/(\d+)$/);
    if (stepMatch) {
      const step = parseInt(stepMatch[4], 10);
      const lo = stepMatch[1] === '*' ? 0 : parseInt(stepMatch[2], 10);
      return value >= lo && (value - lo) % step === 0;
    }
    if (part.includes('-')) {
      const [a, b] = part.split('-').map(n => parseInt(n, 10));
      return value >= a && value <= b;
    }
    return parseInt(part, 10) === value;
  });
}

function cronMatches(expr: string, date: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [min, hour, dom, month, dow] = fields;
  return cronFieldMatches(min, date.getMinutes())
    && cronFieldMatches(hour, date.getHours())
    && cronFieldMatches(dom, date.getDate())
    && cronFieldMatches(month, date.getMonth() + 1)
    && cronFieldMatches(dow, date.getDay());
}

async function runChaosSchedulerTick() {
  if (dbState !== 'connected') return;
  try {
    const now = new Date();
    const schedules = await db.collection<any>('chaos_schedules').find({ active: true }).toArray();
    for (const sched of schedules) {
      if (!cronMatches(sched.cronExpression, now)) continue;
      // Fire at most once per minute per schedule
      const lastFired = sched.lastFiredAt ? new Date(sched.lastFiredAt).getTime() : 0;
      if (now.getTime() - lastFired < 59000) continue;

      const normRegion = normalizeRegion(sched.region) ?? sched.region;
      const clusterId = normRegion === 'US-East' ? 'usEastCluster' : normRegion === 'EU-West' ? 'euWestCluster' : 'apSouthCluster';
      const isNetwork = sched.faultType === 'NETWORK_KILL' || sched.faultType === 'NETWORK_DROPOUT';
      const status = isNetwork ? 'CRITICAL_NETWORK_DOWN' : 'CRITICAL';
      const load = isNetwork ? 0 : 99.8;

      await db.collection<any>('node_states').updateOne(
        { nodeId: clusterId },
        { $set: { status, currentLoadPercentage: load, isQuarantined: true, metrics: { cpu: load, ram: isNetwork ? 0 : 12288, activeConnections: isNetwork ? 0 : 150, responseTimeMs: 20, timestamp: now.toISOString() }, updatedAt: now } },
        { upsert: true }
      );
      await db.collection<any>('chaos_locks').updateOne(
        { region: normRegion },
        { $set: { type: 'scheduler_lock', faultType: sched.faultType, updatedAt: now } },
        { upsert: true }
      );
      await recalculateRouting(db);
      await writeChaosAudit('/api/chaos/scheduler', clusterId, sched.faultType, 'cron-runner', 'success');
      await recordIncident(clusterId, normRegion, sched.faultType, 'CRITICAL_RED', `Scheduled chaos fired: ${sched.description || sched.faultType}`);
      await openSlaOutage(clusterId, normRegion, sched.faultType);
      await db.collection<any>('chaos_schedules').updateOne(
        { _id: sched._id },
        { $set: { lastFiredAt: now } }
      );

      await broadcastLiveMetricsNow();
      io.emit('aethernexus-telemetry-broadcast', {
        eventTimestamp: now.toISOString(),
        principalArchitect: 'AetherNexus-Core',
        executedMitigationAction: `Scheduled chaos fired on ${normRegion}: ${sched.faultType}${sched.description ? ` (${sched.description})` : ''}`,
        incidentThreatLevelColor: 'CRITICAL_RED',
        targetClusterRegion: clusterId,
      });
      executeEvaluationCycle(true).catch(() => {});
      console.log(`[chaos-scheduler] Fired schedule ${sched._id}: ${sched.faultType} on ${normRegion}`);
    }
  } catch (err: any) {
    console.error('[chaos-scheduler] Tick failed:', err.message);
  }
}
setInterval(runChaosSchedulerTick, 30000);

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
        // Count resolved outages by their recorded duration; still-open outages
        // (resolvedAt === null) accrue downtime up to the present moment.
        const downMs = events.filter((e: any) => e.type === 'down').reduce((acc: number, e: any) => {
          if (e.resolvedAt === null || e.resolvedAt === undefined) {
            const started = e.timestamp ? new Date(e.timestamp).getTime() : now;
            return acc + Math.max(0, now - started);
          }
          return acc + (e.durationMs || 0);
        }, 0);
        const uptime = Math.max(0, ((ms - downMs) / ms) * 100);
        sla[clusterId][label] = parseFloat(uptime.toFixed(3));
      }
    }

    return res.json({ sla, openOutages: await db.collection<any>('sla_events').find({ resolvedAt: null }).toArray(), timestamp: new Date().toISOString() });
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
    const { region } = req.body || {};
    let targetClusters: string[] = ['usEastCluster', 'euWestCluster', 'apSouthCluster'];
    if (region) {
      let c = region;
      const low = c.toLowerCase();
      if (low.includes('east')) c = 'usEastCluster';
      else if (low.includes('west')) c = 'euWestCluster';
      else if (low.includes('south')) c = 'apSouthCluster';
      targetClusters = [c];

      let rNorm = 'US-East';
      if (low.includes('west')) rNorm = 'EU-West';
      else if (low.includes('south')) rNorm = 'AP-South';
      await db.collection<any>('chaos_locks').deleteMany({ region: rNorm });
    } else {
      await db.collection<any>('chaos_locks').deleteMany({});
    }

    for (const clusterId of targetClusters) {
      await db.collection<any>('node_states').updateOne(
        { nodeId: clusterId },
        { $set: { status: 'STABLE', currentAction: null, currentLoadPercentage: 25.0, metrics: { cpu: 25.0, ram: 4500, activeConnections: 150, responseTimeMs: 20, timestamp: new Date().toISOString() }, isQuarantined: false, updatedAt: new Date() } },
        { upsert: true }
      );
    }
    const distribution = await recalculateRouting(db);
    await writeChaosAudit('/api/chaos/reset', region || 'all', 'RESET', req.ip ?? '', 'success');
    // PWR-09: close any open SLA outages for the reset clusters
    for (const clusterId of targetClusters) {
      await closeOpenOutages(clusterId, 'manual_reset');
      await recordIncident(clusterId, CLUSTER_ID_TO_REGION[clusterId] ?? clusterId, 'RESET', 'NOMINAL_GREEN', 'Chaos locks reset — cluster restored to nominal');
    }
    await broadcastLiveMetricsNow();
    io.emit('aethernexus-telemetry-broadcast', {
      eventTimestamp: new Date().toISOString(),
      principalArchitect: 'AetherNexus-Core',
      executedMitigationAction: `Chaos locks reset for ${region || 'all clusters'}. Systems nominal.`,
      incidentThreatLevelColor: 'NOMINAL_GREEN',
      trafficDistribution: distribution
    });
    return res.json({ success: true, message: `System chaos locks reset for ${region || 'all'}.`, traffic_distribution_map: distribution });
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
      let records = await db.collection<any>('server_health')
        .find({ region: r }).sort({ timestamp: -1 }).limit(10).toArray();
      if (!records || records.length === 0) {
        const clusterId = r === 'US-East' ? 'usEastCluster' : r === 'EU-West' ? 'euWestCluster' : 'apSouthCluster';
        const node = await db.collection<any>('node_states').findOne({ nodeId: clusterId });
        const curLoad = node?.currentLoadPercentage ?? 25;
        records = Array.from({ length: 6 }).map((_, idx) => ({
          region: r,
          computeLoadPercentage: Math.max(10, Math.min(99, Math.round(curLoad + (Math.sin(idx) * 6)))),
          volatileMemoryAllocationGb: 4.0,
          clusterOperationalStatus: node?.status ?? 'STABLE',
          timestamp: new Date(Date.now() - (6 - idx) * 20000).toISOString(),
        }));
      }
      const outputKey = r === 'US-East' ? 'US-East-1' : r === 'EU-West' ? 'EU-West-1' : 'AP-South-1';
      telemetryArrays[outputKey] = records.reverse();
    }
    const distribution = await getDistributionMap(db);
    return res.json({ telemetry: telemetryArrays, traffic_distribution_map: distribution });
  } catch (err: any) {
    return res.status(500).json({ error: 'Failed to fetch telemetry' });
  }
});// ── IMP-07: Graceful Shutdown ──────────────────────────────────────────

// ── PWR-21: Serve built dashboard (single-service deployment) ────────────
// In production the Vite build in dashboard/dist is served from this same
// origin, so the frontend defaults to same-origin API + WebSocket URLs.
const DASHBOARD_DIST = [
  path.resolve(__dirname, 'dashboard', 'dist'),        // running via ts-node from repo root
  path.resolve(__dirname, '..', 'dashboard', 'dist'),  // running compiled from dist/
].find((p) => fs.existsSync(path.join(p, 'index.html'))) || path.resolve(__dirname, 'dashboard', 'dist');
if (fs.existsSync(DASHBOARD_DIST)) {
  app.use(express.static(DASHBOARD_DIST));
  // SPA fallback: any non-API GET returns index.html (Express 5-safe, no '*')
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/') || req.path.startsWith('/socket.io/')) return next();
    if (req.path === '/healthz' || req.path === '/readyz' || req.path === '/metrics') return next();
    res.sendFile(path.join(DASHBOARD_DIST, 'index.html'));
  });
  console.log(`[server] Serving dashboard from ${DASHBOARD_DIST}`);
} else {
  console.warn('[server] dashboard/dist not found — API-only mode. Run `npm --prefix dashboard run build` to include the UI.');
}

// JSON 404 for unmatched API routes
app.use('/api', (_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

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
