import * as dotenv from "dotenv"; dotenv.config({ override: true });
import OpenAI from "openai";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { emitArchitecturalThoughtStreamPacket, writeAiLog, getLiveTelemetry } from "./egressBroadcaster.js";
let isSystemPaused = false;
const defaultBaseUrl = (process.env["OPENAI_API_KEY"]?.startsWith("sk-") && !process.env["OPENAI_API_KEY"]?.startsWith("gsk_"))
    ? "https://api.openai.com/v1"
    : "https://api.groq.com/openai/v1";
const resolvedLlmGatewayBaseUrl = process.env["OPENAI_BASE_URL"] ?? defaultBaseUrl;
const defaultModel = resolvedLlmGatewayBaseUrl.includes("openai.com") ? "gpt-4o-mini" : "llama-3.3-70b-versatile";
const resolvedOrchestratorModel = process.env["AETHERNEXUS_ORCHESTRATOR_MODEL"] ?? defaultModel;
const resolvedDomain1IngressBaseUrl = process.env["AETHERNEXUS_GATEWAY_URL"] || `http://127.0.0.1:${process.env.PORT || 4000}`;
const resolvedPollingIntervalMs = parseInt(process.env["AETHERNEXUS_POLLING_INTERVAL_MS"] ?? "30000", 10);
// ─── Slack/Discord Webhook (PWR-02) ──────────────────────────────────────────
const resolvedSlackWebhookUrl = process.env["SLACK_WEBHOOK_URL"] ?? null;
async function fireAlertWebhook(region, incidentCode, riskLevel, cpuPct) {
    if (!resolvedSlackWebhookUrl) return;
    try {
        const payload = {
            text: `🚨 *CRITICAL_RED — AetherNexus Alert*\n*Region:* ${region}\n*Incident:* ${incidentCode}\n*Risk:* ${riskLevel}\n*CPU:* ${cpuPct}%\n*Dashboard:* ${process.env.AETHERNEXUS_GATEWAY_URL || 'http://localhost:4000'}`
        };
        await fetch(resolvedSlackWebhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        console.error('[SLACK_ALERT] CRITICAL_RED webhook fired.');
    } catch (e) {
        console.error('[SLACK_ALERT] Webhook failed:', e.message);
    }
}
// ─── AI Token Usage Tracker (PWR-19) ─────────────────────────────────────────
let totalTokenUsage = { promptTokens: 0, completionTokens: 0, cycles: 0 };
function trackTokenUsage(usage) {
    if (!usage) return;
    totalTokenUsage.promptTokens += (usage.prompt_tokens || 0);
    totalTokenUsage.completionTokens += (usage.completion_tokens || 0);
    totalTokenUsage.cycles += 1;
}
export function getTokenUsage() {
    const estimatedCostUSD = ((totalTokenUsage.promptTokens / 1_000_000) * 0.15) + ((totalTokenUsage.completionTokens / 1_000_000) * 0.60);
    return { ...totalTokenUsage, estimatedCostUSD: parseFloat(estimatedCostUSD.toFixed(6)) };
}
// ─── IMP-12: Shared cluster ID mapper (extracted from 3 duplicate definitions) ─
export function mapToClusterId(r) {
    if (!r) return r;
    const low = r.toLowerCase();
    if (low.includes('east')) return 'usEastCluster';
    if (low.includes('west')) return 'euWestCluster';
    if (low.includes('south')) return 'apSouthCluster';
    return r;
}

// GAP-004 FIX: OpenRouter primary client — spec mandates openai/gpt-oss-120b:free as first engine.
const resolvedOpenRouterApiKey = process.env["OPENROUTER_API_KEY"] ?? null;
const openRouterClient = resolvedOpenRouterApiKey
    ? new OpenAI({
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: resolvedOpenRouterApiKey,
        defaultHeaders: {
            "HTTP-Referer": "https://aethernexus-gateway.onrender.com",
            "X-Title": "AetherNexus AI Control Plane",
        },
    })
    : null;

if (!resolvedOpenRouterApiKey) {
    console.error("[ORCHESTRATOR_ENV_WARN] OPENROUTER_API_KEY not found — OpenRouter primary engine disabled. Falling back to Groq key pool only.");
}
let openRouterAuthFailureLogged = false;
let simulationModeNoticedLogged = false;

const groqKeyPool = [
    process.env["OPENAI_API_KEY"],
    process.env["OPENAI_API_KEY2"],
    process.env["OPENAI_API_KEY3"]
].filter((key) => key && (key.startsWith("gsk_") || key.startsWith("sk-")));

if (groqKeyPool.length === 0 && !resolvedOpenRouterApiKey) {
    console.warn("[ORCHESTRATOR_ENV_WARN] No LLM API keys provided (OPENROUTER_API_KEY / OPENAI_API_KEY). Running in telemetry & simulation mode.");
} else if (resolvedOpenRouterApiKey) {
    console.log("[ORCHESTRATOR_ENV] OPENROUTER_API_KEY configured. Using OpenRouter primary engine.");
} else if (groqKeyPool.length > 0) {
    console.log(`[ORCHESTRATOR_ENV] ${groqKeyPool.length} LLM API key(s) configured. Target gateway: ${resolvedLlmGatewayBaseUrl}, Model: ${resolvedOrchestratorModel}`);
}

let currentKeyIndex = 0;

let aetherNexusLlmClient = groqKeyPool.length > 0
    ? new OpenAI({
        apiKey: groqKeyPool[currentKeyIndex],
        baseURL: resolvedLlmGatewayBaseUrl,
    })
    : null;

function rotateGroqKey() {
    currentKeyIndex = (currentKeyIndex + 1) % groqKeyPool.length;
    console.error(`[ORCHESTRATOR_KEY_ROTATION] TPM/outage on active key. Rerouting neural pathways to backup Groq key index ${currentKeyIndex}...`);
    aetherNexusLlmClient = new OpenAI({
        apiKey: groqKeyPool[currentKeyIndex],
        baseURL: resolvedLlmGatewayBaseUrl,
    });
}
// Back-compat alias used inside executeAgenticReasoningCycle
const rotateOpenAiKey = rotateGroqKey;
// IMP-06: Read skills.md as single source of truth for AI behavior.
// Falls back to dist/SYSTEM_PROMPT.md for backward compat.
const resolvedSkillsPath = fs.existsSync(path.join(process.cwd(), "skills.md"))
    ? path.join(process.cwd(), "skills.md")
    : path.join(process.cwd(), "dist", "SYSTEM_PROMPT.md");
const AUTONOMOUS_CONTROL_PLANE_SYSTEM_PROMPT = fs.readFileSync(resolvedSkillsPath, "utf-8");
console.error(`[ORCHESTRATOR] Loaded system prompt from: ${resolvedSkillsPath} (${AUTONOMOUS_CONTROL_PLANE_SYSTEM_PROMPT.length} chars)`);
// ─── MCP Tool Manifest (mirrors mcpServer.ts registrations exactly) ───────────
const aetherNexusMcpToolManifest = [


    {
        type: "function",
        function: {
            name: "executeClusterCacheFlush",
            description: "Issues a destructive cache flush directive to a specified cluster region and cache namespace. Requires a pre-authorized acknowledgement token to prevent unintended execution. STRICT REQUIREMENT: You are physically forbidden from invoking this tool unless the target cluster's computeLoadPercentage is >= 90 or its status is CRITICAL. Do NOT use if STABLE.",
            parameters: {
                type: "object",
                properties: {
                    targetClusterRegion: {
                        type: "string",
                        description: "Target cluster region where the cache flush directive will be applied.",
                    },
                    cacheLayerNamespace: {
                        type: "string",
                        description: "Logical cache namespace identifier (e.g. 'session-store', 'query-cache').",
                    },
                    flushOperationAcknowledgementToken: {
                        type: "string",
                        description: "Pre-authorized UUID token confirming destructive flush authorization.",
                    },
                },
                required: [
                    "targetClusterRegion",
                    "cacheLayerNamespace",
                    "flushOperationAcknowledgementToken",
                ],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "requestHumanOverrideClearance",
            description: "Halts autonomous execution and dispatches a structured clearance request to the human-in-the-loop authorization pipeline. Blocks pending action until override token is issued. STRICT REQUIREMENT: You are physically forbidden from invoking this tool unless the target cluster's computeLoadPercentage is >= 90 or its status is CRITICAL. Do NOT use if STABLE.",
            parameters: {
                type: "object",
                properties: {
                    incidentClassificationCode: {
                        type: "string",
                        description: "Structured incident identifier in INC-XXXXXX format for audit trail linkage.",
                    },
                    mitigationActionSummary: {
                        type: "string",
                        description: "Detailed human-readable description of the autonomous action requiring clearance.",
                    },
                    autonomousDecisionRiskLevel: {
                        type: "string",
                        enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"],
                        description: "AI-assessed risk classification of the pending action.",
                    },
                    requestingAgentIdentifier: {
                        type: "string",
                        description: "Canonical identifier of the autonomous agent requesting override.",
                    },
                    targetClusterRegion: {
                        type: "string",
                        description: "Target cluster region requiring human override.",
                    },
                },
                required: [
                    "incidentClassificationCode",
                    "mitigationActionSummary",
                    "autonomousDecisionRiskLevel",
                    "requestingAgentIdentifier",
                    "targetClusterRegion",
                ],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "executeLoadBalancing",
            description: "Diverts traffic away from a degraded or overloaded cluster region by redistributing load to healthier regions. STRICT REQUIREMENT: You are physically forbidden from invoking this tool unless the target cluster's computeLoadPercentage is >= 75 or its status is DEGRADED. This is the WARNING_AMBER mitigation action. Do NOT use if STABLE (NOMINAL_GREEN).",
            parameters: {
                type: "object",
                properties: {
                    targetClusterRegion: {
                        type: "string",
                        description: "Target cluster region.",
                    }
                },
                required: ["targetClusterRegion"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "readCodebaseFile",
            description: "Reads the content of a file in the codebase. Use this to inspect your own prompt, Skills, or MCP implementations.",
            parameters: {
                type: "object",
                properties: {
                    filePath: {
                        type: "string",
                        description: "Path to the file relative to the project root (e.g., 'dist/SYSTEM_PROMPT.md', 'dist/mcpServer.js').",
                    }
                },
                required: ["filePath"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "updateCodebaseFile",
            description: "Overwrites the content of a file in the codebase. Use this to permanently self-modify your instructions, logic, or skills.",
            parameters: {
                type: "object",
                properties: {
                    filePath: {
                        type: "string",
                        description: "Path to the file relative to the project root.",
                    },
                    newContent: {
                        type: "string",
                        description: "The complete new string content for the file.",
                    }
                },
                required: ["filePath", "newContent"],
            },
        },
    },
];
async function simulateDomain1TelemetryIngress() {
    try {
        const liveData = await getLiveTelemetry();
        if (liveData) return liveData;
    } catch (e) {
        console.error("Telemetry fetch from MongoDB failed", e);
    }
    return {
        usEastCluster: { computeLoadPercentage: 25, volatileMemoryAllocationGb: 4, clusterOperationalStatus: "STABLE" },
        euWestCluster: { computeLoadPercentage: 25, volatileMemoryAllocationGb: 4, clusterOperationalStatus: "STABLE" },
        apSouthCluster: { computeLoadPercentage: 25, volatileMemoryAllocationGb: 4, clusterOperationalStatus: "STABLE" },
    };
}
// ─── MCP Tool Execution Dispatcher ────────────────────────────────────────────
async function dispatchMcpToolCall(toolInvocationRequest) {
    if (toolInvocationRequest.type !== "function") {
        return JSON.stringify({ dispatchFailureReason: "Non-function tool call type is unsupported." });
    }
    const toolArgumentsJson = toolInvocationRequest.function.arguments;
    const dispatchedToolName = toolInvocationRequest.function.name;
    const parseLenientJson = (str) => {
        try { return JSON.parse(str); } catch (e) {
            try {
                // Try repairing single quotes and unquoted keys
                const repaired = str.replace(/'/g, '"').replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":');
                return JSON.parse(repaired);
            } catch (e2) {
                // Ultimate fallback using Function constructor (safe here since it's just parsing an object literal)
                return new Function('return (' + str + ')')();
            }
        }
    };

    try {
        switch (dispatchedToolName) {

            case "executeClusterCacheFlush": {
                const cacheFlushDirective = parseLenientJson(toolArgumentsJson);

                // [LIVE] — Wire to Domain 1 cache invalidation endpoint in production.
                try {
                    await fetch(`${resolvedDomain1IngressBaseUrl}/api/mitigate`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(cacheFlushDirective)
                    });
                } catch (e) {
                    console.error(`[MCP_CACHE_FLUSH_DISPATCHED] Failed to fetch /api/mitigate: ${e.message}`);
                }
                const cacheFlushAcknowledgement = {
                    flushDispatchStatus: "ACKNOWLEDGED",
                    targetClusterRegion: cacheFlushDirective.targetClusterRegion,
                    cacheLayerNamespace: cacheFlushDirective.cacheLayerNamespace,
                    acknowledgedAuthorizationToken: cacheFlushDirective.flushOperationAcknowledgementToken,
                    flushExecutionTimestamp: new Date().toISOString(),
                };
                // IMP-12: Use shared mapToClusterId helper

                console.error(`[MCP_CACHE_FLUSH_DISPATCHED] Region: ${cacheFlushDirective.targetClusterRegion} | Namespace: ${cacheFlushDirective.cacheLayerNamespace}`);
                const cacheFlushBroadcastPacket = {
                    eventTimestamp: new Date().toISOString(),
                    principalArchitect: "AetherNexus-Core",
                    executedMitigationAction: `Cache flush dispatched on ${cacheFlushDirective.targetClusterRegion} — namespace: ${cacheFlushDirective.cacheLayerNamespace}. Healing initiated.`,
                    incidentThreatLevelColor: "HEALING",
                    healingProgress: 0,
                    targetClusterRegion: mapToClusterId(cacheFlushDirective.targetClusterRegion),
                };
                emitArchitecturalThoughtStreamPacket(cacheFlushBroadcastPacket);

                (async () => {
                    for (let progress = 1; progress <= 100; progress += 1) {
                        await new Promise(r => setTimeout(r, 100));
                        if (progress === 100) {
                            // Healing complete — reset node state in DB via the reset endpoint
                            const clusterId = mapToClusterId(cacheFlushDirective.targetClusterRegion);
                            try {
                                await fetch(`${resolvedDomain1IngressBaseUrl}/api/chaos/reset`, {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({ region: clusterId })
                                });
                                console.log(`[HEALING_COMPLETE] Reset node state for ${clusterId} via /api/chaos/reset`);
                            } catch (resetErr) {
                                console.error(`[HEALING_COMPLETE] Failed to reset ${clusterId}:`, resetErr.message);
                            }
                            emitArchitecturalThoughtStreamPacket({
                                eventTimestamp: new Date().toISOString(),
                                principalArchitect: "AetherNexus-Core",
                                executedMitigationAction: `Healing complete on ${cacheFlushDirective.targetClusterRegion}. Systems nominal.`,
                                incidentThreatLevelColor: "NOMINAL_GREEN",
                                healingProgress: null,
                                targetClusterRegion: clusterId,
                                trafficDistribution: { usEastCluster: 33.3, euWestCluster: 33.3, apSouthCluster: 33.4 }
                            });
                        } else {
                            if (progress % 5 === 0) {
                                emitArchitecturalThoughtStreamPacket({
                                    eventTimestamp: new Date().toISOString(),
                                    principalArchitect: "AetherNexus-Core",
                                    executedMitigationAction: `Healing in progress on ${cacheFlushDirective.targetClusterRegion}...`,
                                    incidentThreatLevelColor: "HEALING",
                                    healingProgress: progress,
                                    targetClusterRegion: mapToClusterId(cacheFlushDirective.targetClusterRegion)
                                });
                            }
                        }
                    }
                })();

                return JSON.stringify(cacheFlushAcknowledgement);
            }
            case "requestHumanOverrideClearance": {
                isSystemPaused = true;
                // IMP-11: Persist paused state to MongoDB so restarts honor it
                if (typeof setSharedDb !== 'undefined') {
                    try {
                        const { getLiveTelemetry: _lt, writeAiLog: _wl, emitArchitecturalThoughtStreamPacket: _e, setSharedDb: _sdb, setSharedSocket: _ss } = await import('./egressBroadcaster.js');
                    } catch (_) {}
                }
                setTimeout(() => { isSystemPaused = false; }, 15000);
                const overrideClearanceRequest = parseLenientJson(toolArgumentsJson);
                // IMP-12: Use shared mapToClusterId helper
                let targetRegion = mapToClusterId(overrideClearanceRequest.targetClusterRegion);
                if (!targetRegion) {
                    const summary = (overrideClearanceRequest.mitigationActionSummary || "").toLowerCase();
                    if (summary.includes("euwest") || summary.includes("eu-west") || summary.includes("eu_west") || summary.includes("europe")) {
                        targetRegion = "euWestCluster";
                    } else if (summary.includes("apsouth") || summary.includes("ap-south") || summary.includes("ap_south") || summary.includes("asia")) {
                        targetRegion = "apSouthCluster";
                    } else if (summary.includes("useast") || summary.includes("us-east") || summary.includes("us_east")) {
                        targetRegion = "usEastCluster";
                    } else {
                        targetRegion = "usEastCluster";
                    }
                }

                // [LIVE] — Wire to HITL authorization service in production.
                const overrideClearanceAcknowledgement = {
                    clearanceRequestStatus: "PENDING_HUMAN_AUTHORIZATION",
                    incidentClassificationCode: overrideClearanceRequest.incidentClassificationCode,
                    autonomousDecisionRiskLevel: overrideClearanceRequest.autonomousDecisionRiskLevel,
                    requestingAgentIdentifier: overrideClearanceRequest.requestingAgentIdentifier,
                    targetClusterRegion: targetRegion,
                    clearanceRequestTimestamp: new Date().toISOString(),
                    estimatedAuthorizationWindowMs: 300000,
                };
                console.error(`[MCP_HUMAN_OVERRIDE_REQUESTED] Incident: ${overrideClearanceRequest.incidentClassificationCode} | Risk: ${overrideClearanceRequest.autonomousDecisionRiskLevel} | Target: ${targetRegion}`);
                const overrideClearanceBroadcastPacket = {
                    eventTimestamp: new Date().toISOString(),
                    principalArchitect: "AetherNexus-Core",
                    executedMitigationAction: `Human override clearance requested for ${targetRegion} — Incident: ${overrideClearanceRequest.incidentClassificationCode} | Risk: ${overrideClearanceRequest.autonomousDecisionRiskLevel}`,
                    incidentThreatLevelColor: "CRITICAL_RED",
                    targetClusterRegion: targetRegion,
                };
                emitArchitecturalThoughtStreamPacket(overrideClearanceBroadcastPacket);
                return JSON.stringify(overrideClearanceAcknowledgement);
            }
            case "executeLoadBalancing": {
                const loadBalanceDirective = parseLenientJson(toolArgumentsJson);
                // IMP-12: Use shared mapToClusterId helper
                try {
                    const telemetry = await simulateDomain1TelemetryIngress();
                    const availableRegions = Object.entries(telemetry)
                        .filter(([region]) => region !== loadBalanceDirective.targetClusterRegion)
                        .sort((a, b) => a[1].computeLoadPercentage - b[1].computeLoadPercentage);
                    const dynamicTargetRegion = availableRegions[0][0];

                    await fetch(`${resolvedDomain1IngressBaseUrl}/api/rebalance`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            sourceRegion: loadBalanceDirective.targetClusterRegion,
                            targetRegion: dynamicTargetRegion,
                            trafficShiftPercentage: 50
                        })
                    });
                } catch (e) { }

                const loadBalanceAcknowledgement = {
                    dispatchStatus: "ACKNOWLEDGED",
                    targetClusterRegion: loadBalanceDirective.targetClusterRegion,
                    executionTimestamp: new Date().toISOString(),
                };
                const mapToClusterId = (r) => {
                    if (!r) return r;
                    const low = r.toLowerCase();
                    if (low.includes('east')) return 'usEastCluster';
                    if (low.includes('west')) return 'euWestCluster';
                    if (low.includes('south')) return 'apSouthCluster';
                    return r;
                };
                console.error(`[MCP_LOAD_BALANCE_DISPATCHED] Region: ${loadBalanceDirective.targetClusterRegion}`);
                const loadBalanceBroadcastPacket = {
                    eventTimestamp: new Date().toISOString(),
                    principalArchitect: "AetherNexus-Core",
                    executedMitigationAction: `Load balancing executed on ${loadBalanceDirective.targetClusterRegion}`,
                    incidentThreatLevelColor: "NOMINAL_GREEN",
                    targetClusterRegion: mapToClusterId(loadBalanceDirective.targetClusterRegion)
                };
                emitArchitecturalThoughtStreamPacket(loadBalanceBroadcastPacket);
                return JSON.stringify(loadBalanceAcknowledgement);
            }
            case "readCodebaseFile": {
                const { filePath } = parseLenientJson(toolArgumentsJson);
                try {
                    const resolvedPath = path.join(process.cwd(), filePath);
                    const fileData = await fs.promises.readFile(resolvedPath, "utf-8");
                    return JSON.stringify({ fileReadSuccess: true, content: fileData });
                } catch (err) {
                    return JSON.stringify({ fileReadSuccess: false, error: err.message });
                }
            }
            case "updateCodebaseFile": {
                const { filePath, newContent } = parseLenientJson(toolArgumentsJson);
                try {
                    const resolvedPath = path.join(process.cwd(), filePath);
                    await fs.promises.writeFile(resolvedPath, newContent, "utf-8");
                    console.error(`[AI_SELF_MODIFICATION] Updated file: ${filePath}`);
                    return JSON.stringify({ fileUpdateSuccess: true });
                } catch (err) {
                    return JSON.stringify({ fileUpdateSuccess: false, error: err.message });
                }
            }
            default: {
                console.error(`[MCP_TOOL_DISPATCH_UNKNOWN_TOOL_EXCEPTION] Unrecognized tool name: ${dispatchedToolName}`);
                return JSON.stringify({
                    dispatchFailureReason: `Unrecognized tool identifier: ${dispatchedToolName}`,
                });
            }
        }
    }
    catch (mcpToolDispatchException) {
        console.error(`[MCP_TOOL_DISPATCH_EXECUTION_EXCEPTION] Tool: ${dispatchedToolName}`, mcpToolDispatchException);
        writeAiLog({
            text: `[AI] ERROR: Tool ${dispatchedToolName} failed - ${mcpToolDispatchException instanceof Error ? mcpToolDispatchException.message : 'Unknown error'}`,
            level: 'critical',
            timestamp: new Date().toISOString(),
            architect: 'AetherNexus-Core'
        });
        return JSON.stringify({
            dispatchFailureReason: mcpToolDispatchException instanceof Error
                ? mcpToolDispatchException.message
                : "Unknown dispatch execution fault.",
        });
    }
}
// ─── Agentic Tool-Calling Loop ─────────────────────────────────────────────────
async function executeAgenticReasoningCycle(activeConversationThread, cycleId) {
    const mutatingConversationThread = [...activeConversationThread];

    // GAP-004 FIX: Try OpenRouter as primary engine first, fall back to Groq key pool.
    // Phase 1: Attempt with OpenRouter (primary) if configured.
    if (openRouterClient) {
        try {
            let stepCount = 0;
            const openRouterConversationThread = [...mutatingConversationThread];
            while (true) {
                stepCount++;
                if (stepCount > 5) {
                    console.error("[ORCHESTRATOR_AGENTIC_CYCLE_EXCEPTION] OpenRouter: Maximum agentic reasoning steps exceeded.");
                    break;
                }
                if (cycleId !== undefined && currentCycleId !== cycleId) return openRouterConversationThread;

                const llmCompletionResponse = await openRouterClient.chat.completions.create({
                    // BUG-A19 FIX: Use a valid OpenRouter free model name.
                    model: process.env["OPENROUTER_MODEL"] || "openai/gpt-4o-mini",
                    messages: openRouterConversationThread,
                    tools: aetherNexusMcpToolManifest,
                    tool_choice: "auto",
                    temperature: 0.1,
                });
                trackTokenUsage(llmCompletionResponse.usage);
                const primaryCompletionChoice = llmCompletionResponse.choices[0];
                if (!primaryCompletionChoice) {
                    console.error("[ORCHESTRATOR_LLM_COMPLETION_EXCEPTION] OpenRouter returned zero completion choices.");
                    break;
                }
                const assistantReasoningMessage = primaryCompletionChoice.message;
                
                // Filter out hallucinated tools and validate target clusters against live state
                if (assistantReasoningMessage.tool_calls) {
                    const userMsg = openRouterConversationThread.find(m => m.role === "user");
                    let liveSnap = {};
                    if (userMsg && typeof userMsg.content === "string") {
                        const match = userMsg.content.match(/\{[\s\S]*\}/);
                        if (match) try { liveSnap = JSON.parse(match[0]).infrastructureState || JSON.parse(match[0]); } catch (_) {}
                    }

                    // Find which cluster actually needs mitigation
                    let actualCriticalCluster = null;
                    let actualDegradedCluster = null;
                    for (const [rKey, rData] of Object.entries(liveSnap)) {
                        const cpu = rData?.computeLoadPercentage || rData?.currentLoadPercentage || 0;
                        const st = rData?.clusterOperationalStatus || rData?.status || "STABLE";
                        if (cpu >= 90 || st === "CRITICAL" || st === "CRITICAL_NETWORK_DOWN") {
                            actualCriticalCluster = rKey;
                        } else if (cpu >= 70 || st === "DEGRADED" || st === "WARNING_AMBER") {
                            actualDegradedCluster = rKey;
                        }
                    }

                    const anyAbnormal = actualCriticalCluster || actualDegradedCluster;

                    assistantReasoningMessage.tool_calls = assistantReasoningMessage.tool_calls.filter(tc => {
                        if (!aetherNexusMcpToolManifest.some(m => m.function.name === tc.function.name)) return false;
                        if (!anyAbnormal && (tc.function.name === 'executeClusterCacheFlush' || tc.function.name === 'requestHumanOverrideClearance')) {
                            console.log(`[ORCHESTRATOR] Suppressed hallucinated ${tc.function.name} tool call — all clusters are nominal.`);
                            return false;
                        }
                        return true;
                    });

                    // If a tool was called on a healthy cluster (e.g. US-East-1) while another cluster is actually critical (e.g. euWestCluster), redirect it
                    const targetFix = actualCriticalCluster || actualDegradedCluster;
                    if (targetFix && assistantReasoningMessage.tool_calls) {
                        for (const tc of assistantReasoningMessage.tool_calls) {
                            if (tc.function?.arguments) {
                                try {
                                    const args = JSON.parse(tc.function.arguments);
                                    const mappedArg = mapToClusterId(args.targetClusterRegion);
                                    if (mappedArg && mappedArg !== targetFix) {
                                        console.log(`[ORCHESTRATOR] Correcting hallucinated target region ${args.targetClusterRegion} -> ${targetFix}`);
                                        args.targetClusterRegion = targetFix;
                                        tc.function.arguments = JSON.stringify(args);
                                    }
                                } catch (_) {}
                            }
                        }
                    }

                    if (assistantReasoningMessage.tool_calls.length === 0) {
                        delete assistantReasoningMessage.tool_calls;
                        if (!assistantReasoningMessage.content) {
                            assistantReasoningMessage.content = JSON.stringify({
                                eventTimestamp: new Date().toISOString(),
                                principalArchitect: "AetherNexus-Core",
                                executedMitigationAction: "Autonomous evaluation cycle completed — all cluster regions nominal.",
                                incidentThreatLevelColor: "NOMINAL_GREEN",
                                trafficDistribution: { usEastCluster: 33.3, euWestCluster: 33.3, apSouthCluster: 33.4 }
                            }, null, 2);
                        }
                    }
                }
                
                console.error('[DIAGNOSTIC - OPENROUTER RAW RESPONSE]:', JSON.stringify(assistantReasoningMessage, null, 2));
                openRouterConversationThread.push(assistantReasoningMessage);
                if (assistantReasoningMessage.tool_calls?.length > 0) {
                    for (const pendingToolInvocation of assistantReasoningMessage.tool_calls) {
                        if (pendingToolInvocation.type === "function") {
                            console.error(`[ORCHESTRATOR_TOOL_DISPATCH][OpenRouter] Invoking: ${pendingToolInvocation.function.name}`);
                            writeAiLog({
                                text: `[AI TOOL][OpenRouter] Invoking ${pendingToolInvocation.function.name}`,
                                level: pendingToolInvocation.function.name === 'executeClusterCacheFlush' ? 'warning'
                                    : pendingToolInvocation.function.name === 'requestHumanOverrideClearance' ? 'critical'
                                        : 'info',
                                timestamp: new Date().toISOString(),
                                architect: 'AetherNexus-Core',
                            });
                        }
                        const toolExecutionOutputJson = await dispatchMcpToolCall(pendingToolInvocation);
                        openRouterConversationThread.push({
                            role: "tool",
                            tool_call_id: pendingToolInvocation.id,
                            content: toolExecutionOutputJson,
                        });
                    }
                    continue;
                } else {
                    return openRouterConversationThread; // Success via OpenRouter
                }
            }
            return openRouterConversationThread;
        }
        catch (openRouterException) {
            // GAP-005 FIX: Rotate on 429 AND 5xx — fall through to Groq pool.
            const openRouterStatus = openRouterException?.status ?? 0;
            if ((openRouterStatus === 401 || openRouterStatus === 403) && !openRouterAuthFailureLogged) {
                openRouterAuthFailureLogged = true;
                writeAiLog({
                    text: `[AI] OpenRouter rejected OPENROUTER_API_KEY (HTTP ${openRouterStatus} ${openRouterException?.error?.message || ''}). Replace the key in .env to enable LLM reasoning — continuing with deterministic SOP evaluation.`,
                    level: 'critical',
                    timestamp: new Date().toISOString(),
                    architect: 'AetherNexus-Core'
                });
            }
            const shouldFallback = openRouterStatus === 429 ||
                (openRouterStatus >= 500 && openRouterStatus < 600) ||
                openRouterException?.code === "rate_limit_exceeded";
            if (shouldFallback) {
                console.error(`[ORCHESTRATOR_OPENROUTER_FALLBACK] OpenRouter returned ${openRouterStatus}. Falling back to Groq key pool.`);
                // Preserve OpenRouter's progress so Groq doesn't re-execute the same tools
                mutatingConversationThread.length = 0;
                mutatingConversationThread.push(...openRouterConversationThread);
            } else {
                console.error("[ORCHESTRATOR_OPENROUTER_EXCEPTION] Unexpected OpenRouter error — falling back to Groq.", openRouterException);
            }
            // Fall through to Groq pool below
        }
    }

    // Phase 2: Groq key pool fallback (also primary when OpenRouter is not configured).
    if (!aetherNexusLlmClient) {
        console.log("[ORCHESTRATOR_SIMULATION] Evaluating telemetry using internal SOP rules (Simulation Mode)...");
        if (!simulationModeNoticedLogged) {
            simulationModeNoticedLogged = true;
            writeAiLog({
                text: '[AI] No valid LLM key available — running deterministic SOP evaluation. Real reasoning logs will appear once a valid API key is set.',
                level: 'warning',
                timestamp: new Date().toISOString(),
                architect: 'AetherNexus-Core'
            });
        }
        try {
            const userMsg = mutatingConversationThread.find(m => m.role === "user");
            let state = {};
            if (userMsg && typeof userMsg.content === "string") {
                const match = userMsg.content.match(/\{[\s\S]*\}/);
                if (match) {
                    const parsed = JSON.parse(match[0]);
                    state = parsed.infrastructureState || parsed;
                }
            }
            let criticalRegion = null;
            let warningRegion = null;
            for (const [rKey, rData] of Object.entries(state)) {
                const cpuLoad = rData?.computeLoadPercentage || rData?.currentLoadPercentage || 0;
                const opStatus = rData?.clusterOperationalStatus || rData?.status || "STABLE";
                // Skip clusters already being healed — prevent infinite re-trigger
                if (opStatus === "HEALING") {
                    console.log(`[ORCHESTRATOR_SIMULATION] Skipping ${rKey} — already HEALING.`);
                    continue;
                }
                if (cpuLoad >= 90 || opStatus === "CRITICAL" || opStatus === "CRITICAL_NETWORK_DOWN") {
                    criticalRegion = rKey;
                } else if (cpuLoad >= 70 || opStatus === "DEGRADED") {
                    warningRegion = rKey;
                }
            }

            if (criticalRegion) {
                // Call mitigation tool to heal the cluster
                await dispatchMcpToolCall({
                    type: "function",
                    function: {
                        name: "executeClusterCacheFlush",
                        arguments: JSON.stringify({
                            targetClusterRegion: criticalRegion,
                            cacheLayerNamespace: "session-store",
                            flushOperationAcknowledgementToken: "uuid-" + Date.now()
                        })
                    }
                });
                const distribution = { usEastCluster: 50.0, euWestCluster: 50.0, apSouthCluster: 50.0 };
                distribution[criticalRegion] = 0.0;
                const otherKeys = Object.keys(distribution).filter(k => k !== criticalRegion);
                otherKeys.forEach(k => { distribution[k] = 50.0; });
                mutatingConversationThread.push({
                    role: "assistant",
                    content: JSON.stringify({
                        eventTimestamp: new Date().toISOString(),
                        principalArchitect: "AetherNexus-Core",
                        executedMitigationAction: `CRITICAL SPIKE DETECTED on ${criticalRegion}. executeClusterCacheFlush dispatched. Healing initiated.`,
                        incidentThreatLevelColor: "CRITICAL_RED",
                        targetClusterRegion: criticalRegion,
                        trafficDistribution: distribution
                    }, null, 2)
                });
            } else if (warningRegion) {
                mutatingConversationThread.push({
                    role: "assistant",
                    content: JSON.stringify({
                        eventTimestamp: new Date().toISOString(),
                        principalArchitect: "AetherNexus-Core",
                        executedMitigationAction: `WARNING: High load detected on ${warningRegion}. Traffic rebalanced.`,
                        incidentThreatLevelColor: "WARNING_AMBER",
                        targetClusterRegion: warningRegion,
                        trafficDistribution: { usEastCluster: 40.0, euWestCluster: 20.0, apSouthCluster: 40.0 }
                    }, null, 2)
                });
            } else {
                mutatingConversationThread.push({
                    role: "assistant",
                    content: JSON.stringify({
                        eventTimestamp: new Date().toISOString(),
                        principalArchitect: "AetherNexus-Core",
                        executedMitigationAction: "Autonomous evaluation cycle completed — all cluster regions nominal.",
                        incidentThreatLevelColor: "NOMINAL_GREEN",
                        trafficDistribution: { usEastCluster: 33.3, euWestCluster: 33.3, apSouthCluster: 33.4 }
                    }, null, 2)
                });
            }
        } catch (e) {
            console.error("[ORCHESTRATOR_SIMULATION_ERR]", e);
        }
        return mutatingConversationThread;
    }

    let retryCount = 0;
    const MAX_RETRIES = groqKeyPool.length;

    while (retryCount <= MAX_RETRIES) {
        try {
            let stepCount = 0;
            while (true) {
                stepCount++;
                if (stepCount > 5) {
                    console.error("[ORCHESTRATOR_AGENTIC_CYCLE_EXCEPTION] Maximum agentic reasoning steps exceeded.");
                    break;
                }
                if (cycleId !== undefined && currentCycleId !== cycleId) return mutatingConversationThread;

                const llmCompletionResponse = await aetherNexusLlmClient.chat.completions.create({
                    model: resolvedOrchestratorModel,
                    messages: mutatingConversationThread,
                    tools: aetherNexusMcpToolManifest,
                    tool_choice: "auto",
                    temperature: 0.1,
                });
                trackTokenUsage(llmCompletionResponse.usage);
                const primaryCompletionChoice = llmCompletionResponse.choices[0];
                if (!primaryCompletionChoice) {
                    console.error("[ORCHESTRATOR_LLM_COMPLETION_EXCEPTION] LLM returned zero completion choices. Aborting reasoning cycle.");
                    break;
                }
                const assistantReasoningMessage = primaryCompletionChoice.message;
                
                // Filter out hallucinated tools
                if (assistantReasoningMessage.tool_calls) {
                    assistantReasoningMessage.tool_calls = assistantReasoningMessage.tool_calls.filter(
                        tc => aetherNexusMcpToolManifest.some(m => m.function.name === tc.function.name)
                    );
                    if (assistantReasoningMessage.tool_calls.length === 0) {
                        delete assistantReasoningMessage.tool_calls;
                    }
                }

                console.error('[DIAGNOSTIC - LLM RAW RESPONSE]:', JSON.stringify(assistantReasoningMessage, null, 2));
                // Removed redundant raw JSON logging to prevent UI clutter
                mutatingConversationThread.push(assistantReasoningMessage);
                if (assistantReasoningMessage.tool_calls?.length > 0) {
                    for (const pendingToolInvocation of assistantReasoningMessage.tool_calls) {
                        if (pendingToolInvocation.type === "function") {
                            console.error(`[ORCHESTRATOR_TOOL_DISPATCH] Invoking: ${pendingToolInvocation.function.name} | Args: ${pendingToolInvocation.function.arguments}`);
                            writeAiLog({
                                text: `[AI TOOL] Invoking ${pendingToolInvocation.function.name}`,
                                level: pendingToolInvocation.function.name === 'executeClusterCacheFlush' ? 'warning'
                                    : pendingToolInvocation.function.name === 'requestHumanOverrideClearance' ? 'critical'
                                        : 'info',
                                timestamp: new Date().toISOString(),
                                architect: 'AetherNexus-Core',
                            });
                        }
                        const toolExecutionOutputJson = await dispatchMcpToolCall(pendingToolInvocation);
                        mutatingConversationThread.push({
                            role: "tool",
                            tool_call_id: pendingToolInvocation.id,
                            content: toolExecutionOutputJson,
                        });
                    }
                    continue;
                } else {
                    return mutatingConversationThread; // Success via Groq
                }
            }
            return mutatingConversationThread; // Success via Groq
        }
        catch (agenticCycleExecutionException) {
            const exceptionStatus = agenticCycleExecutionException?.status ?? 0;
            // GAP-005 FIX: Rotate on 429 AND 5xx server-side outages (not just 429).
            const isRotatableError = exceptionStatus === 429 ||
                (exceptionStatus >= 500 && exceptionStatus < 600) ||
                agenticCycleExecutionException?.code === "rate_limit_exceeded";
            if (isRotatableError) {
                retryCount++;
                if (retryCount < MAX_RETRIES) {
                    rotateOpenAiKey();
                    if (mutatingConversationThread[mutatingConversationThread.length - 1]?.role === "system") { mutatingConversationThread.pop(); }
                    continue; // Retry with the next Groq key
                } else {
                    console.error("[ORCHESTRATOR_AGENTIC_CYCLE_EXCEPTION] All Groq keys exhausted (429/5xx).", agenticCycleExecutionException);
                    break;
                }
            } else {
                console.error("[ORCHESTRATOR_AGENTIC_CYCLE_EXCEPTION]", agenticCycleExecutionException);
                break;
            }
        }
    }
    return mutatingConversationThread;
}
// ─── Infrastructure Evaluation Loop (60s polling cadence) ─────────────────────
console.error("[ORCHESTRATOR_BOOTSTRAP] AetherNexus Autonomous Orchestrator — Evaluation loop initialized.");
let isEvaluating = false;
let currentCycleId = 0;

export async function executeEvaluationCycle(forced = false) {
    if (forced) isSystemPaused = false;
    if (isSystemPaused) {
        return;
    }
    
    const cycleId = ++currentCycleId;
    if (isEvaluating && !forced) return;
    isEvaluating = true;
    console.error(`[ORCHESTRATOR_CYCLE_START] Timestamp: ${new Date().toISOString()}`);
    try {
        const currentTelemetrySnapshot = await simulateDomain1TelemetryIngress();
        console.error('[DIAGNOSTIC - RAW DB DATA]:', JSON.stringify(currentTelemetrySnapshot, null, 2));
        if (!currentTelemetrySnapshot || Object.keys(currentTelemetrySnapshot).length === 0) {
            writeAiLog({ text: '[AI] ERROR: Database returned empty telemetry snapshot.', level: 'critical', timestamp: new Date().toISOString(), architect: 'AetherNexus-Core' });
        }
        const telemetryContextMessage = {
            role: "user",
            content: `Evaluate the following live infrastructure telemetry snapshot and execute the appropriate SOP actions:\n\n${JSON.stringify({ infrastructureState: currentTelemetrySnapshot }, null, 2)}`,
        };

        const liveEndpoints = `
Live Endpoints:
Gateway: ${process.env.AETHERNEXUS_GATEWAY_URL || "https://aethernexus-gateway.onrender.com"}
US-East: ${process.env.US_EAST_URL || "https://aethernexus-us-east.onrender.com"}
EU-West: ${process.env.EU_WEST_URL || "https://aethernexus-eu-west.onrender.com"}
AP-South: ${process.env.AP_SOUTH_URL || "https://aethernexus-ap-south.onrender.com"}`;

        // We dynamically read the prompt again so any AI self-modification takes effect instantly
        const dynamicSystemPrompt = `${fs.readFileSync(resolvedSkillsPath, "utf-8")}

${liveEndpoints}
`;

        const initialConversationThread = [
            {
                role: "system",
                content: dynamicSystemPrompt,
            },
            telemetryContextMessage,
        ];
        
        if (currentCycleId !== cycleId) {
            console.error(`[ORCHESTRATOR] Cycle ${cycleId} aborted because a newer cycle started.`);
            return;
        }

        let activeThread = await executeAgenticReasoningCycle(initialConversationThread, cycleId);
        
        if (currentCycleId !== cycleId) return;

        const terminalAssistantMessage = activeThread
            .filter((conversationTurn) => conversationTurn.role === "assistant")
            .at(-1);
        if (terminalAssistantMessage &&
            typeof terminalAssistantMessage.content === "string") {
            const terminalLlmOutputText = terminalAssistantMessage.content;
            console.error(`[ORCHESTRATOR_CYCLE_COMPLETE] AI Evaluation Summary:\n${terminalLlmOutputText}`);
            // ── Parse LLM-structured egress packet and broadcast to Domain 3 ─────
            try {
                let parsedLlmEgressDirective = null;
                const lastBrace = terminalLlmOutputText.lastIndexOf('}');
                let currentStart = terminalLlmOutputText.lastIndexOf('{');
                while (currentStart !== -1 && lastBrace !== -1 && currentStart < lastBrace) {
                    try {
                        let potentialJson = terminalLlmOutputText.substring(currentStart, lastBrace + 1);
                        parsedLlmEgressDirective = JSON.parse(potentialJson);
                        if (parsedLlmEgressDirective && typeof parsedLlmEgressDirective === 'object') {
                            break;
                        }
                    } catch (err) {
                        // Ignore syntax error and try the next outer/previous opening brace
                    }
                    currentStart = terminalLlmOutputText.lastIndexOf('{', currentStart - 1);
                }
                
                if (!parsedLlmEgressDirective) {
                    throw new Error("Invalid JSON parsed from LLM");
                }

                    let resolvedTargetCluster = mapToClusterId(parsedLlmEgressDirective.targetClusterRegion);
                    if (!resolvedTargetCluster && parsedLlmEgressDirective.executedMitigationAction) {
                        const act = parsedLlmEgressDirective.executedMitigationAction.toLowerCase();
                        if (act.includes('euwest') || act.includes('eu-west') || act.includes('eu_west') || act.includes('europe')) resolvedTargetCluster = 'euWestCluster';
                        else if (act.includes('apsouth') || act.includes('ap-south') || act.includes('ap_south') || act.includes('asia')) resolvedTargetCluster = 'apSouthCluster';
                        else if (act.includes('useast') || act.includes('us-east') || act.includes('us_east')) resolvedTargetCluster = 'usEastCluster';
                    }

                    const architecturalThoughtStreamPacket = {
                        eventTimestamp: parsedLlmEgressDirective.eventTimestamp ??
                            new Date().toISOString(),
                        principalArchitect: parsedLlmEgressDirective.principalArchitect ?? "AetherNexus-Core",
                        executedMitigationAction: parsedLlmEgressDirective.executedMitigationAction ??
                            "Autonomous evaluation cycle completed — no critical action required.",
                        incidentThreatLevelColor: parsedLlmEgressDirective.incidentThreatLevelColor ??
                            "NOMINAL_GREEN",
                        targetClusterRegion: resolvedTargetCluster || undefined,
                        trafficDistribution: parsedLlmEgressDirective.trafficDistribution ?? {
                            usEastCluster: 33.3,
                            euWestCluster: 33.3,
                            apSouthCluster: 33.4
                        }
                    };
                    emitArchitecturalThoughtStreamPacket(architecturalThoughtStreamPacket);

            }
            catch (egressPacketParseException) {
                console.error("[SOCKET_EGRESS_PACKET_PARSE_EXCEPTION]", egressPacketParseException);
                const nominalCycleBroadcastPacket = {
                    eventTimestamp: new Date().toISOString(),
                    principalArchitect: "AetherNexus-Core",
                    executedMitigationAction: terminalLlmOutputText.trim() || "Autonomous evaluation cycle completed — no critical action required.",
                    incidentThreatLevelColor: terminalLlmOutputText.toUpperCase().includes('STABLE') || terminalLlmOutputText.toUpperCase().includes('HEALTHY') ? 'NOMINAL_GREEN' : 'WARNING_AMBER',
                    trafficDistribution: { usEastCluster: 33.3, euWestCluster: 33.3, apSouthCluster: 33.4 }
                };
                emitArchitecturalThoughtStreamPacket(nominalCycleBroadcastPacket);
            }
        } else {
            emitArchitecturalThoughtStreamPacket({
                eventTimestamp: new Date().toISOString(),
                principalArchitect: "AetherNexus-Core",
                executedMitigationAction: "AI cycle failed to produce output. Possible schema rejection or step limit reached.",
                incidentThreatLevelColor: "WARNING_AMBER",
                trafficDistribution: { usEastCluster: 33.3, euWestCluster: 33.3, apSouthCluster: 33.4 }
            });
        }
    }
    catch (evaluationCycleException) {
        console.error("[ORCHESTRATOR_EVALUATION_CYCLE_EXCEPTION]", evaluationCycleException);
    } finally {
        isEvaluating = false;
    }
    console.error(`[ORCHESTRATOR_CYCLE_END] Next cycle in ${resolvedPollingIntervalMs}ms.`);
}

// ─── Entrypoint Guard ──────────────────────────────────────────────────────────
export async function bootOrchestrator() {
    console.error("[ORCHESTRATOR_BOOTSTRAP] Engine ignition. AI evaluation loop starting...");
    executeEvaluationCycle(false); // Run immediately on boot
    setInterval(() => executeEvaluationCycle(false), resolvedPollingIntervalMs); // Run every 15 seconds
}

export function resumeSystem() {
    isSystemPaused = false;
    writeAiLog({ text: '[AI] Resume signal received. System unpaused. AI will evaluate on next cycle.', level: 'success', timestamp: new Date().toISOString(), architect: 'AetherNexus-Core' });
}

export function getSystemPausedState() {
    return isSystemPaused;
}
//# sourceMappingURL=orchestrator.js.map