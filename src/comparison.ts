import type {
  ComparisonReport,
  ReleaseReport,
  ScenarioResult,
  Verdict,
} from "./types.js";
import { isReleaseReport, verifyEvidenceDigest } from "./report.js";

function statusMap(report: ReleaseReport): Map<string, ScenarioResult["verdict"]> {
  return new Map(
    report.scenarios.map((scenario) => [scenario.scenarioId, scenario.verdict]),
  );
}

export function compareReports(
  baseline: ReleaseReport,
  candidate: ReleaseReport,
): ComparisonReport {
  const fixed: string[] = [];
  const regressed: string[] = [];
  const unchangedPass: string[] = [];
  const unchangedBlock: string[] = [];
  const reasons: string[] = [];

  if (!isReleaseReport(baseline) || !isReleaseReport(candidate)) {
    return {
      schemaVersion: "agentci.comparison.v1",
      baselineEvidenceDigest: baseline.evidenceDigest,
      candidateEvidenceDigest: candidate.evidenceDigest,
      suiteDigest: candidate.suite.digest,
      verdict: "indeterminate",
      reasons: ["a report does not satisfy the agentci.report.v3 structure"],
      fixed,
      regressed,
      unchangedPass,
      unchangedBlock,
    };
  }

  if (!verifyEvidenceDigest(baseline) || !verifyEvidenceDigest(candidate)) {
    return {
      schemaVersion: "agentci.comparison.v1",
      baselineEvidenceDigest: baseline.evidenceDigest,
      candidateEvidenceDigest: candidate.evidenceDigest,
      suiteDigest: candidate.suite.digest,
      verdict: "indeterminate",
      reasons: ["a report evidence digest does not match its contents"],
      fixed,
      regressed,
      unchangedPass,
      unchangedBlock,
    };
  }

  if (baseline.suite.digest !== candidate.suite.digest) {
    return {
      schemaVersion: "agentci.comparison.v1",
      baselineEvidenceDigest: baseline.evidenceDigest,
      candidateEvidenceDigest: candidate.evidenceDigest,
      suiteDigest: candidate.suite.digest,
      verdict: "indeterminate",
      reasons: ["baseline and candidate reports use different suite digests"],
      fixed,
      regressed,
      unchangedPass,
      unchangedBlock,
    };
  }

  if (baseline.evaluator.buildDigest !== candidate.evaluator.buildDigest) {
    return {
      schemaVersion: "agentci.comparison.v1",
      baselineEvidenceDigest: baseline.evidenceDigest,
      candidateEvidenceDigest: candidate.evidenceDigest,
      suiteDigest: candidate.suite.digest,
      verdict: "indeterminate",
      reasons: ["baseline and candidate reports use different evaluator builds"],
      fixed,
      regressed,
      unchangedPass,
      unchangedBlock,
    };
  }

  if (
    baseline.adapter.apiVersion !== candidate.adapter.apiVersion ||
    baseline.adapter.id !== candidate.adapter.id ||
    baseline.adapter.version !== candidate.adapter.version ||
    baseline.adapter.source !== candidate.adapter.source ||
    baseline.adapter.digestScope !== candidate.adapter.digestScope
  ) {
    return {
      schemaVersion: "agentci.comparison.v1",
      baselineEvidenceDigest: baseline.evidenceDigest,
      candidateEvidenceDigest: candidate.evidenceDigest,
      suiteDigest: candidate.suite.digest,
      verdict: "indeterminate",
      reasons: ["baseline and candidate reports use different adapters"],
      fixed,
      regressed,
      unchangedPass,
      unchangedBlock,
    };
  }

  if (
    baseline.adapter.digestScope === "module-entry-only" &&
    candidate.adapter.digestScope === "module-entry-only" &&
    baseline.adapter.moduleDigest !== candidate.adapter.moduleDigest
  ) {
    return {
      schemaVersion: "agentci.comparison.v1",
      baselineEvidenceDigest: baseline.evidenceDigest,
      candidateEvidenceDigest: candidate.evidenceDigest,
      suiteDigest: candidate.suite.digest,
      verdict: "indeterminate",
      reasons: ["baseline and candidate reports use different adapters"],
      fixed,
      regressed,
      unchangedPass,
      unchangedBlock,
    };
  }

  if (
    baseline.adapter.digestScope ===
      "declared-config-and-adapter-bundle-bytes" &&
    candidate.adapter.digestScope ===
      "declared-config-and-adapter-bundle-bytes" &&
    (baseline.adapter.adapterDigest !== candidate.adapter.adapterDigest ||
      baseline.adapter.execution.nodeVersion !==
        candidate.adapter.execution.nodeVersion ||
      baseline.adapter.execution.platform !==
        candidate.adapter.execution.platform ||
      baseline.adapter.execution.architecture !==
        candidate.adapter.execution.architecture)
  ) {
    return {
      schemaVersion: "agentci.comparison.v1",
      baselineEvidenceDigest: baseline.evidenceDigest,
      candidateEvidenceDigest: candidate.evidenceDigest,
      suiteDigest: candidate.suite.digest,
      verdict: "indeterminate",
      reasons: [
        "baseline and candidate reports use different declared adapters or adapter runtimes",
      ],
      fixed,
      regressed,
      unchangedPass,
      unchangedBlock,
    };
  }

  if (baseline.release.digestScope !== candidate.release.digestScope) {
    return {
      schemaVersion: "agentci.comparison.v1",
      baselineEvidenceDigest: baseline.evidenceDigest,
      candidateEvidenceDigest: candidate.evidenceDigest,
      suiteDigest: candidate.suite.digest,
      verdict: "indeterminate",
      reasons: ["baseline and candidate reports use different release identity scopes"],
      fixed,
      regressed,
      unchangedPass,
      unchangedBlock,
    };
  }

  if (
    baseline.release.digestScope === "declared-config-and-bundle-bytes" &&
    candidate.release.digestScope === "declared-config-and-bundle-bytes" &&
    (baseline.release.execution.nodeVersion !==
      candidate.release.execution.nodeVersion ||
      baseline.release.execution.platform !== candidate.release.execution.platform ||
      baseline.release.execution.architecture !==
        candidate.release.execution.architecture)
  ) {
    return {
      schemaVersion: "agentci.comparison.v1",
      baselineEvidenceDigest: baseline.evidenceDigest,
      candidateEvidenceDigest: candidate.evidenceDigest,
      suiteDigest: candidate.suite.digest,
      verdict: "indeterminate",
      reasons: ["baseline and candidate reports use different execution runtimes"],
      fixed,
      regressed,
      unchangedPass,
      unchangedBlock,
    };
  }

  const baselineStatuses = statusMap(baseline);
  const candidateStatuses = statusMap(candidate);
  if (
    baselineStatuses.size !== candidateStatuses.size ||
    [...baselineStatuses.keys()].some((id) => !candidateStatuses.has(id))
  ) {
    return {
      schemaVersion: "agentci.comparison.v1",
      baselineEvidenceDigest: baseline.evidenceDigest,
      candidateEvidenceDigest: candidate.evidenceDigest,
      suiteDigest: candidate.suite.digest,
      verdict: "indeterminate",
      reasons: ["baseline and candidate reports contain different scenario ids"],
      fixed,
      regressed,
      unchangedPass,
      unchangedBlock,
    };
  }

  for (const [id, baselineVerdict] of baselineStatuses) {
    const candidateVerdict = candidateStatuses.get(id);
    if (baselineVerdict === "pass" && candidateVerdict === "pass") {
      unchangedPass.push(id);
    } else if (baselineVerdict === "pass" && candidateVerdict !== "pass") {
      regressed.push(id);
    } else if (baselineVerdict !== "pass" && candidateVerdict === "pass") {
      fixed.push(id);
    } else {
      unchangedBlock.push(id);
    }
  }

  let verdict: Verdict = candidate.decision.verdict;
  if (
    baseline.decision.verdict === "indeterminate" ||
    candidate.decision.verdict === "indeterminate"
  ) {
    verdict = "indeterminate";
    reasons.push("an aggregate report is indeterminate");
  } else if (regressed.length > 0 || candidate.decision.verdict === "block") {
    verdict = "block";
    if (regressed.length > 0) {
      reasons.push(`regressed scenarios: ${regressed.join(", ")}`);
    }
    if (candidate.decision.verdict === "block") {
      reasons.push("candidate did not meet the absolute suite gate");
    }
  } else {
    verdict = "pass";
    reasons.push("candidate met the suite gate without scenario regressions");
  }

  return {
    schemaVersion: "agentci.comparison.v1",
    baselineEvidenceDigest: baseline.evidenceDigest,
    candidateEvidenceDigest: candidate.evidenceDigest,
    suiteDigest: candidate.suite.digest,
    verdict,
    reasons,
    fixed,
    regressed,
    unchangedPass,
    unchangedBlock,
  };
}

export function renderComparison(comparison: ComparisonReport): string {
  return [
    `${comparison.verdict.toUpperCase()} comparison`,
    `regressed: ${comparison.regressed.length === 0 ? "none" : comparison.regressed.join(", ")}`,
    `fixed: ${comparison.fixed.length === 0 ? "none" : comparison.fixed.join(", ")}`,
    ...comparison.reasons.map((reason) => `reason: ${reason}`),
  ].join("\n");
}
