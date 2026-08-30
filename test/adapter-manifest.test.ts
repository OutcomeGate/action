import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cleanupMaterializedAdapter,
  loadAdapterManifest,
  materializeAdapter,
  parseAdapterManifest,
  verifyMaterializedAdapter,
} from "../src/adapter-manifest.js";
import { AdapterManifestValidationError } from "../src/errors.js";

function remoteManifest(): Record<string, unknown> {
  return {
    schemaVersion: "agentci.adapter-manifest.v1",
    id: "counter.v2",
    version: "2.0.0",
    runtime: {
      kind: "node-esm",
      apiVersion: "agentci.adapter.v2",
      protocolVersion: 1,
      entry: "adapter.mjs",
      operationTimeoutMs: 5_000,
      shutdownTimeoutMs: 2_000,
    },
    bundle: { root: "adapter.bundle" },
    contract: { tools: ["counter.read", "counter.increment"] },
    target: {
      kind: "remote",
      endpoint: "https://API.EXAMPLE.TEST:443/v1",
      tenant: "pilot-sandbox",
      apiVersion: "2026-08-29",
      configuration: { region: "us-central", retries: 0 },
    },
    credentials: { environment: ["Z_COUNTER_TOKEN", "A_COUNTER_TOKEN"] },
  };
}

async function createAdapterFixture(
  context: TestContext,
): Promise<{ root: string; bundle: string; manifestPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "agentci-adapter-manifest-test-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const bundle = join(root, "adapter.bundle");
  await mkdir(join(bundle, "lib"), { recursive: true });
  await writeFile(
    join(bundle, "adapter.mjs"),
    'export { value } from "./lib/value.mjs";\n',
    "utf8",
  );
  await writeFile(join(bundle, "lib", "value.mjs"), "export const value = 1;\n", "utf8");
  const manifestPath = join(root, "adapter.json");
  await writeFile(manifestPath, JSON.stringify(remoteManifest()), "utf8");
  return { root, bundle, manifestPath };
}

test("normalizes and identifies a closed adapter bundle", async (context) => {
  const { root, manifestPath } = await createAdapterFixture(context);
  const first = await loadAdapterManifest(manifestPath);
  const repeated = await loadAdapterManifest(manifestPath);

  assert.deepEqual(first.manifest.contract.tools, [
    "counter.increment",
    "counter.read",
  ]);
  assert.deepEqual(first.manifest.credentials.environment, [
    "A_COUNTER_TOKEN",
    "Z_COUNTER_TOKEN",
  ]);
  assert.equal(
    first.manifest.target.kind === "remote"
      ? first.manifest.target.endpoint
      : undefined,
    "https://api.example.test/v1",
  );
  assert.equal(first.identity.fileCount, 2);
  assert.equal(first.identity.entryPath, "adapter.mjs");
  assert.equal(first.identity.source, "external-manifest");
  assert.equal(
    first.identity.digestScope,
    "declared-config-and-adapter-bundle-bytes",
  );
  assert.match(first.identity.adapterDigest, /^[a-f0-9]{64}$/);
  assert.equal(first.identity.adapterDigest, repeated.identity.adapterDigest);
  assert.equal(JSON.stringify(first.identity).includes(root), false);
  assert.equal(first.manifestPath, manifestPath);
});

test("configuration and bundle changes alter the composite adapter identity", async (context) => {
  const { bundle, manifestPath } = await createAdapterFixture(context);
  const first = await loadAdapterManifest(manifestPath);

  const changedTarget = remoteManifest();
  (changedTarget.target as Record<string, unknown>).tenant = "other-sandbox";
  await writeFile(manifestPath, JSON.stringify(changedTarget), "utf8");
  const configured = await loadAdapterManifest(manifestPath);
  assert.equal(first.identity.bundleDigest, configured.identity.bundleDigest);
  assert.equal(first.identity.contractDigest, configured.identity.contractDigest);
  assert.notEqual(
    first.identity.configurationDigest,
    configured.identity.configurationDigest,
  );
  assert.notEqual(first.identity.adapterDigest, configured.identity.adapterDigest);

  await writeFile(
    join(bundle, "lib", "value.mjs"),
    "export const value = 2;\n",
    "utf8",
  );
  const changedBundle = await loadAdapterManifest(manifestPath);
  assert.equal(
    configured.identity.configurationDigest,
    changedBundle.identity.configurationDigest,
  );
  assert.notEqual(configured.identity.bundleDigest, changedBundle.identity.bundleDigest);
  assert.notEqual(configured.identity.adapterDigest, changedBundle.identity.adapterDigest);
});

test("strict parsing rejects unsafe configuration and process controls", () => {
  const cases: Array<{ name: string; mutate: (value: Record<string, unknown>) => void }> = [
    {
      name: "unknown field",
      mutate: (value) => {
        value.extra = true;
      },
    },
    {
      name: "path traversal",
      mutate: (value) => {
        (value.runtime as Record<string, unknown>).entry = "../adapter.mjs";
      },
    },
    {
      name: "HTTP endpoint",
      mutate: (value) => {
        (value.target as Record<string, unknown>).endpoint = "http://api.example.test";
      },
    },
    {
      name: "endpoint query",
      mutate: (value) => {
        (value.target as Record<string, unknown>).endpoint =
          "https://api.example.test/?token=not-allowed";
      },
    },
    {
      name: "dangerous environment variable",
      mutate: (value) => {
        (value.credentials as Record<string, unknown>).environment = ["NODE_OPTIONS"];
      },
    },
    {
      name: "runtime proxy environment variable",
      mutate: (value) => {
        (value.credentials as Record<string, unknown>).environment = ["HTTP_PROXY"];
      },
    },
    ...[
      "OPENSSL_CONF",
      "GLIBC_TUNABLES",
      "UV_THREADPOOL_SIZE",
      "MALLOC_CONF",
      "BASH_FUNC_INJECT",
      "BASHOPTS",
      "SHELLOPTS",
      "PS4",
      "POSIXLY_CORRECT",
      "JAVA_HOME",
      "CARGO_HOME",
      "RUST_LOG",
    ].map((name) => ({
      name: `process-control environment variable ${name}`,
      mutate: (value: Record<string, unknown>) => {
        (value.credentials as Record<string, unknown>).environment = [name];
      },
    })),
    {
      name: "leading-underscore environment variable",
      mutate: (value) => {
        (value.credentials as Record<string, unknown>).environment = ["_TOKEN"];
      },
    },
    {
      name: "invalid timeout",
      mutate: (value) => {
        (value.runtime as Record<string, unknown>).operationTimeoutMs = 0;
      },
    },
    {
      name: "non-JSON configuration",
      mutate: (value) => {
        (value.target as Record<string, unknown>).configuration = { value: Number.NaN };
      },
    },
  ];

  for (const candidate of cases) {
    const value = remoteManifest();
    candidate.mutate(value);
    assert.throws(
      () => parseAdapterManifest(value),
      AdapterManifestValidationError,
      candidate.name,
    );
  }

  const synthetic = remoteManifest();
  synthetic.target = {
    kind: "synthetic",
    reason: "offline deterministic fixture",
    configuration: {},
  };
  assert.throws(
    () => parseAdapterManifest(synthetic),
    /synthetic targets cannot request credential/,
  );
});

test("adapter capture rejects symlinks and hard links", async (context) => {
  const { bundle, manifestPath } = await createAdapterFixture(context);
  const linkedPath = join(bundle, "linked.mjs");
  await symlink("adapter.mjs", linkedPath);
  await assert.rejects(loadAdapterManifest(manifestPath), /symlink/);
  await rm(linkedPath);

  await link(join(bundle, "adapter.mjs"), linkedPath);
  await assert.rejects(loadAdapterManifest(manifestPath), /hard-linked/);
});

test("fresh adapter materializations preserve modes and detect mutation", async (context) => {
  const { manifestPath } = await createAdapterFixture(context);
  const capture = await loadAdapterManifest(manifestPath);
  const materialized = await materializeAdapter(capture);
  try {
    assert.equal(
      await readFile(materialized.modulePath, "utf8"),
      'export { value } from "./lib/value.mjs";\n',
    );
    assert.deepEqual(await verifyMaterializedAdapter(materialized, capture), []);
    await chmod(materialized.modulePath, 0o777);
    assert.ok((await verifyMaterializedAdapter(materialized, capture)).length > 0);
  } finally {
    await cleanupMaterializedAdapter(materialized);
  }
});
