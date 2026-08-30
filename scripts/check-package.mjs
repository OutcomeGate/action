#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cache = await mkdtemp(join(tmpdir(), "agentci-pack-cache-"));
const result = spawnSync(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["pack", "--dry-run", "--json", "--ignore-scripts"],
  {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, NPM_CONFIG_CACHE: cache },
  },
);

if (result.status !== 0) {
  process.stderr.write("package dry run failed\n");
  process.exit(result.status ?? 1);
}

let records;
try {
  records = JSON.parse(result.stdout);
} catch {
  process.stderr.write("package dry run returned invalid JSON\n");
  process.exit(1);
}
if (!Array.isArray(records) || records.length !== 1) {
  process.stderr.write("package dry run returned an unexpected record count\n");
  process.exit(1);
}

const record = records[0];
const paths = new Set(record.files.map((entry) => entry.path));
const required = [
  "README.md",
  "SECURITY.md",
  "dist/src/cli.js",
  "dist/src/index.js",
  "docs/QUICKSTART.md",
  "templates/starter/agentci/suite.json",
];
const forbiddenPrefixes = [
  ".github/",
  "examples/",
  "scripts/",
  "src/",
  "test/",
];
const failures = [];
for (const path of required) {
  if (!paths.has(path)) failures.push(`missing:${path}`);
}
for (const path of paths) {
  if (forbiddenPrefixes.some((prefix) => path.startsWith(prefix))) {
    failures.push(`unexpected:${path}`);
  }
  if (path.endsWith(".map")) failures.push(`source-map:${path}`);
}
if (record.unpackedSize > 2_000_000) failures.push("unpacked-size");
if (record.entryCount > 120) failures.push("entry-count");

if (failures.length > 0) {
  process.stderr.write(
    `package boundary check failed with ${failures.length} issue(s): ${failures.slice(0, 10).join(", ")}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `package boundary passed: ${record.entryCount} files, ${record.unpackedSize} unpacked bytes\n`,
  );
}
