# OutcomeGate v0.3 quickstart

OutcomeGate v0.3 runs declared, synthetic scenarios against a structured,
tool-using Node.js candidate. The supported GitHub Action path is deliberately
credential-free: the release, adapter, suite, and workflow must not require or
receive secrets.

This guide uses the repository's self-contained counter example. For the data
and process boundary, read [Security model](SECURITY-MODEL.md) before adapting
the example to another workflow.

## 1. Verify the source

Prerequisites:

- Node.js 24.11.0 or newer
- npm

From the repository root:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run verify
```

`npm run verify` type-checks the source, builds it, runs the automated tests,
and executes the synthetic demonstrations. It does not require a model,
service, or customer credential.

The CLI is not published to npm, so commands in this guide use the checkout's
locally built entry point:

```bash
npm run build --silent
node dist/src/cli.js --help
```

## 2. Validate each declaration

Validate the captured candidate release:

```bash
node dist/src/cli.js validate-release \
  --manifest examples/counter/releases/agent.release.json
```

Validate the captured adapter declaration without executing it:

```bash
node dist/src/cli.js validate-adapter \
  --manifest examples/counter/adapter.manifest.json
```

Execute the adapter's deterministic conformance case:

```bash
node dist/src/cli.js adapter-check \
  --adapter-manifest examples/counter/adapter.manifest.json
```

Validate the suite against the adapter's tool and state contract:

```bash
node dist/src/cli.js validate \
  --suite examples/counter/suite.json \
  --adapter-manifest examples/counter/adapter.manifest.json
```

These commands separate capture, adapter execution, and suite-contract errors,
which makes a failed check easier to diagnose.

## 3. Run the credential-free gate locally

```bash
node dist/src/cli.js check \
  --suite examples/counter/suite.json \
  --manifest examples/counter/releases/agent.release.json \
  --adapter-manifest examples/counter/adapter.manifest.json \
  --publication-report .agentci/report.json \
  --publication-markdown .agentci/report.md \
  --require-explicit-candidate-policy
```

The example should print a sanitized `PASS` summary and exit with status `0`.
The two files beneath `.agentci/` contain the reduced
`agentci.publication.v1` projection. They omit task and state content, tool
arguments and results, scenario identifiers and descriptions, detailed
reasons, local paths, manifests, inventories, timings, and raw candidate
stderr.

For protected local debugging, replace the two `--publication-*` options with:

```text
--report .agentci/full-report.json --markdown .agentci/full-report.md
```

Those files contain canonical report-v3 evidence, including scenario and tool
details. Do not publish them by default.

## 4. Run the same gate in GitHub Actions

Commit the suite, release bundle, adapter bundle, and their manifests to the
repository being checked. Then add a workflow like this:

```yaml
name: OutcomeGate

on:
  pull_request:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  release-gate:
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with:
          persist-credentials: false

      - uses: OutcomeGate/action@57d24565c8953f4a4c7635825dd7915a73a2a85a
        with:
          suite: examples/counter/suite.json
          manifest: examples/counter/releases/agent.release.json
          adapter-manifest: examples/counter/adapter.manifest.json
```

This Developer Preview pin is the accepted runtime commit. Review it before use
and replace it only with a later accepted full commit SHA. The Action validates
its credential-free profile, sets up Node.js 24 LTS, and runs the committed
prebuilt runtime. It does not run `npm install` or build the project in the
caller. It writes `.agentci/report.json` and `.agentci/report.md`, appends the
sanitized Markdown to the job summary, and does not upload an artifact.

The Action accepts custom `report` and `markdown` paths only when they are
distinct repository-relative files beneath `.agentci/`. Suite and manifest
inputs must be repository-relative paths outside that reserved output tree.

Do not set secrets at the workflow, job, or Action-step level. Do not use
`pull_request_target` to execute pull-request-controlled candidate or adapter
code. The v0.3 Action rejects every non-empty candidate- or adapter-credential
input.

## 5. Generate an independent starter

Keep the generated project outside the OutcomeGate source checkout. Set
`OUTCOMEGATE_CLI` to the absolute path of the built CLI, then run:

```bash
OUTCOMEGATE_CLI=/absolute/path/to/action/dist/src/cli.js
cd /path/to/a/scratch-parent
node "$OUTCOMEGATE_CLI" init outcomegate-starter
cd outcomegate-starter
node "$OUTCOMEGATE_CLI" validate-release --manifest agentci/release.manifest.json
node "$OUTCOMEGATE_CLI" validate-adapter --manifest agentci/adapter.manifest.json
node "$OUTCOMEGATE_CLI" adapter-check --adapter-manifest agentci/adapter.manifest.json
node "$OUTCOMEGATE_CLI" validate --suite agentci/suite.json --adapter-manifest agentci/adapter.manifest.json
node "$OUTCOMEGATE_CLI" check \
  --suite agentci/suite.json \
  --manifest agentci/release.manifest.json \
  --adapter-manifest agentci/adapter.manifest.json \
  --require-explicit-candidate-policy
```

The final command should report `PASS`. `init` refuses to overwrite an existing
path. The starter includes a credential-free candidate, adapter, suite, release
manifest, and workflow. Its workflow pins the accepted Developer Preview
runtime SHA; review it before enabling the workflow.

After npm publication, or when the package is linked locally, the equivalent
commands can use `outcomegate` directly instead of `node "$OUTCOMEGATE_CLI"`.

## 6. Adapt the counter example

The generated starter is the shortest path to an independent project. You can
also copy and change these three declarations directly from this repository:

1. Candidate release: start from
   [`examples/counter/releases/agent.release.json`](../examples/counter/releases/agent.release.json)
   and its `agent.bundle/`. Implement the JSONL-v1 contract described in
   [Candidate protocol](CANDIDATE-PROTOCOL.md).
2. Adapter: start from
   [`examples/counter/adapter.manifest.json`](../examples/counter/adapter.manifest.json)
   and its `adapter.bundle/`. Implement the isolated API-v2 contract described
   in [Adapter SDK](ADAPTER-SDK.md).
3. Suite: start from
   [`examples/counter/suite.json`](../examples/counter/suite.json). Declare
   normal, fault, omission, and timeout-sensitive behavior as appropriate for
   the synthetic state machine. See [Suites](SUITES.md).

Keep the first integration deterministic and credential-free. Run the four
validation commands before `check`, then add the GitHub workflow in
non-required shadow mode. Promote it to a required check only after the suite's
expected decisions and failure classifications have been reviewed.

## Exit status

| Status | Decision | Meaning |
|---:|---|---|
| `0` | `PASS` | Every scenario passed and the absolute suite gate passed. |
| `1` | `BLOCK` | A candidate defect or failed assertion was established. |
| `2` | `INDETERMINATE` | Configuration, adapter integrity, execution integrity, or uncertain commit state prevented a trustworthy decision. |

See [Troubleshooting](TROUBLESHOOTING.md) for a local diagnosis sequence.
