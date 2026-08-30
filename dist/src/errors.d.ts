import type { ToolErrorShape } from "./types.js";
export declare class SuiteValidationError extends Error {
    readonly issues: string[];
    constructor(issues: string[]);
}
export declare class ReleaseValidationError extends Error {
    readonly issues: string[];
    constructor(issues: string[]);
}
export declare class AdapterValidationError extends Error {
    readonly issues: string[];
    constructor(issues: string[]);
}
export declare class AdapterManifestValidationError extends Error {
    readonly issues: string[];
    constructor(issues: string[]);
}
export declare class FixtureError extends Error {
    constructor(message: string);
}
export declare class ToolCallError extends Error {
    readonly agentciToolError = true;
    readonly detail: ToolErrorShape;
    constructor(code: string, message: string);
}
export declare class DriverToolError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
