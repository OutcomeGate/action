export default {
  apiVersion: "agentci.adapter.v2",
  id: "non-json.v2",
  version: "2.0.0",
  tools: ["bad"],
  conformance: [
    {
      name: "bad",
      initialState: {},
      call: { tool: "bad", arguments: {} },
      expectedResult: {},
      expectedFinalState: {},
    },
  ],
  validateSuite: async () => [],
  validateStatePointer: async () => undefined,
  async createEnvironment(initialState) {
    const state = structuredClone(initialState);
    return {
      tools: ["bad"],
      call: async () => new Date(),
      snapshot: async () => structuredClone(state),
      close: async () => undefined,
    };
  },
};
