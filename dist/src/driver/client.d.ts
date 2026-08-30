import type { JsonValue } from "../types.js";
export interface DriverContext {
    scenarioId: string;
    task: JsonValue;
    availableTools: string[];
    call(tool: string, argumentsValue: JsonValue): Promise<JsonValue>;
}
export type DriverHandler = (context: DriverContext) => Promise<JsonValue>;
export declare function runDriverAgent(handler: DriverHandler): void;
