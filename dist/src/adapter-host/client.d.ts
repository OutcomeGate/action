import { type KnownSecret } from "../credential-policy.js";
import { type AdapterDescriptorV2, type AdapterHostMode, type InitializedResponse, type PointerValidationRequest, type ProtocolJsonValue, type SnapshotResponse, type TransitionResponse, type ValidationResponse } from "./protocol.js";
export type AdapterHostClientErrorCode = "cancelled" | "containment_failed" | "host_crashed" | "host_operation_failed" | "identity_mismatch" | "invalid_state" | "protocol_error" | "secret_leak" | "spawn_failed" | "timeout";
export declare class AdapterHostClientError extends Error {
    readonly code: AdapterHostClientErrorCode;
    constructor(code: AdapterHostClientErrorCode, message: string);
}
export interface AdapterHostClientOptions {
    adapterPath: string;
    mode: AdapterHostMode;
    target: ProtocolJsonValue;
    /** An already-authorized, minimal credential environment. */
    credentialEnvironment?: Readonly<Record<string, string>>;
    /** Inspection-only values that must not cross the host protocol or diagnostics. */
    protectedSecrets?: readonly KnownSecret[];
    expectedModuleDigest?: string;
    hostPath?: string;
    cwd?: string;
    startupTimeoutMs?: number;
    operationTimeoutMs?: number;
    shutdownTimeoutMs?: number;
}
export interface AdapterHostDiagnostics {
    stdout: string;
    stderr: string;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
}
export interface AdapterHostExit {
    code: number | null;
    signal: NodeJS.Signals | null;
}
export declare class AdapterHostClient {
    readonly mode: AdapterHostMode;
    readonly nonce: string;
    readonly adapterPath: string;
    readonly target: ProtocolJsonValue;
    readonly expectedModuleDigest: string;
    private readonly child;
    private readonly operationTimeoutMs;
    private readonly shutdownTimeoutMs;
    private readonly knownSecrets;
    private readonly readyDeferred;
    private readonly processClosedDeferred;
    private readonly terminalListeners;
    private state;
    private scenarioState;
    private sequence;
    private pending;
    private descriptorValue;
    private moduleDigestValue;
    private terminalError;
    private exitValue;
    private expectedNormalExit;
    private terminationPromise;
    private stdoutBytes;
    private stderrBytes;
    private readonly stdoutDecoder;
    private readonly stderrDecoder;
    private stdoutSecretTail;
    private stderrSecretTail;
    private stdoutTruncated;
    private stderrTruncated;
    private constructor();
    static spawn(options: AdapterHostClientOptions): Promise<AdapterHostClient>;
    get descriptor(): AdapterDescriptorV2;
    get moduleDigest(): string;
    get usable(): boolean;
    get diagnostics(): AdapterHostDiagnostics;
    get exit(): AdapterHostExit | undefined;
    onTerminal(listener: (error: AdapterHostClientError) => void): () => void;
    validate(options: {
        suite: ProtocolJsonValue;
        pointers: PointerValidationRequest[];
        timeoutMs?: number;
    }): Promise<ValidationResponse>;
    initialize(options: {
        scenarioId: string;
        initialState: ProtocolJsonValue;
        timeoutMs?: number;
    }): Promise<InitializedResponse>;
    transition(options: {
        invoke: boolean;
        tool?: string;
        arguments?: ProtocolJsonValue;
        timeoutMs?: number;
    }): Promise<TransitionResponse>;
    snapshot(timeoutMs?: number): Promise<SnapshotResponse>;
    close(timeoutMs?: number): Promise<void>;
    cancel(reason?: string): Promise<void>;
    private attachChildListeners;
    private appendDiagnostic;
    private consumeDiagnostic;
    private waitForReady;
    private handleMessage;
    private request;
    private poison;
    private recordTerminal;
    private terminateProcess;
    private killProcessGroup;
    private waitForExit;
    private requireMode;
    private requireActiveScenario;
    private requireIdle;
    private invalidState;
}
export declare function spawnAdapterHost(options: AdapterHostClientOptions): Promise<AdapterHostClient>;
