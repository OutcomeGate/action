## Summary

Describe the problem and the outcome of this change.

## Behavior and compatibility

Describe externally visible behavior, compatibility considerations, schema or
protocol changes, and any new dependency. Write “None” where appropriate.

## Verification

- [ ] `npm run verify`
- [ ] `node scripts/check-doc-links.mjs`
- [ ] `node scripts/audit-public-history.mjs`
- [ ] `git diff --check`
- [ ] Additional relevant adversarial or end-to-end checks are described below

If a check is not applicable, explain why:

## Public-safety review

- [ ] The change contains only synthetic, public-safe fixtures and identifiers.
- [ ] No credential, customer data, private evidence, raw trace, business
      material, or internal planning information appears in files, filenames,
      commit messages, or metadata.
- [ ] Author and committer addresses use `users.noreply.github.com`.
- [ ] Third-party GitHub Actions are pinned to reviewed full commit SHAs.
- [ ] Security-boundary and user-facing changes are documented.

## Reviewer notes

Call out any path handling, process isolation, credential policy, evidence
publication, or GitHub Actions behavior that deserves focused review.
