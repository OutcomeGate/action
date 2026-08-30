import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { isJsonValue } from "./canonical.js";
import { SuiteValidationError } from "./errors.js";
import { validateSuiteForFixture } from "./fixtures/refunds.js";
import {
  assertSecretScanClean,
  scanTextForSecrets,
} from "./secret-scan.js";
import { parseStrictJson } from "./strict-json.js";
import type {
  AssertionSpec,
  FaultSpec,
  JsonValue,
  ScenarioSpec,
  SuiteSpec,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unknownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: string[],
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      issues.push(`${path}${path.length > 0 ? "." : ""}${key} is not supported`);
    }
  }
}

function readString(
  value: unknown,
  path: string,
  issues: string[],
): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    issues.push(`${path} must be a non-empty string`);
    return undefined;
  }
  return value;
}

function readPositiveInteger(
  value: unknown,
  path: string,
  issues: string[],
): number | undefined {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    issues.push(`${path} must be a positive integer`);
    return undefined;
  }
  return value as number;
}

function parseFault(value: unknown, path: string, issues: string[]): FaultSpec | undefined {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return undefined;
  }
  unknownKeys(value, ["tool", "onCall", "phase", "error"], path, issues);

  const tool = readString(value.tool, `${path}.tool`, issues);
  const onCall = readPositiveInteger(value.onCall, `${path}.onCall`, issues);
  const phase = value.phase;
  if (phase !== "before" && phase !== "after") {
    issues.push(`${path}.phase must be 'before' or 'after'`);
  }

  if (!isRecord(value.error)) {
    issues.push(`${path}.error must be an object`);
    return undefined;
  }
  unknownKeys(value.error, ["code", "message"], `${path}.error`, issues);
  const code = readString(value.error.code, `${path}.error.code`, issues);
  const message = readString(value.error.message, `${path}.error.message`, issues);

  if (tool === undefined || onCall === undefined || (phase !== "before" && phase !== "after") || code === undefined || message === undefined) {
    return undefined;
  }

  return { tool, onCall, phase, error: { code, message } };
}

function parseAssertion(
  value: unknown,
  path: string,
  issues: string[],
): AssertionSpec | undefined {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return undefined;
  }

  const id = readString(value.id, `${path}.id`, issues);
  const description = value.description;
  if (description !== undefined && typeof description !== "string") {
    issues.push(`${path}.description must be a string`);
  }

  if (value.type === "json_pointer") {
    unknownKeys(
      value,
      ["id", "description", "type", "source", "pointer", "operator", "expected"],
      path,
      issues,
    );
    const source = value.source;
    const pointer = readString(value.pointer, `${path}.pointer`, issues);
    const operator = value.operator;
    if (source !== "state" && source !== "output") {
      issues.push(`${path}.source must be 'state' or 'output'`);
    }
    if (operator !== "equals" && operator !== "absent") {
      issues.push(`${path}.operator must be 'equals' or 'absent'`);
    }
    if (
      pointer !== undefined &&
      (!pointer.startsWith("/") || /~(?:[^01]|$)/.test(pointer))
    ) {
      issues.push(`${path}.pointer must be an RFC 6901 JSON pointer starting with '/'`);
    }
    if (operator === "equals" && !isJsonValue(value.expected)) {
      issues.push(`${path}.expected must be JSON for an equals assertion`);
    }
    if (
      id === undefined ||
      pointer === undefined ||
      !pointer.startsWith("/") ||
      /~(?:[^01]|$)/.test(pointer) ||
      (source !== "state" && source !== "output") ||
      (operator !== "equals" && operator !== "absent")
    ) {
      return undefined;
    }
    return {
      id,
      ...(typeof description === "string" ? { description } : {}),
      type: "json_pointer",
      source,
      pointer,
      operator,
      ...(operator === "equals" ? { expected: value.expected as JsonValue } : {}),
    };
  }

  if (value.type === "event_count") {
    unknownKeys(
      value,
      ["id", "description", "type", "tool", "outcome", "expected"],
      path,
      issues,
    );
    const tool = readString(value.tool, `${path}.tool`, issues);
    const expected = value.expected;
    const outcome = value.outcome ?? "any";
    if (!Number.isInteger(expected) || (expected as number) < 0) {
      issues.push(`${path}.expected must be a non-negative integer`);
    }
    if (outcome !== "any" && outcome !== "ok" && outcome !== "error") {
      issues.push(`${path}.outcome must be 'any', 'ok', or 'error'`);
    }
    if (id === undefined || tool === undefined || !Number.isInteger(expected) || (expected as number) < 0 || (outcome !== "any" && outcome !== "ok" && outcome !== "error")) {
      return undefined;
    }
    return {
      id,
      ...(typeof description === "string" ? { description } : {}),
      type: "event_count",
      tool,
      outcome,
      expected: expected as number,
    };
  }

  if (value.type === "event_order") {
    unknownKeys(value, ["id", "description", "type", "tools"], path, issues);
    if (!Array.isArray(value.tools) || value.tools.length < 2 || !value.tools.every((tool) => typeof tool === "string" && tool.length > 0)) {
      issues.push(`${path}.tools must contain at least two non-empty tool names`);
      return undefined;
    }
    if (id === undefined) {
      return undefined;
    }
    return {
      id,
      ...(typeof description === "string" ? { description } : {}),
      type: "event_order",
      tools: value.tools as string[],
    };
  }

  issues.push(`${path}.type is unsupported`);
  return undefined;
}

function parseScenario(
  value: unknown,
  index: number,
  issues: string[],
): ScenarioSpec | undefined {
  const path = `scenarios[${index}]`;
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return undefined;
  }
  unknownKeys(
    value,
    [
      "id",
      "description",
      "task",
      "initialState",
      "faults",
      "assertions",
      "timeoutMs",
      "maxToolCalls",
    ],
    path,
    issues,
  );

  const id = readString(value.id, `${path}.id`, issues);
  const description = readString(value.description, `${path}.description`, issues);
  if (!isJsonValue(value.task)) {
    issues.push(`${path}.task must be JSON`);
  }
  if (!isJsonValue(value.initialState)) {
    issues.push(`${path}.initialState must be JSON`);
  }

  const rawFaults = value.faults ?? [];
  const rawAssertions = value.assertions;
  if (!Array.isArray(rawFaults)) {
    issues.push(`${path}.faults must be an array`);
  }
  if (!Array.isArray(rawAssertions) || rawAssertions.length === 0) {
    issues.push(`${path}.assertions must be a non-empty array`);
  }

  const faults = Array.isArray(rawFaults)
    ? rawFaults
        .map((fault, faultIndex) => parseFault(fault, `${path}.faults[${faultIndex}]`, issues))
        .filter((fault): fault is FaultSpec => fault !== undefined)
    : [];
  const assertions = Array.isArray(rawAssertions)
    ? rawAssertions
        .map((assertion, assertionIndex) => parseAssertion(assertion, `${path}.assertions[${assertionIndex}]`, issues))
        .filter((assertion): assertion is AssertionSpec => assertion !== undefined)
    : [];
  const faultKeys = faults.map((fault) => `${fault.tool}:${fault.onCall}`);
  if (new Set(faultKeys).size !== faultKeys.length) {
    issues.push(`${path}.fault schedules must be unique by tool and call number`);
  }
  const assertionIds = assertions.map((assertion) => assertion.id);
  if (new Set(assertionIds).size !== assertionIds.length) {
    issues.push(`${path}.assertion ids must be unique`);
  }

  const timeoutMs = readPositiveInteger(value.timeoutMs ?? 2_000, `${path}.timeoutMs`, issues);
  const maxToolCalls = readPositiveInteger(value.maxToolCalls ?? 20, `${path}.maxToolCalls`, issues);

  if (
    id === undefined ||
    description === undefined ||
    !isJsonValue(value.task) ||
    !isJsonValue(value.initialState) ||
    !Array.isArray(rawAssertions) ||
    rawAssertions.length === 0 ||
    timeoutMs === undefined ||
    maxToolCalls === undefined
  ) {
    return undefined;
  }

  return {
    id,
    description,
    task: value.task,
    initialState: value.initialState,
    faults,
    assertions,
    timeoutMs,
    maxToolCalls,
  };
}

export function parseSuite(value: unknown): SuiteSpec {
  const issues: string[] = [];
  if (!isRecord(value)) {
    throw new SuiteValidationError(["suite must be an object"]);
  }
  unknownKeys(
    value,
    ["schemaVersion", "name", "version", "fixture", "gate", "scenarios"],
    "",
    issues,
  );

  if (value.schemaVersion !== "agentci.suite.v1") {
    issues.push("schemaVersion must be 'agentci.suite.v1'");
  }
  const name = readString(value.name, "name", issues);
  const version = readString(value.version, "version", issues);
  const fixture = readString(value.fixture, "fixture", issues);

  let minPassRate = 1;
  if (!isRecord(value.gate)) {
    issues.push("gate must be an object");
  } else {
    unknownKeys(value.gate, ["minPassRate"], "gate", issues);
    if (
      typeof value.gate.minPassRate !== "number" ||
      value.gate.minPassRate < 0 ||
      value.gate.minPassRate > 1
    ) {
      issues.push("gate.minPassRate must be between 0 and 1");
    } else {
      minPassRate = value.gate.minPassRate;
    }
  }

  const scenarios = Array.isArray(value.scenarios)
    ? value.scenarios
        .map((scenario, index) => parseScenario(scenario, index, issues))
        .filter((scenario): scenario is ScenarioSpec => scenario !== undefined)
    : [];
  if (!Array.isArray(value.scenarios) || value.scenarios.length === 0) {
    issues.push("scenarios must be a non-empty array");
  }

  const ids = scenarios.map((scenario) => scenario.id);
  if (new Set(ids).size !== ids.length) {
    issues.push("scenario ids must be unique");
  }

  if (issues.length > 0 || name === undefined || version === undefined || fixture === undefined) {
    throw new SuiteValidationError(issues);
  }

  const suite: SuiteSpec = {
    schemaVersion: "agentci.suite.v1",
    name,
    version,
    fixture,
    gate: { minPassRate },
    scenarios,
  };
  const fixtureIssues =
    suite.fixture === "refunds.v1" ? validateSuiteForFixture(suite) : [];
  if (fixtureIssues.length > 0) {
    throw new SuiteValidationError(fixtureIssues);
  }
  return suite;
}

export async function loadSuite(path: string): Promise<{ suite: SuiteSpec; path: string; raw: string }> {
  const absolutePath = resolve(path);
  const raw = await readFile(absolutePath, "utf8");
  assertSecretScanClean(
    scanTextForSecrets({ path: "suite/input.json", text: raw }),
    "suite input",
  );
  let parsed: unknown;
  try {
    parsed = parseStrictJson(raw);
  } catch (error) {
    throw new SuiteValidationError([
      `file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  assertSecretScanClean(
    scanTextForSecrets({
      path: "suite/input.json",
      field: "normalized-json",
      text: JSON.stringify(parsed),
    }),
    "normalized suite input",
  );
  return { suite: parseSuite(parsed), path: absolutePath, raw };
}
