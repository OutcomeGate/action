export type SecretScanRuleId = "anthropic-api-key" | "authorization-header" | "aws-access-key-id" | "credentialed-url" | "github-token" | "gitlab-token" | "google-api-key" | "huggingface-token" | "json-web-token" | "npm-access-token" | "openai-api-key" | "private-key" | "sendgrid-api-key" | "slack-token" | "stripe-secret-key" | "suspicious-credential-assignment";
export interface SecretScanFinding {
    ruleId: SecretScanRuleId;
    path: string;
    field?: string;
    line?: number;
    findingDigest: string;
}
export type SecretArtifactContent = string | Uint8Array | readonly Uint8Array[];
export interface NamedSecretArtifact {
    path: string;
    field?: string;
    content: SecretArtifactContent;
}
export interface SecretScanLimits {
    maxArtifacts: number;
    maxArtifactBytes: number;
    maxTotalBytes: number;
    maxFindings: number;
}
export interface SecretScanOptions {
    limits?: Partial<SecretScanLimits>;
}
export interface SecretScanResult {
    schemaVersion: "agentci.secret-scan.v1";
    status: "clean" | "findings";
    scannedArtifacts: number;
    scannedBytes: number;
    findings: readonly SecretScanFinding[];
    findingsTruncated: boolean;
}
export type SecretScanErrorCode = "artifact_limit_exceeded" | "artifact_size_exceeded" | "findings_detected" | "invalid_input" | "invalid_limits" | "total_size_exceeded";
export declare class SecretScanError extends Error {
    readonly code: SecretScanErrorCode;
    constructor(code: SecretScanErrorCode, message: string);
}
export declare const DEFAULT_SECRET_SCAN_LIMITS: Readonly<SecretScanLimits>;
export declare const HARD_SECRET_SCAN_LIMITS: Readonly<SecretScanLimits>;
/**
 * Scans a closed set of logical artifacts without retaining or returning content.
 * Callers must treat SecretScanError and any non-clean result as a failed boundary.
 */
export declare function scanNamedArtifactsForSecrets(artifacts: readonly NamedSecretArtifact[], options?: SecretScanOptions): SecretScanResult;
export declare function scanTextForSecrets(options: {
    path: string;
    field?: string;
    text: string;
    limits?: Partial<SecretScanLimits>;
}): SecretScanResult;
export declare function scanBytesForSecrets(options: {
    path: string;
    field?: string;
    bytes: Uint8Array | readonly Uint8Array[];
    limits?: Partial<SecretScanLimits>;
}): SecretScanResult;
/**
 * Turns a scan result into a fail-closed boundary without exposing matched
 * content. Messages contain only rule and logical-location metadata.
 */
export declare function assertSecretScanClean(result: SecretScanResult, boundary: string): void;
