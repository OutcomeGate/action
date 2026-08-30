import { createHash, randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { assertNoKnownSecretLeaksAtJsonBoundary, knownSecretsFromCredentialEnv, } from "../credential-policy.js";
import { ADAPTER_HOST_PROTOCOL_VERSION, MAX_OPERATION_TIMEOUT_MS, cloneProtocolJson, isProtocolPayload, parseAdapterHostResponse, } from "./protocol.js";
const DEFAULT_STARTUP_TIMEOUT_MS = 5_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 5_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;
const ABORT_GRACE_MS = 100;
const TERM_GRACE_MS = 250;
const KILL_GRACE_MS = 250;
const DIAGNOSTIC_LIMIT_BYTES = 16_384;
export class AdapterHostClientError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "AdapterHostClientError";
        this.code = code;
    }
}
function deferred() {
    let resolveValue;
    let rejectValue;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolveValue = resolvePromise;
        rejectValue = rejectPromise;
    });
    return { promise, resolve: resolveValue, reject: rejectValue };
}
function boundedTimeout(value, fallback) {
    const selected = value ?? fallback;
    if (!Number.isInteger(selected) ||
        selected <= 0 ||
        selected > MAX_OPERATION_TIMEOUT_MS) {
        throw new AdapterHostClientError("invalid_state", `adapter-host timeout must be from 1 through ${MAX_OPERATION_TIMEOUT_MS}ms`);
    }
    return selected;
}
function sha256(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}
function cleanReason(error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.replaceAll("\r", " ").replaceAll("\n", " ").slice(0, 2_048);
}
function scanForSecrets(value, knownSecrets) {
    try {
        assertNoKnownSecretLeaksAtJsonBoundary(value, knownSecrets);
    }
    catch {
        throw new AdapterHostClientError("secret_leak", "known credential material attempted to cross the adapter-host protocol");
    }
}
export class AdapterHostClient {
    mode;
    nonce;
    adapterPath;
    target;
    expectedModuleDigest;
    child;
    operationTimeoutMs;
    shutdownTimeoutMs;
    knownSecrets;
    readyDeferred = deferred();
    processClosedDeferred = deferred();
    terminalListeners = new Set();
    state = "starting";
    scenarioState = "uninitialized";
    sequence = 0;
    pending;
    descriptorValue;
    moduleDigestValue;
    terminalError;
    exitValue;
    expectedNormalExit = false;
    terminationPromise;
    stdoutBytes = Buffer.alloc(0);
    stderrBytes = Buffer.alloc(0);
    stdoutDecoder = new StringDecoder("utf8");
    stderrDecoder = new StringDecoder("utf8");
    stdoutSecretTail = "";
    stderrSecretTail = "";
    stdoutTruncated = false;
    stderrTruncated = false;
    constructor(options) {
        this.child = options.child;
        this.adapterPath = options.adapterPath;
        this.mode = options.mode;
        this.nonce = options.nonce;
        this.target = cloneProtocolJson(options.target);
        this.knownSecrets = options.knownSecrets;
        this.expectedModuleDigest = options.expectedModuleDigest;
        this.operationTimeoutMs = options.operationTimeoutMs;
        this.shutdownTimeoutMs = options.shutdownTimeoutMs;
        this.attachChildListeners();
    }
    static async spawn(options) {
        const startupTimeoutMs = boundedTimeout(options.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS);
        const operationTimeoutMs = boundedTimeout(options.operationTimeoutMs, DEFAULT_OPERATION_TIMEOUT_MS);
        const shutdownTimeoutMs = boundedTimeout(options.shutdownTimeoutMs, DEFAULT_SHUTDOWN_TIMEOUT_MS);
        if (!isProtocolPayload(options.target)) {
            throw new AdapterHostClientError("protocol_error", "adapter target must be finite plain JSON within the protocol limit");
        }
        const adapterPath = resolve(options.adapterPath);
        const expectedModuleDigest = options.expectedModuleDigest ?? sha256(await readFile(adapterPath));
        if (!/^[a-f0-9]{64}$/.test(expectedModuleDigest)) {
            throw new AdapterHostClientError("identity_mismatch", "expected adapter module digest must be lowercase SHA-256");
        }
        const credentialEnvironment = Object.freeze({
            ...(options.credentialEnvironment ?? {}),
        });
        const adapterSecrets = knownSecretsFromCredentialEnv(credentialEnvironment);
        const protectedSecrets = Object.freeze((options.protectedSecrets ?? []).map((secret, index) => Object.freeze({
            ruleId: `protected:${index + 1}`,
            value: secret.value,
        })));
        const knownSecrets = Object.freeze([
            ...adapterSecrets,
            ...protectedSecrets,
        ]);
        scanForSecrets(options.target, knownSecrets);
        const credentialNames = Object.keys(credentialEnvironment).sort();
        const nonce = randomUUID();
        const hostPath = options.hostPath ?? fileURLToPath(new URL("./main.js", import.meta.url));
        const hostWorkingDirectory = options.cwd ?? dirname(adapterPath);
        const credentialNamesArgument = JSON.stringify(credentialNames);
        scanForSecrets({
            executable: process.execPath,
            modulePath: hostPath,
            arguments: [
                options.mode,
                adapterPath,
                nonce,
                credentialNamesArgument,
            ],
            cwd: hostWorkingDirectory,
            environmentNames: credentialNames,
        }, protectedSecrets);
        let child;
        try {
            child = fork(hostPath, [options.mode, adapterPath, nonce, credentialNamesArgument], {
                cwd: hostWorkingDirectory,
                detached: process.platform !== "win32",
                env: { ...credentialEnvironment },
                execArgv: [],
                serialization: "json",
                silent: true,
            });
        }
        catch (error) {
            throw new AdapterHostClientError("spawn_failed", `adapter host could not be spawned: ${cleanReason(error)}`);
        }
        const client = new AdapterHostClient({
            child,
            adapterPath,
            mode: options.mode,
            nonce,
            target: options.target,
            credentialEnvironment,
            knownSecrets,
            expectedModuleDigest,
            operationTimeoutMs,
            shutdownTimeoutMs,
        });
        await client.waitForReady(startupTimeoutMs);
        return client;
    }
    get descriptor() {
        if (this.descriptorValue === undefined) {
            throw new AdapterHostClientError("invalid_state", "adapter host has not completed its handshake");
        }
        return structuredClone(this.descriptorValue);
    }
    get moduleDigest() {
        if (this.moduleDigestValue === undefined) {
            throw new AdapterHostClientError("invalid_state", "adapter host has not completed its handshake");
        }
        return this.moduleDigestValue;
    }
    get usable() {
        return this.state === "idle";
    }
    get diagnostics() {
        return {
            stdout: this.stdoutBytes.toString("utf8"),
            stderr: this.stderrBytes.toString("utf8"),
            stdoutTruncated: this.stdoutTruncated,
            stderrTruncated: this.stderrTruncated,
        };
    }
    get exit() {
        return this.exitValue;
    }
    onTerminal(listener) {
        this.terminalListeners.add(listener);
        if (this.terminalError !== undefined) {
            listener(this.terminalError);
        }
        return () => this.terminalListeners.delete(listener);
    }
    async validate(options) {
        this.requireMode("inspect", "validate");
        const timeoutMs = boundedTimeout(options.timeoutMs, this.operationTimeoutMs);
        return (await this.request({
            type: "validate",
            timeoutMs,
            target: cloneProtocolJson(this.target),
            suite: cloneProtocolJson(options.suite),
            pointers: cloneProtocolJson(options.pointers),
        }, "validation_result", timeoutMs));
    }
    async initialize(options) {
        this.requireMode("scenario", "initialize");
        if (this.scenarioState !== "uninitialized") {
            throw this.invalidState("initialize may run exactly once");
        }
        const timeoutMs = boundedTimeout(options.timeoutMs, this.operationTimeoutMs);
        const response = (await this.request({
            type: "initialize",
            timeoutMs,
            scenarioId: options.scenarioId,
            target: cloneProtocolJson(this.target),
            initialState: cloneProtocolJson(options.initialState),
        }, "initialized", timeoutMs));
        this.scenarioState = "active";
        return response;
    }
    async transition(options) {
        this.requireActiveScenario("transition");
        const timeoutMs = boundedTimeout(options.timeoutMs, this.operationTimeoutMs);
        const partial = options.invoke
            ? {
                type: "transition",
                timeoutMs,
                invoke: true,
                tool: options.tool ?? "",
                arguments: cloneProtocolJson(options.arguments ?? null),
            }
            : {
                type: "transition",
                timeoutMs,
                invoke: false,
            };
        if (partial.invoke && partial.tool.length === 0) {
            throw this.invalidState("invoked transitions require a non-empty tool name");
        }
        return (await this.request(partial, "transition_result", timeoutMs));
    }
    async snapshot(timeoutMs) {
        this.requireActiveScenario("snapshot");
        const bounded = boundedTimeout(timeoutMs, this.operationTimeoutMs);
        return (await this.request({ type: "snapshot", timeoutMs: bounded }, "snapshot_result", bounded));
    }
    async close(timeoutMs) {
        if (this.mode === "scenario") {
            this.requireActiveScenario("close");
        }
        else {
            this.requireIdle("close");
        }
        const bounded = boundedTimeout(timeoutMs, this.shutdownTimeoutMs);
        await this.request({ type: "close", timeoutMs: bounded }, "closed", bounded);
        this.state = "closing";
        this.scenarioState = "closed";
        this.expectedNormalExit = true;
        const exit = await this.waitForExit(bounded);
        if (exit === undefined) {
            const error = new AdapterHostClientError("timeout", "adapter host acknowledged close but did not exit before its deadline");
            await this.poison(error);
            throw error;
        }
        if (exit.code !== 0 || exit.signal !== null) {
            const error = new AdapterHostClientError("host_crashed", `adapter host exited after close with code ${String(exit.code)} and signal ${String(exit.signal)}`);
            this.recordTerminal(error);
            this.state = "poisoned";
            throw error;
        }
        if (this.terminalError !== undefined) {
            this.state = "poisoned";
            throw this.terminalError;
        }
        this.state = "closed";
        this.killProcessGroup("SIGKILL");
    }
    async cancel(reason = "adapter-host operation cancelled") {
        const error = new AdapterHostClientError("cancelled", cleanReason(reason));
        await this.poison(error);
    }
    attachChildListeners() {
        this.child.stdout?.on("data", (chunk) => {
            this.consumeDiagnostic("stdout", chunk, false);
        });
        this.child.stdout?.once("end", () => this.consumeDiagnostic("stdout", "", true));
        this.child.stderr?.on("data", (chunk) => {
            this.consumeDiagnostic("stderr", chunk, false);
        });
        this.child.stderr?.once("end", () => this.consumeDiagnostic("stderr", "", true));
        this.child.on("message", (message) => {
            this.handleMessage(message);
        });
        this.child.once("error", (error) => {
            void this.poison(new AdapterHostClientError("spawn_failed", `adapter host process error: ${cleanReason(error)}`));
        });
        this.child.once("exit", (code, signal) => {
            const exit = { code, signal };
            this.exitValue = exit;
            if (!this.expectedNormalExit &&
                this.state !== "poisoned" &&
                this.state !== "closed") {
                void this.poison(new AdapterHostClientError("host_crashed", `adapter host exited unexpectedly with code ${String(code)} and signal ${String(signal)}`));
            }
        });
        this.child.once("close", (code, signal) => {
            const exit = this.exitValue ?? { code, signal };
            this.exitValue = exit;
            this.processClosedDeferred.resolve(exit);
        });
    }
    appendDiagnostic(current, chunk) {
        const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remaining = Math.max(0, DIAGNOSTIC_LIMIT_BYTES - current.byteLength);
        return {
            bytes: remaining === 0
                ? current
                : Buffer.concat([current, incoming.subarray(0, remaining)]),
            truncated: incoming.byteLength > remaining,
        };
    }
    consumeDiagnostic(stream, chunk, final) {
        const decoder = stream === "stdout" ? this.stdoutDecoder : this.stderrDecoder;
        const decoded = final
            ? decoder.end()
            : decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        let combined = `${stream === "stdout" ? this.stdoutSecretTail : this.stderrSecretTail}${decoded}`;
        let leaked = false;
        for (const secret of this.knownSecrets) {
            if (combined.includes(secret.value)) {
                leaked = true;
                combined = combined.replaceAll(secret.value, "[REDACTED]");
            }
        }
        const longestSecret = this.knownSecrets.reduce((longest, secret) => Math.max(longest, secret.value.length), 0);
        const retainedCharacters = final
            ? 0
            : Math.min(Math.max(0, longestSecret - 1), DIAGNOSTIC_LIMIT_BYTES);
        const splitAt = Math.max(0, combined.length - retainedCharacters);
        const safePrefix = combined.slice(0, splitAt);
        const secretTail = combined.slice(splitAt);
        if (stream === "stdout") {
            const appended = this.appendDiagnostic(this.stdoutBytes, safePrefix);
            this.stdoutBytes = appended.bytes;
            this.stdoutTruncated ||= appended.truncated;
            this.stdoutSecretTail = secretTail;
        }
        else {
            const appended = this.appendDiagnostic(this.stderrBytes, safePrefix);
            this.stderrBytes = appended.bytes;
            this.stderrTruncated ||= appended.truncated;
            this.stderrSecretTail = secretTail;
        }
        if (leaked) {
            void this.poison(new AdapterHostClientError("secret_leak", `known credential material appeared in adapter ${stream} diagnostics`));
        }
    }
    async waitForReady(timeoutMs) {
        let timer;
        try {
            await Promise.race([
                this.readyDeferred.promise,
                new Promise((_resolve, reject) => {
                    timer = setTimeout(() => {
                        reject(new AdapterHostClientError("timeout", `adapter host did not become ready within ${timeoutMs}ms`));
                    }, timeoutMs);
                }),
            ]);
        }
        catch (error) {
            const failure = error instanceof AdapterHostClientError
                ? error
                : new AdapterHostClientError("spawn_failed", cleanReason(error));
            await this.poison(failure);
            throw failure;
        }
        finally {
            if (timer !== undefined) {
                clearTimeout(timer);
            }
        }
    }
    handleMessage(raw) {
        if (this.state === "poisoned" || this.state === "closed") {
            return;
        }
        let response;
        try {
            if (!isProtocolPayload(raw)) {
                throw new AdapterHostClientError("protocol_error", "adapter host sent a non-JSON or oversized response");
            }
            scanForSecrets(raw, this.knownSecrets);
            response = parseAdapterHostResponse(raw);
            if (response === undefined) {
                throw new AdapterHostClientError("protocol_error", "adapter host sent an invalid response");
            }
            if (response.nonce !== this.nonce) {
                throw new AdapterHostClientError("protocol_error", "adapter host response nonce did not match");
            }
        }
        catch (error) {
            void this.poison(error instanceof AdapterHostClientError
                ? error
                : new AdapterHostClientError("protocol_error", cleanReason(error)));
            return;
        }
        if (this.state === "starting") {
            if (response.type === "fatal") {
                const error = new AdapterHostClientError("host_operation_failed", `adapter host ${response.phase} failed: ${response.message}`);
                this.readyDeferred.reject(error);
                void this.poison(error);
                return;
            }
            if (response.type !== "ready" ||
                response.seq !== 0 ||
                response.mode !== this.mode) {
                const error = new AdapterHostClientError("protocol_error", "adapter host did not begin with the expected ready response");
                this.readyDeferred.reject(error);
                void this.poison(error);
                return;
            }
            if (response.moduleDigest !== this.expectedModuleDigest) {
                const error = new AdapterHostClientError("identity_mismatch", "adapter module digest changed between capture and host import");
                this.readyDeferred.reject(error);
                void this.poison(error);
                return;
            }
            this.moduleDigestValue = response.moduleDigest;
            this.descriptorValue = response.descriptor;
            this.state = "idle";
            this.readyDeferred.resolve();
            return;
        }
        const pending = this.pending;
        if (pending === undefined) {
            void this.poison(new AdapterHostClientError("protocol_error", "adapter host sent an unsolicited or late response"));
            return;
        }
        if (performance.now() >= pending.deadlineAt) {
            void this.poison(new AdapterHostClientError("timeout", "adapter host response lost the operation deadline race"));
            return;
        }
        if (response.seq !== pending.seq) {
            void this.poison(new AdapterHostClientError("protocol_error", "adapter host response sequence did not match the pending request"));
            return;
        }
        if (response.type === "operation_error" || response.type === "fatal") {
            void this.poison(new AdapterHostClientError("host_operation_failed", `adapter host ${response.phase} failed: ${response.message}`));
            return;
        }
        if (response.type !== pending.expectedType) {
            void this.poison(new AdapterHostClientError("protocol_error", `adapter host returned ${response.type} while ${pending.expectedType} was pending`));
            return;
        }
        clearTimeout(pending.timer);
        this.pending = undefined;
        if (response.type === "closed") {
            this.expectedNormalExit = true;
        }
        this.state = response.type === "closed" ? "closing" : "idle";
        pending.resolve(response);
    }
    async request(partial, expectedType, timeoutMs) {
        this.requireIdle(partial.type);
        const seq = ++this.sequence;
        const request = {
            v: ADAPTER_HOST_PROTOCOL_VERSION,
            nonce: this.nonce,
            seq,
            ...partial,
        };
        if (!isProtocolPayload(request)) {
            throw new AdapterHostClientError("protocol_error", "adapter-host request exceeded the protocol boundary");
        }
        scanForSecrets(request, this.knownSecrets);
        this.state = "pending";
        return await new Promise((resolveRequest, rejectRequest) => {
            const deadlineAt = performance.now() + timeoutMs;
            const timer = setTimeout(() => {
                void this.poison(new AdapterHostClientError("timeout", `${partial.type} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            this.pending = {
                seq,
                expectedType,
                deadlineAt,
                timer,
                resolve: resolveRequest,
                reject: rejectRequest,
            };
            if (!this.child.connected) {
                void this.poison(new AdapterHostClientError("host_crashed", "adapter-host IPC channel closed before the request was sent"));
                return;
            }
            try {
                this.child.send(request, (error) => {
                    if (error !== null) {
                        void this.poison(new AdapterHostClientError("host_crashed", `adapter-host request could not be sent: ${cleanReason(error)}`));
                    }
                });
            }
            catch (error) {
                void this.poison(new AdapterHostClientError("host_crashed", `adapter-host request could not be sent: ${cleanReason(error)}`));
            }
        });
    }
    async poison(error) {
        if (this.state === "closed") {
            return;
        }
        if (this.terminalError === undefined) {
            this.recordTerminal(error);
        }
        this.state = "poisoned";
        this.readyDeferred.reject(error);
        const pending = this.pending;
        this.pending = undefined;
        if (pending !== undefined) {
            clearTimeout(pending.timer);
        }
        let terminalFailure = error;
        try {
            await this.terminateProcess(pending?.seq, error.message);
        }
        catch (containmentError) {
            terminalFailure =
                containmentError instanceof AdapterHostClientError
                    ? containmentError
                    : new AdapterHostClientError("containment_failed", cleanReason(containmentError));
            this.recordTerminal(terminalFailure);
        }
        pending?.reject(terminalFailure);
    }
    recordTerminal(error) {
        this.terminalError ??= error;
        for (const listener of this.terminalListeners) {
            listener(error);
        }
    }
    async terminateProcess(pendingSequence, reason) {
        if (this.terminationPromise !== undefined) {
            return this.terminationPromise;
        }
        this.terminationPromise = (async () => {
            if (pendingSequence !== undefined &&
                this.child.connected &&
                this.exitValue === undefined) {
                const cancel = {
                    v: ADAPTER_HOST_PROTOCOL_VERSION,
                    nonce: this.nonce,
                    seq: ++this.sequence,
                    type: "cancel",
                    targetSeq: pendingSequence,
                    reason: cleanReason(reason) || "adapter-host request cancelled",
                };
                try {
                    if (isProtocolPayload(cancel)) {
                        this.child.send(cancel, () => undefined);
                    }
                }
                catch {
                    // IPC disconnect and OS signals are the fallback containment path.
                }
            }
            this.child.stdin?.end();
            if ((await this.waitForExit(ABORT_GRACE_MS)) !== undefined) {
                this.killProcessGroup("SIGKILL");
                return;
            }
            this.killProcessGroup("SIGTERM");
            if ((await this.waitForExit(TERM_GRACE_MS)) !== undefined) {
                this.killProcessGroup("SIGKILL");
                return;
            }
            this.killProcessGroup("SIGKILL");
            if ((await this.waitForExit(KILL_GRACE_MS)) === undefined) {
                throw new AdapterHostClientError("containment_failed", "adapter host did not exit after process-group SIGKILL");
            }
            this.killProcessGroup("SIGKILL");
        })();
        return this.terminationPromise;
    }
    killProcessGroup(signal) {
        const pid = this.child.pid;
        if (pid === undefined) {
            return;
        }
        if (process.platform !== "win32") {
            try {
                process.kill(-pid, signal);
                return;
            }
            catch (error) {
                if (error.code !== "ESRCH") {
                    try {
                        this.child.kill(signal);
                    }
                    catch {
                        // The bounded exit wait determines whether containment succeeded.
                    }
                }
                return;
            }
        }
        try {
            this.child.kill(signal);
        }
        catch {
            // The bounded exit wait determines whether containment succeeded.
        }
    }
    async waitForExit(timeoutMs) {
        let timer;
        try {
            return await Promise.race([
                this.processClosedDeferred.promise,
                new Promise((resolveTimeout) => {
                    timer = setTimeout(() => resolveTimeout(undefined), timeoutMs);
                }),
            ]);
        }
        finally {
            if (timer !== undefined) {
                clearTimeout(timer);
            }
        }
    }
    requireMode(expected, operation) {
        if (this.mode !== expected) {
            throw this.invalidState(`${operation} requires ${expected} mode`);
        }
        this.requireIdle(operation);
    }
    requireActiveScenario(operation) {
        this.requireMode("scenario", operation);
        if (this.scenarioState !== "active") {
            throw this.invalidState(`${operation} requires an initialized scenario`);
        }
    }
    requireIdle(operation) {
        if (this.state !== "idle") {
            if (this.terminalError !== undefined) {
                throw this.terminalError;
            }
            throw this.invalidState(`${operation} requires an idle adapter host; current state is ${this.state}`);
        }
    }
    invalidState(message) {
        return new AdapterHostClientError("invalid_state", message);
    }
}
export async function spawnAdapterHost(options) {
    return AdapterHostClient.spawn(options);
}
