console.log("adapter diagnostic output does not share the IPC protocol");

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function expectedError(code, message) {
  return { agentciToolError: true, code, message };
}

export default {
  apiVersion: "agentci.adapter.v2",
  id: "counter.v2",
  version: "2.0.0",
  tools: [
    "counter.increment",
    "counter.expected_error",
    "counter.context",
  ],
  conformance: [
    {
      name: "increment",
      initialState: { count: 0 },
      call: { tool: "counter.increment", arguments: { delta: 1 } },
      expectedResult: { count: 1 },
      expectedFinalState: { count: 1 },
    },
  ],
  async validateSuite(suite, context) {
    const issues = [];
    if (!isRecord(suite)) issues.push("suite must be an object");
    if (!isRecord(context.target) || context.target.tenant !== "sandbox") {
      issues.push("target tenant must be sandbox");
    }
    return issues;
  },
  async validateStatePointer(pointer, _initialState, context) {
    if (context.signal.aborted) throw new Error("validation was aborted");
    return pointer === "/count" ? undefined : "is not declared";
  },
  async createEnvironment(initialState, context) {
    if (context.signal.aborted) throw new Error("initialization was aborted");
    const state = structuredClone(initialState);
    return {
      tools: [
        "counter.increment",
        "counter.expected_error",
        "counter.context",
      ],
      async call(tool, argumentsValue, operation) {
        if (tool === "counter.expected_error") {
          throw expectedError("expected_failure", "declared tool failure");
        }
        if (tool === "counter.context") {
          return {
            target: operation.target,
            credentialNames: Object.keys(operation.credentials).sort(),
            credentialAccepted:
              operation.credentials.TEST_TOKEN === "super-secret-value",
            ambientCredentialRemoved: process.env.TEST_TOKEN === undefined,
          };
        }
        if (
          tool !== "counter.increment" ||
          !isRecord(argumentsValue) ||
          !Number.isFinite(argumentsValue.delta)
        ) {
          throw expectedError("invalid_call", "invalid counter call");
        }
        state.count += argumentsValue.delta;
        return { count: state.count };
      },
      async snapshot(operation) {
        if (operation.signal.aborted) throw new Error("snapshot was aborted");
        return structuredClone(state);
      },
      async close(operation) {
        if (operation.signal.aborted) throw new Error("close was aborted");
      },
    };
  },
};
