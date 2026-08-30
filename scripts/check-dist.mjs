#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = resolve(projectRoot, "dist/src");
const allowedRuntimePath = /^dist\/src\/(?:[^/]+\/)*(?:[^/]+\.js|[^/]+\.d\.ts)$/u;

function git(args) {
  const result = spawnSync("git", args, {
    cwd: projectRoot,
    encoding: null,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.signal || result.status !== 0) {
    throw new Error("Git runtime inspection failed");
  }
  return result.stdout;
}

async function collectFiles(directory) {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error("runtime contains a symbolic link");
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(absolute)));
    } else if (entry.isFile()) {
      const path = relative(projectRoot, absolute).split(sep).join("/");
      if (!allowedRuntimePath.test(path)) {
        throw new Error("runtime contains an unsupported file type");
      }
      files.push(path);
    } else {
      throw new Error("runtime contains an unsupported filesystem entry");
    }
  }
  return files;
}

try {
  const actual = new Set(await collectFiles(distRoot));
  const trackedBuffer = git(["ls-files", "-z", "--", "dist/src"]);
  if (trackedBuffer.length > 0 && trackedBuffer.at(-1) !== 0) {
    throw new Error("tracked runtime listing was not NUL terminated");
  }
  const tracked = new Set(
    trackedBuffer
      .toString("utf8")
      .split("\0")
      .filter(Boolean),
  );
  const missing = [...tracked].filter((path) => !actual.has(path));
  const untracked = [...actual].filter((path) => !tracked.has(path));
  if (actual.size === 0 || missing.length > 0 || untracked.length > 0) {
    throw new Error("generated and tracked runtime manifests differ");
  }

  const diff = spawnSync("git", ["diff", "--quiet", "--", "dist/src"], {
    cwd: projectRoot,
    stdio: "ignore",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
  });
  if (diff.error || diff.signal || diff.status !== 0) {
    throw new Error("generated runtime content differs from the index");
  }
  process.stdout.write(
    `committed runtime boundary passed (${actual.size} generated files)\n`,
  );
} catch {
  process.stderr.write(
    "committed runtime boundary failed; rebuild and stage the complete dist/src tree\n",
  );
  process.exitCode = 1;
}
