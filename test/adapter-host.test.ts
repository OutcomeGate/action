import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AdapterHostClientError,
  spawnAdapterHost,
  type AdapterHostClient,
  type AdapterHostClientOptions,
} from "../src/adapter-host/client.js";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "../..");
const fixtures = resolve(projectRoot, "test/fixtures/adapters");
const target = { tenant: "sandbox", endpoint: "https://sandbox.invalid" };
const secret = "super-secret-value";

async function spawnFixture(
  name: string,
  mode: "inspect" | "scenario",
  overrides: Partial<AdapterHostClientOptions> = {},
): Promise<AdapterHostClient> {
  return spawnAdapterHost({
    adapterPath: resolve(fixtures, name),
    mode,
    target,
    startupTimeoutMs: 1_000,
    operationTimeoutMs: 500,
    shutdownTimeoutMs: 500,
    ...overrides,
  });
}

function isHostErrorWith(...codes: AdapterHostClientError["code"][]) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof AdapterHostClientError);
    assert.ok(codes.includes(error.code), `unexpected host error code: ${error.code}`);
    return true;
  };
}

test("inspection mode returns a v2 descriptor and executes async validators", async () => {
  const client = await spawnFixture("good.mjs", "inspect", {
    credentialEnvironment: { TEST_TOKEN: secret },
  });
  const result = await client.validate({
    suite: { schemaVersion: "agentci.suite.v1" },
    pointers: [
      { id: "known", pointer: "/count", initialState: { count: 0 } },
      { id: "unknown", pointer: "/coutn", initialState: { count: 0 } },
    ],
  });

  assert.equal(client.descriptor.apiVersion, "agentci.adapter.v2");
  assert.equal(client.descriptor.id, "counter.v2");
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.pointers, [
    { id: "known", issue: null },
    { id: "unknown", issue: "is not declared" },
  ]);
  await client.close();
  assert.deepEqual(client.exit, { code: 0, signal: null });
  assert.match(client.diagnostics.stdout, /diagnostic output/);
});

test("scenario mode keeps target and credentials inside the child context", async () => {
  const client = await spawnFixture("good.mjs", "scenario", {
    credentialEnvironment: { TEST_TOKEN: secret },
  });
  const initialized = await client.initialize({
    scenarioId: "counter-case",
    initialState: { count: 0 },
  });
  assert.deepEqual(initialized.initialState, { count: 0 });

  const contextResult = await client.transition({
    invoke: true,
    tool: "counter.context",
    arguments: {},
  });
  assert.deepEqual(contextResult.outcome, {
    kind: "ok",
    content: {
      target,
      credentialNames: ["TEST_TOKEN"],
      credentialAccepted: true,
      ambientCredentialRemoved: true,
    },
  });
  assert.ok(!JSON.stringify(contextResult).includes(secret));

  const increment = await client.transition({
    invoke: true,
    tool: "counter.increment",
    arguments: { delta: 2 },
  });
  assert.deepEqual(increment.beforeState, { count: 0 });
  assert.deepEqual(increment.afterState, { count: 2 });
  assert.deepEqual(increment.outcome, { kind: "ok", content: { count: 2 } });

  const expectedError = await client.transition({
    invoke: true,
    tool: "counter.expected_error",
    arguments: {},
  });
  assert.deepEqual(expectedError.outcome, {
    kind: "tool_error",
    error: { code: "expected_failure", message: "declared tool failure" },
  });

  const skipped = await client.transition({ invoke: false });
  assert.deepEqual(skipped.outcome, { kind: "skipped" });
  assert.deepEqual((await client.snapshot()).state, { count: 2 });
  await client.close();
});

test("known credential values cannot cross a protocol reply", async () => {
  const client = await spawnFixture("reply-secret.mjs", "scenario", {
    credentialEnvironment: { TEST_TOKEN: secret },
  });
  await client.initialize({ scenarioId: "reply-leak", initialState: {} });
  await assert.rejects(
    client.transition({ invoke: true, tool: "leak", arguments: {} }),
    (error: unknown) => {
      assert.ok(error instanceof AdapterHostClientError);
      assert.ok(!error.message.includes(secret));
      assert.ok(
        error.code === "host_operation_failed" || error.code === "secret_leak",
      );
      return true;
    },
  );
  assert.ok(!JSON.stringify(client.diagnostics).includes(secret));
});

test("opposite-grant literals are rejected before adapter-host startup", async () => {
  await assert.rejects(
    spawnFixture("good.mjs", "inspect", {
      protectedSecrets: [
        { ruleId: "candidate-only", value: "main.js" },
      ],
    }),
    isHostErrorWith("secret_leak"),
  );
});

test("known credential values split after the diagnostic limit still poison the host", async () => {
  const client = await spawnFixture("log-secret.mjs", "scenario", {
    credentialEnvironment: { TEST_TOKEN: secret },
  });
  await client.initialize({ scenarioId: "log-leak", initialState: {} });
  await assert.rejects(
    client.transition({ invoke: true, tool: "leak", arguments: {}, timeoutMs: 500 }),
    isHostErrorWith("secret_leak"),
  );
  assert.ok(!JSON.stringify(client.diagnostics).includes(secret));
  assert.equal(client.diagnostics.stderrTruncated, true);
});

test("a synchronous import hang is killed by the parent startup deadline", async () => {
  const started = performance.now();
  await assert.rejects(
    spawnFixture("hanging-import.mjs", "inspect", { startupTimeoutMs: 100 }),
    isHostErrorWith("timeout"),
  );
  assert.ok(performance.now() - started < 2_000);
});

test("a timed-out call terminally poisons and terminates its scenario host", async () => {
  const client = await spawnFixture("hanging-call.mjs", "scenario");
  await client.initialize({ scenarioId: "hanging-call", initialState: {} });
  await assert.rejects(
    client.transition({ invoke: true, tool: "hang", arguments: {}, timeoutMs: 100 }),
    isHostErrorWith("timeout", "host_operation_failed"),
  );
  assert.equal(client.usable, false);
  assert.ok(client.exit !== undefined);
  await assert.rejects(client.snapshot(), isHostErrorWith("timeout", "host_operation_failed"));
});

test("the client rejects concurrent RPCs while preserving the pending deadline", async () => {
  const client = await spawnFixture("hanging-call.mjs", "scenario");
  await client.initialize({ scenarioId: "one-at-a-time", initialState: {} });
  const pending = client.transition({
    invoke: true,
    tool: "hang",
    arguments: {},
    timeoutMs: 100,
  });
  await assert.rejects(client.snapshot(), isHostErrorWith("invalid_state"));
  await assert.rejects(pending, isHostErrorWith("timeout", "host_operation_failed"));
});

test("a hanging mandatory close is killed and cannot be reported as clean", async () => {
  const client = await spawnFixture("hanging-close.mjs", "scenario");
  await client.initialize({ scenarioId: "hanging-close", initialState: {} });
  await assert.rejects(
    client.close(100),
    isHostErrorWith("timeout", "host_operation_failed"),
  );
  assert.ok(client.exit !== undefined);
});

test("an adapter process crash poisons an in-flight transition", async () => {
  const client = await spawnFixture("crash-call.mjs", "scenario");
  await client.initialize({ scenarioId: "crash", initialState: {} });
  await assert.rejects(
    client.transition({ invoke: true, tool: "crash", arguments: {} }),
    isHostErrorWith("host_crashed"),
  );
  assert.equal(client.exit?.code, 17);
});

test("non-JSON adapter results fail closed", async () => {
  const client = await spawnFixture("non-json-result.mjs", "scenario");
  await client.initialize({ scenarioId: "non-json", initialState: {} });
  await assert.rejects(
    client.transition({ invoke: true, tool: "bad", arguments: {} }),
    isHostErrorWith("host_operation_failed"),
  );
});

test("unsolicited malformed IPC during boot is terminal", async () => {
  await assert.rejects(
    spawnFixture("spoof-ipc.mjs", "inspect"),
    isHostErrorWith("protocol_error"),
  );
});

test(
  "process-group termination prevents an adapter descendant from escaping",
  { skip: process.platform === "win32" },
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), "agentci-adapter-host-"));
    context.after(async () => rm(root, { recursive: true, force: true }));
    const marker = join(root, "escaped.txt");
    const client = await spawnFixture("spawn-child.mjs", "scenario");
    await client.initialize({ scenarioId: "spawn-child", initialState: {} });
    await assert.rejects(
      client.transition({
        invoke: true,
        tool: "spawn",
        arguments: { marker },
        timeoutMs: 100,
      }),
      isHostErrorWith("timeout", "host_operation_failed"),
    );
    await delay(650);
    await assert.rejects(access(marker), (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
      return true;
    });
  },
);
