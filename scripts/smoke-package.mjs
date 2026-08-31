#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(
  await readFile(resolve(projectRoot, "package.json"), "utf8"),
);
const root = await mkdtemp(join(tmpdir(), "agentci-package-smoke-"));
const cache = join(root, "npm-cache");
const packageDirectory = join(root, "package");
const consumer = join(root, "consumer");
const workspace = join(root, "workspace");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NPM_CONFIG_CACHE: cache },
  });
  if (result.status !== 0) {
    throw new Error(`package smoke command failed: ${command} ${args[0] ?? ""}`);
  }
  return result.stdout;
}

try {
  await mkdir(packageDirectory);
  await mkdir(consumer);
  await mkdir(workspace);
  const packed = JSON.parse(
    run(
      npm,
      [
        "pack",
        projectRoot,
        "--pack-destination",
        packageDirectory,
        "--json",
        "--ignore-scripts",
      ],
      projectRoot,
    ),
  );
  if (!Array.isArray(packed) || packed.length !== 1) {
    throw new Error("package smoke received an unexpected pack record");
  }
  const archive = join(packageDirectory, packed[0].filename);
  run(
    npm,
    [
      "install",
      "--prefix",
      consumer,
      archive,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ],
    consumer,
  );
  const cli = join(
    consumer,
    "node_modules",
    packageJson.name,
    "dist",
    "src",
    "cli.js",
  );
  const installedCli = join(
    consumer,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "outcomegate.cmd" : "outcomegate",
  );
  const runCli = (args, cwd) =>
    process.platform === "win32"
      ? run(process.execPath, [cli, ...args], cwd)
      : run(installedCli, args, cwd);

  const help = runCli(["--help"], consumer);
  if (!/^Usage:/m.test(help) || !/outcomegate check/u.test(help)) {
    throw new Error("installed package binary did not return OutcomeGate help");
  }
  run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `const api = await import(${JSON.stringify(packageJson.name)}); if (typeof api.runSuite !== "function") throw new Error("missing runSuite export");`,
    ],
    consumer,
  );

  runCli(["init", "starter"], workspace);
  const starter = join(workspace, "starter");
  const output = runCli(
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
    starter,
  );
  if (!/^PASS /m.test(output)) {
    throw new Error("installed package starter did not report PASS");
  }
  process.stdout.write("installed package and generated starter smoke passed\n");
} finally {
  await rm(root, { recursive: true, force: true });
}
