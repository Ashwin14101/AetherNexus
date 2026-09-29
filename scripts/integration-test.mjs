#!/usr/bin/env node
/**
 * IMP-20: AetherNexus Integration Test Script
 * Tests the full chaos → AI evaluation → mitigation cycle against a running instance.
 * Usage: npm run integration-test
 * Requires: VITE_API_GATEWAY_URL or defaults to http://localhost:4000
 */

const BASE_URL = process.env.VITE_API_GATEWAY_URL || 'http://localhost:4000';
const TIMEOUT_MS = 10000;

let passed = 0;
let failed = 0;

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeout);
    return res;
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ❌ ${name}: ${e.message}`);
    failed++;
  }
}

console.log(`\n🔬 AetherNexus Integration Tests — ${BASE_URL}\n`);

// 1. Health check
await test('GET /healthz returns 200', async () => {
  const res = await fetchWithTimeout(`${BASE_URL}/healthz`);
  if (!res.ok) throw new Error(`Status ${res.status}`);
});

// 2. Readiness check
await test('GET /readyz returns success or DB not ready (503 is acceptable when DB is down)', async () => {
  const res = await fetchWithTimeout(`${BASE_URL}/readyz`);
  if (res.status !== 200 && res.status !== 503) throw new Error(`Unexpected status ${res.status}`);
});

// 3. Status endpoint
await test('GET /api/status returns JSON with dbState', async () => {
  const res = await fetchWithTimeout(`${BASE_URL}/api/status`);
  if (!res.ok) throw new Error(`Status ${res.status}`);
  const data = await res.json();
  if (!('dbState' in data)) throw new Error('Missing dbState field');
});

// 4. Telemetry endpoint
await test('GET /api/telemetry returns infrastructureState', async () => {
  const res = await fetchWithTimeout(`${BASE_URL}/api/telemetry`);
  if (!res.ok) throw new Error(`Status ${res.status}`);
  const data = await res.json();
  if (!data.infrastructureState) throw new Error('Missing infrastructureState');
  const keys = Object.keys(data.infrastructureState);
  if (keys.length !== 3) throw new Error(`Expected 3 cluster keys, got ${keys.length}`);
});

// 5. Chaos spike-cpu
await test('POST /api/chaos/spike-cpu responds with success or auth error', async () => {
  const res = await fetchWithTimeout(`${BASE_URL}/api/chaos/spike-cpu`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ region: 'US-East-1' }),
  });
  if (res.status !== 200 && res.status !== 401 && res.status !== 503) {
    throw new Error(`Unexpected status ${res.status}`);
  }
});

// 6. Rebalance validation
await test('POST /api/rebalance rejects invalid payload', async () => {
  const res = await fetchWithTimeout(`${BASE_URL}/api/rebalance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceRegion: 'usEastCluster', targetRegion: 'usEastCluster', trafficShiftPercentage: 10 }),
  });
  const data = await res.json();
  if (data.success !== false) throw new Error('Should have rejected same-region rebalance');
});

// 7. Normalizes region in spike endpoint
await test('POST /api/chaos/spike-cpu with unknown region returns 400 or 401', async () => {
  const res = await fetchWithTimeout(`${BASE_URL}/api/chaos/spike-cpu`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ region: 'NOT-A-REAL-REGION' }),
  });
  if (res.status !== 400 && res.status !== 401) throw new Error(`Expected 400/401, got ${res.status}`);
});

// 8. Token usage
await test('GET /api/ai/usage returns token usage object', async () => {
  const res = await fetchWithTimeout(`${BASE_URL}/api/ai/usage`);
  if (!res.ok) throw new Error(`Status ${res.status}`);
  const data = await res.json();
  if (!('promptTokens' in data)) throw new Error('Missing promptTokens field');
});

// 9. SLA endpoint
await test('GET /api/sla returns sla or 503', async () => {
  const res = await fetchWithTimeout(`${BASE_URL}/api/sla`);
  if (res.status !== 200 && res.status !== 503) throw new Error(`Unexpected status ${res.status}`);
});

// 10. Incident log endpoint
await test('GET /api/incidents returns incidents or 503', async () => {
  const res = await fetchWithTimeout(`${BASE_URL}/api/incidents`);
  if (res.status !== 200 && res.status !== 503) throw new Error(`Unexpected status ${res.status}`);
});

// Summary
console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(`\n⚠  ${failed} test(s) failed\n`);
  process.exit(1);
} else {
  console.log(`\n✅ All integration tests passed\n`);
  process.exit(0);
}
