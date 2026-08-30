import type { JsonValue, ReleaseReport, SanitizedPublicationReport } from "./types.js";
interface RunSuiteBaseOptions {
    suitePath: string;
    adapterPath?: string;
    adapterManifestPath?: string;
    callerAllowlist?: readonly string[];
    approvedAdapterDigest?: string;
    adapterSourceEnv?: Readonly<Record<string, string | undefined>>;
    candidateCallerAllowlist?: readonly string[];
    approvedReleaseDigest?: string;
    candidateSourceEnv?: Readonly<Record<string, string | undefined>>;
    candidateRuntimeEnvironment?: Readonly<Record<string, string>>;
    requireExplicitCandidatePolicy?: boolean;
    generatedAt?: string;
}
export type RunSuiteOptions = RunSuiteBaseOptions & ({
    releaseManifestPath: string;
    candidatePath?: never;
    releaseName?: never;
} | {
    releaseManifestPath?: never;
    candidatePath: string;
    releaseName: string;
});
export declare function runSuite(options: RunSuiteOptions): Promise<ReleaseReport>;
export declare function runSuiteWithEvidenceGuard(options: RunSuiteOptions): Promise<{
    report: ReleaseReport;
    assertNoExecutionSecretLeaks: (value: JsonValue) => void;
}>;
export declare function runSuiteWithSanitizedPublication(options: RunSuiteOptions): Promise<{
    report: ReleaseReport;
    publication: SanitizedPublicationReport;
    assertNoExecutionSecretLeaks: (value: JsonValue) => void;
}>;
export {};
