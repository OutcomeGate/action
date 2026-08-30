import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "../..");

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(
  cwd: string,
  command: string,
  args: readonly string[],
  extraEnv: Readonly<Record<string, string>> = {},
): CommandResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv, LC_ALL: "C" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.signal) throw result.error ?? new Error("command failed");
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function git(cwd: string, args: readonly string[]): string {
  const result = run(cwd, "git", args);
  assert.equal(
    result.status,
    0,
    `git ${args[0] ?? ""} failed\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout;
}

async function initializeRepository(
  context: { after(callback: () => Promise<void>): void },
  kind: "content" | "history",
): Promise<{ root: string; audit: string }> {
  const root = await mkdtemp(join(tmpdir(), `agentci-${kind}-audit-`));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts"), { recursive: true });
  const auditName =
    kind === "content"
      ? "audit-public-content.mjs"
      : "audit-public-history.mjs";
  const audit = join(root, "scripts", auditName);
  await copyFile(join(projectRoot, "scripts", auditName), audit);
  if (kind === "content") {
    await mkdir(join(root, "dist/src"), { recursive: true });
    await copyFile(
      join(projectRoot, "dist/src/secret-scan.js"),
      join(root, "dist/src/secret-scan.js"),
    );
    await writeFile(join(root, "package.json"), '{"type":"module"}\n', "utf8");
  }
  await writeFile(join(root, "README.md"), "# Synthetic audit fixture\n", "utf8");
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "Audit Fixture"]);
  git(root, ["config", "user.email", "audit@users.noreply.github.com"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "Add release audit fixture"]);
  return { root, audit };
}

function runAudit(root: string, audit: string): CommandResult {
  return run(root, process.execPath, [audit]);
}

function assertSuppressedFailure(
  result: CommandResult,
  forbidden: readonly string[],
): void {
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  for (const value of forbidden) {
    assert.doesNotMatch(result.stdout, new RegExp(value, "u"));
    assert.doesNotMatch(result.stderr, new RegExp(value, "u"));
  }
}

test("public content audit passes a clean isolated repository", async (context) => {
  const { root, audit } = await initializeRepository(context, "content");
  const result = runAudit(root, audit);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /public content audit passed/);
});

test("public content audit scans staged bytes even when working bytes are safe", async (context) => {
  const { root, audit } = await initializeRepository(context, "content");
  const path = join(root, "examples/probe.md");
  await mkdir(dirname(path), { recursive: true });
  const sensitive = `${["pass", "word"].join("")} = "synthetic-audit-value"\n`;
  await writeFile(path, sensitive, "utf8");
  git(root, ["add", "examples/probe.md"]);
  await writeFile(path, "Synthetic safe working copy.\n", "utf8");

  assertSuppressedFailure(runAudit(root, audit), [
    "synthetic-audit-value",
    "examples/probe.md",
  ]);
});

test("public content audit rejects historical sensitive prose after deletion", async (context) => {
  const { root, audit } = await initializeRepository(context, "content");
  const path = join(root, "examples/notes.md");
  await mkdir(dirname(path), { recursive: true });
  const sensitive = ["Synthetic revenue", "forecast material."].join(" ");
  await writeFile(path, `${sensitive}\n`, "utf8");
  git(root, ["add", "examples/notes.md"]);
  git(root, ["commit", "-m", "Add example notes"]);
  await unlink(path);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "Remove example notes"]);

  assertSuppressedFailure(runAudit(root, audit), [
    ["revenue", "forecast"].join(" "),
    "notes.md",
  ]);
});

test("public content audit rejects non-UTF8 working files", async (context) => {
  const { root, audit } = await initializeRepository(context, "content");
  const path = join(root, "src/probe.ts");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Uint8Array.from([0xff, 0xfe, 0x00, 0x61]));

  assertSuppressedFailure(runAudit(root, audit), ["src/probe.ts"]);
});

test("public content audit follows nested annotated tag objects", async (context) => {
  const { root, audit } = await initializeRepository(context, "content");
  const sensitive = ["Synthetic executive", "summary"].join(" ");
  git(root, ["tag", "-a", "inner", "-m", sensitive]);
  git(root, ["tag", "-a", "outer", "inner", "-m", "Release annotation"]);
  git(root, ["tag", "-d", "inner"]);

  assertSuppressedFailure(runAudit(root, audit), [
    ["executive", "summary"].join(" "),
  ]);
});

test("public history audit passes a clean isolated repository", async (context) => {
  const { root, audit } = await initializeRepository(context, "history");
  const result = runAudit(root, audit);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Public history audit passed/);
});

test("public history audit rejects forbidden historical paths after deletion", async (context) => {
  const { root, audit } = await initializeRepository(context, "history");
  const path = join(root, "src/innocent.pdf");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "Synthetic binary-shaped document.\n", "utf8");
  git(root, ["add", "src/innocent.pdf"]);
  git(root, ["commit", "-m", "Add test document"]);
  await unlink(path);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "Remove test document"]);

  assertSuppressedFailure(runAudit(root, audit), ["innocent.pdf"]);
});

test("public history audit rejects non-noreply commit metadata", async (context) => {
  const { root, audit } = await initializeRepository(context, "history");
  git(root, ["config", "user.email", "person@example.invalid"]);
  const readme = join(root, "README.md");
  const contents = await readFile(readme, "utf8");
  await writeFile(readme, `${contents}\nUpdate.\n`, "utf8");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "Update readme"]);

  assertSuppressedFailure(runAudit(root, audit), ["person@example.invalid"]);
});
