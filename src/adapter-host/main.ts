import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  assertNoKnownSecretLeaksAtJsonBoundary,
  knownSecretsFromCredentialEnv,
  type KnownSecret,
} from "../credential-policy.js";
import {
  ADAPTER_HOST_PROTOCOL_VERSION,
  EXTERNAL_ADAPTER_API_VERSION,
  cloneProtocolJson,
  isAdapterDescriptorV2,
  isProtocolPayload,
  parseAdapterHostRequest,
  type AdapterDescriptorV2,
  type AdapterHostMode,
  type AdapterHostRequest,
  type AdapterHostResponse,
  type AdapterOperationContext,
  type ExternalAdapterDefinitionV2,
  type ExternalAdapterEnvironmentV2,
  type ProtocolJsonValue,
  type TransitionOutcome,
} from "./protocol.js";
import { parseStrictJson } from "../strict-json.js";

type HostState =
  | "booting"
  | "ready"
  | "initializing"
  | "active"
  | "closing"
  | "poisoned"
  | "closed";

interface ActiveOperation {
  seq: number;
  phase: string;
  controller: AbortController;
  deadlineTimer: NodeJS.Timeout;
  timeoutMs: number;
  timedOut: boolean;
  cancelled: boolean;
}

class HostOperationError extends Error {
  readonly phase: string;

  constructor(phase: string, message: string) {
    super(message);
    this.name = "HostOperationError";
    this.phase = phase;
  }
}

const mode = process.argv[2] as AdapterHostMode | undefined;
const adapterPath = process.argv[3];
const nonce = process.argv[4];
const credentialNamesArgument = process.argv[5] ?? "[]";

let state: HostState = "booting";
let definition: ExternalAdapterDefinitionV2 | undefined;
let environment: ExternalAdapterEnvironmentV2 | undefined;
let scenarioId = "adapter-inspection";
let target: ProtocolJsonValue = null;
let credentials: Readonly<Record<string, string>> = Object.freeze({});
let knownSecrets: readonly KnownSecret[] = Object.freeze([]);
let lastSequence = 0;
let activeOperation: ActiveOperation | undefined;
let activeTask: Promise<void> | undefined;
let closeStarted = false;
let normalExit = false;
let emergencyExitStarted = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function cleanMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.replaceAll("\r", " ").replaceAll("\n", " ").trim();
  let redacted = normalized.length > 0 ? normalized : "unknown adapter-host error";
  for (const secret of knownSecrets) {
    redacted = redacted.replaceAll(secret.value, "[REDACTED]");
  }
  return redacted.slice(0, 2_048);
}

function digestBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function descriptorOf(
  adapter: ExternalAdapterDefinitionV2,
): AdapterDescriptorV2 {
  return cloneProtocolJson({
    apiVersion: adapter.apiVersion,
    id: adapter.id,
    version: adapter.version,
    tools: [...adapter.tools],
    conformance: adapter.conformance.map((candidate) => ({
      name: candidate.name,
      initialState: candidate.initialState,
      call: {
        tool: candidate.call.tool,
        arguments: candidate.call.arguments,
      },
      expectedResult: candidate.expectedResult,
      expectedFinalState: candidate.expectedFinalState,
    })),
  });
}

function assertAdapterDefinition(value: unknown): ExternalAdapterDefinitionV2 {
  if (!isRecord(value)) {
    throw new Error("adapter export must be an object");
  }
  if (
    !hasOnlyKeys(value, [
      "apiVersion",
      "id",
      "version",
      "tools",
      "conformance",
      "validateSuite",
      "validateStatePointer",
      "createEnvironment",
    ])
  ) {
    throw new Error("adapter export contains unsupported fields");
  }
  if (
    typeof value.validateSuite !== "function" ||
    typeof value.validateStatePointer !== "function" ||
    typeof value.createEnvironment !== "function"
  ) {
    throw new Error(
      "adapter must provide validateSuite, validateStatePointer, and createEnvironment",
    );
  }
  const descriptor = {
    apiVersion: value.apiVersion,
    id: value.id,
    version: value.version,
    tools: value.tools,
    conformance: value.conformance,
  };
  if (!isAdapterDescriptorV2(descriptor)) {
    throw new Error(
      `adapter descriptor must satisfy ${EXTERNAL_ADAPTER_API_VERSION}`,
    );
  }
  return value as unknown as ExternalAdapterDefinitionV2;
}

function assertEnvironment(value: unknown): ExternalAdapterEnvironmentV2 {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["tools", "call", "snapshot", "close"]) ||
    !Array.isArray(value.tools) ||
    value.tools.length === 0 ||
    !value.tools.every(
      (tool) => typeof tool === "string" && tool.length > 0,
    ) ||
    new Set(value.tools).size !== value.tools.length ||
    typeof value.call !== "function" ||
    typeof value.snapshot !== "function" ||
    typeof value.close !== "function"
  ) {
    throw new Error(
      "createEnvironment must return tools plus call, snapshot, and mandatory close methods",
    );
  }
  return value as unknown as ExternalAdapterEnvironmentV2;
}

function boundaryJson(value: unknown, label: string): ProtocolJsonValue {
  if (!isProtocolPayload(value)) {
    throw new HostOperationError(
      label,
      `${label} did not return finite plain JSON within the protocol limit`,
    );
  }
  return cloneProtocolJson(value);
}

function deepFreezeJson(value: ProtocolJsonValue): ProtocolJsonValue {
  if (Array.isArray(value)) {
    value.forEach(deepFreezeJson);
    return Object.freeze(value) as unknown as ProtocolJsonValue;
  }
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(deepFreezeJson);
    return Object.freeze(value);
  }
  return value;
}

function isExpectedToolError(
  value: unknown,
): { code: string; message: string } | undefined {
  if (!isRecord(value) || value.agentciToolError !== true) {
    return undefined;
  }
  if (
    typeof value.code === "string" &&
    value.code.length > 0 &&
    typeof value.message === "string" &&
    value.message.length > 0
  ) {
    return { code: value.code, message: value.message };
  }
  const detail = value.detail;
  if (
    isRecord(detail) &&
    typeof detail.code === "string" &&
    detail.code.length > 0 &&
    typeof detail.message === "string" &&
    detail.message.length > 0
  ) {
    return { code: detail.code, message: detail.message };
  }
  return undefined;
}

function makeContext(operation: ActiveOperation): AdapterOperationContext {
  return Object.freeze({
    signal: operation.controller.signal,
    scenarioId,
    operationId: `${nonce}:${operation.seq}`,
    timeoutMs: operation.timeoutMs,
    target,
    credentials,
  });
}

async function sendFrame(frame: AdapterHostResponse): Promise<void> {
  if (!isProtocolPayload(frame)) {
    throw new Error("adapter-host response exceeded the protocol boundary");
  }
  assertNoKnownSecretLeaksAtJsonBoundary(
    frame as unknown as Parameters<typeof assertNoKnownSecretLeaksAtJsonBoundary>[0],
    knownSecrets,
  );
  if (process.send === undefined || !process.connected) {
    throw new Error("adapter-host IPC channel is closed");
  }
  await new Promise<void>((resolveSend, rejectSend) => {
    process.send!(frame, (error) => {
      if (error === null) {
        resolveSend();
      } else {
        rejectSend(error);
      }
    });
  });
}

function beginOperation(request: Exclude<AdapterHostRequest, { type: "cancel" }>): ActiveOperation {
  const controller = new AbortController();
  const operation: ActiveOperation = {
    seq: request.seq,
    phase: request.type,
    controller,
    deadlineTimer: setTimeout(() => {
      operation.timedOut = true;
      controller.abort(new Error(`${request.type} exceeded its host deadline`));
    }, request.timeoutMs),
    timeoutMs: request.timeoutMs,
    timedOut: false,
    cancelled: false,
  };
  return operation;
}

function finishOperation(operation: ActiveOperation): void {
  clearTimeout(operation.deadlineTimer);
  if (activeOperation === operation) {
    activeOperation = undefined;
  }
}

function ensureOperationLive(operation: ActiveOperation): void {
  if (operation.timedOut) {
    throw new HostOperationError(
      operation.phase,
      `${operation.phase} exceeded its host deadline`,
    );
  }
  if (operation.cancelled || operation.controller.signal.aborted) {
    throw new HostOperationError(operation.phase, `${operation.phase} was cancelled`);
  }
}

function requireState(expected: HostState, operation: string): void {
  if (state !== expected) {
    throw new HostOperationError(
      operation,
      `${operation} is not valid while the host is ${state}`,
    );
  }
}

async function snapshot(
  target: ExternalAdapterEnvironmentV2,
  context: AdapterOperationContext,
  phase: string,
): Promise<ProtocolJsonValue> {
  try {
    return boundaryJson(await target.snapshot(context), phase);
  } catch (error) {
    if (error instanceof HostOperationError) {
      throw error;
    }
    throw new HostOperationError(phase, cleanMessage(error));
  }
}

async function handleValidate(
  request: Extract<AdapterHostRequest, { type: "validate" }>,
  operation: ActiveOperation,
): Promise<AdapterHostResponse> {
  if (mode !== "inspect") {
    throw new HostOperationError("validate", "validate requires inspection mode");
  }
  requireState("ready", "validate");
  const adapter = definition!;
  target = deepFreezeJson(cloneProtocolJson(request.target));
  const context = makeContext(operation);
  let issues: unknown;
  try {
    issues = await adapter.validateSuite(cloneProtocolJson(request.suite), context);
  } catch (error) {
    throw new HostOperationError("validateSuite", cleanMessage(error));
  }
  ensureOperationLive(operation);
  if (
    !Array.isArray(issues) ||
    !issues.every((issue) => typeof issue === "string" && issue.length > 0)
  ) {
    throw new HostOperationError(
      "validateSuite",
      "validateSuite must return an array of non-empty strings",
    );
  }
  const pointers = [];
  for (const pointer of request.pointers) {
    let issue: unknown;
    try {
      issue = await adapter.validateStatePointer(
        pointer.pointer,
        cloneProtocolJson(pointer.initialState),
        context,
      );
    } catch (error) {
      throw new HostOperationError("validateStatePointer", cleanMessage(error));
    }
    ensureOperationLive(operation);
    if (issue !== undefined && (typeof issue !== "string" || issue.length === 0)) {
      throw new HostOperationError(
        "validateStatePointer",
        "validateStatePointer must return undefined or a non-empty string",
      );
    }
    pointers.push({ id: pointer.id, issue: issue ?? null });
  }
  return {
    v: ADAPTER_HOST_PROTOCOL_VERSION,
    nonce: nonce!,
    seq: request.seq,
    type: "validation_result",
    issues,
    pointers,
  };
}

async function handleInitialize(
  request: Extract<AdapterHostRequest, { type: "initialize" }>,
  operation: ActiveOperation,
): Promise<AdapterHostResponse> {
  if (mode !== "scenario") {
    throw new HostOperationError(
      "initialize",
      "initialize requires scenario mode",
    );
  }
  requireState("ready", "initialize");
  state = "initializing";
  scenarioId = request.scenarioId;
  target = deepFreezeJson(cloneProtocolJson(request.target));
  const context = makeContext(operation);
  let created: unknown;
  try {
    created = await definition!.createEnvironment(
      cloneProtocolJson(request.initialState),
      context,
    );
  } catch (error) {
    throw new HostOperationError("createEnvironment", cleanMessage(error));
  }
  ensureOperationLive(operation);
  environment = assertEnvironment(created);
  const initialState = await snapshot(
    environment,
    context,
    "initialSnapshot",
  );
  ensureOperationLive(operation);
  state = "active";
  return {
    v: ADAPTER_HOST_PROTOCOL_VERSION,
    nonce: nonce!,
    seq: request.seq,
    type: "initialized",
    tools: [...environment.tools],
    initialState,
  };
}

async function handleTransition(
  request: Extract<AdapterHostRequest, { type: "transition" }>,
  operation: ActiveOperation,
): Promise<AdapterHostResponse> {
  requireState("active", "transition");
  const target = environment!;
  const context = makeContext(operation);
  const beforeState = await snapshot(target, context, "beforeSnapshot");
  ensureOperationLive(operation);
  let outcome: TransitionOutcome = { kind: "skipped" };
  if (request.invoke) {
    try {
      const content = await target.call(
        request.tool,
        cloneProtocolJson(request.arguments),
        context,
      );
      ensureOperationLive(operation);
      outcome = { kind: "ok", content: boundaryJson(content, "call") };
    } catch (error) {
      ensureOperationLive(operation);
      const expected = isExpectedToolError(error);
      if (expected === undefined) {
        throw new HostOperationError("call", cleanMessage(error));
      }
      outcome = { kind: "tool_error", error: expected };
    }
  }
  const afterState = await snapshot(target, context, "afterSnapshot");
  ensureOperationLive(operation);
  return {
    v: ADAPTER_HOST_PROTOCOL_VERSION,
    nonce: nonce!,
    seq: request.seq,
    type: "transition_result",
    beforeState,
    afterState,
    outcome,
  };
}

async function handleSnapshot(
  request: Extract<AdapterHostRequest, { type: "snapshot" }>,
  operation: ActiveOperation,
): Promise<AdapterHostResponse> {
  requireState("active", "snapshot");
  const stateValue = await snapshot(
    environment!,
    makeContext(operation),
    "snapshot",
  );
  ensureOperationLive(operation);
  return {
    v: ADAPTER_HOST_PROTOCOL_VERSION,
    nonce: nonce!,
    seq: request.seq,
    type: "snapshot_result",
    state: stateValue,
  };
}

async function handleClose(
  request: Extract<AdapterHostRequest, { type: "close" }>,
  operation: ActiveOperation,
): Promise<AdapterHostResponse> {
  if (mode === "inspect") {
    requireState("ready", "close");
  } else {
    requireState("active", "close");
    state = "closing";
    closeStarted = true;
    try {
      await environment!.close(makeContext(operation));
    } catch (error) {
      throw new HostOperationError("close", cleanMessage(error));
    }
    ensureOperationLive(operation);
  }
  state = "closed";
  return {
    v: ADAPTER_HOST_PROTOCOL_VERSION,
    nonce: nonce!,
    seq: request.seq,
    type: "closed",
  };
}

async function executeRequest(
  request: Exclude<AdapterHostRequest, { type: "cancel" }>,
  operation: ActiveOperation,
): Promise<void> {
  let response: AdapterHostResponse;
  try {
    if (request.type === "validate") {
      response = await handleValidate(request, operation);
    } else if (request.type === "initialize") {
      response = await handleInitialize(request, operation);
    } else if (request.type === "transition") {
      response = await handleTransition(request, operation);
    } else if (request.type === "snapshot") {
      response = await handleSnapshot(request, operation);
    } else {
      response = await handleClose(request, operation);
    }
    ensureOperationLive(operation);
    await sendFrame(response);
    if (response.type === "closed") {
      normalExit = true;
      if (process.connected) {
        process.disconnect();
      }
      process.exit(0);
    }
  } catch (error) {
    state = "poisoned";
    const phase = error instanceof HostOperationError ? error.phase : operation.phase;
    try {
      await sendFrame({
        v: ADAPTER_HOST_PROTOCOL_VERSION,
        nonce: nonce!,
        seq: request.seq,
        type: "operation_error",
        phase,
        message: cleanMessage(error),
      });
    } catch {
      // The parent also observes IPC disconnect or process exit.
    }
    setTimeout(() => process.exit(1), 250).unref();
  } finally {
    finishOperation(operation);
  }
}

async function sendFatal(phase: string, error: unknown): Promise<void> {
  if (normalExit) {
    return;
  }
  state = "poisoned";
  activeOperation?.controller.abort(error);
  try {
    await sendFrame({
      v: ADAPTER_HOST_PROTOCOL_VERSION,
      nonce: nonce ?? "invalid-host-nonce",
      seq: activeOperation?.seq ?? lastSequence,
      type: "fatal",
      phase,
      message: cleanMessage(error),
    });
  } catch {
    // The parent also observes IPC disconnect or process exit.
  }
  process.exit(1);
}

async function emergencyExit(reason: string): Promise<void> {
  if (normalExit || emergencyExitStarted) {
    return;
  }
  emergencyExitStarted = true;
  state = "poisoned";
  if (activeOperation !== undefined) {
    activeOperation.cancelled = true;
    activeOperation.controller.abort(new Error(reason));
  }
  if (activeTask !== undefined) {
    await Promise.race([
      activeTask.catch(() => undefined),
      new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 75)),
    ]);
  }
  if (
    environment !== undefined &&
    activeOperation === undefined &&
    !closeStarted
  ) {
    closeStarted = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(reason)), 75);
    try {
      await Promise.race([
        Promise.resolve(
          environment.close({
            signal: controller.signal,
            scenarioId,
            operationId: `${nonce}:emergency-close`,
            timeoutMs: 75,
            target,
            credentials,
          }),
        ),
        new Promise<void>((_resolve, reject) =>
          setTimeout(() => reject(new Error("emergency close timed out")), 75),
        ),
      ]);
    } catch {
      // Forced process termination is the final containment boundary.
    } finally {
      clearTimeout(timer);
    }
  }
  process.exit(1);
}

function handleMessage(raw: unknown): void {
  if (state === "closed" || state === "poisoned") {
    void sendFatal("protocol", `received a message while host was ${state}`);
    return;
  }
  const request = parseAdapterHostRequest(raw);
  if (request === undefined) {
    void sendFatal("protocol", "received an invalid or oversized request");
    return;
  }
  if (request.nonce !== nonce) {
    void sendFatal("protocol", "request nonce did not match this host");
    return;
  }
  if (request.seq !== lastSequence + 1) {
    void sendFatal("protocol", "request sequence was not strictly monotonic");
    return;
  }
  lastSequence = request.seq;

  if (request.type === "cancel") {
    if (
      activeOperation === undefined ||
      request.targetSeq !== activeOperation.seq
    ) {
      void sendFatal("cancel", "cancel did not target the active request");
      return;
    }
    state = "poisoned";
    activeOperation.cancelled = true;
    activeOperation.controller.abort(new Error(request.reason));
    return;
  }

  if (activeOperation !== undefined) {
    void sendFatal("protocol", "only one adapter-host request may be in flight");
    return;
  }
  const operation = beginOperation(request);
  activeOperation = operation;
  activeTask = executeRequest(request, operation).finally(() => {
    activeTask = undefined;
  });
}

async function boot(): Promise<void> {
  if (
    (mode !== "inspect" && mode !== "scenario") ||
    adapterPath === undefined ||
    adapterPath.length === 0 ||
    nonce === undefined ||
    nonce.length === 0 ||
    nonce.length > 128
  ) {
    throw new Error("adapter host requires mode, adapter path, and nonce arguments");
  }
  let credentialNames: unknown;
  try {
    credentialNames = parseStrictJson(credentialNamesArgument);
  } catch {
    throw new Error("credential-name argument must be JSON");
  }
  if (
    !Array.isArray(credentialNames) ||
    !credentialNames.every(
      (name) => typeof name === "string" && /^[A-Z][A-Z0-9_]*$/.test(name),
    ) ||
    new Set(credentialNames).size !== credentialNames.length
  ) {
    throw new Error("credential-name argument must contain unique safe env names");
  }
  const capturedCredentials: Record<string, string> = {};
  for (const name of credentialNames as string[]) {
    const value = process.env[name];
    if (value === undefined || value.length === 0) {
      throw new Error(`authorized credential '${name}' is missing`);
    }
    capturedCredentials[name] = value;
    delete process.env[name];
  }
  credentials = Object.freeze(capturedCredentials);
  knownSecrets = knownSecretsFromCredentialEnv(credentials);
  const moduleBytes = await readFile(adapterPath);
  const moduleDigest = digestBytes(moduleBytes);
  const moduleUrl = pathToFileURL(adapterPath);
  moduleUrl.searchParams.set("agentciDigest", moduleDigest);
  const imported = (await import(moduleUrl.href)) as Record<string, unknown>;
  definition = assertAdapterDefinition(imported.adapter ?? imported.default);
  const descriptor = descriptorOf(definition);
  state = "ready";

  process.on("message", handleMessage);
  await sendFrame({
    v: ADAPTER_HOST_PROTOCOL_VERSION,
    nonce,
    seq: 0,
    type: "ready",
    mode,
    moduleDigest,
    descriptor,
  });
}

process.once("disconnect", () => {
  void emergencyExit("parent IPC disconnected");
});
process.stdin.resume();
process.stdin.once("end", () => {
  void emergencyExit("parent stdin closed");
});
process.once("SIGTERM", () => {
  void emergencyExit("adapter host received SIGTERM");
});
process.once("SIGINT", () => {
  void emergencyExit("adapter host received SIGINT");
});
process.once("uncaughtException", (error) => {
  void sendFatal("uncaughtException", error);
});
process.once("unhandledRejection", (error) => {
  void sendFatal("unhandledRejection", error);
});

void boot().catch((error: unknown) => sendFatal("boot", error));
