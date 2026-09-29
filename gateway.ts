import express, { Request, Response } from 'express';
import cors from 'cors';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { MongoClient, Db } from 'mongodb';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.GATEWAY_PORT || 3003;
const MONGODB_URI = process.env.MONGODB_URI;

if (process.env.NODE_ENV === 'production' && (!process.env.US_EAST_URL || !process.env.EU_WEST_URL || !process.env.AP_SOUTH_URL)) {
  console.error('[gateway] Fatal Error: Missing one or more required cluster URL environment variables (US_EAST_URL, EU_WEST_URL, AP_SOUTH_URL).');
  process.exit(1);
}

const NODE_URLS = {
  'US-East-1': process.env.US_EAST_URL || 'http://localhost:3001',
  'EU-West-1': process.env.EU_WEST_URL || 'http://localhost:3002',
  'AP-South-1': process.env.AP_SOUTH_URL || 'http://localhost:3004',
};

interface RoutingTable {
  'US-East-1': number;
  'EU-West-1': number;
  'AP-South-1': number;
}

// In-memory routing table initialized to nominal even weights
// BUG-A09 FIX: AP-South-1 was 33.3 (total=99.9). Now 33.4 to match loadbalancer.ts default (total=100).
let routingTable: RoutingTable = {
  'US-East-1': 33.3,
  'EU-West-1': 33.3,
  'AP-South-1': 33.4,
};

let db: Db;
let mongoConnected = false;

// Normalize input keys to standard 'US-East-1', 'EU-West-1', 'AP-South-1'
function normalizeRoutingKey(key: string): keyof RoutingTable | null {
  const k = key.trim().toUpperCase();
  if (k === 'US' || k === 'US-EAST' || k === 'US-EAST-1') return 'US-East-1';
  if (k === 'EU' || k === 'EU-WEST' || k === 'EU-WEST-1') return 'EU-West-1';
  if (k === 'ASIA' || k === 'AP' || k === 'AP-SOUTH' || k === 'AP-SOUTH-1') return 'AP-South-1';
  return null;
}

// Connect to MongoDB Atlas and synchronize initial weights
async function connectDb() {
  if (MONGODB_URI) {
    try {
      const client = new MongoClient(MONGODB_URI);
      await client.connect();
      db = client.db();
      mongoConnected = true;
      console.log('[gateway] Connected to MongoDB Atlas successfully.');

      // Load initial distribution map from the database if it exists
      const stateDoc = await db.collection<any>('load_balancer_state').findOne({ _id: 'current_state' });
      if (stateDoc && stateDoc.traffic_distribution_map) {
        routingTable = stateDoc.traffic_distribution_map;
        console.log('[gateway] Initialized routing table from database:', routingTable);
      }

      // Refresh routing table periodically
      setInterval(async () => {
        try {
          const stateDoc = await db.collection<any>('load_balancer_state').findOne({ _id: 'current_state' });
          if (stateDoc && stateDoc.traffic_distribution_map) {
            routingTable = stateDoc.traffic_distribution_map;
          }
        } catch (err: any) {
          console.error('[gateway] Failed to refresh routing table:', err.message);
        }
      }, 5000);

    } catch (err: any) {
      console.warn('[gateway] Database sync failed. Using default in-memory weights:', err.message);
    }
  } else {
    console.warn('[gateway] MONGODB_URI not found. Running in standalone in-memory mode.');
  }
}

// Dynamic Weighted Target Selection Algorithm
function selectTargetRegion(): keyof RoutingTable {
  const rand = Math.random() * 100;
  let runningSum = 0;
  
  const keys = Object.keys(routingTable) as (keyof RoutingTable)[];
  for (const key of keys) {
    runningSum += routingTable[key];
    if (rand < runningSum) {
      return key;
    }
  }

  // Fallback to first region with a non-zero weight, or EU-West-1
  for (const key of keys) {
    if (routingTable[key] > 0) return key;
  }
  return 'EU-West-1';
}

// ── Admin Rebalance Secret Door ─────────────────────────────────────────────

app.use(cors());


// ── http-proxy-middleware Gateway Setup ─────────────────────────────────────

const proxyMiddleware = createProxyMiddleware({
  target: NODE_URLS['EU-West-1'] || 'http://localhost:3002', // Default fallback target
  router: (req) => {
    const targetRegion = selectTargetRegion();
    const targetUrl = NODE_URLS[targetRegion];
    return targetUrl;
  },
  changeOrigin: true,
  on: {
    proxyReq: (proxyReq, req, res) => {
      // Add custom header to track proxy path routing for diagnostics
      proxyReq.setHeader('x-gateway-routed-by', 'altrosyn-load-balancer');
    },
    error: (err, req, res: any) => {
      console.error('[gateway] Proxy forwarding failure:', err.message);
      if (res.writeHead) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bad Gateway: Regional node unreachable', details: err.message }));
      }
    }
  }
});

// Catch all traffic and forward it through http-proxy-middleware
app.use('/', proxyMiddleware);

// Boot the Server
async function start() {
  await connectDb();
  app.listen(PORT, () => {
    console.log(`[gateway] Gateway Proxy Load Balancer running on port ${PORT}`);
    console.log('[gateway] Configuration URLs:');
    console.log(`  US-East-1  → ${NODE_URLS['US-East-1']}`);
    console.log(`  EU-West-1  → ${NODE_URLS['EU-West-1']}`);
    console.log(`  AP-South-1 → ${NODE_URLS['AP-South-1']}`);
  });
}

start();
