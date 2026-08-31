#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";

import { scanBytesForSecrets } from "../dist/src/secret-scan.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_OUTPUT = 32 * 1024 * 1024;
const MAX_OBJECTS = 20_000;
const MAX_PATH_OBSERVATIONS = 2_000_000;
const utf8 = new TextDecoder("utf-8", { fatal: true });
const emailPattern = /[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/giu;

const suspiciousAssignmentLines = new Map([
  ["dist/src/adapter-host/main.js", new Set([24, 556])],
  ["dist/src/adapter-host/protocol.d.ts", new Set([18])],
  ["dist/src/adapter-manifest.js", new Set([278, 371])],
  ["dist/src/adapter.d.ts", new Set([16])],
  ["dist/src/adapter.js", new Set([239, 550])],
  ["dist/src/assertions.js", new Set([19])],
  ["dist/src/release.js", new Set([141, 170])],
  ["dist/src/report.js", new Set([610, 629])],
  ["dist/src/secret-scan.js", new Set([399])],
  ["dist/src/strict-json.js", new Set([132])],
  ["dist/src/types.d.ts", new Set([150, 158])],
  ["docs/ADAPTER-SDK.md", new Set([97])],
  ["docs/SECURITY-MODEL.md", new Set([18])],
  ["src/adapter-host/main.ts", new Set([68, 713])],
  ["src/adapter-host/protocol.ts", new Set([22])],
  ["src/adapter-manifest.ts", new Set([389, 421, 534])],
  ["src/adapter.ts", new Set([308, 336, 356, 678, 737])],
  ["src/assertions.ts", new Set([32])],
  ["src/release.ts", new Set([215, 251])],
  ["src/report.ts", new Set([758, 782])],
  ["src/secret-scan.ts", new Set([653])],
  ["src/strict-json.ts", new Set([161])],
  ["src/types.ts", new Set([170, 181])],
  ["test/adapter-host.test.ts", new Set([20])],
  ["test/candidate-credential-policy.test.ts", new Set([441])],
  ["test/credential-policy.test.ts", new Set([196, 200, 211, 216, 217, 222, 226, 230, 242])],
  ["test/driver.test.ts", new Set([179, 211, 225, 307, 350, 378, 414, 446])],
  ["test/runner.test.ts", new Set([264, 533, 858, 977, 1193])],
  ["test/secret-scan.test.ts", new Set([54, 202, 215, 241, 260, 261, 262, 263, 264, 277])],
]);

const sensitiveProsePatterns = Object.freeze([
  ["acquisition", /\bacquisitions?\b/iu],
  ["business-plan", /\bbusiness[\s_-]*plans?\b/iu],
  ["competitive-analysis", /\bcompetitive[\s_-]*analysis\b/iu],
  ["confidential", /\bconfidential\b/iu],
  ["design-partner", /\bdesign[\s_-]*partners?\b/iu],
  ["executive-summary", /\bexecutive[\s_-]*summary\b/iu],
  ["financial-model", /\bfinancial[\s_-]*models?\b/iu],
  ["fundraising", /\bfundrais(?:e|ing)\b/iu],
  ["investor", /\binvestors?\b/iu],
  ["market-analysis", /\bmarket[\s_-]*analysis\b/iu],
  ["market-research", /\bmarket[\s_-]*research\b/iu],
  ["pricing-plan", /\bpricing[\s_-]*(?:model|strategy)\b/iu],
  ["research-notes", /\bresearch[\s_-]*notes\b/iu],
  ["revenue-forecast", /\brevenue[\s_-]*forecasts?\b/iu],
  ["sales-material", /\bsales[\s_-]*material\b/iu],
  ["sales-pipeline", /\bsales[\s_-]*pipeline\b/iu],
  ["statement-of-work", /\bstatement[\s_-]*of[\s_-]*work\b/iu],
  ["term-sheet", /\bterm[\s_-]*sheet\b/iu],
  ["valuation", /\bvaluation\b/iu],
]);

const proseAllowlist = new Map([
  [
    "CONTRIBUTING.md",
    new Set(["business-plan", "research-notes", "sales-material"]),
  ],
  [
    "scripts/audit-public-content.mjs",
    new Set(sensitiveProsePatterns.map(([id]) => id)),
  ],
  [
    "scripts/audit-public-history.mjs",
    new Set(sensitiveProsePatterns.map(([id]) => id)),
  ],
]);

function git(args, encoding = null) {
  const result = spawnSync("git", args, {
    cwd: projectRoot,
    encoding,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1", LC_ALL: "C" },
    maxBuffer: MAX_OUTPUT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0 || result.error || result.signal) {
    throw new Error("git inspection failed");
  }
  return result.stdout;
}

function nulPaths(buffer) {
  if (buffer.length > 0 && buffer.at(-1) !== 0) {
    throw new Error("path listing was not NUL terminated");
  }
  return buffer
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

function treeEntries(buffer) {
  return nulPaths(buffer).map((record) => {
    const match = record.match(
      /^([0-9]{6}) (blob|commit|tree) ([0-9a-f]{40}|[0-9a-f]{64})\t([\s\S]+)$/u,
    );
    if (!match) throw new Error("invalid tree entry");
    return {
      mode: match[1],
      type: match[2],
      objectId: match[3],
      path: match[4],
    };
  });
}

function indexEntries(buffer) {
  return nulPaths(buffer).map((record) => {
    const match = record.match(
      /^([0-9]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-3])\t([\s\S]+)$/u,
    );
    if (!match) throw new Error("invalid index entry");
    return {
      mode: match[1],
      objectId: match[2],
      stage: match[3],
      path: match[4],
    };
  });
}

function emailIsAllowed(email) {
  const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
  return (
    domain === "users.noreply.github.com" ||
    domain === "example.com" ||
    domain.endsWith(".example") ||
    domain.endsWith(".invalid") ||
    domain.endsWith(".test")
  );
}

function findingIsExplicitlySynthetic(finding, sourcePath) {
  if (finding.ruleId === "suspicious-credential-assignment") {
    return (
      finding.line !== undefined &&
      suspiciousAssignmentLines.get(sourcePath)?.has(finding.line) === true
    );
  }
  return (
    sourcePath === "test/secret-scan.test.ts" &&
    ((finding.ruleId === "private-key" && finding.line === 36) ||
      (finding.ruleId === "credentialed-url" && finding.line === 53))
  );
}

function containsUnapprovedSensitiveProse(text, sourcePaths) {
  return sensitiveProsePatterns.some(([id, pattern]) => {
    if (!pattern.test(text)) return false;
    return sourcePaths.some((sourcePath) => !proseAllowlist.get(sourcePath)?.has(id));
  });
}

function inspectBytes(bytes, logicalPath, sourcePaths) {
  const scan = scanBytesForSecrets({ path: logicalPath, bytes });
  if (
    scan.findingsTruncated ||
    sourcePaths.some((sourcePath) =>
      scan.findings.some(
        (finding) => !findingIsExplicitlySynthetic(finding, sourcePath),
      ),
    )
  ) {
    return false;
  }
  let text;
  try {
    text = utf8.decode(bytes);
  } catch {
    return false;
  }
  return (
    [...text.matchAll(emailPattern)].every((match) =>
      emailIsAllowed(match[0]),
    ) && !containsUnapprovedSensitiveProse(text, sourcePaths)
  );
}

let currentCount = 0;
let indexCount = 0;
let historicalBlobCount = 0;
let violationCount = 0;
let auditStage = "initialization";

try {
  auditStage = "index-list";
  const stagedEntries = indexEntries(
    git(["ls-files", "--stage", "-z", "--"]),
  );
  auditStage = "index-content";
  for (const entry of stagedEntries) {
    if (
      entry.stage !== "0" ||
      (entry.mode !== "100644" && entry.mode !== "100755")
    ) {
      violationCount += 1;
      continue;
    }
    const bytes = git(["cat-file", "blob", entry.objectId]);
    if (!inspectBytes(bytes, `index/file-${indexCount + 1}`, [entry.path])) {
      violationCount += 1;
    }
    indexCount += 1;
  }

  auditStage = "current-path-list";
  const currentPaths = nulPaths(
    git(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--"]),
  );
  auditStage = "current-content";
  for (const [index, path] of currentPaths.entries()) {
    const absolute = resolve(projectRoot, path);
    let details;
    try {
      details = await lstat(absolute);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (!details.isFile()) {
      violationCount += 1;
      continue;
    }
    const bytes = await readFile(absolute);
    if (!inspectBytes(bytes, `current/file-${index + 1}`, [path])) {
      violationCount += 1;
    }
    currentCount += 1;
  }

  auditStage = "history-object-list";
  const commits = git(["rev-list", "--all", "HEAD"], "utf8")
    .split("\n")
    .filter(Boolean);
  if (
    commits.length === 0 ||
    commits.length > MAX_OBJECTS ||
    commits.some((commit) => !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(commit))
  ) {
    throw new Error("history commit limit exceeded");
  }
  const objectPaths = new Map();
  let pathObservations = 0;
  for (const commit of commits) {
    const entries = treeEntries(
      git(["ls-tree", "-r", "--full-tree", "-z", commit]),
    );
    pathObservations += entries.length;
    if (pathObservations > MAX_PATH_OBSERVATIONS) {
      throw new Error("history path limit exceeded");
    }
    for (const entry of entries) {
      if (
        entry.type !== "blob" ||
        (entry.mode !== "100644" && entry.mode !== "100755")
      ) {
        violationCount += 1;
        continue;
      }
      const paths = objectPaths.get(entry.objectId) ?? new Set();
      paths.add(entry.path);
      objectPaths.set(entry.objectId, paths);
    }
  }
  auditStage = "history-metadata";
  for (const [index, commit] of commits.entries()) {
    const bytes = git(["cat-file", "commit", commit]);
    if (!inspectBytes(bytes, `history/commit-${index + 1}`, ["git/commit-object"])) {
      violationCount += 1;
    }
  }
  const tagObjectIds = git(
    ["for-each-ref", "--format=%(objectname)", "refs/tags"],
    "utf8",
  )
    .split("\n")
    .filter(Boolean);
  const pendingTagObjects = [...tagObjectIds];
  const seenTagObjects = new Set();
  let tagIndex = 0;
  while (pendingTagObjects.length > 0) {
    const objectId = pendingTagObjects.pop();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(objectId)) {
      throw new Error("invalid tag object identifier");
    }
    if (seenTagObjects.has(objectId)) continue;
    seenTagObjects.add(objectId);
    if (seenTagObjects.size > MAX_OBJECTS) {
      throw new Error("tag object limit exceeded");
    }
    const type = git(["cat-file", "-t", objectId], "utf8").trim();
    if (type === "commit") continue;
    if (type !== "tag" && type !== "blob") {
      violationCount += 1;
      continue;
    }
    const bytes = git(["cat-file", type, objectId]);
    tagIndex += 1;
    if (!inspectBytes(bytes, `history/tag-${tagIndex}`, ["git/tag-object"])) {
      violationCount += 1;
    }
    if (type === "tag") {
      const target = bytes.toString("utf8").match(
        /^object ([0-9a-f]{40}|[0-9a-f]{64})\n/u,
      )?.[1];
      if (target === undefined) throw new Error("invalid annotated tag object");
      pendingTagObjects.push(target);
    }
  }
  auditStage = "history-content";
  for (const [objectId, paths] of objectPaths) {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(objectId)) {
      throw new Error("invalid history object identifier");
    }
    const type = git(["cat-file", "-t", objectId], "utf8").trim();
    if (type !== "blob") continue;
    const bytes = git(["cat-file", "blob", objectId]);
    historicalBlobCount += 1;
    if (
      paths.size === 0 ||
      !inspectBytes(
        bytes,
        `history/blob-${historicalBlobCount}`,
        [...paths],
      )
    ) {
      violationCount += 1;
    }
  }

  if (violationCount > 0) {
    process.stderr.write(
      `public content audit failed with ${violationCount} suppressed finding set(s); inspect locally before publishing\n`,
    );
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `public content audit passed (${indexCount} index files, ${currentCount} working files, ${historicalBlobCount} unique historical blobs)\n`,
    );
  }
} catch {
  process.stderr.write(
    `public content audit could not complete safely (stage: ${auditStage}); no matched values were printed\n`,
  );
  process.exitCode = 2;
}
