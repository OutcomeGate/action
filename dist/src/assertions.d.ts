import type { AssertionResult, AssertionSpec, JsonValue, ToolEvent } from "./types.js";
declare const MISSING: unique symbol;
export declare function readJsonPointer(root: JsonValue | undefined, pointer: string): JsonValue | typeof MISSING;
export declare function evaluateAssertion(assertion: AssertionSpec, context: {
    state: JsonValue;
    output?: JsonValue;
    events: ToolEvent[];
}): AssertionResult;
export declare function evaluateAssertions(assertions: AssertionSpec[], context: {
    state: JsonValue;
    output?: JsonValue;
    events: ToolEvent[];
}): AssertionResult[];
export {};
