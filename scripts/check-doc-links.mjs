#!/usr/bin/env node

import { readdir, readFile, realpath, stat } from "node:fs/promises";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const roots = [
  "README.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "SUPPORT.md",
  "docs",
];

async function markdownFiles(path) {
  const absolute = resolve(projectRoot, path);
  let details;
  try {
    details = await stat(absolute);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  if (details.isFile()) return extname(absolute) === ".md" ? [absolute] : [];
  if (!details.isDirectory()) return [];
  const entries = await readdir(absolute, { withFileTypes: true });
  const nested = await Promise.all(
    entries
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => markdownFiles(join(path, entry.name))),
  );
  return nested.flat();
}

function localTarget(rawLink, source) {
  const link = rawLink.trim().replace(/^<|>$/g, "");
  if (
    link.length === 0 ||
    link.startsWith("#") ||
    /^[a-z][a-z0-9+.-]*:/i.test(link)
  ) {
    return undefined;
  }
  const withoutFragment = link.split("#", 1)[0];
  if (withoutFragment.length === 0) return undefined;
  const decoded = decodeURIComponent(withoutFragment);
  if (isAbsolute(decoded) || decoded.includes("\\")) {
    throw new Error("documentation link must be repository-relative");
  }
  return resolve(dirname(source), decoded);
}

function isWithinProject(target) {
  const fromProject = relative(projectRoot, target);
  return (
    fromProject === "" ||
    (!isAbsolute(fromProject) &&
      fromProject !== ".." &&
      !fromProject.startsWith(`..${sep}`))
  );
}

const files = (await Promise.all(roots.map(markdownFiles))).flat();
const failures = [];
for (const file of files) {
  const text = await readFile(file, "utf8");
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    try {
      const target = localTarget(match[1], file);
      if (target === undefined) continue;
      await stat(target);
      const canonicalTarget = await realpath(target);
      if (!isWithinProject(canonicalTarget)) {
        failures.push(file.slice(projectRoot.length + 1));
      }
    } catch (error) {
      failures.push(file.slice(projectRoot.length + 1));
    }
  }
}

if (failures.length > 0) {
  const affected = [...new Set(failures)].sort();
  process.stderr.write(
    `documentation link check failed in ${affected.length} file(s): ${affected.join(", ")}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(`documentation links passed for ${files.length} file(s)\n`);
}
