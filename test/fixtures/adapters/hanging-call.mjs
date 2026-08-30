export default {
  apiVersion: "agentci.adapter.v2",
  id: "hanging-call.v2",
  version: "2.0.0",
  tools: ["hang"],
  conformance: [
    {
      name: "hang",
      initialState: {},
      call: { tool: "hang", arguments: {} },
      expectedResult: {},
      expectedFinalState: {},
    },
  ],
  validateSuite: async () => [],
  validateStatePointer: async () => undefined,
  async createEnvironment(initialState) {
    const state = structuredClone(initialState);
    return {
      tools: ["hang"],
      async call(_tool, _arguments, context) {
        await new Promise((_resolve, reject) => {
          context.signal.addEventListener(
            "abort",
            () => reject(new Error("call observed abort")),
            { once: true },
          );
        });
        return {};
      },
      snapshot: async () => structuredClone(state),
      close: async () => undefined,
    };
  },
};
