import { lstat, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { bundleFileIdentities, captureDeclaredBundle, cleanupMaterializedBundle, compareCanonicalText, computeBundleDigest, isSafeRelativePath, materializeCapturedBundle, materializedBundleMatches, } from "./bundle.js";
import { cloneJson, digestValue, isJsonValue } from "./canonical.js";
import { isReservedCredentialEnvironmentName } from "./environment-names.js";
import { AdapterManifestValidationError } from "./errors.js";
import { assertSecretScanClean, scanNamedArtifactsForSecrets, scanTextForSecrets, } from "./secret-scan.js";
import { parseStrictJson, StrictJsonError } from "./strict-json.js";
const MIN_OPERATION_TIMEOUT_MS = 100;
const MAX_OPERATION_TIMEOUT_MS = 60_000;
const MIN_SHUTDOWN_TIMEOUT_MS = 100;
const MAX_SHUTDOWN_TIMEOUT_MS = 10_000;
const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const ENVIRONMENT_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function unknownKeys(record, allowed, path, issues) {
    for (const key of Object.keys(record)) {
        if (!allowed.includes(key)) {
            issues.push(`${path}${path.length > 0 ? "." : ""}${key} is not supported`);
        }
    }
}
function readString(value, path, issues) {
    if (typeof value !== "string" || value.trim().length === 0) {
        issues.push(`${path} must be a non-empty string`);
        return undefined;
    }
    if (value !== value.trim()) {
        issues.push(`${path} must not contain leading or trailing whitespace`);
        return undefined;
    }
    return value;
}
function readIdentifier(value, path, issues) {
    const text = readString(value, path, issues);
    if (text !== undefined && !IDENTIFIER_PATTERN.test(text)) {
        issues.push(`${path} must match ${IDENTIFIER_PATTERN.source}`);
        return undefined;
    }
    return text;
}
function readPath(value, path, issues) {
    const text = readString(value, path, issues);
    if (text !== undefined && !isSafeRelativePath(text)) {
        issues.push(`${path} must be a normalized relative POSIX path without traversal`);
        return undefined;
    }
    return text;
}
function readBoundedInteger(value, path, minimum, maximum, issues) {
    if (!Number.isInteger(value) ||
        value < minimum ||
        value > maximum) {
        issues.push(`${path} must be an integer from ${minimum} through ${maximum}`);
        return undefined;
    }
    return value;
}
function readConfiguration(value, path, issues) {
    if (!isRecord(value) || !isJsonValue(value)) {
        issues.push(`${path} must be a JSON object`);
        return undefined;
    }
    return cloneJson(value);
}
function readUniqueStrings(options) {
    if (!Array.isArray(options.value) ||
        (!options.allowEmpty && options.value.length === 0)) {
        options.issues.push(`${options.path} must be ${options.allowEmpty ? "an" : "a non-empty"} array of strings`);
        return [];
    }
    const values = [];
    options.value.forEach((candidate, index) => {
        const itemPath = `${options.path}[${index}]`;
        const text = readString(candidate, itemPath, options.issues);
        if (text !== undefined &&
            (options.validate === undefined ||
                options.validate(text, itemPath, options.issues))) {
            values.push(text);
        }
    });
    if (new Set(values).size !== values.length) {
        options.issues.push(`${options.path} must not contain duplicates`);
    }
    return values.sort(compareCanonicalText);
}
function normalizeRemoteEndpoint(value, issues) {
    const text = readString(value, "target.endpoint", issues);
    if (text === undefined) {
        return undefined;
    }
    let endpoint;
    try {
        endpoint = new URL(text);
    }
    catch {
        issues.push("target.endpoint must be an absolute HTTPS URL");
        return undefined;
    }
    if (endpoint.protocol !== "https:") {
        issues.push("target.endpoint must use HTTPS");
    }
    if (endpoint.username.length > 0 || endpoint.password.length > 0) {
        issues.push("target.endpoint must not contain credentials");
    }
    if (endpoint.search.length > 0 || endpoint.hash.length > 0) {
        issues.push("target.endpoint must not contain a query or fragment");
    }
    if (endpoint.protocol !== "https:" ||
        endpoint.username.length > 0 ||
        endpoint.password.length > 0 ||
        endpoint.search.length > 0 ||
        endpoint.hash.length > 0) {
        return undefined;
    }
    return endpoint.href;
}
function parseTarget(value, issues) {
    if (!isRecord(value)) {
        issues.push("target must be an object");
        return undefined;
    }
    if (value.kind === "synthetic") {
        unknownKeys(value, ["kind", "reason", "configuration"], "target", issues);
        const reason = readString(value.reason, "target.reason", issues);
        const configuration = readConfiguration(value.configuration, "target.configuration", issues);
        return reason === undefined || configuration === undefined
            ? undefined
            : { kind: "synthetic", reason, configuration };
    }
    if (value.kind === "remote") {
        unknownKeys(value, ["kind", "endpoint", "tenant", "apiVersion", "configuration"], "target", issues);
        const endpoint = normalizeRemoteEndpoint(value.endpoint, issues);
        const tenant = readString(value.tenant, "target.tenant", issues);
        const apiVersion = readString(value.apiVersion, "target.apiVersion", issues);
        const configuration = readConfiguration(value.configuration, "target.configuration", issues);
        return endpoint === undefined ||
            tenant === undefined ||
            apiVersion === undefined ||
            configuration === undefined
            ? undefined
            : { kind: "remote", endpoint, tenant, apiVersion, configuration };
    }
    issues.push("target.kind must be 'synthetic' or 'remote'");
    return undefined;
}
function validEnvironmentName(value, path, issues) {
    if (!ENVIRONMENT_NAME_PATTERN.test(value)) {
        issues.push(`${path} must match ${ENVIRONMENT_NAME_PATTERN.source}`);
        return false;
    }
    if (isReservedCredentialEnvironmentName(value)) {
        issues.push(`${path} names a process-control environment variable`);
        return false;
    }
    return true;
}
export function parseAdapterManifest(value) {
    const issues = [];
    if (!isRecord(value)) {
        throw new AdapterManifestValidationError([
            "adapter manifest must be an object",
        ]);
    }
    unknownKeys(value, [
        "schemaVersion",
        "id",
        "version",
        "runtime",
        "bundle",
        "contract",
        "target",
        "credentials",
    ], "", issues);
    if (value.schemaVersion !== "agentci.adapter-manifest.v1") {
        issues.push("schemaVersion must be 'agentci.adapter-manifest.v1'");
    }
    const id = readIdentifier(value.id, "id", issues);
    const version = readString(value.version, "version", issues);
    let runtime;
    if (!isRecord(value.runtime)) {
        issues.push("runtime must be an object");
    }
    else {
        unknownKeys(value.runtime, [
            "kind",
            "apiVersion",
            "protocolVersion",
            "entry",
            "operationTimeoutMs",
            "shutdownTimeoutMs",
        ], "runtime", issues);
        if (value.runtime.kind !== "node-esm") {
            issues.push("runtime.kind must be 'node-esm'");
        }
        if (value.runtime.apiVersion !== "agentci.adapter.v2") {
            issues.push("runtime.apiVersion must be 'agentci.adapter.v2'");
        }
        if (value.runtime.protocolVersion !== 1) {
            issues.push("runtime.protocolVersion must be 1");
        }
        const entry = readPath(value.runtime.entry, "runtime.entry", issues);
        const operationTimeoutMs = readBoundedInteger(value.runtime.operationTimeoutMs, "runtime.operationTimeoutMs", MIN_OPERATION_TIMEOUT_MS, MAX_OPERATION_TIMEOUT_MS, issues);
        const shutdownTimeoutMs = readBoundedInteger(value.runtime.shutdownTimeoutMs, "runtime.shutdownTimeoutMs", MIN_SHUTDOWN_TIMEOUT_MS, MAX_SHUTDOWN_TIMEOUT_MS, issues);
        if (value.runtime.kind === "node-esm" &&
            value.runtime.apiVersion === "agentci.adapter.v2" &&
            value.runtime.protocolVersion === 1 &&
            entry !== undefined &&
            operationTimeoutMs !== undefined &&
            shutdownTimeoutMs !== undefined) {
            runtime = {
                kind: "node-esm",
                apiVersion: "agentci.adapter.v2",
                protocolVersion: 1,
                entry,
                operationTimeoutMs,
                shutdownTimeoutMs,
            };
        }
    }
    let bundle;
    if (!isRecord(value.bundle)) {
        issues.push("bundle must be an object");
    }
    else {
        unknownKeys(value.bundle, ["root"], "bundle", issues);
        const root = readPath(value.bundle.root, "bundle.root", issues);
        if (root !== undefined) {
            bundle = { root };
        }
    }
    let contract;
    if (!isRecord(value.contract)) {
        issues.push("contract must be an object");
    }
    else {
        unknownKeys(value.contract, ["tools"], "contract", issues);
        contract = {
            tools: readUniqueStrings({
                value: value.contract.tools,
                path: "contract.tools",
                allowEmpty: false,
                issues,
            }),
        };
    }
    const target = parseTarget(value.target, issues);
    let credentials;
    if (!isRecord(value.credentials)) {
        issues.push("credentials must be an object");
    }
    else {
        unknownKeys(value.credentials, ["environment"], "credentials", issues);
        credentials = {
            environment: readUniqueStrings({
                value: value.credentials.environment,
                path: "credentials.environment",
                allowEmpty: true,
                validate: validEnvironmentName,
                issues,
            }),
        };
    }
    if (target?.kind === "synthetic" &&
        credentials !== undefined &&
        credentials.environment.length > 0) {
        issues.push("synthetic targets cannot request credential environment variables");
    }
    if (issues.length > 0 ||
        id === undefined ||
        version === undefined ||
        runtime === undefined ||
        bundle === undefined ||
        contract === undefined ||
        target === undefined ||
        credentials === undefined) {
        throw new AdapterManifestValidationError(issues);
    }
    return {
        schemaVersion: "agentci.adapter-manifest.v1",
        id,
        version,
        runtime,
        bundle,
        contract,
        target,
        credentials,
    };
}
export async function loadAdapterManifest(path) {
    const manifestPath = resolve(path);
    let value;
    try {
        const metadata = await lstat(manifestPath);
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
            throw new Error("manifest path must identify a regular non-symlink file");
        }
        const raw = await readFile(manifestPath, "utf8");
        assertSecretScanClean(scanTextForSecrets({ path: "adapter/manifest.json", text: raw }), "adapter manifest");
        value = parseStrictJson(raw);
        assertSecretScanClean(scanTextForSecrets({
            path: "adapter/manifest.json",
            field: "normalized-json",
            text: JSON.stringify(value),
        }), "normalized adapter manifest");
    }
    catch (error) {
        throw new AdapterManifestValidationError([
            `manifest could not be read as JSON: ${error instanceof Error ? error.message : String(error)}`,
        ]);
    }
    const manifest = parseAdapterManifest(value);
    const capturedBundle = await captureDeclaredBundle({
        manifestDirectory: dirname(manifestPath),
        relativeRoot: manifest.bundle.root,
        createError: (issues) => new AdapterManifestValidationError(issues),
    });
    const files = capturedBundle.files;
    assertSecretScanClean(scanNamedArtifactsForSecrets(files.map((file) => ({
        path: `adapter-bundle/${file.path}`,
        content: file.content,
    }))), "adapter bundle");
    const normalizedJsonFiles = files.flatMap((file, index) => {
        try {
            const text = new TextDecoder("utf-8", { fatal: true }).decode(file.content);
            const parsed = parseStrictJson(text);
            const normalized = JSON.stringify(parsed);
            if (normalized === undefined) {
                return [];
            }
            return [
                {
                    path: `adapter-bundle/${file.path}`,
                    field: "normalized-json",
                    content: normalized,
                },
            ];
        }
        catch (error) {
            if (error instanceof StrictJsonError &&
                error.code !== "invalid_syntax") {
                throw new AdapterManifestValidationError([
                    `adapter bundle JSON artifact ${index + 1} is ambiguous or exceeds the strict parser boundary`,
                ]);
            }
            return [];
        }
    });
    if (normalizedJsonFiles.length > 0) {
        assertSecretScanClean(scanNamedArtifactsForSecrets(normalizedJsonFiles), "normalized adapter JSON bundle files");
    }
    const entry = files.find((file) => file.path === manifest.runtime.entry);
    if (entry === undefined) {
        throw new AdapterManifestValidationError([
            `manifest references an entry absent from the bundle: ${manifest.runtime.entry}`,
        ]);
    }
    const manifestDigest = digestValue({
        domain: "agentci.adapter-manifest.v1",
        manifest,
    });
    const bundleDigest = computeBundleDigest("agentci.adapter-bundle.v1", files);
    const configurationDigest = digestValue({
        domain: "agentci.adapter-configuration.v1",
        target: manifest.target,
    });
    const credentialDeclarationDigest = digestValue({
        domain: "agentci.adapter-credentials.v1",
        credentials: manifest.credentials,
    });
    const contractDigest = digestValue({
        domain: "agentci.adapter-contract.v1",
        contract: {
            id: manifest.id,
            version: manifest.version,
            apiVersion: manifest.runtime.apiVersion,
            tools: manifest.contract.tools,
        },
    });
    const adapterDigest = digestValue({
        domain: "agentci.declared-adapter.v1",
        runtime: manifest.runtime,
        manifestDigest,
        bundleDigest,
        configurationDigest,
        credentialDeclarationDigest,
        contractDigest,
    });
    return {
        manifestPath,
        bundleRoot: capturedBundle.sourceRoot,
        manifest,
        files,
        identity: {
            apiVersion: "agentci.adapter.v2",
            id: manifest.id,
            version: manifest.version,
            source: "external-manifest",
            digestScope: "declared-config-and-adapter-bundle-bytes",
            manifestDigest,
            bundleDigest,
            configurationDigest,
            credentialDeclarationDigest,
            contractDigest,
            adapterDigest,
            entryPath: manifest.runtime.entry,
            entryFileDigest: entry.digest,
            fileCount: files.length,
            manifest,
            files: bundleFileIdentities(files),
            execution: {
                nodeVersion: process.version,
                platform: process.platform,
                architecture: process.arch,
            },
        },
    };
}
export async function materializeAdapter(capture) {
    const root = await materializeCapturedBundle({
        files: capture.files,
        prefix: "agentci-adapter-",
        createError: (issues) => new AdapterManifestValidationError(issues),
    });
    return {
        root,
        modulePath: join(root, ...capture.manifest.runtime.entry.split("/")),
    };
}
export async function verifyMaterializedAdapter(materialized, capture) {
    try {
        return (await materializedBundleMatches({
            root: materialized.root,
            expectedFiles: capture.files,
            createError: (issues) => new AdapterManifestValidationError(issues),
        }))
            ? []
            : ["materialized adapter bundle changed during execution"];
    }
    catch (error) {
        return [
            `materialized adapter bundle could not be verified: ${error instanceof Error ? error.message : String(error)}`,
        ];
    }
}
export async function cleanupMaterializedAdapter(materialized) {
    await cleanupMaterializedBundle(materialized.root);
}
