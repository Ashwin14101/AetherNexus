# AetherNexus // Autonomous Control Plane

[![Live Demo](https://img.shields.io/badge/Live%20Demo-Render-46E3B7?style=for-the-badge&logo=render&logoColor=000)](https://aethernexus-gateway-saqu.onrender.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=fff)](https://www.typescriptlang.org/)
[![React 19](https://img.shields.io/badge/React%2019-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)](https://react.dev/)
[![Express 5](https://img.shields.io/badge/Express%205-000000?style=for-the-badge&logo=express&logoColor=fff)](https://expressjs.com/)
[![Three.js](https://img.shields.io/badge/Three.js-000000?style=for-the-badge&logo=threedotjs&logoColor=fff)](https://threejs.org/)

> **Live Production Demo:** [https://aethernexus-gateway-saqu.onrender.com/](https://aethernexus-gateway-saqu.onrender.com/)  
> **Live Telemetry Feed (JSON):** [https://aethernexus-gateway-saqu.onrender.com/api/telemetry](https://aethernexus-gateway-saqu.onrender.com/api/telemetry)

An AI-driven chaos-engineering and self-healing infrastructure control plane. AetherNexus monitors three regional micro-services (`US-East`, `EU-West`, `AP-South`), routes traffic through a weighted health-aware load balancer with automatic failover, injects faults on demand, and uses an LLM orchestrator to detect, reason about, and mitigate incidents — all visualized in a live 3D topology dashboard.

---

## 60-Second Recruiter Demo Walkthrough

Open the **[Live Dashboard](https://aethernexus-gateway-saqu.onrender.com/)** *(free-tier Render cold start may take ~20–30s on first load)*:

1. **Observe Live Multi-Region Telemetry:** Watch real-time CPU, RAM, latency, active connections, and traffic routing across `US-East`, `EU-West`, and `AP-South` in the 3D topology view.
2. **Inject a Fault (Chaos Engineering):** Trigger a **CPU Spike**, **Network Kill**, or **Cascade Scenario** on any cluster and watch the load balancer automatically shift traffic to healthy regions.
3. **Watch Autonomous AI Mitigation:** Inspect the live **AI Orchestrator Reasoning Feed** and **Incident Timeline** as the system diagnoses root cause, applies mitigation SOPs, and restores cluster health.
4. **Verify Real SLA Tracking:** Check `/api/sla` and `/api/incidents` — uptime metrics (24h / 7d / 30d) are computed from actual outage events rather than hardcoded values.

---

## System Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  dashboard/          React 19 + Three.js + Recharts (Vite)       │
│      │  REST + Socket.io (same-origin in production)             │
│  server.ts           Express 5 control plane + static hosting    │
│      ├── loadbalancer.ts      weighted health-aware routing      │
│      ├── dist/orchestrator.js AI engine (OpenRouter/Groq → SOPs)  │
│      └── nodes/*.ts           US-East / EU-West / AP-South       │
│  MongoDB Atlas (optional — capped in-memory fallback when down)  │
└──────────────────────────────────────────────────────────────────┘
```

### Key Engineering Highlights

- **Weighted Health-Aware Load Balancer (`loadbalancer.ts`):** Continuously scores regional nodes by load, latency, and quarantine state to perform automatic failover without dropping traffic.
- **Real-Time 3D Observability (`dashboard/`):** Built with React 19, Three.js, Recharts, and Socket.io for sub-second visual feedback during chaos events and recovery.
- **LLM Incident Orchestrator:** Streams structured reasoning logs, evaluates SOPs, tracks token usage/cost (`/api/ai/usage`), and supports automated self-healing via `POST /api/mitigate`.
- **Resilient Data Layer:** Logs real outage events to MongoDB Atlas (`incident_log`, `sla_events`) and transparently falls back to a capped in-memory store (`dbState: "memory"`) if the database is unreachable.
- **Cron Chaos Scheduler:** Supports 5-field cron expressions via `POST /api/chaos/schedule` evaluated by a 30-second background runner.

---

## Quick Start

```bash
npm install
npm --prefix dashboard install

# optional: cp .env.example .env   (runs out-of-the-box with no .env)

npm start                          # control plane on http://localhost:4000
npm run start:all                  # + 3 region nodes + dashboard dev server

npm --prefix dashboard run build   # build static UI served by server.ts
```

Open **http://localhost:4000** — `server.ts` automatically serves `dashboard/dist` once built.

## Scripts

| Command | Description |
| --- | --- |
| `npm start` | Run the control plane (`server.ts`) with static UI |
| `npm run start:all` | Control plane + 3 region nodes + Vite dev server |
| `npm run integration-test` | Black-box API tests against a running instance |
| `npm run pre-deploy-check` | Validates `render.yaml` blueprint before deploy |
| `npm --prefix dashboard run dev` | Dashboard dev server (port 5173) |

## API Surface

| Endpoint | Purpose |
| --- | --- |
| `GET /api/telemetry` | Live 3-cluster infrastructure state |
| `GET /api/infrastructure/telemetry` | Historical telemetry arrays + traffic map |
| `GET /api/sla` | Per-cluster uptime for 24h / 7d / 30d from real outage events |
| `GET /api/incidents` | Incident timeline (`incident_log`) |
| `GET /api/ai/logs` | AI orchestrator reasoning log feed |
| `GET /api/ai/usage` | LLM token usage & estimated cost |
| `POST /api/chaos/spike-cpu` | Inject CPU-spike fault (region required) |
| `POST /api/chaos/kill-network` | Knock out a region's network |
| `POST /api/chaos/cascade` | Run a named cascade scenario |
| `POST /api/chaos/reset` | Heal clusters & close open outages |
| `POST /api/mitigate` | Trigger the self-healing sequence |

Chaos endpoints accept `Authorization: Bearer $CHAOS_API_TOKEN` when configured (open in local dev).

## Data Model Notes

- `incident_log` / `sla_events` are written by every fault injection, cascade step, scheduler fire, mitigation, and reset — `/api/incidents` and `/api/sla` are powered by real events, never synthetic data.
- When MongoDB is unreachable the server transparently switches to a capped in-memory store (`dbState: "memory"`) so demos never hard-fail.
- `POST /api/chaos/schedule` accepts a 5-field cron expression; a 30s runner evaluates active schedules.

## Deployment (Render)

`render.yaml` defines four services: the gateway (builds the dashboard and serves it from `server.ts`) and three regional nodes. Push to GitHub and create a Blueprint from the repo, then set `MONGODB_URI`, AI keys, and `*_URL` environment variables in the Render dashboard.

## Security

- AI MCP file tools are path-contained; code writes are disabled in production and restricted to the repo allowlist otherwise.
- Secrets live only in `.env` (git-ignored) — see `.env.example`.
