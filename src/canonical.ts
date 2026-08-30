import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { JsonValue } from "./types.js";

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalize);
  }

  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .filter((key) => record[key] !== undefined)
        .map((key) => [key, normalize(record[key])]),
    );
  }

  return value;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function digestValue(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export async function digestFile(path: string): Promise<string> {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

export async function digestFiles(paths: string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const [index, path] of paths.entries()) {
    hash.update(String(index));
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function digestNamedFiles(
  files: ReadonlyArray<{ name: string; path: string }>,
): Promise<string> {
  const identities: Array<{ name: string; digest: string; bytes: number }> = [];
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

export function cloneJson<T extends JsonValue>(value: T): T {
  return structuredClone(value);
}

function isJsonValueAt(value: unknown, ancestors: Set<object>): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
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
    const object = value as object;
    const prototype = Object.getPrototypeOf(object);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      ancestors.has(object)
    ) {
      return false;
    }
    ancestors.add(object);
    const valid = Object.values(value as Record<string, unknown>).every((item) =>
      isJsonValueAt(item, ancestors),
    );
    ancestors.delete(object);
    return valid;
  }

  return false;
}

export function isJsonValue(value: unknown): value is JsonValue {
  return isJsonValueAt(value, new Set<object>());
}
