import type { JsonValue } from "./types.js";
export declare const MAX_CREDENTIAL_VALUE_BYTES: number;
export type CredentialPolicyErrorCode = "adapter_digest_mismatch" | "adapter_digest_required" | "allowlist_mismatch" | "duplicate_env_name" | "empty_credential_value" | "invalid_adapter_digest" | "invalid_env_name" | "invalid_json_value" | "invalid_secret_rule" | "invalid_credential_value" | "missing_credential_value" | "reserved_env_name";
export declare class CredentialPolicyError extends Error {
    readonly code: CredentialPolicyErrorCode;
    constructor(code: CredentialPolicyErrorCode, message: string);
}
export interface AdapterCredentialAuthorization {
    declaredEnvNames: readonly string[];
    callerAllowlist: readonly string[];
    sourceEnv: Readonly<Record<string, string | undefined>>;
    capturedAdapterDigest: string;
    approvedAdapterDigest?: string;
}
export interface KnownSecret {
    ruleId: string;
    value: string;
}
export interface KnownSecretFinding {
    ruleId: string;
    location: string;
}
export declare class KnownSecretLeakError extends Error {
    readonly code: "known_secret_leak";
    readonly findings: readonly KnownSecretFinding[];
    constructor(findings: readonly KnownSecretFinding[]);
}
/**
 * Authorizes the credential environment for one captured adapter identity.
 * The result contains no ambient variables and no values absent from both lists.
 */
export declare function authorizeAdapterCredentials(options: AdapterCredentialAuthorization): Readonly<Record<string, string>>;
export declare function knownSecretsFromCredentialEnv(environment: Readonly<Record<string, string>>): readonly KnownSecret[];
/**
 * Finds exact known secret literals in JSON string values and object keys.
 * Locations use property ordinals, never property contents, so findings remain safe.
 */
export declare function findKnownSecretLeaks(value: JsonValue, secrets: readonly KnownSecret[]): readonly KnownSecretFinding[];
export declare function assertNoKnownSecretLeaks(value: JsonValue, secrets: readonly KnownSecret[]): void;
/**
 * Checks both decoded JSON strings/keys and the exact serialized JSON text.
 * The second check covers numeric, boolean, and punctuation-shaped credential
 * values that do not exist as JSON strings but can still appear in output bytes.
 */
export declare function assertNoKnownSecretLeaksAtJsonBoundary(value: JsonValue, secrets: readonly KnownSecret[]): void;
