import assert from "node:assert/strict";
import test from "node:test";
import {
  cp,
  chmod,
  link,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ReleaseValidationError } from "../src/errors.js";
import {
  cleanupMaterializedRelease,
  loadReleaseManifest,
  materializeRelease,
  parseReleaseManifest,
  verifyMaterializedRelease,
} from "../src/release.js";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "../..");
const manifestPath = resolve(
  projectRoot,
  "examples/refunds/releases/agent-v1.release.json",
);

test("captures a closed release bundle with component digests", async () => {
  const capture = await loadReleaseManifest(manifestPath);

  assert.equal(capture.identity.digestScope, "declared-config-and-bundle-bytes");
  assert.equal(capture.identity.fileCount, 4);
  assert.equal(capture.identity.entryPath, "candidate.mjs");
  assert.match(capture.identity.releaseDigest, /^[a-f0-9]{64}$/);
  assert.notEqual(capture.identity.promptDigest, capture.identity.harnessDigest);
  assert.equal(capture.manifest.schemaVersion, "agentci.release.v2");
});

test("release v2 requires an explicit closed candidate credential policy", () => {
  const base = {
    schemaVersion: "agentci.release.v2",
    name: "candidate-policy",
    runtime: { kind: "node-jsonl", protocolVersion: 1, entry: "candidate.mjs" },
    bundle: { root: "bundle" },
    model: {
      kind: "remote",
      provider: "synthetic-provider",
      identifier: "synthetic-model",
      revision: "fixed",
    },
    components: { prompts: ["prompt.md"], toolSchemas: ["tools.json"] },
  };
  assert.throws(() => parseReleaseManifest(base), /candidate must be an object/);
  const parsed = parseReleaseManifest({
    ...base,
    candidate: { credentials: { kind: "none" } },
  });
  assert.equal(parsed.schemaVersion, "agentci.release.v2");
  assert.deepEqual(parsed.candidate.credentials, { kind: "none" });
  assert.throws(
    () =>
      parseReleaseManifest({
        ...base,
        model: { kind: "none", reason: "offline" },
        candidate: {
          credentials: {
            kind: "environment",
            environment: ["MODEL_PROVIDER_KEY"],
          },
        },
      }),
    /credentials require a declared remote model/,
  );
});

test("release v2 accepts closed local model artifacts and rejects unsafe variants", () => {
  const base = {
    schemaVersion: "agentci.release.v2",
    name: "local-model",
    runtime: { kind: "node-jsonl", protocolVersion: 1, entry: "candidate.mjs" },
    bundle: { root: "bundle" },
    model: {
      kind: "local",
      identifier: "local-linear-model",
      revision: "int8",
      format: "example.linear.v1",
      artifacts: ["tokenizer.json", "model.json"],
      configuration: { precision: "int8" },
    },
    components: { prompts: ["prompt.md"], toolSchemas: ["tools.json"] },
    candidate: { credentials: { kind: "none" } },
  };
  const parsed = parseReleaseManifest(base);
  assert.equal(parsed.schemaVersion, "agentci.release.v2");
  assert.equal(parsed.model.kind, "local");
  if (parsed.model.kind === "local") {
    assert.deepEqual(parsed.model.artifacts, ["model.json", "tokenizer.json"]);
  }

  assert.throws(
    () => parseReleaseManifest({ ...base, schemaVersion: "agentci.release.v1" }),
    /requires agentci\.release\.v2/,
  );
  assert.throws(
    () =>
      parseReleaseManifest({
        ...base,
        model: { ...base.model, artifacts: ["model.json", "model.json"] },
      }),
    /must not contain duplicates/,
  );
  assert.throws(
    () =>
      parseReleaseManifest({
        ...base,
        model: { ...base.model, artifacts: ["../model.json"] },
      }),
    /normalized relative POSIX path/,
  );
  assert.throws(
    () =>
      parseReleaseManifest({
        ...base,
        model: { ...base.model, artifacts: ["candidate.mjs"] },
    }),
    /cannot also be the runtime entry/,
  );
  assert.throws(
    () =>
      parseReleaseManifest({
        ...base,
        model: { ...base.model, unsupported: true },
      }),
    /model\.unsupported is not supported/,
  );
  assert.throws(
    () =>
      parseReleaseManifest({
        ...base,
        model: {
          ...base.model,
          configuration: { precision: undefined },
        },
      }),
    /model\.configuration must be JSON/,
  );
  assert.throws(
    () =>
      parseReleaseManifest({
        ...base,
        candidate: {
          credentials: {
            kind: "environment",
            environment: ["LOCAL_MODEL_KEY"],
          },
        },
      }),
    /credentials require a declared remote model/,
  );
});

test("local model artifact bytes are required and alter release identity", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "outcomegate-local-model-test-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "bundle"));
  await writeFile(join(root, "bundle/candidate.mjs"), "", "utf8");
  await writeFile(join(root, "bundle/prompt.md"), "prompt", "utf8");
  await writeFile(join(root, "bundle/tools.json"), "{}", "utf8");
  await writeFile(join(root, "bundle/model.json"), '{"weight":1}', "utf8");
  const manifest = {
    schemaVersion: "agentci.release.v2",
    name: "local-model-artifact",
    runtime: { kind: "node-jsonl", protocolVersion: 1, entry: "candidate.mjs" },
    bundle: { root: "bundle" },
    model: {
      kind: "local",
      identifier: "local-linear-model",
      revision: "fp32",
      format: "example.linear.v1",
      artifacts: ["model.json"],
    },
    components: { prompts: ["prompt.md"], toolSchemas: ["tools.json"] },
    candidate: { credentials: { kind: "none" } },
  };
  const manifestPath = join(root, "release.json");
  await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

  const first = await loadReleaseManifest(manifestPath);
  assert.ok(first.identity.files.some((file) => file.path === "model.json"));
  await writeFile(join(root, "bundle/model.json"), '{"weight":2}', "utf8");
  const second = await loadReleaseManifest(manifestPath);
  assert.equal(
    first.identity.modelDeclarationDigest,
    second.identity.modelDeclarationDigest,
  );
  assert.notEqual(first.identity.bundleDigest, second.identity.bundleDigest);
  assert.notEqual(first.identity.releaseDigest, second.identity.releaseDigest);

  await writeFile(
    manifestPath,
    JSON.stringify({
      ...manifest,
      model: {
        ...manifest.model,
        revision: "int8",
        configuration: { precision: "int8" },
      },
    }),
    "utf8",
  );
  const changedDeclaration = await loadReleaseManifest(manifestPath);
  assert.equal(second.identity.bundleDigest, changedDeclaration.identity.bundleDigest);
  assert.notEqual(
    second.identity.modelDeclarationDigest,
    changedDeclaration.identity.modelDeclarationDigest,
  );
  assert.notEqual(
    second.identity.releaseDigest,
    changedDeclaration.identity.releaseDigest,
  );

  const materialized = await materializeRelease(second);
  try {
    await writeFile(join(materialized.root, "model.json"), '{"weight":3}', "utf8");
    assert.ok((await verifyMaterializedRelease(materialized, second)).length > 0);
  } finally {
    await cleanupMaterializedRelease(materialized);
  }

  await writeFile(
    manifestPath,
    JSON.stringify({
      ...manifest,
      model: { ...manifest.model, artifacts: ["missing-model.json"] },
    }),
    "utf8",
  );
  await assert.rejects(
    loadReleaseManifest(manifestPath),
    /manifest references files absent from the bundle/,
  );
});

test("rejects path traversal before reading a bundle", () => {
  assert.throws(
    () =>
      parseReleaseManifest({
        schemaVersion: "agentci.release.v1",
        name: "unsafe",
        runtime: {
          kind: "node-jsonl",
          protocolVersion: 1,
          entry: "../candidate.mjs",
        },
        bundle: { root: "bundle" },
        model: { kind: "none", reason: "test" },
        components: {
          prompts: ["prompt.md"],
          toolSchemas: ["tools.json"],
        },
      }),
    ReleaseValidationError,
  );
});

test("rejects symlinks anywhere in a release bundle", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agentci-release-test-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "bundle"));
  await writeFile(join(root, "bundle", "candidate.mjs"), "", "utf8");
  await writeFile(join(root, "bundle", "prompt.md"), "prompt", "utf8");
  await writeFile(join(root, "bundle", "tools.json"), "{}", "utf8");
  await symlink("prompt.md", join(root, "bundle", "prompt-link.md"));
  await writeFile(
    join(root, "release.json"),
    JSON.stringify({
      schemaVersion: "agentci.release.v1",
      name: "symlinked",
      runtime: { kind: "node-jsonl", protocolVersion: 1, entry: "candidate.mjs" },
      bundle: { root: "bundle" },
      model: { kind: "none", reason: "test" },
      components: { prompts: ["prompt.md"], toolSchemas: ["tools.json"] },
    }),
    "utf8",
  );

  await assert.rejects(
    loadReleaseManifest(join(root, "release.json")),
    ReleaseValidationError,
  );
});

test("rejects a symlink in the bundle root path", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agentci-release-test-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "actual", "bundle"), { recursive: true });
  await writeFile(join(root, "actual", "bundle", "candidate.mjs"), "", "utf8");
  await writeFile(join(root, "actual", "bundle", "prompt.md"), "prompt", "utf8");
  await writeFile(join(root, "actual", "bundle", "tools.json"), "{}", "utf8");
  await symlink("actual", join(root, "linked"));
  await writeFile(
    join(root, "release.json"),
    JSON.stringify({
      schemaVersion: "agentci.release.v1",
      name: "symlinked-root",
      runtime: { kind: "node-jsonl", protocolVersion: 1, entry: "candidate.mjs" },
      bundle: { root: "linked/bundle" },
      model: { kind: "none", reason: "test" },
      components: { prompts: ["prompt.md"], toolSchemas: ["tools.json"] },
    }),
    "utf8",
  );

  await assert.rejects(
    loadReleaseManifest(join(root, "release.json")),
    ReleaseValidationError,
  );
});

test("rejects hard-linked bundle files whose aliasing cannot be materialized", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agentci-release-test-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "bundle"));
  await writeFile(join(root, "bundle", "candidate.mjs"), "", "utf8");
  await writeFile(join(root, "bundle", "prompt.md"), "prompt", "utf8");
  await link(
    join(root, "bundle", "prompt.md"),
    join(root, "bundle", "prompt-alias.md"),
  );
  await writeFile(join(root, "bundle", "tools.json"), "{}", "utf8");
  await writeFile(
    join(root, "release.json"),
    JSON.stringify({
      schemaVersion: "agentci.release.v1",
      name: "hard-linked",
      runtime: { kind: "node-jsonl", protocolVersion: 1, entry: "candidate.mjs" },
      bundle: { root: "bundle" },
      model: { kind: "none", reason: "test" },
      components: { prompts: ["prompt.md"], toolSchemas: ["tools.json"] },
    }),
    "utf8",
  );

  await assert.rejects(loadReleaseManifest(join(root, "release.json")), /hard-linked/);
});

test("rejects oversized files before loading their contents", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agentci-release-test-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "bundle"));
  await writeFile(join(root, "bundle", "candidate.mjs"), "", "utf8");
  await truncate(join(root, "bundle", "candidate.mjs"), 21 * 1024 * 1024);
  await writeFile(join(root, "bundle", "prompt.md"), "prompt", "utf8");
  await writeFile(join(root, "bundle", "tools.json"), "{}", "utf8");
  await writeFile(
    join(root, "release.json"),
    JSON.stringify({
      schemaVersion: "agentci.release.v1",
      name: "oversized",
      runtime: { kind: "node-jsonl", protocolVersion: 1, entry: "candidate.mjs" },
      bundle: { root: "bundle" },
      model: { kind: "none", reason: "test" },
      components: { prompts: ["prompt.md"], toolSchemas: ["tools.json"] },
    }),
    "utf8",
  );

  await assert.rejects(
    loadReleaseManifest(join(root, "release.json")),
    /exceeds the 20971520-byte supported limit/,
  );
});

test("uses one global canonical order for nested bundle files", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agentci-release-test-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "bundle", "lib"), { recursive: true });
  await writeFile(join(root, "bundle", "candidate.mjs"), "", "utf8");
  await writeFile(join(root, "bundle", "lib", "x.mjs"), "x", "utf8");
  await writeFile(join(root, "bundle", "lib.js"), "sibling", "utf8");
  await writeFile(join(root, "bundle", "prompt.md"), "prompt", "utf8");
  await writeFile(join(root, "bundle", "tools.json"), "{}", "utf8");
  await writeFile(
    join(root, "release.json"),
    JSON.stringify({
      schemaVersion: "agentci.release.v1",
      name: "nested",
      runtime: { kind: "node-jsonl", protocolVersion: 1, entry: "candidate.mjs" },
      bundle: { root: "bundle" },
      model: { kind: "none", reason: "test" },
      components: { prompts: ["prompt.md"], toolSchemas: ["tools.json"] },
    }),
    "utf8",
  );

  const capture = await loadReleaseManifest(join(root, "release.json"));
  assert.deepEqual(
    capture.identity.files.map((file) => file.path),
    ["candidate.mjs", "lib.js", "lib/x.mjs", "prompt.md", "tools.json"],
  );
});

test("model declaration changes alter release identity", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agentci-release-test-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await cp(
    resolve(projectRoot, "examples/refunds/releases/agent-v1.bundle"),
    join(root, "bundle"),
    { recursive: true },
  );
  const manifest = {
    schemaVersion: "agentci.release.v1",
    name: "identity-test",
    runtime: { kind: "node-jsonl", protocolVersion: 1, entry: "candidate.mjs" },
    bundle: { root: "bundle" },
    model: { kind: "none", reason: "first declaration" },
    components: { prompts: ["prompt.md"], toolSchemas: ["tool-schema.json"] },
  };
  await writeFile(join(root, "first.json"), JSON.stringify(manifest), "utf8");
  await writeFile(
    join(root, "second.json"),
    JSON.stringify({
      ...manifest,
      model: { kind: "none", reason: "changed declaration" },
    }),
    "utf8",
  );
  const first = await loadReleaseManifest(join(root, "first.json"));
  const second = await loadReleaseManifest(join(root, "second.json"));

  assert.equal(first.identity.bundleDigest, second.identity.bundleDigest);
  assert.notEqual(
    first.identity.modelDeclarationDigest,
    second.identity.modelDeclarationDigest,
  );
  assert.notEqual(first.identity.releaseDigest, second.identity.releaseDigest);
});

test("candidate credential-name declarations alter release v2 identity", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agentci-release-v2-policy-test-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await cp(
    resolve(projectRoot, "examples/refunds/releases/agent-v1.bundle"),
    join(root, "bundle"),
    { recursive: true },
  );
  const manifest = {
    schemaVersion: "agentci.release.v2",
    name: "candidate-policy-identity",
    runtime: { kind: "node-jsonl", protocolVersion: 1, entry: "candidate.mjs" },
    bundle: { root: "bundle" },
    model: {
      kind: "remote",
      provider: "synthetic-provider",
      identifier: "synthetic-model",
      revision: "fixed",
    },
    components: { prompts: ["prompt.md"], toolSchemas: ["tool-schema.json"] },
    candidate: {
      credentials: {
        kind: "environment",
        environment: ["MODEL_PROVIDER_KEY"],
      },
    },
  };
  await writeFile(join(root, "first.json"), JSON.stringify(manifest), "utf8");
  await writeFile(
    join(root, "second.json"),
    JSON.stringify({
      ...manifest,
      candidate: {
        credentials: {
          kind: "environment",
          environment: ["SECOND_MODEL_PROVIDER_KEY"],
        },
      },
    }),
    "utf8",
  );
  const first = await loadReleaseManifest(join(root, "first.json"));
  const second = await loadReleaseManifest(join(root, "second.json"));
  assert.equal(first.identity.bundleDigest, second.identity.bundleDigest);
  assert.notEqual(first.identity.manifestDigest, second.identity.manifestDigest);
  assert.notEqual(first.identity.releaseDigest, second.identity.releaseDigest);
});

test("detects files created inside a materialized release", async () => {
  const capture = await loadReleaseManifest(manifestPath);
  const materialized = await materializeRelease(capture);
  try {
    await writeFile(join(materialized.root, "unexpected.txt"), "mutation", "utf8");
    assert.ok((await verifyMaterializedRelease(materialized, capture)).length > 0);
  } finally {
    await cleanupMaterializedRelease(materialized);
  }
});

test("detects mode changes inside a materialized release", async () => {
  const capture = await loadReleaseManifest(manifestPath);
  const materialized = await materializeRelease(capture);
  try {
    await chmod(materialized.candidatePath, 0o777);
    assert.ok((await verifyMaterializedRelease(materialized, capture)).length > 0);
  } finally {
    await cleanupMaterializedRelease(materialized);
  }
});
