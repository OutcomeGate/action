import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  computeEvidenceDigest,
  computePublicationDigest,
  createSanitizedPublicationReport,
  isSanitizedPublicationReport,
  renderSanitizedPublicationMarkdown,
  verifyPublicationDigest,
} from "../src/report.js";
import { runSuite } from "../src/runner.js";
import type { ReleaseReport } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "../..");

async function reportWithSensitiveDetails(): Promise<ReleaseReport> {
  const report = await runSuite({
    suitePath: resolve(projectRoot, "examples/refunds/suite.json"),
    releaseManifestPath: resolve(
      projectRoot,
      "examples/refunds/releases/agent-v2.release.json",
    ),
    generatedAt: "2026-08-29T12:00:00.000Z",
  });
  const sensitive = "customer-sensitive-literal-never-publish";
  const scenario = report.scenarios.find(
    (candidate) => candidate.verdict === "block",
  )!;
  scenario.description = sensitive;
  scenario.reasons.push(sensitive);
  scenario.output = { sensitive };
  scenario.events[0]!.arguments = { sensitive };
  if (scenario.events[0]!.content !== undefined) {
    scenario.events[0]!.content = { sensitive };
  }
  scenario.assertions[0]!.message = sensitive;
  scenario.assertions[0]!.expected = sensitive;
  scenario.assertions[0]!.observed = sensitive;
  const { evidenceDigest: _evidenceDigest, ...withoutDigest } = report;
  report.evidenceDigest = computeEvidenceDigest(withoutDigest);
  return report;
}

test("sanitized publication binds validated stable evidence while omitting sensitive details and identifiers", async () => {
  const report = await reportWithSensitiveDetails();
  const publication = createSanitizedPublicationReport(report);
  const serialized = JSON.stringify(publication);
  const markdown = renderSanitizedPublicationMarkdown(publication);

  assert.equal(publication.sourceEvidenceDigest, report.evidenceDigest);
  assert.equal(publication.profile, "sanitized");
  assert.equal(publication.publication.recommendedRetentionDays, 7);
  assert.equal(publication.publication.fullEvidencePublished, false);
  assert.equal(publication.publication.rawCandidateStderrPublished, false);
  assert.equal(isSanitizedPublicationReport(publication), true);
  assert.equal(verifyPublicationDigest(publication), true);
  assert.doesNotMatch(serialized, /customer-sensitive-literal-never-publish/);
  assert.doesNotMatch(markdown, /customer-sensitive-literal-never-publish/);
  assert.doesNotMatch(serialized, new RegExp(report.scenarios[0]!.candidateDiagnostics.stderrDigest));
  assert.doesNotMatch(serialized, /candidatePath|manifestPath|initialStateHash|finalStateHash/);
  assert.equal(serialized.includes(report.generatedAt), false);
  assert.equal(serialized.includes(report.suite.name), false);
  assert.equal(serialized.includes(report.release.name), false);
  assert.equal(serialized.includes(report.adapter.id), false);
  assert.equal(serialized.includes(report.scenarios[0]!.scenarioId), false);
});

test("sanitized publication detects source and publication tampering", async () => {
  const report = await reportWithSensitiveDetails();
  report.decision.total += 1;
  assert.throws(
    () => createSanitizedPublicationReport(report),
    /source report is invalid|evidence digest/,
  );

  const fresh = await reportWithSensitiveDetails();
  const publication = createSanitizedPublicationReport(fresh);
  publication.scenarios[0]!.toolCallCount += 1;
  assert.equal(verifyPublicationDigest(publication), false);
  assert.throws(
    () => renderSanitizedPublicationMarkdown(publication),
    /publication is invalid|digest/,
  );

  const invalidSource = await reportWithSensitiveDetails();
  (invalidSource.scenarios[0] as unknown as Record<string, unknown>).unsupported =
    "extension";
  const { evidenceDigest: _oldDigest, ...invalidWithoutDigest } = invalidSource;
  invalidSource.evidenceDigest = computeEvidenceDigest(invalidWithoutDigest);
  assert.throws(
    () => createSanitizedPublicationReport(invalidSource),
    /source report is invalid/,
  );

  const validSource = await reportWithSensitiveDetails();
  const extended = structuredClone(
    createSanitizedPublicationReport(validSource),
  ) as unknown as Record<string, unknown>;
  delete extended.publicationDigest;
  extended.unsupported = "extension";
  extended.publicationDigest = computePublicationDigest(
    extended as unknown as Omit<
      ReturnType<typeof createSanitizedPublicationReport>,
      "publicationDigest"
    >,
  );
  assert.equal(isSanitizedPublicationReport(extended), false);
  assert.throws(
    () =>
      renderSanitizedPublicationMarkdown(
        extended as unknown as ReturnType<
          typeof createSanitizedPublicationReport
        >,
      ),
    /publication is invalid/,
  );

  const forgedVerdict = structuredClone(
    createSanitizedPublicationReport(validSource),
  );
  forgedVerdict.decision.verdict = "pass";
  const { publicationDigest: _forgedDigest, ...forgedWithoutDigest } =
    forgedVerdict;
  forgedVerdict.publicationDigest = computePublicationDigest(forgedWithoutDigest);
  assert.equal(isSanitizedPublicationReport(forgedVerdict), false);
  assert.throws(
    () => renderSanitizedPublicationMarkdown(forgedVerdict),
    /publication is invalid/,
  );

  const forgedTruncation = structuredClone(
    createSanitizedPublicationReport(validSource),
  );
  forgedTruncation.scenarios[0]!.candidateStderrTruncated =
    !forgedTruncation.scenarios[0]!.candidateStderrTruncated;
  const { publicationDigest: _truncationDigest, ...truncationWithoutDigest } =
    forgedTruncation;
  forgedTruncation.publicationDigest = computePublicationDigest(
    truncationWithoutDigest,
  );
  assert.equal(isSanitizedPublicationReport(forgedTruncation), false);

  const unsafeCounter = structuredClone(
    createSanitizedPublicationReport(validSource),
  );
  unsafeCounter.scenarios[0]!.toolCallCount = 1e100;
  const { publicationDigest: _counterDigest, ...counterWithoutDigest } =
    unsafeCounter;
  unsafeCounter.publicationDigest = computePublicationDigest(
    counterWithoutDigest,
  );
  assert.equal(verifyPublicationDigest(unsafeCounter), true);
  assert.equal(isSanitizedPublicationReport(unsafeCounter), false);
});
