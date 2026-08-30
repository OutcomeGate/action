#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const blockers = [];
const APACHE_2_CANONICAL_SHA256 =
  "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30";
const MIT_TEMPLATE_SHA256 =
  "c963879647034d6c5d7027d8e2b024213589b749d11ba7320032802307bced9c";

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizedLineEndings(value) {
  return value.replace(/\r\n?/gu, "\n");
}

const supportedLicenses = new Map([
  [
    "Apache-2.0",
    (text) => sha256(normalizedLineEndings(text)) === APACHE_2_CANONICAL_SHA256,
  ],
  [
    "MIT",
    (text) => {
      const normalized = normalizedLineEndings(text);
      const copyright = normalized.match(
        /^[ \t]*Copyright \(c\) ([^\n]+)$/mu,
      );
      if (
        copyright === null ||
        copyright[1].includes("<year>") ||
        copyright[1].includes("<copyright holders>")
      ) {
        return false;
      }
      const templated = normalized.replace(
        copyright[0],
        "Copyright (c) <year> <copyright holders>",
      );
      const whitespaceNormalized = templated.trim().replace(/\s+/gu, " ");
      return sha256(whitespaceNormalized) === MIT_TEMPLATE_SHA256;
    },
  ],
]);

let licenseText;

try {
  const license = await stat(resolve(projectRoot, "LICENSE"));
  if (!license.isFile() || license.size < 500 || license.size > 20_000) {
    blockers.push("license-file");
  } else {
    licenseText = await readFile(resolve(projectRoot, "LICENSE"), "utf8");
  }
} catch (error) {
  if (error?.code === "ENOENT") blockers.push("license-file");
  else throw error;
}

const packageJson = JSON.parse(
  await readFile(resolve(projectRoot, "package.json"), "utf8"),
);
if (
  typeof packageJson.name !== "string" ||
  packageJson.name.length === 0 ||
  typeof packageJson.version !== "string" ||
  packageJson.version.length === 0
) {
  blockers.push("package-metadata");
}
if (
  typeof packageJson.license !== "string" ||
  !supportedLicenses.has(packageJson.license)
) {
  blockers.push("package-license");
} else if (
  licenseText !== undefined &&
  !supportedLicenses.get(packageJson.license)(licenseText)
) {
  blockers.push("license-content");
}
if (packageJson.private !== true) {
  blockers.push("npm-private");
}

try {
  const packageLock = JSON.parse(
    await readFile(resolve(projectRoot, "package-lock.json"), "utf8"),
  );
  const lockRoot = packageLock?.packages?.[""];
  if (
    lockRoot?.name !== packageJson.name ||
    lockRoot?.version !== packageJson.version ||
    lockRoot?.license !== packageJson.license
  ) {
    blockers.push("package-lock-metadata");
  }
} catch {
  blockers.push("package-lock-metadata");
}

try {
  const changelog = await readFile(
    resolve(projectRoot, "CHANGELOG.md"),
    "utf8",
  );
  const escapedVersion = packageJson.version.replace(
    /[.*+?^${}()|[\]\\]/gu,
    "\\$&",
  );
  if (!new RegExp(`^## ${escapedVersion}(?:\\s|$)`, "mu").test(changelog)) {
    blockers.push("changelog-version");
  }
} catch {
  blockers.push("changelog-version");
}

const status = spawnSync(
  "git",
  ["status", "--porcelain=v1", "--untracked-files=all"],
  {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
if (status.error || status.signal || status.status !== 0) {
  throw new Error("could not inspect release checkout status");
}
if (status.stdout.length > 0) {
  blockers.push("repository-clean");
}

if (blockers.length > 0) {
  process.stderr.write(
    `release blocked: ${blockers.length} readiness check(s) failed (${blockers.join(", ")})\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write("release readiness passed; candidate may proceed to final release review\n");
}
