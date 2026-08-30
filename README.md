# Agent CI Action

Agent CI is a credential-free GitHub Action and local CLI for deterministic
release checks of structured, tool-using agents. It runs synthetic declared
scenarios, checks final state and ordered tool evidence, and returns one of
three outcomes:

- `0` — pass
- `1` — block
- `2` — indeterminate or invalid configuration

## Verify the source

Node.js 20 or newer is required.

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run verify
```

The verification suite is offline and uses synthetic fixtures. It does not
require model, service, or customer credentials.

## Use the Action

Pin the Action to a reviewed full 40-character commit SHA:

```yaml
name: agent-ci

on:
  pull_request:

permissions:
  contents: read

jobs:
  release-gate:
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
        with:
          persist-credentials: false

      - uses: OWNER/agent-ci-action@FULL_40_CHARACTER_SHA
        with:
          suite: examples/counter/suite.json
          manifest: examples/counter/releases/agent.release.json
          adapter-manifest: examples/counter/adapter.manifest.json
```

The caller owns its suite, release bundle, adapter bundle, and output paths.
The source Action requires a release-v2 manifest and a manifest-backed adapter.

## Security boundary

- Do not attach secrets or credentials to the Action step, job, or workflow.
- Do not use `pull_request_target` to execute pull-request-controlled code.
- Keep checkout credential persistence disabled.
- Use only synthetic or explicitly approved sanitized fixtures.
- Candidate, evaluator, and adapter processes share the runner's OS account;
  this is not hostile-code isolation.
- Static secret-pattern checks are defense in depth, not a complete data-loss
  prevention system.
- Terminating a process cannot prove that a remote mutation was cancelled or
  rolled back.

The Action writes a reduced `agentci.publication.v1` JSON/Markdown derivative
and job summary. It does not upload canonical evidence or workflow artifacts.

## Source layout

- `action.yml` — composite GitHub Action
- `src/` — evaluator, CLI, release capture, adapters, and evidence handling
- `schemas/` — informative JSON schemas; runtime parsers are authoritative
- `examples/` — synthetic release, adapter, and suite fixtures
- `test/` — unit, adversarial, and end-to-end tests
