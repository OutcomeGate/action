# Troubleshooting Agent CI v0.3

Start locally, without `--github`, so configuration errors are rendered when
they pass the static secret scanner. The GitHub Action intentionally replaces
detailed failures with a fixed `INDETERMINATE` message at its publication
boundary.

## Recommended debug sequence

Build once:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run build --silent
```

Then run the narrowest checks in this order:

```bash
node dist/src/cli.js validate-release \
  --manifest path/to/agent.release.json

node dist/src/cli.js validate-adapter \
  --manifest path/to/adapter.manifest.json

node dist/src/cli.js adapter-check \
  --adapter-manifest path/to/adapter.manifest.json

node dist/src/cli.js validate \
  --suite path/to/suite.json \
  --adapter-manifest path/to/adapter.manifest.json

node dist/src/cli.js check \
  --suite path/to/suite.json \
  --manifest path/to/agent.release.json \
  --adapter-manifest path/to/adapter.manifest.json \
  --report .agentci/full-report.json \
  --markdown .agentci/full-report.md \
  --require-explicit-candidate-policy
```

The final two outputs are canonical local evidence. They can include logical
scenario names and descriptions, candidate output, tool arguments and results,
assertion expected/observed values, reasons, manifests, file inventories,
local paths, state hashes, and timing. Keep them protected. Once the behavior
is understood, switch to `--publication-report` and
`--publication-markdown` for the reduced publication projection used by the
Action.

## Exit statuses

| Status | Meaning | First question |
|---:|---|---|
| `0` | Pass | Do the assertions actually cover the intended failure modes? |
| `1` | Block | Which scenario reason, event, or assertion establishes the candidate defect? |
| `2` | Indeterminate/configuration error | Did capture, adapter validation, execution integrity, cleanup, or commit attribution fail? |

Do not convert exit `2` to a pass. It means the evaluator could not establish
a trustworthy release decision.

## Common failures

### `release manifest` or `adapter manifest` validation fails

- Confirm the JSON has no duplicate object members.
- Remove unknown fields; all manifest objects are closed.
- Use normalized relative POSIX paths with no absolute path, backslash, `.`,
  `..`, empty segment, or traversal.
- Resolve `bundle.root` relative to its manifest, then resolve entry and
  component paths inside that bundle.
- Remove symlinks, hard links, special files, and empty nested directories.
- Keep the bundle at or below 1,000 files and 20 MiB.
- For the Action, use release v2 with
  `candidate.credentials.kind: "none"` and an adapter with an empty credential
  environment list.

Run `validate-release` or `validate-adapter` again before executing code.

### `adapter-check` fails

Inspect its conformance case and verify:

- the manifest and module have identical `apiVersion`, `id`, `version`, and
  ordered tool list;
- `createEnvironment` returns exactly `tools`, `call`, `snapshot`, and `close`;
- a fresh environment preserves `initialState`;
- `snapshot` returns a deep clone rather than internal mutable state;
- two environments do not share state;
- the declared call result and final state are exact JSON matches;
- repeating the case in a fresh environment is deterministic;
- every asynchronous operation honors `context.signal` and closes cleanly.

An ordinary tool-level failure must be thrown as
`{ agentciToolError: true, code, message }`. Other thrown values are treated as
adapter-host failures.

### Suite validation reports an unexposed tool

The suite's `fixture` must equal the adapter manifest `id`. Every tool named by
a fault, `event_count`, or `event_order` assertion must appear in
`contract.tools`, in the module descriptor, and in the environment's exact
ordered `tools` list.

### Suite validation rejects a state pointer

The adapter's `validateStatePointer` rejected it. Check RFC 6901 escaping,
array indexes, and the scenario's initial-state shape. A JSON pointer must begin
with `/`. An `absent` assertion is allowed for adapter state but not for untyped
candidate output.

### Candidate wrote non-JSON data to stdout

Reserve stdout exclusively for one JSON message per line. Move logs to stderr.
Also check for:

- pretty-printed multi-line JSON;
- a startup banner from a framework;
- duplicate JSON object fields;
- `NaN`, `Infinity`, `undefined`, class instances, or other non-JSON values;
- concurrent writes that interleave two frames.

Use the minimal
[`candidate.mjs`](../examples/counter/releases/agent.bundle/candidate.mjs) or
the reusable pattern in
[`driver.mjs`](../examples/refunds/releases/agent-v1.bundle/driver.mjs) as a
reference.

### Candidate exited before `done` or exited nonzero

Catch candidate errors, put a safe diagnostic on stderr, settle or reject every
pending tool call, send exactly one JSON `done` output, and then close stdin
handling cleanly. A second `done`, a call after `done`, or a reused request ID
also blocks.

### Candidate exceeded the call budget

Increase `maxToolCalls` only when the extra calls are intended and asserted.
Otherwise inspect retry logic or an agent loop. Error calls and injected faults
still consume the budget.

### Timeout is `BLOCK`

The deadline expired while no adapter transition was active, so the evaluator
attributed the failure to the candidate. Reduce work, make the candidate stop
cleanly, or increase the scenario's positive `timeoutMs` after measuring a
deterministic upper bound.

### Timeout is `INDETERMINATE`

The deadline expired during an active adapter transition, or adapter/tool work
did not settle. The evaluator cannot prove whether a mutation committed. Make
the adapter honor abort signals, bound its own I/O, use idempotent operations,
and add reconciliation behavior. Increasing a timeout does not by itself solve
unknown commit state.

### Action returns only a generic `INDETERMINATE`

Reproduce with the local `check` command above and omit `--github`. Check that:

- all three input paths are repository-relative and outside `.agentci/`;
- report and Markdown paths are different files beneath `.agentci/`;
- no path traverses a symlink outside the workspace;
- the four reserved credential inputs are empty;
- no secret was attached to the workflow, job, or Action step.

The Action withholds details because the failing text itself can contain
sensitive material.

### A static secret scan rejects synthetic text

Remove or regenerate the flagged token-like text rather than weakening the
scanner. The scanner is intentionally conservative at suite, manifest, bundle,
console, and publication boundaries. It is defense in depth, not proof that
arbitrary content is non-sensitive.

### The Action passes but `.agentci` is not in artifacts

That is expected. v0.3 writes sanitized JSON and Markdown files and appends the
Markdown to the job summary, but it does not upload artifacts. Add retention or
artifact handling only after reviewing the data boundary in
[Security model](SECURITY-MODEL.md).

## Compare two local reports

`compare` accepts full `agentci.report.v3` JSON reports, not publication-v1
projections:

```bash
node dist/src/cli.js compare \
  --baseline .agentci/baseline-full.json \
  --candidate .agentci/candidate-full.json
```

Both reports must have valid evidence digests and matching suite digest,
evaluator build, adapter identity and runtime, execution runtime, and scenario
IDs. Otherwise comparison is indeterminate. A candidate that fails its
absolute suite gate remains blocked even if another scenario was fixed.
