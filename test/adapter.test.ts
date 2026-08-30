import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadExternalAdapter,
  loadManifestAdapter,
  runAdapterConformance,
  validateSuiteAgainstAdapter,
} from "../src/adapter.js";
import { refundsAdapter } from "../src/fixtures/refunds.js";
import { parseSuite } from "../src/suite.js";
import type { AdapterDefinition, JsonValue } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "../..");

test("built-in refund adapter passes generic conformance", async () => {
  assert.deepEqual(await runAdapterConformance(refundsAdapter), []);
});

test("external adapter modules load with an entry-file identity", async () => {
  const loaded = await loadExternalAdapter(
    resolve(projectRoot, "dist/examples/test-adapters/refunds-wrapper.js"),
  );

  assert.equal(loaded.definition.id, "refunds.v1");
  assert.equal(loaded.identity.source, "external");
  assert.equal(loaded.identity.digestScope, "module-entry-only");
  assert.match(loaded.identity.moduleDigest, /^[a-f0-9]{64}$/);
});

test("manifest adapter environments use fresh host processes", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agentci-adapter-fresh-host-test-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const bundle = join(root, "bundle");
  await mkdir(bundle);
  await writeFile(
    join(bundle, "adapter.mjs"),
    `export default {
      apiVersion: "agentci.adapter.v2",
      id: "pid.v1",
      version: "1.0.0",
      tools: ["pid.read"],
      conformance: [{
        name: "pid",
        initialState: {},
        call: { tool: "pid.read", arguments: {} },
        expectedResult: { pid: 0 },
        expectedFinalState: {}
      }],
      validateSuite() { return []; },
      validateStatePointer() { return undefined; },
      createEnvironment(initialState) {
        const state = structuredClone(initialState);
        return {
          tools: ["pid.read"],
          call() { return { pid: process.pid }; },
          snapshot() { return structuredClone(state); },
          close() {}
        };
      }
    };\n`,
    "utf8",
  );
  const manifestPath = join(root, "adapter.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: "agentci.adapter-manifest.v1",
      id: "pid.v1",
      version: "1.0.0",
      runtime: {
        kind: "node-esm",
        apiVersion: "agentci.adapter.v2",
        protocolVersion: 1,
        entry: "adapter.mjs",
        operationTimeoutMs: 1_000,
        shutdownTimeoutMs: 250,
      },
      bundle: { root: "bundle" },
      contract: { tools: ["pid.read"] },
      target: {
        kind: "synthetic",
        reason: "fresh host regression test",
        configuration: {},
      },
      credentials: { environment: [] },
    }),
    "utf8",
  );

  const loaded = await loadManifestAdapter({ manifestPath });
  assert.deepEqual(await loaded.closeValidationHost(), []);
  const first = await loaded.definition.createEnvironment({}, {
    scenarioId: "first",
    timeoutMs: 1_000,
  });
  const second = await loaded.definition.createEnvironment({}, {
    scenarioId: "second",
    timeoutMs: 1_000,
  });
  try {
    const firstResult = (await first.call("pid.read", {})) as { pid: number };
    const secondResult = (await second.call("pid.read", {})) as { pid: number };
    assert.notEqual(firstResult.pid, secondResult.pid);
  } finally {
    await first.close?.();
    await second.close?.();
  }
  assert.deepEqual(await loaded.verifyIdentity(), []);
});

test("manifest adapter rejects a divergent runtime environment tool surface", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agentci-adapter-runtime-tools-test-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const bundle = join(root, "bundle");
  await mkdir(bundle);
  await writeFile(
    join(bundle, "adapter.mjs"),
    `export default {
      apiVersion: "agentci.adapter.v2",
      id: "runtime-tools.v1",
      version: "1.0.0",
      tools: ["counter.read"],
      conformance: [{
        name: "read",
        initialState: { count: 0 },
        call: { tool: "counter.read", arguments: {} },
        expectedResult: { count: 0 },
        expectedFinalState: { count: 0 }
      }],
      validateSuite() { return []; },
      validateStatePointer() { return undefined; },
      createEnvironment(initialState) {
        const state = structuredClone(initialState);
        return {
          tools: ["counter.write"],
          call() { return { count: state.count }; },
          snapshot() { return structuredClone(state); },
          close() {}
        };
      }
    };\n`,
    "utf8",
  );
  const manifestPath = join(root, "adapter.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: "agentci.adapter-manifest.v1",
      id: "runtime-tools.v1",
      version: "1.0.0",
      runtime: {
        kind: "node-esm",
        apiVersion: "agentci.adapter.v2",
        protocolVersion: 1,
        entry: "adapter.mjs",
        operationTimeoutMs: 1_000,
        shutdownTimeoutMs: 250,
      },
      bundle: { root: "bundle" },
      contract: { tools: ["counter.read"] },
      target: {
        kind: "synthetic",
        reason: "runtime tool-surface regression test",
        configuration: {},
      },
      credentials: { environment: [] },
    }),
    "utf8",
  );

  const loaded = await loadManifestAdapter({ manifestPath });
  assert.deepEqual(await loaded.closeValidationHost(), []);
  await assert.rejects(
    async () =>
      loaded.definition.createEnvironment(
        { count: 0 },
        { scenarioId: "runtime-tools", timeoutMs: 1_000 },
      ),
    /runtime environment tools differ from the adapter manifest contract/,
  );
  assert.deepEqual(await loaded.verifyIdentity(), []);
});

test("conformance detects aliased snapshots", async () => {
  const shared: { count: number; [key: string]: JsonValue } = { count: 0 };
  const broken: AdapterDefinition = {
    apiVersion: "agentci.adapter.v1",
    id: "broken.v1",
    version: "1.0.0",
    tools: ["counter.increment"],
    conformance: [
      {
        name: "increment",
        initialState: { count: 0 },
        call: { tool: "counter.increment", arguments: {} },
        expectedResult: { count: 1 },
        expectedFinalState: { count: 1 },
      },
    ],
    validateSuite: () => [],
    validateStatePointer: () => undefined,
    createEnvironment() {
      shared.count = 0;
      return {
        tools: ["counter.increment"],
        async call() {
          shared.count += 1;
          return { count: shared.count };
        },
        snapshot() {
          return shared;
        },
      };
    },
  };

  const issues = await runAdapterConformance(broken);
  assert.ok(issues.some((issue) => issue.includes("snapshot mutation leaked")));
});

test("core validation rejects tools not exposed by an external adapter", async () => {
  const suite = parseSuite({
    schemaVersion: "agentci.suite.v1",
    name: "external-suite",
    version: "1.0.0",
    fixture: "external.v1",
    gate: { minPassRate: 1 },
    scenarios: [
      {
        id: "case",
        description: "unknown tool assertion",
        task: {},
        initialState: {},
        assertions: [
          {
            id: "unknown-tool",
            type: "event_count",
            tool: "unknown.call",
            expected: 0,
          },
        ],
      },
    ],
  });
  const adapter: AdapterDefinition = {
    apiVersion: "agentci.adapter.v1",
    id: "external.v1",
    version: "1.0.0",
    tools: ["known.call"],
    conformance: [
      {
        name: "known call",
        initialState: {},
        call: { tool: "known.call", arguments: {} },
        expectedResult: {},
        expectedFinalState: {},
      },
    ],
    validateSuite: () => [],
    validateStatePointer: (pointer) =>
      pointer === "/count" ? undefined : "is not declared by the adapter",
    createEnvironment: () => ({
      tools: ["known.call"],
      call: async () => ({}),
      snapshot: async () => ({}),
    }),
  };

  assert.ok(
    (await validateSuiteAgainstAdapter(suite, adapter)).some((issue) =>
      issue.includes("not exposed"),
    ),
  );
});

test("external adapters must reject undeclared state pointers", async () => {
  const suite = parseSuite({
    schemaVersion: "agentci.suite.v1",
    name: "external-suite",
    version: "1.0.0",
    fixture: "external.v1",
    gate: { minPassRate: 1 },
    scenarios: [
      {
        id: "case",
        description: "typoed absence assertion",
        task: {},
        initialState: { count: 0 },
        assertions: [
          {
            id: "typoed-absence",
            type: "json_pointer",
            source: "state",
            pointer: "/coutn",
            operator: "absent",
          },
        ],
      },
    ],
  });
  const adapter: AdapterDefinition = {
    apiVersion: "agentci.adapter.v1",
    id: "external.v1",
    version: "1.0.0",
    tools: ["counter.read"],
    conformance: [
      {
        name: "read",
        initialState: { count: 0 },
        call: { tool: "counter.read", arguments: {} },
        expectedResult: { count: 0 },
        expectedFinalState: { count: 0 },
      },
    ],
    validateSuite: () => [],
    validateStatePointer: (pointer) =>
      pointer === "/count" ? undefined : "is not declared by the adapter",
    createEnvironment: () => ({
      tools: ["counter.read"],
      call: async () => ({ count: 0 }),
      snapshot: async () => ({ count: 0 }),
    }),
  };

  assert.ok(
    (await validateSuiteAgainstAdapter(suite, adapter)).some((issue) =>
      issue.includes("/coutn"),
    ),
  );
});

test("conformance detects adapters that mutate their initial-state input", async () => {
  const broken: AdapterDefinition = {
    apiVersion: "agentci.adapter.v1",
    id: "broken-input.v1",
    version: "1.0.0",
    tools: ["counter.read"],
    conformance: [
      {
        name: "read",
        initialState: { count: 0 },
        call: { tool: "counter.read", arguments: {} },
        expectedResult: { count: 1 },
        expectedFinalState: { count: 1 },
      },
    ],
    validateSuite: () => [],
    validateStatePointer: () => undefined,
    createEnvironment(initialState) {
      const state = initialState as { count: number };
      state.count = 1;
      return {
        tools: ["counter.read"],
        call: async () => ({ count: state.count }),
        snapshot: async () => state,
      };
    },
  };

  assert.ok(
    (await runAdapterConformance(broken)).some((issue) =>
      issue.includes("did not preserve initial state"),
    ),
  );
});
