import { spawn } from "node:child_process";

export default {
  apiVersion: "agentci.adapter.v2",
  id: "spawn-child.v2",
  version: "2.0.0",
  tools: ["spawn"],
  conformance: [
    {
      name: "spawn",
      initialState: {},
      call: { tool: "spawn", arguments: { marker: "marker" } },
      expectedResult: {},
      expectedFinalState: {},
    },
  ],
  validateSuite: async () => [],
  validateStatePointer: async () => undefined,
  async createEnvironment(initialState) {
    const state = structuredClone(initialState);
    return {
      tools: ["spawn"],
      async call(_tool, argumentsValue) {
        const marker = argumentsValue.marker;
        const child = spawn(
          process.execPath,
          [
            "-e",
            "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'escaped'), 500)",
            marker,
          ],
          { stdio: "ignore" },
        );
        child.unref();
        await new Promise(() => {});
      },
      snapshot: async () => structuredClone(state),
      close: async () => undefined,
    };
  },
};
