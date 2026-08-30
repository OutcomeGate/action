export class SuiteValidationError extends Error {
    issues;
    constructor(issues) {
        super(`Invalid suite:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
        this.name = "SuiteValidationError";
        this.issues = issues;
    }
}
export class ReleaseValidationError extends Error {
    issues;
    constructor(issues) {
        super(`Invalid release manifest:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
        this.name = "ReleaseValidationError";
        this.issues = issues;
    }
}
export class AdapterValidationError extends Error {
    issues;
    constructor(issues) {
        super(`Invalid adapter:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
        this.name = "AdapterValidationError";
        this.issues = issues;
    }
}
export class AdapterManifestValidationError extends Error {
    issues;
    constructor(issues) {
        super(`Invalid adapter manifest:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
        this.name = "AdapterManifestValidationError";
        this.issues = issues;
    }
}
export class FixtureError extends Error {
    constructor(message) {
        super(message);
        this.name = "FixtureError";
    }
}
export class ToolCallError extends Error {
    agentciToolError = true;
    detail;
    constructor(code, message) {
        super(message);
        this.name = "ToolCallError";
        this.detail = { code, message };
    }
}
export class DriverToolError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "DriverToolError";
        this.code = code;
    }
}
