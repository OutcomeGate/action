# Local model-compression comparison

This credential-free example compares one captured FP32 support-ticket router
with correctly derived INT8 and INT4 symmetric quantizations. The reference
uses explicit float32 rounding; the integer models use integer accumulation and
their declared dequantization scale. It demonstrates deployment-equivalence
gating, not a general language-model benchmark or a latency, memory, or quality
claim.

Run it from the repository root:

```bash
npm run demo:model-compression
```

The suite holds the evaluator, adapter, tasks, and assertions constant:

| Scenario | FP32 | INT8 | INT4 |
|---|---|---|---|
| `urgent-service-ticket` | escalate | escalate | escalate |
| `borderline-billing-refund` | escalate | escalate | auto-resolve |
| `routine-duplicate` | auto-resolve | auto-resolve | auto-resolve |

The FP32-to-INT8 comparison passes with all three workflows unchanged. The
FP32-to-INT4 comparison blocks: `borderline-billing-refund` regresses while the
two high-margin workflows remain stable.

The model artifacts contain the actual stored values. The automated test
recomputes both integer models from the FP32 artifact using each declared scale,
rounding, signed bit range, and zero point. This prevents the negative fixture
from being an unrelated planted implementation disguised as quantization. The
small JSON artifacts are intentionally reviewable rather than packed tensors;
the example makes no storage, latency, or memory-improvement claim.

All model artifacts are listed by the release-v2 `model.kind: "local"`
declaration. Their paths and optimization metadata contribute to the model and
manifest declarations; their exact bytes, modes, and paths contribute to the
closed release-bundle and release digests. OutcomeGate establishes which bytes
were evaluated, but it does not prove that an arbitrary candidate truly used
every declared artifact.
