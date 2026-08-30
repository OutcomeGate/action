import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  bundleFileIdentities,
  captureDeclaredBundle,
  cleanupMaterializedBundle,
  compareCanonicalText,
  computeBundleDigest,
  isSafeRelativePath,
  materializeCapturedBundle,
  materializedBundleMatches,
} from "./bundle.js";
import { digestValue, isJsonValue } from "./canonical.js";
import { parseCandidateCredentialPolicy } from "./candidate-credential-policy.js";
import { ReleaseValidationError } from "./errors.js";
import {
  assertSecretScanClean,
  scanNamedArtifactsForSecrets,
  scanTextForSecrets,
} from "./secret-scan.js";
import { parseStrictJson, StrictJsonError } from "./strict-json.js";
import type { CapturedBundleFile } from "./bundle.js";
import type {
  ManifestReleaseIdentity,
  ReleaseManifestSpec,
  ReleaseModelSpec,
} from "./types.js";

export interface ReleaseCapture {
  manifest: ReleaseManifestSpec;
  identity: ManifestReleaseIdentity;
  files: CapturedBundleFile[];
}

export interface MaterializedRelease {
  root: string;
  candidatePath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unknownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: string[],
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      issues.push(`${path}${path.length > 0 ? "." : ""}${key} is not supported`);
    }
  }
}

function readString(
  value: unknown,
  path: string,
  issues: string[],
): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push(`${path} must be a non-empty string`);
    return undefined;
  }
  return value;
}

function readPath(
  value: unknown,
  path: string,
  issues: string[],
): string | undefined {
  const text = readString(value, path, issues);
  if (text !== undefined && !isSafeRelativePath(text)) {
    issues.push(`${path} must be a normalized relative POSIX path without traversal`);
    return undefined;
  }
  return text;
}

function parseStringPaths(
  value: unknown,
  path: string,
  issues: string[],
): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(`${path} must be a non-empty array of relative paths`);
    return [];
  }
  const paths = value
    .map((candidate, index) => readPath(candidate, `${path}[${index}]`, issues))
    .filter((candidate): candidate is string => candidate !== undefined);
  if (new Set(paths).size !== paths.length) {
    issues.push(`${path} must not contain duplicates`);
  }
  return paths.sort(compareCanonicalText);
}

function parseModel(
  value: unknown,
  issues: string[],
): ReleaseModelSpec | undefined {
  if (!isRecord(value)) {
    issues.push("model must be an object");
    return undefined;
  }
  if (value.kind === "none") {
    unknownKeys(value, ["kind", "reason"], "model", issues);
    const reason = readString(value.reason, "model.reason", issues);
    return reason === undefined ? undefined : { kind: "none", reason };
  }
  if (value.kind === "remote") {
    unknownKeys(
      value,
      ["kind", "provider", "identifier", "revision", "configuration"],
      "model",
      issues,
    );
    const provider = readString(value.provider, "model.provider", issues);
    const identifier = readString(value.identifier, "model.identifier", issues);
    const revision = readString(value.revision, "model.revision", issues);
    if (value.configuration !== undefined && !isJsonValue(value.configuration)) {
      issues.push("model.configuration must be JSON");
    }
    if (provider === undefined || identifier === undefined || revision === undefined) {
      return undefined;
    }
    return {
      kind: "remote",
      provider,
      identifier,
      revision,
      ...(value.configuration !== undefined && isJsonValue(value.configuration)
        ? { configuration: value.configuration }
        : {}),
    };
  }
  issues.push("model.kind must be 'none' or 'remote'");
  return undefined;
}

export function parseReleaseManifest(value: unknown): ReleaseManifestSpec {
  const issues: string[] = [];
  if (!isRecord(value)) {
    throw new ReleaseValidationError(["release manifest must be an object"]);
  }
  const schemaVersion = value.schemaVersion;
  unknownKeys(
    value,
    [
      "schemaVersion",
      "name",
      "runtime",
      "bundle",
      "model",
      "components",
      ...(schemaVersion === "agentci.release.v2" ? ["candidate"] : []),
    ],
    "",
    issues,
  );
  if (
    schemaVersion !== "agentci.release.v1" &&
    schemaVersion !== "agentci.release.v2"
  ) {
    issues.push("schemaVersion must be 'agentci.release.v1' or 'agentci.release.v2'");
  }
  const name = readString(value.name, "name", issues);

  let runtime: ReleaseManifestSpec["runtime"] | undefined;
  if (!isRecord(value.runtime)) {
    issues.push("runtime must be an object");
  } else {
    unknownKeys(value.runtime, ["kind", "protocolVersion", "entry"], "runtime", issues);
    if (value.runtime.kind !== "node-jsonl") {
      issues.push("runtime.kind must be 'node-jsonl'");
    }
    if (value.runtime.protocolVersion !== 1) {
      issues.push("runtime.protocolVersion must be 1");
    }
    const entry = readPath(value.runtime.entry, "runtime.entry", issues);
    if (
      value.runtime.kind === "node-jsonl" &&
      value.runtime.protocolVersion === 1 &&
      entry !== undefined
    ) {
      runtime = { kind: "node-jsonl", protocolVersion: 1, entry };
    }
  }

  let bundle: ReleaseManifestSpec["bundle"] | undefined;
  if (!isRecord(value.bundle)) {
    issues.push("bundle must be an object");
  } else {
    unknownKeys(value.bundle, ["root"], "bundle", issues);
    const root = readPath(value.bundle.root, "bundle.root", issues);
    if (root !== undefined) {
      bundle = { root };
    }
  }

  const model = parseModel(value.model, issues);
  let candidate:
    | Extract<ReleaseManifestSpec, { schemaVersion: "agentci.release.v2" }>["candidate"]
    | undefined;
  if (schemaVersion === "agentci.release.v2") {
    if (!isRecord(value.candidate)) {
      issues.push("candidate must be an object");
    } else {
      unknownKeys(value.candidate, ["credentials"], "candidate", issues);
      try {
        candidate = {
          credentials: parseCandidateCredentialPolicy(
            value.candidate.credentials,
          ),
        };
      } catch (error) {
        issues.push(
          `candidate.credentials is invalid: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
  let components: ReleaseManifestSpec["components"] | undefined;
  if (!isRecord(value.components)) {
    issues.push("components must be an object");
  } else {
    unknownKeys(value.components, ["prompts", "toolSchemas"], "components", issues);
    const prompts = parseStringPaths(value.components.prompts, "components.prompts", issues);
    const toolSchemas = parseStringPaths(
      value.components.toolSchemas,
      "components.toolSchemas",
      issues,
    );
    const overlaps = prompts.filter((path) => toolSchemas.includes(path));
    if (overlaps.length > 0) {
      issues.push(`prompt and tool-schema paths overlap: ${overlaps.join(", ")}`);
    }
    components = { prompts, toolSchemas };
  }

  if (
    runtime !== undefined &&
    components !== undefined &&
    (components.prompts.includes(runtime.entry) ||
      components.toolSchemas.includes(runtime.entry))
  ) {
    issues.push("runtime.entry cannot also be classified as a prompt or tool schema");
  }

  if (
    issues.length > 0 ||
    name === undefined ||
    runtime === undefined ||
    bundle === undefined ||
    model === undefined ||
    components === undefined ||
    (schemaVersion === "agentci.release.v2" && candidate === undefined)
  ) {
    throw new ReleaseValidationError(issues);
  }
  if (
    schemaVersion === "agentci.release.v2" &&
    candidate !== undefined
  ) {
    if (
      model.kind === "none" &&
      candidate.credentials.kind === "environment"
    ) {
      throw new ReleaseValidationError([
        "candidate credentials require a declared remote model",
      ]);
    }
    return {
      schemaVersion,
      name,
      runtime,
      bundle,
      model,
      components,
      candidate,
    };
  }
  return {
    schemaVersion: "agentci.release.v1",
    name,
    runtime,
    bundle,
    model,
    components,
  };
}

export async function loadReleaseManifest(
  path: string,
): Promise<ReleaseCapture> {
  const manifestPath = resolve(path);
  let value: unknown;
  try {
    const raw = await readFile(manifestPath, "utf8");
    assertSecretScanClean(
      scanTextForSecrets({ path: "release/manifest.json", text: raw }),
      "release manifest",
    );
    value = parseStrictJson(raw);
    assertSecretScanClean(
      scanTextForSecrets({
        path: "release/manifest.json",
        field: "normalized-json",
        text: JSON.stringify(value),
      }),
      "normalized release manifest",
    );
  } catch (error) {
    throw new ReleaseValidationError([
      `manifest could not be read as JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ]);
  }
  const manifest = parseReleaseManifest(value);
  const manifestDirectory = dirname(manifestPath);
  const capturedBundle = await captureDeclaredBundle({
    manifestDirectory,
    relativeRoot: manifest.bundle.root,
    createError: (issues) => new ReleaseValidationError(issues),
  });
  const bundleRoot = capturedBundle.sourceRoot;
  const files = capturedBundle.files;
  assertSecretScanClean(
    scanNamedArtifactsForSecrets(
      files.map((file) => ({
        path: `release-bundle/${file.path}`,
        content: file.content,
      })),
    ),
    "release bundle",
  );
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
          path: `release-bundle/${file.path}`,
          field: "normalized-json",
          content: normalized,
        },
      ];
    } catch (error) {
      if (
        error instanceof StrictJsonError &&
        error.code !== "invalid_syntax"
      ) {
        throw new ReleaseValidationError([
          `release bundle JSON artifact ${index + 1} is ambiguous or exceeds the strict parser boundary`,
        ]);
      }
      return [];
    }
  });
  if (normalizedJsonFiles.length > 0) {
    assertSecretScanClean(
      scanNamedArtifactsForSecrets(normalizedJsonFiles),
      "normalized release JSON bundle files",
    );
  }
  const byPath = new Map(files.map((file) => [file.path, file]));
  const requiredPaths = [
    manifest.runtime.entry,
    ...manifest.components.prompts,
    ...manifest.components.toolSchemas,
  ];
  const missing = requiredPaths.filter((requiredPath) => !byPath.has(requiredPath));
  if (missing.length > 0) {
    throw new ReleaseValidationError([
      `manifest references files absent from the bundle: ${missing.join(", ")}`,
    ]);
  }
  const entry = byPath.get(manifest.runtime.entry);
  if (entry === undefined) {
    throw new ReleaseValidationError(["runtime entry is missing after capture"]);
  }
  const prompts = manifest.components.prompts.map((promptPath) => byPath.get(promptPath)!);
  const toolSchemas = manifest.components.toolSchemas.map(
    (schemaPath) => byPath.get(schemaPath)!,
  );
  const classified = new Set([
    ...manifest.components.prompts,
    ...manifest.components.toolSchemas,
  ]);
  const harness = files.filter((file) => !classified.has(file.path));
  const manifestVersion = manifest.schemaVersion === "agentci.release.v2" ? 2 : 1;
  const manifestDigest = digestValue({
    domain: `agentci.release-manifest.v${manifestVersion}`,
    manifest,
  });
  const bundleDigest = computeBundleDigest("agentci.release-bundle.v1", files);
  const modelDeclarationDigest = digestValue({
    domain: "agentci.model-declaration.v1",
    model: manifest.model,
  });
  const promptDigest = computeBundleDigest("agentci.prompt-set.v1", prompts);
  const toolSchemaDigest = computeBundleDigest(
    "agentci.tool-schema-set.v1",
    toolSchemas,
  );
  const harnessDigest = computeBundleDigest("agentci.harness-set.v1", harness);
  const releaseDigest = digestValue({
    domain: `agentci.declared-release.v${manifestVersion}`,
    runtime: manifest.runtime,
    manifestDigest,
    bundleDigest,
    modelDeclarationDigest,
    promptDigest,
    toolSchemaDigest,
    harnessDigest,
  });
  return {
    manifest,
    files,
    identity: {
      name: manifest.name,
      candidatePath: join(bundleRoot, manifest.runtime.entry),
      entryFileDigest: entry.digest,
      digestScope: "declared-config-and-bundle-bytes",
      manifestPath,
      manifestDigest,
      releaseDigest,
      bundleDigest,
      modelDeclarationDigest,
      promptDigest,
      toolSchemaDigest,
      harnessDigest,
      entryPath: manifest.runtime.entry,
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

export async function materializeRelease(
  capture: ReleaseCapture,
): Promise<MaterializedRelease> {
  const root = await materializeCapturedBundle({
    files: capture.files,
    prefix: "agentci-release-",
    createError: (issues) => new ReleaseValidationError(issues),
  });
  return {
    root,
    candidatePath: join(root, ...capture.manifest.runtime.entry.split("/")),
  };
}

export async function verifyMaterializedRelease(
  materialized: MaterializedRelease,
  capture: ReleaseCapture,
): Promise<string[]> {
  try {
    return (await materializedBundleMatches({
      root: materialized.root,
      expectedFiles: capture.files,
      createError: (issues) => new ReleaseValidationError(issues),
    }))
      ? []
      : ["materialized release bundle changed during scenario execution"];
  } catch (error) {
    return [
      `materialized release bundle could not be verified: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ];
  }
}

export async function cleanupMaterializedRelease(
  materialized: MaterializedRelease,
): Promise<void> {
  await cleanupMaterializedBundle(materialized.root);
}
