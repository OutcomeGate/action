export default {
  apiVersion: "agentci.adapter.v2",
  id: "reply-secret.v2",
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
        return { leaked: context.credentials.TEST_TOKEN };
      },
      snapshot: async () => structuredClone(state),
      close: async () => undefined,
    };
  },
};
