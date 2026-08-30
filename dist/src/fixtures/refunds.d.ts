import type { AdapterDefinition, Environment, JsonValue, SuiteSpec } from "../types.js";
export declare const REFUND_TOOL_NAMES: readonly ["orders.get", "refunds.list", "refunds.create", "tickets.get", "tickets.update", "notifications.send", "cases.escalate"];
export declare function validateRefundState(value: JsonValue): string[];
export declare function validateSuiteForFixture(suite: SuiteSpec): string[];
export declare function createRefundEnvironment(initialState: JsonValue): Environment;
export declare function createEnvironment(fixture: string, initialState: JsonValue): Environment;
export declare const refundsAdapter: AdapterDefinition;
