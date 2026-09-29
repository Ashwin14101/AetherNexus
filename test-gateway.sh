#!/usr/bin/env bash
# AetherNexus Gateway Diagnostic Script
# Replace GATEWAY_URL with your actual Render deployment URL before running.

GATEWAY_URL="https://aethernexus-gateway.onrender.com"

echo ""
echo "============================================================"
echo "  AetherNexus Gateway Connectivity RCA"
echo "  Target: $GATEWAY_URL"
echo "============================================================"
echo ""

echo ">>> [1/4] Checking gateway root (alive probe)..."
curl -s -o /dev/null -w "  HTTP Status: %{http_code} | Time: %{time_total}s\n" \
  "${GATEWAY_URL}/"

echo ""
echo ">>> [2/4] GET /api/telemetry (AI-facing telemetry endpoint)..."
curl -s -w "\n  HTTP Status: %{http_code} | Time: %{time_total}s\n" \
  "${GATEWAY_URL}/api/telemetry" | head -40

echo ""
echo ">>> [3/4] GET /api/infrastructure/telemetry (Frontend chart data)..."
curl -s -w "\n  HTTP Status: %{http_code} | Time: %{time_total}s\n" \
  "${GATEWAY_URL}/api/infrastructure/telemetry" | head -60

echo ""
echo ">>> [4/4] CORS preflight OPTIONS check (simulates browser behaviour)..."
curl -s -o /dev/null -w "  HTTP Status: %{http_code}\n" \
  -X OPTIONS "${GATEWAY_URL}/api/infrastructure/telemetry" \
  -H "Origin: https://your-app.vercel.app" \
  -H "Access-Control-Request-Method: GET" \
  -H "Access-Control-Request-Headers: Content-Type" \
  -D - 2>&1 | grep -E "(HTTP|access-control|Allow)"

echo ""
echo "============================================================"
echo "  Done. If all HTTP statuses are 200 and CORS headers appear"
echo "  in step 4, the gateway is healthy. If 503 / no response,"
echo "  the Render service is sleeping — trigger a manual deploy."
echo "============================================================"
echo ""
