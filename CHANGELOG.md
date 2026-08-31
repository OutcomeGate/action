# Changelog

All notable changes to OutcomeGate are recorded here. This entry describes the
Apache-2.0 Developer Preview; the npm package remains intentionally unpublished.

## Unreleased

- Add release-v2 local-model artifact identity and validation.
- Add a deterministic FP32-to-INT8/INT4 workflow-regression example.

## 0.3.0 Developer Preview

- Adopt the OutcomeGate name, `@outcomegate/cli` package metadata, and sole
  `outcomegate` command while retaining the v0.3 `agentci.*` protocol identifiers.
- Add a safe `outcomegate init` starter workflow.
- Add public protocol, adapter, suite, security, and troubleshooting guides.
- Add a committed prebuilt runtime for network-minimal Action execution.
- Add public-history, documentation-link, package-boundary, and release checks.
- Add contribution, support, issue, and vulnerability-reporting guidance.
- Pin the starter and examples to the independently accepted preview runtime.
- Require release-v2 manifests with explicit candidate credential policy.
- Require manifest-backed adapter-v2 execution for the source Action.
- Add sanitized publication-v1 output and fail-closed `0`/`1`/`2` behavior.
- Add static secret-pattern checks and exact known-credential boundary checks.
- Require Node.js 24.11.0 or newer and run the Action on Node.js 24 LTS.
- Validate the credential-free Action on GitHub-hosted Ubuntu using an exact SHA.
