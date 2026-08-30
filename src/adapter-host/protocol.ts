export const ADAPTER_HOST_PROTOCOL_VERSION = "agentci.adapter-host.v1" as const;
export const EXTERNAL_ADAPTER_API_VERSION = "agentci.adapter.v2" as const;
export const MAX_PROTOCOL_MESSAGE_BYTES = 1024 * 1024;
export const MAX_PROTOCOL_JSON_DEPTH = 64;
export const MAX_PROTOCOL_JSON_NODES = 100_000;
export const MAX_OPERATION_TIMEOUT_MS = 60_000;

export type JsonPrimitive = string | number | boolean | null;
export type ProtocolJsonValue =
  | JsonPrimitive
  | ProtocolJsonValue[]
  | { [key: string]: ProtocolJsonValue };

export type AdapterHostMode = "inspect" | "scenario";

export interface AdapterOperationContext {
  readonly signal: AbortSignal;
  readonly scenarioId: string;
  readonly operationId: string;
  readonly timeoutMs: number;
  readonly target: ProtocolJsonValue;
  readonly credentials: Readonly<Record<string, string>>;
}

export interface AdapterConformanceCaseV2 {
  name: string;
  initialState: ProtocolJsonValue;
  call: {
    tool: string;
    arguments: ProtocolJsonValue;
  };
  expectedResult: ProtocolJsonValue;
  expectedFinalState: ProtocolJsonValue;
}

export interface AdapterDescriptorV2 {
  apiVersion: typeof EXTERNAL_ADAPTER_API_VERSION;
  id: string;
  version: string;
  tools: string[];
  conformance: AdapterConformanceCaseV2[];
}

export interface ExternalAdapterEnvironmentV2 {
  readonly tools: readonly string[];
  call(
    tool: string,
    argumentsValue: ProtocolJsonValue,
    context: AdapterOperationContext,
  ): ProtocolJsonValue | Promise<ProtocolJsonValue>;
  snapshot(
    context: AdapterOperationContext,
  ): ProtocolJsonValue | Promise<ProtocolJsonValue>;
  close(context: AdapterOperationContext): void | Promise<void>;
}

export interface ExternalAdapterDefinitionV2 extends AdapterDescriptorV2 {
  validateSuite(
    suite: ProtocolJsonValue,
    context: AdapterOperationContext,
  ): string[] | Promise<string[]>;
  validateStatePointer(
    pointer: string,
    initialState: ProtocolJsonValue,
    context: AdapterOperationContext,
  ): string | undefined | Promise<string | undefined>;
  createEnvironment(
    initialState: ProtocolJsonValue,
    context: AdapterOperationContext,
  ): ExternalAdapterEnvironmentV2 | Promise<ExternalAdapterEnvironmentV2>;
}

export interface PointerValidationRequest {
  id: string;
  pointer: string;
  initialState: ProtocolJsonValue;
}

export interface PointerValidationResult {
  id: string;
  issue: string | null;
}

interface RequestBase {
  v: typeof ADAPTER_HOST_PROTOCOL_VERSION;
  nonce: string;
  seq: number;
}

export interface ValidateRequest extends RequestBase {
  type: "validate";
  timeoutMs: number;
  target: ProtocolJsonValue;
  suite: ProtocolJsonValue;
  pointers: PointerValidationRequest[];
}

export interface InitializeRequest extends RequestBase {
  type: "initialize";
  timeoutMs: number;
  scenarioId: string;
  target: ProtocolJsonValue;
  initialState: ProtocolJsonValue;
}

export interface InvokeTransitionRequest extends RequestBase {
  type: "transition";
  timeoutMs: number;
  invoke: true;
  tool: string;
  arguments: ProtocolJsonValue;
}

export interface ObserveTransitionRequest extends RequestBase {
  type: "transition";
  timeoutMs: number;
  invoke: false;
}

export type TransitionRequest =
  | InvokeTransitionRequest
  | ObserveTransitionRequest;

export interface SnapshotRequest extends RequestBase {
  type: "snapshot";
  timeoutMs: number;
}

export interface CloseRequest extends RequestBase {
  type: "close";
  timeoutMs: number;
}

export interface CancelRequest extends RequestBase {
  type: "cancel";
  targetSeq: number;
  reason: string;
}

export type AdapterHostRequest =
  | ValidateRequest
  | InitializeRequest
  | TransitionRequest
  | SnapshotRequest
  | CloseRequest
  | CancelRequest;

interface ResponseBase {
  v: typeof ADAPTER_HOST_PROTOCOL_VERSION;
  nonce: string;
  seq: number;
}

export interface ReadyResponse extends ResponseBase {
  type: "ready";
  seq: 0;
  mode: AdapterHostMode;
  moduleDigest: string;
  descriptor: AdapterDescriptorV2;
}

export interface ValidationResponse extends ResponseBase {
  type: "validation_result";
  issues: string[];
  pointers: PointerValidationResult[];
}

export interface InitializedResponse extends ResponseBase {
  type: "initialized";
  tools: string[];
  initialState: ProtocolJsonValue;
}

export type TransitionOutcome =
  | { kind: "ok"; content: ProtocolJsonValue }
  | { kind: "tool_error"; error: { code: string; message: string } }
  | { kind: "skipped" };

export interface TransitionResponse extends ResponseBase {
  type: "transition_result";
  beforeState: ProtocolJsonValue;
  afterState: ProtocolJsonValue;
  outcome: TransitionOutcome;
}

export interface SnapshotResponse extends ResponseBase {
  type: "snapshot_result";
  state: ProtocolJsonValue;
}

export interface ClosedResponse extends ResponseBase {
  type: "closed";
}

export interface OperationErrorResponse extends ResponseBase {
  type: "operation_error";
  phase: string;
  message: string;
}

export interface FatalResponse extends ResponseBase {
  type: "fatal";
  phase: string;
  message: string;
}

export type AdapterHostResponse =
  | ReadyResponse
  | ValidationResponse
  | InitializedResponse
  | TransitionResponse
  | SnapshotResponse
  | ClosedResponse
  | OperationErrorResponse
  | FatalResponse;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isSequence(value: unknown, allowZero = false): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= (allowZero ? 0 : 1)
  );
}

function isTimeout(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) > 0 &&
    (value as number) <= MAX_OPERATION_TIMEOUT_MS
  );
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isStringArray(
  value: unknown,
  requireNonEmpty = false,
  requireUnique = true,
): value is string[] {
  return (
    Array.isArray(value) &&
    (!requireNonEmpty || value.length > 0) &&
    value.every(isNonEmptyString) &&
    (!requireUnique || new Set(value).size === value.length)
  );
}

interface JsonWalkState {
  nodes: number;
  ancestors: Set<object>;
}

function isStrictJsonValueAt(
  value: unknown,
  depth: number,
  state: JsonWalkState,
): value is ProtocolJsonValue {
  state.nodes += 1;
  if (
    state.nodes > MAX_PROTOCOL_JSON_NODES ||
    depth > MAX_PROTOCOL_JSON_DEPTH
  ) {
    return false;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "object") {
    return false;
  }

  const object = value as object;
  if (state.ancestors.has(object)) {
    return false;
  }
  state.ancestors.add(object);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      if (
        keys.length !== value.length + 1 ||
        !keys.includes("length") ||
        keys.some(
          (key) =>
            typeof key !== "string" ||
            (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key)),
        )
      ) {
        return false;
      }
      for (let index = 0; index < value.length; index += 1) {
        if (
          !Object.prototype.hasOwnProperty.call(value, index) ||
          !isStrictJsonValueAt(value[index], depth + 1, state)
        ) {
          return false;
        }
      }
      return true;
    }
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) {
      return false;
    }
    const keys = Reflect.ownKeys(object);
    for (const key of keys) {
      if (typeof key !== "string") {
        return false;
      }
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor) ||
        !isStrictJsonValueAt(descriptor.value, depth + 1, state)
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  } finally {
    state.ancestors.delete(object);
  }
}

export function isStrictProtocolJson(
  value: unknown,
): value is ProtocolJsonValue {
  return isStrictJsonValueAt(value, 0, {
    nodes: 0,
    ancestors: new Set<object>(),
  });
}

export function protocolMessageSize(value: unknown): number | undefined {
  if (!isStrictProtocolJson(value)) {
    return undefined;
  }
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return undefined;
  }
}

export function isProtocolPayload(value: unknown): value is ProtocolJsonValue {
  const size = protocolMessageSize(value);
  return size !== undefined && size <= MAX_PROTOCOL_MESSAGE_BYTES;
}

function isRequestBase(value: Record<string, unknown>): boolean {
  return (
    value.v === ADAPTER_HOST_PROTOCOL_VERSION &&
    isNonEmptyString(value.nonce) &&
    value.nonce.length <= 128 &&
    isSequence(value.seq)
  );
}

function isPointerRequest(value: unknown): value is PointerValidationRequest {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["id", "pointer", "initialState"]) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.pointer) &&
    isStrictProtocolJson(value.initialState)
  );
}

function isConformanceCase(value: unknown): value is AdapterConformanceCaseV2 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "name",
      "initialState",
      "call",
      "expectedResult",
      "expectedFinalState",
    ]) ||
    !isNonEmptyString(value.name) ||
    !isStrictProtocolJson(value.initialState) ||
    !isStrictProtocolJson(value.expectedResult) ||
    !isStrictProtocolJson(value.expectedFinalState) ||
    !isRecord(value.call) ||
    !hasExactKeys(value.call, ["tool", "arguments"]) ||
    !isNonEmptyString(value.call.tool) ||
    !isStrictProtocolJson(value.call.arguments)
  ) {
    return false;
  }
  return true;
}

export function isAdapterDescriptorV2(
  value: unknown,
): value is AdapterDescriptorV2 {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "apiVersion",
      "id",
      "version",
      "tools",
      "conformance",
    ]) &&
    value.apiVersion === EXTERNAL_ADAPTER_API_VERSION &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.version) &&
    isStringArray(value.tools, true) &&
    Array.isArray(value.conformance) &&
    value.conformance.length > 0 &&
    value.conformance.every(isConformanceCase)
  );
}

export function parseAdapterHostRequest(
  value: unknown,
): AdapterHostRequest | undefined {
  if (!isRecord(value) || !isRequestBase(value) || !isProtocolPayload(value)) {
    return undefined;
  }
  if (value.type === "validate") {
    return hasExactKeys(value, [
      "v",
      "nonce",
      "seq",
      "type",
      "timeoutMs",
      "target",
      "suite",
      "pointers",
    ]) &&
      isTimeout(value.timeoutMs) &&
      isStrictProtocolJson(value.target) &&
      isStrictProtocolJson(value.suite) &&
      Array.isArray(value.pointers) &&
      value.pointers.every(isPointerRequest)
      ? (value as unknown as ValidateRequest)
      : undefined;
  }
  if (value.type === "initialize") {
    return hasExactKeys(value, [
      "v",
      "nonce",
      "seq",
      "type",
      "timeoutMs",
      "scenarioId",
      "target",
      "initialState",
    ]) &&
      isTimeout(value.timeoutMs) &&
      isNonEmptyString(value.scenarioId) &&
      isStrictProtocolJson(value.target) &&
      isStrictProtocolJson(value.initialState)
      ? (value as unknown as InitializeRequest)
      : undefined;
  }
  if (value.type === "transition") {
    if (
      value.invoke === false &&
      hasExactKeys(value, [
        "v",
        "nonce",
        "seq",
        "type",
        "timeoutMs",
        "invoke",
      ]) &&
      isTimeout(value.timeoutMs)
    ) {
      return value as unknown as ObserveTransitionRequest;
    }
    return value.invoke === true &&
      hasExactKeys(value, [
        "v",
        "nonce",
        "seq",
        "type",
        "timeoutMs",
        "invoke",
        "tool",
        "arguments",
      ]) &&
      isTimeout(value.timeoutMs) &&
      isNonEmptyString(value.tool) &&
      isStrictProtocolJson(value.arguments)
      ? (value as unknown as InvokeTransitionRequest)
      : undefined;
  }
  if (value.type === "snapshot" || value.type === "close") {
    return hasExactKeys(value, [
      "v",
      "nonce",
      "seq",
      "type",
      "timeoutMs",
    ]) && isTimeout(value.timeoutMs)
      ? (value as unknown as SnapshotRequest | CloseRequest)
      : undefined;
  }
  if (value.type === "cancel") {
    return hasExactKeys(value, [
      "v",
      "nonce",
      "seq",
      "type",
      "targetSeq",
      "reason",
    ]) &&
      isSequence(value.targetSeq) &&
      isNonEmptyString(value.reason)
      ? (value as unknown as CancelRequest)
      : undefined;
  }
  return undefined;
}

function isResponseBase(value: Record<string, unknown>): boolean {
  return (
    value.v === ADAPTER_HOST_PROTOCOL_VERSION &&
    isNonEmptyString(value.nonce) &&
    value.nonce.length <= 128 &&
    isSequence(value.seq, true)
  );
}

function isPointerResult(value: unknown): value is PointerValidationResult {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["id", "issue"]) &&
    isNonEmptyString(value.id) &&
    (value.issue === null || isNonEmptyString(value.issue))
  );
}

function isToolError(value: unknown): value is { code: string; message: string } {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["code", "message"]) &&
    isNonEmptyString(value.code) &&
    isNonEmptyString(value.message)
  );
}

function isTransitionOutcome(value: unknown): value is TransitionOutcome {
  if (!isRecord(value) || !isNonEmptyString(value.kind)) {
    return false;
  }
  if (value.kind === "ok") {
    return (
      hasExactKeys(value, ["kind", "content"]) &&
      isStrictProtocolJson(value.content)
    );
  }
  if (value.kind === "tool_error") {
    return hasExactKeys(value, ["kind", "error"]) && isToolError(value.error);
  }
  return value.kind === "skipped" && hasExactKeys(value, ["kind"]);
}

export function parseAdapterHostResponse(
  value: unknown,
): AdapterHostResponse | undefined {
  if (!isRecord(value) || !isResponseBase(value) || !isProtocolPayload(value)) {
    return undefined;
  }
  if (value.type === "ready") {
    return hasExactKeys(value, [
      "v",
      "nonce",
      "seq",
      "type",
      "mode",
      "moduleDigest",
      "descriptor",
    ]) &&
      value.seq === 0 &&
      (value.mode === "inspect" || value.mode === "scenario") &&
      isDigest(value.moduleDigest) &&
      isAdapterDescriptorV2(value.descriptor)
      ? (value as unknown as ReadyResponse)
      : undefined;
  }
  if (value.type === "validation_result") {
    return hasExactKeys(value, [
      "v",
      "nonce",
      "seq",
      "type",
      "issues",
      "pointers",
    ]) &&
      isStringArray(value.issues, false, false) &&
      Array.isArray(value.pointers) &&
      value.pointers.every(isPointerResult)
      ? (value as unknown as ValidationResponse)
      : undefined;
  }
  if (value.type === "initialized") {
    return hasExactKeys(value, [
      "v",
      "nonce",
      "seq",
      "type",
      "tools",
      "initialState",
    ]) &&
      isStringArray(value.tools, true) &&
      isStrictProtocolJson(value.initialState)
      ? (value as unknown as InitializedResponse)
      : undefined;
  }
  if (value.type === "transition_result") {
    return hasExactKeys(value, [
      "v",
      "nonce",
      "seq",
      "type",
      "beforeState",
      "afterState",
      "outcome",
    ]) &&
      isStrictProtocolJson(value.beforeState) &&
      isStrictProtocolJson(value.afterState) &&
      isTransitionOutcome(value.outcome)
      ? (value as unknown as TransitionResponse)
      : undefined;
  }
  if (value.type === "snapshot_result") {
    return hasExactKeys(value, [
      "v",
      "nonce",
      "seq",
      "type",
      "state",
    ]) && isStrictProtocolJson(value.state)
      ? (value as unknown as SnapshotResponse)
      : undefined;
  }
  if (value.type === "closed") {
    return hasExactKeys(value, ["v", "nonce", "seq", "type"])
      ? (value as unknown as ClosedResponse)
      : undefined;
  }
  if (value.type === "operation_error" || value.type === "fatal") {
    return hasExactKeys(value, [
      "v",
      "nonce",
      "seq",
      "type",
      "phase",
      "message",
    ]) &&
      isNonEmptyString(value.phase) &&
      isNonEmptyString(value.message)
      ? (value as unknown as OperationErrorResponse | FatalResponse)
      : undefined;
  }
  return undefined;
}

export function cloneProtocolJson<T extends ProtocolJsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
