# Security model and current limitations

OutcomeGate v0.3 is a fail-closed release evaluator for synthetic, structured-agent
workflows. It captures declared release and adapter bytes, runs scenarios,
records tool/state evidence, and emits a reduced publication report for CI.

It is not a sandbox, a secrets manager, a remote-transaction coordinator, or a
general data-loss prevention system.

## Supported GitHub Action profile

The v0.3 Action supports one profile:

- release manifest: `agentci.release.v2`
- candidate runtime: Node JSONL protocol v1
- candidate credential policy: `kind: "none"`
- adapter: manifest-backed API v2
- adapter credentials: empty
- inputs: synthetic or explicitly approved sanitized files
- outputs: sanitized `agentci.publication.v1` JSON and Markdown

Do not attach secrets or credentials to the workflow, job, or Action step. The
composite Action rejects non-empty `allow-adapter-env`,
`approved-adapter-digest`, `allow-candidate-env`, and
`approved-release-digest` inputs before setting up Node or running the evaluator.
This refusal does not scrub arbitrary ambient variables from every composite
setup process, which is why the caller must keep the whole job credential-free.

Use `permissions: contents: read`, disable checkout credential persistence,
pin this Action and every dependency Action to reviewed full commit SHAs, and
do not use `pull_request_target` to execute pull-request-controlled code.

## Integrity controls

### Declared capture

Release and adapter manifests point to closed bundle roots. OutcomeGate:

- rejects unsafe paths, symlinks, hard links, special files, and unstable
  captures;
- captures every regular file, its mode, size, and SHA-256 digest;
- limits each bundle to 1,000 files and 20 MiB;
- materializes captured bytes in a fresh temporary directory;
- verifies materialized and source identities after execution;
- includes manifest, component, bundle, runtime, adapter, evaluator, and suite
  identities in canonical evidence.

These controls answer which declared bytes were evaluated. They do not prove
that the code is benign or that its dependencies are trustworthy.

### Candidate boundary

The candidate is spawned with the current Node executable, no shell, a captured
entry path, and a fresh explicit environment. Ambient variables are never
copied. In the Action profile, that environment is empty.

The JSONL protocol is strict and bounded by scenario time and call limits.
Known credential values, when using the separately staged local grant path,
are checked at protocol, state, stderr, evidence, and output boundaries. Raw
candidate stderr is never included in reports.

### Adapter boundary

A manifest-backed adapter is materialized from captured bytes and imported in a
separate Node child process. That host has sequenced IPC, one operation in
flight, explicit deadlines and abort signals, exact descriptor matching,
mandatory closure, and post-run identity verification. Its ambient environment
contains only explicitly authorized adapter values; the host removes those
values from `process.env` and provides them through the operation context.

The host records state immediately before and after each transition. This
supports fault injection and state-lineage checks, but it cannot make a remote
service transactional.

## Decision semantics

OutcomeGate distinguishes:

- `PASS`: all scenarios and assertions passed with intact evaluator and adapter
  integrity;
- `BLOCK`: an attributable candidate defect was established;
- `INDETERMINATE`: a trustworthy attribution could not be made.

Adapter crashes, invalid state lineage, cleanup failures, identity changes, and
a timeout during an active transition are indeterminate unless an independent
candidate block was already established. Consumers must fail closed on both
exit `1` and exit `2`; they should not reinterpret indeterminate as pass.

## Publication boundary

The Action creates a full in-memory `agentci.report.v3`, derives a closed
`agentci.publication.v1` projection, and writes only that projection to the
configured repository paths and job summary. It does not upload canonical
evidence or a workflow artifact.

The publication contains:

- suite, release, adapter, evaluator, source-evidence, and publication digests;
- per-scenario ordinal, verdict, assertion counts, tool-call count, and stderr
  byte/truncation metadata;
- aggregate decision counts and pass rate;
- an explicit omissions list and recommended retention of seven days.

It omits logical identifiers, descriptions, tasks, initial and final state,
tool events and their arguments/results, candidate output, assertion details,
reasons, manifests, file inventories, local paths, timing, raw stderr, and the
candidate-stderr digest.

Static secret-pattern checks run across declared artifacts and rendered output.
Exact authorized credential values receive additional boundary checks in the
local grant path. These checks reduce accidental disclosure; they cannot
identify every sensitive value or semantic disclosure. Review synthetic data
and publication output before enabling a check on an untrusted pull request.

The repository release audits have the same limitation: path, history, binary,
email, credential-shape, and sensitive-phrase policies reduce accidental
publication but cannot prove that innocuously named prose is non-sensitive.
Initial publication and every later release require a human review of the
complete clean-clone tree inventory and candidate diff, with its commit and
manifest digest recorded outside this repository.

The seven-day value in the publication is a recommendation, not automatic
deletion. The repository owner must configure retention and remove every copy,
including job summaries or any artifacts added outside this Action.

## Code-execution limitations

Candidate and adapter bundles are executable code. Process separation and an
empty environment do not provide hostile-code isolation. Candidate, evaluator,
and adapter processes run under the same runner OS account and may have the
runner's filesystem and network capabilities. A malicious bundle can attempt
to read workspace files, consume resources, open network connections, or
interfere with sibling processes.

Therefore:

- run only reviewed candidate and adapter code;
- use disposable GitHub-hosted runners for pull-request evaluation;
- do not place secrets, production datasets, or writable production endpoints
  on the runner;
- avoid self-hosted runners unless a separate containment review establishes
  an adequate boundary;
- keep suite inputs synthetic and minimal;
- treat third-party package installation and arbitrary bundle imports as code
  execution.

The evaluator sends termination signals and the adapter context exposes an
abort signal. Termination cannot prove that a remote mutation was cancelled or
rolled back. Remote adapters need bounded requests, idempotency keys,
reconciliation, and independent service-side controls. If a deadline expires
during a transition, OutcomeGate reports indeterminate rather than claiming
rollback.

## Current product limitations

- GitHub Action evaluation is credential-free only.
- Candidate execution is Node.js JSONL-v1; other languages need a Node wrapper.
- Adapter execution is Node ESM API v2.
- The schemas are informative; runtime parsers are authoritative.
- The Action runs the committed prebuilt `dist/src` runtime; the CLI is not
  published to npm in v0.3.
- The Action publishes counts and digests, not full evidence or diagnostic
  detail.
- Static scanning is not complete DLP.
- Same-account processes are not hostile-code isolation.
- Remote cancellation and rollback cannot be proven by the evaluator.
- Passing demonstrates the declared synthetic scenarios, not correctness for
  undeclared behavior or production traffic.
- A release-v2 local-model declaration binds captured artifact paths, bytes,
  modes, and metadata into release evidence. It does not prove that candidate
  code used those artifacts, that a format or optimization claim is truthful,
  or that undeclared accelerator, kernel, driver, and hardware state was fixed.
- Local model artifacts remain subject to the 20 MiB closed-bundle limit. Larger
  model formats need a future streamed, content-addressed design rather than an
  expanded in-memory trust boundary.

For the supported workflow, start with [Quickstart](QUICKSTART.md). For a fixed
diagnostic sequence, see [Troubleshooting](TROUBLESHOOTING.md).
