import type { ToolErrorShape } from "./types.js";

export class SuiteValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid suite:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
    this.name = "SuiteValidationError";
    this.issues = issues;
  }
}

export class ReleaseValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid release manifest:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
    this.name = "ReleaseValidationError";
    this.issues = issues;
  }
}

export class AdapterValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid adapter:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
    this.name = "AdapterValidationError";
    this.issues = issues;
  }
}

export class AdapterManifestValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(
      `Invalid adapter manifest:\n${issues.map((issue) => `- ${issue}`).join("\n")}`,
    );
    this.name = "AdapterManifestValidationError";
    this.issues = issues;
  }
}

export class FixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixtureError";
  }
}

export class ToolCallError extends Error {
  readonly agentciToolError = true;
  readonly detail: ToolErrorShape;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ToolCallError";
    this.detail = { code, message };
  }
}

export class DriverToolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DriverToolError";
    this.code = code;
  }
}
