# Model-compression regression checks

OutcomeGate can act as the final deployment-equivalence gate after model
compression, distillation, or quantization. It answers a bounded question:
does the optimized release still satisfy the same declared workflow contracts?
It does not replace general model benchmarks, statistical quality analysis, or
hardware performance measurement.

## Run the included comparison

The repository includes a credential-free linear support-ticket router with
captured FP32, INT8, and INT4 model artifacts. The reference uses explicit
float32 rounding; the optimized variants use integer accumulation followed by
their declared dequantization scale:

```bash
npm run demo:model-compression
```

The demo runs the same suite and adapter against all three releases, writes full
reports beneath `.agentci/model-compression/`, and compares each optimized
release with the FP32 reference.

The INT8 model is a positive example: every workflow remains a pass and the
comparison reports no regression. The deliberately aggressive INT4 model is a
negative example: two high-margin workflows remain stable, while the
near-boundary `borderline-billing-refund` workflow changes route and blocks the
comparison. An automated test recomputes both integer artifacts from the FP32
weights and their declared symmetric quantization scales. These small JSON
artifacts make the arithmetic reviewable; they are not packed tensors and do
not demonstrate storage, latency, or memory improvement.

See the complete fixture and expected decisions in
[`examples/model-compression/README.md`](../examples/model-compression/README.md).

## Declare a local model

Release v2 supports a closed local-model declaration:

```json
{
  "model": {
    "kind": "local",
    "identifier": "support-ticket-linear-router",
    "revision": "int8-symmetric",
    "format": "outcomegate.linear-router.v1",
    "artifacts": ["model.json"],
    "configuration": {
      "precision": "int8",
      "quantization": {
        "scheme": "symmetric-per-tensor",
        "scale": 0.0125,
        "zeroPoint": 0
      }
    }
  }
}
```

Artifact paths must be unique normalized relative paths inside `bundle.root`.
They cannot overlap the runtime entry, prompts, or tool schemas. The closed
bundle captures and verifies every artifact before and after each scenario.
Only remote model declarations may request a candidate credential grant.

## Compare a reference and candidate

Keep the suite, adapter, evaluator build, and execution runtime fixed. Run the
reference and optimized manifests to produce full reports, then compare them:

```bash
node dist/src/cli.js check \
  --suite path/to/suite.json \
  --manifest path/to/reference.release.json \
  --adapter-manifest path/to/adapter.manifest.json \
  --report .agentci/reference.json

node dist/src/cli.js check \
  --suite path/to/suite.json \
  --manifest path/to/optimized.release.json \
  --adapter-manifest path/to/adapter.manifest.json \
  --report .agentci/optimized.json

node dist/src/cli.js compare \
  --baseline .agentci/reference.json \
  --candidate .agentci/optimized.json
```

Before attributing a difference to model optimization, verify that the reports'
`entryFileDigest`, `promptDigest`, `toolSchemaDigest`, and `harnessDigest` values
match. The generic `compare` command detects outcome regressions but does not
enforce that attribution boundary; a changed wrapper, prompt, or tool schema can
otherwise confound the result. The included demo and test enforce these four
equalities.

Prefer final state, structured output, and tool-use assertions over exact prose
matching. A reference `PASS` that becomes `BLOCK` or `INDETERMINATE` is reported
as a regressed scenario.

## Current boundary

- Each scenario is one deterministic trial; there is no seed matrix or
  confidence interval yet.
- Assertions do not yet express numeric tolerance, latency, memory, throughput,
  token cost, or aggregate quality deltas.
- Local artifacts share the 1,000-file and 20 MiB bundle limits.
- Evidence binds the declared and captured bytes but cannot prove candidate code
  actually used them.
- Candidate execution remains Node.js JSONL-v1; another inference runtime needs
  a reviewed Node wrapper.

Future extensions should add numeric regression policies, paired repeated-seed
execution, and content-addressed identities for production-sized model,
tokenizer, inference-engine, and hardware artifacts.
