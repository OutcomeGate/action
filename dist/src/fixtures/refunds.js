import { cloneJson, isJsonValue } from "../canonical.js";
import { FixtureError, ToolCallError } from "../errors.js";
export const REFUND_TOOL_NAMES = [
    "orders.get",
    "refunds.list",
    "refunds.create",
    "tickets.get",
    "tickets.update",
    "notifications.send",
    "cases.escalate",
];
function isJsonRecord(value) {
    return value !== undefined && value !== null && !Array.isArray(value) && typeof value === "object";
}
function checkString(record, key, path, issues) {
    if (typeof record[key] !== "string" || record[key].length === 0) {
        issues.push(`${path}.${key} must be a non-empty string`);
    }
}
function checkPositiveNumber(record, key, path, issues) {
    const value = record[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        issues.push(`${path}.${key} must be a positive number`);
    }
}
export function validateRefundState(value) {
    const issues = [];
    if (!isJsonRecord(value)) {
        return ["initialState must be an object"];
    }
    const orders = value.orders;
    const tickets = value.tickets;
    const refunds = value.refunds;
    const notifications = value.notifications;
    const escalations = value.escalations;
    if (!isJsonRecord(orders)) {
        issues.push("initialState.orders must be an object");
    }
    else {
        for (const [key, rawOrder] of Object.entries(orders)) {
            const path = `initialState.orders.${key}`;
            if (!isJsonRecord(rawOrder)) {
                issues.push(`${path} must be an object`);
                continue;
            }
            checkString(rawOrder, "id", path, issues);
            checkPositiveNumber(rawOrder, "amount", path, issues);
            checkString(rawOrder, "currency", path, issues);
            checkString(rawOrder, "status", path, issues);
            if (typeof rawOrder.refundable !== "boolean") {
                issues.push(`${path}.refundable must be a boolean`);
            }
            if (rawOrder.id !== key) {
                issues.push(`${path}.id must equal its map key`);
            }
        }
    }
    if (!isJsonRecord(tickets)) {
        issues.push("initialState.tickets must be an object");
    }
    else {
        for (const [key, rawTicket] of Object.entries(tickets)) {
            const path = `initialState.tickets.${key}`;
            if (!isJsonRecord(rawTicket)) {
                issues.push(`${path} must be an object`);
                continue;
            }
            checkString(rawTicket, "id", path, issues);
            checkString(rawTicket, "orderId", path, issues);
            checkString(rawTicket, "status", path, issues);
            if (rawTicket.id !== key) {
                issues.push(`${path}.id must equal its map key`);
            }
            if (typeof rawTicket.orderId === "string" &&
                isJsonRecord(orders) &&
                orders[rawTicket.orderId] === undefined) {
                issues.push(`${path}.orderId must reference an existing order`);
            }
        }
    }
    if (!Array.isArray(refunds)) {
        issues.push("initialState.refunds must be an array");
    }
    else {
        const keys = new Set();
        refunds.forEach((rawRefund, index) => {
            const path = `initialState.refunds[${index}]`;
            if (!isJsonRecord(rawRefund)) {
                issues.push(`${path} must be an object`);
                return;
            }
            checkString(rawRefund, "id", path, issues);
            checkString(rawRefund, "orderId", path, issues);
            checkPositiveNumber(rawRefund, "amount", path, issues);
            checkString(rawRefund, "currency", path, issues);
            checkString(rawRefund, "idempotencyKey", path, issues);
            if (typeof rawRefund.idempotencyKey === "string") {
                if (keys.has(rawRefund.idempotencyKey)) {
                    issues.push(`${path}.idempotencyKey must be unique`);
                }
                keys.add(rawRefund.idempotencyKey);
            }
            if (typeof rawRefund.orderId === "string" &&
                isJsonRecord(orders) &&
                orders[rawRefund.orderId] === undefined) {
                issues.push(`${path}.orderId must reference an existing order`);
            }
        });
    }
    if (!Array.isArray(notifications)) {
        issues.push("initialState.notifications must be an array");
    }
    else {
        notifications.forEach((rawNotification, index) => {
            const path = `initialState.notifications[${index}]`;
            if (!isJsonRecord(rawNotification)) {
                issues.push(`${path} must be an object`);
                return;
            }
            checkString(rawNotification, "ticketId", path, issues);
            checkString(rawNotification, "template", path, issues);
        });
    }
    if (!Array.isArray(escalations)) {
        issues.push("initialState.escalations must be an array");
    }
    else {
        escalations.forEach((rawEscalation, index) => {
            const path = `initialState.escalations[${index}]`;
            if (!isJsonRecord(rawEscalation)) {
                issues.push(`${path} must be an object`);
                return;
            }
            checkString(rawEscalation, "ticketId", path, issues);
            checkString(rawEscalation, "reason", path, issues);
        });
    }
    return issues;
}
function pointerSegments(pointer) {
    if (!pointer.startsWith("/") || /~(?:[^01]|$)/.test(pointer)) {
        return undefined;
    }
    return pointer
        .slice(1)
        .split("/")
        .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}
const REFUND_STATE_PATHS = {
    orders: {
        kind: "map",
        fields: new Set(["id", "amount", "currency", "status", "refundable"]),
    },
    tickets: {
        kind: "map",
        fields: new Set(["id", "orderId", "status"]),
    },
    refunds: {
        kind: "array",
        fields: new Set(["id", "orderId", "amount", "currency", "idempotencyKey"]),
    },
    notifications: {
        kind: "array",
        fields: new Set(["ticketId", "template"]),
    },
    escalations: {
        kind: "array",
        fields: new Set(["ticketId", "reason"]),
    },
};
function validateRefundStatePointer(pointer, initialState) {
    const segments = pointerSegments(pointer);
    const root = segments?.[0];
    if (segments === undefined || root === undefined || root.length === 0) {
        return "must begin with a declared state root";
    }
    const shape = REFUND_STATE_PATHS[root];
    if (shape === undefined) {
        return "must begin with a declared state root";
    }
    if (segments.length === 1) {
        return undefined;
    }
    if (segments.length > 3) {
        return "is deeper than the refunds.v1 state contract";
    }
    const member = segments[1];
    if (member === undefined || member.length === 0) {
        return "must name a state member after its root";
    }
    if (shape.kind === "array" && !/^\d+$/.test(member)) {
        return `must use a numeric index below /${root}`;
    }
    if (shape.kind === "map") {
        if (!isJsonRecord(initialState)) {
            return "cannot be checked against malformed initial state";
        }
        const collection = initialState[root];
        if (!isJsonRecord(collection) || collection[member] === undefined) {
            return `names undeclared ${root} member ${member}`;
        }
    }
    const field = segments[2];
    if (field !== undefined && !shape.fields.has(field)) {
        return `uses unknown ${root} field ${field}`;
    }
    return undefined;
}
export function validateSuiteForFixture(suite) {
    if (suite.fixture !== "refunds.v1") {
        return [`unsupported fixture: ${suite.fixture}`];
    }
    const toolNames = new Set(REFUND_TOOL_NAMES);
    const issues = [];
    suite.scenarios.forEach((scenario, scenarioIndex) => {
        const prefix = `scenarios[${scenarioIndex}]`;
        issues.push(...validateRefundState(scenario.initialState).map((issue) => `${prefix}.${issue}`));
        const faultKeys = new Set();
        scenario.faults.forEach((fault, faultIndex) => {
            if (!toolNames.has(fault.tool)) {
                issues.push(`${prefix}.faults[${faultIndex}].tool is not available in refunds.v1`);
            }
            const key = `${fault.tool}:${fault.onCall}`;
            if (faultKeys.has(key)) {
                issues.push(`${prefix}.faults contains a duplicate schedule for ${key}`);
            }
            faultKeys.add(key);
        });
        scenario.assertions.forEach((assertion, assertionIndex) => {
            const assertionPath = `${prefix}.assertions[${assertionIndex}]`;
            if (assertion.type === "event_count" && !toolNames.has(assertion.tool)) {
                issues.push(`${assertionPath}.tool is not available in refunds.v1`);
            }
            if (assertion.type === "event_order") {
                assertion.tools.forEach((tool) => {
                    if (!toolNames.has(tool)) {
                        issues.push(`${assertionPath}.tools contains unavailable tool ${tool}`);
                    }
                });
            }
            if (assertion.type === "json_pointer") {
                if (assertion.source === "output" && assertion.operator === "absent") {
                    issues.push(`${assertionPath} cannot use an absent assertion on untyped candidate output`);
                }
                if (assertion.source === "state") {
                    const pointerIssue = validateRefundStatePointer(assertion.pointer, scenario.initialState);
                    if (pointerIssue !== undefined) {
                        issues.push(`${assertionPath}.pointer ${pointerIssue}`);
                    }
                }
            }
        });
    });
    return issues;
}
function asRecord(value, label) {
    if (value === null || Array.isArray(value) || typeof value !== "object") {
        throw new ToolCallError("invalid_arguments", `${label} must be an object`);
    }
    return value;
}
function requiredString(record, key) {
    const value = record[key];
    if (typeof value !== "string" || value.length === 0) {
        throw new ToolCallError("invalid_arguments", `${key} must be a non-empty string`);
    }
    return value;
}
function requiredNumber(record, key) {
    const value = record[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        throw new ToolCallError("invalid_arguments", `${key} must be a positive number`);
    }
    return value;
}
function assertState(value) {
    const issues = validateRefundState(value);
    if (issues.length > 0) {
        throw new FixtureError(`invalid refund fixture state:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
    }
    return cloneJson(value);
}
function toJson(value) {
    if (!isJsonValue(value)) {
        throw new FixtureError("fixture attempted to return a non-JSON value");
    }
    return value;
}
export function createRefundEnvironment(initialState) {
    const state = assertState(initialState);
    return {
        tools: [...REFUND_TOOL_NAMES],
        async call(tool, argumentsValue) {
            const args = asRecord(argumentsValue, "arguments");
            switch (tool) {
                case "orders.get": {
                    const orderId = requiredString(args, "orderId");
                    const order = state.orders[orderId];
                    if (order === undefined) {
                        throw new ToolCallError("not_found", `order ${orderId} was not found`);
                    }
                    return toJson(cloneJson(order));
                }
                case "tickets.get": {
                    const ticketId = requiredString(args, "ticketId");
                    const ticket = state.tickets[ticketId];
                    if (ticket === undefined) {
                        throw new ToolCallError("not_found", `ticket ${ticketId} was not found`);
                    }
                    return toJson(cloneJson(ticket));
                }
                case "refunds.list": {
                    const orderId = requiredString(args, "orderId");
                    return toJson(cloneJson(state.refunds.filter((refund) => refund.orderId === orderId)));
                }
                case "refunds.create": {
                    const orderId = requiredString(args, "orderId");
                    const amount = requiredNumber(args, "amount");
                    const currency = requiredString(args, "currency");
                    const idempotencyKey = requiredString(args, "idempotencyKey");
                    const order = state.orders[orderId];
                    if (order === undefined) {
                        throw new ToolCallError("not_found", `order ${orderId} was not found`);
                    }
                    if (amount > order.amount) {
                        throw new ToolCallError("amount_exceeds_order", "refund exceeds the order amount");
                    }
                    if (currency !== order.currency) {
                        throw new ToolCallError("currency_mismatch", "refund currency differs from order");
                    }
                    const existing = state.refunds.find((refund) => refund.idempotencyKey === idempotencyKey);
                    if (existing !== undefined) {
                        return toJson(cloneJson(existing));
                    }
                    const refund = {
                        id: `refund-${state.refunds.length + 1}`,
                        orderId,
                        amount,
                        currency,
                        idempotencyKey,
                    };
                    state.refunds.push(refund);
                    order.status = "refunded";
                    return toJson(cloneJson(refund));
                }
                case "tickets.update": {
                    const ticketId = requiredString(args, "ticketId");
                    const status = requiredString(args, "status");
                    if (!["open", "resolved", "escalated"].includes(status)) {
                        throw new ToolCallError("invalid_status", `unsupported ticket status ${status}`);
                    }
                    const ticket = state.tickets[ticketId];
                    if (ticket === undefined) {
                        throw new ToolCallError("not_found", `ticket ${ticketId} was not found`);
                    }
                    ticket.status = status;
                    return toJson(cloneJson(ticket));
                }
                case "notifications.send": {
                    const ticketId = requiredString(args, "ticketId");
                    const template = requiredString(args, "template");
                    if (state.tickets[ticketId] === undefined) {
                        throw new ToolCallError("not_found", `ticket ${ticketId} was not found`);
                    }
                    const notification = { ticketId, template };
                    state.notifications.push(notification);
                    return toJson({ accepted: true });
                }
                case "cases.escalate": {
                    const ticketId = requiredString(args, "ticketId");
                    const reason = requiredString(args, "reason");
                    const ticket = state.tickets[ticketId];
                    if (ticket === undefined) {
                        throw new ToolCallError("not_found", `ticket ${ticketId} was not found`);
                    }
                    ticket.status = "escalated";
                    const escalation = { ticketId, reason };
                    state.escalations.push(escalation);
                    return toJson({ accepted: true });
                }
                default:
                    throw new ToolCallError("unknown_tool", `unknown tool: ${tool}`);
            }
        },
        snapshot() {
            return cloneJson(state);
        },
    };
}
export function createEnvironment(fixture, initialState) {
    if (fixture === "refunds.v1") {
        return createRefundEnvironment(initialState);
    }
    throw new FixtureError(`unsupported fixture: ${fixture}`);
}
const conformanceInitialState = {
    orders: {
        "order-conformance": {
            id: "order-conformance",
            amount: 25,
            currency: "USD",
            status: "paid",
            refundable: true,
        },
    },
    tickets: {},
    refunds: [],
    notifications: [],
    escalations: [],
};
export const refundsAdapter = {
    apiVersion: "agentci.adapter.v1",
    id: "refunds.v1",
    version: "1.0.0",
    tools: REFUND_TOOL_NAMES,
    conformance: [
        {
            name: "creates one deterministic refund in isolated state",
            initialState: conformanceInitialState,
            call: {
                tool: "refunds.create",
                arguments: {
                    orderId: "order-conformance",
                    amount: 25,
                    currency: "USD",
                    idempotencyKey: "conformance-refund",
                },
            },
            expectedResult: {
                id: "refund-1",
                orderId: "order-conformance",
                amount: 25,
                currency: "USD",
                idempotencyKey: "conformance-refund",
            },
            expectedFinalState: {
                orders: {
                    "order-conformance": {
                        id: "order-conformance",
                        amount: 25,
                        currency: "USD",
                        status: "refunded",
                        refundable: true,
                    },
                },
                tickets: {},
                refunds: [
                    {
                        id: "refund-1",
                        orderId: "order-conformance",
                        amount: 25,
                        currency: "USD",
                        idempotencyKey: "conformance-refund",
                    },
                ],
                notifications: [],
                escalations: [],
            },
        },
    ],
    validateSuite: validateSuiteForFixture,
    validateStatePointer: validateRefundStatePointer,
    createEnvironment: createRefundEnvironment,
};
