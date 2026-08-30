import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL, fileURLToPath } from "node:url";

import {
  cleanupMaterializedAdapter,
  loadAdapterManifest,
  materializeAdapter,
  verifyMaterializedAdapter,
  type AdapterManifestCapture,
  type MaterializedAdapter,
} from "./adapter-manifest.js";
import {
  spawnAdapterHost,
  type AdapterHostClient,
} from "./adapter-host/client.js";
import type {
  AdapterDescriptorV2,
  ProtocolJsonValue,
} from "./adapter-host/protocol.js";
import {
  cloneJson,
  digestFile,
  digestValue,
  isJsonValue,
} from "./canonical.js";
import {
  assertNoKnownSecretLeaksAtJsonBoundary,
  authorizeAdapterCredentials,
  knownSecretsFromCredentialEnv,
  type KnownSecret,
} from "./credential-policy.js";
import { parseStrictJson } from "./strict-json.js";
import {
  AdapterValidationError,
  FixtureError,
  ToolCallError,
} from "./errors.js";
import { refundsAdapter } from "./fixtures/refunds.js";
import type {
  AdapterDefinition,
  AdapterIdentity,
  AdapterPointerValidationRequest,
  AdapterRuntime,
  Environment,
  EnvironmentTransitionRequest,
  JsonValue,
  LegacyAdapterIdentity,
  LoadedAdapter,
  ManifestAdapterIdentity,
  SuiteSpec,
} from "./types.js";

const LEGACY_ADAPTER_OPERATION_TIMEOUT_MS = 5_000;

async function withAdapterDeadline<T>(
  operation: Promise<T> | T,
  label: string,
  timeoutMs = LEGACY_ADAPTER_OPERATION_TIMEOUT_MS,
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function definitionIssues(value: unknown): string[] {
  if (!isRecord(value)) {
    return ["adapter export must be an object"];
  }
  const issues: string[] = [];
  if (value.apiVersion !== "agentci.adapter.v1") {
    issues.push("apiVersion must be 'agentci.adapter.v1'");
  }
  if (typeof value.id !== "string" || value.id.length === 0) {
    issues.push("id must be a non-empty string");
  }
  if (typeof value.version !== "string" || value.version.length === 0) {
    issues.push("version must be a non-empty string");
  }
  if (
    !Array.isArray(value.tools) ||
    value.tools.length === 0 ||
    !value.tools.every((tool) => typeof tool === "string" && tool.length > 0)
  ) {
    issues.push("tools must be a non-empty array of tool names");
  } else if (new Set(value.tools).size !== value.tools.length) {
    issues.push("tool names must be unique");
  }
  if (!Array.isArray(value.conformance) || value.conformance.length === 0) {
    issues.push("conformance must contain at least one deterministic case");
  } else {
    value.conformance.forEach((candidate, index) => {
      const prefix = `conformance[${index}]`;
      if (!isRecord(candidate)) {
        issues.push(`${prefix} must be an object`);
        return;
      }
      if (typeof candidate.name !== "string" || candidate.name.length === 0) {
        issues.push(`${prefix}.name must be a non-empty string`);
      }
      if (!isJsonValue(candidate.initialState)) {
        issues.push(`${prefix}.initialState must be JSON`);
      }
      if (
        !isRecord(candidate.call) ||
        typeof candidate.call.tool !== "string" ||
        candidate.call.tool.length === 0 ||
        !isJsonValue(candidate.call.arguments)
      ) {
        issues.push(`${prefix}.call must declare a tool and JSON arguments`);
      }
      if (!isJsonValue(candidate.expectedResult)) {
        issues.push(`${prefix}.expectedResult must be JSON`);
      }
      if (!isJsonValue(candidate.expectedFinalState)) {
        issues.push(`${prefix}.expectedFinalState must be JSON`);
      }
    });
  }
  if (typeof value.validateSuite !== "function") {
    issues.push("validateSuite must be a function");
  }
  if (typeof value.validateStatePointer !== "function") {
    issues.push("validateStatePointer must be a function");
  }
  if (typeof value.createEnvironment !== "function") {
    issues.push("createEnvironment must be a function");
  }
  return issues;
}

export function assertAdapterDefinition(value: unknown): AdapterDefinition {
  const issues = definitionIssues(value);
  if (issues.length > 0) {
    throw new AdapterValidationError(issues);
  }
  return value as AdapterDefinition;
}

export function defineAdapter<T extends AdapterDefinition>(definition: T): T {
  assertAdapterDefinition(definition);
  return definition;
}

function legacyAdapterIdentity(options: {
  definition: AdapterDefinition;
  source: LegacyAdapterIdentity["source"];
  modulePath: string;
  moduleDigest: string;
}): LegacyAdapterIdentity {
  return {
    apiVersion: "agentci.adapter.v1",
    id: options.definition.id,
    version: options.definition.version,
    source: options.source,
    modulePath: options.modulePath,
    moduleDigest: options.moduleDigest,
    digestScope: "module-entry-only",
  };
}

function legacyLoadedAdapter(
  definition: AdapterDefinition,
  identity: LegacyAdapterIdentity,
): LoadedAdapter {
  return {
    definition,
    identity,
    credentialBoundary: {
      declaredEnvNames: Object.freeze([]),
      environment: Object.freeze({}),
    },
    verifyIdentity: () => verifyAdapterIdentity(identity),
    closeValidationHost: async () => [],
  };
}

export async function loadExternalAdapter(path: string): Promise<LoadedAdapter> {
  const modulePath = resolve(path);
  const moduleDigest = await digestFile(modulePath);
  const moduleUrl = pathToFileURL(modulePath);
  moduleUrl.searchParams.set("agentciDigest", moduleDigest);
  const imported = (await withAdapterDeadline(
    import(moduleUrl.href),
    "adapter module import",
  )) as Record<string, unknown>;
  const definition = assertAdapterDefinition(imported.adapter ?? imported.default);
  return legacyLoadedAdapter(
    definition,
    legacyAdapterIdentity({
      definition,
      source: "external",
      modulePath,
      moduleDigest,
    }),
  );
}

async function loadBuiltinAdapter(fixture: string): Promise<LoadedAdapter> {
  if (fixture !== refundsAdapter.id) {
    throw new AdapterValidationError([
      `fixture '${fixture}' has no built-in adapter; provide --adapter-manifest`,
    ]);
  }
  const modulePath = fileURLToPath(
    new URL("./fixtures/refunds.js", import.meta.url),
  );
  return legacyLoadedAdapter(
    refundsAdapter,
    legacyAdapterIdentity({
      definition: refundsAdapter,
      source: "builtin",
      modulePath,
      moduleDigest: await digestFile(modulePath),
    }),
  );
}

function descriptorIssues(
  descriptor: AdapterDescriptorV2,
  capture: AdapterManifestCapture,
): string[] {
  const manifest = capture.manifest;
  const issues: string[] = [];
  if (descriptor.apiVersion !== manifest.runtime.apiVersion) {
    issues.push("adapter API version differs from its manifest");
  }
  if (descriptor.id !== manifest.id) {
    issues.push("adapter id differs from its manifest");
  }
  if (descriptor.version !== manifest.version) {
    issues.push("adapter version differs from its manifest");
  }
  if (digestValue(descriptor.tools) !== digestValue(manifest.contract.tools)) {
    issues.push("adapter tool contract differs from its manifest");
  }
  return issues;
}

async function cleanupHostedMaterialization(options: {
  host: AdapterHostClient | undefined;
  materialized: MaterializedAdapter;
  capture: AdapterManifestCapture;
  normalClose: boolean;
  reason: string;
}): Promise<string[]> {
  const issues: string[] = [];
  if (options.host !== undefined) {
    try {
      if (options.normalClose && options.host.usable) {
        await options.host.close(options.capture.manifest.runtime.shutdownTimeoutMs);
      } else {
        await options.host.cancel(options.reason);
      }
    } catch (error) {
      issues.push(`adapter host cleanup failed: ${errorMessage(error)}`);
    }
  }
  issues.push(
    ...(await verifyMaterializedAdapter(options.materialized, options.capture)),
  );
  try {
    await cleanupMaterializedAdapter(options.materialized);
  } catch (error) {
    issues.push(`materialized adapter cleanup failed: ${errorMessage(error)}`);
  }
  return issues;
}

async function verifyManifestCapture(
  capture: AdapterManifestCapture,
): Promise<string[]> {
  try {
    const current = await loadAdapterManifest(capture.manifestPath);
    return current.identity.adapterDigest === capture.identity.adapterDigest
      ? []
      : ["declared adapter changed while the suite was running"];
  } catch (error) {
    return [`declared adapter could not be re-verified: ${errorMessage(error)}`];
  }
}

async function spawnCapturedHost(options: {
  capture: AdapterManifestCapture;
  materialized: MaterializedAdapter;
  mode: "inspect" | "scenario";
  credentials: Readonly<Record<string, string>>;
  protectedSecrets?: readonly KnownSecret[];
  timeoutMs?: number;
}): Promise<AdapterHostClient> {
  const runtime = options.capture.manifest.runtime;
  return spawnAdapterHost({
    adapterPath: options.materialized.modulePath,
    mode: options.mode,
    target: structuredClone(
      options.capture.manifest.target,
    ) as unknown as ProtocolJsonValue,
    credentialEnvironment: options.credentials,
    protectedSecrets: options.protectedSecrets ?? [],
    expectedModuleDigest: options.capture.identity.entryFileDigest,
    startupTimeoutMs: Math.max(
      1,
      Math.min(
        options.timeoutMs ?? runtime.operationTimeoutMs,
        runtime.operationTimeoutMs,
      ),
    ),
    operationTimeoutMs: runtime.operationTimeoutMs,
    shutdownTimeoutMs: runtime.shutdownTimeoutMs,
  });
}

async function createHostedEnvironment(options: {
  capture: AdapterManifestCapture;
  credentials: Readonly<Record<string, string>>;
  protectedSecrets: readonly KnownSecret[];
  initialState: JsonValue;
  scenarioId: string;
  timeoutMs: number;
}): Promise<Environment> {
  const deadlineAt = performance.now() + Math.max(1, options.timeoutMs);
  const remainingMs = (): number =>
    Math.max(0, Math.ceil(deadlineAt - performance.now()));
  const materialized = await materializeAdapter(options.capture);
  let host: AdapterHostClient | undefined;
  try {
    const startupTimeoutMs = remainingMs();
    if (startupTimeoutMs === 0) {
      throw new Error("adapter setup exhausted its deadline before host startup");
    }
    host = await spawnCapturedHost({
      capture: options.capture,
      materialized,
      mode: "scenario",
      credentials: options.credentials,
      protectedSecrets: options.protectedSecrets,
      timeoutMs: startupTimeoutMs,
    });
    const issues = descriptorIssues(host.descriptor, options.capture);
    if (issues.length > 0) {
      throw new AdapterValidationError(issues);
    }
    const initializeTimeoutMs = remainingMs();
    if (initializeTimeoutMs === 0) {
      throw new Error("adapter setup exhausted its deadline before initialization");
    }
    const initialized = await host.initialize({
      scenarioId: options.scenarioId,
      initialState: cloneJson(options.initialState) as ProtocolJsonValue,
      timeoutMs: Math.max(
        1,
        Math.min(
          initializeTimeoutMs,
          options.capture.manifest.runtime.operationTimeoutMs,
        ),
      ),
    });
    if (
      digestValue(initialized.tools) !==
      digestValue(options.capture.manifest.contract.tools)
    ) {
      throw new AdapterValidationError([
        "runtime environment tools differ from the adapter manifest contract",
      ]);
    }
    if (
      digestValue(initialized.initialState) !==
      digestValue(options.initialState)
    ) {
      throw new AdapterValidationError([
        "runtime environment did not preserve the declared initial state",
      ]);
    }
  } catch (error) {
    const cleanupIssues = await cleanupHostedMaterialization({
      host,
      materialized,
      capture: options.capture,
      normalClose: false,
      reason: "scenario initialization failed",
    });
    throw new FixtureError(
      [`adapter host initialization failed: ${errorMessage(error)}`, ...cleanupIssues].join(
        "; ",
      ),
    );
  }

  const activeHost = host;
  const credentialBytes = Object.values(options.credentials).map((value) =>
    Buffer.from(value, "utf8"),
  );
  const knownCredentialSecrets: readonly KnownSecret[] = Object.freeze([
    ...knownSecretsFromCredentialEnv(options.credentials),
    ...options.protectedSecrets,
  ]);
  const longestCredential = credentialBytes.reduce(
    (maximum, value) => Math.max(maximum, value.byteLength),
    0,
  );
  let candidateStderrTail = Buffer.alloc(0);
  let finalization: Promise<string[]> | undefined;
  const finalize = (normalClose: boolean, reason: string): Promise<string[]> => {
    finalization ??= cleanupHostedMaterialization({
      host: activeHost,
      materialized,
      capture: options.capture,
      normalClose,
      reason,
    });
    return finalization;
  };
  const ensureClean = async (normalClose: boolean, reason: string): Promise<void> => {
    const issues = await finalize(normalClose, reason);
    if (issues.length > 0) {
      throw new FixtureError(issues.join("; "));
    }
  };

  return {
    tools: [...options.capture.manifest.contract.tools],
    async call(tool, argumentsValue) {
      const response = await activeHost.transition({
        invoke: true,
        tool,
        arguments: cloneJson(argumentsValue) as ProtocolJsonValue,
      });
      if (response.outcome.kind === "ok") {
        return cloneJson(response.outcome.content as JsonValue);
      }
      if (response.outcome.kind === "tool_error") {
        throw new ToolCallError(
          response.outcome.error.code,
          response.outcome.error.message,
        );
      }
      throw new FixtureError("adapter skipped an invoked transition");
    },
    async snapshot() {
      const response = await activeHost.snapshot();
      return cloneJson(response.state as JsonValue);
    },
    async transition(request: EnvironmentTransitionRequest) {
      const response = await activeHost.transition(
        request.invoke
          ? {
              invoke: true,
              tool: request.tool,
              arguments: cloneJson(request.arguments) as ProtocolJsonValue,
            }
          : { invoke: false },
      );
      return {
        beforeState: cloneJson(response.beforeState as JsonValue),
        afterState: cloneJson(response.afterState as JsonValue),
        outcome:
          response.outcome.kind === "ok"
            ? {
                kind: "ok" as const,
                content: cloneJson(response.outcome.content as JsonValue),
              }
            : response.outcome.kind === "tool_error"
              ? {
                  kind: "tool_error" as const,
                  error: { ...response.outcome.error },
                }
              : { kind: "skipped" as const },
      };
    },
    inspectCandidateStderr(chunk) {
      if (credentialBytes.length === 0) {
        return;
      }
      const combined = Buffer.concat([
        candidateStderrTail,
        Buffer.from(chunk),
      ]);
      if (
        credentialBytes.some(
          (credential) => combined.indexOf(credential) !== -1,
        )
      ) {
        throw new FixtureError(
          "known adapter credential material appeared in candidate stderr",
        );
      }
      candidateStderrTail = combined.subarray(
        Math.max(0, combined.byteLength - Math.max(0, longestCredential - 1)),
      );
    },
    inspectCandidateProtocol(message) {
      assertNoKnownSecretLeaksAtJsonBoundary(
        message,
        knownCredentialSecrets,
      );
    },
    abort(reason) {
      return ensureClean(false, reason);
    },
    close() {
      return ensureClean(true, "scenario completed");
    },
  };
}

export async function loadManifestAdapter(options: {
  manifestPath: string;
  callerAllowlist?: readonly string[];
  approvedAdapterDigest?: string;
  sourceEnv?: Readonly<Record<string, string | undefined>>;
  preparation?: PreparedManifestAdapter;
  candidateCredentialEnvironment?: Readonly<Record<string, string>>;
}): Promise<LoadedAdapter> {
  const preparation =
    options.preparation ??
    (await prepareManifestAdapter({
      manifestPath: options.manifestPath,
      ...(options.callerAllowlist !== undefined
        ? { callerAllowlist: options.callerAllowlist }
        : {}),
      ...(options.approvedAdapterDigest !== undefined
        ? { approvedAdapterDigest: options.approvedAdapterDigest }
        : {}),
      ...(options.sourceEnv !== undefined
        ? { sourceEnv: options.sourceEnv }
        : {}),
    }));
  const { capture, credentials } = preparation;
  const candidateSecrets = knownSecretsFromCredentialEnv(
    options.candidateCredentialEnvironment ?? {},
  );
  if (!adapterCaptureExcludesKnownSecrets(capture, candidateSecrets)) {
    throw new AdapterValidationError([
      "adapter declaration or bundle contains candidate credential material",
    ]);
  }
  const materialized = await materializeAdapter(capture);
  let inspector: AdapterHostClient | undefined;
  try {
    inspector = await spawnCapturedHost({
      capture,
      materialized,
      mode: "inspect",
      credentials,
      protectedSecrets: candidateSecrets,
    });
    const issues = descriptorIssues(inspector.descriptor, capture);
    if (issues.length > 0) {
      throw new AdapterValidationError(issues);
    }
  } catch (error) {
    const cleanupIssues = await cleanupHostedMaterialization({
      host: inspector,
      materialized,
      capture,
      normalClose: false,
      reason: "adapter inspection failed",
    });
    if (error instanceof AdapterValidationError && cleanupIssues.length === 0) {
      throw error;
    }
    throw new AdapterValidationError([
      `adapter inspection failed: ${errorMessage(error)}`,
      ...cleanupIssues,
    ]);
  }

  const validationHost = inspector;
  const descriptor = validationHost.descriptor;
  let validationCleanup: Promise<string[]> | undefined;
  const closeValidationHost = (): Promise<string[]> => {
    validationCleanup ??= cleanupHostedMaterialization({
      host: validationHost,
      materialized,
      capture,
      normalClose: true,
      reason: "adapter validation completed",
    });
    return validationCleanup;
  };

  const definition: AdapterRuntime = {
    apiVersion: "agentci.adapter.v2",
    id: descriptor.id,
    version: descriptor.version,
    tools: [...descriptor.tools],
    conformance: descriptor.conformance.map((candidate) => ({
      name: candidate.name,
      initialState: cloneJson(candidate.initialState as JsonValue),
      call: {
        tool: candidate.call.tool,
        arguments: cloneJson(candidate.call.arguments as JsonValue),
      },
      expectedResult: cloneJson(candidate.expectedResult as JsonValue),
      expectedFinalState: cloneJson(candidate.expectedFinalState as JsonValue),
    })),
    async validateSuite(suite) {
      const response = await validationHost.validate({
        suite: structuredClone(suite) as unknown as ProtocolJsonValue,
        pointers: [],
      });
      return [...response.issues];
    },
    async validateStatePointer(pointer, initialState) {
      const response = await validationHost.validate({
        suite: { schemaVersion: "agentci.suite.v1" },
        pointers: [{ id: "pointer", pointer, initialState }],
      });
      return response.pointers[0]?.issue ?? undefined;
    },
    async validate(suite, pointers) {
      const response = await validationHost.validate({
        suite: structuredClone(suite) as unknown as ProtocolJsonValue,
        pointers: pointers.map((pointer) => ({
          id: pointer.id,
          pointer: pointer.pointer,
          initialState: cloneJson(pointer.initialState) as ProtocolJsonValue,
        })),
      });
      return {
        issues: [...response.issues],
        pointers: response.pointers.map((pointer) => ({
          id: pointer.id,
          ...(pointer.issue !== null ? { issue: pointer.issue } : {}),
        })),
      };
    },
    createEnvironment(initialState, context) {
      return createHostedEnvironment({
        capture,
        credentials,
        protectedSecrets: candidateSecrets,
        initialState,
        scenarioId: context?.scenarioId ?? "adapter-conformance",
        timeoutMs:
          context?.timeoutMs ?? capture.manifest.runtime.operationTimeoutMs,
      });
    },
  };

  return {
    definition,
    identity: capture.identity,
    credentialBoundary: {
      declaredEnvNames: Object.freeze([
        ...capture.manifest.credentials.environment,
      ]),
      environment: credentials,
    },
    verifyIdentity: () => verifyManifestCapture(capture),
    closeValidationHost,
  };
}

export interface PreparedManifestAdapter {
  capture: AdapterManifestCapture;
  credentials: Readonly<Record<string, string>>;
}

function adapterCaptureExcludesKnownSecrets(
  capture: AdapterManifestCapture,
  secrets: ReturnType<typeof knownSecretsFromCredentialEnv>,
): boolean {
  if (secrets.length === 0) {
    return true;
  }
  try {
    assertNoKnownSecretLeaksAtJsonBoundary(
      capture.manifest as unknown as JsonValue,
      secrets,
    );
  } catch {
    return false;
  }
  const secretBytes = secrets.map((secret) => Buffer.from(secret.value, "utf8"));
  for (const file of capture.files) {
    if (
      secrets.some((secret) => file.path.includes(secret.value)) ||
      secretBytes.some(
        (credential) => Buffer.from(file.content).indexOf(credential) !== -1,
      )
    ) {
      return false;
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
        return false;
      }
      assertNoKnownSecretLeaksAtJsonBoundary(normalizedValue, secrets);
    } catch {
      return false;
    }
  }
  return true;
}

export async function prepareManifestAdapter(options: {
  manifestPath: string;
  callerAllowlist?: readonly string[];
  approvedAdapterDigest?: string;
  sourceEnv?: Readonly<Record<string, string | undefined>>;
}): Promise<PreparedManifestAdapter> {
  const capture = await loadAdapterManifest(options.manifestPath);
  const credentials = authorizeAdapterCredentials({
    declaredEnvNames: capture.manifest.credentials.environment,
    callerAllowlist: options.callerAllowlist ?? [],
    sourceEnv: options.sourceEnv ?? {},
    capturedAdapterDigest: capture.identity.adapterDigest,
    ...(options.approvedAdapterDigest !== undefined
      ? { approvedAdapterDigest: options.approvedAdapterDigest }
      : {}),
  });
  const authorizedSecrets = knownSecretsFromCredentialEnv(credentials);
  if (!adapterCaptureExcludesKnownSecrets(capture, authorizedSecrets)) {
    throw new AdapterValidationError([
      "adapter declaration or bundle contains authorized credential material",
    ]);
  }
  return {
    capture,
    credentials,
  };
}

export async function resolveAdapter(options: {
  fixture: string;
  adapterPath?: string;
  adapterManifestPath?: string;
  callerAllowlist?: readonly string[];
  approvedAdapterDigest?: string;
  sourceEnv?: Readonly<Record<string, string | undefined>>;
  manifestPreparation?: PreparedManifestAdapter;
  candidateCredentialEnvironment?: Readonly<Record<string, string>>;
}): Promise<LoadedAdapter> {
  if (
    options.adapterPath !== undefined &&
    options.adapterManifestPath !== undefined
  ) {
    throw new AdapterValidationError([
      "--adapter and --adapter-manifest are mutually exclusive",
    ]);
  }
  const loaded =
    options.adapterManifestPath !== undefined
      ? await loadManifestAdapter({
          manifestPath: options.adapterManifestPath,
          ...(options.callerAllowlist !== undefined
            ? { callerAllowlist: options.callerAllowlist }
            : {}),
          ...(options.approvedAdapterDigest !== undefined
            ? { approvedAdapterDigest: options.approvedAdapterDigest }
            : {}),
          ...(options.sourceEnv !== undefined
            ? { sourceEnv: options.sourceEnv }
            : {}),
          ...(options.manifestPreparation !== undefined
            ? { preparation: options.manifestPreparation }
            : {}),
          ...(options.candidateCredentialEnvironment !== undefined
            ? {
                candidateCredentialEnvironment:
                  options.candidateCredentialEnvironment,
              }
            : {}),
        })
      : options.adapterPath !== undefined
        ? await loadExternalAdapter(options.adapterPath)
        : await loadBuiltinAdapter(options.fixture);
  if (loaded.definition.id !== options.fixture) {
    const cleanupIssues = await loaded.closeValidationHost();
    throw new AdapterValidationError([
      `adapter id '${loaded.definition.id}' does not match suite fixture '${options.fixture}'`,
      ...cleanupIssues,
    ]);
  }
  return loaded;
}

export async function validateSuiteAgainstAdapter(
  suite: SuiteSpec,
  adapter: AdapterRuntime,
): Promise<string[]> {
  const issues: string[] = [];
  const tools = new Set(adapter.tools);
  const pointerRequests: AdapterPointerValidationRequest[] = [];
  const pointerPaths = new Map<string, string>();
  suite.scenarios.forEach((scenario, scenarioIndex) => {
    const prefix = `scenarios[${scenarioIndex}]`;
    scenario.faults.forEach((fault, faultIndex) => {
      if (!tools.has(fault.tool)) {
        issues.push(`${prefix}.faults[${faultIndex}].tool is not exposed by the adapter`);
      }
    });
    scenario.assertions.forEach((assertion, assertionIndex) => {
      const assertionPath = `${prefix}.assertions[${assertionIndex}]`;
      if (assertion.type === "event_count" && !tools.has(assertion.tool)) {
        issues.push(`${assertionPath}.tool is not exposed by the adapter`);
      }
      if (assertion.type === "event_order") {
        assertion.tools.forEach((tool) => {
          if (!tools.has(tool)) {
            issues.push(`${assertionPath}.tools contains unexposed tool ${tool}`);
          }
        });
      }
      if (
        assertion.type === "json_pointer" &&
        assertion.source === "output" &&
        assertion.operator === "absent"
      ) {
        issues.push(`${assertionPath} cannot assert absence on untyped candidate output`);
      }
      if (assertion.type === "json_pointer" && assertion.source === "state") {
        const id = `pointer-${scenarioIndex}-${assertionIndex}`;
        pointerRequests.push({
          id,
          pointer: assertion.pointer,
          initialState: cloneJson(scenario.initialState),
        });
        pointerPaths.set(id, assertionPath);
      }
    });
  });

  if (adapter.validate !== undefined) {
    try {
      const result = await adapter.validate(structuredClone(suite), pointerRequests);
      if (
        !Array.isArray(result.issues) ||
        !result.issues.every(
          (issue) => typeof issue === "string" && issue.length > 0,
        ) ||
        !Array.isArray(result.pointers)
      ) {
        issues.push("adapter validation returned an invalid result");
      } else {
        issues.push(...result.issues);
        const expectedIds = new Set(pointerRequests.map((pointer) => pointer.id));
        const observedIds = new Set<string>();
        for (const pointer of result.pointers) {
          if (
            typeof pointer.id !== "string" ||
            !expectedIds.has(pointer.id) ||
            observedIds.has(pointer.id) ||
            (pointer.issue !== undefined &&
              (typeof pointer.issue !== "string" || pointer.issue.length === 0))
          ) {
            issues.push("adapter pointer validation returned an invalid result");
            continue;
          }
          observedIds.add(pointer.id);
          if (pointer.issue !== undefined) {
            const request = pointerRequests.find(
              (candidate) => candidate.id === pointer.id,
            );
            issues.push(
              `${pointerPaths.get(pointer.id) ?? pointer.id}.pointer '${request?.pointer ?? ""}' ${pointer.issue}`,
            );
          }
        }
        if (
          observedIds.size !== expectedIds.size ||
          [...expectedIds].some((id) => !observedIds.has(id))
        ) {
          issues.push("adapter pointer validation omitted a requested pointer");
        }
      }
    } catch (error) {
      issues.push(`adapter validation failed: ${errorMessage(error)}`);
    }
    return [...new Set(issues)];
  }

  for (const request of pointerRequests) {
    try {
      const issue = await adapter.validateStatePointer(
        request.pointer,
        cloneJson(request.initialState),
      );
      if (issue !== undefined) {
        if (typeof issue !== "string" || issue.length === 0) {
          issues.push(
            `${pointerPaths.get(request.id)}.pointer adapter validation returned an invalid issue`,
          );
        } else {
          issues.push(
            `${pointerPaths.get(request.id)}.pointer '${request.pointer}' ${issue}`,
          );
        }
      }
    } catch (error) {
      issues.push(
        `${pointerPaths.get(request.id)}.pointer adapter validation threw: ${errorMessage(error)}`,
      );
    }
  }
  try {
    const adapterIssues = await adapter.validateSuite(structuredClone(suite));
    if (
      !Array.isArray(adapterIssues) ||
      !adapterIssues.every(
        (issue) => typeof issue === "string" && issue.length > 0,
      )
    ) {
      issues.push("adapter validateSuite must return an array of non-empty strings");
    } else {
      issues.push(...adapterIssues);
    }
  } catch (error) {
    issues.push(`adapter suite validation threw: ${errorMessage(error)}`);
  }
  return [...new Set(issues)];
}

function mutateSnapshot(snapshot: JsonValue): void {
  if (Array.isArray(snapshot)) {
    snapshot.push("agentci-mutation-probe");
  } else if (snapshot !== null && typeof snapshot === "object") {
    snapshot.__agentciMutationProbe = true;
  }
}

async function readJsonSnapshot(
  environment: Environment,
  label: string,
): Promise<JsonValue> {
  const snapshot = await withAdapterDeadline(
    environment.snapshot(),
    `${label} snapshot`,
  );
  if (!isJsonValue(snapshot)) {
    throw new Error(`${label} returned a non-JSON snapshot`);
  }
  return snapshot;
}

async function callForJson(
  environment: Environment,
  tool: string,
  argumentsValue: JsonValue,
  label: string,
): Promise<JsonValue> {
  const result = await withAdapterDeadline(
    environment.call(tool, cloneJson(argumentsValue)),
    label,
  );
  if (!isJsonValue(result)) {
    throw new Error(`${label} returned a non-JSON result`);
  }
  return result;
}

function runtimeFromUnknown(value: unknown): AdapterRuntime {
  if (isRecord(value) && value.apiVersion === "agentci.adapter.v2") {
    const requiredFunctions = [
      value.validateSuite,
      value.validateStatePointer,
      value.createEnvironment,
    ];
    if (
      typeof value.id === "string" &&
      value.id.length > 0 &&
      typeof value.version === "string" &&
      value.version.length > 0 &&
      Array.isArray(value.tools) &&
      Array.isArray(value.conformance) &&
      requiredFunctions.every((candidate) => typeof candidate === "function")
    ) {
      return value as unknown as AdapterRuntime;
    }
    throw new AdapterValidationError(["adapter v2 runtime is incomplete"]);
  }
  return assertAdapterDefinition(value);
}

export async function runAdapterConformance(
  adapterValue: unknown,
): Promise<string[]> {
  let adapter: AdapterRuntime;
  try {
    adapter = runtimeFromUnknown(adapterValue);
  } catch (error) {
    return error instanceof AdapterValidationError
      ? error.issues
      : [errorMessage(error)];
  }
  const issues: string[] = [];
  for (const [index, candidate] of adapter.conformance.entries()) {
    const prefix = `conformance[${index}] '${candidate.name}'`;
    if (!adapter.tools.includes(candidate.call.tool)) {
      issues.push(`${prefix}: call tool is not declared by the adapter`);
      continue;
    }
    let first: Environment | undefined;
    let second: Environment | undefined;
    try {
      const expectedInitialState = cloneJson(candidate.initialState);
      const expectedInitialDigest = digestValue(expectedInitialState);
      first = await withAdapterDeadline(
        adapter.createEnvironment(cloneJson(expectedInitialState), {
          scenarioId: `${prefix}:first`,
          timeoutMs: LEGACY_ADAPTER_OPERATION_TIMEOUT_MS,
        }),
        "first environment creation",
      );
      second = await withAdapterDeadline(
        adapter.createEnvironment(cloneJson(expectedInitialState), {
          scenarioId: `${prefix}:second`,
          timeoutMs: LEGACY_ADAPTER_OPERATION_TIMEOUT_MS,
        }),
        "second environment creation",
      );
      if (
        digestValue(await readJsonSnapshot(first, "first environment")) !==
        expectedInitialDigest
      ) {
        issues.push(`${prefix}: first environment did not preserve initial state`);
      }
      if (
        digestValue(await readJsonSnapshot(second, "second environment")) !==
        expectedInitialDigest
      ) {
        issues.push(`${prefix}: second environment did not preserve initial state`);
      }
      if (
        !Array.isArray(first.tools) ||
        !first.tools.every((tool) => typeof tool === "string" && tool.length > 0) ||
        digestValue(first.tools) !== digestValue(adapter.tools)
      ) {
        issues.push(`${prefix}: environment tools differ from adapter tools`);
      }
      const detachedSnapshot = await readJsonSnapshot(first, "first environment");
      mutateSnapshot(detachedSnapshot);
      if (
        digestValue(await readJsonSnapshot(first, "first environment")) !==
        expectedInitialDigest
      ) {
        issues.push(`${prefix}: snapshot mutation leaked into environment state`);
      }

      const firstResult = await callForJson(
        first,
        candidate.call.tool,
        candidate.call.arguments,
        "first environment call",
      );
      if (digestValue(firstResult) !== digestValue(candidate.expectedResult)) {
        issues.push(`${prefix}: result differs from expectedResult`);
      }
      if (
        digestValue(await readJsonSnapshot(first, "first environment")) !==
        digestValue(candidate.expectedFinalState)
      ) {
        issues.push(`${prefix}: final state differs from expectedFinalState`);
      }
      if (
        digestValue(await readJsonSnapshot(second, "second environment")) !==
        expectedInitialDigest
      ) {
        issues.push(`${prefix}: first environment mutated the second environment`);
      }
      const secondResult = await callForJson(
        second,
        candidate.call.tool,
        candidate.call.arguments,
        "second environment call",
      );
      if (
        digestValue(secondResult) !== digestValue(firstResult) ||
        digestValue(await readJsonSnapshot(second, "second environment")) !==
          digestValue(await readJsonSnapshot(first, "first environment"))
      ) {
        issues.push(`${prefix}: repeated fresh execution was not deterministic`);
      }
    } catch (error) {
      issues.push(`${prefix}: execution failed: ${errorMessage(error)}`);
    } finally {
      for (const [label, environment] of [
        ["first", first],
        ["second", second],
      ] as const) {
        try {
          if (environment?.close !== undefined) {
            await withAdapterDeadline(
              environment.close(),
              `${label} environment cleanup`,
            );
          }
        } catch (error) {
          issues.push(
            `${prefix}: ${label} environment cleanup failed: ${errorMessage(error)}`,
          );
        }
      }
    }
  }
  return issues;
}

export async function verifyAdapterIdentity(
  identity: AdapterIdentity,
): Promise<string[]> {
  if (identity.digestScope !== "module-entry-only") {
    return [
      "manifest-backed adapter identity must be verified through its closed capture",
    ];
  }
  try {
    return (await digestFile(identity.modulePath)) === identity.moduleDigest
      ? []
      : ["adapter module changed while the suite was running"];
  } catch (error) {
    return [`adapter module could not be re-verified: ${errorMessage(error)}`];
  }
}

export function isManifestAdapterIdentity(
  identity: AdapterIdentity,
): identity is ManifestAdapterIdentity {
  return identity.digestScope === "declared-config-and-adapter-bundle-bytes";
}
