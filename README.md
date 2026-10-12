# AetherNexus // Autonomous Control Plane

An AI-driven chaos-engineering control plane: it watches three regional
micro-services, injects faults on demand, and lets an LLM orchestrator
detect, reason about, and mitigate incidents — all visualized in a live
3D topology dashboard.

```
┌──────────────────────────────────────────────────────────────────┐
│  dashboard/          React 19 + Three.js + Recharts (Vite)       │
│      │  REST + Socket.io (same-origin in production)             │
│  server.ts           Express 5 control plane + static hosting    │
│      ├── loadbalancer.ts      weighted health-aware routing      │
│      ├── dist/orchestrator.js AI engine (OpenRouter/Groq → SOPs)  │
│      └── nodes/*.ts           US-East / EU-West / AP-South       │
│  MongoDB Atlas (optional — in-memory fallback when unavailable)  │
└──────────────────────────────────────────────────────────────────┘
```

## Quick start

```bash
npm install
npm --prefix dashboard install

# optional: cp .env.example .env   (works with no .env at all)

npm start                     # control plane on http://localhost:4000
npm run start:all             # + region nodes + dashboard dev server

npm --prefix dashboard run build   # build the UI served by server.ts
```

Open **http://localhost:4000** — the server hosts `dashboard/dist`
automatically once it exists.

## Scripts

| Command | Description |
| --- | --- |
| `npm start` | Run the control plane (`server.ts`) with static UI |
| `npm run start:all` | Control plane + 3 region nodes + Vite dev server |
| `npm run integration-test` | Black-box API tests against a running instance |
| `npm run pre-deploy-check` | Validates `render.yaml` blueprint before deploy |
| `npm --prefix dashboard run dev` | Dashboard dev server (port 5173) |

## API surface (selected)

| Endpoint | Purpose |
| --- | --- |
| `GET /api/telemetry` | Live 3-cluster infrastructure state |
| `GET /api/infrastructure/telemetry` | Historical telemetry arrays + traffic map |
| `GET /api/sla` | Per-cluster uptime for 24h/7d/30d from real outage events |
| `GET /api/incidents` | Incident timeline (`incident_log`) |
| `GET /api/ai/logs` | AI orchestrator reasoning log feed |
| `GET /api/ai/usage` | LLM token usage / estimated cost |
| `POST /api/chaos/spike-cpu` | Inject CPU-spike fault (region required) |
| `POST /api/chaos/kill-network` | Knock out a region's network |
| `POST /api/chaos/cascade` | Run a named cascade scenario |
| `POST /api/chaos/reset` | Heal clusters & close open outages |
| `POST /api/mitigate` | Trigger the self-healing sequence |

Chaos endpoints accept `Authorization: Bearer $CHAOS_API_TOKEN` when the
token is configured (open in local dev).

## Data model notes

- `incident_log` / `sla_events` are written by every fault injection,
  cascade step, scheduler fire, mitigation and reset — `/api/incidents`
  and `/api/sla` are powered by real events, never synthetic data.
- When MongoDB is unreachable the server transparently switches to a
  capped in-memory store (`dbState: "memory"`) so demos never hard-fail.
- `POST /api/chaos/schedule` accepts a 5-field cron expression; a 30s
  runner evaluates active schedules.

## Deployment (Render)

`render.yaml` defines four services: the gateway (builds the dashboard,
serves it from `server.ts`) and three region nodes. Push to GitHub and
create a Blueprint from the repo. Set `MONGODB_URI`, AI keys, and the
`*_URL` env vars in the dashboard after the first deploy.

## Security

- AI MCP file tools are path-contained; code writes are disabled in
  production and restricted to the repo allowlist otherwise.
- Secrets live only in `.env` (git-ignored) — see `.env.example`.
