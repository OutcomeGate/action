import { stableStringify } from "./canonical.js";
import { FixtureError } from "./errors.js";
import type {
  AssertionResult,
  AssertionSpec,
  JsonValue,
  ToolEvent,
} from "./types.js";

const MISSING = Symbol("missing");

function decodePointerToken(token: string): string {
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}

export function readJsonPointer(
  root: JsonValue | undefined,
  pointer: string,
): JsonValue | typeof MISSING {
  if (root === undefined) {
    return MISSING;
  }
  if (pointer === "") {
    return root;
  }
  if (!pointer.startsWith("/")) {
    throw new FixtureError(`JSON pointer must be empty or start with '/': ${pointer}`);
  }

  let current: JsonValue = root;
  for (const rawToken of pointer.slice(1).split("/")) {
    const token = decodePointerToken(rawToken);
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(token)) {
        return MISSING;
      }
      const next = current[Number(token)];
      if (next === undefined) {
        return MISSING;
      }
      current = next;
      continue;
    }
    if (current === null || typeof current !== "object") {
      return MISSING;
    }
    const next = current[token];
    if (next === undefined) {
      return MISSING;
    }
    current = next;
  }
  return current;
}

function baseResult(
  assertion: AssertionSpec,
  passed: boolean,
  message: string,
  expected?: JsonValue,
  observed?: JsonValue,
): AssertionResult {
  return {
    id: assertion.id,
    ...(assertion.description !== undefined
      ? { description: assertion.description }
      : {}),
    passed,
    ...(expected !== undefined ? { expected } : {}),
    ...(observed !== undefined ? { observed } : {}),
    message,
  };
}

export function evaluateAssertion(
  assertion: AssertionSpec,
  context: {
    state: JsonValue;
    output?: JsonValue;
    events: ToolEvent[];
  },
): AssertionResult {
  if (assertion.type === "json_pointer") {
    const root = assertion.source === "state" ? context.state : context.output;
    const observed = readJsonPointer(root, assertion.pointer);
    if (assertion.operator === "absent") {
      const passed = observed === MISSING;
      return baseResult(
        assertion,
        passed,
        passed
          ? `${assertion.source}${assertion.pointer} is absent`
          : `${assertion.source}${assertion.pointer} was expected to be absent`,
        undefined,
        observed === MISSING ? undefined : observed,
      );
    }
    const passed =
      observed !== MISSING &&
      stableStringify(observed) === stableStringify(assertion.expected);
    return baseResult(
      assertion,
      passed,
      passed
        ? `${assertion.source}${assertion.pointer} equals the expected value`
        : `${assertion.source}${assertion.pointer} differs from the expected value`,
      assertion.expected,
      observed === MISSING ? undefined : observed,
    );
  }

  if (assertion.type === "event_count") {
    const outcome = assertion.outcome ?? "any";
    const observed = context.events.filter(
      (event) =>
        event.tool === assertion.tool &&
        (outcome === "any" || event.outcome === outcome),
    ).length;
    const passed = observed === assertion.expected;
    return baseResult(
      assertion,
      passed,
      passed
        ? `${assertion.tool} call count is ${observed}`
        : `${assertion.tool} call count was ${observed}; expected ${assertion.expected}`,
      assertion.expected,
      observed,
    );
  }

  const eventTools = context.events.map((event) => event.tool);
  let cursor = 0;
  for (const tool of assertion.tools) {
    const foundAt = eventTools.indexOf(tool, cursor);
    if (foundAt === -1) {
      return baseResult(
        assertion,
        false,
        `required order was not observed: ${assertion.tools.join(" -> ")}`,
        assertion.tools,
        eventTools,
      );
    }
    cursor = foundAt + 1;
  }
  return baseResult(
    assertion,
    true,
    `required order was observed: ${assertion.tools.join(" -> ")}`,
    assertion.tools,
    eventTools,
  );
}

export function evaluateAssertions(
  assertions: AssertionSpec[],
  context: {
    state: JsonValue;
    output?: JsonValue;
    events: ToolEvent[];
  },
): AssertionResult[] {
  return assertions.map((assertion) => evaluateAssertion(assertion, context));
}
