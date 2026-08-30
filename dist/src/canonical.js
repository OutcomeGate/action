import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
function normalize(value) {
    if (Array.isArray(value)) {
        return value.map(normalize);
    }
    if (value !== null && typeof value === "object") {
        const record = value;
        return Object.fromEntries(Object.keys(record)
            .sort()
            .filter((key) => record[key] !== undefined)
            .map((key) => [key, normalize(record[key])]));
    }
    return value;
}
export function stableStringify(value) {
    return JSON.stringify(normalize(value));
}
export function digestValue(value) {
    return createHash("sha256").update(stableStringify(value)).digest("hex");
}
export async function digestFile(path) {
    const bytes = await readFile(path);
    return createHash("sha256").update(bytes).digest("hex");
}
export async function digestFiles(paths) {
    const hash = createHash("sha256");
    for (const [index, path] of paths.entries()) {
        hash.update(String(index));
        hash.update("\0");
        hash.update(await readFile(path));
        hash.update("\0");
    }
    return hash.digest("hex");
}
export async function digestNamedFiles(files) {
    const identities = [];
    for (const file of files) {
        const content = await readFile(file.path);
        identities.push({
            name: file.name,
            digest: createHash("sha256").update(content).digest("hex"),
            bytes: content.byteLength,
        });
    }
    return digestValue({ domain: "agentci.named-files.v1", files: identities });
}
export function cloneJson(value) {
    return structuredClone(value);
}
function isJsonValueAt(value, ancestors) {
    if (value === null ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean") {
        return typeof value !== "number" || Number.isFinite(value);
    }
    if (Array.isArray(value)) {
        if (ancestors.has(value)) {
            return false;
        }
        ancestors.add(value);
        const valid = value.every((item) => isJsonValueAt(item, ancestors));
        ancestors.delete(value);
        return valid;
    }
    if (typeof value === "object") {
        const object = value;
        const prototype = Object.getPrototypeOf(object);
        if ((prototype !== Object.prototype && prototype !== null) ||
            ancestors.has(object)) {
            return false;
        }
        ancestors.add(object);
        const valid = Object.values(value).every((item) => isJsonValueAt(item, ancestors));
        ancestors.delete(object);
        return valid;
    }
    return false;
}
export function isJsonValue(value) {
    return isJsonValueAt(value, new Set());
}
