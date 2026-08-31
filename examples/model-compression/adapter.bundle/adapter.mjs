function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function expectedError(code, message) {
  return { agentciToolError: true, code, message };
}

function assertSyntheticTarget(context) {
  if (
    !isRecord(context) ||
    !isRecord(context.target) ||
    context.target.kind !== "synthetic" ||
    !isRecord(context.target.configuration) ||
    context.target.configuration.namespace !== "model-compression-routing-example"
  ) {
    throw new Error("routing adapter received the wrong declared target");
  }
}

function validateInitialState(state, path, issues) {
  if (
    !isRecord(state) ||
    state.route !== null ||
    state.decisionCount !== 0 ||
    Object.keys(state).some((key) => key !== "route" && key !== "decisionCount")
  ) {
    issues.push(`${path} must equal {"route":null,"decisionCount":0}`);
  }
}

export default {
  apiVersion: "agentci.adapter.v2",
  id: "support-routing.v1",
  version: "1.0.0",
  tools: ["ticket.auto_resolve", "ticket.escalate"],
  conformance: [
    {
      name: "records one escalation decision",
      initialState: { route: null, decisionCount: 0 },
      call: { tool: "ticket.escalate", arguments: {} },
      expectedResult: { route: "escalate", decisionCount: 1 },
      expectedFinalState: { route: "escalate", decisionCount: 1 },
    },
    {
      name: "records one automatic-resolution decision",
      initialState: { route: null, decisionCount: 0 },
      call: { tool: "ticket.auto_resolve", arguments: {} },
      expectedResult: { route: "auto_resolve", decisionCount: 1 },
      expectedFinalState: { route: "auto_resolve", decisionCount: 1 },
    },
  ],
  validateSuite(suite, context) {
    assertSyntheticTarget(context);
    const issues = [];
    suite.scenarios.forEach((scenario, index) => {
      validateInitialState(
        scenario.initialState,
        `scenarios[${index}].initialState`,
        issues,
      );
      if (
        !isRecord(scenario.task) ||
        typeof scenario.task.text !== "string" ||
        scenario.task.text.trim().length === 0 ||
        Object.keys(scenario.task).some((key) => key !== "text")
      ) {
        issues.push(`scenarios[${index}].task must contain only non-empty text`);
      }
    });
    return issues;
  },
  validateStatePointer(pointer, _initialState, context) {
    assertSyntheticTarget(context);
    return pointer === "/route" || pointer === "/decisionCount"
      ? undefined
      : "is not part of support-routing.v1 state";
  },
  createEnvironment(initialState, context) {
    assertSyntheticTarget(context);
    const state = structuredClone(initialState);
    return {
      tools: ["ticket.auto_resolve", "ticket.escalate"],
      async call(tool, argumentsValue, operation) {
        if (operation.signal.aborted) {
          throw new Error("routing operation was aborted");
        }
        if (tool !== "ticket.escalate" && tool !== "ticket.auto_resolve") {
          throw expectedError("unknown_tool", `unknown tool: ${tool}`);
        }
        if (!isRecord(argumentsValue) || Object.keys(argumentsValue).length !== 0) {
          throw expectedError("invalid_arguments", "routing tools take no arguments");
        }
        if (state.decisionCount !== 0 || state.route !== null) {
          throw expectedError("already_routed", "ticket already has a route");
        }
        state.route = tool === "ticket.escalate" ? "escalate" : "auto_resolve";
        state.decisionCount = 1;
        return structuredClone(state);
      },
      snapshot(operation) {
        if (operation.signal.aborted) {
          throw new Error("routing snapshot was aborted");
        }
        return structuredClone(state);
      },
      close() {},
    };
  },
};
