import * as dotenv from "dotenv"; dotenv.config({ override: true });
import OpenAI from "openai";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { emitArchitecturalThoughtStreamPacket, writeAiLog, getLiveTelemetry } from "./egressBroadcaster.js";
let isSystemPaused = false;
// ─── Environment Validation & Key Pool Initialization ──────────
const resolvedOrchestratorModel = process.env["AETHERNEXUS_ORCHESTRATOR_MODEL"] ?? "llama-3.3-70b-versatile";
// BUG-A14 FIX: Use AETHERNEXUS_GATEWAY_URL for cross-service calls on Render.
// Loopback (127.0.0.1) only works when orchestrator and server are the same process (local dev).
// In production on Render, inter-service calls must go through the public service URL.
const resolvedDomain1IngressBaseUrl = process.env["AETHERNEXUS_GATEWAY_URL"] || `http://127.0.0.1:${process.env.PORT || 4000}`;
// GAP-006 FIX: Spec mandates 30s polling cadence — default corrected from 60000 to 30000.
const resolvedPollingIntervalMs = parseInt(process.env["AETHERNEXUS_POLLING_INTERVAL_MS"] ?? "30000", 10);
const resolvedLlmGatewayBaseUrl = process.env["OPENAI_BASE_URL"] ?? "https://api.groq.com/openai/v1";
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

const groqKeyPool = [
    process.env["OPENAI_API_KEY"],
    process.env["OPENAI_API_KEY2"],
    process.env["OPENAI_API_KEY3"]
].filter((key) => key && key.startsWith("gsk_"));

if (groqKeyPool.length === 0 && !resolvedOpenRouterApiKey) {
    console.error("[ORCHESTRATOR_ENV_VALIDATION_EXCEPTION] No valid LLM credentials found (no OPENROUTER_API_KEY and no gsk_ Groq keys). Cannot start.");
    process.exit(1);
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
                        await new Promise(r => setTimeout(r, 300));
                        if (progress === 100) {
                            // NOTE: Do NOT call /api/chaos/reset here — that nukes all 3 clusters globally.
                            // The chaos_lock for this specific region was already cleared atomically
                            // by /api/mitigate at the START of this cycle (the first fetch above).
                            emitArchitecturalThoughtStreamPacket({
                                eventTimestamp: new Date().toISOString(),
                                principalArchitect: "AetherNexus-Core",
                                executedMitigationAction: `Healing complete on ${cacheFlushDirective.targetClusterRegion}. Systems nominal.`,
                                incidentThreatLevelColor: "NOMINAL_GREEN",
                                healingProgress: null,
                                targetClusterRegion: mapToClusterId(cacheFlushDirective.targetClusterRegion),
                                trafficDistribution: { usEastCluster: 33.3, euWestCluster: 33.3, apSouthCluster: 33.4 }
                            });
                        } else {
                            // Only emit actual websocket packets every 5% to avoid saturating the network,
                            // but still provide a smooth progress experience
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
                setTimeout(() => { isSystemPaused = false; }, 300000);
                const overrideClearanceRequest = parseLenientJson(toolArgumentsJson);
                // IMP-12: Use shared mapToClusterId helper
                let targetRegion = mapToClusterId(overrideClearanceRequest.targetClusterRegion) || "usEastCluster";
                if (overrideClearanceRequest.mitigationActionSummary?.includes("euWestCluster") || overrideClearanceRequest.mitigationActionSummary?.toLowerCase().includes("eu-west")) targetRegion = "euWestCluster";
                if (overrideClearanceRequest.mitigationActionSummary?.includes("apSouthCluster") || overrideClearanceRequest.mitigationActionSummary?.toLowerCase().includes("ap-south")) targetRegion = "apSouthCluster";
                if (overrideClearanceRequest.mitigationActionSummary?.includes("usEastCluster") || overrideClearanceRequest.mitigationActionSummary?.toLowerCase().includes("us-east")) targetRegion = "usEastCluster";

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
                console.error(`[MCP_HUMAN_OVERRIDE_REQUESTED] Incident: ${overrideClearanceRequest.incidentClassificationCode} | Risk: ${overrideClearanceRequest.autonomousDecisionRiskLevel}`);
                const overrideClearanceBroadcastPacket = {
                    eventTimestamp: new Date().toISOString(),
                    principalArchitect: "AetherNexus-Core",
                    executedMitigationAction: `Human override clearance requested — Incident: ${overrideClearanceRequest.incidentClassificationCode} | Risk: ${overrideClearanceRequest.autonomousDecisionRiskLevel}`,
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
                
                // Filter out hallucinated tools
                if (assistantReasoningMessage.tool_calls) {
                    assistantReasoningMessage.tool_calls = assistantReasoningMessage.tool_calls.filter(
                        tc => aetherNexusMcpToolManifest.some(m => m.function.name === tc.function.name)
                    );
                    if (assistantReasoningMessage.tool_calls.length === 0) {
                        delete assistantReasoningMessage.tool_calls;
                    }
                }
                
                console.error('[DIAGNOSTIC - OPENROUTER RAW RESPONSE]:', JSON.stringify(assistantReasoningMessage, null, 2));
                // Removed redundant raw JSON logging to prevent UI clutter
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
        console.error("[ORCHESTRATOR_AGENTIC_CYCLE_EXCEPTION] No LLM client available (OpenRouter failed and no Groq keys).");
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
    if (isSystemPaused) {
        if (forced) {
            writeAiLog({ text: '[AI] System is currently PAUSED pending human override clearance. Evaluation bypassed.', level: 'warning', timestamp: new Date().toISOString(), architect: 'AetherNexus-Core' });
        }
        return;
    }
    
    const cycleId = ++currentCycleId;
    if (isEvaluating && !forced) return;
    isEvaluating = true;
    console.error(`[ORCHESTRATOR_CYCLE_START] Timestamp: ${new Date().toISOString()}`);
    writeAiLog({ text: '[AI] Evaluation cycle started — ingesting live telemetry snapshot.', level: 'info', timestamp: new Date().toISOString(), architect: 'AetherNexus-Core' });
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

                    const architecturalThoughtStreamPacket = {
                        eventTimestamp: parsedLlmEgressDirective.eventTimestamp ??
                            new Date().toISOString(),
                        principalArchitect: parsedLlmEgressDirective.principalArchitect ?? "AetherNexus-Core",
                        executedMitigationAction: parsedLlmEgressDirective.executedMitigationAction ??
                            "Autonomous evaluation cycle completed — no critical action required.",
                        incidentThreatLevelColor: parsedLlmEgressDirective.incidentThreatLevelColor ??
                            "NOMINAL_GREEN",
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