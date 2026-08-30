# Support

Agent CI is a pre-1.0 project being prepared for open-source publication and is
maintained on a best-effort basis. There is no response-time or compatibility
SLA.

## Where to ask

- For a reproducible defect, use the **Bug report** issue form.
- For a new capability or integration, use the **Feature request** issue form.
- For a suspected vulnerability, follow [`SECURITY.md`](SECURITY.md) and do
  not open a detailed public issue.

Before filing an issue, verify the latest default-branch commit, search existing
issues, and run `npm run verify` when possible.

## What to include

Provide the exact Agent CI commit SHA, Node.js version, execution environment,
exit code or outcome, and a minimal synthetic reproduction. Reduce logs to the
smallest relevant excerpt and check them again for private information before
posting.

Never attach credentials, customer fixtures, real conversations, production
traces, canonical evidence, or unsanitized reports. If a reproduction cannot
be shared without private data, describe the behavior at a high level and wait
for a maintainer to establish an appropriate channel.

## Supported scope

Public support covers the credential-free GitHub Action, the local CLI,
documented schemas and protocols, and the included synthetic examples. It does
not include review of proprietary prompts or data, production incident
response, custom adapter implementation, or guarantees that terminating a
local process cancels an external side effect.
