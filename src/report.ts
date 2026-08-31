import { mkdir, writeFile } from "node:fs/promises";
import { dirname, posix } from "node:path";

import { digestValue, isJsonValue } from "./canonical.js";
import { parseAdapterManifest } from "./adapter-manifest.js";
import { parseReleaseManifest } from "./release.js";
import {
  assertSecretScanClean,
  scanTextForSecrets,
} from "./secret-scan.js";
import type {
  AdapterManifestSpec,
  AdapterIdentity,
  ReleaseIdentity,
  ReleaseManifestSpec,
  ReleaseModelSpec,
  ReleaseReport,
  SanitizedPublicationReport,
  ScenarioResult,
  ToolEvent,
} from "./types.js";

const CANDIDATE_STDERR_CAPTURE_LIMIT_BYTES = 16_384;

function stableEvent(event: ToolEvent): Omit<ToolEvent, "durationMs"> {
  const { durationMs: _durationMs, ...stable } = event;
  return stable;
}

function stableScenario(
  scenario: ScenarioResult,
): Omit<ScenarioResult, "durationMs" | "events"> & {
  events: Omit<ToolEvent, "durationMs">[];
} {
  const {
    durationMs: _durationMs,
    events,
    ...stable
  } = scenario;
  return { ...stable, events: events.map(stableEvent) };
}

export function computeEvidenceDigest(
  report: Omit<ReleaseReport, "evidenceDigest">,
): string {
  const release =
    report.release.digestScope === "entry-file-only"
      ? {
          name: report.release.name,
          entryFileDigest: report.release.entryFileDigest,
          digestScope: report.release.digestScope,
        }
      : {
          name: report.release.name,
          entryFileDigest: report.release.entryFileDigest,
          digestScope: report.release.digestScope,
          manifestDigest: report.release.manifestDigest,
          releaseDigest: report.release.releaseDigest,
          bundleDigest: report.release.bundleDigest,
          modelDeclarationDigest: report.release.modelDeclarationDigest,
          promptDigest: report.release.promptDigest,
          toolSchemaDigest: report.release.toolSchemaDigest,
          harnessDigest: report.release.harnessDigest,
          entryPath: report.release.entryPath,
          fileCount: report.release.fileCount,
          manifest: report.release.manifest,
          files: report.release.files,
          execution: report.release.execution,
        };
  return digestValue({
    schemaVersion: report.schemaVersion,
    suite: {
      name: report.suite.name,
      version: report.suite.version,
      digest: report.suite.digest,
      fixture: report.suite.fixture,
    },
    release,
    adapter:
      report.adapter.digestScope === "module-entry-only"
        ? {
            apiVersion: report.adapter.apiVersion,
            id: report.adapter.id,
            version: report.adapter.version,
            source: report.adapter.source,
            moduleDigest: report.adapter.moduleDigest,
            digestScope: report.adapter.digestScope,
          }
        : {
            apiVersion: report.adapter.apiVersion,
            id: report.adapter.id,
            version: report.adapter.version,
            source: report.adapter.source,
            digestScope: report.adapter.digestScope,
            manifestDigest: report.adapter.manifestDigest,
            bundleDigest: report.adapter.bundleDigest,
            configurationDigest: report.adapter.configurationDigest,
            credentialDeclarationDigest:
              report.adapter.credentialDeclarationDigest,
            contractDigest: report.adapter.contractDigest,
            adapterDigest: report.adapter.adapterDigest,
            entryPath: report.adapter.entryPath,
            entryFileDigest: report.adapter.entryFileDigest,
            fileCount: report.adapter.fileCount,
            manifest: report.adapter.manifest,
            files: report.adapter.files,
            execution: report.adapter.execution,
          },
    evaluator: report.evaluator,
    scenarios: report.scenarios.map(stableScenario),
    decision: report.decision,
  });
}

export function verifyEvidenceDigest(report: ReleaseReport): boolean {
  const { evidenceDigest, ...withoutDigest } = report;
  return computeEvidenceDigest(withoutDigest) === evidenceDigest;
}

const SANITIZED_PUBLICATION_OMISSIONS = Object.freeze([
  "adapter.manifest-and-file-inventory",
  "candidate.stderr-digest",
  "local.paths",
  "logical.identifiers",
  "release.manifest-and-file-inventory",
  "scenario.assertion-details",
  "scenario.descriptions",
  "scenario.events",
  "scenario.outputs",
  "scenario.reasons",
  "suite.task-and-initial-state",
  "timing",
]);

export const SANITIZED_PUBLICATION_RETENTION_DAYS = 7;

export function computePublicationDigest(
  report: Omit<SanitizedPublicationReport, "publicationDigest">,
): string {
  return digestValue(report);
}

export function createSanitizedPublicationReport(
  report: ReleaseReport,
): SanitizedPublicationReport {
  if (!isReleaseReport(report) || !verifyEvidenceDigest(report)) {
    throw new Error("source report is invalid or its evidence digest does not match");
  }
  const release: SanitizedPublicationReport["release"] =
    report.release.digestScope === "entry-file-only"
      ? {
          digestScope: report.release.digestScope,
          entryFileDigest: report.release.entryFileDigest,
        }
      : {
          digestScope: report.release.digestScope,
          releaseDigest: report.release.releaseDigest,
        };
  const adapter: SanitizedPublicationReport["adapter"] =
    report.adapter.digestScope === "module-entry-only"
      ? {
          digestScope: report.adapter.digestScope,
          moduleDigest: report.adapter.moduleDigest,
        }
      : {
          digestScope: report.adapter.digestScope,
          adapterDigest: report.adapter.adapterDigest,
        };
  const withoutDigest: Omit<
    SanitizedPublicationReport,
    "publicationDigest"
  > = {
    schemaVersion: "agentci.publication.v1",
    profile: "sanitized",
    sourceEvidenceDigest: report.evidenceDigest,
    suite: { digest: report.suite.digest },
    release,
    adapter,
    evaluator: report.evaluator,
    scenarios: report.scenarios.map((scenario, index) => ({
      scenario: index + 1,
      verdict: scenario.verdict,
      reasonCount: scenario.reasons.length,
      assertionsPassed: scenario.assertions.filter((assertion) => assertion.passed)
        .length,
      assertionsTotal: scenario.assertions.length,
      toolCallCount: scenario.events.length,
      candidateStderrBytes: scenario.candidateDiagnostics.stderrBytes,
      candidateStderrTruncated:
        scenario.candidateDiagnostics.stderrTruncated,
    })),
    decision: {
      verdict: report.decision.verdict,
      passed: report.decision.passed,
      blocked: report.decision.blocked,
      indeterminate: report.decision.indeterminate,
      total: report.decision.total,
      passRate: report.decision.passRate,
    },
    publication: {
      fullEvidencePublished: false,
      rawCandidateStderrPublished: false,
      omitted: [...SANITIZED_PUBLICATION_OMISSIONS],
      recommendedRetentionDays: SANITIZED_PUBLICATION_RETENTION_DAYS,
    },
  };
  return {
    ...withoutDigest,
    publicationDigest: computePublicationDigest(withoutDigest),
  };
}

export function verifyPublicationDigest(
  report: SanitizedPublicationReport,
): boolean {
  const { publicationDigest, ...withoutDigest } = report;
  return computePublicationDigest(withoutDigest) === publicationDigest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isSafeInventoryPath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    value !== "." &&
    posix.normalize(value) === value &&
    !value.split("/").some((segment) => segment.length === 0 || segment === "..")
  );
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function isSanitizedPublicationReport(
  value: unknown,
): value is SanitizedPublicationReport {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "schemaVersion",
      "profile",
      "sourceEvidenceDigest",
      "suite",
      "release",
      "adapter",
      "evaluator",
      "scenarios",
      "decision",
      "publication",
      "publicationDigest",
    ]) ||
    value.schemaVersion !== "agentci.publication.v1" ||
    value.profile !== "sanitized" ||
    !isDigest(value.sourceEvidenceDigest) ||
    !isDigest(value.publicationDigest)
  ) {
    return false;
  }
  const suite = value.suite;
  const release = value.release;
  const adapter = value.adapter;
  const evaluator = value.evaluator;
  const scenarios = value.scenarios;
  const decision = value.decision;
  const publication = value.publication;
  if (
    !isRecord(suite) ||
    !hasOnlyKeys(suite, ["digest"]) ||
    !isDigest(suite.digest) ||
    !isRecord(release) ||
    !(
      (release.digestScope === "entry-file-only" &&
        hasOnlyKeys(release, ["digestScope", "entryFileDigest"]) &&
        isDigest(release.entryFileDigest)) ||
      (release.digestScope === "declared-config-and-bundle-bytes" &&
        hasOnlyKeys(release, ["digestScope", "releaseDigest"]) &&
        isDigest(release.releaseDigest))
    ) ||
    !isRecord(adapter) ||
    !(
      (adapter.digestScope === "module-entry-only" &&
        hasOnlyKeys(adapter, ["digestScope", "moduleDigest"]) &&
        isDigest(adapter.moduleDigest)) ||
      (adapter.digestScope === "declared-config-and-adapter-bundle-bytes" &&
        hasOnlyKeys(adapter, ["digestScope", "adapterDigest"]) &&
        isDigest(adapter.adapterDigest))
    ) ||
    !isRecord(evaluator) ||
    !hasOnlyKeys(evaluator, ["name", "version", "buildDigest"]) ||
    evaluator.name !== "agent-ci" ||
    typeof evaluator.version !== "string" ||
    evaluator.version.length === 0 ||
    !isDigest(evaluator.buildDigest) ||
    !Array.isArray(scenarios) ||
    scenarios.length === 0
  ) {
    return false;
  }
  for (let index = 0; index < scenarios.length; index += 1) {
    const scenario = scenarios[index];
    if (
      !isRecord(scenario) ||
      !hasOnlyKeys(scenario, [
        "scenario",
        "verdict",
        "reasonCount",
        "assertionsPassed",
        "assertionsTotal",
        "toolCallCount",
        "candidateStderrBytes",
        "candidateStderrTruncated",
      ]) ||
      scenario.scenario !== index + 1 ||
      (scenario.verdict !== "pass" &&
        scenario.verdict !== "block" &&
        scenario.verdict !== "indeterminate") ||
      !isNonNegativeInteger(scenario.reasonCount) ||
      !isNonNegativeInteger(scenario.assertionsPassed) ||
      !isNonNegativeInteger(scenario.assertionsTotal) ||
      scenario.assertionsPassed > scenario.assertionsTotal ||
      !isNonNegativeInteger(scenario.toolCallCount) ||
      !isNonNegativeInteger(scenario.candidateStderrBytes) ||
      typeof scenario.candidateStderrTruncated !== "boolean" ||
      scenario.candidateStderrTruncated !==
        (scenario.candidateStderrBytes >
          CANDIDATE_STDERR_CAPTURE_LIMIT_BYTES) ||
      (scenario.verdict === "pass" && scenario.reasonCount !== 0) ||
      (scenario.verdict === "pass" &&
        scenario.assertionsPassed !== scenario.assertionsTotal)
    ) {
      return false;
    }
  }
  if (
    !isRecord(decision) ||
    !hasOnlyKeys(decision, [
      "verdict",
      "passed",
      "blocked",
      "indeterminate",
      "total",
      "passRate",
    ]) ||
    (decision.verdict !== "pass" &&
      decision.verdict !== "block" &&
      decision.verdict !== "indeterminate") ||
    !isNonNegativeInteger(decision.passed) ||
    !isNonNegativeInteger(decision.blocked) ||
    !isNonNegativeInteger(decision.indeterminate) ||
    decision.total !== scenarios.length ||
    decision.passed + decision.blocked + decision.indeterminate !==
      decision.total ||
    typeof decision.passRate !== "number" ||
    decision.passRate !== decision.passed / decision.total ||
    decision.passed !==
      scenarios.filter(
        (scenario) => isRecord(scenario) && scenario.verdict === "pass",
      ).length ||
    decision.blocked !==
      scenarios.filter(
        (scenario) => isRecord(scenario) && scenario.verdict === "block",
      ).length ||
    decision.indeterminate !==
      scenarios.filter(
        (scenario) => isRecord(scenario) && scenario.verdict === "indeterminate",
      ).length ||
    decision.verdict !==
      (decision.blocked > 0
        ? "block"
        : decision.indeterminate > 0
          ? "indeterminate"
          : "pass")
  ) {
    return false;
  }
  if (
    !isRecord(publication) ||
    !hasOnlyKeys(publication, [
      "fullEvidencePublished",
      "rawCandidateStderrPublished",
      "omitted",
      "recommendedRetentionDays",
    ]) ||
    publication.fullEvidencePublished !== false ||
    publication.rawCandidateStderrPublished !== false ||
    publication.recommendedRetentionDays !==
      SANITIZED_PUBLICATION_RETENTION_DAYS ||
    !Array.isArray(publication.omitted) ||
    publication.omitted.length !== SANITIZED_PUBLICATION_OMISSIONS.length ||
    publication.omitted.some(
      (item, index) => item !== SANITIZED_PUBLICATION_OMISSIONS[index],
    )
  ) {
    return false;
  }
  return true;
}

function isReleaseModel(value: unknown): value is ReleaseModelSpec {
  if (!isRecord(value)) {
    return false;
  }
  if (value.kind === "none") {
    return typeof value.reason === "string" && value.reason.length > 0;
  }
  if (value.kind === "local") {
    return (
      typeof value.identifier === "string" &&
      value.identifier.length > 0 &&
      typeof value.revision === "string" &&
      value.revision.length > 0 &&
      typeof value.format === "string" &&
      value.format.length > 0 &&
      Array.isArray(value.artifacts) &&
      value.artifacts.length > 0 &&
      value.artifacts.every(
        (artifact) => typeof artifact === "string" && artifact.length > 0,
      ) &&
      (value.configuration === undefined || isJsonValue(value.configuration))
    );
  }
  return (
    value.kind === "remote" &&
    typeof value.provider === "string" &&
    value.provider.length > 0 &&
    typeof value.identifier === "string" &&
    value.identifier.length > 0 &&
    typeof value.revision === "string" &&
    value.revision.length > 0 &&
    (value.configuration === undefined || isJsonValue(value.configuration))
  );
}

function normalizeReleaseManifest(
  value: unknown,
): ReleaseManifestSpec | undefined {
  try {
    return parseReleaseManifest(value);
  } catch {
    return undefined;
  }
}

function isManifestReleaseIdentity(
  value: Record<string, unknown>,
): boolean {
  const manifest = value.manifest;
  const files = value.files;
  const execution = value.execution;
  const parsedManifest = normalizeReleaseManifest(manifest);
  if (
    !hasOnlyKeys(value, [
      "name",
      "candidatePath",
      "entryFileDigest",
      "digestScope",
      "manifestPath",
      "manifestDigest",
      "releaseDigest",
      "bundleDigest",
      "modelDeclarationDigest",
      "promptDigest",
      "toolSchemaDigest",
      "harnessDigest",
      "entryPath",
      "fileCount",
      "manifest",
      "files",
      "execution",
    ]) ||
    typeof value.name !== "string" ||
    typeof value.candidatePath !== "string" ||
    !isDigest(value.entryFileDigest) ||
    value.digestScope !== "declared-config-and-bundle-bytes" ||
    typeof value.manifestPath !== "string" ||
    !isDigest(value.manifestDigest) ||
    !isDigest(value.releaseDigest) ||
    !isDigest(value.bundleDigest) ||
    !isDigest(value.modelDeclarationDigest) ||
    !isDigest(value.promptDigest) ||
    !isDigest(value.toolSchemaDigest) ||
    !isDigest(value.harnessDigest) ||
    typeof value.entryPath !== "string" ||
    !Number.isSafeInteger(value.fileCount) ||
    (value.fileCount as number) < 1 ||
    parsedManifest === undefined ||
    digestValue(manifest) !== digestValue(parsedManifest) ||
    !Array.isArray(files) ||
    !isRecord(execution) ||
    !hasOnlyKeys(execution, ["nodeVersion", "platform", "architecture"]) ||
    typeof execution.nodeVersion !== "string" ||
    typeof execution.platform !== "string" ||
    typeof execution.architecture !== "string"
  ) {
    return false;
  }
  const identities = files.filter(isRecord).map((file) => ({
    path: file.path,
    digest: file.digest,
    bytes: file.bytes,
    mode: file.mode,
  }));
  if (
    identities.length !== files.length ||
    identities.length !== value.fileCount ||
    identities.some(
      (file) =>
        typeof file.path !== "string" ||
        !isSafeInventoryPath(file.path) ||
        !isDigest(file.digest) ||
        !Number.isSafeInteger(file.bytes) ||
        (file.bytes as number) < 0 ||
        !Number.isSafeInteger(file.mode) ||
        (file.mode as number) < 0 ||
        (file.mode as number) > 0o777,
    ) ||
    files.some(
      (file) =>
        isRecord(file) &&
        !hasOnlyKeys(file, ["path", "digest", "bytes", "mode"]),
    ) ||
    new Set(identities.map((file) => file.path)).size !== identities.length ||
    identities.some(
      (file, index) =>
        index > 0 &&
        typeof identities[index - 1]?.path === "string" &&
        (identities[index - 1]!.path as string) >= (file.path as string),
    )
  ) {
    return false;
  }
  const fileRecords = identities as Array<{
    path: string;
    digest: string;
    bytes: number;
    mode: number;
  }>;
  const byPath = new Map(fileRecords.map((file) => [file.path, file]));
  const entry = byPath.get(parsedManifest.runtime.entry);
  const promptFiles = parsedManifest.components.prompts.map((path) => byPath.get(path));
  const toolSchemaFiles = parsedManifest.components.toolSchemas.map((path) =>
    byPath.get(path),
  );
  const modelArtifactFiles =
    parsedManifest.model.kind === "local"
      ? parsedManifest.model.artifacts.map((path) => byPath.get(path))
      : [];
  if (
    value.name !== parsedManifest.name ||
    value.entryPath !== parsedManifest.runtime.entry ||
    entry === undefined ||
    entry.digest !== value.entryFileDigest ||
    promptFiles.some((file) => file === undefined) ||
    toolSchemaFiles.some((file) => file === undefined) ||
    modelArtifactFiles.some((file) => file === undefined) ||
    !isReleaseModel(parsedManifest.model)
  ) {
    return false;
  }
  const classified = new Set([
    ...parsedManifest.components.prompts,
    ...parsedManifest.components.toolSchemas,
    ...(parsedManifest.model.kind === "local"
      ? parsedManifest.model.artifacts
      : []),
  ]);
  const harnessFiles = fileRecords.filter((file) => !classified.has(file.path));
  const manifestVersion =
    parsedManifest.schemaVersion === "agentci.release.v2" ? 2 : 1;
  const manifestDigest = digestValue({
    domain: `agentci.release-manifest.v${manifestVersion}`,
    manifest: parsedManifest,
  });
  const bundleDigest = digestValue({
    domain: "agentci.release-bundle.v1",
    files: fileRecords,
  });
  const modelDeclarationDigest = digestValue({
    domain: "agentci.model-declaration.v1",
    model: parsedManifest.model,
  });
  const promptDigest = digestValue({
    domain: "agentci.prompt-set.v1",
    files: promptFiles,
  });
  const toolSchemaDigest = digestValue({
    domain: "agentci.tool-schema-set.v1",
    files: toolSchemaFiles,
  });
  const harnessDigest = digestValue({
    domain: "agentci.harness-set.v1",
    files: harnessFiles,
  });
  const releaseDigest = digestValue({
    domain: `agentci.declared-release.v${manifestVersion}`,
    runtime: parsedManifest.runtime,
    manifestDigest,
    bundleDigest,
    modelDeclarationDigest,
    promptDigest,
    toolSchemaDigest,
    harnessDigest,
  });
  return (
    value.manifestDigest === manifestDigest &&
    value.bundleDigest === bundleDigest &&
    value.modelDeclarationDigest === modelDeclarationDigest &&
    value.promptDigest === promptDigest &&
    value.toolSchemaDigest === toolSchemaDigest &&
    value.harnessDigest === harnessDigest &&
    value.releaseDigest === releaseDigest
  );
}

function isReleaseIdentity(value: unknown): value is ReleaseIdentity {
  if (!isRecord(value)) {
    return false;
  }
  if (value.digestScope === "entry-file-only") {
    return (
      hasOnlyKeys(value, [
        "name",
        "candidatePath",
        "entryFileDigest",
        "digestScope",
      ]) &&
      typeof value.name === "string" &&
      typeof value.candidatePath === "string" &&
      isDigest(value.entryFileDigest)
    );
  }
  return isManifestReleaseIdentity(value);
}

function normalizeAdapterManifest(
  value: unknown,
): AdapterManifestSpec | undefined {
  try {
    return parseAdapterManifest(value);
  } catch {
    return undefined;
  }
}

function isManifestAdapterIdentity(
  value: Record<string, unknown>,
): boolean {
  const parsedManifest = normalizeAdapterManifest(value.manifest);
  const files = value.files;
  const execution = value.execution;
  if (
    !hasOnlyKeys(value, [
      "apiVersion",
      "id",
      "version",
      "source",
      "digestScope",
      "manifestDigest",
      "bundleDigest",
      "configurationDigest",
      "credentialDeclarationDigest",
      "contractDigest",
      "adapterDigest",
      "entryPath",
      "entryFileDigest",
      "fileCount",
      "manifest",
      "files",
      "execution",
    ]) ||
    value.apiVersion !== "agentci.adapter.v2" ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.version !== "string" ||
    value.version.length === 0 ||
    value.source !== "external-manifest" ||
    value.digestScope !== "declared-config-and-adapter-bundle-bytes" ||
    !isDigest(value.manifestDigest) ||
    !isDigest(value.bundleDigest) ||
    !isDigest(value.configurationDigest) ||
    !isDigest(value.credentialDeclarationDigest) ||
    !isDigest(value.contractDigest) ||
    !isDigest(value.adapterDigest) ||
    typeof value.entryPath !== "string" ||
    !isDigest(value.entryFileDigest) ||
    !Number.isSafeInteger(value.fileCount) ||
    (value.fileCount as number) < 1 ||
    parsedManifest === undefined ||
    digestValue(value.manifest) !== digestValue(parsedManifest) ||
    !Array.isArray(files) ||
    !isRecord(execution) ||
    !hasOnlyKeys(execution, ["nodeVersion", "platform", "architecture"]) ||
    typeof execution.nodeVersion !== "string" ||
    typeof execution.platform !== "string" ||
    typeof execution.architecture !== "string"
  ) {
    return false;
  }
  const identities = files.filter(isRecord).map((file) => ({
    path: file.path,
    digest: file.digest,
    bytes: file.bytes,
    mode: file.mode,
  }));
  if (
    identities.length !== files.length ||
    identities.length !== value.fileCount ||
    identities.some(
      (file) =>
        typeof file.path !== "string" ||
        !isSafeInventoryPath(file.path) ||
        !isDigest(file.digest) ||
        !Number.isSafeInteger(file.bytes) ||
        (file.bytes as number) < 0 ||
        !Number.isSafeInteger(file.mode) ||
        (file.mode as number) < 0 ||
        (file.mode as number) > 0o777,
    ) ||
    files.some(
      (file) =>
        isRecord(file) &&
        !hasOnlyKeys(file, ["path", "digest", "bytes", "mode"]),
    ) ||
    new Set(identities.map((file) => file.path)).size !== identities.length ||
    identities.some(
      (file, index) =>
        index > 0 &&
        typeof identities[index - 1]?.path === "string" &&
        (identities[index - 1]!.path as string) >= (file.path as string),
    )
  ) {
    return false;
  }
  const fileRecords = identities as Array<{
    path: string;
    digest: string;
    bytes: number;
    mode: number;
  }>;
  const entry = fileRecords.find(
    (file) => file.path === parsedManifest.runtime.entry,
  );
  if (
    value.id !== parsedManifest.id ||
    value.version !== parsedManifest.version ||
    value.entryPath !== parsedManifest.runtime.entry ||
    entry === undefined ||
    value.entryFileDigest !== entry.digest
  ) {
    return false;
  }
  const manifestDigest = digestValue({
    domain: "agentci.adapter-manifest.v1",
    manifest: parsedManifest,
  });
  const bundleDigest = digestValue({
    domain: "agentci.adapter-bundle.v1",
    files: fileRecords,
  });
  const configurationDigest = digestValue({
    domain: "agentci.adapter-configuration.v1",
    target: parsedManifest.target,
  });
  const credentialDeclarationDigest = digestValue({
    domain: "agentci.adapter-credentials.v1",
    credentials: parsedManifest.credentials,
  });
  const contractDigest = digestValue({
    domain: "agentci.adapter-contract.v1",
    contract: {
      id: parsedManifest.id,
      version: parsedManifest.version,
      apiVersion: parsedManifest.runtime.apiVersion,
      tools: parsedManifest.contract.tools,
    },
  });
  const adapterDigest = digestValue({
    domain: "agentci.declared-adapter.v1",
    runtime: parsedManifest.runtime,
    manifestDigest,
    bundleDigest,
    configurationDigest,
    credentialDeclarationDigest,
    contractDigest,
  });
  return (
    value.manifestDigest === manifestDigest &&
    value.bundleDigest === bundleDigest &&
    value.configurationDigest === configurationDigest &&
    value.credentialDeclarationDigest === credentialDeclarationDigest &&
    value.contractDigest === contractDigest &&
    value.adapterDigest === adapterDigest
  );
}

function isAdapterIdentity(value: unknown): value is AdapterIdentity {
  if (!isRecord(value)) {
    return false;
  }
  if (value.digestScope === "declared-config-and-adapter-bundle-bytes") {
    return isManifestAdapterIdentity(value);
  }
  return (
    hasOnlyKeys(value, [
      "apiVersion",
      "id",
      "version",
      "source",
      "modulePath",
      "moduleDigest",
      "digestScope",
    ]) &&
    value.apiVersion === "agentci.adapter.v1" &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.version === "string" &&
    value.version.length > 0 &&
    (value.source === "builtin" || value.source === "external") &&
    typeof value.modulePath === "string" &&
    isDigest(value.moduleDigest) &&
    value.digestScope === "module-entry-only"
  );
}

function isVerdict(value: unknown): value is "pass" | "block" | "indeterminate" {
  return value === "pass" || value === "block" || value === "indeterminate";
}

function isToolError(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["code", "message"]) &&
    typeof value.code === "string" &&
    value.code.length > 0 &&
    typeof value.message === "string" &&
    value.message.length > 0
  );
}

function isFault(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["tool", "onCall", "phase", "error"]) &&
    typeof value.tool === "string" &&
    Number.isSafeInteger(value.onCall) &&
    (value.onCall as number) > 0 &&
    (value.phase === "before" || value.phase === "after") &&
    isToolError(value.error)
  );
}

function isToolEvent(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return (
    hasOnlyKeys(value, [
      "sequence",
      "requestId",
      "tool",
      "arguments",
      "outcome",
      "content",
      "error",
      "fault",
      "committed",
      "beforeStateHash",
      "afterStateHash",
      "durationMs",
    ]) &&
    Number.isSafeInteger(value.sequence) &&
    (value.sequence as number) > 0 &&
    typeof value.requestId === "string" &&
    value.requestId.length > 0 &&
    typeof value.tool === "string" &&
    value.tool.length > 0 &&
    isJsonValue(value.arguments) &&
    (value.outcome === "ok" || value.outcome === "error") &&
    (value.outcome === "ok"
      ? (value.content === undefined || isJsonValue(value.content)) &&
        value.error === undefined
      : value.content === undefined && isToolError(value.error)) &&
    (value.fault === undefined || isFault(value.fault)) &&
    typeof value.committed === "boolean" &&
    isDigest(value.beforeStateHash) &&
    isDigest(value.afterStateHash) &&
    value.committed === (value.beforeStateHash !== value.afterStateHash) &&
    typeof value.durationMs === "number" &&
    Number.isFinite(value.durationMs) &&
    value.durationMs >= 0
  );
}

function isAssertionResult(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return (
    hasOnlyKeys(value, [
      "id",
      "description",
      "passed",
      "expected",
      "observed",
      "message",
    ]) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    (value.description === undefined ||
      typeof value.description === "string") &&
    typeof value.passed === "boolean" &&
    typeof value.message === "string" &&
    (value.expected === undefined || isJsonValue(value.expected)) &&
    (value.observed === undefined || isJsonValue(value.observed))
  );
}

function hasConsistentStateLineage(value: Record<string, unknown>): boolean {
  if (
    !Array.isArray(value.events) ||
    typeof value.initialStateHash !== "string" ||
    typeof value.finalStateHash !== "string"
  ) {
    return false;
  }
  const events = value.events as Array<Record<string, unknown>>;
  if (events.length === 0) {
    return value.initialStateHash === value.finalStateHash;
  }
  if (events[0]?.beforeStateHash !== value.initialStateHash) {
    return false;
  }
  for (let index = 1; index < events.length; index += 1) {
    if (events[index - 1]?.afterStateHash !== events[index]?.beforeStateHash) {
      return false;
    }
  }
  return events.at(-1)?.afterStateHash === value.finalStateHash;
}

function isScenarioResult(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return (
    hasOnlyKeys(value, [
      "scenarioId",
      "description",
      "verdict",
      "reasons",
      "initialStateHash",
      "finalStateHash",
      "output",
      "events",
      "assertions",
      "candidateDiagnostics",
      "durationMs",
    ]) &&
    typeof value.scenarioId === "string" &&
    typeof value.description === "string" &&
    isVerdict(value.verdict) &&
    Array.isArray(value.reasons) &&
    value.reasons.every((reason) => typeof reason === "string") &&
    isDigest(value.initialStateHash) &&
    isDigest(value.finalStateHash) &&
    (value.output === undefined || isJsonValue(value.output)) &&
    Array.isArray(value.events) &&
    value.events.every(
      (event, index) =>
        isToolEvent(event) &&
        (event as Record<string, unknown>).sequence === index + 1,
    ) &&
    Array.isArray(value.assertions) &&
    value.assertions.every(isAssertionResult) &&
    new Set(
      (value.assertions as Array<Record<string, unknown>>).map(
        (assertion) => assertion.id,
      ),
    ).size === value.assertions.length &&
    (value.verdict !== "pass" ||
      (value.reasons.length === 0 &&
        value.assertions.length > 0 &&
        hasConsistentStateLineage(value) &&
        value.assertions.every(
          (assertion) =>
            isRecord(assertion) && assertion.passed === true,
        ))) &&
    isRecord(value.candidateDiagnostics) &&
    hasOnlyKeys(value.candidateDiagnostics, [
      "stderrDigest",
      "stderrBytes",
      "stderrTruncated",
    ]) &&
    isDigest(value.candidateDiagnostics.stderrDigest) &&
    Number.isSafeInteger(value.candidateDiagnostics.stderrBytes) &&
    (value.candidateDiagnostics.stderrBytes as number) >= 0 &&
    typeof value.candidateDiagnostics.stderrTruncated === "boolean" &&
    value.candidateDiagnostics.stderrTruncated ===
      ((value.candidateDiagnostics.stderrBytes as number) >
        CANDIDATE_STDERR_CAPTURE_LIMIT_BYTES) &&
    typeof value.durationMs === "number" &&
    Number.isFinite(value.durationMs) &&
    value.durationMs >= 0
  );
}

function isGateDecision(
  value: unknown,
  scenarios: ScenarioResult[],
): boolean {
  if (!isRecord(value) || !isVerdict(value.verdict)) {
    return false;
  }
  const passed = scenarios.filter((scenario) => scenario.verdict === "pass").length;
  const blocked = scenarios.filter((scenario) => scenario.verdict === "block").length;
  const indeterminate = scenarios.filter(
    (scenario) => scenario.verdict === "indeterminate",
  ).length;
  const total = scenarios.length;
  const passRate = total === 0 ? 0 : passed / total;
  const expectedVerdict =
    blocked > 0 ? "block" : indeterminate > 0 ? "indeterminate" : "pass";
  return (
    hasOnlyKeys(value, [
      "verdict",
      "reasons",
      "passed",
      "blocked",
      "indeterminate",
      "total",
      "passRate",
    ]) &&
    Array.isArray(value.reasons) &&
    value.reasons.every((reason) => typeof reason === "string") &&
    value.passed === passed &&
    value.blocked === blocked &&
    value.indeterminate === indeterminate &&
    value.total === total &&
    value.passRate === passRate &&
    value.verdict === expectedVerdict
  );
}

export function isReleaseReport(value: unknown): value is ReleaseReport {
  if (!isRecord(value)) {
    return false;
  }
  const suite = value.suite;
  const release = value.release;
  const adapter = value.adapter;
  const evaluator = value.evaluator;
  const scenarios = value.scenarios;
  return (
    hasOnlyKeys(value, [
      "schemaVersion",
      "generatedAt",
      "durationMs",
      "suite",
      "release",
      "adapter",
      "evaluator",
      "scenarios",
      "decision",
      "evidenceDigest",
    ]) &&
    value.schemaVersion === "agentci.report.v3" &&
    typeof value.generatedAt === "string" &&
    !Number.isNaN(Date.parse(value.generatedAt)) &&
    typeof value.durationMs === "number" &&
    Number.isFinite(value.durationMs) &&
    value.durationMs >= 0 &&
    isRecord(suite) &&
    hasOnlyKeys(suite, ["name", "version", "path", "digest", "fixture"]) &&
    typeof suite.name === "string" &&
    typeof suite.version === "string" &&
    typeof suite.path === "string" &&
    isDigest(suite.digest) &&
    typeof suite.fixture === "string" &&
    isReleaseIdentity(release) &&
    isAdapterIdentity(adapter) &&
    isRecord(evaluator) &&
    hasOnlyKeys(evaluator, ["name", "version", "buildDigest"]) &&
    evaluator.name === "agent-ci" &&
    typeof evaluator.version === "string" &&
    isDigest(evaluator.buildDigest) &&
    Array.isArray(scenarios) &&
    scenarios.length > 0 &&
    scenarios.every(isScenarioResult) &&
    new Set(
      (scenarios as Array<Record<string, unknown>>).map(
        (scenario) => scenario.scenarioId,
      ),
    ).size === scenarios.length &&
    isGateDecision(value.decision, scenarios as ScenarioResult[]) &&
    isDigest(value.evidenceDigest)
  );
}

export async function writeTextFile(path: string, content: string): Promise<void> {
  assertSecretScanClean(
    scanTextForSecrets({ path: "evidence/output.txt", text: content }),
    "evidence publication",
  );
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

export async function writeJsonReport(
  path: string,
  report: ReleaseReport,
): Promise<void> {
  await writeTextFile(path, `${JSON.stringify(report, null, 2)}\n`);
}

export async function writeSanitizedPublicationReport(
  path: string,
  report: SanitizedPublicationReport,
): Promise<void> {
  if (!isSanitizedPublicationReport(report) || !verifyPublicationDigest(report)) {
    throw new Error("sanitized publication is invalid or its digest does not match");
  }
  await writeTextFile(path, `${JSON.stringify(report, null, 2)}\n`);
}

function verdictIcon(verdict: ScenarioResult["verdict"]): string {
  if (verdict === "pass") {
    return "PASS";
  }
  if (verdict === "block") {
    return "BLOCK";
  }
  return "INDETERMINATE";
}

function markdownText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ")
    .replace(/([\\`*_{}[\]()#+.!|\-])/g, "\\$1");
}

function markdownCode(value: string): string {
  return `\`${value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("`", "&#96;")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ")}\``;
}

export function renderMarkdownReport(report: ReleaseReport): string {
  const releaseLines =
    report.release.digestScope === "entry-file-only"
      ? [
          `Identity scope: \`entry-file-only\`  `,
          `Candidate entry-file SHA-256: ${markdownCode(report.release.entryFileDigest)}  `,
        ]
      : [
          `Identity scope: \`declared-config-and-bundle-bytes\`  `,
          `Declared release SHA-256: ${markdownCode(report.release.releaseDigest)}  `,
          `Bundle: ${report.release.fileCount} file(s), SHA-256 ${markdownCode(report.release.bundleDigest)}  `,
          `Declared model/config SHA-256: ${markdownCode(report.release.modelDeclarationDigest)}  `,
        ];
  const adapterLines =
    report.adapter.digestScope === "module-entry-only"
      ? [
          `Adapter: ${markdownCode(`${report.adapter.id}@${report.adapter.version}`)} (${markdownCode(report.adapter.moduleDigest)}, ${markdownCode(report.adapter.digestScope)})  `,
        ]
      : [
          `Adapter: ${markdownCode(`${report.adapter.id}@${report.adapter.version}`)} (${markdownCode(report.adapter.adapterDigest)}, ${markdownCode(report.adapter.digestScope)})  `,
          `Adapter bundle: ${report.adapter.fileCount} file(s), SHA-256 ${markdownCode(report.adapter.bundleDigest)}  `,
          `Adapter target/config SHA-256: ${markdownCode(report.adapter.configurationDigest)}  `,
        ];
  const lines = [
    `# OutcomeGate report: ${markdownText(report.release.name)}`,
    "",
    `**Decision: ${report.decision.verdict.toUpperCase()}**`,
    "",
    `Suite: ${markdownCode(`${report.suite.name}@${report.suite.version}`)}  `,
    ...releaseLines,
    ...adapterLines,
    `Evaluator: ${markdownCode(`${report.evaluator.name}@${report.evaluator.version}`)} (${markdownCode(report.evaluator.buildDigest)})  `,
    `Evidence SHA-256: ${markdownCode(report.evidenceDigest)}`,
    "",
    "| Scenario | Verdict | Assertions | Tool calls |",
    "|---|---:|---:|---:|",
  ];

  for (const scenario of report.scenarios) {
    const assertionPasses = scenario.assertions.filter(
      (assertion) => assertion.passed,
    ).length;
    lines.push(
      `| ${markdownText(scenario.scenarioId)} | ${verdictIcon(scenario.verdict)} | ${assertionPasses}/${scenario.assertions.length} | ${scenario.events.length} |`,
    );
  }

  for (const scenario of report.scenarios.filter(
    (candidate) => candidate.verdict !== "pass",
  )) {
    lines.push(
      "",
      `## ${markdownText(scenario.scenarioId)}: ${verdictIcon(scenario.verdict)}`,
      "",
    );
    for (const reason of scenario.reasons) {
      lines.push(`- ${markdownText(reason)}`);
    }
    for (const assertion of scenario.assertions.filter(
      (candidate) => !candidate.passed,
    )) {
      lines.push(
        `- Assertion ${markdownCode(assertion.id)}: ${markdownText(assertion.message)}`,
      );
    }
  }

  lines.push(
    "",
    "> This report evaluates only the declared suite, captured release bytes, declared adapter bytes/configuration, and observed adapter state. It does not establish remote-system fidelity, guarantee remote cancellation or rollback, or certify production safety.",
    "",
  );
  return lines.join("\n");
}

export function renderSanitizedPublicationMarkdown(
  report: SanitizedPublicationReport,
): string {
  if (!isSanitizedPublicationReport(report) || !verifyPublicationDigest(report)) {
    throw new Error("sanitized publication is invalid or its digest does not match");
  }
  const releaseDigest =
    report.release.digestScope === "entry-file-only"
      ? report.release.entryFileDigest
      : report.release.releaseDigest;
  const adapterDigest =
    report.adapter.digestScope === "module-entry-only"
      ? report.adapter.moduleDigest
      : report.adapter.adapterDigest;
  const lines = [
    "# OutcomeGate sanitized report",
    "",
    `**Decision: ${report.decision.verdict.toUpperCase()}**`,
    "",
    `Profile: \`sanitized\`  `,
    `Suite identity: ${markdownCode(report.suite.digest)}  `,
    `Release identity: ${markdownCode(releaseDigest)}  `,
    `Adapter identity: ${markdownCode(adapterDigest)}  `,
    `Evaluator: ${markdownCode(`${report.evaluator.name}@${report.evaluator.version}`)} (${markdownCode(report.evaluator.buildDigest)})  `,
    `Source evidence SHA-256: ${markdownCode(report.sourceEvidenceDigest)}  `,
    `Publication SHA-256: ${markdownCode(report.publicationDigest)}`,
    "",
    "| Scenario | Verdict | Assertions | Tool calls |",
    "|---|---:|---:|---:|",
  ];
  for (const scenario of report.scenarios) {
    lines.push(
      `| ${scenario.scenario} | ${verdictIcon(scenario.verdict)} | ${scenario.assertionsPassed}/${scenario.assertionsTotal} | ${scenario.toolCallCount} |`,
    );
  }
  lines.push(
    "",
    `> This sanitized publication omits logical identifiers, timestamps/durations, scenario descriptions, tasks, state, tool arguments/results, outputs, assertion details, reasons, manifests, file inventories, local paths, and candidate-stderr digests. Full evidence was not published. Recommended retention is ${report.publication.recommendedRetentionDays} days; the caller must configure and enforce deletion for every retained copy, including artifacts and job summaries.`,
    "",
  );
  return lines.join("\n");
}

export function renderSanitizedConsoleSummary(
  report: SanitizedPublicationReport,
): string {
  if (!isSanitizedPublicationReport(report) || !verifyPublicationDigest(report)) {
    throw new Error("sanitized publication is invalid or its digest does not match");
  }
  return [
    `${report.decision.verdict.toUpperCase()} sanitized OutcomeGate publication`,
    ...report.scenarios.map(
      (scenario) =>
        `${scenario.verdict.toUpperCase().padEnd(13)} scenario ${scenario.scenario} (${scenario.assertionsPassed}/${scenario.assertionsTotal} assertions)`,
    ),
    `source evidence ${report.sourceEvidenceDigest}`,
    `publication ${report.publicationDigest}`,
  ].join("\n");
}

export function renderConsoleSummary(report: ReleaseReport): string {
  const rows = report.scenarios.map(
    (scenario) =>
      `${scenario.verdict.toUpperCase().padEnd(13)} ${scenario.scenarioId} (${scenario.assertions.filter((assertion) => assertion.passed).length}/${scenario.assertions.length} assertions)`,
  );
  return [
    `${report.decision.verdict.toUpperCase()} ${report.release.name} against ${report.suite.name}@${report.suite.version}`,
    ...rows,
    `evidence ${report.evidenceDigest}`,
  ].join("\n");
}
