import assert from "node:assert/strict";
import { access, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadAdapterManifest } from "../src/adapter-manifest.js";
import { loadReleaseManifest } from "../src/release.js";
import { writeTextFile } from "../src/report.js";
import { SecretScanError } from "../src/secret-scan.js";
import { loadSuite } from "../src/suite.js";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "../..");
const counterExample = resolve(projectRoot, "examples/counter");

async function expectSafeScanFailure(
  operation: Promise<unknown>,
  canary: string,
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof SecretScanError || error instanceof Error);
    assert.match((error as Error).message, /static secret scanning/);
    assert.equal((error as Error).message.includes(canary), false);
    return true;
  });
}

test("suite loading fails closed on a secret-shaped input", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agentci-suite-secret-boundary-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const canary = `ghp_${"s".repeat(36)}`;
  const suite = JSON.parse(
    await readFile(join(counterExample, "suite.json"), "utf8"),
  ) as { scenarios: Array<{ task: Record<string, unknown> }> };
  suite.scenarios[0]!.task.canary = canary;
  const suitePath = join(root, "suite.json");
  await writeFile(suitePath, JSON.stringify(suite), "utf8");
  await expectSafeScanFailure(loadSuite(suitePath), canary);
});

test("normalized JSON scans catch escaped credential shapes before use", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agentci-normalized-json-secret-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const counterRoot = join(root, "counter");
  await cp(counterExample, counterRoot, { recursive: true });
  const canary = `ghp_${"a".repeat(36)}`;
  const escapedCanary = `ghp_\\u0061${"a".repeat(35)}`;

  const suitePath = join(counterRoot, "suite.json");
  const suiteRaw = await readFile(suitePath, "utf8");
  await writeFile(
    suitePath,
    suiteRaw.replace(
      "Increment the declared counter exactly once",
      `Increment the declared counter exactly once ${escapedCanary}`,
    ),
    "utf8",
  );
  await expectSafeScanFailure(loadSuite(suitePath), canary);
  await writeFile(suitePath, suiteRaw, "utf8");

  const releasePath = join(counterRoot, "releases/agent.release.json");
  const releaseRaw = await readFile(releasePath, "utf8");
  await writeFile(
    releasePath,
    releaseRaw.replace(
      "Deterministic external-adapter example.",
      `Deterministic external-adapter example. ${escapedCanary}`,
    ),
    "utf8",
  );
  await expectSafeScanFailure(loadReleaseManifest(releasePath), canary);
  await writeFile(releasePath, releaseRaw, "utf8");

  const adapterPath = join(counterRoot, "adapter.manifest.json");
  const adapterRaw = await readFile(adapterPath, "utf8");
  await writeFile(
    adapterPath,
    adapterRaw.replace(
      "Self-contained adapter-host integration example",
      `Self-contained adapter-host integration example ${escapedCanary}`,
    ),
    "utf8",
  );
  await expectSafeScanFailure(loadAdapterManifest(adapterPath), canary);
  await writeFile(adapterPath, adapterRaw, "utf8");

  const schemaPath = join(
    counterRoot,
    "releases/agent.bundle/tool-schema.json",
  );
  const schema = JSON.parse(await readFile(schemaPath, "utf8")) as Record<
    string,
    unknown
  >;
  const rawWithEscapedCanary = JSON.stringify({
    ...schema,
    canary: "PLACEHOLDER",
  }).replace("PLACEHOLDER", escapedCanary);
  await writeFile(schemaPath, rawWithEscapedCanary, "utf8");
  await expectSafeScanFailure(loadReleaseManifest(releasePath), canary);

  await writeFile(schemaPath, JSON.stringify(schema), "utf8");
  await writeFile(
    join(counterRoot, "releases/agent.bundle/opaque.JSON"),
    `{"canary":"${escapedCanary}"}`,
    "utf8",
  );
  await expectSafeScanFailure(loadReleaseManifest(releasePath), canary);
});

test("declared JSON rejects duplicate members before normalization", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agentci-strict-declaration-json-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const counterRoot = join(root, "counter");
  await cp(counterExample, counterRoot, { recursive: true });
  const canary = `ghp_${"d".repeat(36)}`;
  const escapedCanary = `ghp_\\u0064${"d".repeat(35)}`;

  const expectDuplicateFailure = async (
    operation: Promise<unknown>,
  ): Promise<void> => {
    await assert.rejects(operation, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /duplicate member/);
      assert.equal(error.message.includes(canary), false);
      return true;
    });
  };
  const withDiscardedMember = (raw: string): string =>
    raw.replace(
      /^\{/,
      `{"discarded":"${escapedCanary}","discarded":"safe",`,
    );

  const suitePath = join(counterRoot, "suite.json");
  await writeFile(
    suitePath,
    withDiscardedMember(await readFile(suitePath, "utf8")),
    "utf8",
  );
  await expectDuplicateFailure(loadSuite(suitePath));

  const releasePath = join(counterRoot, "releases/agent.release.json");
  await writeFile(
    releasePath,
    withDiscardedMember(await readFile(releasePath, "utf8")),
    "utf8",
  );
  await expectDuplicateFailure(loadReleaseManifest(releasePath));

  const adapterPath = join(counterRoot, "adapter.manifest.json");
  await writeFile(
    adapterPath,
    withDiscardedMember(await readFile(adapterPath, "utf8")),
    "utf8",
  );
  await expectDuplicateFailure(loadAdapterManifest(adapterPath));
});

test("release and adapter bundle capture scan every declared file", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agentci-bundle-secret-boundary-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const counterRoot = join(root, "counter");
  await cp(counterExample, counterRoot, { recursive: true });

  const releaseCanary = `github_pat_${"r".repeat(24)}`;
  const releaseEntry = join(counterRoot, "releases/agent.bundle/candidate.mjs");
  await writeFile(
    releaseEntry,
    `${await readFile(releaseEntry, "utf8")}\n// ${releaseCanary}\n`,
    "utf8",
  );
  await expectSafeScanFailure(
    loadReleaseManifest(join(counterRoot, "releases/agent.release.json")),
    releaseCanary,
  );

  const adapterCanary = `sk_test_${"a".repeat(24)}`;
  const adapterEntry = join(counterRoot, "adapter.bundle/adapter.mjs");
  await writeFile(
    adapterEntry,
    `${await readFile(adapterEntry, "utf8")}\n// ${adapterCanary}\n`,
    "utf8",
  );
  await expectSafeScanFailure(
    loadAdapterManifest(join(counterRoot, "adapter.manifest.json")),
    adapterCanary,
  );
});

test("evidence writing scans the exact serialized publication boundary", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agentci-output-secret-boundary-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const canary = `sk-proj-${"p".repeat(30)}`;
  const outputPath = join(root, "publication.md");
  await expectSafeScanFailure(
    writeTextFile(outputPath, `unsafe publication ${canary}`),
    canary,
  );
  await assert.rejects(access(outputPath), (error: unknown) => {
    assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
    return true;
  });
});
