#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(projectRoot, "dist");
const outputFromRoot = relative(projectRoot, output);
if (outputFromRoot !== "dist") {
  throw new Error("refusing to clean an unexpected compiler output path");
}
const packageJson = JSON.parse(
  await readFile(resolve(projectRoot, "package.json"), "utf8"),
);
if (packageJson.name !== "agent-ci-mvp") {
  throw new Error("refusing to build from an unexpected package root");
}

await rm(output, { recursive: true, force: true });
const compiler = join(projectRoot, "node_modules", "typescript", "bin", "tsc");
const result = spawnSync(process.execPath, [compiler, "-p", "tsconfig.json"], {
  cwd: projectRoot,
  stdio: "inherit",
});
if (result.status !== 0) process.exit(result.status ?? 1);
