import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "../..");

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(
    result.status,
    0,
    `git ${args[0] ?? ""} failed\n${result.stdout}\n${result.stderr}`,
  );
}

async function releaseRepository(
  context: { after(callback: () => Promise<void>): void },
  license: "MIT" | "UNLICENSED",
  includeLicense: boolean,
): Promise<{ root: string; script: string }> {
  const root = await mkdtemp(join(tmpdir(), "agentci-release-readiness-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts"));
  const script = join(root, "scripts/check-release-readiness.mjs");
  await copyFile(
    join(projectRoot, "scripts/check-release-readiness.mjs"),
    script,
  );
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({ name: "synthetic-release", license })}\n`,
    "utf8",
  );
  if (includeLicense) {
    await copyFile(
      join(projectRoot, "node_modules/undici-types/LICENSE"),
      join(root, "LICENSE"),
    );
  }
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "Release Fixture"]);
  git(root, ["config", "user.email", "release@users.noreply.github.com"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "Add release fixture"]);
  return { root, script };
}

function check(root: string, script: string) {
  return spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("release readiness keeps an unlicensed repository closed", async (context) => {
  const { root, script } = await releaseRepository(
    context,
    "UNLICENSED",
    false,
  );
  const result = check(root, script);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /license-file/);
  assert.match(result.stderr, /package-license/);
});

test("release readiness accepts canonical MIT terms with a concrete copyright", async (context) => {
  const { root, script } = await releaseRepository(context, "MIT", true);
  const result = check(root, script);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /license gate passed/);
});

test("release readiness rejects restrictions appended to canonical terms", async (context) => {
  const { root, script } = await releaseRepository(context, "MIT", true);
  await appendFile(join(root, "LICENSE"), "\nAdditional synthetic restriction.\n", "utf8");
  git(root, ["add", "LICENSE"]);
  git(root, ["commit", "-m", "Alter license terms"]);
  const result = check(root, script);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /license-content/);
});
