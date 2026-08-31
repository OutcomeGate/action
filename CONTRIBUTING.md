# Contributing to Agent CI

Thank you for helping make deterministic agent release checks easier to adopt.
Contributions should preserve the credential-free, synthetic-data boundary of
the planned public Developer Preview.

Unless explicitly stated otherwise, a contribution intentionally submitted for
inclusion is provided under the [Apache License 2.0](LICENSE), consistent with
Section 5 of the license. Submit only work you created or are authorized to
contribute.

## Set up a development checkout

Node.js 24.11.0 or newer is required.

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run verify
node scripts/audit-public-history.mjs
```

`npm run verify` type-checks the project, runs the automated tests, and runs the
synthetic demonstration. The public-history audit checks the current checkout
and all reachable commits. It intentionally refuses to certify a shallow
clone; fetch the complete history before running it.

## Keep contributions public-safe

- Use only synthetic fixtures and invented identifiers.
- Never add credentials, tokens, customer data, raw traces, private evidence,
  sales material, research notes, business plans, or internal planning files.
- Do not paste sensitive values into issues, pull requests, test snapshots,
  commit messages, filenames, or generated output.
- Use the GitHub-provided `users.noreply.github.com` address associated with
  your account for both author and committer metadata.
- If sensitive material enters a commit, stop and report it privately. Deleting
  it in a later commit does not remove it from Git history.

Tests that exercise secret detection should construct unmistakably synthetic
test values at runtime instead of committing realistic credentials.

## Make a focused change

- Add or update tests for behavioral changes.
- Keep examples deterministic, offline, and credential-free.
- Update documentation when commands, schemas, outcomes, or security
  boundaries change.
- Treat runtime parsers as authoritative; keep informative JSON schemas aligned
  with them.
- Pin third-party GitHub Actions to reviewed full commit SHAs.
- Explain any new dependency and its security or maintenance cost.
- Do not commit local reports, traces, coverage, dependency directories, or
  customer-derived fixtures.

Before opening a pull request, run:

```bash
npm run verify
node scripts/check-doc-links.mjs
node scripts/audit-public-history.mjs
git diff --check
```

If a command is not relevant to a documentation-only change, explain that in
the pull request instead of silently omitting it.

## Open a pull request

Describe the problem, the chosen approach, externally visible behavior, and
verification performed. Keep unrelated changes separate. A maintainer may ask
for additional adversarial tests when a change affects process isolation,
path handling, credential policy, evidence publication, or GitHub Actions.

Security vulnerabilities follow [`SECURITY.md`](SECURITY.md), not the public
issue or pull-request workflow.
