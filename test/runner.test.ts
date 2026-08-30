import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compareReports } from "../src/comparison.js";
import { digestValue } from "../src/canonical.js";
import { loadAdapterManifest } from "../src/adapter-manifest.js";
import { loadReleaseManifest } from "../src/release.js";
import {
  computeEvidenceDigest,
  isReleaseReport,
  renderConsoleSummary,
  renderSanitizedConsoleSummary,
  verifyEvidenceDigest,
} from "../src/report.js";
import {
  runSuite,
  runSuiteWithEvidenceGuard,
  runSuiteWithSanitizedPublication,
} from "../src/runner.js";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "../..");
const suitePath = resolve(projectRoot, "examples/refunds/suite.json");
const goodCandidate = resolve(
  projectRoot,
  "dist/examples/refunds/releases/agent-v1.js",
);
const regressedCandidate = resolve(
  projectRoot,
  "dist/examples/refunds/releases/agent-v2.js",
);
const goodManifest = resolve(
  projectRoot,
  "examples/refunds/releases/agent-v1.release.json",
);
const regressedManifest = resolve(
  projectRoot,
  "examples/refunds/releases/agent-v2.release.json",
);
const counterSuite = resolve(projectRoot, "examples/counter/suite.json");
const counterManifest = resolve(
  projectRoot,
  "examples/counter/releases/agent.release.json",
);
const counterAdapterManifest = resolve(
  projectRoot,
  "examples/counter/adapter.manifest.json",
);

async function runCli(
  args: readonly string[],
  environment: Readonly<Record<string, string>> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(
      process.execPath,
      [resolve(projectRoot, "dist/src/cli.js"), ...args],
      {
        cwd: projectRoot,
        env: { ...environment },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", rejectResult);
    child.once("close", (code) => resolveResult({ code, stdout, stderr }));
  });
}

test("known-good release passes and produces stable evidence", async () => {
  const first = await runSuite({
    suitePath,
    candidatePath: goodCandidate,
    releaseName: "agent-v1",
    generatedAt: "2026-08-29T00:00:00.000Z",
  });
  const second = await runSuite({
    suitePath,
    candidatePath: goodCandidate,
    releaseName: "agent-v1",
    generatedAt: "2026-08-30T00:00:00.000Z",
  });

  assert.equal(first.decision.verdict, "pass");
  assert.equal(first.scenarios.length, 3);
  assert.equal(first.evidenceDigest, second.evidenceDigest);
  assert.equal(verifyEvidenceDigest(first), true);
});

test("idempotency regression is blocked and identified by comparison", async () => {
  const baseline = await runSuite({
    suitePath,
    candidatePath: goodCandidate,
    releaseName: "agent-v1",
  });
  const candidate = await runSuite({
    suitePath,
    candidatePath: regressedCandidate,
    releaseName: "agent-v2",
  });
  const comparison = compareReports(baseline, candidate);

  assert.equal(candidate.decision.verdict, "block");
  assert.equal(
    candidate.scenarios.find(
      (scenario) => scenario.scenarioId === "timeout-after-commit",
    )?.verdict,
    "block",
  );
  assert.deepEqual(comparison.regressed, ["timeout-after-commit"]);
  assert.equal(comparison.verdict, "block");

  const baselineScenario = baseline.scenarios.find(
    (scenario) => scenario.scenarioId === "timeout-after-commit",
  );
  const candidateScenario = candidate.scenarios.find(
    (scenario) => scenario.scenarioId === "timeout-after-commit",
  );
  assert.ok(baselineScenario);
  assert.ok(candidateScenario);
  assert.deepEqual(
    candidateScenario.assertions
      .filter((assertion) => !assertion.passed)
      .map((assertion) => assertion.id),
    ["one-refund-after-ambiguous-timeout"],
  );
  const baselineCreates = baselineScenario.events.filter(
    (event) => event.tool === "refunds.create",
  );
  const candidateCreates = candidateScenario.events.filter(
    (event) => event.tool === "refunds.create",
  );
  assert.equal(baselineCreates[0]?.outcome, "error");
  assert.equal(baselineCreates[0]?.committed, true);
  assert.equal(baselineCreates[1]?.committed, false);
  assert.equal(candidateCreates[0]?.outcome, "error");
  assert.equal(candidateCreates[0]?.committed, true);
  assert.equal(candidateCreates[1]?.committed, true);
  assert.equal(
    (baselineCreates[1]?.arguments as Record<string, unknown>).idempotencyKey,
    "ticket-timeout:order-timeout:refund",
  );
  assert.equal(
    (candidateCreates[1]?.arguments as Record<string, unknown>).idempotencyKey,
    "ticket-timeout:order-timeout:refund:retry",
  );
});

test("manifest-backed releases carry bundle identity and retain the gate result", async () => {
  const baseline = await runSuite({
    suitePath,
    releaseManifestPath: goodManifest,
    generatedAt: "2026-08-29T00:00:00.000Z",
  });
  const repeated = await runSuite({
    suitePath,
    releaseManifestPath: goodManifest,
    generatedAt: "2026-08-30T00:00:00.000Z",
  });
  const candidate = await runSuite({
    suitePath,
    releaseManifestPath: regressedManifest,
  });

  assert.equal(baseline.schemaVersion, "agentci.report.v3");
  assert.equal(baseline.decision.verdict, "pass");
  assert.equal(candidate.decision.verdict, "block");
  assert.equal(baseline.release.digestScope, "declared-config-and-bundle-bytes");
  assert.equal(baseline.evidenceDigest, repeated.evidenceDigest);
  assert.equal(isReleaseReport(baseline), true);
  assert.equal(verifyEvidenceDigest(baseline), true);
  assert.deepEqual(compareReports(baseline, candidate).regressed, [
    "timeout-after-commit",
  ]);
});

test("a manifest-declared external adapter runs end to end", async () => {
  const report = await runSuite({
    suitePath: counterSuite,
    releaseManifestPath: counterManifest,
    adapterManifestPath: counterAdapterManifest,
  });

  assert.equal(report.decision.verdict, "pass");
  assert.equal(report.adapter.id, "counter.v1");
  assert.equal(report.adapter.apiVersion, "agentci.adapter.v2");
  assert.equal(report.adapter.source, "external-manifest");
  assert.equal(
    report.adapter.digestScope,
    "declared-config-and-adapter-bundle-bytes",
  );
  assert.equal(report.adapter.manifest.runtime.entry, "adapter.mjs");
  assert.equal(report.adapter.fileCount, report.adapter.files.length);
  assert.equal(report.adapter.files.some((file) => file.path === "adapter.mjs"), true);
  assert.equal("manifestPath" in report.adapter, false);
  assert.equal("bundleRoot" in report.adapter, false);
  assert.equal(JSON.stringify(report.adapter).includes(projectRoot), false);
  assert.equal(report.release.digestScope, "declared-config-and-bundle-bytes");
  assert.equal(isReleaseReport(report), true);
  assert.equal(verifyEvidenceDigest(report), true);
});

test("a release-v2 digest grant supplies only declared candidate credentials", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agentci-candidate-credential-runner-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const counterRoot = join(root, "counter");
  await cp(resolve(projectRoot, "examples/counter"), counterRoot, {
    recursive: true,
  });
  const releaseManifestPath = join(
    counterRoot,
    "releases/agent.release.json",
  );
  const releaseManifest = JSON.parse(
    await readFile(releaseManifestPath, "utf8"),
  ) as Record<string, unknown>;
  releaseManifest.model = {
    kind: "remote",
    provider: "synthetic-provider",
    identifier: "synthetic-model",
    revision: "fixed",
  };
  releaseManifest.candidate = {
    credentials: {
      kind: "environment",
      environment: ["MODEL_PROVIDER_KEY"],
    },
  };
  await writeFile(
    releaseManifestPath,
    JSON.stringify(releaseManifest),
    "utf8",
  );
  const candidatePath = join(
    counterRoot,
    "releases/agent.bundle/candidate.mjs",
  );
  await writeFile(
    candidatePath,
    `if (typeof process.env.MODEL_PROVIDER_KEY !== "string" || process.env.AMBIENT_SHOULD_NOT_REACH !== undefined) throw new Error("candidate environment policy failed");\nif (Number(process.env.MODEL_PROVIDER_KEY) === 314_159) process.stderr.write("x".repeat(Number(process.env.MODEL_PROVIDER_KEY)));\n${await readFile(candidatePath, "utf8")}`,
    "utf8",
  );
  const capture = await loadReleaseManifest(releaseManifestPath);
  const credential = "synthetic-model-provider-credential-value";
  const priorAmbientCandidateValue = process.env.MODEL_PROVIDER_KEY;
  process.env.MODEL_PROVIDER_KEY = "ambient-value-that-must-not-be-read";
  try {
    await assert.rejects(
      runSuite({
        suitePath: join(counterRoot, "suite.json"),
        releaseManifestPath,
        adapterManifestPath: join(counterRoot, "adapter.manifest.json"),
        candidateCallerAllowlist: ["MODEL_PROVIDER_KEY"],
        approvedReleaseDigest: capture.identity.releaseDigest,
        requireExplicitCandidatePolicy: true,
      }),
      /candidate credential environment value 'MODEL_PROVIDER_KEY' is missing/,
    );
  } finally {
    if (priorAmbientCandidateValue === undefined) {
      delete process.env.MODEL_PROVIDER_KEY;
    } else {
      process.env.MODEL_PROVIDER_KEY = priorAmbientCandidateValue;
    }
  }
  const { report, publication } = await runSuiteWithSanitizedPublication({
    suitePath: join(counterRoot, "suite.json"),
    releaseManifestPath,
    adapterManifestPath: join(counterRoot, "adapter.manifest.json"),
    candidateCallerAllowlist: ["MODEL_PROVIDER_KEY"],
    approvedReleaseDigest: capture.identity.releaseDigest,
    candidateSourceEnv: {
      MODEL_PROVIDER_KEY: credential,
      AMBIENT_SHOULD_NOT_REACH: "ambient-value",
    },
    requireExplicitCandidatePolicy: true,
  });

  assert.equal(report.decision.verdict, "pass");
  assert.equal(JSON.stringify(report).includes(credential), false);
  assert.equal(JSON.stringify(publication).includes(credential), false);

  const adapterHostRequestFragment = '"type":"validate"';
  await assert.rejects(
    runSuite({
      suitePath: join(counterRoot, "suite.json"),
      releaseManifestPath,
      adapterManifestPath: join(counterRoot, "adapter.manifest.json"),
      candidateCallerAllowlist: ["MODEL_PROVIDER_KEY"],
      approvedReleaseDigest: capture.identity.releaseDigest,
      candidateSourceEnv: {
        MODEL_PROVIDER_KEY: adapterHostRequestFragment,
      },
      requireExplicitCandidatePolicy: true,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /adapter-host protocol/);
      assert.equal(error.message.includes(adapterHostRequestFragment), false);
      return true;
    },
  );
  await assert.rejects(
    runSuite({
      suitePath: join(counterRoot, "suite.json"),
      releaseManifestPath,
      adapterManifestPath: join(counterRoot, "adapter.manifest.json"),
      candidateCallerAllowlist: ["MODEL_PROVIDER_KEY"],
      approvedReleaseDigest: capture.identity.releaseDigest,
      candidateSourceEnv: {
        MODEL_PROVIDER_KEY: report.evidenceDigest,
      },
      requireExplicitCandidatePolicy: true,
    }),
    /canonical evidence contains authorized credential material/,
  );
  await assert.rejects(
    runSuiteWithSanitizedPublication({
      suitePath: join(counterRoot, "suite.json"),
      releaseManifestPath,
      adapterManifestPath: join(counterRoot, "adapter.manifest.json"),
      candidateCallerAllowlist: ["MODEL_PROVIDER_KEY"],
      approvedReleaseDigest: capture.identity.releaseDigest,
      candidateSourceEnv: {
        MODEL_PROVIDER_KEY: publication.publicationDigest,
      },
      requireExplicitCandidatePolicy: true,
    }),
    /sanitized publication contains authorized credential material/,
  );
  const fixedPhraseBoundary = await runSuiteWithSanitizedPublication({
    suitePath: join(counterRoot, "suite.json"),
    releaseManifestPath,
    adapterManifestPath: join(counterRoot, "adapter.manifest.json"),
    candidateCallerAllowlist: ["MODEL_PROVIDER_KEY"],
    approvedReleaseDigest: capture.identity.releaseDigest,
    candidateSourceEnv: {
      MODEL_PROVIDER_KEY: "PASS sanitized Agent CI publication",
    },
    requireExplicitCandidatePolicy: true,
  });
  assert.throws(
    () =>
      fixedPhraseBoundary.assertNoExecutionSecretLeaks(
        renderSanitizedConsoleSummary(fixedPhraseBoundary.publication),
      ),
    /rendered evidence contains authorized credential material/,
  );
  const plainPhraseBoundary = await runSuiteWithEvidenceGuard({
    suitePath: join(counterRoot, "suite.json"),
    releaseManifestPath,
    adapterManifestPath: join(counterRoot, "adapter.manifest.json"),
    candidateCallerAllowlist: ["MODEL_PROVIDER_KEY"],
    approvedReleaseDigest: capture.identity.releaseDigest,
    candidateSourceEnv: {
      MODEL_PROVIDER_KEY:
        "PASS counter-agent-v1 against external-counter@1.0.0",
    },
    requireExplicitCandidatePolicy: true,
  });
  assert.throws(
    () =>
      plainPhraseBoundary.assertNoExecutionSecretLeaks(
        renderConsoleSummary(plainPhraseBoundary.report),
      ),
    /rendered evidence contains authorized credential material/,
  );
  const cliBaseArgs = [
    "check",
    "--suite",
    join(counterRoot, "suite.json"),
    "--manifest",
    releaseManifestPath,
    "--adapter-manifest",
    join(counterRoot, "adapter.manifest.json"),
    "--allow-candidate-env",
    "MODEL_PROVIDER_KEY",
    "--approved-release-digest",
    capture.identity.releaseDigest,
    "--require-explicit-candidate-policy",
  ] as const;
  const exactSummaryCredential =
    "PASS counter-agent-v1 against external-counter@1.0.0\n";
  const summaryCollision = await runCli(cliBaseArgs, {
    MODEL_PROVIDER_KEY: exactSummaryCredential,
  });
  assert.equal(summaryCollision.code, 2);
  assert.equal(summaryCollision.stdout.includes(exactSummaryCredential), false);
  assert.equal(summaryCollision.stderr.includes(exactSummaryCredential), false);

  const blockingSuitePath = join(counterRoot, "blocking-suite.json");
  const blockingSuite = JSON.parse(
    await readFile(join(counterRoot, "suite.json"), "utf8"),
  ) as {
    scenarios: Array<{
      assertions: Array<{ id: string; expected?: unknown }>;
    }>;
  };
  const finalCount = blockingSuite.scenarios[0]?.assertions.find(
    (assertion) => assertion.id === "final-count",
  );
  assert.ok(finalCount);
  finalCount.expected = 3;
  await writeFile(blockingSuitePath, JSON.stringify(blockingSuite), "utf8");
  const githubArgs = [
    ...cliBaseArgs.slice(0, 1),
    "--suite",
    blockingSuitePath,
    ...cliBaseArgs.slice(3),
    "--github",
  ];
  for (const githubCredential of [
    "Agent CI block: scenario 1",
    "::error title=Agent CI block%3A scenario 1::Sanitized annotation: inspect protected local evidence for details.\n",
  ]) {
    const annotationCollision = await runCli(githubArgs, {
      MODEL_PROVIDER_KEY: githubCredential,
    });
    assert.equal(annotationCollision.code, 2);
    assert.equal(annotationCollision.stdout.includes(githubCredential), false);
    assert.equal(annotationCollision.stderr.includes(githubCredential), false);
  }
  await assert.rejects(
    runSuite({
      suitePath: join(counterRoot, "suite.json"),
      releaseManifestPath,
      adapterManifestPath: join(counterRoot, "adapter.manifest.json"),
      candidateCallerAllowlist: ["MODEL_PROVIDER_KEY"],
      approvedReleaseDigest: capture.identity.releaseDigest,
      candidateSourceEnv: { MODEL_PROVIDER_KEY: "314159" },
      requireExplicitCandidatePolicy: true,
    }),
    /canonical evidence contains authorized credential material/,
  );
  await assert.rejects(
    runSuite({
      suitePath: join(counterRoot, "suite.json"),
      releaseManifestPath,
      adapterManifestPath: join(counterRoot, "adapter.manifest.json"),
      candidateCallerAllowlist: ["MODEL_PROVIDER_KEY"],
      candidateSourceEnv: {
        MODEL_PROVIDER_KEY: credential,
        AMBIENT_SHOULD_NOT_REACH: "ambient-value",
      },
      requireExplicitCandidatePolicy: true,
    }),
    /require captured and independently approved release digests|require captured and independently approved release/i,
  );
});

test("candidate credentials reject a legacy adapter before its module is imported", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agentci-legacy-candidate-credential-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const counterRoot = join(root, "counter");
  await cp(resolve(projectRoot, "examples/counter"), counterRoot, {
    recursive: true,
  });
  const releaseManifestPath = join(
    counterRoot,
    "releases/agent.release.json",
  );
  const releaseManifest = JSON.parse(
    await readFile(releaseManifestPath, "utf8"),
  ) as Record<string, unknown>;
  releaseManifest.model = {
    kind: "remote",
    provider: "synthetic-provider",
    identifier: "synthetic-model",
    revision: "fixed",
  };
  releaseManifest.candidate = {
    credentials: {
      kind: "environment",
      environment: ["MODEL_PROVIDER_KEY"],
    },
  };
  await writeFile(releaseManifestPath, JSON.stringify(releaseManifest), "utf8");
  const capture = await loadReleaseManifest(releaseManifestPath);
  const importedMarker = join(root, "legacy-adapter-imported");
  const legacyAdapter = join(root, "legacy-adapter.mjs");
  await writeFile(
    legacyAdapter,
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(importedMarker)}, "imported");\nexport default {};\n`,
    "utf8",
  );

  await assert.rejects(
    runSuite({
      suitePath: join(counterRoot, "suite.json"),
      releaseManifestPath,
      adapterPath: legacyAdapter,
      candidateCallerAllowlist: ["MODEL_PROVIDER_KEY"],
      approvedReleaseDigest: capture.identity.releaseDigest,
      candidateSourceEnv: {
        MODEL_PROVIDER_KEY: "candidate-provider-value-for-legacy-test",
      },
    }),
    /manifest-backed API-v2 adapter boundary/,
  );
  await assert.rejects(access(importedMarker), (error: unknown) => {
    assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
    return true;
  });
});

test("candidate credentials are excluded from adapter artifacts before inspection", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agentci-adapter-candidate-separation-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const counterRoot = join(root, "counter");
  await cp(resolve(projectRoot, "examples/counter"), counterRoot, {
    recursive: true,
  });
  const secret = "candidate-provider-value-in-adapter-artifact";
  const releaseManifestPath = join(
    counterRoot,
    "releases/agent.release.json",
  );
  const releaseManifest = JSON.parse(
    await readFile(releaseManifestPath, "utf8"),
  ) as Record<string, unknown>;
  releaseManifest.model = {
    kind: "remote",
    provider: "synthetic-provider",
    identifier: "synthetic-model",
    revision: "fixed",
  };
  releaseManifest.candidate = {
    credentials: {
      kind: "environment",
      environment: ["MODEL_PROVIDER_KEY"],
    },
  };
  await writeFile(releaseManifestPath, JSON.stringify(releaseManifest), "utf8");
  const releaseCapture = await loadReleaseManifest(releaseManifestPath);

  const adapterManifestPath = join(counterRoot, "adapter.manifest.json");
  await writeFile(join(counterRoot, "adapter.bundle", secret), "safe", "utf8");
  const importedMarker = join(root, "adapter-inspection-started");
  const adapterEntry = join(counterRoot, "adapter.bundle/adapter.mjs");
  await writeFile(
    adapterEntry,
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(importedMarker)}, "imported");\n${await readFile(adapterEntry, "utf8")}`,
    "utf8",
  );

  await assert.rejects(
    runSuite({
      suitePath: join(counterRoot, "suite.json"),
      releaseManifestPath,
      adapterManifestPath,
      candidateCallerAllowlist: ["MODEL_PROVIDER_KEY"],
      approvedReleaseDigest: releaseCapture.identity.releaseDigest,
      candidateSourceEnv: { MODEL_PROVIDER_KEY: secret },
    }),
    /adapter declaration or bundle contains candidate credential material/,
  );
  await assert.rejects(access(importedMarker), (error: unknown) => {
    assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
    return true;
  });
});

test("duplicate JSON members cannot hide cross-grant credentials in bundles", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agentci-duplicate-json-grant-boundary-"));
  context.after(async () => rm(root, { recursive: true, force: true }));

  const adapterDirectionRoot = join(root, "adapter-direction");
  await cp(resolve(projectRoot, "examples/counter"), adapterDirectionRoot, {
    recursive: true,
  });
  const adapterSecret = 'opaque"adapter\\value';
  await writeFile(
    join(
      adapterDirectionRoot,
      "releases/agent.bundle/ambiguous-credential.json",
    ),
    `{"value":${JSON.stringify(adapterSecret)},"value":"safe"}`,
    "utf8",
  );
  const adapterManifestPath = join(
    adapterDirectionRoot,
    "adapter.manifest.json",
  );
  const adapterManifest = JSON.parse(
    await readFile(adapterManifestPath, "utf8"),
  ) as Record<string, unknown>;
  adapterManifest.credentials = {
    environment: ["TEST_ADAPTER_TOKEN"],
  };
  adapterManifest.target = {
    kind: "remote",
    endpoint: "https://sandbox.invalid",
    tenant: "duplicate-json-boundary",
    apiVersion: "v1",
    configuration: {},
  };
  await writeFile(adapterManifestPath, JSON.stringify(adapterManifest), "utf8");
  const adapterImportMarker = join(root, "adapter-direction-imported");
  const adapterEntry = join(
    adapterDirectionRoot,
    "adapter.bundle/adapter.mjs",
  );
  await writeFile(
    adapterEntry,
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(adapterImportMarker)}, "imported");\n${await readFile(adapterEntry, "utf8")}`,
    "utf8",
  );
  const adapterCapture = await loadAdapterManifest(adapterManifestPath);
  await assert.rejects(
    runSuite({
      suitePath: join(adapterDirectionRoot, "suite.json"),
      releaseManifestPath: join(
        adapterDirectionRoot,
        "releases/agent.release.json",
      ),
      adapterManifestPath,
      callerAllowlist: ["TEST_ADAPTER_TOKEN"],
      approvedAdapterDigest: adapterCapture.identity.adapterDigest,
      adapterSourceEnv: { TEST_ADAPTER_TOKEN: adapterSecret },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /release bundle JSON artifact/);
      assert.equal(error.message.includes(adapterSecret), false);
      return true;
    },
  );
  await assert.rejects(access(adapterImportMarker), (error: unknown) => {
    assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
    return true;
  });

  const candidateDirectionRoot = join(root, "candidate-direction");
  await cp(resolve(projectRoot, "examples/counter"), candidateDirectionRoot, {
    recursive: true,
  });
  const candidateSecret = 'opaque"candidate\\value';
  const candidateReleasePath = join(
    candidateDirectionRoot,
    "releases/agent.release.json",
  );
  const candidateRelease = JSON.parse(
    await readFile(candidateReleasePath, "utf8"),
  ) as Record<string, unknown>;
  candidateRelease.model = {
    kind: "remote",
    provider: "synthetic-provider",
    identifier: "synthetic-model",
    revision: "fixed",
  };
  candidateRelease.candidate = {
    credentials: {
      kind: "environment",
      environment: ["MODEL_PROVIDER_KEY"],
    },
  };
  await writeFile(
    candidateReleasePath,
    JSON.stringify(candidateRelease),
    "utf8",
  );
  await writeFile(
    join(
      candidateDirectionRoot,
      "adapter.bundle/ambiguous-credential.json",
    ),
    `{"value":${JSON.stringify(candidateSecret)},"value":"safe"}`,
    "utf8",
  );
  const candidateImportMarker = join(root, "candidate-direction-imported");
  const candidateAdapterEntry = join(
    candidateDirectionRoot,
    "adapter.bundle/adapter.mjs",
  );
  await writeFile(
    candidateAdapterEntry,
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(candidateImportMarker)}, "imported");\n${await readFile(candidateAdapterEntry, "utf8")}`,
    "utf8",
  );
  const candidateReleaseCapture = await loadReleaseManifest(
    candidateReleasePath,
  );
  await assert.rejects(
    runSuite({
      suitePath: join(candidateDirectionRoot, "suite.json"),
      releaseManifestPath: candidateReleasePath,
      adapterManifestPath: join(
        candidateDirectionRoot,
        "adapter.manifest.json",
      ),
      candidateCallerAllowlist: ["MODEL_PROVIDER_KEY"],
      approvedReleaseDigest:
        candidateReleaseCapture.identity.releaseDigest,
      candidateSourceEnv: { MODEL_PROVIDER_KEY: candidateSecret },
      requireExplicitCandidatePolicy: true,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /adapter bundle JSON artifact/);
      assert.equal(error.message.includes(candidateSecret), false);
      return true;
    },
  );
  await assert.rejects(access(candidateImportMarker), (error: unknown) => {
    assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
    return true;
  });
});

test("non-finite JSON numbers cannot encode cross-grant credential values", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agentci-nonfinite-secret-boundary-"));
  context.after(async () => rm(root, { recursive: true, force: true }));

  const candidateRoot = join(root, "candidate");
  await cp(resolve(projectRoot, "examples/counter"), candidateRoot, {
    recursive: true,
  });
  const candidateSecret = "Infinity";
  const releaseManifestPath = join(
    candidateRoot,
    "releases/agent.release.json",
  );
  const releaseManifest = JSON.parse(
    await readFile(releaseManifestPath, "utf8"),
  ) as Record<string, unknown>;
  releaseManifest.model = {
    kind: "remote",
    provider: "synthetic-provider",
    identifier: "synthetic-model",
    revision: "fixed",
  };
  releaseManifest.candidate = {
    credentials: {
      kind: "environment",
      environment: ["MODEL_PROVIDER_KEY"],
    },
  };
  await writeFile(releaseManifestPath, JSON.stringify(releaseManifest), "utf8");
  const releaseCapture = await loadReleaseManifest(releaseManifestPath);
  await writeFile(
    join(candidateRoot, "releases/agent.bundle/opaque.DATA"),
    '{"n":1e400}',
    "utf8",
  );
  const adapterInspectionMarker = join(root, "candidate-direction-adapter-inspected");
  const candidateDirectionAdapterEntry = join(
    candidateRoot,
    "adapter.bundle/adapter.mjs",
  );
  await writeFile(
    candidateDirectionAdapterEntry,
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(adapterInspectionMarker)}, "inspected");\n${await readFile(candidateDirectionAdapterEntry, "utf8")}`,
    "utf8",
  );
  await assert.rejects(
    runSuite({
      suitePath: join(candidateRoot, "suite.json"),
      releaseManifestPath,
      adapterManifestPath: join(candidateRoot, "adapter.manifest.json"),
      candidateCallerAllowlist: ["MODEL_PROVIDER_KEY"],
      approvedReleaseDigest: releaseCapture.identity.releaseDigest,
      candidateSourceEnv: { MODEL_PROVIDER_KEY: candidateSecret },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /release bundle JSON artifact/);
      assert.equal(error.message.includes(candidateSecret), false);
      return true;
    },
  );
  await assert.rejects(access(adapterInspectionMarker), (error: unknown) => {
    assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
    return true;
  });

  const adapterRoot = join(root, "adapter");
  await cp(resolve(projectRoot, "examples/counter"), adapterRoot, {
    recursive: true,
  });
  const adapterSecret = "-Infinity";
  const adapterManifestPath = join(adapterRoot, "adapter.manifest.json");
  const adapterManifest = JSON.parse(
    await readFile(adapterManifestPath, "utf8"),
  ) as {
    credentials: { environment: string[] };
    target: Record<string, unknown>;
  };
  adapterManifest.credentials.environment = ["ADAPTER_TEST_KEY"];
  adapterManifest.target = {
    kind: "remote",
    endpoint: "https://counter.example.invalid/",
    tenant: "dedicated-test-tenant",
    apiVersion: "test-v1",
    configuration: { namespace: "counter-example" },
  };
  await writeFile(adapterManifestPath, JSON.stringify(adapterManifest), "utf8");
  const adapterCapture = await loadAdapterManifest(adapterManifestPath);
  await writeFile(
    join(adapterRoot, "adapter.bundle/opaque.DATA"),
    '{"n":-1e400}',
    "utf8",
  );
  const candidateExecutionMarker = join(root, "adapter-direction-candidate-ran");
  const adapterDirectionCandidateEntry = join(
    adapterRoot,
    "releases/agent.bundle/candidate.mjs",
  );
  await writeFile(
    adapterDirectionCandidateEntry,
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(candidateExecutionMarker)}, "ran");\n${await readFile(adapterDirectionCandidateEntry, "utf8")}`,
    "utf8",
  );
  await assert.rejects(
    runSuite({
      suitePath: join(adapterRoot, "suite.json"),
      releaseManifestPath: join(adapterRoot, "releases/agent.release.json"),
      adapterManifestPath,
      callerAllowlist: ["ADAPTER_TEST_KEY"],
      approvedAdapterDigest: adapterCapture.identity.adapterDigest,
      adapterSourceEnv: { ADAPTER_TEST_KEY: adapterSecret },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /adapter bundle JSON artifact/);
      assert.equal(error.message.includes(adapterSecret), false);
      return true;
    },
  );
  await assert.rejects(access(candidateExecutionMarker), (error: unknown) => {
    assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
    return true;
  });
});

test("canonical evidence rejects an authorized credential in a local path", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agentci-report-path-secret-boundary-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const secret = "opaque-canonical-path-value-1234567890";
  const counterRoot = join(root, secret, "counter");
  await mkdir(join(root, secret), { recursive: true });
  await cp(resolve(projectRoot, "examples/counter"), counterRoot, {
    recursive: true,
  });
  const releaseManifestPath = join(
    counterRoot,
    "releases/agent.release.json",
  );
  const releaseManifest = JSON.parse(
    await readFile(releaseManifestPath, "utf8"),
  ) as Record<string, unknown>;
  releaseManifest.model = {
    kind: "remote",
    provider: "synthetic-provider",
    identifier: "synthetic-model",
    revision: "fixed",
  };
  releaseManifest.candidate = {
    credentials: {
      kind: "environment",
      environment: ["MODEL_PROVIDER_KEY"],
    },
  };
  await writeFile(releaseManifestPath, JSON.stringify(releaseManifest), "utf8");
  const releaseCapture = await loadReleaseManifest(releaseManifestPath);

  await assert.rejects(
    runSuite({
      suitePath: join(counterRoot, "suite.json"),
      releaseManifestPath,
      adapterManifestPath: join(counterRoot, "adapter.manifest.json"),
      candidateCallerAllowlist: ["MODEL_PROVIDER_KEY"],
      approvedReleaseDigest: releaseCapture.identity.releaseDigest,
      candidateSourceEnv: { MODEL_PROVIDER_KEY: secret },
    }),
    /canonical evidence contains authorized credential material/,
  );
});

test("a digest-approved CLI credential allowlist reaches a manifest adapter", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agentci-credentialed-adapter-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const bundle = join(root, "adapter.bundle");
  await mkdir(bundle);
  await writeFile(
    join(bundle, "adapter.mjs"),
    `function record(value) {
       return value !== null && typeof value === "object" && !Array.isArray(value);
     }
     export default {
       apiVersion: "agentci.adapter.v2",
       id: "counter.v1",
       version: "2.0.0",
       tools: ["counter.increment"],
       conformance: [{
         name: "credentialed increment",
         initialState: { count: 0 },
         call: { tool: "counter.increment", arguments: { delta: 1 } },
         expectedResult: { count: 1 },
         expectedFinalState: { count: 1 }
       }],
       validateSuite() { return []; },
       validateStatePointer(pointer) {
         return pointer === "/count" ? undefined : "is not declared";
       },
       createEnvironment(initialState, context) {
         if (typeof context.credentials.TEST_ADAPTER_TOKEN !== "string" ||
             context.credentials.TEST_ADAPTER_TOKEN.length === 0 ||
             process.env.TEST_ADAPTER_TOKEN !== undefined) {
           throw new Error("credential context was not isolated");
         }
         const state = structuredClone(initialState);
         return {
           tools: ["counter.increment"],
           async call(tool, argumentsValue) {
             if (tool !== "counter.increment" || !record(argumentsValue)) {
               throw { agentciToolError: true, code: "invalid_call", message: "invalid call" };
             }
             state.count += argumentsValue.delta;
             return { count: state.count };
           },
           snapshot() { return structuredClone(state); },
           close() {}
         };
       }
     };\n`,
    "utf8",
  );
  const adapterManifestPath = join(root, "adapter.manifest.json");
  await writeFile(
    adapterManifestPath,
    JSON.stringify({
      schemaVersion: "agentci.adapter-manifest.v1",
      id: "counter.v1",
      version: "2.0.0",
      runtime: {
        kind: "node-esm",
        apiVersion: "agentci.adapter.v2",
        protocolVersion: 1,
        entry: "adapter.mjs",
        operationTimeoutMs: 1_000,
        shutdownTimeoutMs: 250,
      },
      bundle: { root: "adapter.bundle" },
      contract: { tools: ["counter.increment"] },
      target: {
        kind: "remote",
        endpoint: "https://sandbox.invalid",
        tenant: "credential-policy-test",
        apiVersion: "v1",
        configuration: {},
      },
      credentials: { environment: ["TEST_ADAPTER_TOKEN"] },
    }),
    "utf8",
  );
  const capture = await loadAdapterManifest(adapterManifestPath);
  const secret = "credential-value-that-must-not-enter-evidence";
  const priorAmbientAdapterValue = process.env.TEST_ADAPTER_TOKEN;
  process.env.TEST_ADAPTER_TOKEN = "ambient-value-that-must-not-be-read";
  try {
    await assert.rejects(
      runSuite({
        suitePath: counterSuite,
        releaseManifestPath: counterManifest,
        adapterManifestPath,
        callerAllowlist: ["TEST_ADAPTER_TOKEN"],
        approvedAdapterDigest: capture.identity.adapterDigest,
      }),
      /credential environment value 'TEST_ADAPTER_TOKEN' is missing/,
    );
  } finally {
    if (priorAmbientAdapterValue === undefined) {
      delete process.env.TEST_ADAPTER_TOKEN;
    } else {
      process.env.TEST_ADAPTER_TOKEN = priorAmbientAdapterValue;
    }
  }
  const report = await runSuite({
    suitePath: counterSuite,
    releaseManifestPath: counterManifest,
    adapterManifestPath,
    callerAllowlist: ["TEST_ADAPTER_TOKEN"],
    approvedAdapterDigest: capture.identity.adapterDigest,
    adapterSourceEnv: { TEST_ADAPTER_TOKEN: secret },
  });

  assert.equal(report.decision.verdict, "pass");
  assert.equal(JSON.stringify(report).includes(secret), false);

  const startFrameCredential = `${JSON.stringify({
    v: 1,
    type: "start",
    scenarioId: "increment-once",
    task: { delta: 2 },
    tools: ["counter.increment"],
  })}\n`;
  const outboundBoundaryReport = await runSuite({
    suitePath: counterSuite,
    releaseManifestPath: counterManifest,
    adapterManifestPath,
    callerAllowlist: ["TEST_ADAPTER_TOKEN"],
    approvedAdapterDigest: capture.identity.adapterDigest,
    adapterSourceEnv: { TEST_ADAPTER_TOKEN: startFrameCredential },
  });
  assert.equal(outboundBoundaryReport.decision.verdict, "indeterminate");
  assert.match(
    outboundBoundaryReport.scenarios[0]!.reasons.join(" "),
    /runner-to-candidate protocol crossed a known credential boundary/,
  );
  assert.equal(
    JSON.stringify(outboundBoundaryReport).includes(startFrameCredential),
    false,
  );

  const spawnBoundaryReport = await runSuite({
    suitePath: counterSuite,
    releaseManifestPath: counterManifest,
    adapterManifestPath,
    callerAllowlist: ["TEST_ADAPTER_TOKEN"],
    approvedAdapterDigest: capture.identity.adapterDigest,
    adapterSourceEnv: { TEST_ADAPTER_TOKEN: process.execPath },
  });
  assert.equal(spawnBoundaryReport.decision.verdict, "indeterminate");
  assert.match(
    spawnBoundaryReport.scenarios[0]!.reasons.join(" "),
    /candidate spawn metadata crossed a known credential boundary/,
  );
  assert.equal(JSON.stringify(spawnBoundaryReport).includes(process.execPath), false);

  const cliResult = await runCli(
    [
      "check",
      "--suite",
      counterSuite,
      "--manifest",
      counterManifest,
      "--adapter-manifest",
      adapterManifestPath,
      "--allow-adapter-env",
      "TEST_ADAPTER_TOKEN",
      "--approved-adapter-digest",
      capture.identity.adapterDigest,
    ],
    { TEST_ADAPTER_TOKEN: secret },
  );
  assert.equal(cliResult.code, 0, cliResult.stderr);
  assert.match(cliResult.stdout, /^PASS /m);
  assert.equal(`${cliResult.stdout}${cliResult.stderr}`.includes(secret), false);

  const adapterCheckOutput =
    "valid adapter counter.v1@2.0.0: 1 conformance case(s)\n";
  const adapterCheckCollision = await runCli(
    [
      "adapter-check",
      "--adapter-manifest",
      adapterManifestPath,
      "--allow-adapter-env",
      "TEST_ADAPTER_TOKEN",
      "--approved-adapter-digest",
      capture.identity.adapterDigest,
    ],
    { TEST_ADAPTER_TOKEN: adapterCheckOutput },
  );
  assert.equal(adapterCheckCollision.code, 2);
  assert.equal(adapterCheckCollision.stdout.includes(adapterCheckOutput), false);
  assert.equal(adapterCheckCollision.stderr.includes(adapterCheckOutput), false);
});

test("manifest adapter identity rejects internally consistent evidence tampering", async () => {
  const report = await runSuite({
    suitePath: counterSuite,
    releaseManifestPath: counterManifest,
    adapterManifestPath: counterAdapterManifest,
  });
  if (
    report.adapter.digestScope !==
    "declared-config-and-adapter-bundle-bytes"
  ) {
    assert.fail("expected manifest-backed adapter identity");
  }

  const replacementDigest = (digest: string): string =>
    `${digest[0] === "0" ? "1" : "0"}${digest.slice(1)}`;
  const mutations: Array<{
    name: string;
    apply: (candidate: typeof report) => void;
  }> = [
    {
      name: "adapterDigest",
      apply(candidate) {
        if (
          candidate.adapter.digestScope !==
          "declared-config-and-adapter-bundle-bytes"
        ) {
          assert.fail("expected manifest-backed adapter identity");
        }
        candidate.adapter.adapterDigest = replacementDigest(
          candidate.adapter.adapterDigest,
        );
      },
    },
    {
      name: "normalized target configuration",
      apply(candidate) {
        if (
          candidate.adapter.digestScope !==
            "declared-config-and-adapter-bundle-bytes" ||
          candidate.adapter.manifest.target.kind !== "synthetic"
        ) {
          assert.fail("expected synthetic manifest-backed adapter identity");
        }
        candidate.adapter.manifest.target.configuration.namespace = "tampered";
      },
    },
    {
      name: "captured bundle file",
      apply(candidate) {
        if (
          candidate.adapter.digestScope !==
          "declared-config-and-adapter-bundle-bytes"
        ) {
          assert.fail("expected manifest-backed adapter identity");
        }
        const file = candidate.adapter.files[0];
        assert.ok(file);
        file.digest = replacementDigest(file.digest);
      },
    },
    ...([
      "manifestDigest",
      "bundleDigest",
      "configurationDigest",
      "credentialDeclarationDigest",
      "contractDigest",
      "entryFileDigest",
    ] as const).map((field) => ({
      name: field,
      apply(candidate: typeof report) {
        if (
          candidate.adapter.digestScope !==
          "declared-config-and-adapter-bundle-bytes"
        ) {
          assert.fail("expected manifest-backed adapter identity");
        }
        candidate.adapter[field] = replacementDigest(candidate.adapter[field]);
      },
    })),
  ];

  for (const mutation of mutations) {
    const tampered = structuredClone(report);
    mutation.apply(tampered);
    const { evidenceDigest: _oldDigest, ...withoutDigest } = tampered;
    tampered.evidenceDigest = computeEvidenceDigest(withoutDigest);

    assert.equal(
      verifyEvidenceDigest(tampered),
      true,
      `${mutation.name} should be covered by the evidence digest`,
    );
    assert.equal(
      isReleaseReport(tampered),
      false,
      `${mutation.name} must fail internal identity validation`,
    );
    assert.equal(compareReports(report, tampered).verdict, "indeterminate");
  }
});

test("candidate stderr is represented by metadata and omitted from reports", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agentci-stderr-report-test-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const secret = "synthetic-canary-secret-never-retain";
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

  const report = await runSuite({
    suitePath,
    candidatePath,
    releaseName: "stderr-metadata-only",
  });

  assert.equal(JSON.stringify(report).includes(secret), false);
  assert.ok(report.scenarios.every((result) => result.candidateDiagnostics.stderrBytes > 0));
  assert.ok(report.scenarios.every((result) => !("candidateStderr" in result)));
  assert.equal(isReleaseReport(report), true);
  assert.equal(verifyEvidenceDigest(report), true);
});

test("a candidate that mutates its materialized release is indeterminate", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agentci-runner-test-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const bundle = join(root, "bundle");
  await cp(
    resolve(projectRoot, "examples/refunds/releases/agent-v1.bundle"),
    bundle,
    { recursive: true },
  );
  const candidatePath = join(bundle, "candidate.mjs");
  const candidate = await readFile(candidatePath, "utf8");
  await writeFile(
    candidatePath,
    `import { writeFileSync } from "node:fs";\nwriteFileSync("unexpected.txt", "mutation");\n${candidate}`,
    "utf8",
  );
  const manifest = join(root, "release.json");
  await writeFile(
    manifest,
    JSON.stringify({
      schemaVersion: "agentci.release.v1",
      name: "self-mutating",
      runtime: { kind: "node-jsonl", protocolVersion: 1, entry: "candidate.mjs" },
      bundle: { root: "bundle" },
      model: { kind: "none", reason: "deterministic synthetic test" },
      components: {
        prompts: ["prompt.md"],
        toolSchemas: ["tool-schema.json"],
      },
    }),
    "utf8",
  );

  const report = await runSuite({ suitePath, releaseManifestPath: manifest });
  assert.equal(report.decision.verdict, "indeterminate");
  assert.ok(
    report.scenarios.every((scenario) =>
      scenario.reasons.some((reason) => reason.includes("bundle changed")),
    ),
  );
});

test("an adapter cannot pass by replacing the declared initial state", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agentci-runner-test-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const bundle = join(root, "bundle");
  await mkdir(bundle);
  await writeFile(
    join(root, "adapter.mjs"),
    `export default {
      apiVersion: "agentci.adapter.v1",
      id: "external.v1",
      version: "1.0.0",
      tools: ["noop"],
      conformance: [{
        name: "noop",
        initialState: { done: false },
        call: { tool: "noop", arguments: {} },
        expectedResult: {},
        expectedFinalState: { done: false }
      }],
      validateSuite() { return []; },
      validateStatePointer(pointer) {
        return pointer === "/done" ? undefined : "is not declared";
      },
      createEnvironment(initialState) {
        initialState.done = true;
        return {
          tools: ["noop"],
          async call() { return {}; },
          snapshot() { return structuredClone(initialState); }
        };
      }
    };\n`,
    "utf8",
  );
  await writeFile(
    join(root, "suite.json"),
    JSON.stringify({
      schemaVersion: "agentci.suite.v1",
      name: "external-initial-state",
      version: "1.0.0",
      fixture: "external.v1",
      gate: { minPassRate: 1 },
      scenarios: [
        {
          id: "case",
          description: "adapter tries to pre-satisfy the oracle",
          task: {},
          initialState: { done: false },
          timeoutMs: 500,
          maxToolCalls: 1,
          assertions: [
            {
              id: "done",
              type: "json_pointer",
              source: "state",
              pointer: "/done",
              operator: "equals",
              expected: true,
            },
          ],
        },
      ],
    }),
    "utf8",
  );
  await writeFile(
    join(root, "release.json"),
    JSON.stringify({
      schemaVersion: "agentci.release.v1",
      name: "external-candidate",
      runtime: { kind: "node-jsonl", protocolVersion: 1, entry: "candidate.mjs" },
      bundle: { root: "bundle" },
      model: { kind: "none", reason: "deterministic synthetic test" },
      components: { prompts: ["prompt.md"], toolSchemas: ["tools.json"] },
    }),
    "utf8",
  );
  await writeFile(
    join(bundle, "candidate.mjs"),
    `import { createInterface } from "node:readline";
     const lines = createInterface({ input: process.stdin });
     lines.on("line", (line) => {
       const message = JSON.parse(line);
       if (message.type === "start") {
         process.stdout.write(JSON.stringify({ v: 1, type: "done", output: {} }) + "\\n");
       }
     });\n`,
    "utf8",
  );
  await writeFile(join(bundle, "prompt.md"), "prompt", "utf8");
  await writeFile(join(bundle, "tools.json"), "{}", "utf8");

  const report = await runSuite({
    suitePath: join(root, "suite.json"),
    releaseManifestPath: join(root, "release.json"),
    adapterPath: join(root, "adapter.mjs"),
  });
  assert.equal(report.decision.verdict, "indeterminate");
  assert.match(report.scenarios[0]!.reasons.join(" "), /did not preserve/);
});

test("tampering invalidates the evidence digest", async () => {
  const report = await runSuite({
    suitePath,
    candidatePath: goodCandidate,
    releaseName: "agent-v1",
  });
  const tampered = structuredClone(report);
  tampered.scenarios[0]!.verdict = "block";
  assert.equal(verifyEvidenceDigest(tampered), false);
  assert.equal(compareReports(report, tampered).verdict, "indeterminate");
});

test("report validation rejects inconsistent decision counters", async () => {
  const report = await runSuite({
    suitePath,
    candidatePath: goodCandidate,
    releaseName: "agent-v1",
  });
  const inconsistent = structuredClone(report);
  inconsistent.decision.passed = 999;
  const { evidenceDigest: _oldDigest, ...withoutDigest } = inconsistent;
  inconsistent.evidenceDigest = computeEvidenceDigest(withoutDigest);

  assert.equal(verifyEvidenceDigest(inconsistent), true);
  assert.equal(isReleaseReport(inconsistent), false);
});

test("report validation rejects malformed optional assertion metadata", async () => {
  const report = await runSuite({
    suitePath,
    releaseManifestPath: goodManifest,
  });
  const malformed = structuredClone(report);
  (malformed.scenarios[0]!.assertions[0] as unknown as Record<
    string,
    unknown
  >).description = 42;
  const { evidenceDigest: _oldDigest, ...withoutDigest } = malformed;
  malformed.evidenceDigest = computeEvidenceDigest(withoutDigest);

  assert.equal(verifyEvidenceDigest(malformed), true);
  assert.equal(isReleaseReport(malformed), false);
});

test("report validation rejects a non-finite top-level duration", async () => {
  const report = await runSuite({
    suitePath,
    releaseManifestPath: goodManifest,
  });
  const malformed = structuredClone(report);
  malformed.durationMs = Number.POSITIVE_INFINITY;
  const { evidenceDigest: _oldDigest, ...withoutDigest } = malformed;
  malformed.evidenceDigest = computeEvidenceDigest(withoutDigest);

  assert.equal(verifyEvidenceDigest(malformed), true);
  assert.equal(isReleaseReport(malformed), false);
});

test("report validation rejects unsigned extension fields", async () => {
  const report = await runSuite({
    suitePath,
    releaseManifestPath: goodManifest,
  });
  const extended = structuredClone(report) as typeof report & {
    claimedCertification?: string;
  };
  extended.claimedCertification = "not covered by evidence";

  assert.equal(verifyEvidenceDigest(extended), true);
  assert.equal(isReleaseReport(extended), false);
  assert.equal(compareReports(report, extended).verdict, "indeterminate");
});

test("report validation rejects duplicate scenario ids", async () => {
  const report = await runSuite({
    suitePath,
    releaseManifestPath: goodManifest,
  });
  const duplicated = structuredClone(report);
  duplicated.scenarios[1]!.scenarioId = duplicated.scenarios[0]!.scenarioId;
  const { evidenceDigest: _oldDigest, ...withoutDigest } = duplicated;
  duplicated.evidenceDigest = computeEvidenceDigest(withoutDigest);

  assert.equal(verifyEvidenceDigest(duplicated), true);
  assert.equal(isReleaseReport(duplicated), false);
  assert.equal(compareReports(report, duplicated).verdict, "indeterminate");
});

test("report validation rejects a passing scenario with omitted assertions", async () => {
  const report = await runSuite({
    suitePath: counterSuite,
    releaseManifestPath: counterManifest,
    adapterManifestPath: counterAdapterManifest,
  });
  const omitted = structuredClone(report);
  omitted.scenarios[0]!.assertions = [];
  const { evidenceDigest: _oldDigest, ...withoutDigest } = omitted;
  omitted.evidenceDigest = computeEvidenceDigest(withoutDigest);

  assert.equal(verifyEvidenceDigest(omitted), true);
  assert.equal(isReleaseReport(omitted), false);
  assert.equal(compareReports(report, omitted).verdict, "indeterminate");
});

test("report validation rejects a non-normalized embedded manifest", async () => {
  const report = await runSuite({
    suitePath,
    releaseManifestPath: goodManifest,
  });
  const noncanonical = structuredClone(report);
  if (noncanonical.release.digestScope !== "declared-config-and-bundle-bytes") {
    assert.fail("expected a manifest-backed release");
  }
  const release = noncanonical.release;
  release.manifest.components.prompts = ["prompt.md", "driver.mjs"];
  const byPath = new Map(release.files.map((file) => [file.path, file]));
  const promptFiles = release.manifest.components.prompts.map(
    (path) => byPath.get(path)!,
  );
  const classified = new Set([
    ...release.manifest.components.prompts,
    ...release.manifest.components.toolSchemas,
  ]);
  const harnessFiles = release.files.filter((file) => !classified.has(file.path));
  release.manifestDigest = digestValue({
    domain: "agentci.release-manifest.v1",
    manifest: release.manifest,
  });
  release.promptDigest = digestValue({
    domain: "agentci.prompt-set.v1",
    files: promptFiles,
  });
  release.harnessDigest = digestValue({
    domain: "agentci.harness-set.v1",
    files: harnessFiles,
  });
  release.releaseDigest = digestValue({
    domain: "agentci.declared-release.v1",
    runtime: release.manifest.runtime,
    manifestDigest: release.manifestDigest,
    bundleDigest: release.bundleDigest,
    modelDeclarationDigest: release.modelDeclarationDigest,
    promptDigest: release.promptDigest,
    toolSchemaDigest: release.toolSchemaDigest,
    harnessDigest: release.harnessDigest,
  });
  const { evidenceDigest: _oldDigest, ...withoutDigest } = noncanonical;
  noncanonical.evidenceDigest = computeEvidenceDigest(withoutDigest);

  assert.equal(verifyEvidenceDigest(noncanonical), true);
  assert.equal(isReleaseReport(noncanonical), false);
  assert.equal(compareReports(report, noncanonical).verdict, "indeterminate");
});
