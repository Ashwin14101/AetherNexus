
let db = null;

export async function writeAiLog(payload) {
    if (!db) return;
    try {
        await db.collection('ai_logs').insertOne({
            timestamp: payload.timestamp ? new Date(payload.timestamp) : new Date(),
            level: payload.level,
            text: payload.text,
            architect: payload.architect || 'AetherNexus-Core'
        });
        if (aetherNexusSocketIoEgressServer) {
            aetherNexusSocketIoEgressServer.emit('ai-log', payload);
        }
    } catch (e) {
        console.error("[writeAiLog] Error inserting AI log:", e);
    }
}

export async function getLiveTelemetry() {
    if (!db) return null;
    try {
        const results = await db.collection('node_states').find({}).toArray();
        const infrastructureState = {
            usEastCluster: { computeLoadPercentage: 0, volatileMemoryAllocationGb: 0, clusterOperationalStatus: 'STABLE' },
            euWestCluster: { computeLoadPercentage: 0, volatileMemoryAllocationGb: 0, clusterOperationalStatus: 'STABLE' },
            apSouthCluster: { computeLoadPercentage: 0, volatileMemoryAllocationGb: 0, clusterOperationalStatus: 'STABLE' },
        };
        results.forEach((r) => {
            const mappedId = r.nodeId;
            if (infrastructureState[mappedId]) {
                infrastructureState[mappedId] = {
                    computeLoadPercentage: r.currentLoadPercentage,
                    volatileMemoryAllocationGb: (r.metrics?.ram || 0) / 1024,
                    clusterOperationalStatus: r.status,
                };
            }
        });
        return infrastructureState;
    } catch (e) {
        console.error("[getLiveTelemetry] MongoDB error:", e);
        return null;
    }
}
// ─── Socket.io Shared Reference ───────────────────────────────────────────────
let aetherNexusSocketIoEgressServer = null;
export function setSharedSocket(ioInstance) {
    aetherNexusSocketIoEgressServer = ioInstance;
}
// ─── Egress Broadcast Function ─────────────────────────────────────────────────
// Suppress identical nominal heartbeat broadcasts so the live feed only
// re-shows a repeated state after HEARTBEAT_REPEAT_MS (kills 30s spam).
const HEARTBEAT_REPEAT_MS = 5 * 60 * 1000;
const lastBroadcastBySignature = new Map();
export function emitArchitecturalThoughtStreamPacket(architecturalThoughtStreamPacket) {
    try {
        const signature = `${architecturalThoughtStreamPacket.incidentThreatLevelColor}|${architecturalThoughtStreamPacket.targetClusterRegion || ''}|${architecturalThoughtStreamPacket.executedMitigationAction || ''}`;
        const isNominalHeartbeat = architecturalThoughtStreamPacket.incidentThreatLevelColor === 'NOMINAL_GREEN'
            && !architecturalThoughtStreamPacket.targetClusterRegion;
        if (isNominalHeartbeat) {
            const lastSeen = lastBroadcastBySignature.get(signature) || 0;
            if (Date.now() - lastSeen < HEARTBEAT_REPEAT_MS) {
                return; // identical nominal heartbeat — suppress
            }
            lastBroadcastBySignature.set(signature, Date.now());
        }
        if (aetherNexusSocketIoEgressServer) {
            aetherNexusSocketIoEgressServer.emit("aethernexus-telemetry-broadcast", architecturalThoughtStreamPacket);
            console.error(`[SOCKET_BROADCAST_EMITTED] Event: aethernexus-telemetry-broadcast | ThreatLevel: ${architecturalThoughtStreamPacket.incidentThreatLevelColor} | Action: ${architecturalThoughtStreamPacket.executedMitigationAction}`);
        }

        // Emit tagged AI insight to MongoDB
        const level = architecturalThoughtStreamPacket.incidentThreatLevelColor === 'CRITICAL_RED' ? 'critical'
            : architecturalThoughtStreamPacket.incidentThreatLevelColor === 'WARNING_AMBER' ? 'warning'
            : architecturalThoughtStreamPacket.incidentThreatLevelColor === 'NOMINAL_GREEN' ? 'success'
            : 'info';

    }
    catch (socketBroadcastException) {
        console.error("[SOCKET_BROADCAST_EXCEPTION]", socketBroadcastException);
    }
}
// ─── HTTP Transport Bootstrap ──────────────────────────────────────────────────
export function setSharedDb(databaseInstance) {
    db = databaseInstance;
}
//# sourceMappingURL=egressBroadcaster.js.map