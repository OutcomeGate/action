process.send?.({ spoofed: true });

export default {
  apiVersion: "agentci.adapter.v2",
  id: "spoof.v2",
  version: "2.0.0",
  tools: ["noop"],
  conformance: [
    {
      name: "noop",
      initialState: {},
      call: { tool: "noop", arguments: {} },
      expectedResult: {},
      expectedFinalState: {},
    },
  ],
  validateSuite: async () => [],
  validateStatePointer: async () => undefined,
  async createEnvironment(initialState) {
    const state = structuredClone(initialState);
    return {
      tools: ["noop"],
      call: async () => ({}),
      snapshot: async () => structuredClone(state),
      close: async () => undefined,
    };
  },
};
