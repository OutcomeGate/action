import assert from "node:assert/strict";
import test from "node:test";

import { decideGate } from "../src/gate.js";
import type { ScenarioResult, Verdict } from "../src/types.js";

function scenario(id: string, verdict: Verdict): ScenarioResult {
  return {
    scenarioId: id,
    description: id,
    verdict,
    reasons: [],
    initialStateHash: "a".repeat(64),
    finalStateHash: "b".repeat(64),
    events: [],
    assertions: [],
    candidateDiagnostics: {
      stderrDigest:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      stderrBytes: 0,
      stderrTruncated: false,
    },
    durationMs: 0,
  };
}

test("a known block takes precedence over additional indeterminate cases", () => {
  const decision = decideGate(
    [scenario("known-regression", "block"), scenario("unknown", "indeterminate")],
    { minPassRate: 1 },
  );

  assert.equal(decision.verdict, "block");
  assert.equal(decision.blocked, 1);
  assert.equal(decision.indeterminate, 1);
});
