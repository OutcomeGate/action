import { isReservedCredentialEnvironmentName } from "./environment-names.js";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const GLOB_PATTERN = /[*?\[\]{}!]/;
export const MAX_CANDIDATE_ENV_VALUE_BYTES = 8 * 1024;
export const CANDIDATE_RUNTIME_ENV_NAMES = Object.freeze([
    "LANG",
    "LC_ALL",
    "NO_COLOR",
    "TERM",
    "TZ",
]);
const CANDIDATE_RUNTIME_ENV_NAME_SET = new Set(CANDIDATE_RUNTIME_ENV_NAMES);
/**
 * Deliberately contains only a fixed code and fixed/name-only message. It never
 * stores credential values, value hashes, release digests, or a cause supplied
 * by an input object.
 */
export class CandidateCredentialPolicyError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "CandidateCredentialPolicyError";
        this.code = code;
    }
}
function fail(code, message) {
    throw new CandidateCredentialPolicyError(code, message);
}
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactOwnStringKeys(value, expected) {
    try {
        const keys = Reflect.ownKeys(value);
        return (keys.length === expected.length &&
            keys.every((key) => typeof key === "string" && expected.includes(key)));
    }
    catch {
        return false;
    }
}
function validateCredentialEnvName(name) {
    if (typeof name !== "string" ||
        GLOB_PATTERN.test(name) ||
        !ENV_NAME_PATTERN.test(name)) {
        fail("invalid_env_name", "candidate credential declaration contains an invalid environment name");
    }
    if (isReservedCredentialEnvironmentName(name)) {
        fail("reserved_env_name", `candidate credential environment name '${name}' is reserved`);
    }
}
function validateNameList(value, source) {
    if (!Array.isArray(value)) {
        fail("invalid_policy", `${source} must be an array of exact names`);
    }
    const names = [];
    const seen = new Set();
    for (const candidate of value) {
        validateCredentialEnvName(candidate);
        if (seen.has(candidate)) {
            fail("duplicate_env_name", `${source} repeats candidate credential environment name '${candidate}'`);
        }
        seen.add(candidate);
        names.push(candidate);
    }
    return Object.freeze(names.sort());
}
function setsEqual(left, right) {
    return (left.length === right.length &&
        left.every((value, index) => value === right[index]));
}
/** Parses the closed candidate credential policy union. */
export function parseCandidateCredentialPolicy(value) {
    if (!isRecord(value)) {
        fail("invalid_policy", "candidate credential policy must be an object");
    }
    let kind;
    try {
        kind = value.kind;
    }
    catch {
        fail("invalid_policy", "candidate credential policy could not be read");
    }
    if (kind === "none") {
        if (!exactOwnStringKeys(value, ["kind"])) {
            fail("invalid_policy", "candidate no-credentials policy contains unsupported fields");
        }
        return Object.freeze({ kind: "none" });
    }
    if (kind === "environment") {
        if (!exactOwnStringKeys(value, ["kind", "environment"])) {
            fail("invalid_policy", "candidate environment-credential policy contains unsupported fields");
        }
        let environment;
        try {
            environment = value.environment;
        }
        catch {
            fail("invalid_policy", "candidate credential declaration could not be read");
        }
        const names = validateNameList(environment, "declaration");
        if (names.length === 0) {
            fail("invalid_policy", "an empty candidate credential grant must use the explicit 'none' policy");
        }
        return Object.freeze({ kind: "environment", environment: names });
    }
    fail("invalid_policy", "candidate credential policy kind must be 'none' or 'environment'");
}
function readOwnValue(record, name) {
    try {
        if (!Object.prototype.hasOwnProperty.call(record, name)) {
            return { present: false };
        }
        return { present: true, value: record[name] };
    }
    catch {
        return { present: false };
    }
}
function containsUnpairedSurrogate(value) {
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(index + 1);
            if (!(next >= 0xdc00 && next <= 0xdfff)) {
                return true;
            }
            index += 1;
        }
        else if (code >= 0xdc00 && code <= 0xdfff) {
            return true;
        }
    }
    return false;
}
function validateBoundedValue(value, emptyCode, invalidCode, subject) {
    if (typeof value !== "string") {
        fail(invalidCode, `${subject} is not a string`);
    }
    if (value.length === 0) {
        fail(emptyCode, `${subject} is empty`);
    }
    if (value.includes("\0") ||
        containsUnpairedSurrogate(value) ||
        Buffer.byteLength(value, "utf8") > MAX_CANDIDATE_ENV_VALUE_BYTES) {
        fail(invalidCode, `${subject} is not a bounded process value`);
    }
    return value;
}
function readObjectKeys(value, code, message) {
    if (!isRecord(value)) {
        fail(code, message);
    }
    try {
        const keys = Reflect.ownKeys(value);
        if (keys.some((key) => typeof key !== "string")) {
            fail(code, message);
        }
        return keys.sort();
    }
    catch (error) {
        if (error instanceof CandidateCredentialPolicyError) {
            throw error;
        }
        fail(code, message);
    }
}
function validateAdapterBoundary(boundary) {
    if (!isRecord(boundary)) {
        fail("adapter_boundary_invalid", "adapter credential boundary is invalid");
    }
    let declaredInput;
    let environmentInput;
    try {
        declaredInput = boundary.declaredEnvNames;
        environmentInput = boundary.environment;
    }
    catch {
        fail("adapter_boundary_invalid", "adapter credential boundary is invalid");
    }
    if (!Array.isArray(declaredInput) || !isRecord(environmentInput)) {
        fail("adapter_boundary_invalid", "adapter credential boundary is invalid");
    }
    const declared = [];
    const seen = new Set();
    for (const name of declaredInput) {
        try {
            validateCredentialEnvName(name);
        }
        catch {
            fail("adapter_boundary_invalid", "adapter credential boundary is invalid");
        }
        if (seen.has(name)) {
            fail("adapter_boundary_invalid", "adapter credential boundary is invalid");
        }
        seen.add(name);
        declared.push(name);
    }
    declared.sort();
    const environmentKeys = readObjectKeys(environmentInput, "adapter_boundary_invalid", "adapter credential boundary is invalid");
    if (!setsEqual(declared, environmentKeys)) {
        fail("adapter_boundary_invalid", "adapter credential boundary is incomplete");
    }
    const adapterEnvironment = {};
    for (const name of declared) {
        const observed = readOwnValue(environmentInput, name);
        if (!observed.present) {
            fail("adapter_boundary_invalid", "adapter credential boundary is incomplete");
        }
        let value;
        try {
            value = validateBoundedValue(observed.value, "adapter_boundary_invalid", "adapter_boundary_invalid", "adapter credential value");
        }
        catch {
            fail("adapter_boundary_invalid", "adapter credential boundary is invalid");
        }
        adapterEnvironment[name] = value;
    }
    return Object.freeze(adapterEnvironment);
}
function validateRuntimeEnvironment(value) {
    const names = readObjectKeys(value, "invalid_runtime_environment", "non-secret runtime environment is invalid");
    const runtime = {};
    for (const name of names) {
        if (!CANDIDATE_RUNTIME_ENV_NAME_SET.has(name)) {
            fail("runtime_name_not_allowed", `candidate runtime environment name '${name}' is not allowed`);
        }
        const observed = readOwnValue(value, name);
        if (!observed.present) {
            fail("invalid_runtime_environment", "non-secret runtime environment is invalid");
        }
        runtime[name] = validateBoundedValue(observed.value, "invalid_runtime_environment", "invalid_runtime_environment", `candidate runtime environment value '${name}'`);
    }
    return Object.freeze(runtime);
}
function valuesOverlap(left, right) {
    return left.includes(right) || right.includes(left);
}
function assertDisjointValues(options) {
    const candidateEntries = Object.entries(options.candidate);
    const adapterValues = Object.values(options.adapter);
    const runtimeEntries = Object.entries(options.runtime);
    for (let index = 0; index < candidateEntries.length; index += 1) {
        const entry = candidateEntries[index];
        if (entry === undefined) {
            continue;
        }
        const [, candidateValue] = entry;
        for (const adapterValue of adapterValues) {
            if (valuesOverlap(candidateValue, adapterValue)) {
                fail("adapter_value_overlap", "candidate and adapter credential values overlap");
            }
        }
        for (let otherIndex = index + 1; otherIndex < candidateEntries.length; otherIndex += 1) {
            const other = candidateEntries[otherIndex];
            if (other !== undefined && valuesOverlap(candidateValue, other[1])) {
                fail("candidate_value_overlap", "candidate credential values overlap each other");
            }
        }
        for (const [, runtimeValue] of runtimeEntries) {
            if (runtimeValue.includes(candidateValue)) {
                fail("runtime_value_overlap", "candidate credential and runtime values overlap");
            }
        }
    }
    for (const adapterValue of adapterValues) {
        for (const [, runtimeValue] of runtimeEntries) {
            if (runtimeValue.includes(adapterValue)) {
                fail("adapter_value_overlap", "adapter credential and candidate runtime values overlap");
            }
        }
    }
}
/**
 * Builds a fresh candidate environment. Ambient variables are never copied.
 * Credential-bearing grants require exact name approval and exact release
 * approval; the result contains only approved candidate values and explicitly
 * supplied allowlisted runtime metadata.
 */
export function authorizeCandidateEnvironment(options) {
    const policy = parseCandidateCredentialPolicy(options.credentialPolicy);
    const callerAllowlist = validateNameList(options.callerAllowlist, "caller allowlist");
    const declared = policy.kind === "none" ? Object.freeze([]) : policy.environment;
    if (!setsEqual(declared, callerAllowlist)) {
        fail("allowlist_mismatch", "caller allowlist must exactly match the candidate credential declaration");
    }
    const adapterEnvironment = validateAdapterBoundary(options.adapterCredentials);
    const runtimeEnvironment = validateRuntimeEnvironment(options.nonSecretRuntimeEnvironment);
    const adapterNames = new Set(Object.keys(adapterEnvironment));
    for (const name of declared) {
        if (adapterNames.has(name)) {
            fail("adapter_name_overlap", `candidate credential environment name '${name}' is already used by the adapter`);
        }
    }
    for (const name of Object.keys(runtimeEnvironment)) {
        if (adapterNames.has(name)) {
            fail("runtime_name_overlap", `candidate runtime environment name '${name}' is already used by the adapter`);
        }
    }
    const candidateEnvironment = {};
    if (declared.length > 0) {
        if (options.capturedReleaseDigest === undefined ||
            options.approvedReleaseDigest === undefined) {
            fail("release_digest_required", "candidate credentials require captured and independently approved release digests");
        }
        if (!SHA256_PATTERN.test(options.capturedReleaseDigest) ||
            !SHA256_PATTERN.test(options.approvedReleaseDigest)) {
            fail("invalid_release_digest", "candidate credential release digests must be exact lowercase SHA-256 digests");
        }
        if (options.capturedReleaseDigest !== options.approvedReleaseDigest) {
            fail("release_digest_mismatch", "approved candidate release digest does not match the captured release");
        }
        if (!isRecord(options.sourceEnv)) {
            fail("invalid_credential_source", "candidate credential source is invalid");
        }
        for (const name of declared) {
            const observed = readOwnValue(options.sourceEnv, name);
            if (!observed.present || typeof observed.value !== "string") {
                fail("missing_credential_value", `candidate credential environment value '${name}' is missing`);
            }
            candidateEnvironment[name] = validateBoundedValue(observed.value, "empty_credential_value", "invalid_credential_value", `candidate credential environment value '${name}'`);
        }
    }
    assertDisjointValues({
        candidate: candidateEnvironment,
        adapter: adapterEnvironment,
        runtime: runtimeEnvironment,
    });
    const entries = [
        ...Object.entries(runtimeEnvironment),
        ...Object.entries(candidateEnvironment),
    ].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return Object.freeze(Object.fromEntries(entries));
}
