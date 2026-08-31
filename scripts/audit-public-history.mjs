#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { TextDecoder } from "node:util";

const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_REACHABLE_COMMITS = 20_000;
const MAX_PATH_OBSERVATIONS = 2_000_000;
const utf8 = new TextDecoder("utf-8", { fatal: true });

const ROOT_FILES = new Set([
  ".gitattributes",
  ".gitignore",
  ".npmignore",
  ".nvmrc",
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "LICENSE.md",
  "NOTICE",
  "README.md",
  "SECURITY.md",
  "SUPPORT.md",
  "action.yml",
  "package-lock.json",
  "package.json",
  "tsconfig.json",
]);

const DIRECTORY_SUFFIXES = new Map([
  ["examples", [".json", ".md", ".mjs", ".ts", ".yml"]],
  ["schemas", [".json", ".md"]],
  ["src", [".ts"]],
  ["test", [".mjs", ".ts"]],
]);

const GITHUB_FILES = new Set([
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/ISSUE_TEMPLATE/feature_request.yml",
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/workflows/ci.yml",
]);

const DOCUMENTATION_FILES = new Set([
  "docs/ADAPTER-SDK.md",
  "docs/CANDIDATE-PROTOCOL.md",
  "docs/QUICKSTART.md",
  "docs/RELEASING.md",
  "docs/SECURITY-MODEL.md",
  "docs/SUITES.md",
  "docs/TROUBLESHOOTING.md",
  "docs/MODEL-COMPRESSION.md",
]);

const SCRIPT_FILES = new Set([
  "scripts/audit-public-content.mjs",
  "scripts/audit-public-history.mjs",
  "scripts/build.mjs",
  "scripts/check-dist.mjs",
  "scripts/check-doc-links.mjs",
  "scripts/check-package.mjs",
  "scripts/check-release-readiness.mjs",
  "scripts/demo.ts",
  "scripts/model-compression-demo.ts",
  "scripts/smoke-package.mjs",
]);

const TEMPLATE_FILES = new Set([
  "templates/starter/.github/workflows/outcomegate.yml",
  "templates/starter/README.md",
  "templates/starter/agentci/adapter.bundle/adapter.mjs",
  "templates/starter/agentci/adapter.manifest.json",
  "templates/starter/agentci/release.bundle/candidate.mjs",
  "templates/starter/agentci/release.bundle/prompt.md",
  "templates/starter/agentci/release.bundle/tool-schema.json",
  "templates/starter/agentci/release.manifest.json",
  "templates/starter/agentci/suite.json",
  "templates/starter/gitignore",
]);

// A repository rename should not require rewriting otherwise accepted history.
// These paths are valid only in reachable commits, never in the current tree.
const LEGACY_HISTORICAL_FILES = new Set([
  "templates/starter/.github/workflows/agent-ci.yml",
]);

const INTERNAL_TOKENS = new Set([
  "acquisition",
  "acquisitions",
  "backlog",
  "board",
  "businessplan",
  "claude",
  "codex",
  "confidential",
  "crm",
  "customer",
  "discovery",
  "fundraising",
  "internal",
  "interview",
  "interviews",
  "investor",
  "investors",
  "lead",
  "leads",
  "memo",
  "memos",
  "pilot",
  "pilots",
  "pricing",
  "private",
  "prospect",
  "prospects",
  "research",
  "roadmap",
  "sales",
  "sources",
  "strategy",
  "valuation",
]);

const INTERNAL_COMPACT_COMPONENTS = new Set([
  "agentinstructions",
  "businessplan",
  "competitiveanalysis",
  "customerdata",
  "customerdiscovery",
  "customerfixtures",
  "customerinterviews",
  "designpartner",
  "executiveworkspace",
  "financialmodel",
  "internalonly",
  "marketanalysis",
  "marketresearch",
  "meetingnotes",
  "statementofwork",
]);

const INTERNAL_MESSAGE_PATTERNS = [
  /\bbusiness[\s_-]*plan\b/u,
  /\bcompetitive[\s_-]*analysis\b/u,
  /\bcustomer[\s_-]*(?:data|discovery|fixture|interview|name)\b/u,
  /\bdesign[\s_-]*partner\b/u,
  /\bfinancial[\s_-]*model\b/u,
  /\bfundrais(?:e|ing)\b/u,
  /\binternal[\s_-]*only\b/u,
  /\bmarket[\s_-]*(?:analysis|research)\b/u,
  /\bmeeting[\s_-]*notes\b/u,
  /\bnamed[\s_-]*partner\b/u,
  /\bpricing[\s_-]*model\b/u,
  /\bstatement[\s_-]*of[\s_-]*work\b/u,
  /\bacquisitions?\b/u,
  /\bconfidential\b/u,
  /\binvestors?\b/u,
  /\bpilots?\b/u,
  /\bresearch[\s_-]*notes\b/u,
  /\bsow\b/u,
  /\bvaluation\b/u,
];

const NOREPLY_EMAIL = /^(?:[^@\s]+@users\.noreply\.github\.com|noreply@github\.com)$/iu;

class AuditError extends Error {
  constructor(stage) {
    super(stage);
    this.stage = stage;
  }
}

function runGit(args, cwd, stage, maxBuffer = MAX_GIT_OUTPUT_BYTES) {
  const result = spawnSync(
    "git",
    ["-c", "core.quotePath=false", "-c", "diff.renames=false", ...args],
    {
      cwd,
      encoding: null,
      env: {
        ...process.env,
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_OPTIONAL_LOCKS: "0",
        LC_ALL: "C",
      },
      maxBuffer,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  if (result.error || result.signal || result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    throw new AuditError(stage);
  }
  return result.stdout;
}

function decode(buffer, stage) {
  try {
    return utf8.decode(buffer);
  } catch {
    throw new AuditError(stage);
  }
}

function decodeSingleLine(buffer, stage) {
  const value = decode(buffer, stage).replace(/\r?\n$/u, "");
  if (value.length === 0 || /[\r\n\0]/u.test(value)) {
    throw new AuditError(stage);
  }
  return value;
}

function decodeNulList(buffer, stage) {
  if (buffer.length === 0) return [];
  if (buffer.at(-1) !== 0) throw new AuditError(stage);

  const values = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue;
    if (index > start) values.push(decode(buffer.subarray(start, index), stage));
    start = index + 1;
  }
  return values;
}

function decodeTreeEntries(buffer, stage) {
  return decodeNulList(buffer, stage).map((record) => {
    const match = record.match(
      /^([0-9]{6}) (blob|commit|tree) ([0-9a-f]{40}|[0-9a-f]{64})\t([\s\S]+)$/u,
    );
    if (!match) throw new AuditError(stage);
    return {
      mode: match[1],
      type: match[2],
      path: match[4],
    };
  });
}

function canonicalComponent(component) {
  const extensionIndex = component.lastIndexOf(".");
  const withoutExtension = extensionIndex > 0 ? component.slice(0, extensionIndex) : component;
  return withoutExtension
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function hasInternalPathName(path) {
  for (const component of path.split("/")) {
    if (/^(?:AGENTS|CLAUDE|CODEX)\.md$/iu.test(component)) return true;
    const canonical = canonicalComponent(component);
    const tokens = canonical.split("-").filter(Boolean);
    const compact = tokens.join("");
    if (tokens.some((token) => INTERNAL_TOKENS.has(token))) return true;
    if (INTERNAL_COMPACT_COMPONENTS.has(compact)) return true;
  }
  return false;
}

function isStructurallyAllowed(path, allowLegacyHistorical = false) {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(path)
  ) {
    return false;
  }

  const components = path.split("/");
  if (components.some((component) => component.length === 0 || component === "." || component === "..")) {
    return false;
  }

  if (components.length === 1) return ROOT_FILES.has(path);
  if (GITHUB_FILES.has(path) || DOCUMENTATION_FILES.has(path) || SCRIPT_FILES.has(path)) return true;
  if (
    TEMPLATE_FILES.has(path) ||
    (allowLegacyHistorical && LEGACY_HISTORICAL_FILES.has(path))
  ) {
    return true;
  }
  if (components[0] === "dist") {
    return (
      components.length >= 3 &&
      components[1] === "src" &&
      (path.endsWith(".js") || path.endsWith(".d.ts"))
    );
  }
  const allowedSuffixes = DIRECTORY_SUFFIXES.get(components[0]);
  return (
    allowedSuffixes !== undefined &&
    allowedSuffixes.some((suffix) => path.endsWith(suffix))
  );
}

function pathViolatesPolicy(path, allowLegacyHistorical = false) {
  return (
    !isStructurallyAllowed(path, allowLegacyHistorical) ||
    hasInternalPathName(path)
  );
}

function messageHasInternalMarker(message) {
  const normalized = message.normalize("NFKC").toLocaleLowerCase("en-US");
  return INTERNAL_MESSAGE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function parseCommitList(buffer) {
  const text = decode(buffer, "commit-list");
  const commits = text.split("\n").filter(Boolean);
  if (
    commits.length === 0 ||
    commits.length > MAX_REACHABLE_COMMITS ||
    commits.some((commit) => !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(commit))
  ) {
    throw new AuditError("commit-list");
  }
  return [...new Set(commits)];
}

function readCommitMetadata(commit, repositoryRoot) {
  const object = runGit(["cat-file", "commit", commit], repositoryRoot, "commit-object", 2 * 1024 * 1024);
  const separator = object.indexOf(Buffer.from("\n\n"));
  if (separator < 0) throw new AuditError("commit-object");

  const headers = decode(object.subarray(0, separator), "commit-headers").split("\n");
  const message = decode(object.subarray(separator + 2), "commit-message");
  const authorHeaders = headers.filter((line) => line.startsWith("author "));
  const committerHeaders = headers.filter((line) => line.startsWith("committer "));
  if (authorHeaders.length !== 1 || committerHeaders.length !== 1) {
    throw new AuditError("commit-identities");
  }

  const extractEmail = (line) => {
    const match = line.match(/ <([^<>\s]+)> [0-9]+ [+-][0-9]{4}$/u);
    if (!match) throw new AuditError("commit-identities");
    return match[1];
  };

  return {
    authorEmail: extractEmail(authorHeaders[0]),
    committerEmail: extractEmail(committerHeaders[0]),
    message,
  };
}

function printPolicyFailure(violations) {
  console.error("Public history audit failed.");
  if (violations.currentPaths) console.error("- Current checkout path policy violation(s) detected.");
  if (violations.historicalPaths) console.error("- Reachable history path policy violation(s) detected.");
  if (violations.identities) console.error("- Non-noreply or malformed commit identity metadata detected.");
  if (violations.messages) console.error("- Internal-only commit-message marker(s) detected.");
  if (violations.references) console.error("- Internal-only Git reference name(s) detected.");
  console.error("Matched values are intentionally suppressed; review locally before publishing.");
}

function main() {
  const initialDirectory = process.cwd();
  const repositoryRoot = decodeSingleLine(
    runGit(["rev-parse", "--show-toplevel"], initialDirectory, "repository-discovery"),
    "repository-discovery",
  );

  const insideWorkTree = decodeSingleLine(
    runGit(["rev-parse", "--is-inside-work-tree"], repositoryRoot, "work-tree-check"),
    "work-tree-check",
  );
  if (insideWorkTree !== "true") throw new AuditError("work-tree-check");

  const shallow = decodeSingleLine(
    runGit(["rev-parse", "--is-shallow-repository"], repositoryRoot, "shallow-check"),
    "shallow-check",
  );
  if (shallow !== "false") throw new AuditError("incomplete-history");

  runGit(["rev-parse", "--verify", "HEAD"], repositoryRoot, "head-check");

  const violations = {
    currentPaths: false,
    historicalPaths: false,
    identities: false,
    messages: false,
    references: false,
  };

  const currentPaths = decodeNulList(
    runGit(
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--"],
      repositoryRoot,
      "current-paths",
    ),
    "current-paths",
  );
  violations.currentPaths = currentPaths.some((path) =>
    pathViolatesPolicy(path),
  );

  const commits = parseCommitList(
    runGit(["rev-list", "--all", "HEAD"], repositoryRoot, "commit-list"),
  );

  let pathObservations = 0;
  for (const commit of commits) {
    const historicalEntries = decodeTreeEntries(
      runGit(
        ["ls-tree", "-r", "--full-tree", "-z", commit],
        repositoryRoot,
        "historical-paths",
      ),
      "historical-paths",
    );
    pathObservations += historicalEntries.length;
    if (pathObservations > MAX_PATH_OBSERVATIONS) throw new AuditError("history-size-limit");
    if (
      historicalEntries.some(
        (entry) =>
          entry.type !== "blob" ||
          (entry.mode !== "100644" && entry.mode !== "100755") ||
          pathViolatesPolicy(entry.path, true),
      )
    ) {
      violations.historicalPaths = true;
    }

    const metadata = readCommitMetadata(commit, repositoryRoot);
    if (!NOREPLY_EMAIL.test(metadata.authorEmail) || !NOREPLY_EMAIL.test(metadata.committerEmail)) {
      violations.identities = true;
    }
    if (messageHasInternalMarker(metadata.message)) violations.messages = true;
  }

  const references = decode(
    runGit(["for-each-ref", "--format=%(refname)"], repositoryRoot, "references"),
    "references",
  )
    .split("\n")
    .filter(Boolean);
  violations.references = references.some(hasInternalPathName);

  if (Object.values(violations).some(Boolean)) {
    printPolicyFailure(violations);
    process.exitCode = 1;
    return;
  }

  console.log(
    `Public history audit passed (${commits.length} reachable commits, ${currentPaths.length} current paths, ${pathObservations} historical path observations).`,
  );
}

try {
  main();
} catch (error) {
  const stage = error instanceof AuditError ? error.stage : "unexpected-error";
  console.error(`Public history audit could not complete safely (stage: ${stage}).`);
  console.error("No values were printed. Resolve the audit condition before publishing.");
  process.exitCode = 2;
}
