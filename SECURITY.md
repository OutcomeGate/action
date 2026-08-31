# Security policy

## Supported versions

The OutcomeGate Developer Preview candidate is pre-1.0. Security fixes are made
against the current default branch and, when applicable, the accepted candidate
SHA. Older commits and forks are not maintained with security backports.

| Version | Supported |
| --- | --- |
| Current default branch / accepted candidate SHA | Yes |
| Older commits | No |

## Report a vulnerability privately

After publication, use GitHub's **Security** tab and select **Report a
vulnerability**:

<https://github.com/OutcomeGate/action/security/advisories/new>

Do not put vulnerability details in a public issue. If private vulnerability
reporting is unavailable, open a public issue that only asks the maintainer to
establish a private channel. Do not include the vulnerability, an exploit,
logs, credentials, customer information, or unpublished evidence in that
issue.

A useful private report includes:

- the affected commit SHA and whether the issue is in the Action or local CLI;
- the security impact and prerequisites;
- a minimal reproduction made only from synthetic data;
- relevant operating-system and Node.js versions; and
- a suggested mitigation, if one is known.

Please keep the report private until a fix and disclosure plan have been
coordinated.

## Security boundary

The GitHub Action is intentionally credential-free. Do not attach secrets to
its step, job, fixtures, manifests, reports, or logs. Candidate, adapter, and
evaluator processes run as the same operating-system user; OutcomeGate is not a
hostile-code sandbox. Static secret scanning is defense in depth, not a data
loss prevention guarantee.

For the complete boundary and deployment guidance, see
[`docs/SECURITY-MODEL.md`](docs/SECURITY-MODEL.md).
