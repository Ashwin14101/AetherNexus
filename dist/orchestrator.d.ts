// IMP-05: TypeScript declaration file for dist/orchestrator.js
// This allows server.ts to import from the ESM module without @ts-ignore on every call.

export function bootOrchestrator(): Promise<void>;
export function executeEvaluationCycle(forced?: boolean): Promise<void>;
export function getTokenUsage(): {
  promptTokens: number;
  completionTokens: number;
  cycles: number;
  estimatedCostUSD: number;
};
export function mapToClusterId(region: string): string;
export function resumeSystem(): void;
export function getSystemPausedState(): boolean;