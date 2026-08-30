export declare const MAX_CANDIDATE_ENV_VALUE_BYTES: number;
export declare const CANDIDATE_RUNTIME_ENV_NAMES: readonly ["LANG", "LC_ALL", "NO_COLOR", "TERM", "TZ"];
export type CandidateCredentialPolicyErrorCode = "adapter_boundary_invalid" | "adapter_name_overlap" | "adapter_value_overlap" | "allowlist_mismatch" | "candidate_value_overlap" | "duplicate_env_name" | "empty_credential_value" | "invalid_credential_source" | "invalid_credential_value" | "invalid_env_name" | "invalid_policy" | "invalid_release_digest" | "invalid_runtime_environment" | "missing_credential_value" | "release_digest_mismatch" | "release_digest_required" | "reserved_env_name" | "runtime_name_not_allowed" | "runtime_name_overlap" | "runtime_value_overlap";
/**
 * Deliberately contains only a fixed code and fixed/name-only message. It never
 * stores credential values, value hashes, release digests, or a cause supplied
 * by an input object.
 */
export declare class CandidateCredentialPolicyError extends Error {
    readonly code: CandidateCredentialPolicyErrorCode;
    constructor(code: CandidateCredentialPolicyErrorCode, message: string);
}
export interface NoCandidateCredentialsPolicy {
    readonly kind: "none";
}
export interface ExplicitCandidateCredentialsPolicy {
    readonly kind: "environment";
    readonly environment: readonly string[];
}
export type CandidateCredentialPolicy = NoCandidateCredentialsPolicy | ExplicitCandidateCredentialsPolicy;
/**
 * The complete already-authorized adapter credential set. Requiring both the
 * declaration and the map lets this boundary reject an incomplete handoff.
 */
export interface AdapterCredentialBoundary {
    readonly declaredEnvNames: readonly string[];
    readonly environment: Readonly<Record<string, string>>;
}
export interface CandidateEnvironmentAuthorization {
    /** Raw policy input is parsed closed: unknown fields and modes are rejected. */
    readonly credentialPolicy: unknown;
    /** Independently supplied caller approval; must exactly equal the declaration. */
    readonly callerAllowlist: readonly string[];
    /** Ambient source consulted only for declared, approved candidate names. */
    readonly sourceEnv: Readonly<Record<string, string | undefined>>;
    /** Digest produced by capture of the exact candidate release. */
    readonly capturedReleaseDigest?: string;
    /** Protected caller approval of that exact captured release digest. */
    readonly approvedReleaseDigest?: string;
    /** Complete adapter credential boundary, including the explicit empty case. */
    readonly adapterCredentials: AdapterCredentialBoundary;
    /** Root assertion: these allowlisted entries are non-secret runtime metadata. */
    readonly nonSecretRuntimeEnvironment: Readonly<Record<string, string>>;
}
/** Parses the closed candidate credential policy union. */
export declare function parseCandidateCredentialPolicy(value: unknown): CandidateCredentialPolicy;
/**
 * Builds a fresh candidate environment. Ambient variables are never copied.
 * Credential-bearing grants require exact name approval and exact release
 * approval; the result contains only approved candidate values and explicitly
 * supplied allowlisted runtime metadata.
 */
export declare function authorizeCandidateEnvironment(options: CandidateEnvironmentAuthorization): Readonly<Record<string, string>>;
