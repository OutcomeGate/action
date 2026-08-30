import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_STARTER_DIRECTORY,
  initializeStarter,
} from "../src/init.js";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "../..");
const cliPath = join(projectRoot, "dist/src/cli.js");

async function assertMissing(path: string): Promise<void> {
  await assert.rejects(access(path), (error: unknown) => {
    assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
    return true;
  });
}

async function runCli(
  cwd: string,
  args: readonly string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", rejectResult);
    child.once("close", (code) => resolveResult({ code, stdout, stderr }));
  });
}

test("init creates the default credential-free starter from a fixed template", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agentci-init-create-"));
  context.after(async () => rm(root, { recursive: true, force: true }));

  const target = await initializeStarter(undefined, root);
  assert.equal(
    target,
    join(await realpath(root), DEFAULT_STARTER_DIRECTORY),
  );

  const release = JSON.parse(
    await readFile(join(target, "agentci/release.manifest.json"), "utf8"),
  ) as {
    schemaVersion: string;
    candidate: { credentials: { kind: string } };
  };
  assert.equal(release.schemaVersion, "agentci.release.v2");
  assert.deepEqual(release.candidate.credentials, { kind: "none" });

  const adapter = JSON.parse(
    await readFile(join(target, "agentci/adapter.manifest.json"), "utf8"),
  ) as {
    runtime: { apiVersion: string };
    credentials: { environment: string[] };
  };
  assert.equal(adapter.runtime.apiVersion, "agentci.adapter.v2");
  assert.deepEqual(adapter.credentials.environment, []);

  const workflow = await readFile(
    join(target, ".github/workflows/agent-ci.yml"),
    "utf8",
  );
  const actionRefs = [...workflow.matchAll(/uses: [^\s@]+@([0-9a-f]{40})/g)];
  assert.equal(actionRefs.length, 2, "every generated action ref must be a full SHA");
  assert.match(workflow, /Reviewed full-SHA pin/);
  assert.match(workflow, /REQUIRED: replace the all-zero placeholder/);
  assert.match(workflow, /agent-ci-action@0{40}/);
});

test("init refuses existing, escaping, absolute, and symlink-escaping targets", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agentci-init-safety-"));
  const outside = await mkdtemp(join(tmpdir(), "agentci-init-outside-"));
  context.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  const existingEmpty = join(root, "existing-empty");
  await mkdir(existingEmpty);
  await assert.rejects(
    initializeStarter("existing-empty", root),
    /already exists; refusing to overwrite/,
  );

  const existingNonempty = join(root, "existing-nonempty");
  await mkdir(existingNonempty);
  const sentinel = join(existingNonempty, "keep.txt");
  await writeFile(sentinel, "do not replace\n", "utf8");
  await assert.rejects(
    initializeStarter("existing-nonempty", root),
    /already exists; refusing to overwrite/,
  );
  assert.equal(await readFile(sentinel, "utf8"), "do not replace\n");

  const escapedName = `${basename(root)}-escaped`;
  await assert.rejects(
    initializeStarter(`../${escapedName}`, root),
    /must remain within/,
  );
  await assertMissing(join(dirname(root), escapedName));

  await assert.rejects(
    initializeStarter(join(root, "absolute-target"), root),
    /must be a non-empty relative directory/,
  );
  await assertMissing(join(root, "absolute-target"));

  await assert.rejects(
    initializeStarter("line\nbreak", root),
    /must be a non-empty relative directory/,
  );
  await assertMissing(join(root, "line\nbreak"));

  await symlink(outside, join(root, "linked-parent"));
  await assert.rejects(
    initializeStarter("linked-parent/escaped", root),
    /parent must remain within/,
  );
  await assertMissing(join(outside, "escaped"));
});

test("the CLI-generated project validates and passes end to end", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agentci-init-e2e-"));
  context.after(async () => rm(root, { recursive: true, force: true }));

  const initialized = await runCli(root, ["init", "generated"]);
  assert.equal(initialized.code, 0, `${initialized.stdout}\n${initialized.stderr}`);
  assert.match(initialized.stdout, /created Agent CI starter at generated/);
  assert.match(initialized.stdout, /Next:/);
  assert.match(initialized.stdout, /cd 'generated'/);
  assert.match(initialized.stdout, /Follow README\.md/);
  assert.match(initialized.stdout, /intentionally non-runnable/);

  const spaced = await runCli(root, ["init", "generated starter"]);
  assert.equal(spaced.code, 0, `${spaced.stdout}\n${spaced.stderr}`);
  assert.match(spaced.stdout, /cd 'generated starter'/);

  const generated = join(root, "generated");
  const commands: readonly (readonly string[])[] = [
    [
      "validate-release",
      "--manifest",
      "agentci/release.manifest.json",
    ],
    [
      "validate-adapter",
      "--manifest",
      "agentci/adapter.manifest.json",
    ],
    [
      "adapter-check",
      "--adapter-manifest",
      "agentci/adapter.manifest.json",
    ],
    [
      "validate",
      "--suite",
      "agentci/suite.json",
      "--adapter-manifest",
      "agentci/adapter.manifest.json",
    ],
    [
      "check",
      "--suite",
      "agentci/suite.json",
      "--manifest",
      "agentci/release.manifest.json",
      "--adapter-manifest",
      "agentci/adapter.manifest.json",
      "--require-explicit-candidate-policy",
    ],
  ];

  for (const command of commands) {
    const result = await runCli(generated, command);
    assert.equal(
      result.code,
      0,
      `agentci ${command.join(" ")} failed\n${result.stdout}\n${result.stderr}`,
    );
  }

  const passed = await runCli(generated, commands.at(-1)!);
  assert.equal(passed.code, 0, `${passed.stdout}\n${passed.stderr}`);
  assert.match(passed.stdout, /^PASS starter-agent-v1/m);
});
