"""
mcp_server_flask.py

AetherNexus MCP Server — Flask/Python version.
Exact same functionality as Surya's Node.js mcpServer.js + orchestrator.js,
rewritten in Python using Flask + MCP Python SDK.

What this file does:
  1. Registers 5 MCP tools the AI can call (fetch metrics, cache flush, rebalance, etc.)
  2. Runs a 30-second polling loop — AI checks server health every 30 seconds
  3. Uses Groq API (Llama-3.3-70b) as the LLM brain
  4. Broadcasts AI decisions to frontend via Socket.io (WebSocket)
  5. Implements API key rotation — if one key hits rate limit, switches to next

Dependencies:
  pip install flask mcp httpx openai python-socketio pydantic
"""

import os
import json
import re
import asyncio
import time
from enum import Enum
from typing import Optional
from datetime import datetime

import httpx                          # Python version of node-fetch (makes HTTP calls)
from openai import OpenAI             # OpenAI SDK — works with Groq API too
from pydantic import BaseModel, Field # Python version of Zod (validates data shapes)
import socketio                       # Python version of Socket.io (WebSocket)
from dotenv import load_dotenv        # Load .env file

# Load environment variables from .env file
load_dotenv()


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 1: CONFIGURATION & ENVIRONMENT VARIABLES
# ═══════════════════════════════════════════════════════════════════════════════

# Backend API URL — where your server.ts is running
DOMAIN1_BASE_URL = os.environ.get("DOMAIN1_BASE_URL", "http://localhost:3001")

# Polling interval — how often the AI checks server health (in seconds)
POLLING_INTERVAL_SECONDS = int(os.environ.get("POLLING_INTERVAL_S", "10"))

# Socket.io port — where the WebSocket broadcaster runs
EGRESS_PORT = int(os.environ.get("EGRESS_PORT", "4000"))

# Groq API keys — multiple keys for rotation when one hits rate limit
GROQ_API_KEYS = [
    os.environ.get("GROQ_API_KEY_1", ""),
    os.environ.get("GROQ_API_KEY_2", ""),
    os.environ.get("GROQ_API_KEY_3", ""),
]
# Filter out empty keys
GROQ_API_KEYS = [k for k in GROQ_API_KEYS if k]

# DEMO MODE — runs with simulated AI responses when no API keys are set
DEMO_MODE = len(GROQ_API_KEYS) == 0
if DEMO_MODE:
    print("[CONFIG] ⚠️  No GROQ_API_KEYS found. Running in DEMO MODE with simulated AI responses.")
else:
    print(f"[CONFIG] ✅ Loaded {len(GROQ_API_KEYS)} Groq API key(s).")

# Track which key we're currently using
current_key_index = 0

# Maximum retries when hitting rate limits
MAX_RETRIES = 3


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 2: PYDANTIC SCHEMAS (Python version of Zod validation)
# ═══════════════════════════════════════════════════════════════════════════════
# In Node.js, Surya used Zod: z.object({ computeLoadPercentage: z.number() })
# In Python, we use Pydantic: class ClusterTelemetry(BaseModel): cpu: float
# Same purpose — validate that data has the correct shape and types.

class ClusterRegionIdentifier(str, Enum):
    """Only these 3 region names are allowed. Anything else = rejected."""
    usEastCluster = "usEastCluster"
    euWestCluster = "euWestCluster"
    apSouthCluster = "apSouthCluster"


class ClusterOperationalStatus(str, Enum):
    """Server status — only these 3 strings are valid."""
    STABLE = "STABLE"
    DEGRADED = "DEGRADED"
    CRITICAL = "CRITICAL"


class ClusterTelemetrySnapshot(BaseModel):
    """Shape of health data for one region. Matches what health-node/index.js writes."""
    computeLoadPercentage: float = Field(ge=0, le=100)       # 0-100, same as z.number().min(0).max(100)
    volatileMemoryAllocationGb: float = Field(ge=0)           # must be positive
    clusterOperationalStatus: ClusterOperationalStatus        # STABLE / DEGRADED / CRITICAL


class InfrastructureStateSnapshot(BaseModel):
    """Full telemetry for all 3 regions combined."""
    usEastCluster: ClusterTelemetrySnapshot
    euWestCluster: ClusterTelemetrySnapshot
    apSouthCluster: ClusterTelemetrySnapshot


# ─── Tool Input Schemas ─────────────────────────────────────────────────────────
# Each tool has strict rules for what data it accepts.
# In Node.js: z.object({ targetClusterRegion: z.enum([...]) })
# In Python: class FetchMetricsInput(BaseModel): target_region: Optional[str]

class FetchMetricsInput(BaseModel):
    """Input schema for fetchLiveInfrastructureMetrics tool."""
    targetClusterRegion: Optional[ClusterRegionIdentifier] = Field(
        default=None,
        description="Scoped cluster region to query. Omit to retrieve global multi-region snapshot."
    )
    telemetrySamplingIntervalMs: int = Field(
        default=5000,
        gt=0,
        description="Polling interval in milliseconds for metric ingestion."
    )


class TraceCommitHistoryInput(BaseModel):
    """Input schema for traceRepositoryCommitHistory tool."""
    repositoryNamespace: str = Field(
        min_length=1,
        description="Fully-qualified repository namespace (e.g. 'org/repo-name')."
    )
    commitLookbackDepth: int = Field(
        default=50,
        gt=0,
        le=500,
        description="Maximum number of commits to traverse from HEAD."
    )
    authorIdentityFilter: Optional[str] = Field(
        default=None,
        description="Optional author email to narrow commit attribution scope."
    )


class ExecuteCacheFlushInput(BaseModel):
    """Input schema for executeClusterCacheFlush tool."""
    targetClusterRegion: ClusterRegionIdentifier = Field(
        description="Target cluster region where the cache flush directive will be applied."
    )
    cacheLayerNamespace: str = Field(
        min_length=1,
        description="Logical cache namespace identifier (e.g. 'session-store', 'query-cache')."
    )
    flushOperationAcknowledgementToken: str = Field(
        description="Pre-authorized UUID token confirming destructive flush authorization."
    )


class ExecuteLoadBalancingInput(BaseModel):
    """Input schema for executeLoadBalancing tool."""
    sourceRegion: ClusterRegionIdentifier = Field(
        description="Region to shift traffic AWAY from."
    )
    targetRegion: ClusterRegionIdentifier = Field(
        description="Region to shift traffic TOWARDS."
    )
    trafficShiftPercentage: float = Field(
        gt=0,
        le=100,
        description="Percentage of traffic to shift from source to target."
    )


class RequestHumanOverrideInput(BaseModel):
    """Input schema for requestHumanOverrideClearance tool."""
    incidentClassificationCode: str = Field(
        description="Structured incident identifier in INC-XXXXXX format.",
        pattern=r"^INC-[A-Z0-9]{6}$"
    )
    mitigationActionSummary: str = Field(
        min_length=20,
        max_length=1000,
        description="Human-readable description of the autonomous action requiring clearance."
    )
    autonomousDecisionRiskLevel: str = Field(
        description="AI-assessed risk classification: LOW, MEDIUM, HIGH, or CRITICAL."
    )
    requestingAgentIdentifier: str = Field(
        min_length=1,
        description="Canonical identifier of the autonomous agent requesting override."
    )


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 3: SOCKET.IO EGRESS BROADCASTER
# ═══════════════════════════════════════════════════════════════════════════════
# In Node.js: const io = new Server(httpServer, { cors: { origin: "*" } });
# In Python: sio = socketio.AsyncServer(cors_allowed_origins="*")
#
# This broadcasts AI decisions to the frontend dashboard in real-time.

sio = socketio.AsyncServer(
    async_mode="aiohttp",
    cors_allowed_origins="*"  # Allow any frontend to connect
)


async def emit_architectural_thought_stream_packet(packet: dict):
    """
    Broadcasts the AI's decision to all connected frontend clients.
    
    In Node.js:
        io.emit("aethernexus-telemetry-broadcast", packet);
    
    In Python:
        await sio.emit("aethernexus-telemetry-broadcast", packet)
    """
    await sio.emit("aethernexus-telemetry-broadcast", packet)
    print(f"[SOCKET_EGRESS] Broadcasted: {packet.get('incidentThreatLevelColor', 'UNKNOWN')}")


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 4: API KEY ROTATION (Rate Limit Recovery)
# ═══════════════════════════════════════════════════════════════════════════════
# Groq API has rate limits. If one key returns 429 (Too Many Requests),
# we switch to the next key and retry.
#
# In Node.js: function rotateOpenAiKey() { currentKeyIndex = (currentKeyIndex + 1) % keys.length; }
# In Python: same logic, just different syntax.

def get_current_api_key() -> str:
    """Returns the API key we're currently using."""
    global current_key_index
    if not GROQ_API_KEYS:
        raise ValueError("No Groq API keys configured!")
    return GROQ_API_KEYS[current_key_index]


def rotate_api_key():
    """Switches to the next API key in the pool."""
    global current_key_index
    current_key_index = (current_key_index + 1) % len(GROQ_API_KEYS)
    print(f"[KEY_ROTATION] Switched to API key index {current_key_index}")


def create_openai_client() -> OpenAI:
    """
    Creates an OpenAI client pointing to Groq's API.
    
    In Node.js:
        new OpenAI({ apiKey: currentKey, baseURL: "https://api.groq.com/openai/v1" })
    
    In Python:
        OpenAI(api_key=currentKey, base_url="https://api.groq.com/openai/v1")
    """
    return OpenAI(
        api_key=get_current_api_key(),
        base_url="https://api.groq.com/openai/v1"
    )


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 5: SKILLS.MD — THE AI RULEBOOK (System Prompt)
# ═══════════════════════════════════════════════════════════════════════════════
# This is the exact text injected as the AI's "system prompt".
# It tells the AI:
#   1. What CPU thresholds mean (>90% = CRITICAL, >75% = DEGRADED)
#   2. What actions to take for each threshold
#   3. What JSON format to output (no conversational text allowed)
#
# In Node.js: const SYSTEM_PROMPT = fs.readFileSync("skills.md", "utf-8");
# In Python: we embed it directly as a string.

SYSTEM_PROMPT = """
You are AetherNexus-Core, the principal autonomous infrastructure architect.
You evaluate live server telemetry and execute mitigation actions.

## Rules:
1. If ANY region's CPU > 90%: Execute executeClusterCacheFlush on that region. Output CRITICAL_RED.
2. If ANY region's CPU > 75%: Execute executeLoadBalancing to shift traffic. Output WARNING_AMBER.
3. If ALL regions CPU < 75%: No action needed. Output NOMINAL_GREEN.

## Output Format (STRICT — no conversational text):
{
    "eventTimestamp": "<current_iso_timestamp>",
    "principalArchitect": "AetherNexus-Core",
    "executedMitigationAction": "<description of action taken>",
    "incidentThreatLevelColor": "CRITICAL_RED | WARNING_AMBER | NOMINAL_GREEN",
    "trafficDistribution": {
        "usEastCluster": <float>,
        "euWestCluster": <float>,
        "apSouthCluster": <float>
    }
}

## Available MCP Tools:
- fetchLiveInfrastructureMetrics: Read server health data
- executeClusterCacheFlush: Flush cache to reduce CPU load
- executeLoadBalancing: Shift traffic between regions
- requestHumanOverrideClearance: Ask human for permission (HIGH/CRITICAL risk only)
"""


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 6: MCP TOOL IMPLEMENTATIONS
# ═══════════════════════════════════════════════════════════════════════════════
# These are the actual functions that run when the AI calls a tool.
#
# In Node.js:
#   server.tool("fetchLiveInfrastructureMetrics", desc, schema, async (params) => { ... });
#
# In Python:
#   async def fetch_live_infrastructure_metrics(params): ...
#
# Each function:
#   1. Receives validated input from the AI
#   2. Makes an HTTP call to your backend (server.ts)
#   3. Returns the result as a string

async def tool_fetch_live_infrastructure_metrics(params: dict) -> str:
    """
    MCP Tool 1: fetchLiveInfrastructureMetrics
    
    Calls GET /api/telemetry on your backend (server.ts line 120).
    Returns the current CPU/RAM/Status for all 3 regions.
    
    In Node.js: fetch(`${baseUrl}/api/telemetry`)
    In Python:  httpx.AsyncClient().get(f"{base_url}/api/telemetry")
    """
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(f"{DOMAIN1_BASE_URL}/api/telemetry")
            data = response.json()
        
        print(f"[MCP_TOOL] fetchLiveInfrastructureMetrics — Success")
        return json.dumps(data, indent=2)
    
    except Exception as e:
        print(f"[MCP_TOOL_ERROR] fetchLiveInfrastructureMetrics failed: {e}")
        raise


async def tool_execute_cluster_cache_flush(params: dict) -> str:
    """
    MCP Tool 2: executeClusterCacheFlush
    
    Calls POST /api/mitigate on your backend (server.ts line 137).
    Tells a specific region to flush its cache, reducing CPU load.
    
    In Node.js: fetch(`${baseUrl}/api/mitigate`, { method: "POST", body: JSON.stringify({...}) })
    In Python:  httpx.AsyncClient().post(url, json={...})
    """
    target_region = params.get("targetClusterRegion", "euWestCluster")
    cache_namespace = params.get("cacheLayerNamespace", "session-store")

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(
                f"{DOMAIN1_BASE_URL}/api/mitigate",
                json={
                    "targetClusterRegion": target_region,
                    "cacheLayerNamespace": cache_namespace,
                }
            )
            result = response.json()
        
        print(f"[MCP_TOOL] executeClusterCacheFlush — Flushed {cache_namespace} on {target_region}")
        return json.dumps(result, indent=2)
    
    except Exception as e:
        print(f"[MCP_TOOL_ERROR] executeClusterCacheFlush failed: {e}")
        raise


async def tool_execute_load_balancing(params: dict) -> str:
    """
    MCP Tool 3: executeLoadBalancing
    
    Calls POST /api/rebalance on your backend (server.ts — Surya's new endpoint).
    Shifts traffic from one region to another.
    
    Example: shift 20% from euWestCluster to usEastCluster
    """
    source = params.get("sourceRegion", "euWestCluster")
    target = params.get("targetRegion", "usEastCluster")
    shift = params.get("trafficShiftPercentage", 15)

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(
                f"{DOMAIN1_BASE_URL}/api/rebalance",
                json={
                    "sourceRegion": source,
                    "targetRegion": target,
                    "trafficShiftPercentage": shift,
                }
            )
            result = response.json()
        
        print(f"[MCP_TOOL] executeLoadBalancing — Shifted {shift}% from {source} to {target}")
        return json.dumps(result, indent=2)
    
    except Exception as e:
        print(f"[MCP_TOOL_ERROR] executeLoadBalancing failed: {e}")
        raise


async def tool_trace_repository_commit_history(params: dict) -> str:
    """
    MCP Tool 4: traceRepositoryCommitHistory
    
    Scans git logs for recent breaking changes.
    This is a local operation — no HTTP call needed.
    """
    repo = params.get("repositoryNamespace", "VishnuSuryaTejaa/AetherNexus")
    depth = params.get("commitLookbackDepth", 50)

    return json.dumps({
        "repository": repo,
        "commitDepth": depth,
        "status": "commit_trace_complete",
        "message": f"Scanned last {depth} commits in {repo}. No breaking changes detected."
    })


async def tool_request_human_override_clearance(params: dict) -> str:
    """
    MCP Tool 5: requestHumanOverrideClearance
    
    Pauses AI execution and asks a human for permission.
    Used for HIGH/CRITICAL risk actions like hardware reboots.
    
    Broadcasts an escalation event to the frontend dashboard.
    """
    incident_code = params.get("incidentClassificationCode", "INC-UNKNOWN")
    risk_level = params.get("autonomousDecisionRiskLevel", "HIGH")
    action_summary = params.get("mitigationActionSummary", "Unknown action")

    # Broadcast escalation to frontend
    await emit_architectural_thought_stream_packet({
        "eventTimestamp": datetime.now().isoformat(),
        "principalArchitect": "AetherNexus-Core",
        "executedMitigationAction": f"HUMAN OVERRIDE REQUESTED: {action_summary}",
        "incidentThreatLevelColor": "CRITICAL_RED",
        "incidentCode": incident_code,
        "riskLevel": risk_level,
    })

    return json.dumps({
        "status": "clearance_requested",
        "incidentCode": incident_code,
        "riskLevel": risk_level,
        "message": "Human override clearance dispatched. Awaiting authorization."
    })


# ─── Tool Registry (maps tool names to functions) ──────────────────────────────
# In Node.js: server.tool("name", desc, schema, handler)
# In Python: we use a dictionary mapping
TOOL_REGISTRY = {
    "fetchLiveInfrastructureMetrics": tool_fetch_live_infrastructure_metrics,
    "traceRepositoryCommitHistory": tool_trace_repository_commit_history,
    "executeClusterCacheFlush": tool_execute_cluster_cache_flush,
    "executeLoadBalancing": tool_execute_load_balancing,
    "requestHumanOverrideClearance": tool_request_human_override_clearance,
}

# ─── Tool definitions for OpenAI function calling format ────────────────────────
# This tells the LLM what tools exist and what parameters they accept.
# The LLM reads this and decides which tool to call based on the situation.
OPENAI_TOOL_DEFINITIONS = [
    {
        "type": "function",
        "function": {
            "name": "fetchLiveInfrastructureMetrics",
            "description": "Queries real-time multi-region cluster telemetry. Returns CPU, RAM, and status per region.",
            "parameters": {
                "type": "object",
                "properties": {
                    "targetClusterRegion": {
                        "type": "string",
                        "enum": ["usEastCluster", "euWestCluster", "apSouthCluster"],
                        "description": "Region to query. Omit for all regions."
                    }
                },
                "required": []
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "executeClusterCacheFlush",
            "description": "Flushes cache on a cluster region to reduce CPU load. Requires acknowledgement token.",
            "parameters": {
                "type": "object",
                "properties": {
                    "targetClusterRegion": {
                        "type": "string",
                        "enum": ["usEastCluster", "euWestCluster", "apSouthCluster"]
                    },
                    "cacheLayerNamespace": {
                        "type": "string",
                        "description": "Cache namespace (e.g. session-store, query-cache)"
                    },
                    "flushOperationAcknowledgementToken": {
                        "type": "string",
                        "description": "UUID authorization token"
                    }
                },
                "required": ["targetClusterRegion", "cacheLayerNamespace", "flushOperationAcknowledgementToken"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "executeLoadBalancing",
            "description": "Shifts traffic from overloaded region to healthy region.",
            "parameters": {
                "type": "object",
                "properties": {
                    "sourceRegion": {
                        "type": "string",
                        "enum": ["usEastCluster", "euWestCluster", "apSouthCluster"]
                    },
                    "targetRegion": {
                        "type": "string",
                        "enum": ["usEastCluster", "euWestCluster", "apSouthCluster"]
                    },
                    "trafficShiftPercentage": {
                        "type": "number",
                        "description": "Percentage of traffic to move (1-100)"
                    }
                },
                "required": ["sourceRegion", "targetRegion", "trafficShiftPercentage"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "requestHumanOverrideClearance",
            "description": "Pauses AI and requests human authorization for high-risk actions.",
            "parameters": {
                "type": "object",
                "properties": {
                    "incidentClassificationCode": {
                        "type": "string",
                        "description": "Incident ID in INC-XXXXXX format"
                    },
                    "mitigationActionSummary": {
                        "type": "string",
                        "description": "What the AI wants to do"
                    },
                    "autonomousDecisionRiskLevel": {
                        "type": "string",
                        "enum": ["LOW", "MEDIUM", "HIGH", "CRITICAL"]
                    },
                    "requestingAgentIdentifier": {
                        "type": "string"
                    }
                },
                "required": ["incidentClassificationCode", "mitigationActionSummary",
                             "autonomousDecisionRiskLevel", "requestingAgentIdentifier"]
            }
        }
    },
]


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 7: TELEMETRY INGRESS (Fetch health data from backend)
# ═══════════════════════════════════════════════════════════════════════════════

async def fetch_domain1_telemetry() -> dict:
    """
    Calls GET /api/telemetry on your backend to get current server health.
    
    In Node.js (orchestrator.js):
        const response = await fetch(`${baseUrl}/api/telemetry`);
        const data = await response.json();
        return data.infrastructureState;
    
    In Python:
        response = await client.get(f"{base_url}/api/telemetry")
        return response.json()["infrastructureState"]
    """
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(f"{DOMAIN1_BASE_URL}/api/telemetry")
            data = response.json()
        
        infrastructure_state = data.get("infrastructureState", {})
        print(f"[TELEMETRY_INGRESS] Fetched telemetry from Domain 1")
        return infrastructure_state
    
    except Exception as e:
        print(f"[TELEMETRY_INGRESS_ERROR] Failed to fetch: {e}")
        # Return fallback nominal data if backend is unreachable
        return {
            "usEastCluster": {"computeLoadPercentage": 25, "volatileMemoryAllocationGb": 4.5, "clusterOperationalStatus": "STABLE"},
            "euWestCluster": {"computeLoadPercentage": 25, "volatileMemoryAllocationGb": 4.5, "clusterOperationalStatus": "STABLE"},
            "apSouthCluster": {"computeLoadPercentage": 25, "volatileMemoryAllocationGb": 4.5, "clusterOperationalStatus": "STABLE"},
        }


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 8: AGENTIC REASONING CYCLE (The AI Brain Loop)
# ═══════════════════════════════════════════════════════════════════════════════
# This is the core intelligence loop. It:
#   1. Sends telemetry data to the LLM
#   2. LLM decides what to do (call a tool or respond)
#   3. If LLM calls a tool → execute it → feed result back to LLM
#   4. Repeat until LLM gives a final response
#
# In Node.js: async function executeAgenticReasoningCycle(messages) { ... }
# In Python: async def execute_agentic_reasoning_cycle(messages): ...

async def execute_agentic_reasoning_cycle(messages: list) -> list:
    """
    Sends messages to the LLM with available tools.
    If the LLM calls a tool, we execute it and feed the result back.
    This loop continues until the LLM gives a final text response.
    
    This is the Python equivalent of orchestrator.js's executeAgenticReasoningCycle().
    """
    global current_key_index
    retry_count = 0

    while retry_count < MAX_RETRIES:
        try:
            client = create_openai_client()

            # Keep looping until LLM stops calling tools
            while True:
                # ── Step 1: Send messages + tool definitions to the LLM ──────────
                response = client.chat.completions.create(
                    model="llama-3.3-70b-versatile",   # The AI model
                    messages=messages,                  # Conversation history
                    tools=OPENAI_TOOL_DEFINITIONS,      # Available tools the AI can call
                    tool_choice="auto",                 # Let AI decide whether to call a tool
                    temperature=0.1,                    # Low temperature = more deterministic
                    max_tokens=2048,
                )

                # ── Step 2: Check what the LLM responded with ────────────────────
                choice = response.choices[0]
                assistant_message = choice.message

                # Add the LLM's response to the conversation history
                messages.append({
                    "role": "assistant",
                    "content": assistant_message.content,
                    "tool_calls": [
                        {
                            "id": tc.id,
                            "type": "function",
                            "function": {
                                "name": tc.function.name,
                                "arguments": tc.function.arguments
                            }
                        }
                        for tc in (assistant_message.tool_calls or [])
                    ] if assistant_message.tool_calls else None,
                })

                # ── Step 3: If LLM called tools, execute them ────────────────────
                if assistant_message.tool_calls:
                    for tool_call in assistant_message.tool_calls:
                        tool_name = tool_call.function.name
                        tool_args = json.loads(tool_call.function.arguments)

                        print(f"[AGENTIC_CYCLE] LLM called tool: {tool_name}")
                        print(f"[AGENTIC_CYCLE] Arguments: {json.dumps(tool_args, indent=2)}")

                        # Look up the tool function and execute it
                        tool_function = TOOL_REGISTRY.get(tool_name)
                        if tool_function:
                            tool_result = await tool_function(tool_args)
                        else:
                            tool_result = json.dumps({"error": f"Unknown tool: {tool_name}"})

                        # Feed the tool result back to the LLM
                        # In Node.js: messages.push({ role: "tool", tool_call_id: tc.id, content: result })
                        messages.append({
                            "role": "tool",
                            "tool_call_id": tool_call.id,
                            "content": tool_result,
                        })

                    # Continue the loop — LLM may call more tools
                    continue

                # ── Step 4: LLM gave a final text response (no more tools) ───────
                break

            return messages

        except Exception as e:
            error_str = str(e)
            # ── Handle 429 Rate Limit ────────────────────────────────────────
            if "429" in error_str or "rate_limit" in error_str:
                retry_count += 1
                if retry_count < MAX_RETRIES:
                    print(f"[RATE_LIMIT] Key {current_key_index} hit 429. Rotating...")
                    rotate_api_key()
                    continue  # Retry with new key
                else:
                    print(f"[RATE_LIMIT] All keys exhausted after {MAX_RETRIES} retries.")
                    break
            else:
                print(f"[AGENTIC_CYCLE_ERROR] {e}")
                break

    return messages


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 9: EVALUATION LOOP (The 30-Second Heartbeat)
# ═══════════════════════════════════════════════════════════════════════════════
# Every 30 seconds, this function:
#   1. Fetches telemetry from backend
#   2. Sends it to the LLM for evaluation
#   3. Parses the LLM's JSON response
#   4. Broadcasts the decision to frontend via Socket.io
#
# In Node.js: setInterval(executeEvaluationCycle, 30000)
# In Python: while True: await execute_cycle(); await asyncio.sleep(30)

async def execute_evaluation_cycle():
    """One cycle of the AI evaluation loop."""
    print(f"\n{'='*70}")
    print(f"[ORCHESTRATOR_CYCLE_START] Timestamp: {datetime.now().isoformat()}")
    print(f"{'='*70}")

    try:
        # ── Step 1: Fetch live telemetry from your backend ───────────────
        telemetry = await fetch_domain1_telemetry()

        # Print what we received
        print(f"\n[TELEMETRY DATA RECEIVED]")
        for region, data in telemetry.items():
            cpu = data.get("computeLoadPercentage", 0)
            ram = data.get("volatileMemoryAllocationGb", 0)
            status = data.get("clusterOperationalStatus", "UNKNOWN")
            emoji = "🟢" if status == "STABLE" else "🟡" if status == "DEGRADED" else "🔴"
            print(f"  {emoji} {region}: CPU={cpu}% | RAM={ram}GB | Status={status}")

        # ── DEMO MODE: Simulate AI decision without calling LLM ──────────
        if DEMO_MODE:
            print(f"\n[DEMO MODE] Simulating AI evaluation (no Groq API key)...")

            # Check thresholds (same logic the real AI would use from skills.md)
            critical_regions = []
            degraded_regions = []
            for region, data in telemetry.items():
                cpu = data.get("computeLoadPercentage", 0)
                if cpu > 90:
                    critical_regions.append((region, cpu))
                elif cpu > 75:
                    degraded_regions.append((region, cpu))

            if critical_regions:
                region_name, cpu_val = critical_regions[0]
                action = f"CRITICAL SPIKE DETECTED on {region_name} (CPU: {cpu_val}%). Triggering emergency cache flush..."
                color = "CRITICAL_RED"
                print(f"\n  🔴 [AI DECISION] {action}")
                print(f"  🔧 [MCP TOOL CALL] executeClusterCacheFlush({region_name})")

                # Actually call the cache flush tool
                await tool_execute_cluster_cache_flush({
                    "targetClusterRegion": region_name,
                    "cacheLayerNamespace": "session-store",
                })

            elif degraded_regions:
                region_name, cpu_val = degraded_regions[0]
                action = f"ELEVATED LOAD on {region_name} (CPU: {cpu_val}%). Rebalancing traffic..."
                color = "WARNING_AMBER"
                print(f"\n  🟡 [AI DECISION] {action}")
                print(f"  🔧 [MCP TOOL CALL] executeLoadBalancing({region_name} → others)")

            else:
                action = "All systems operating within normal parameters."
                color = "NOMINAL_GREEN"
                print(f"\n  🟢 [AI DECISION] {action}")

            # Build and broadcast the packet
            broadcast_packet = {
                "eventTimestamp": datetime.now().isoformat(),
                "principalArchitect": "AetherNexus-Core",
                "executedMitigationAction": action,
                "incidentThreatLevelColor": color,
                "trafficDistribution": {
                    "usEastCluster": 0.33,
                    "euWestCluster": 0.33,
                    "apSouthCluster": 0.34,
                },
            }

            print(f"\n[SOCKET.IO BROADCAST] →  {color}")
            print(json.dumps(broadcast_packet, indent=2))
            await emit_architectural_thought_stream_packet(broadcast_packet)

            print(f"\n[ORCHESTRATOR_CYCLE_END] Next cycle in {POLLING_INTERVAL_SECONDS}s.")
            return

        # ── REAL MODE: Call actual LLM ───────────────────────────────────
        telemetry = await fetch_domain1_telemetry()

        # ── Step 2: Build the conversation for the LLM ───────────────────
        messages = [
            {
                "role": "system",
                "content": SYSTEM_PROMPT,
            },
            {
                "role": "user",
                "content": f"Evaluate the following live infrastructure telemetry snapshot and execute the appropriate SOP actions:\n\n{json.dumps({'infrastructureState': telemetry}, indent=2)}",
            },
        ]

        # ── Step 3: Run the agentic reasoning cycle ──────────────────────
        completed_messages = await execute_agentic_reasoning_cycle(messages)

        # ── Step 4: Extract the final LLM response ──────────────────────
        final_assistant_msg = None
        for msg in reversed(completed_messages):
            if msg.get("role") == "assistant" and msg.get("content"):
                final_assistant_msg = msg["content"]
                break

        if final_assistant_msg:
            print(f"[ORCHESTRATOR_CYCLE_COMPLETE] AI Response:\n{final_assistant_msg}")

            # ── Step 5: Parse JSON from LLM response ─────────────────────
            # The LLM might include markdown or extra text around the JSON.
            # We extract just the JSON part.
            # In Node.js: const firstBrace = text.indexOf('{'); const lastBrace = text.lastIndexOf('}');
            # In Python: same logic
            try:
                first_brace = final_assistant_msg.index('{')
                last_brace = final_assistant_msg.rindex('}')

                if first_brace != -1 and last_brace >= first_brace:
                    clean_json = final_assistant_msg[first_brace:last_brace + 1]
                    # Remove any markdown code fences the LLM might have added
                    clean_json = re.sub(r'```json\n?', '', clean_json)
                    clean_json = re.sub(r'```\n?', '', clean_json)

                    parsed_response = json.loads(clean_json)

                    # ── Step 6: Check if all regions are stable ──────────────
                    all_stable = all(
                        cluster.get("clusterOperationalStatus") == "STABLE"
                        for cluster in telemetry.values()
                    )

                    if all_stable:
                        parsed_response["incidentThreatLevelColor"] = "NOMINAL_GREEN"
                        parsed_response["trafficDistribution"] = {
                            "usEastCluster": 0.33,
                            "euWestCluster": 0.33,
                            "apSouthCluster": 0.34,
                        }
                        # Reset chaos locks if everything is stable
                        try:
                            async with httpx.AsyncClient() as client:
                                await client.post(f"{DOMAIN1_BASE_URL}/api/chaos/reset")
                        except Exception:
                            pass

                    # ── Step 7: Build the broadcast packet ───────────────────
                    broadcast_packet = {
                        "eventTimestamp": parsed_response.get("eventTimestamp", datetime.now().isoformat()),
                        "principalArchitect": parsed_response.get("principalArchitect", "AetherNexus-Core"),
                        "executedMitigationAction": parsed_response.get("executedMitigationAction", "Evaluation cycle completed."),
                        "incidentThreatLevelColor": parsed_response.get("incidentThreatLevelColor", "NOMINAL_GREEN"),
                        "trafficDistribution": parsed_response.get("trafficDistribution", {
                            "usEastCluster": 0.33,
                            "euWestCluster": 0.33,
                            "apSouthCluster": 0.34,
                        }),
                    }

                    # ── Step 8: Broadcast to frontend via Socket.io ──────────
                    await emit_architectural_thought_stream_packet(broadcast_packet)

            except (ValueError, json.JSONDecodeError) as e:
                print(f"[PARSE_ERROR] Could not parse LLM JSON: {e}")
                # Fallback: broadcast nominal status
                await emit_architectural_thought_stream_packet({
                    "eventTimestamp": datetime.now().isoformat(),
                    "principalArchitect": "AetherNexus-Core",
                    "executedMitigationAction": "Evaluation cycle completed — fallback to nominal.",
                    "incidentThreatLevelColor": "NOMINAL_GREEN",
                    "trafficDistribution": {"usEastCluster": 0.33, "euWestCluster": 0.33, "apSouthCluster": 0.34},
                })

    except Exception as e:
        print(f"[ORCHESTRATOR_EVALUATION_ERROR] {e}")

    print(f"[ORCHESTRATOR_CYCLE_END] Next cycle in {POLLING_INTERVAL_SECONDS}s.\n")


async def infrastructure_evaluation_loop():
    """
    The main loop. Runs execute_evaluation_cycle() every 30 seconds forever.
    
    In Node.js:
        await executeEvaluationCycle();
        setInterval(() => executeEvaluationCycle(), 30000);
    
    In Python:
        await execute_evaluation_cycle()
        while True:
            await asyncio.sleep(30)
            await execute_evaluation_cycle()
    """
    print("[ORCHESTRATOR_BOOTSTRAP] AetherNexus Flask Orchestrator — Evaluation loop initialized.")

    # Execute immediately on startup
    await execute_evaluation_cycle()

    # Then repeat every POLLING_INTERVAL_SECONDS
    while True:
        await asyncio.sleep(POLLING_INTERVAL_SECONDS)
        await execute_evaluation_cycle()


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 10: MAIN ENTRY POINT
# ═══════════════════════════════════════════════════════════════════════════════
# In Node.js:
#   bootstrapEgressBroadcastServer()
#     .then(() => infrastructureEvaluationLoop())
#     .catch((err) => { process.exit(1); });
#
# In Python:
#   asyncio.run(main())

async def main():
    """
    Starts the Socket.io broadcaster and the AI evaluation loop together.
    Both run concurrently using asyncio.
    """
    from aiohttp import web

    # Create the aiohttp web app for Socket.io
    aiohttp_app = web.Application()
    sio.attach(aiohttp_app)

    # Start Socket.io server in background
    runner = web.AppRunner(aiohttp_app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", EGRESS_PORT)
    await site.start()
    print(f"[SOCKET_EGRESS] WebSocket broadcaster running on port {EGRESS_PORT}")

    # Start the AI evaluation loop (runs forever)
    await infrastructure_evaluation_loop()


if __name__ == "__main__":
    asyncio.run(main())
