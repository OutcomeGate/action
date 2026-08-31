import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { compareReports, renderComparison } from "../src/comparison.js";
import {
  isReleaseReport,
  renderConsoleSummary,
  renderMarkdownReport,
  verifyEvidenceDigest,
  writeJsonReport,
  writeTextFile,
} from "../src/report.js";
import { runSuite } from "../src/runner.js";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "../..");
const suitePath = resolve(projectRoot, "examples/refunds/suite.json");
const artifactRoot = resolve(projectRoot, ".agentci/demo");

const baseline = await runSuite({
  suitePath,
  releaseManifestPath: resolve(
    projectRoot,
    "examples/refunds/releases/agent-v1.release.json",
  ),
});
const candidate = await runSuite({
  suitePath,
  releaseManifestPath: resolve(
    projectRoot,
    "examples/refunds/releases/agent-v2.release.json",
  ),
});
const comparison = compareReports(baseline, candidate);
const counter = await runSuite({
  suitePath: resolve(projectRoot, "examples/counter/suite.json"),
  releaseManifestPath: resolve(
    projectRoot,
    "examples/counter/releases/agent.release.json",
  ),
  adapterManifestPath: resolve(
    projectRoot,
    "examples/counter/adapter.manifest.json",
  ),
});

await writeJsonReport(resolve(artifactRoot, "agent-v1.json"), baseline);
await writeJsonReport(resolve(artifactRoot, "agent-v2.json"), candidate);
await writeJsonReport(resolve(artifactRoot, "counter-manifest.json"), counter);
await writeTextFile(
  resolve(artifactRoot, "agent-v1.md"),
  renderMarkdownReport(baseline),
);
await writeTextFile(
  resolve(artifactRoot, "agent-v2.md"),
  renderMarkdownReport(candidate),
);
await writeTextFile(
  resolve(artifactRoot, "counter-manifest.md"),
  renderMarkdownReport(counter),
);

process.stdout.write(
  [
    "OutcomeGate deterministic demo",
    "",
    renderConsoleSummary(baseline),
    "",
    renderConsoleSummary(candidate),
    "",
    renderComparison(comparison),
    "",
    "Manifest-backed external adapter",
    renderConsoleSummary(counter),
    "",
    `artifacts ${artifactRoot}`,
    "",
  ].join("\n"),
);

if (baseline.decision.verdict !== "pass") {
  throw new Error("known-good release did not pass");
}
if (candidate.decision.verdict !== "block") {
  throw new Error("planted regression was not blocked");
}
if (!comparison.regressed.includes("timeout-after-commit")) {
  throw new Error("comparison did not identify the planted regression");
}
if (
  counter.decision.verdict !== "pass" ||
  counter.schemaVersion !== "agentci.report.v3" ||
  counter.release.digestScope !== "declared-config-and-bundle-bytes" ||
  counter.adapter.source !== "external-manifest" ||
  counter.adapter.digestScope !==
    "declared-config-and-adapter-bundle-bytes" ||
  !isReleaseReport(counter) ||
  !verifyEvidenceDigest(counter)
) {
  throw new Error("manifest-backed counter release did not produce valid passing evidence");
}
const baselineTimeout = baseline.scenarios.find(
  (scenario) => scenario.scenarioId === "timeout-after-commit",
);
const candidateTimeout = candidate.scenarios.find(
  (scenario) => scenario.scenarioId === "timeout-after-commit",
);
if (baselineTimeout === undefined || candidateTimeout === undefined) {
  throw new Error("timeout-after-commit evidence is missing");
}
const failedIds = candidateTimeout.assertions
  .filter((assertion) => !assertion.passed)
  .map((assertion) => assertion.id);
if (
  failedIds.length !== 1 ||
  failedIds[0] !== "one-refund-after-ambiguous-timeout"
) {
  throw new Error(`unexpected candidate failure: ${failedIds.join(", ")}`);
}
const baselineCreates = baselineTimeout.events.filter(
  (event) => event.tool === "refunds.create",
);
const candidateCreates = candidateTimeout.events.filter(
  (event) => event.tool === "refunds.create",
);
if (
  baselineCreates.length !== 2 ||
  baselineCreates[0]?.outcome !== "error" ||
  baselineCreates[0].committed !== true ||
  baselineCreates[1]?.committed !== false ||
  candidateCreates.length !== 2 ||
  candidateCreates[0]?.outcome !== "error" ||
  candidateCreates[0].committed !== true ||
  candidateCreates[1]?.committed !== true
) {
  throw new Error("the demo did not exercise the intended ambiguous-commit semantics");
}
const baselineRetryKey = (
  baselineCreates[1]?.arguments as Record<string, unknown> | undefined
)?.idempotencyKey;
const candidateRetryKey = (
  candidateCreates[1]?.arguments as Record<string, unknown> | undefined
)?.idempotencyKey;
if (
  baselineRetryKey !== "ticket-timeout:order-timeout:refund" ||
  candidateRetryKey !== "ticket-timeout:order-timeout:refund:retry"
) {
  throw new Error("the demo did not compare stable and changed idempotency keys");
}
