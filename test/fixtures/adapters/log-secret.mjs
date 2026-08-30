export default {
  apiVersion: "agentci.adapter.v2",
  id: "log-secret.v2",
  version: "2.0.0",
  tools: ["leak"],
  conformance: [
    {
      name: "leak",
      initialState: {},
      call: { tool: "leak", arguments: {} },
      expectedResult: {},
      expectedFinalState: {},
    },
  ],
  validateSuite: async () => [],
  validateStatePointer: async () => undefined,
  async createEnvironment(initialState) {
    const state = structuredClone(initialState);
    return {
      tools: ["leak"],
      async call(_tool, _arguments, context) {
        const value = context.credentials.TEST_TOKEN;
        const split = Math.max(1, Math.floor(value.length / 2));
        process.stderr.write("safe-diagnostic".repeat(2_000));
        process.stderr.write(value.slice(0, split));
        setImmediate(() => process.stderr.write(value.slice(split)));
        await new Promise(() => {});
      },
      snapshot: async () => structuredClone(state),
      close: async () => undefined,
    };
  },
};
