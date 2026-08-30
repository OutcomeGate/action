function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function expectedError(code, message) {
  return { agentciToolError: true, code, message };
}

export default {
  apiVersion: "agentci.adapter.v1",
  id: "counter.v1",
  version: "1.0.0",
  tools: ["counter.increment"],
  conformance: [
    {
      name: "increments isolated counter state",
      initialState: { count: 0 },
      call: { tool: "counter.increment", arguments: { delta: 1 } },
      expectedResult: { count: 1 },
      expectedFinalState: { count: 1 },
    },
  ],
  validateSuite(suite) {
    const issues = [];
    suite.scenarios.forEach((scenario, index) => {
      if (!isRecord(scenario.initialState) || !Number.isFinite(scenario.initialState.count)) {
        issues.push(`scenarios[${index}].initialState.count must be finite`);
      }
      if (!isRecord(scenario.task) || !Number.isFinite(scenario.task.delta)) {
        issues.push(`scenarios[${index}].task.delta must be finite`);
      }
    });
    return issues;
  },
  validateStatePointer(pointer) {
    return pointer === "/count" ? undefined : "is not part of counter.v1 state";
  },
  createEnvironment(initialState) {
    const state = structuredClone(initialState);
    return {
      tools: ["counter.increment"],
      async call(tool, argumentsValue) {
        if (tool !== "counter.increment") {
          throw expectedError("unknown_tool", `unknown tool: ${tool}`);
        }
        if (!isRecord(argumentsValue) || !Number.isFinite(argumentsValue.delta)) {
          throw expectedError("invalid_arguments", "delta must be finite");
        }
        state.count += argumentsValue.delta;
        return { count: state.count };
      },
      snapshot() {
        return structuredClone(state);
      },
    };
  },
};
