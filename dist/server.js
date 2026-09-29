"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const http_1 = __importDefault(require("http"));
const socket_io_1 = require("socket.io");
const mongodb_1 = require("mongodb");
const dotenv_1 = __importDefault(require("dotenv"));
const node_fetch_1 = __importDefault(require("node-fetch"));
// NOTE: mcpServer.js is deprecated. The system utilizes the inline dispatchMcpToolCall in orchestrator.js for tool execution.
const loadbalancer_1 = require("./loadbalancer");
// @ts-ignore - Bypassing TS strict mode for compiled JS module
const orchestrator_js_1 = require("./dist/orchestrator.js");
// @ts-ignore - Bypassing TS strict mode for patched JS export
const egressBroadcaster_js_1 = require("./dist/egressBroadcaster.js");
// Load environment variables
dotenv_1.default.config();
const app = (0, express_1.default)();
const httpServer = http_1.default.createServer(app);
const io = new socket_io_1.Server(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
});
(0, egressBroadcaster_js_1.setSharedSocket)(io);
const PORT = process.env.PORT || 4000;
const MONGODB_URI = process.env.MONGODB_URI;
// Microservice URLs — driven by environment variables for production (Render)
const MICROSERVICE_URLS = {
    usEastCluster: process.env.US_EAST_URL || 'http://localhost:3001',
    euWestCluster: process.env.EU_WEST_URL || 'http://localhost:3002',
    apSouthCluster: process.env.AP_SOUTH_URL || 'http://localhost:3004',
};
// Region name → JSON key mapping (for real data)
const REGION_TO_KEY = {
    'US-East': 'usEastCluster',
    'EU-West': 'euWestCluster',
    'AP-South': 'apSouthCluster',
};
// Domain 2 camelCase cluster identifier → server_health region name mapping
const CLUSTER_ID_TO_REGION = {
    usEastCluster: 'US-East',
    euWestCluster: 'EU-West',
    apSouthCluster: 'AP-South',
};
// ── DISTRIBUTED NETWORK BRIDGES ──────────────────────────────────────────
// These functions replace the old local clusterManager. 
// They convert internal gateway commands into physical HTTP network requests sent across the globe.
async function mitigateCluster(region) {
    const targetUrl = MICROSERVICE_URLS[region];
    console.log(`[Gateway] Routing mitigation command across the internet to ${targetUrl}`);
    try {
        await (0, node_fetch_1.default)(`${targetUrl}/mitigate`, { method: 'POST' });
    }
    catch (err) {
        console.error(`[Gateway] Failed to reach ${region} at ${targetUrl}`);
    }
}
async function injectFault(region, faultType) {
    const targetUrl = MICROSERVICE_URLS[region];
    console.log(`[Gateway] Routing chaos command across the internet to ${targetUrl}`);
    try {
        await (0, node_fetch_1.default)(`${targetUrl}/inject-fault`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetClusterRegion: region, faultType })
        });
    }
    catch (err) {
        console.error(`[Gateway] Failed to reach ${region} at ${targetUrl}`);
    }
}
// ─────────────────────────────────────────────────────────────────────────
app.use((0, cors_1.default)({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express_1.default.json());
let db;
let mongoConnected = false;
// Connect to MongoDB Atlas
async function connectDb() {
    if (!MONGODB_URI) {
        console.error('[server] Error: MONGODB_URI is not set in environment variables!');
        process.exit(1);
    }
    try {
        const client = new mongodb_1.MongoClient(MONGODB_URI);
        await client.connect();
        db = client.db();
        (0, egressBroadcaster_js_1.setSharedDb)(db);
        mongoConnected = true;
        console.log('[server] Connected to MongoDB Atlas successfully.');
        // Initialize the routing table on startup
        await (0, loadbalancer_1.recalculateRouting)(db);
        // Boot the AI evaluation engine inside the main process
        await (0, orchestrator_js_1.bootOrchestrator)();
        console.log('[server] AI Orchestrator engine initialized and running.');
        // High-frequency telemetry broadcast loop
        setInterval(async () => {
            try {
                await ensureDbConnection();
                const liveData = await getLatestMetrics();
                if (liveData)
                    io.emit('live-metrics-stream', liveData);
            }
            catch (err) {
                mongoConnected = false;
                console.error('[Socket] Broadcast error:', err.message);
            }
        }, 2000);
    }
    catch (err) {
        console.error('[server] MongoDB connection failed:', err.message);
        process.exit(1);
    }
}
// ── Helpers ─────────────────────────────────────────────────────────────────
async function ensureDbConnection() {
    if (!mongoConnected) {
        await connectDb();
    }
    return mongoConnected;
}
async function getLatestMetrics() {
    if (!await ensureDbConnection())
        return null;
    const results = await db.collection('node_states').find({}).toArray();
    const infrastructureState = {
        usEastCluster: { currentLoadPercentage: 0, metrics: { ram: 0 }, status: 'STABLE' },
        euWestCluster: { currentLoadPercentage: 0, metrics: { ram: 0 }, status: 'STABLE' },
        apSouthCluster: { currentLoadPercentage: 0, metrics: { ram: 0 }, status: 'STABLE' },
    };
    for (const doc of results) {
        const key = doc.nodeId;
        if (key && infrastructureState[key]) {
            infrastructureState[key] = {
                currentLoadPercentage: doc.currentLoadPercentage,
                metrics: doc.metrics,
                status: doc.status,
                // BACKWARDS COMPATIBILITY FOR CACHED APP.JSX:
                computeLoadPercentage: doc.currentLoadPercentage,
                volatileMemoryAllocationGb: (doc.metrics?.ram || 0) / 1024,
                clusterOperationalStatus: doc.status
            };
        }
    }
    return infrastructureState;
}
// ── Telemetry API (Port 4000 primary endpoint) ──────────────────────────────
/**
 * GET /api/telemetry
 * Returns real telemetry states in the exact JSON format expected by the AI.
 */
app.get('/api/telemetry', async (req, res) => {
    try {
        const infrastructureState = await getLatestMetrics();
        if (!infrastructureState) {
            return res.status(503).json({ error: 'MongoDB connection not ready' });
        }
        return res.json({ infrastructureState });
    }
    catch (err) {
        console.error('[server] Telemetry fetch error:', err.message);
        return res.status(500).json({ error: 'Failed to fetch telemetry' });
    }
});
/**
 * POST /api/mitigate
 * Mitigates cache issues by forwarding request to the target regional health node.
 */
app.post('/api/mitigate', async (req, res) => {
    const { targetClusterRegion, cacheLayerNamespace } = req.body || {};
    if (!targetClusterRegion || !cacheLayerNamespace) {
        return res.status(400).json({
            success: false,
            message: 'Missing targetClusterRegion or cacheLayerNamespace',
        });
    }
    try {
        // Fix name mapping
        let clusterId = targetClusterRegion;
        if (clusterId === 'US-East' || clusterId === 'US-East-1')
            clusterId = 'usEastCluster';
        if (clusterId === 'EU-West' || clusterId === 'EU-West-1')
            clusterId = 'euWestCluster';
        if (clusterId === 'AP-South' || clusterId === 'AP-South-1')
            clusterId = 'apSouthCluster';
        if (await ensureDbConnection()) {
            const existingNode = await db.collection('node_states').findOne({ nodeId: clusterId });
            if (existingNode?.status === 'HEALING' && existingNode?.currentAction === 'CLEAR_CACHE') {
                console.log(`[mitigate] Duplicate suppressed — ${clusterId} is already HEALING with CLEAR_CACHE.`);
                return res.json({ success: true, message: 'Mitigation already running. Duplicate suppressed.' });
            }
            await db.collection('node_states').updateOne({ nodeId: clusterId }, { $set: { status: 'HEALING', currentAction: 'CLEAR_CACHE', isQuarantined: false, updatedAt: new Date() } }, { upsert: true });
        }
        await mitigateCluster(clusterId);
        if (await ensureDbConnection()) {
            await (0, loadbalancer_1.recalculateRouting)(db);
            await db.collection('node_states').updateOne({ nodeId: clusterId }, { $set: { status: 'STABLE', currentAction: null, isQuarantined: false, updatedAt: new Date() } }, { upsert: true });
        }
        console.log(`[mitigate] Autonomous mitigation executed on ${targetClusterRegion}: ${cacheLayerNamespace}`);
        return res.json({
            success: true,
            message: `Mitigation successful on ${targetClusterRegion}.`,
        });
    }
    catch (err) {
        console.error(`[mitigate] Failed to mitigate ${targetClusterRegion}:`, err.message);
        return res.status(500).json({
            success: false,
            message: `Internal error during mitigation: ${err.message}`,
        });
    }
});
/**
 * POST /api/rebalance
 * Domain 2 AI Core integration endpoint.
 * Accepts { sourceRegion, targetRegion, trafficShiftPercentage } as dispatched
 * by the executeLoadBalancing MCP tool and updates the in-memory routing weights
 * persisted to MongoDB load_balancer_state.
 */
app.post('/api/rebalance', async (req, res) => {
    const { sourceRegion, targetRegion, trafficShiftPercentage } = req.body || {};
    if (!sourceRegion || !targetRegion || typeof trafficShiftPercentage !== 'number') {
        return res.status(400).json({
            success: false,
            message: 'Missing or invalid payload. Required: sourceRegion (string), targetRegion (string), trafficShiftPercentage (number).',
        });
    }
    if (sourceRegion === targetRegion) {
        return res.status(400).json({
            success: false,
            message: 'sourceRegion and targetRegion cannot be the same',
        });
    }
    const resolvedSourceRegion = CLUSTER_ID_TO_REGION[sourceRegion];
    const resolvedTargetRegion = CLUSTER_ID_TO_REGION[targetRegion];
    if (!resolvedSourceRegion || !resolvedTargetRegion) {
        return res.status(400).json({
            success: false,
            message: `Unrecognized cluster identifier. Valid sourceRegion/targetRegion values: usEastCluster, euWestCluster, apSouthCluster. Received: sourceRegion=${sourceRegion}, targetRegion=${targetRegion}`,
        });
    }
    if (trafficShiftPercentage < 1 || trafficShiftPercentage > 100) {
        return res.status(400).json({
            success: false,
            message: `trafficShiftPercentage must be between 1 and 100. Received: ${trafficShiftPercentage}`,
        });
    }
    try {
        const currentDistribution = await (0, loadbalancer_1.getDistributionMap)(db);
        // Map server_health region names back to TrafficDistributionMap keys
        const regionToDistKey = {
            'US-East': 'US-East-1',
            'EU-West': 'EU-West-1',
            'AP-South': 'AP-South-1',
        };
        const sourceDistKey = regionToDistKey[resolvedSourceRegion];
        const targetDistKey = regionToDistKey[resolvedTargetRegion];
        const updatedDistribution = { ...currentDistribution };
        const shiftAmount = Math.min(trafficShiftPercentage, updatedDistribution[sourceDistKey]);
        const mutatedSourceWeight = parseFloat(Math.max(0, updatedDistribution[sourceDistKey] - shiftAmount).toFixed(4));
        const mutatedTargetWeight = parseFloat(Math.min(100, updatedDistribution[targetDistKey] + shiftAmount).toFixed(4));
        // Derive the third unaffected region's weight as the 100-sum remainder
        // to guarantee the distribution always sums to exactly 100.
        const availableKeys = Object.keys(updatedDistribution).filter(k => k !== sourceDistKey && k !== targetDistKey);
        const thirdDistKey = availableKeys[0];
        const derivedThirdWeight = parseFloat((100 - mutatedSourceWeight - mutatedTargetWeight).toFixed(4));
        updatedDistribution[sourceDistKey] = mutatedSourceWeight;
        updatedDistribution[targetDistKey] = mutatedTargetWeight;
        updatedDistribution[thirdDistKey] = derivedThirdWeight;
        if (await ensureDbConnection()) {
            await db.collection('load_balancer_state').updateOne({ _id: 'current_state' }, {
                $set: {
                    traffic_distribution_map: updatedDistribution,
                    updatedAt: new Date(),
                },
            }, { upsert: true });
        }
        console.log(`[rebalance] Domain 2 directive applied — ${trafficShiftPercentage}% shifted from ${sourceRegion} to ${targetRegion}. New distribution:`, updatedDistribution);
        return res.json({
            success: true,
            message: `Traffic rebalanced: ${trafficShiftPercentage}% shifted from ${sourceRegion} to ${targetRegion}.`,
            traffic_distribution_map: updatedDistribution,
        });
    }
    catch (rebalanceOperationException) {
        console.error('[rebalance] Failed to apply Domain 2 rebalance directive:', rebalanceOperationException.message);
        return res.status(500).json({
            success: false,
            message: 'Internal error applying rebalance directive.',
        });
    }
});
// ── Chaos Endpoints ─────────────────────────────────────────────────────────
/**
 * POST /api/chaos/inject-fault
 * Executes programmatic resource fault-injection on isolated cluster workers.
 */
app.post('/api/chaos/inject-fault', async (req, res) => {
    const { targetClusterRegion, faultType } = req.body;
    if (!targetClusterRegion || !faultType) {
        return res.status(400).json({ error: 'Missing targetClusterRegion or faultType' });
    }
    try {
        await injectFault(targetClusterRegion, faultType);
        if (await ensureDbConnection()) {
            let metricDoc = {
                timestamp: new Date(),
                region: (0, loadbalancer_1.normalizeRegion)(targetClusterRegion),
            };
            if (faultType === 'NETWORK_DROPOUT') {
                metricDoc = { ...metricDoc, computeLoadPercentage: 0.0, volatileMemoryAllocationGb: 0.0, networkPackets: 0, clusterOperationalStatus: 'CRITICAL_NETWORK_DOWN' };
            }
            else if (faultType === 'MODERATE_LOAD') {
                metricDoc = { ...metricDoc, computeLoadPercentage: 82.0, volatileMemoryAllocationGb: 8.5, clusterOperationalStatus: 'DEGRADED' };
            }
            else {
                metricDoc = { ...metricDoc, computeLoadPercentage: 98.0, volatileMemoryAllocationGb: 14.0, clusterOperationalStatus: 'CRITICAL' };
            }
            // Removed server_health insert
            await db.collection('node_states').updateOne({ nodeId: targetClusterRegion }, { $set: { status: metricDoc.clusterOperationalStatus, isQuarantined: true, currentLoadPercentage: metricDoc.computeLoadPercentage, metrics: { cpu: metricDoc.computeLoadPercentage, ram: metricDoc.volatileMemoryAllocationGb * 1024, activeConnections: metricDoc.networkPackets ? 150 : 0, responseTimeMs: 20, timestamp: new Date().toISOString() }, updatedAt: new Date() } }, { upsert: true });
            await (0, loadbalancer_1.recalculateRouting)(db);
        }
        console.log(`[chaos] Fault ${faultType} injected into ${targetClusterRegion}`);
        return res.json({
            success: true,
            message: `Successfully injected ${faultType} into ${targetClusterRegion}`,
        });
    }
    catch (err) {
        console.error('[chaos] Inject fault error:', err.message);
        return res.status(500).json({ error: 'Failed to inject fault' });
    }
});
/**
 * POST /api/chaos/spike-cpu
 * Takes a specific region name in the request body (e.g. { "region": "US-East-1" })
 * and instantly locks that region's CPU tracking variable to 99.8%.
 */
app.post('/api/chaos/spike-cpu', async (req, res) => {
    if (!await ensureDbConnection()) {
        return res.status(503).json({ error: 'Database connection not ready' });
    }
    const { region } = req.body;
    if (!region) {
        return res.status(400).json({ error: 'Missing "region" parameter in request body' });
    }
    let normRegion;
    try {
        normRegion = (0, loadbalancer_1.normalizeRegion)(region);
    }
    catch (err) {
        return res.status(400).json({ error: err.message });
    }
    try {
        const metricDoc = {
            timestamp: new Date(),
            region: normRegion,
            computeLoadPercentage: 99.8,
            volatileMemoryAllocationGb: 12.0,
            clusterOperationalStatus: 'CRITICAL',
        };
        await db.collection('chaos_locks').updateOne({ region: normRegion }, {
            $set: {
                type: 'cpu_lock',
                computeLoadPercentage: 99.8,
                updatedAt: new Date(),
            },
        }, { upsert: true });
        let clusterId = normRegion === 'US-East' ? 'usEastCluster' : normRegion === 'EU-West' ? 'euWestCluster' : 'apSouthCluster';
        await db.collection('node_states').updateOne({ nodeId: clusterId }, { $set: { status: 'CRITICAL', currentLoadPercentage: 99.8, metrics: { cpu: 99.8, ram: 12.0 * 1024, activeConnections: 150, responseTimeMs: 20, timestamp: new Date().toISOString() }, isQuarantined: true, updatedAt: new Date() } }, { upsert: true });
        const distribution = await (0, loadbalancer_1.recalculateRouting)(db);
        console.log(`[chaos] CPU spiked to 99.8% for region ${normRegion} (${region})`);
        return res.json({
            success: true,
            message: `CPU spiked and locked to 99.8% for region ${normRegion}`,
            latestMetric: metricDoc,
            traffic_distribution_map: distribution,
        });
    }
    catch (err) {
        console.error('[chaos] Spike CPU error:', err.message);
        return res.status(500).json({ error: 'Failed to apply CPU spike' });
    }
});
/**
 * POST /api/chaos/kill-network
 * Simulates a dropped cable by forcing network packets to zero and changing
 * the cluster's status string to "CRITICAL_NETWORK_DOWN".
 * Defaults to "US-East-1" if no region is provided.
 */
app.post('/api/chaos/kill-network', async (req, res) => {
    if (!await ensureDbConnection()) {
        return res.status(503).json({ error: 'Database connection not ready' });
    }
    const { region = 'US-East-1' } = req.body;
    let normRegion;
    try {
        normRegion = (0, loadbalancer_1.normalizeRegion)(region);
    }
    catch (err) {
        return res.status(400).json({ error: err.message });
    }
    try {
        const metricDoc = {
            timestamp: new Date(),
            region: normRegion,
            computeLoadPercentage: 0.0,
            volatileMemoryAllocationGb: 0.0,
            networkPackets: 0,
            clusterOperationalStatus: 'CRITICAL_NETWORK_DOWN',
        };
        await db.collection('chaos_locks').updateOne({ region: normRegion }, {
            $set: {
                type: 'network_lock',
                networkPackets: 0,
                clusterOperationalStatus: 'CRITICAL_NETWORK_DOWN',
                updatedAt: new Date(),
            },
        }, { upsert: true });
        let clusterId = normRegion === 'US-East' ? 'usEastCluster' : normRegion === 'EU-West' ? 'euWestCluster' : 'apSouthCluster';
        await db.collection('node_states').updateOne({ nodeId: clusterId }, { $set: { status: 'CRITICAL_NETWORK_DOWN', currentLoadPercentage: 0, metrics: { cpu: 0, ram: 0, activeConnections: 0, responseTimeMs: 20, timestamp: new Date().toISOString() }, isQuarantined: true, updatedAt: new Date() } }, { upsert: true });
        const distribution = await (0, loadbalancer_1.recalculateRouting)(db);
        console.log(`[chaos] Network dropped (CRITICAL_NETWORK_DOWN) for region ${normRegion} (${region})`);
        return res.json({
            success: true,
            message: `Network killed for region ${normRegion}. Status set to CRITICAL_NETWORK_DOWN.`,
            latestMetric: metricDoc,
            traffic_distribution_map: distribution,
        });
    }
    catch (err) {
        console.error('[chaos] Kill network error:', err.message);
        return res.status(500).json({ error: 'Failed to kill network' });
    }
});
/**
 * POST /api/chaos/reset
 * Administrative endpoint to clear all CPU and network chaos locks,
 * returning the load balancer back to its normal 33.3% distribution.
 */
app.post('/api/chaos/reset', async (req, res) => {
    if (!await ensureDbConnection()) {
        return res.status(503).json({ error: 'Database connection not ready' });
    }
    try {
        await db.collection('chaos_locks').deleteMany({});
        const regions = ['US-East', 'EU-West', 'AP-South'];
        const restoreTime = new Date();
        for (const r of regions) {
            let clusterId = r === 'US-East' ? 'usEastCluster' : r === 'EU-West' ? 'euWestCluster' : 'apSouthCluster';
            await db.collection('node_states').updateOne({ nodeId: clusterId }, { $set: { status: 'STABLE', currentLoadPercentage: 25.0, metrics: { cpu: 25.0, ram: 4500, activeConnections: 150, responseTimeMs: 20, timestamp: new Date().toISOString() }, isQuarantined: false, updatedAt: new Date() } }, { upsert: true });
        }
        const distribution = await (0, loadbalancer_1.recalculateRouting)(db);
        console.log('[chaos] All chaos locks cleared and infrastructure restored.');
        return res.json({
            success: true,
            message: 'All system chaos locks reset. Normal telemetry restored.',
            traffic_distribution_map: distribution,
        });
    }
    catch (err) {
        console.error('[chaos] Reset error:', err.message);
        return res.status(500).json({ error: 'Failed to reset chaos status' });
    }
});
// ── Infrastructure Telemetry Endpoint ───────────────────────────────────────
/**
 * GET /api/infrastructure/telemetry
 * Reads the database and returns the current metric arrays for all three regions.
 */
app.get('/api/infrastructure/telemetry', async (req, res) => {
    if (!await ensureDbConnection()) {
        return res.status(503).json({ error: 'Database connection not ready' });
    }
    try {
        const regionKeys = ['US-East', 'EU-West', 'AP-South'];
        const telemetryArrays = {};
        for (const r of regionKeys) {
            const records = await db.collection('server_health')
                .find({ region: r })
                .sort({ timestamp: -1 })
                .limit(10)
                .toArray();
            const ordered = records.reverse();
            const outputKey = r === 'US-East' ? 'US-East-1' : r === 'EU-West' ? 'EU-West-1' : 'AP-South-1';
            telemetryArrays[outputKey] = ordered;
        }
        const distribution = await (0, loadbalancer_1.getDistributionMap)(db);
        return res.json({
            telemetry: telemetryArrays,
            traffic_distribution_map: distribution,
        });
    }
    catch (err) {
        console.error('[telemetry] Retrieval error:', err.message);
        return res.status(500).json({ error: 'Failed to fetch telemetry' });
    }
});
// Start the Server
async function start() {
    await connectDb();
    httpServer.listen(PORT, () => {
        console.log(`[chaos-server] Unified Admin & Telemetry server running on port ${PORT}`);
    });
}
start();
