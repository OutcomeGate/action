import { createHash } from "node:crypto";
import { posix } from "node:path";
export class SecretScanError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "SecretScanError";
        this.code = code;
    }
}
export const DEFAULT_SECRET_SCAN_LIMITS = Object.freeze({
    maxArtifacts: 1_000,
    maxArtifactBytes: 20 * 1024 * 1024,
    maxTotalBytes: 20 * 1024 * 1024,
    maxFindings: 100,
});
export const HARD_SECRET_SCAN_LIMITS = Object.freeze({
    maxArtifacts: 2_000,
    maxArtifactBytes: 20 * 1024 * 1024,
    maxTotalBytes: 64 * 1024 * 1024,
    maxFindings: 500,
});
const STATIC_RULES = Object.freeze([
    {
        id: "private-key",
        pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/g,
    },
    {
        id: "aws-access-key-id",
        pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    },
    {
        id: "github-token",
        pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{20,255})\b/g,
    },
    {
        id: "gitlab-token",
        pattern: /\bglpat-[A-Za-z0-9_-]{20,255}\b/g,
    },
    {
        id: "slack-token",
        pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,255}\b/g,
    },
    {
        id: "stripe-secret-key",
        pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,255}\b/g,
    },
    {
        id: "anthropic-api-key",
        pattern: /\bsk-ant-(?:api\d{2}-)?[A-Za-z0-9_-]{20,255}\b/g,
    },
    {
        id: "openai-api-key",
        pattern: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,255}\b/g,
    },
    {
        id: "google-api-key",
        pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    },
    {
        id: "sendgrid-api-key",
        pattern: /\bSG\.[A-Za-z0-9_-]{16,256}\.[A-Za-z0-9_-]{20,256}\b/g,
    },
    {
        id: "npm-access-token",
        pattern: /\bnpm_[A-Za-z0-9]{36}\b/g,
    },
    {
        id: "huggingface-token",
        pattern: /\bhf_[A-Za-z0-9]{20,255}\b/g,
    },
    {
        id: "json-web-token",
        pattern: /\beyJ[A-Za-z0-9_-]{5,512}\.[A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{8,2048}\b/g,
    },
    {
        id: "authorization-header",
        pattern: /\bauthorization\s*[:=]\s*["']?(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,512}/gi,
    },
]);
const CREDENTIAL_ASSIGNMENT_PATTERN = /(?:^|[\s,{;.\[])["']?(?:api[_-]?key|access[_-]?key|access[_-]?token|auth[_-]?token|authorization|client[_-]?secret|credential|credentials|password|passwd|pwd|secret|token|private[_-]?key|aws[_-]?secret[_-]?access[_-]?key|account[_-]?key|_auth[_-]?token)["']?\]?\s*(?::|=)\s*(?:"((?:\\.|[^"\\]){0,2048})"|'((?:\\.|[^'\\]){0,2048})'|([\[{]|[^\s,;}\]"'\[{]{1,2048}))/gim;
const CREDENTIALED_URL_PATTERN = /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s/:@]{1,128}:([^\s/@]{4,256})@[^\s/"']+/gi;
const LIMIT_KEYS = [
    "maxArtifacts",
    "maxArtifactBytes",
    "maxTotalBytes",
    "maxFindings",
];
function resolveLimits(options) {
    if (!isRecord(options) ||
        Object.keys(options).some((key) => key !== "limits") ||
        (options.limits !== undefined &&
            (!isRecord(options.limits) ||
                Object.keys(options.limits).some((key) => !LIMIT_KEYS.includes(key))))) {
        throw new SecretScanError("invalid_limits", "secret scan options contain unsupported fields");
    }
    const requested = options.limits ?? {};
    const limits = { ...DEFAULT_SECRET_SCAN_LIMITS };
    for (const key of LIMIT_KEYS) {
        const value = requested[key];
        if (value === undefined) {
            continue;
        }
        if (typeof value !== "number" ||
            !Number.isSafeInteger(value) ||
            value < 1 ||
            value > HARD_SECRET_SCAN_LIMITS[key]) {
            throw new SecretScanError("invalid_limits", `secret scan ${key} must be a positive integer within its hard cap`);
        }
        limits[key] = value;
    }
    return limits;
}
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validatePath(path, artifactIndex) {
    if (typeof path !== "string" ||
        path.length === 0 ||
        path.length > 512 ||
        path.startsWith("/") ||
        path.includes("\\") ||
        /[\u0000-\u001f\u007f]/.test(path) ||
        posix.normalize(path) !== path ||
        path.split("/").some((part) => part.length === 0 || part === "." || part === "..") ||
        metadataContainsSecretShape(path)) {
        throw new SecretScanError("invalid_input", `secret scan artifact ${artifactIndex} has an invalid logical path`);
    }
    return path;
}
function validateField(field, artifactIndex) {
    if (field === undefined) {
        return undefined;
    }
    if (typeof field !== "string" ||
        field.length === 0 ||
        field.length > 256 ||
        /[\u0000-\u001f\u007f]/.test(field) ||
        metadataContainsSecretShape(field)) {
        throw new SecretScanError("invalid_input", `secret scan artifact ${artifactIndex} has an invalid logical field`);
    }
    return field;
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
function assertWithinArtifactLimit(bytes, limits, artifactIndex) {
    if (bytes > limits.maxArtifactBytes) {
        throw new SecretScanError("artifact_size_exceeded", `secret scan artifact ${artifactIndex} exceeds the configured byte limit`);
    }
}
function readArtifactBytes(content, limits, artifactIndex) {
    if (typeof content === "string") {
        if (containsUnpairedSurrogate(content)) {
            throw new SecretScanError("invalid_input", `secret scan artifact ${artifactIndex} contains invalid text`);
        }
        const byteLength = Buffer.byteLength(content, "utf8");
        assertWithinArtifactLimit(byteLength, limits, artifactIndex);
        return { bytes: Buffer.from(content, "utf8"), suppliedAsText: true };
    }
    if (content instanceof Uint8Array) {
        assertWithinArtifactLimit(content.byteLength, limits, artifactIndex);
        return { bytes: Buffer.from(content), suppliedAsText: false };
    }
    if (Array.isArray(content)) {
        let byteLength = 0;
        const chunks = [];
        for (const chunk of content) {
            if (!(chunk instanceof Uint8Array)) {
                throw new SecretScanError("invalid_input", `secret scan artifact ${artifactIndex} contains an invalid byte chunk`);
            }
            if (chunk.byteLength > limits.maxArtifactBytes - byteLength) {
                throw new SecretScanError("artifact_size_exceeded", `secret scan artifact ${artifactIndex} exceeds the configured byte limit`);
            }
            byteLength += chunk.byteLength;
            chunks.push(Buffer.from(chunk));
        }
        return { bytes: Buffer.concat(chunks, byteLength), suppliedAsText: false };
    }
    throw new SecretScanError("invalid_input", `secret scan artifact ${artifactIndex} has invalid content`);
}
function isProbablyText(value) {
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
            code === 0x7f) {
            return false;
        }
    }
    return true;
}
function decodeForScanning(bytes, suppliedAsText) {
    if (suppliedAsText) {
        const text = Buffer.from(bytes).toString("utf8");
        return { text, lineNumbersAvailable: isProbablyText(text) };
    }
    try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (isProbablyText(text)) {
            return { text, lineNumbersAvailable: true };
        }
    }
    catch {
        // Contiguous ASCII tokens remain visible in the byte-preserving fallback.
    }
    return {
        text: Buffer.from(bytes).toString("latin1"),
        lineNumbersAvailable: false,
    };
}
function lineStartsFor(text) {
    const starts = [0];
    for (let index = 0; index < text.length; index += 1) {
        if (text.charCodeAt(index) === 0x0a) {
            starts.push(index + 1);
        }
    }
    return starts;
}
function lineForIndex(starts, index) {
    let low = 0;
    let high = starts.length;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if ((starts[middle] ?? 0) <= index) {
            low = middle + 1;
        }
        else {
            high = middle;
        }
    }
    return Math.max(1, low);
}
function safeFindingDigest(options) {
    return createHash("sha256")
        .update(JSON.stringify({
        domain: "agentci.secret-finding.v1",
        ruleId: options.ruleId,
        path: options.path,
        field: options.field ?? null,
        line: options.line ?? null,
    }), "utf8")
        .digest("hex");
}
function isPlaceholderOrReference(value, structural = false, quoted = false) {
    if (structural && (value === "{" || value === "[")) {
        return true;
    }
    const lower = value.toLowerCase();
    return (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value) ||
        /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value) ||
        /^\{\{\s*(?:secrets?|env|vars)\.[A-Za-z_][A-Za-z0-9_.-]*\s*\}\}$/i.test(value) ||
        /^<(?:redacted|masked|placeholder|api[_-]?key|token|password|secret|credential)>$/i.test(value) ||
        (!quoted &&
            (/^(?:[A-Za-z_$][\w$]*\.)*(?:env|credentials?|secrets?|tokens?)(?:\.[A-Za-z_$][\w$]*)+$/i.test(value) ||
                /^(?:getenv|Deno\.env\.get)\((?:["'])?[A-Za-z_][A-Za-z0-9_]*(?:["'])?\)$/i.test(value) ||
                /^os\.environ\[(?:["'])[A-Za-z_][A-Za-z0-9_]*(?:["'])\]$/i.test(value))) ||
        /^(?:redacted|masked|placeholder|example|sample|dummy|changeme|change-me|password|not[_-]?a[_-]?secret|none|null|undefined|test|x{8,}|\*{8,})$/i.test(lower) ||
        /^your[_-](?:api[_-]?key|token|password|secret|credential)$/i.test(lower));
}
function metadataContainsSecretShape(value) {
    for (const rule of STATIC_RULES) {
        const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
        if (pattern.test(value)) {
            return true;
        }
    }
    const assignmentPattern = new RegExp(CREDENTIAL_ASSIGNMENT_PATTERN.source, CREDENTIAL_ASSIGNMENT_PATTERN.flags);
    for (const match of value.matchAll(assignmentPattern)) {
        const assignedValue = (match[1] ?? match[2] ?? match[3] ?? "").trim();
        if (!isPlaceholderOrReference(assignedValue, match[3] !== undefined && (assignedValue === "{" || assignedValue === "["), match[1] !== undefined || match[2] !== undefined)) {
            return true;
        }
    }
    const urlPattern = new RegExp(CREDENTIALED_URL_PATTERN.source, CREDENTIALED_URL_PATTERN.flags);
    for (const match of value.matchAll(urlPattern)) {
        if (!isPlaceholderOrReference(match[1] ?? "")) {
            return true;
        }
    }
    return false;
}
function compareFindings(left, right) {
    return (compareText(left.path, right.path) ||
        compareText(left.field ?? "", right.field ?? "") ||
        (left.line ?? 0) - (right.line ?? 0) ||
        compareText(left.ruleId, right.ruleId));
}
function compareText(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
/**
 * Scans a closed set of logical artifacts without retaining or returning content.
 * Callers must treat SecretScanError and any non-clean result as a failed boundary.
 */
export function scanNamedArtifactsForSecrets(artifacts, options = {}) {
    const limits = resolveLimits(options);
    if (!Array.isArray(artifacts) || artifacts.length === 0) {
        throw new SecretScanError("invalid_input", "secret scan requires a non-empty artifact set");
    }
    if (artifacts.length > limits.maxArtifacts) {
        throw new SecretScanError("artifact_limit_exceeded", "secret scan artifact count exceeds the configured limit");
    }
    const normalized = artifacts.map((artifact, index) => {
        if (!isRecord(artifact)) {
            throw new SecretScanError("invalid_input", `secret scan artifact ${index} is invalid`);
        }
        if (Object.keys(artifact).some((key) => key !== "path" && key !== "field" && key !== "content")) {
            throw new SecretScanError("invalid_input", `secret scan artifact ${index} contains unsupported fields`);
        }
        const path = validatePath(artifact.path, index);
        const field = validateField(artifact.field, index);
        return {
            originalIndex: index,
            path,
            ...(field !== undefined ? { field } : {}),
            content: artifact.content,
        };
    });
    normalized.sort((left, right) => compareText(left.path, right.path) ||
        compareText(left.field ?? "", right.field ?? ""));
    const seenLocations = new Set();
    for (const artifact of normalized) {
        const key = `${artifact.path}\0${artifact.field ?? ""}`;
        if (seenLocations.has(key)) {
            throw new SecretScanError("invalid_input", "secret scan artifact locations must be unique");
        }
        seenLocations.add(key);
    }
    const findings = new Map();
    let findingsTruncated = false;
    let scannedBytes = 0;
    const addFinding = (finding) => {
        const key = `${finding.ruleId}\0${finding.path}\0${finding.field ?? ""}\0${finding.line ?? ""}`;
        if (findings.has(key)) {
            return;
        }
        if (findings.size >= limits.maxFindings) {
            findingsTruncated = true;
            return;
        }
        const safeFinding = Object.freeze({
            ...finding,
            findingDigest: safeFindingDigest(finding),
        });
        findings.set(key, safeFinding);
    };
    for (const artifact of normalized) {
        const { bytes, suppliedAsText } = readArtifactBytes(artifact.content, limits, artifact.originalIndex);
        if (bytes.byteLength > limits.maxTotalBytes - scannedBytes) {
            bytes.fill(0);
            throw new SecretScanError("total_size_exceeded", "secret scan total bytes exceed the configured limit");
        }
        scannedBytes += bytes.byteLength;
        try {
            const { text, lineNumbersAvailable } = decodeForScanning(bytes, suppliedAsText);
            const lineStarts = lineNumbersAvailable ? lineStartsFor(text) : [];
            const locationFor = (ruleId, index) => ({
                ruleId,
                path: artifact.path,
                ...(artifact.field !== undefined ? { field: artifact.field } : {}),
                ...(lineNumbersAvailable
                    ? { line: lineForIndex(lineStarts, index) }
                    : {}),
            });
            for (const rule of STATIC_RULES) {
                const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
                for (const match of text.matchAll(pattern)) {
                    addFinding(locationFor(rule.id, match.index));
                }
            }
            const assignmentPattern = new RegExp(CREDENTIAL_ASSIGNMENT_PATTERN.source, CREDENTIAL_ASSIGNMENT_PATTERN.flags);
            for (const match of text.matchAll(assignmentPattern)) {
                const assignedValue = (match[1] ?? match[2] ?? match[3] ?? "").trim();
                if (!isPlaceholderOrReference(assignedValue, match[3] !== undefined &&
                    (assignedValue === "{" || assignedValue === "["), match[1] !== undefined || match[2] !== undefined)) {
                    const firstCharacter = match[0][0];
                    const assignmentIndex = firstCharacter !== undefined && /[\s,{;]/.test(firstCharacter)
                        ? match.index + 1
                        : match.index;
                    addFinding(locationFor("suspicious-credential-assignment", assignmentIndex));
                }
            }
            const urlPattern = new RegExp(CREDENTIALED_URL_PATTERN.source, CREDENTIALED_URL_PATTERN.flags);
            for (const match of text.matchAll(urlPattern)) {
                const password = match[1] ?? "";
                if (!isPlaceholderOrReference(password)) {
                    addFinding(locationFor("credentialed-url", match.index));
                }
            }
        }
        finally {
            bytes.fill(0);
        }
    }
    const stableFindings = Object.freeze([...findings.values()].sort(compareFindings));
    return Object.freeze({
        schemaVersion: "agentci.secret-scan.v1",
        status: stableFindings.length > 0 || findingsTruncated ? "findings" : "clean",
        scannedArtifacts: normalized.length,
        scannedBytes,
        findings: stableFindings,
        findingsTruncated,
    });
}
export function scanTextForSecrets(options) {
    return scanNamedArtifactsForSecrets([
        {
            path: options.path,
            ...(options.field !== undefined ? { field: options.field } : {}),
            content: options.text,
        },
    ], options.limits !== undefined ? { limits: options.limits } : {});
}
export function scanBytesForSecrets(options) {
    return scanNamedArtifactsForSecrets([
        {
            path: options.path,
            ...(options.field !== undefined ? { field: options.field } : {}),
            content: options.bytes,
        },
    ], options.limits !== undefined ? { limits: options.limits } : {});
}
/**
 * Turns a scan result into a fail-closed boundary without exposing matched
 * content. Messages contain only rule and logical-location metadata.
 */
export function assertSecretScanClean(result, boundary) {
    if (result.status === "clean" && !result.findingsTruncated) {
        return;
    }
    const safeFindings = result.findings.slice(0, 10).map((finding) => {
        const field = finding.field === undefined ? "" : ` field ${finding.field}`;
        const line = finding.line === undefined ? "" : ` line ${finding.line}`;
        return `${finding.ruleId} at ${finding.path}${field}${line}`;
    });
    const suffix = result.findingsTruncated
        ? "additional findings were truncated"
        : "remove the source value and rescan";
    throw new SecretScanError("findings_detected", `${boundary} failed static secret scanning: ${[
        ...safeFindings,
        suffix,
    ].join("; ")}`);
}
