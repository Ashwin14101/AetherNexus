import { z } from "zod";
declare const InfrastructureStateSnapshot: z.ZodObject<{
    usEastCluster: z.ZodObject<{
        computeLoadPercentage: z.ZodNumber;
        volatileMemoryAllocationGb: z.ZodNumber;
        clusterOperationalStatus: z.ZodEnum<{
            STABLE: "STABLE";
            DEGRADED: "DEGRADED";
            CRITICAL: "CRITICAL";
        }>;
    }, z.core.$strip>;
    euWestCluster: z.ZodObject<{
        computeLoadPercentage: z.ZodNumber;
        volatileMemoryAllocationGb: z.ZodNumber;
        clusterOperationalStatus: z.ZodEnum<{
            STABLE: "STABLE";
            DEGRADED: "DEGRADED";
            CRITICAL: "CRITICAL";
        }>;
    }, z.core.$strip>;
    apSouthCluster: z.ZodObject<{
        computeLoadPercentage: z.ZodNumber;
        volatileMemoryAllocationGb: z.ZodNumber;
        clusterOperationalStatus: z.ZodEnum<{
            STABLE: "STABLE";
            DEGRADED: "DEGRADED";
            CRITICAL: "CRITICAL";
        }>;
    }, z.core.$strip>;
}, z.core.$strip>;
declare const FetchLiveInfrastructureMetricsInputSchema: z.ZodObject<{
    targetClusterRegion: z.ZodOptional<z.ZodEnum<{
        usEastCluster: "usEastCluster";
        euWestCluster: "euWestCluster";
        apSouthCluster: "apSouthCluster";
    }>>;
    telemetrySamplingIntervalMs: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>;
declare const TraceRepositoryCommitHistoryInputSchema: z.ZodObject<{
    repositoryNamespace: z.ZodString;
    commitLookbackDepth: z.ZodDefault<z.ZodNumber>;
    authorIdentityFilter: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
declare const ExecuteClusterCacheFlushInputSchema: z.ZodObject<{
    targetClusterRegion: z.ZodEnum<{
        usEastCluster: "usEastCluster";
        euWestCluster: "euWestCluster";
        apSouthCluster: "apSouthCluster";
    }>;
    cacheLayerNamespace: z.ZodString;
    flushOperationAcknowledgementToken: z.ZodString;
}, z.core.$strip>;
declare const RequestHumanOverrideClearanceInputSchema: z.ZodObject<{
    incidentClassificationCode: z.ZodString;
    mitigationActionSummary: z.ZodString;
    autonomousDecisionRiskLevel: z.ZodEnum<{
        CRITICAL: "CRITICAL";
        LOW: "LOW";
        MEDIUM: "MEDIUM";
        HIGH: "HIGH";
    }>;
    requestingAgentIdentifier: z.ZodString;
}, z.core.$strip>;
export type FetchLiveInfrastructureMetricsInput = z.infer<typeof FetchLiveInfrastructureMetricsInputSchema>;
export type TraceRepositoryCommitHistoryInput = z.infer<typeof TraceRepositoryCommitHistoryInputSchema>;
export type ExecuteClusterCacheFlushInput = z.infer<typeof ExecuteClusterCacheFlushInputSchema>;
export type RequestHumanOverrideClearanceInput = z.infer<typeof RequestHumanOverrideClearanceInputSchema>;
export type InfrastructureStateSnapshot = z.infer<typeof InfrastructureStateSnapshot>;
export {};
//# sourceMappingURL=mcpServer.d.ts.map