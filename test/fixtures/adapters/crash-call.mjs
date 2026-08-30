export default {
  apiVersion: "agentci.adapter.v2",
  id: "crash-call.v2",
  version: "2.0.0",
  tools: ["crash"],
  conformance: [
    {
      name: "crash",
      initialState: {},
      call: { tool: "crash", arguments: {} },
      expectedResult: {},
      expectedFinalState: {},
    },
  ],
  validateSuite: async () => [],
  validateStatePointer: async () => undefined,
  async createEnvironment(initialState) {
    const state = structuredClone(initialState);
    return {
      tools: ["crash"],
      async call() {
        process.exit(17);
      },
      snapshot: async () => structuredClone(state),
      close: async () => undefined,
    };
  },
};
