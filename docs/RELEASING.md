# Releasing

Apache-2.0 is selected for the Agent CI Developer Preview. The candidate remains
private until the remaining technical and publication controls pass. Do not
make the repository public merely because one automated check passes.

## Selected release posture

- `LICENSE` contains the unmodified canonical Apache License 2.0 text, and the
  package metadata uses the `Apache-2.0` SPDX identifier.
- Version `0.3.0` is the planned Developer Preview.
- The Action and source are distributed from GitHub. The CLI is not published
  to npm, and `private: true` remains an intentional publication lock.
- Support is best effort with no response-time or compatibility SLA.

Before publication, confirm the public issue and private vulnerability-reporting
channels, approve the visibility change, and decide whether to create a `v0.3.0`
GitHub prerelease tag. npm publication is a separate future decision.

## Technical release sequence

1. Assemble the release changes with every self-reference placeholder still
   inert, then review the complete diff.
2. Create the candidate commit using noreply author and committer metadata.
3. Check out that exact commit in a clean clone with complete history; shallow
   clones are rejected.
4. Run `npm ci --ignore-scripts --no-audit --no-fund`.
5. Run `npm run release:check`; it must pass from the clean candidate checkout.
6. Review the complete output of `npm pack --dry-run --json --ignore-scripts`.
7. Confirm that `npm run build:release` leaves no diff in `dist/src`.
8. Review every reachable commit and tag reported by `npm run audit:public`,
   then review the complete sorted `git ls-tree -r --full-tree`
   inventory and the candidate diff. Record the commit, tree, file count, and
   manifest digest in an acceptance record kept outside this distribution
   repository. Automated pattern checks are defense in depth and cannot prove
   that innocuously named prose is non-sensitive.
9. Run that exact commit from a separate repository using
   `OWNER/REPOSITORY@<full-40-character-SHA>` on the supported Ubuntu runner.
10. Review the job summary, annotations, logs, retention, and artifact list.
11. Record the accepted runtime SHA. In a later reference-only commit,
    replace starter placeholders with that accepted SHA if the project chooses
    to ship a ready-to-run default.
12. Re-run the release, history, and package audits. Change repository
    visibility only after explicit approval.
13. Before advertising the repository, configure a branch ruleset that requires
    every `verify` matrix job and `action-smoke`, and blocks force pushes and
    branch deletion. Enable private vulnerability reporting, confirm read-only
    workflow permissions, require full-SHA Action pins, and retain logs for no
    more than seven days. If a GitHub setting is unavailable on the
    private-repository plan, enable it immediately after changing visibility
    and before accepting contributions.

The two-commit documentation step avoids pretending a commit can contain its own
SHA. Users should execute the accepted runtime commit, not a mutable branch or
tag.

## npm publication, if selected

The package remains `private: true` until its name, registry ownership, and
release channel are approved. The Developer Preview release gate enforces that
lock. Removing it is an npm publication decision, not a GitHub source-release
step. Before publishing, install the generated tarball into an empty temporary
project and run both `agentci init` and the generated starter check.
