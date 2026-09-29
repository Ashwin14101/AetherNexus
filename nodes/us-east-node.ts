import express from 'express';
import cors from 'cors';
import { MongoClient, Db } from 'mongodb';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const REGION_ID = 'usEastCluster';
const REGION_DB_NAME = 'US-East';
const MONGODB_URI = process.env.MONGODB_URI;

let db: Db;
let cpuLoad = 25;
let memoryGb = 4.5;
let networkPackets = 1500;
let clusterStatus = 'STABLE';
let memoryBloatArray: any[] = [];
let cpuInterval: NodeJS.Timeout | null = null;
let faults = { cpu: false, memory: false, network: false };

async function connectDb() {
  if (!MONGODB_URI) {
    console.error(`[${REGION_ID}] No MONGODB_URI found.`);
    process.exit(1);
  }
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db();
    console.log(`[${REGION_ID}] Connected to MongoDB`);
  } catch (err: any) {
    console.error(`[${REGION_ID}] DB Connect Error:`, err.message);
    process.exit(1);
  }
}

function startIntensiveMathLoop() {
  if (cpuInterval) return;
  cpuInterval = setInterval(() => {
    let result = 0;
    for (let i = 0; i < 5000000; i++) result += Math.sqrt(i) * Math.sin(i);
    cpuLoad = 95 + Math.random() * 4;
  }, 100);
}

function stopIntensiveMathLoop() {
  if (cpuInterval) {
    clearInterval(cpuInterval);
    cpuInterval = null;
  }
  cpuLoad = 25 + Math.random() * 5;
}

// IMP-10: Kubernetes/Render health check endpoints
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', region: REGION_DB_NAME, regionId: REGION_ID, port: PORT, cpuLoad: parseFloat(cpuLoad.toFixed(1)), clusterStatus });
});

app.get('/healthz', (_req, res) => res.status(200).json({ alive: true }));

app.get('/readyz', (_req, res) => {
  if (!db) return res.status(503).json({ ready: false, reason: 'MongoDB not connected' });
  res.status(200).json({ ready: true, region: REGION_DB_NAME });
});

app.post('/inject-fault', (req, res) => {
  const { targetClusterRegion, faultType } = req.body;
  if (targetClusterRegion && targetClusterRegion !== REGION_ID) {
    return res.status(400).json({ success: false, message: `Ignored: targetClusterRegion ${targetClusterRegion} does not match this node (${REGION_ID})` });
  }
  if (faultType === 'CPU_SPIKE') {
    faults.cpu = true;
    startIntensiveMathLoop();
    clusterStatus = 'CRITICAL';
  } else if (faultType === 'MEMORY_OVERFLOW') {
    faults.memory = true;
    for (let i = 0; i < 100000; i++) {
      memoryBloatArray.push(new Array(1000).fill('MEMORY_LEAK_PAYLOAD_CHUNK_AETHERNEXUS'));
    }
    memoryGb = 14.5 + Math.random() * 2;
    clusterStatus = 'CRITICAL';
  } else if (faultType === 'NETWORK_DROPOUT') {
    faults.network = true;
    networkPackets = 0;
    clusterStatus = 'CRITICAL_NETWORK_DOWN';
  }
  res.json({ success: true, message: `Injected ${faultType} on ${REGION_ID}` });
});

app.post('/mitigate', (req, res) => {
  faults = { cpu: false, memory: false, network: false };
  stopIntensiveMathLoop();
  memoryBloatArray = [];
  memoryGb = 4.5;
  networkPackets = 1500;
  clusterStatus = 'STABLE';
  res.json({ success: true, message: `Mitigated ${REGION_ID}` });
});

setInterval(async () => {
  if (!db) return;
  if (!faults.cpu) cpuLoad = 20 + Math.random() * 10;
  if (!faults.memory) memoryGb = 4.0 + Math.random();
  if (!faults.network) networkPackets = 1400 + Math.random() * 200;
  if (!faults.cpu && !faults.memory && !faults.network) clusterStatus = 'STABLE';

  try {
    // GAP-002 + GAP-003: Atomic upsert on node_states with spec-mandated schema
    await db.collection('node_states').updateOne(
      { nodeId: REGION_ID },
      {
        $set: {
          nodeId: REGION_ID,
          status: clusterStatus,
          currentLoadPercentage: cpuLoad,
          metrics: {
            cpu: cpuLoad,
            ram: memoryGb * 1024,
            activeConnections: Math.floor(networkPackets / 10),
            responseTimeMs: Math.floor(10 + Math.random() * 20),
            timestamp: new Date().toISOString(),
          },
          isQuarantined: false,
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );
  } catch (err) {}
}, 10000); // GAP-001: spec mandates 10,000ms (10s) telemetry cadence

connectDb().then(() => {
  app.listen(PORT, () => console.log(`[${REGION_ID}] Listening on port ${PORT}`));
});
