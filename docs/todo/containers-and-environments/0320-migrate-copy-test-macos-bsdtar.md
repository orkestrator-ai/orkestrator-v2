# Migration copy-helper timeout tests fail on macOS hosts

Found on 2026-10-27 while validating branch
`search-projects-environments-d964ef18680e-r1` (⌘K search across machines).
That branch does not touch `docker/orkestrator-migrate.sh` or
`tests/unit/migrate-copy.test.ts`. The failure is unrelated to the search change.

## Current state

- `bun test tests/unit/migrate-copy.test.ts` on macOS (Darwin 27, bsdtar
  3.5.3 / libarchive 3.7.4 as `tar`) fails both
  `verified copy helper > a missing listing completion times out as
  extract-failed` and `... a missing root completion times out as
  extract-failed`. 10 tests pass and 2 fail. Each failure is at line 166:
  `extract.status` holds `2`, but the test expects `0`.
- The same two cases fail unchanged on `origin/main`. The 1013 merge
  validation recorded this, and a detached `origin/main` worktree reproduced
  it again on 2026-10-27. On Linux with GNU tar (case 1003, omarchy-hp), the
  owner passes all 12 tests.
- Cause: the helper is written for GNU tar inside the container. Its header
  says so: "by GNU tar inside this container". The unit test runs it with the
  host's `tar`. On macOS that is bsdtar, which exits 2 for the
  extraction-consumer pipeline the test builds (`tee >(tar -x … "${filter[@]}")`).
  The production path is not affected, because the script only ever runs
  inside the Linux image.

## Items

1. Make the test host-independent. Either run the helper with GNU tar (put
   `gtar` first on `PATH` as `tar` when it exists, and skip with a clear
   message otherwise), or run these two cases only on Linux. Do not weaken
   the `extract.status` assertion.
2. Confirm that the full root group passes on a macOS host afterwards.
