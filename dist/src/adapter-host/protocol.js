export const ADAPTER_HOST_PROTOCOL_VERSION = "agentci.adapter-host.v1";
export const EXTERNAL_ADAPTER_API_VERSION = "agentci.adapter.v2";
export const MAX_PROTOCOL_MESSAGE_BYTES = 1024 * 1024;
export const MAX_PROTOCOL_JSON_DEPTH = 64;
export const MAX_PROTOCOL_JSON_NODES = 100_000;
export const MAX_OPERATION_TIMEOUT_MS = 60_000;
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function hasExactKeys(value, keys) {
    const actual = Object.keys(value);
    return actual.length === keys.length && actual.every((key) => keys.includes(key));
}
function isNonEmptyString(value) {
    return typeof value === "string" && value.length > 0;
}
function isSequence(value, allowZero = false) {
    return (Number.isSafeInteger(value) &&
        value >= (allowZero ? 0 : 1));
}
function isTimeout(value) {
    return (Number.isInteger(value) &&
        value > 0 &&
        value <= MAX_OPERATION_TIMEOUT_MS);
}
function isDigest(value) {
    return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function isStringArray(value, requireNonEmpty = false, requireUnique = true) {
    return (Array.isArray(value) &&
        (!requireNonEmpty || value.length > 0) &&
        value.every(isNonEmptyString) &&
        (!requireUnique || new Set(value).size === value.length));
}
function isStrictJsonValueAt(value, depth, state) {
    state.nodes += 1;
    if (state.nodes > MAX_PROTOCOL_JSON_NODES ||
        depth > MAX_PROTOCOL_JSON_DEPTH) {
        return false;
    }
    if (value === null ||
        typeof value === "string" ||
        typeof value === "boolean") {
        return true;
    }
    if (typeof value === "number") {
        return Number.isFinite(value);
    }
    if (typeof value !== "object") {
        return false;
    }
    const object = value;
    if (state.ancestors.has(object)) {
        return false;
    }
    state.ancestors.add(object);
    try {
        if (Array.isArray(value)) {
            const keys = Reflect.ownKeys(value);
            if (keys.length !== value.length + 1 ||
                !keys.includes("length") ||
                keys.some((key) => typeof key !== "string" ||
                    (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key)))) {
                return false;
            }
            for (let index = 0; index < value.length; index += 1) {
                if (!Object.prototype.hasOwnProperty.call(value, index) ||
                    !isStrictJsonValueAt(value[index], depth + 1, state)) {
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
            if (descriptor === undefined ||
                !descriptor.enumerable ||
                !("value" in descriptor) ||
                !isStrictJsonValueAt(descriptor.value, depth + 1, state)) {
                return false;
            }
        }
        return true;
    }
    catch {
        return false;
    }
    finally {
        state.ancestors.delete(object);
    }
}
export function isStrictProtocolJson(value) {
    return isStrictJsonValueAt(value, 0, {
        nodes: 0,
        ancestors: new Set(),
    });
}
export function protocolMessageSize(value) {
    if (!isStrictProtocolJson(value)) {
        return undefined;
    }
    try {
        return Buffer.byteLength(JSON.stringify(value), "utf8");
    }
    catch {
        return undefined;
    }
}
export function isProtocolPayload(value) {
    const size = protocolMessageSize(value);
    return size !== undefined && size <= MAX_PROTOCOL_MESSAGE_BYTES;
}
function isRequestBase(value) {
    return (value.v === ADAPTER_HOST_PROTOCOL_VERSION &&
        isNonEmptyString(value.nonce) &&
        value.nonce.length <= 128 &&
        isSequence(value.seq));
}
function isPointerRequest(value) {
    return (isRecord(value) &&
        hasExactKeys(value, ["id", "pointer", "initialState"]) &&
        isNonEmptyString(value.id) &&
        isNonEmptyString(value.pointer) &&
        isStrictProtocolJson(value.initialState));
}
function isConformanceCase(value) {
    if (!isRecord(value) ||
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
        !isStrictProtocolJson(value.call.arguments)) {
        return false;
    }
    return true;
}
export function isAdapterDescriptorV2(value) {
    return (isRecord(value) &&
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
        value.conformance.every(isConformanceCase));
}
export function parseAdapterHostRequest(value) {
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
            ? value
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
            ? value
            : undefined;
    }
    if (value.type === "transition") {
        if (value.invoke === false &&
            hasExactKeys(value, [
                "v",
                "nonce",
                "seq",
                "type",
                "timeoutMs",
                "invoke",
            ]) &&
            isTimeout(value.timeoutMs)) {
            return value;
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
            ? value
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
            ? value
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
            ? value
            : undefined;
    }
    return undefined;
}
function isResponseBase(value) {
    return (value.v === ADAPTER_HOST_PROTOCOL_VERSION &&
        isNonEmptyString(value.nonce) &&
        value.nonce.length <= 128 &&
        isSequence(value.seq, true));
}
function isPointerResult(value) {
    return (isRecord(value) &&
        hasExactKeys(value, ["id", "issue"]) &&
        isNonEmptyString(value.id) &&
        (value.issue === null || isNonEmptyString(value.issue)));
}
function isToolError(value) {
    return (isRecord(value) &&
        hasExactKeys(value, ["code", "message"]) &&
        isNonEmptyString(value.code) &&
        isNonEmptyString(value.message));
}
function isTransitionOutcome(value) {
    if (!isRecord(value) || !isNonEmptyString(value.kind)) {
        return false;
    }
    if (value.kind === "ok") {
        return (hasExactKeys(value, ["kind", "content"]) &&
            isStrictProtocolJson(value.content));
    }
    if (value.kind === "tool_error") {
        return hasExactKeys(value, ["kind", "error"]) && isToolError(value.error);
    }
    return value.kind === "skipped" && hasExactKeys(value, ["kind"]);
}
export function parseAdapterHostResponse(value) {
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
            ? value
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
            ? value
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
            ? value
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
            ? value
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
            ? value
            : undefined;
    }
    if (value.type === "closed") {
        return hasExactKeys(value, ["v", "nonce", "seq", "type"])
            ? value
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
            ? value
            : undefined;
    }
    return undefined;
}
export function cloneProtocolJson(value) {
    return JSON.parse(JSON.stringify(value));
}
