import { isJsonValue } from "./canonical.js";
import { isReservedCredentialEnvironmentName } from "./environment-names.js";
import type { JsonValue } from "./types.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const RULE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const GLOB_PATTERN = /[*?\[\]{}!]/;
export const MAX_CREDENTIAL_VALUE_BYTES = 8 * 1024;

export type CredentialPolicyErrorCode =
  | "adapter_digest_mismatch"
  | "adapter_digest_required"
  | "allowlist_mismatch"
  | "duplicate_env_name"
  | "empty_credential_value"
  | "invalid_adapter_digest"
  | "invalid_env_name"
  | "invalid_json_value"
  | "invalid_secret_rule"
  | "invalid_credential_value"
  | "missing_credential_value"
  | "reserved_env_name";

export class CredentialPolicyError extends Error {
  readonly code: CredentialPolicyErrorCode;

  constructor(code: CredentialPolicyErrorCode, message: string) {
    super(message);
    this.name = "CredentialPolicyError";
    this.code = code;
  }
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

export class KnownSecretLeakError extends Error {
  readonly code = "known_secret_leak" as const;
  readonly findings: readonly KnownSecretFinding[];

  constructor(findings: readonly KnownSecretFinding[]) {
    super("known credential material crossed a protected JSON boundary");
    this.name = "KnownSecretLeakError";
    this.findings = Object.freeze(
      findings.map((finding) => Object.freeze({ ...finding })),
    );
  }
}

function validateEnvName(name: string): void {
  if (GLOB_PATTERN.test(name) || !ENV_NAME_PATTERN.test(name)) {
    throw new CredentialPolicyError(
      "invalid_env_name",
      `credential environment name '${name}' is invalid`,
    );
  }
  if (isReservedCredentialEnvironmentName(name)) {
    throw new CredentialPolicyError(
      "reserved_env_name",
      `credential environment name '${name}' is reserved`,
    );
  }
}

function validateUniqueEnvNames(
  names: readonly string[],
  source: "declaration" | "caller allowlist",
): Set<string> {
  const seen = new Set<string>();
  for (const name of names) {
    validateEnvName(name);
    if (seen.has(name)) {
      throw new CredentialPolicyError(
        "duplicate_env_name",
        `${source} repeats credential environment name '${name}'`,
      );
    }
    seen.add(name);
  }
  return seen;
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function containsUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/**
 * Authorizes the credential environment for one captured adapter identity.
 * The result contains no ambient variables and no values absent from both lists.
 */
export function authorizeAdapterCredentials(
  options: AdapterCredentialAuthorization,
): Readonly<Record<string, string>> {
  const declared = validateUniqueEnvNames(
    options.declaredEnvNames,
    "declaration",
  );
  const allowed = validateUniqueEnvNames(
    options.callerAllowlist,
    "caller allowlist",
  );
  if (!setsEqual(declared, allowed)) {
    throw new CredentialPolicyError(
      "allowlist_mismatch",
      "caller credential allowlist must exactly match the adapter declaration",
    );
  }

  if (declared.size === 0) {
    return Object.freeze({});
  }

  if (!SHA256_PATTERN.test(options.capturedAdapterDigest)) {
    throw new CredentialPolicyError(
      "invalid_adapter_digest",
      "captured adapter digest must be a lowercase SHA-256 digest",
    );
  }
  if (options.approvedAdapterDigest === undefined) {
    throw new CredentialPolicyError(
      "adapter_digest_required",
      "credentialed adapters require an approved adapter digest",
    );
  }
  if (
    !SHA256_PATTERN.test(options.approvedAdapterDigest) ||
    options.approvedAdapterDigest !== options.capturedAdapterDigest
  ) {
    throw new CredentialPolicyError(
      "adapter_digest_mismatch",
      "approved adapter digest does not match the captured adapter digest",
    );
  }

  const authorized: Record<string, string> = {};
  for (const name of [...declared].sort()) {
    if (!Object.prototype.hasOwnProperty.call(options.sourceEnv, name)) {
      throw new CredentialPolicyError(
        "missing_credential_value",
        `credential environment value '${name}' is missing`,
      );
    }
    const value = options.sourceEnv[name];
    if (typeof value !== "string") {
      throw new CredentialPolicyError(
        "missing_credential_value",
        `credential environment value '${name}' is missing`,
      );
    }
    if (value.length === 0) {
      throw new CredentialPolicyError(
        "empty_credential_value",
        `credential environment value '${name}' is empty`,
      );
    }
    if (value.includes("\0") || containsUnpairedSurrogate(value)) {
      throw new CredentialPolicyError(
        "invalid_credential_value",
        `credential environment value '${name}' is not a safe process string`,
      );
    }
    if (Buffer.byteLength(value, "utf8") > MAX_CREDENTIAL_VALUE_BYTES) {
      throw new CredentialPolicyError(
        "invalid_credential_value",
        `credential environment value '${name}' exceeds the ${MAX_CREDENTIAL_VALUE_BYTES}-byte limit`,
      );
    }
    authorized[name] = value;
  }
  return Object.freeze(authorized);
}

export function knownSecretsFromCredentialEnv(
  environment: Readonly<Record<string, string>>,
): readonly KnownSecret[] {
  const rules = Object.keys(environment)
    .sort()
    .map((name) => {
      validateEnvName(name);
      const value = environment[name];
      if (value === undefined || value.length === 0) {
        throw new CredentialPolicyError(
          "empty_credential_value",
          `credential environment value '${name}' is empty`,
        );
      }
      if (
        value.includes("\0") ||
        containsUnpairedSurrogate(value) ||
        Buffer.byteLength(value, "utf8") > MAX_CREDENTIAL_VALUE_BYTES
      ) {
        throw new CredentialPolicyError(
          "invalid_credential_value",
          `credential environment value '${name}' is not safe for bounded scanning`,
        );
      }
      return Object.freeze({
        ruleId: `credential:${name}`,
        value,
      });
    });
  return Object.freeze(rules);
}

function validateKnownSecrets(secrets: readonly KnownSecret[]): KnownSecret[] {
  const ruleIds = new Set<string>();
  const validated = secrets.map((secret) => {
    if (
      !RULE_ID_PATTERN.test(secret.ruleId) ||
      typeof secret.value !== "string" ||
      secret.value.length === 0
    ) {
      throw new CredentialPolicyError(
        "invalid_secret_rule",
        "known-secret rules require a safe rule ID and a non-empty literal value",
      );
    }
    if (ruleIds.has(secret.ruleId)) {
      throw new CredentialPolicyError(
        "invalid_secret_rule",
        `known-secret rule ID '${secret.ruleId}' is duplicated`,
      );
    }
    ruleIds.add(secret.ruleId);
    return secret;
  });
  return validated.sort((left, right) =>
    left.ruleId < right.ruleId ? -1 : left.ruleId > right.ruleId ? 1 : 0,
  );
}

/**
 * Finds exact known secret literals in JSON string values and object keys.
 * Locations use property ordinals, never property contents, so findings remain safe.
 */
export function findKnownSecretLeaks(
  value: JsonValue,
  secrets: readonly KnownSecret[],
): readonly KnownSecretFinding[] {
  if (!isJsonValue(value)) {
    throw new CredentialPolicyError(
      "invalid_json_value",
      "known-secret scanning requires a finite acyclic JSON value",
    );
  }
  const rules = validateKnownSecrets(secrets);
  const findings: KnownSecretFinding[] = [];

  const scanString = (text: string, location: string): void => {
    for (const rule of rules) {
      if (text.includes(rule.value)) {
        findings.push({ ruleId: rule.ruleId, location });
      }
    }
  };

  const visit = (candidate: JsonValue, location: string): void => {
    if (typeof candidate === "string") {
      scanString(candidate, location);
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach((item, index) => visit(item, `${location}[${index}]`));
      return;
    }
    if (candidate === null || typeof candidate !== "object") {
      return;
    }

    const record = candidate as Record<string, JsonValue>;
    Object.keys(record)
      .sort()
      .forEach((key, index) => {
        const propertyLocation = `${location}.properties[${index}]`;
        scanString(key, `${propertyLocation}.key`);
        visit(record[key]!, `${propertyLocation}.value`);
      });
  };

  visit(value, "$");
  return Object.freeze(
    findings.map((finding) => Object.freeze({ ...finding })),
  );
}

export function assertNoKnownSecretLeaks(
  value: JsonValue,
  secrets: readonly KnownSecret[],
): void {
  const findings = findKnownSecretLeaks(value, secrets);
  if (findings.length > 0) {
    throw new KnownSecretLeakError(findings);
  }
}

/**
 * Checks both decoded JSON strings/keys and the exact serialized JSON text.
 * The second check covers numeric, boolean, and punctuation-shaped credential
 * values that do not exist as JSON strings but can still appear in output bytes.
 */
export function assertNoKnownSecretLeaksAtJsonBoundary(
  value: JsonValue,
  secrets: readonly KnownSecret[],
): void {
  assertNoKnownSecretLeaks(value, secrets);
  assertNoKnownSecretLeaks(JSON.stringify(value), secrets);
}
