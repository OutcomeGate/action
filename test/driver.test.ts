import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runCandidateProcess } from "../src/driver/process.js";
import { createRefundEnvironment } from "../src/fixtures/refunds.js";
import type { JsonValue, ScenarioSpec } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "../..");
const initialState: JsonValue = {
  orders: {},
  tickets: {},
  refunds: [],
  notifications: [],
  escalations: [],
};
const scenario: ScenarioSpec = {
  id: "driver-failure",
  description: "candidate protocol failure",
  task: {},
  initialState,
  faults: [],
  assertions: [
    {
      id: "no-refund",
      type: "json_pointer",
      source: "state",
      pointer: "/refunds/0",
      operator: "absent",
    },
  ],
  timeoutMs: 500,
  maxToolCalls: 2,
};

test("opposite-grant literals are rejected before candidate process startup", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agentci-candidate-spawn-boundary-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const marker = join(root, "candidate-ran");
  const candidatePath = join(root, "candidate.mjs");
  await writeFile(
    candidatePath,
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\n`,
    "utf8",
  );

  await assert.rejects(
    runCandidateProcess({
      candidatePath,
      scenario,
      environment: createRefundEnvironment(initialState),
      candidateEnvironment: Object.freeze({}),
      candidateCredentialNames: [],
      knownExecutionSecrets: [
        { ruleId: "adapter-only", value: process.execPath },
      ],
      protectedSecrets: [
        { ruleId: "adapter-only", value: process.execPath },
      ],
    }),
    /candidate spawn metadata crossed a known credential boundary/,
  );
  await assert.rejects(access(marker), (error: unknown) => {
    assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
    return true;
  });
});

test("invalid candidate JSONL blocks", async () => {
  const result = await runCandidateProcess({
    candidatePath: resolve(
      projectRoot,
      "dist/examples/test-candidates/invalid-candidate.js",
    ),
    scenario,
    environment: createRefundEnvironment(initialState),
  });
  assert.equal(result.verdict, "block");
  assert.match(result.reasons.join(" "), /non-JSON/);
});

test("idle candidate timeout remains a block", async () => {
  const result = await runCandidateProcess({
    candidatePath: resolve(
      projectRoot,
      "dist/examples/test-candidates/timeout-candidate.js",
    ),
    scenario: { ...scenario, timeoutMs: 100 },
    environment: createRefundEnvironment(initialState),
  });
  assert.equal(result.verdict, "block");
  assert.match(result.reasons.join(" "), /timed out/);
});

async function writeSingleCallCandidate(
  root: string,
  tool: string,
): Promise<string> {
  const candidatePath = join(root, "single-call-candidate.mjs");
  await writeFile(
    candidatePath,
    `import { createInterface } from "node:readline";\n` +
      `createInterface({ input: process.stdin }).on("line", (line) => {\n` +
      `  const message = JSON.parse(line);\n` +
      `  if (message.type === "start") process.stdout.write(JSON.stringify({ v: 1, type: "call", id: "one", tool: ${JSON.stringify(tool)}, arguments: {} }) + "\\n");\n` +
      `  if (message.type === "result") process.stdout.write(JSON.stringify({ v: 1, type: "done", output: {} }) + "\\n");\n` +
      `});\n`,
    "utf8",
  );
  return candidatePath;
}

test("a skipped transition that mutates state is indeterminate", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agentci-skipped-transition-test-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const candidatePath = await writeSingleCallCandidate(root, "counter.read");
  const result = await runCandidateProcess({
    candidatePath,
    scenario: {
      ...scenario,
      initialState: { count: 0 },
      faults: [
        {
          tool: "counter.read",
          onCall: 1,
          phase: "before",
          error: { code: "scheduled", message: "scheduled failure" },
        },
      ],
    },
    environment: {
      tools: ["counter.read"],
      call: async () => ({ count: 1 }),
      snapshot: () => ({ count: 0 }),
      transition: async () => ({
        beforeState: { count: 0 },
        afterState: { count: 1 },
        outcome: { kind: "skipped" },
      }),
    },
  });

  assert.equal(result.verdict, "indeterminate");
  assert.match(result.reasons.join(" "), /mutated state during a skipped transition/);
});

test("an unknown-tool block retains a skipped-transition integrity concern", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agentci-skipped-unknown-tool-test-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const candidatePath = await writeSingleCallCandidate(root, "counter.unknown");
  const result = await runCandidateProcess({
    candidatePath,
    scenario: { ...scenario, initialState: { count: 0 } },
    environment: {
      tools: ["counter.read"],
      call: async () => ({ count: 1 }),
      snapshot: () => ({ count: 0 }),
      transition: async () => ({
        beforeState: { count: 0 },
        afterState: { count: 1 },
        outcome: { kind: "skipped" },
      }),
    },
  });

  assert.equal(result.verdict, "block");
  assert.match(result.reasons.join(" "), /unknown tool/);
  assert.match(result.reasons.join(" "), /integrity concern.*skipped transition/);
});

test("candidate stderr is retained only as digest, byte count, and truncation metadata", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agentci-driver-stderr-test-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const secret = "synthetic-driver-canary-never-retain";
  const candidatePath = join(root, "candidate.mjs");
  await writeFile(
    candidatePath,
    `import { createInterface } from "node:readline";\n` +
      `process.stderr.write(${JSON.stringify(secret)});\n` +
      `createInterface({ input: process.stdin }).on("line", (line) => {\n` +
      `  const message = JSON.parse(line);\n` +
      `  if (message.type === "start") process.stdout.write(JSON.stringify({ v: 1, type: "done", output: {} }) + "\\n");\n` +
      `});\n`,
    "utf8",
  );

  const result = await runCandidateProcess({
    candidatePath,
    scenario,
    environment: createRefundEnvironment(initialState),
  });

  assert.equal(result.verdict, "pass");
  assert.deepEqual(result.candidateDiagnostics, {
    stderrDigest: createHash("sha256").update(secret).digest("hex"),
    stderrBytes: Buffer.byteLength(secret),
    stderrTruncated: false,
  });
  assert.equal("candidateStderr" in result, false);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("a known adapter credential split across stderr writes blocks with a redacted digest", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agentci-driver-secret-test-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const secret = "split-credential-canary";
  const candidatePath = join(root, "candidate.mjs");
  await writeFile(
    candidatePath,
    `import { createInterface } from "node:readline";\n` +
      `createInterface({ input: process.stdin }).on("line", (line) => {\n` +
      `  const message = JSON.parse(line);\n` +
      `  if (message.type !== "start") return;\n` +
      `  process.stderr.write("split-credential-");\n` +
      `  setTimeout(() => process.stderr.write("canary"), 30);\n` +
      `  setTimeout(() => process.stdout.write(JSON.stringify({ v: 1, type: "done", output: {} }) + "\\n"), 100);\n` +
      `});\n`,
    "utf8",
  );
  const credential = Buffer.from(secret);
  let tail = Buffer.alloc(0);
  let aborted = false;

  const result = await runCandidateProcess({
    candidatePath,
    scenario,
    environment: {
      tools: [],
      async call() {
        return {};
      },
      snapshot: () => initialState,
      inspectCandidateStderr(chunk) {
        const combined = Buffer.concat([tail, Buffer.from(chunk)]);
        if (combined.indexOf(credential) !== -1) {
          throw new Error("known secret detected");
        }
        tail = combined.subarray(
          Math.max(0, combined.byteLength - (credential.byteLength - 1)),
        );
      },
      abort() {
        aborted = true;
      },
    },
  });

  assert.equal(result.verdict, "block");
  assert.equal(aborted, true);
  assert.match(result.reasons.join(" "), /credential boundary/);
  assert.equal(
    result.candidateDiagnostics.stderrDigest,
    createHash("sha256")
      .update("agentci.redacted-known-secret.v1")
      .digest("hex"),
  );
  assert.notEqual(
    result.candidateDiagnostics.stderrDigest,
    createHash("sha256").update(secret).digest("hex"),
  );
  assert.equal(result.candidateDiagnostics.stderrBytes, 0);
  assert.equal(result.candidateDiagnostics.stderrTruncated, false);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("known candidate-stderr leaks produce fixed non-derived metadata", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agentci-driver-fixed-redaction-test-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const candidatePath = join(root, "candidate.mjs");
  await writeFile(
    candidatePath,
    `process.stderr.write(process.env.MODEL_PROVIDER_KEY);\nsetInterval(() => {}, 1000);\n`,
    "utf8",
  );

  const run = async (secret: string) =>
    runCandidateProcess({
      candidatePath,
      scenario,
      environment: createRefundEnvironment(initialState),
      candidateEnvironment: Object.freeze({ MODEL_PROVIDER_KEY: secret }),
      candidateCredentialNames: ["MODEL_PROVIDER_KEY"],
    });
  const short = await run("short-candidate-secret");
  const long = await run("much-longer-candidate-secret-value-for-redaction");

  assert.equal(short.verdict, "block");
  assert.equal(long.verdict, "block");
  assert.deepEqual(short.candidateDiagnostics, long.candidateDiagnostics);
  assert.deepEqual(short.candidateDiagnostics, {
    stderrDigest: createHash("sha256")
      .update("agentci.redacted-known-secret.v1")
      .digest("hex"),
    stderrBytes: 0,
    stderrTruncated: false,
  });
});

test("a known adapter credential in candidate JSONL is blocked before evidence capture", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agentci-driver-protocol-secret-test-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const secret = "candidate-protocol-credential-canary";
  const candidatePath = join(root, "candidate.mjs");
  await writeFile(
    candidatePath,
    `import { createInterface } from "node:readline";\n` +
      `createInterface({ input: process.stdin }).on("line", (line) => {\n` +
      `  const message = JSON.parse(line);\n` +
      `  if (message.type === "start") process.stdout.write(JSON.stringify({ v: 1, type: "done", output: ${JSON.stringify(secret)} }) + "\\n");\n` +
      `});\n`,
    "utf8",
  );
  let aborted = false;

  const result = await runCandidateProcess({
    candidatePath,
    scenario,
    environment: {
      tools: [],
      async call() {
        return {};
      },
      snapshot: () => initialState,
      inspectCandidateProtocol(message) {
        if (JSON.stringify(message).includes(secret)) {
          throw new Error("known secret detected");
        }
      },
      abort() {
        aborted = true;
      },
    },
  });

  assert.equal(result.verdict, "block");
  assert.equal(aborted, true);
  assert.equal(result.output, undefined);
  assert.match(result.reasons.join(" "), /protocol.*credential boundary/);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("a declared candidate credential cannot enter candidate JSONL evidence", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agentci-candidate-protocol-secret-test-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const secret = "candidate-owned-credential-canary";
  const candidatePath = join(root, "candidate.mjs");
  await writeFile(
    candidatePath,
    `import { createInterface } from "node:readline";\n` +
      `createInterface({ input: process.stdin }).on("line", (line) => {\n` +
      `  const message = JSON.parse(line);\n` +
      `  if (message.type === "start") process.stdout.write(JSON.stringify({ v: 1, type: "done", output: process.env.MODEL_PROVIDER_KEY }) + "\\n");\n` +
      `});\n`,
    "utf8",
  );

  const result = await runCandidateProcess({
    candidatePath,
    scenario,
    environment: createRefundEnvironment(initialState),
    candidateEnvironment: Object.freeze({ MODEL_PROVIDER_KEY: secret }),
    candidateCredentialNames: ["MODEL_PROVIDER_KEY"],
  });

  assert.equal(result.verdict, "block");
  assert.match(result.reasons.join(" "), /candidate stdout crossed/);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("adapter transition states cannot derive evidence from a candidate credential", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agentci-driver-state-secret-test-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const secret = "candidate-state-credential-canary";
  const candidatePath = await writeSingleCallCandidate(root, "counter.increment");
  const result = await runCandidateProcess({
    candidatePath,
    scenario: { ...scenario, initialState: { count: 0 } },
    candidateEnvironment: Object.freeze({ MODEL_PROVIDER_KEY: secret }),
    candidateCredentialNames: ["MODEL_PROVIDER_KEY"],
    environment: {
      tools: ["counter.increment"],
      call: async () => ({ count: 1 }),
      snapshot: () => ({ count: 1 }),
      transition: async () => ({
        beforeState: { count: 0, hidden: secret },
        afterState: { count: 1, hidden: secret },
        outcome: { kind: "ok", content: { count: 1 } },
      }),
    },
  });

  const fixedDigest = createHash("sha256")
    .update("agentci.redacted-known-secret-state.v1")
    .digest("hex");
  assert.equal(result.verdict, "indeterminate");
  assert.match(result.reasons.join(" "), /state crossed.*credential boundary/);
  assert.equal(result.events[0]?.beforeStateHash, fixedDigest);
  assert.equal(result.events[0]?.afterStateHash, fixedDigest);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.notEqual(
    fixedDigest,
    createHash("sha256").update(JSON.stringify({ count: 0, hidden: secret })).digest("hex"),
  );
});

test("a JSON-escaped candidate credential cannot enter parsed protocol evidence", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agentci-candidate-escaped-secret-test-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const secret = "candidate-escaped-credential-canary";
  const candidatePath = join(root, "candidate.mjs");
  await writeFile(
    candidatePath,
    `import { createInterface } from "node:readline";\n` +
      `createInterface({ input: process.stdin }).on("line", (line) => {\n` +
      `  const message = JSON.parse(line);\n` +
      `  if (message.type === "start") {\n` +
      `    const escaped = [...process.env.MODEL_PROVIDER_KEY].map((character) => "\\\\u" + character.charCodeAt(0).toString(16).padStart(4, "0")).join("");\n` +
      `    process.stdout.write('{"v":1,"type":"done","output":"' + escaped + '"}\\n');\n` +
      `  }\n` +
      `});\n`,
    "utf8",
  );

  const result = await runCandidateProcess({
    candidatePath,
    scenario,
    environment: createRefundEnvironment(initialState),
    candidateEnvironment: Object.freeze({ MODEL_PROVIDER_KEY: secret }),
    candidateCredentialNames: ["MODEL_PROVIDER_KEY"],
  });

  assert.equal(result.verdict, "block");
  assert.equal(result.output, undefined);
  assert.match(result.reasons.join(" "), /protocol crossed its credential boundary/);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("duplicate candidate JSON members cannot discard an escaped credential", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agentci-candidate-duplicate-json-test-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const secret = 'opaque"candidate\\value';
  const candidatePath = join(root, "candidate.mjs");
  await writeFile(
    candidatePath,
    `import { createInterface } from "node:readline";\n` +
      `createInterface({ input: process.stdin }).on("line", (line) => {\n` +
      `  const message = JSON.parse(line);\n` +
      `  if (message.type === "start") {\n` +
      `    const encoded = JSON.stringify(process.env.MODEL_PROVIDER_KEY);\n` +
      `    process.stdout.write('{"v":1,"type":"done","output":' + encoded + ',"output":{}}\\n');\n` +
      `  }\n` +
      `});\n`,
    "utf8",
  );

  const result = await runCandidateProcess({
    candidatePath,
    scenario,
    environment: createRefundEnvironment(initialState),
    candidateEnvironment: Object.freeze({ MODEL_PROVIDER_KEY: secret }),
    candidateCredentialNames: ["MODEL_PROVIDER_KEY"],
  });

  assert.equal(result.verdict, "block");
  assert.equal(result.output, undefined);
  assert.match(result.reasons.join(" "), /ambiguous JSON/);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("a scenario deadline during an active hosted transition is indeterminate", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agentci-driver-transition-test-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const candidatePath = join(root, "candidate.mjs");
  await writeFile(
    candidatePath,
    `import { createInterface } from "node:readline";\n` +
      `createInterface({ input: process.stdin }).on("line", (line) => {\n` +
      `  const message = JSON.parse(line);\n` +
      `  if (message.type === "start") process.stdout.write(JSON.stringify({ v: 1, type: "call", id: "one", tool: "noop", arguments: {} }) + "\\n");\n` +
      `  if (message.type === "result") process.stdout.write(JSON.stringify({ v: 1, type: "done", output: {} }) + "\\n");\n` +
      `});\n`,
    "utf8",
  );
  let aborted = false;

  const result = await runCandidateProcess({
    candidatePath,
    scenario: { ...scenario, timeoutMs: 100 },
    environment: {
      tools: ["noop"],
      async call() {
        return {};
      },
      snapshot: () => ({}),
      transition: () => new Promise(() => undefined),
      abort() {
        aborted = true;
      },
    },
  });

  assert.equal(result.verdict, "indeterminate");
  assert.equal(aborted, true);
  assert.doesNotMatch(result.reasons.join(" "), /candidate timed out/);
});

test("trusted external adapters can return structural expected tool errors", async () => {
  const result = await runCandidateProcess({
    candidatePath: resolve(
      projectRoot,
      "dist/examples/test-candidates/tool-error-candidate.js",
    ),
    scenario,
    environment: {
      tools: ["noop"],
      async call() {
        throw {
          agentciToolError: true,
          code: "sandbox_not_found",
          message: "the sandbox record was not found",
        };
      },
      snapshot: () => ({}),
    },
  });

  assert.equal(result.verdict, "pass");
  assert.deepEqual(result.output, { observedCode: "sandbox_not_found" });
  assert.equal(result.events[0]?.outcome, "error");
});
