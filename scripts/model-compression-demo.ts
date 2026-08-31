import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { compareReports, renderComparison } from "../src/comparison.js";
import {
  renderConsoleSummary,
  verifyEvidenceDigest,
  writeJsonReport,
  writeTextFile,
} from "../src/report.js";
import { runSuite } from "../src/runner.js";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "../..");
const exampleRoot = resolve(projectRoot, "examples/model-compression");
const artifactRoot = resolve(projectRoot, ".agentci/model-compression");
const suitePath = resolve(exampleRoot, "suite.json");
const adapterManifestPath = resolve(exampleRoot, "adapter.manifest.json");

const runModel = (name: string) =>
  runSuite({
    suitePath,
    releaseManifestPath: resolve(
      exampleRoot,
      `releases/router-${name}.release.json`,
    ),
    adapterManifestPath,
  });
const full = await runModel("fp32");
const int8 = await runModel("int8");
const int4 = await runModel("int4");
const stableComparison = compareReports(full, int8);
const regressedComparison = compareReports(full, int4);
const fixedReleaseComponents = (() => {
  if (full.release.digestScope !== "declared-config-and-bundle-bytes") {
    return false;
  }
  const reference = full.release;
  return [int8.release, int4.release].every(
    (candidate) =>
      candidate.digestScope === "declared-config-and-bundle-bytes" &&
      candidate.entryFileDigest === reference.entryFileDigest &&
      candidate.promptDigest === reference.promptDigest &&
      candidate.toolSchemaDigest === reference.toolSchemaDigest &&
      candidate.harnessDigest === reference.harnessDigest,
  );
})();

await Promise.all([
  writeJsonReport(resolve(artifactRoot, "router-fp32.json"), full),
  writeJsonReport(resolve(artifactRoot, "router-int8.json"), int8),
  writeJsonReport(resolve(artifactRoot, "router-int4.json"), int4),
  writeTextFile(
    resolve(artifactRoot, "fp32-vs-int8.json"),
    `${JSON.stringify(stableComparison, null, 2)}\n`,
  ),
  writeTextFile(
    resolve(artifactRoot, "fp32-vs-int4.json"),
    `${JSON.stringify(regressedComparison, null, 2)}\n`,
  ),
]);

process.stdout.write(
  [
    "OutcomeGate local-model compression demo",
    "",
    "Reference FP32 release",
    renderConsoleSummary(full),
    "",
    "Positive example: FP32 versus INT8",
    renderComparison(stableComparison),
    "",
    "Negative example: FP32 versus INT4",
    renderComparison(regressedComparison),
    "",
    `artifacts ${artifactRoot}`,
    "",
  ].join("\n"),
);

if (
  full.decision.verdict !== "pass" ||
  int8.decision.verdict !== "pass" ||
  int4.decision.verdict !== "block" ||
  stableComparison.verdict !== "pass" ||
  stableComparison.regressed.length !== 0 ||
  regressedComparison.verdict !== "block" ||
  regressedComparison.regressed.length !== 1 ||
  regressedComparison.regressed[0] !== "borderline-billing-refund" ||
  !regressedComparison.unchangedPass.includes("urgent-service-ticket") ||
  !regressedComparison.unchangedPass.includes("routine-duplicate") ||
  !fixedReleaseComponents ||
  ![full, int8, int4].every(verifyEvidenceDigest)
) {
  throw new Error("model-compression demo did not produce the expected evidence");
}
