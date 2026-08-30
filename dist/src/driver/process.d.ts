import { type KnownSecret } from "../credential-policy.js";
import type { CandidateDiagnostics, Environment, JsonValue, ScenarioSpec, ToolEvent, Verdict } from "../types.js";
export interface DriverRunResult {
    verdict: Verdict;
    reasons: string[];
    output?: JsonValue;
    events: ToolEvent[];
    candidateDiagnostics: CandidateDiagnostics;
    durationMs: number;
}
export declare function runCandidateProcess(options: {
    candidatePath: string;
    scenario: ScenarioSpec;
    environment: Environment;
    candidateEnvironment?: Readonly<Record<string, string>>;
    candidateCredentialNames?: readonly string[];
    knownExecutionSecrets?: readonly KnownSecret[];
    /** Values owned by another process that must not enter candidate startup. */
    protectedSecrets?: readonly KnownSecret[];
    timeoutMs?: number;
}): Promise<DriverRunResult>;
