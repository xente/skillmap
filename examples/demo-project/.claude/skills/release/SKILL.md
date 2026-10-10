---
name: release
description: Cut a new release of Acme Shop — bump the version, write the changelog, run the test suite and deploy to production.
allowed-tools: Bash, Read, Edit
argument-hint: <major|minor|patch>
---
# Release

1. Use the `changelog` skill to draft the notes for this version.
2. Use the `run-tests` skill; stop if anything fails.
3. Use the `deploy` skill to ship the tagged build.

See `references/checklist.md` for the manual sign-off list.
