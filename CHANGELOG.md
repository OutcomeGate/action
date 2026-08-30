# Changelog

All notable changes to Agent CI are recorded here. The project has not made a
public release yet, so versions remain pre-release implementation records until
the license and public-release checklist are complete.

## Unreleased

- Add a safe `agentci init` starter workflow.
- Add public protocol, adapter, suite, security, and troubleshooting guides.
- Add a committed prebuilt runtime for network-minimal Action execution.
- Add public-history, documentation-link, package-boundary, and release checks.
- Add contribution, support, issue, and vulnerability-reporting guidance.

## 0.3.0 — 2026-08-30

- Require release-v2 manifests with explicit candidate credential policy.
- Require manifest-backed adapter-v2 execution for the source Action.
- Add sanitized publication-v1 output and fail-closed `0`/`1`/`2` behavior.
- Add static secret-pattern checks and exact known-credential boundary checks.
- Validate the credential-free Action on GitHub-hosted Ubuntu using an exact SHA.
