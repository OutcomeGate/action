import { access, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import {
  prepareManifestAdapter,
  resolveAdapter,
  runAdapterConformance,
  validateSuiteAgainstAdapter,
} from "./adapter.js";
import {
  digestFile,
  digestNamedFiles,
  digestValue,
  isJsonValue,
  cloneJson,
} from "./canonical.js";
import { evaluateAssertions } from "./assertions.js";
import { runCandidateProcess } from "./driver/process.js";
import {
  AdapterValidationError,
  ReleaseValidationError,
  SuiteValidationError,
} from "./errors.js";
import { decideGate } from "./gate.js";
import {
  cleanupMaterializedRelease,
  loadReleaseManifest,
  materializeRelease,
  verifyMaterializedRelease,
} from "./release.js";
import {
  computeEvidenceDigest,
  createSanitizedPublicationReport,
} from "./report.js";
import { authorizeCandidateEnvironment } from "./candidate-credential-policy.js";
import {
  assertNoKnownSecretLeaksAtJsonBoundary,
  knownSecretsFromCredentialEnv,
  type KnownSecret,
} from "./credential-policy.js";
import { loadSuite } from "./suite.js";
import { parseStrictJson } from "./strict-json.js";
import type {
  AdapterRuntime,
  CandidateDiagnostics,
  EntryFileReleaseIdentity,
  Environment,
  JsonValue,
  ReleaseIdentity,
  ReleaseReport,
  SanitizedPublicationReport,
  ScenarioResult,
  ScenarioSpec,
} from "./types.js";
import type { ReleaseCapture } from "./release.js";

const EVALUATOR_VERSION = "0.3.0";
const ADAPTER_CLEANUP_TIMEOUT_MS = 11_000;
const EMPTY_STDERR_DIGEST =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function emptyCandidateDiagnostics(): CandidateDiagnostics {
  return {
    stderrDigest: EMPTY_STDERR_DIGEST,
    stderrBytes: 0,
    stderrTruncated: false,
  };
}

async function withDeadline<T>(
  operation: Promise<T> | T,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve(operation),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function collectRuntimeJavaScript(
  root: string,
  directory = root,
): Promise<Array<{ name: string; path: string }>> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  const files: Array<{ name: string; path: string }> = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectRuntimeJavaScript(root, path)));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push({ name: relative(root, path).split(sep).join("/"), path });
    }
  }
  return files;
}

async function evaluatorBuildDigest(): Promise<string> {
  const root = dirname(fileURLToPath(import.meta.url));
  return digestNamedFiles(await collectRuntimeJavaScript(root));
}

function indeterminateScenario(
  scenario: ScenarioSpec,
  message: string,
  initialStateHash: string,
  durationMs: number,
): ScenarioResult {
  return {
    scenarioId: scenario.id,
    description: scenario.description,
    verdict: "indeterminate",
    reasons: [message],
    initialStateHash,
    finalStateHash: initialStateHash,
    events: [],
    assertions: [],
    candidateDiagnostics: emptyCandidateDiagnostics(),
    durationMs,
  };
}

async function closeEnvironment(
  environment: Environment,
): Promise<string | undefined> {
  if (environment.close === undefined) {
    return undefined;
  }
  try {
    await withDeadline(
      environment.close(),
      ADAPTER_CLEANUP_TIMEOUT_MS,
      "adapter environment cleanup",
    );
    return undefined;
  } catch (error) {
    return `adapter environment cleanup failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

async function runScenario(options: {
  scenario: ScenarioSpec;
  candidatePath: string;
  adapter: AdapterRuntime;
  candidateEnvironment: Readonly<Record<string, string>>;
  candidateCredentialNames: readonly string[];
  knownExecutionSecrets: readonly KnownSecret[];
  knownAdapterSecrets: readonly KnownSecret[];
}): Promise<ScenarioResult> {
  const startedAt = Date.now();
  const deadlineAt = performance.now() + options.scenario.timeoutMs;
  const remainingMs = (): number =>
    Math.max(0, Math.ceil(deadlineAt - performance.now()));
  const declaredInitialState = cloneJson(options.scenario.initialState);
  const initialStateHash = digestValue(declaredInitialState);
  const knownCandidateSecrets = knownSecretsFromCredentialEnv(
    Object.freeze(
      Object.fromEntries(
        options.candidateCredentialNames.map((name) => [
          name,
          options.candidateEnvironment[name]!,
        ]),
      ),
    ),
  );
  let environment;
  try {
    const creationTimeoutMs = Math.max(1, Math.min(remainingMs(), 5_000));
    const creation = options.adapter.createEnvironment(
      cloneJson(declaredInitialState),
      {
        scenarioId: options.scenario.id,
        timeoutMs: creationTimeoutMs,
      },
    );
    // Manifest-backed v2 creation owns its host deadlines and completes cleanup
    // before rejection. An outer Promise.race would abandon that cleanup and can
    // leak a host that becomes active after the caller has moved on.
    environment =
      options.adapter.apiVersion === "agentci.adapter.v2"
        ? await creation
        : await withDeadline(
            creation,
            creationTimeoutMs,
            "adapter environment creation",
          );
  } catch (error) {
    return indeterminateScenario(
      options.scenario,
      `fixture initialization failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      initialStateHash,
      Date.now() - startedAt,
    );
  }

  if (remainingMs() === 0) {
    const closeIssue = await closeEnvironment(environment);
    return indeterminateScenario(
      options.scenario,
      [
        "adapter environment creation exhausted the scenario deadline",
        ...(closeIssue !== undefined ? [closeIssue] : []),
      ].join("; "),
      initialStateHash,
      Date.now() - startedAt,
    );
  }

  try {
    const observedInitialState = await withDeadline(
      environment.snapshot(),
      Math.max(1, Math.min(remainingMs(), 5_000)),
      "adapter initial snapshot",
    );
    if (!isJsonValue(observedInitialState)) {
      throw new Error("adapter returned a non-JSON initial state");
    }
    try {
      assertNoKnownSecretLeaksAtJsonBoundary(
        observedInitialState,
        knownCandidateSecrets,
      );
    } catch {
      throw new Error(
        "adapter initial state crossed the candidate credential boundary",
      );
    }
    if (digestValue(observedInitialState) !== initialStateHash) {
      throw new Error("adapter environment did not preserve the declared initial state");
    }
  } catch (error) {
    const closeIssue = await closeEnvironment(environment);
    return indeterminateScenario(
      options.scenario,
      [
        `initial state verification failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        ...(closeIssue !== undefined ? [closeIssue] : []),
      ].join("; "),
      initialStateHash,
      Date.now() - startedAt,
    );
  }

  if (
    !Array.isArray(environment.tools) ||
    !environment.tools.every(
      (tool): tool is string => typeof tool === "string" && tool.length > 0,
    ) ||
    digestValue(environment.tools) !== digestValue(options.adapter.tools)
  ) {
    const closeIssue = await closeEnvironment(environment);
    return indeterminateScenario(
      options.scenario,
      [
        "adapter environment tools differ from its declared tool list",
        ...(closeIssue !== undefined ? [closeIssue] : []),
      ].join("; "),
      initialStateHash,
      Date.now() - startedAt,
    );
  }

  if (remainingMs() === 0) {
    const closeIssue = await closeEnvironment(environment);
    return indeterminateScenario(
      options.scenario,
      [
        "adapter setup exhausted the scenario deadline before candidate execution",
        ...(closeIssue !== undefined ? [closeIssue] : []),
      ].join("; "),
      initialStateHash,
      Date.now() - startedAt,
    );
  }

  let driver;
  try {
    driver = await runCandidateProcess({
      candidatePath: options.candidatePath,
      scenario: options.scenario,
      environment,
      candidateEnvironment: options.candidateEnvironment,
      candidateCredentialNames: options.candidateCredentialNames,
      knownExecutionSecrets: options.knownExecutionSecrets,
      protectedSecrets: options.knownAdapterSecrets,
      timeoutMs: Math.max(1, remainingMs()),
    });
  } catch (error) {
    const closeIssue = await closeEnvironment(environment);
    return indeterminateScenario(
      options.scenario,
      [
        `candidate driver failed unexpectedly: ${
          error instanceof Error ? error.message : String(error)
        }`,
        ...(closeIssue !== undefined ? [closeIssue] : []),
      ].join("; "),
      initialStateHash,
      Date.now() - startedAt,
    );
  }
  let finalState;
  let finalStateHash: string;
  try {
    finalState = await withDeadline(
      environment.snapshot(),
      Math.max(1, Math.min(remainingMs(), 5_000)),
      "adapter final snapshot",
    );
    if (!isJsonValue(finalState)) {
      throw new Error("adapter returned a non-JSON final state");
    }
    try {
      assertNoKnownSecretLeaksAtJsonBoundary(
        finalState,
        knownCandidateSecrets,
      );
    } catch {
      throw new Error(
        "adapter final state crossed the candidate credential boundary",
      );
    }
    finalStateHash = digestValue(finalState);
  } catch (error) {
    const closeIssue = await closeEnvironment(environment);
    return {
      scenarioId: options.scenario.id,
      description: options.scenario.description,
      verdict: driver.verdict === "block" ? "block" : "indeterminate",
      reasons: [
        ...driver.reasons,
        `final state snapshot failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        ...(closeIssue !== undefined ? [closeIssue] : []),
      ],
      initialStateHash,
      finalStateHash: initialStateHash,
      ...(driver.output !== undefined ? { output: driver.output } : {}),
      events: driver.events,
      assertions: [],
      candidateDiagnostics: driver.candidateDiagnostics,
      durationMs: Date.now() - startedAt,
    };
  }

  let assertions;
  const stateLineageIssue = (() => {
    if (driver.events.length === 0) {
      return finalStateHash === initialStateHash
        ? undefined
        : "adapter state changed outside a recorded candidate transition";
    }
    if (driver.events[0]?.beforeStateHash !== initialStateHash) {
      return "first candidate transition did not begin at the verified initial state";
    }
    for (let index = 1; index < driver.events.length; index += 1) {
      if (
        driver.events[index - 1]?.afterStateHash !==
        driver.events[index]?.beforeStateHash
      ) {
        return "adapter state changed between recorded candidate transitions";
      }
    }
    return driver.events.at(-1)?.afterStateHash === finalStateHash
      ? undefined
      : "final adapter state differs from the last recorded candidate transition";
  })();
  if (stateLineageIssue !== undefined) {
    const closeIssue = await closeEnvironment(environment);
    return {
      scenarioId: options.scenario.id,
      description: options.scenario.description,
      verdict: driver.verdict === "block" ? "block" : "indeterminate",
      reasons: [
        ...driver.reasons,
        stateLineageIssue,
        ...(closeIssue !== undefined ? [closeIssue] : []),
      ],
      initialStateHash,
      finalStateHash,
      ...(driver.output !== undefined ? { output: driver.output } : {}),
      events: driver.events,
      assertions: [],
      candidateDiagnostics: driver.candidateDiagnostics,
      durationMs: Date.now() - startedAt,
    };
  }
  try {
    assertions = evaluateAssertions(options.scenario.assertions, {
      state: finalState,
      ...(driver.output !== undefined ? { output: driver.output } : {}),
      events: driver.events,
    });
  } catch (error) {
    const closeIssue = await closeEnvironment(environment);
    return {
      scenarioId: options.scenario.id,
      description: options.scenario.description,
      verdict: driver.verdict === "block" ? "block" : "indeterminate",
      reasons: [
        ...driver.reasons,
        `oracle failed: ${error instanceof Error ? error.message : String(error)}`,
        ...(closeIssue !== undefined ? [closeIssue] : []),
      ],
      initialStateHash,
      finalStateHash,
      ...(driver.output !== undefined ? { output: driver.output } : {}),
      events: driver.events,
      assertions: [],
      candidateDiagnostics: driver.candidateDiagnostics,
      durationMs: Date.now() - startedAt,
    };
  }

  const failedAssertions = assertions.filter((assertion) => !assertion.passed);
  const reasons = [...driver.reasons];
  if (failedAssertions.length > 0) {
    reasons.push(
      `${failedAssertions.length} assertion(s) failed: ${failedAssertions.map((assertion) => assertion.id).join(", ")}`,
    );
  }
  const closeIssue = await closeEnvironment(environment);
  if (closeIssue !== undefined) {
    reasons.push(closeIssue);
  }
  // Assertions observed after an evaluator/environment integrity failure are
  // not independent evidence of a candidate defect. Preserve indeterminate
  // unless the driver had already established a candidate block.
  const verdict =
    driver.verdict === "block"
      ? "block"
      : driver.verdict === "indeterminate" || closeIssue !== undefined
        ? "indeterminate"
        : failedAssertions.length > 0
          ? "block"
          : "pass";

  return {
    scenarioId: options.scenario.id,
    description: options.scenario.description,
    verdict,
    reasons,
    initialStateHash,
    finalStateHash,
    ...(driver.output !== undefined ? { output: driver.output } : {}),
    events: driver.events,
    assertions,
    candidateDiagnostics: driver.candidateDiagnostics,
    durationMs: Date.now() - startedAt,
  };
}

interface RunSuiteBaseOptions {
  suitePath: string;
  adapterPath?: string;
  adapterManifestPath?: string;
  callerAllowlist?: readonly string[];
  approvedAdapterDigest?: string;
  adapterSourceEnv?: Readonly<Record<string, string | undefined>>;
  candidateCallerAllowlist?: readonly string[];
  approvedReleaseDigest?: string;
  candidateSourceEnv?: Readonly<Record<string, string | undefined>>;
  candidateRuntimeEnvironment?: Readonly<Record<string, string>>;
  requireExplicitCandidatePolicy?: boolean;
  generatedAt?: string;
}

export type RunSuiteOptions = RunSuiteBaseOptions &
  (
    | {
        releaseManifestPath: string;
        candidatePath?: never;
        releaseName?: never;
      }
    | {
        releaseManifestPath?: never;
        candidatePath: string;
        releaseName: string;
      }
  );

async function resolveRelease(
  options: RunSuiteOptions,
): Promise<{ identity: ReleaseIdentity; capture?: ReleaseCapture }> {
  if (options.releaseManifestPath !== undefined) {
    const capture = await loadReleaseManifest(options.releaseManifestPath);
    return { identity: capture.identity, capture };
  }
  const candidatePath = resolve(options.candidatePath);
  await access(candidatePath);
  const entryFileDigest = await digestFile(candidatePath);
  const identity: EntryFileReleaseIdentity = {
    name: options.releaseName,
    candidatePath,
    entryFileDigest,
    digestScope: "entry-file-only",
  };
  return { identity };
}

async function verifyLegacyReleaseIdentity(
  identity: EntryFileReleaseIdentity,
): Promise<string[]> {
  try {
    return (await digestFile(identity.candidatePath)) === identity.entryFileDigest
      ? []
      : ["candidate entry file changed while the suite was running"];
  } catch (error) {
    return [
      `candidate entry file could not be re-verified: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ];
  }
}

function capturedFilesContainKnownSecrets(
  files: Readonly<ReleaseCapture["files"]>,
  secrets: ReturnType<typeof knownSecretsFromCredentialEnv>,
): boolean {
  if (secrets.length === 0) {
    return false;
  }
  const secretBytes = secrets.map((secret) => Buffer.from(secret.value, "utf8"));
  for (const file of files) {
    if (
      secrets.some((secret) => file.path.includes(secret.value)) ||
      secretBytes.some(
        (secret) => Buffer.from(file.content).indexOf(secret) !== -1,
      )
    ) {
      return true;
    }
    let parsed: unknown;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(file.content);
      parsed = parseStrictJson(text);
    } catch {
      continue;
    }
    const normalized = JSON.stringify(parsed);
    if (normalized === undefined) {
      continue;
    }
    try {
      const normalizedValue = parseStrictJson(normalized);
      if (!isJsonValue(normalizedValue)) {
        return true;
      }
      assertNoKnownSecretLeaksAtJsonBoundary(normalizedValue, secrets);
    } catch {
      return true;
    }
  }
  return false;
}

async function executeSuite(
  options: RunSuiteOptions,
  includeSanitizedPublication: boolean,
): Promise<{
  report: ReleaseReport;
  publication?: SanitizedPublicationReport;
  assertNoExecutionSecretLeaks?: (value: JsonValue) => void;
}> {
  const startedAt = Date.now();
  const loaded = await loadSuite(options.suitePath);
  const resolvedRelease = await resolveRelease(options);
  const release = resolvedRelease.identity;
  if (
    resolvedRelease.capture === undefined &&
    (options.candidateCallerAllowlist !== undefined ||
      options.approvedReleaseDigest !== undefined ||
      options.candidateSourceEnv !== undefined ||
      options.requireExplicitCandidatePolicy === true)
  ) {
    throw new ReleaseValidationError([
      "candidate credential policy requires a declared release manifest",
    ]);
  }
  if (
    options.requireExplicitCandidatePolicy === true &&
    resolvedRelease.capture?.manifest.schemaVersion !== "agentci.release.v2"
  ) {
    throw new ReleaseValidationError([
      "release evaluation requires agentci.release.v2 with an explicit candidate credential policy",
    ]);
  }
  const candidateCredentialPolicy =
    resolvedRelease.capture?.manifest.schemaVersion === "agentci.release.v2"
      ? resolvedRelease.capture.manifest.candidate.credentials
      : { kind: "none" as const };
  if (
    candidateCredentialPolicy.kind === "environment" &&
    options.adapterManifestPath === undefined
  ) {
    throw new ReleaseValidationError([
      "candidate credentials require a manifest-backed API-v2 adapter boundary",
    ]);
  }
  const manifestPreparation =
    options.adapterManifestPath !== undefined
      ? await prepareManifestAdapter({
          manifestPath: options.adapterManifestPath,
          ...(options.callerAllowlist !== undefined
            ? { callerAllowlist: options.callerAllowlist }
            : {}),
          ...(options.approvedAdapterDigest !== undefined
            ? { approvedAdapterDigest: options.approvedAdapterDigest }
            : {}),
          ...(options.adapterSourceEnv !== undefined
            ? { sourceEnv: options.adapterSourceEnv }
            : {}),
        })
      : undefined;
  const candidateEnvironment = authorizeCandidateEnvironment({
    credentialPolicy: candidateCredentialPolicy,
    callerAllowlist: options.candidateCallerAllowlist ?? [],
    sourceEnv: options.candidateSourceEnv ?? {},
    ...(resolvedRelease.capture !== undefined
      ? { capturedReleaseDigest: resolvedRelease.capture.identity.releaseDigest }
      : {}),
    ...(options.approvedReleaseDigest !== undefined
      ? { approvedReleaseDigest: options.approvedReleaseDigest }
      : {}),
    adapterCredentials:
      manifestPreparation === undefined
        ? { declaredEnvNames: [], environment: {} }
        : {
            declaredEnvNames:
              manifestPreparation.capture.manifest.credentials.environment,
            environment: manifestPreparation.credentials,
          },
    nonSecretRuntimeEnvironment: options.candidateRuntimeEnvironment ?? {},
  });
  const candidateCredentialNames =
    candidateCredentialPolicy.kind === "environment"
      ? candidateCredentialPolicy.environment
      : [];
  const candidateCredentialEnvironment = Object.freeze(
    Object.fromEntries(
      candidateCredentialNames.map((name) => [name, candidateEnvironment[name]!]),
    ),
  );
  const knownCandidateSecrets = knownSecretsFromCredentialEnv(
    candidateCredentialEnvironment,
  );
  const knownAdapterSecrets = knownSecretsFromCredentialEnv(
    manifestPreparation?.credentials ?? {},
  );
  const knownExecutionSecrets = [
    ...knownCandidateSecrets,
    ...knownAdapterSecrets,
  ];
  const assertNoExecutionSecretLeaks = (value: JsonValue): void => {
    try {
      assertNoKnownSecretLeaksAtJsonBoundary(value, knownExecutionSecrets);
    } catch {
      throw new ReleaseValidationError([
        "rendered evidence contains authorized credential material",
      ]);
    }
  };
  try {
    assertNoKnownSecretLeaksAtJsonBoundary(
      loaded.suite as unknown as JsonValue,
      knownExecutionSecrets,
    );
    if (resolvedRelease.capture !== undefined) {
      assertNoKnownSecretLeaksAtJsonBoundary(
        resolvedRelease.capture.manifest as unknown as JsonValue,
        knownExecutionSecrets,
      );
    }
  } catch {
    throw new ReleaseValidationError([
      "declared suite or release manifest contains authorized credential material",
    ]);
  }
  if (
    resolvedRelease.capture !== undefined &&
    capturedFilesContainKnownSecrets(
      resolvedRelease.capture.files,
      knownExecutionSecrets,
    )
  ) {
      throw new ReleaseValidationError([
        "declared release bundle contains authorized credential material",
      ]);
  }
  const adapter = await resolveAdapter({
    fixture: loaded.suite.fixture,
    ...(options.adapterPath !== undefined
      ? { adapterPath: options.adapterPath }
      : {}),
    ...(options.adapterManifestPath !== undefined
      ? { adapterManifestPath: options.adapterManifestPath }
      : {}),
    ...(options.callerAllowlist !== undefined
      ? { callerAllowlist: options.callerAllowlist }
      : {}),
    ...(options.approvedAdapterDigest !== undefined
      ? { approvedAdapterDigest: options.approvedAdapterDigest }
      : {}),
    ...(options.adapterSourceEnv !== undefined
      ? { sourceEnv: options.adapterSourceEnv }
      : {}),
    ...(manifestPreparation !== undefined
      ? { manifestPreparation }
      : {}),
    ...(candidateCredentialPolicy.kind === "environment"
      ? { candidateCredentialEnvironment }
      : {}),
  });
  const adapterIssues = await validateSuiteAgainstAdapter(
    loaded.suite,
    adapter.definition,
  );
  const validationCleanupIssues = await adapter.closeValidationHost();
  if (adapterIssues.length > 0) {
    throw new SuiteValidationError([
      ...adapterIssues,
      ...validationCleanupIssues,
    ]);
  }
  if (validationCleanupIssues.length > 0) {
    throw new AdapterValidationError(validationCleanupIssues);
  }
  if (adapter.identity.source === "builtin") {
    const conformanceIssues = await runAdapterConformance(adapter.definition);
    if (conformanceIssues.length > 0) {
      throw new AdapterValidationError(conformanceIssues);
    }
  }
  const suiteDigest = digestValue(loaded.suite);
  const buildDigest = await evaluatorBuildDigest();
  const scenarios: ScenarioResult[] = [];

  for (const scenario of loaded.suite.scenarios) {
    let materialized:
      | Awaited<ReturnType<typeof materializeRelease>>
      | undefined;
    let result = indeterminateScenario(
      scenario,
      "scenario did not start",
      digestValue(scenario.initialState),
      0,
    );
    let canRun = true;
    if (resolvedRelease.capture !== undefined) {
      try {
        materialized = await materializeRelease(resolvedRelease.capture);
      } catch (error) {
        canRun = false;
        result = indeterminateScenario(
          scenario,
          `release materialization failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          digestValue(scenario.initialState),
          0,
        );
      }
    }
    if (canRun) {
      try {
        result = await runScenario({
          scenario,
          candidatePath: materialized?.candidatePath ?? release.candidatePath,
          adapter: adapter.definition,
          candidateEnvironment,
          candidateCredentialNames,
          knownExecutionSecrets,
          knownAdapterSecrets,
        });
      } catch (error) {
        result = indeterminateScenario(
          scenario,
          `scenario evaluation failed unexpectedly: ${
            error instanceof Error ? error.message : String(error)
          }`,
          digestValue(scenario.initialState),
          0,
        );
      }
    }
    const identityIssues = [...(await adapter.verifyIdentity())];
    if (resolvedRelease.capture !== undefined && materialized !== undefined) {
      identityIssues.push(
        ...(await verifyMaterializedRelease(
          materialized,
          resolvedRelease.capture,
        )),
      );
      try {
        await cleanupMaterializedRelease(materialized);
      } catch (error) {
        identityIssues.push(
          `materialized release cleanup failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    } else if (release.digestScope === "entry-file-only") {
      identityIssues.push(...(await verifyLegacyReleaseIdentity(release)));
    }
    if (identityIssues.length > 0) {
      result = {
        ...result,
        verdict: result.verdict === "block" ? "block" : "indeterminate",
        reasons: [...result.reasons, ...identityIssues],
      };
    }
    scenarios.push(result);
  }

  const decision = decideGate(scenarios, loaded.suite.gate);
  const reportWithoutDigest: Omit<ReleaseReport, "evidenceDigest"> = {
    schemaVersion: "agentci.report.v3",
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    suite: {
      name: loaded.suite.name,
      version: loaded.suite.version,
      path: loaded.path,
      digest: suiteDigest,
      fixture: loaded.suite.fixture,
    },
    release,
    adapter: adapter.identity,
    evaluator: {
      name: "agent-ci",
      version: EVALUATOR_VERSION,
      buildDigest,
    },
    scenarios,
    decision,
  };

  const report: ReleaseReport = {
    ...reportWithoutDigest,
    evidenceDigest: computeEvidenceDigest(reportWithoutDigest),
  };
  try {
    assertNoKnownSecretLeaksAtJsonBoundary(
      report as unknown as JsonValue,
      knownExecutionSecrets,
    );
  } catch {
    throw new ReleaseValidationError([
      "canonical evidence contains authorized credential material",
    ]);
  }
  if (!includeSanitizedPublication) {
    return { report, assertNoExecutionSecretLeaks };
  }
  const publication = createSanitizedPublicationReport(report);
  try {
    assertNoKnownSecretLeaksAtJsonBoundary(
      publication as unknown as JsonValue,
      knownExecutionSecrets,
    );
  } catch {
    throw new ReleaseValidationError([
      "sanitized publication contains authorized credential material",
    ]);
  }
  return { report, publication, assertNoExecutionSecretLeaks };
}

export async function runSuite(options: RunSuiteOptions): Promise<ReleaseReport> {
  return (await executeSuite(options, false)).report;
}

export async function runSuiteWithEvidenceGuard(
  options: RunSuiteOptions,
): Promise<{
  report: ReleaseReport;
  assertNoExecutionSecretLeaks: (value: JsonValue) => void;
}> {
  const result = await executeSuite(options, false);
  if (result.assertNoExecutionSecretLeaks === undefined) {
    throw new ReleaseValidationError(["evidence guard was not constructed"]);
  }
  return {
    report: result.report,
    assertNoExecutionSecretLeaks: result.assertNoExecutionSecretLeaks,
  };
}

export async function runSuiteWithSanitizedPublication(
  options: RunSuiteOptions,
): Promise<{
  report: ReleaseReport;
  publication: SanitizedPublicationReport;
  assertNoExecutionSecretLeaks: (value: JsonValue) => void;
}> {
  const result = await executeSuite(options, true);
  if (
    result.publication === undefined ||
    result.assertNoExecutionSecretLeaks === undefined
  ) {
    throw new ReleaseValidationError([
      "sanitized publication was not constructed",
    ]);
  }
  return {
    report: result.report,
    publication: result.publication,
    assertNoExecutionSecretLeaks: result.assertNoExecutionSecretLeaks,
  };
}
