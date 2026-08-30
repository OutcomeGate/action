# Agent CI starter

This is a deterministic, credential-free starter for testing the Agent CI
release gate. It models one synthetic tool, one candidate, and one passing
scenario. No network access, production data, or credentials are required.

## Run locally

Until the package is published, point `AGENTCI_CLI` at the absolute path of a
built Agent CI source checkout:

```sh
AGENTCI_CLI=/absolute/path/to/agent-ci-action/dist/src/cli.js
node "$AGENTCI_CLI" validate-release --manifest agentci/release.manifest.json
node "$AGENTCI_CLI" validate-adapter --manifest agentci/adapter.manifest.json
node "$AGENTCI_CLI" adapter-check --adapter-manifest agentci/adapter.manifest.json
node "$AGENTCI_CLI" validate --suite agentci/suite.json --adapter-manifest agentci/adapter.manifest.json
node "$AGENTCI_CLI" check \
  --suite agentci/suite.json \
  --manifest agentci/release.manifest.json \
  --adapter-manifest agentci/adapter.manifest.json \
  --require-explicit-candidate-policy
```

The final command should report `PASS starter-agent-v1`. If `agentci` is
installed or linked on your path, use it directly instead of
`node "$AGENTCI_CLI"`.

## Adapt it

1. Replace the deterministic logic in `agentci/release.bundle/candidate.mjs`
   with a JSONL wrapper around your agent.
2. Declare its prompt and tool schema in the same release bundle.
3. Model isolated tool behavior in `agentci/adapter.bundle/adapter.mjs`.
4. Add normal and fault scenarios to `agentci/suite.json`.
5. Keep credentials and real customer data out of this starter.

## Enable GitHub Actions

The workflow is deliberately non-runnable at first. Replace the all-zero
Agent CI Action ref with a reviewed 40-character commit SHA. Keep both actions
pinned to reviewed full SHAs; do not substitute a mutable branch or tag.
