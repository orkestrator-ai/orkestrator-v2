# Migration copy-helper timeout tests fail on macOS hosts

Found on 2026-10-27 while validating branch
`search-projects-environments-d964ef18680e-r1` (⌘K search across machines).
That branch does not touch `docker/orkestrator-migrate.sh` or
`tests/unit/migrate-copy.test.ts`. The failure is unrelated to the search change.

Finished on 2026-10-28: every item is done. #1365 (`beb1ec4c8`) fixed the
test, and this file now records the corrected cause and the macOS evidence.
Keep this file until the branch that records it merges, for its decisions,
then delete it and remove its index row.

## Current state

- **Symptom (before `beb1ec4c8`).** `bun test tests/unit/migrate-copy.test.ts`
  on macOS failed `verified copy helper > a missing listing completion times
  out as extract-failed` and `... a missing root completion times out as
  extract-failed`: 10 tests passed and 2 failed, with `extract.status` holding
  `2` where the test expects `0`. On Linux with GNU tar (case 1003,
  omarchy-hp) all 12 passed.
- **Cause: hard-link order in the archive, not bsdtar.** This file first
  blamed the host's bsdtar. That was wrong. Since #988 the suite runs the
  helper with GNU tar: `tests/unit/gnu-shell-tools.ts` puts Homebrew's
  `gnu-tar/libexec/gnubin` ahead of `PATH`, and `missingGnuTools("tar")`
  skips the group with a reason when GNU tar is missing. The fixture
  hard-links `ws/a.txt` to `ws/sub/hard.txt`. Which of the two GNU tar
  archives first depends on directory enumeration order. On APFS it archives
  `ws/sub/hard.txt` first and stores `ws/a.txt` as a hard link to it. The two
  cases extracted only `ws/a.txt`, so GNU tar had no target to link to:
  `Cannot hard link to 'ws/sub/hard.txt': No such file or directory`, exit 2.
  This was reproduced by hand with GNU tar 1.35 on Darwin 27 on 2026-10-28.
  On ext4 `ws/a.txt` happened to come first, so Linux passed.
- **Fix (on `main` since #1365, `beb1ec4c8`).** Both cases now select the
  regular member `ws/sub/b.bin` (`tests/unit/migrate-copy.test.ts:146-148`,
  with a comment giving the reason). The `extract.status` assertion is still
  `0\n`; it now passes `extract.err` as its message, so a future tar failure
  prints tar's own error. The helper and its production path are unchanged.
  The script still only runs inside the Linux image.

## Items

1. ~~Make the test host-independent.~~ Done. GNU tar was already preferred,
   with a skip and reason when it is missing (#988). The failure itself was
   order-dependent, and #1365 removed it by selecting a member that is never
   stored as a hard link. The `extract.status` assertion was not weakened.
   Evidence, 2026-10-28, Darwin 27 (`/usr/bin/tar` is bsdtar 3.5.3; Homebrew
   GNU tar 1.35): the current file passes 12/12. The pre-#1365 file
   (`413872bfd`), run from a temporary copy, fails 10/2 with the original
   symptom.
2. ~~Confirm that the full root group passes on a macOS host afterwards.~~
   Done. `mise run test` on base `1d1f0a878` on the same host reported
   **root and agent-support tests: PASS** (3208 pass, 0 fail, no GNU-tool
   skip), with bridges also PASS. In that run the workspace and Codex
   protocol lockfile groups never started: they stayed queued behind
   scheduler resources held by other worktrees until the 1800 s group
   deadline cancelled them ("Validation was cancelled while queued"). That
   has nothing to do with this file. Their macOS failures are tracked in
   [0321](0321-macos-host-dependent-unit-failures.md) and
   [0350](0350-rootless-tests-fail-on-macos.md).

## Assumptions and decisions

- **Code change for item 1.**
  - Options: (a) no new code, because #1365 already fixed the test;
    (b) also add a guard that fails if the selected member is archived as a
    hard link; (c) run the two cases only on Linux.
  - Choice: (a).
  - Why: with GNU tar the test is already host-independent, and the
    remaining failure came from the fixture, which #1365 fixed at its source.
  - Pros: no duplicate fix; the cases keep running on macOS, which (c) would
    lose.
  - Cons: if a later change switches back to a hard-linked member, the
    failure returns. The `extract.err` message added in #1365 would make the
    cause obvious at once.
- **What to do with the finished file.**
  - Options: (a) mark it Finished and keep it until this branch merges;
    (b) delete it now and drop its index row.
  - Choice: (a).
  - Why: it follows [0058](0058-legacy-migration-root-symlink.md)'s
    precedent and the coordinator's brief (set Finished = Yes in the index).
    The corrected cause stays reviewable; until now many flaky-test records
    blamed bsdtar.
  - Pros: reviewers see the evidence and the corrected cause.
  - Cons: the README asks for finished files to be deleted, so one more step
    is left after the merge.
- **Index rank.**
  - Options: (a) keep row 13 and change only its Finished and Covers cells;
    (b) move the row below 0058 with the other finished file and renumber.
  - Choice: (a).
  - Why: (b) renumbers the rows of 0321 and 0247, and parallel branches are
    editing 0321 now.
  - Pros: no merge conflicts in the index.
  - Cons: a finished file is ranked above two open Low files until it is
    deleted after the merge.
- **Nothing durable to move.** The cause is specific to this fixture and is
  already explained by the test's own comment, so no `architecture/` or
  `development/` text changes.

## Needs verification

Nothing for this file. A full `mise run test` with every group green on
macOS still depends on 0321 and 0350.
