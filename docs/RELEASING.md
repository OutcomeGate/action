# Releasing

Agent CI remains private and unlicensed until the repository owner completes the
legal and publication decisions below. Do not make the repository public merely
because the technical checks pass.

## Required decisions

1. Select an OSI-approved license and add the exact canonical license text as
   `LICENSE`.
2. Replace `UNLICENSED` in `package.json` with the matching SPDX identifier.
   The automated gate currently verifies the canonical Apache-2.0 text by
   digest or the canonical MIT template after normalizing its copyright line;
   another license requires a reviewed update to that gate.
3. Decide whether the CLI will be distributed only from GitHub or also through
   npm. npm publication additionally requires a final package name and registry
   ownership check.
4. Confirm the public support and vulnerability-reporting channels.

`npm run release:check` intentionally fails while the license decision remains
open.

## Technical release sequence

1. Begin from a clean clone with complete history; shallow clones are rejected.
2. Run `npm ci --ignore-scripts --no-audit --no-fund`.
3. Run `npm run verify` and `npm run pack:check`.
4. Review the complete output of `npm pack --dry-run --json --ignore-scripts`.
5. Confirm that `npm run build:release` leaves no diff in `dist/src`.
6. Review every reachable commit and tag reported by `npm run audit:public`.
7. Create the candidate commit without a mutable Action reference.
8. From a clean clone, review the complete sorted `git ls-tree -r --full-tree`
   inventory and the candidate diff. Record the commit, tree, file count, and
   manifest digest in an acceptance record kept outside this distribution
   repository. Automated pattern checks are defense in depth and cannot prove
   that innocuously named prose is non-sensitive.
9. Run that exact commit from a separate repository using
   `OWNER/REPOSITORY@<full-40-character-SHA>` on the supported Ubuntu runner.
10. Review the job summary, annotations, logs, retention, and artifact list.
11. Record the accepted runtime SHA. In a later documentation-only commit,
    replace starter placeholders with that accepted SHA if the project chooses
    to ship a ready-to-run default.
12. Re-run the history and package audits, then change repository visibility.
13. Before advertising the repository, configure a branch ruleset that requires
    both CI jobs and blocks force pushes and branch deletion. Enable private
    vulnerability reporting, confirm read-only workflow permissions, require
    full-SHA Action pins, and retain logs for no more than seven days. If a
    GitHub setting is unavailable on the private-repository plan, enable it
    immediately after changing visibility and before accepting contributions.

The two-commit documentation step avoids pretending a commit can contain its own
SHA. Users should execute the accepted runtime commit, not a mutable branch or
tag.

## npm publication, if selected

The package remains `private: true` until its name, license, ownership, and
release channel are approved. Removing that flag is a publication decision, not
a build step. Before publishing, install the generated tarball into an empty
temporary project and run both `agentci init` and the generated starter check.
