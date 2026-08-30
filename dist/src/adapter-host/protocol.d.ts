export declare const ADAPTER_HOST_PROTOCOL_VERSION: "agentci.adapter-host.v1";
export declare const EXTERNAL_ADAPTER_API_VERSION: "agentci.adapter.v2";
export declare const MAX_PROTOCOL_MESSAGE_BYTES: number;
export declare const MAX_PROTOCOL_JSON_DEPTH = 64;
export declare const MAX_PROTOCOL_JSON_NODES = 100000;
export declare const MAX_OPERATION_TIMEOUT_MS = 60000;
export type JsonPrimitive = string | number | boolean | null;
export type ProtocolJsonValue = JsonPrimitive | ProtocolJsonValue[] | {
    [key: string]: ProtocolJsonValue;
};
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
    call(tool: string, argumentsValue: ProtocolJsonValue, context: AdapterOperationContext): ProtocolJsonValue | Promise<ProtocolJsonValue>;
    snapshot(context: AdapterOperationContext): ProtocolJsonValue | Promise<ProtocolJsonValue>;
    close(context: AdapterOperationContext): void | Promise<void>;
}
export interface ExternalAdapterDefinitionV2 extends AdapterDescriptorV2 {
    validateSuite(suite: ProtocolJsonValue, context: AdapterOperationContext): string[] | Promise<string[]>;
    validateStatePointer(pointer: string, initialState: ProtocolJsonValue, context: AdapterOperationContext): string | undefined | Promise<string | undefined>;
    createEnvironment(initialState: ProtocolJsonValue, context: AdapterOperationContext): ExternalAdapterEnvironmentV2 | Promise<ExternalAdapterEnvironmentV2>;
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
export type TransitionRequest = InvokeTransitionRequest | ObserveTransitionRequest;
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
export type AdapterHostRequest = ValidateRequest | InitializeRequest | TransitionRequest | SnapshotRequest | CloseRequest | CancelRequest;
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
export type TransitionOutcome = {
    kind: "ok";
    content: ProtocolJsonValue;
} | {
    kind: "tool_error";
    error: {
        code: string;
        message: string;
    };
} | {
    kind: "skipped";
};
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
export type AdapterHostResponse = ReadyResponse | ValidationResponse | InitializedResponse | TransitionResponse | SnapshotResponse | ClosedResponse | OperationErrorResponse | FatalResponse;
export declare function isStrictProtocolJson(value: unknown): value is ProtocolJsonValue;
export declare function protocolMessageSize(value: unknown): number | undefined;
export declare function isProtocolPayload(value: unknown): value is ProtocolJsonValue;
export declare function isAdapterDescriptorV2(value: unknown): value is AdapterDescriptorV2;
export declare function parseAdapterHostRequest(value: unknown): AdapterHostRequest | undefined;
export declare function parseAdapterHostResponse(value: unknown): AdapterHostResponse | undefined;
export declare function cloneProtocolJson<T extends ProtocolJsonValue>(value: T): T;
export {};
