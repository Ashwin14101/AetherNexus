// IMP-05: TypeScript declaration file for dist/egressBroadcaster.js

export function setSharedSocket(ioInstance: any): void;
export function setSharedDb(databaseInstance: any): void;
export function emitArchitecturalThoughtStreamPacket(packet: {
  eventTimestamp: string;
  principalArchitect: string;
  executedMitigationAction: string;
  incidentThreatLevelColor: 'NOMINAL_GREEN' | 'WARNING_AMBER' | 'CRITICAL_RED' | 'HEALING';
  trafficDistribution?: Record<string, number>;
  healingProgress?: number;
  targetClusterRegion?: string;
}): void;
export function writeAiLog(payload: {
  level: 'info' | 'warning' | 'critical' | 'success';
  text: string;
  timestamp?: string;
  architect?: string;
}): Promise<void>;
export function getLiveTelemetry(): Promise<Record<string, any> | null>;