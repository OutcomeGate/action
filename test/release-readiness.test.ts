import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
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
  options: {
    license: "Apache-2.0" | "MIT" | "UNLICENSED";
    includeLicense: boolean;
    privatePackage?: boolean;
    lockLicense?: "Apache-2.0" | "MIT" | "UNLICENSED";
    changelogVersion?: string;
  },
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
    `${JSON.stringify({
      name: "synthetic-release",
      version: "0.0.0",
      private: options.privatePackage ?? true,
      license: options.license,
    })}\n`,
    "utf8",
  );
  await writeFile(
    join(root, "package-lock.json"),
    `${JSON.stringify({
      name: "synthetic-release",
      version: "0.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": {
          name: "synthetic-release",
          version: "0.0.0",
          license: options.lockLicense ?? options.license,
        },
      },
    })}\n`,
    "utf8",
  );
  await writeFile(
    join(root, "CHANGELOG.md"),
    `# Changelog\n\n## ${options.changelogVersion ?? "0.0.0"}\n`,
    "utf8",
  );
  if (options.includeLicense) {
    await copyFile(
      options.license === "Apache-2.0"
        ? join(projectRoot, "LICENSE")
        : join(projectRoot, "node_modules/undici-types/LICENSE"),
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
    { license: "UNLICENSED", includeLicense: false },
  );
  const result = check(root, script);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /license-file/);
  assert.match(result.stderr, /package-license/);
});

test("release readiness accepts canonical MIT terms with a concrete copyright", async (context) => {
  const { root, script } = await releaseRepository(context, {
    license: "MIT",
    includeLicense: true,
  });
  const result = check(root, script);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /release readiness passed/);
});

test("release readiness accepts canonical Apache-2.0 terms", async (context) => {
  const { root, script } = await releaseRepository(context, {
    license: "Apache-2.0",
    includeLicense: true,
  });
  const result = check(root, script);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /release readiness passed/);
});

test("release readiness rejects restrictions appended to canonical Apache terms", async (context) => {
  const { root, script } = await releaseRepository(context, {
    license: "Apache-2.0",
    includeLicense: true,
  });
  await appendFile(join(root, "LICENSE"), "\nAdditional synthetic restriction.\n", "utf8");
  git(root, ["add", "LICENSE"]);
  git(root, ["commit", "-m", "Alter license terms"]);
  const result = check(root, script);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /license-content/);
});

test("release readiness rejects a dirty checkout", async (context) => {
  const { root, script } = await releaseRepository(context, {
    license: "Apache-2.0",
    includeLicense: true,
  });
  await writeFile(join(root, "untracked.txt"), "synthetic dirty file\n", "utf8");
  const result = check(root, script);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /repository-clean/);
});

test("release readiness keeps the Developer Preview private on npm", async (context) => {
  const { root, script } = await releaseRepository(context, {
    license: "Apache-2.0",
    includeLicense: true,
    privatePackage: false,
  });
  const result = check(root, script);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /npm-private/);
});

test("release readiness rejects package-lock metadata drift", async (context) => {
  const { root, script } = await releaseRepository(context, {
    license: "Apache-2.0",
    includeLicense: true,
    lockLicense: "MIT",
  });
  const result = check(root, script);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /package-lock-metadata/);
});

test("release readiness requires the package version in the changelog", async (context) => {
  const { root, script } = await releaseRepository(context, {
    license: "Apache-2.0",
    includeLicense: true,
    changelogVersion: "9.9.9",
  });
  const changelog = await readFile(join(root, "CHANGELOG.md"), "utf8");
  assert.match(changelog, /9\.9\.9/);
  const result = check(root, script);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /changelog-version/);
});
