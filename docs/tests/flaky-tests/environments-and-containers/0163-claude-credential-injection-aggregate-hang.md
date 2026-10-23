# Claude credential injection hangs in the aggregate root group

- **ID:** 0163
- **Status:** open
- **Date observed:** 2026-09-25
- **File:** `apps/backend/tests/claude-credential-injection.test.ts`
- **Original command:** `mise run test` (four aggregate groups; root group with
  3 worker slots).
- **Failure:** the root group's no-progress watchdog fired after 300 s with
  this file still running (316 s). No assertion failed; the group was reported
  `INCOMPLETE`. Workspace, bridges and protocol-lockfile groups passed.
- **Suite counts:** not available; the watchdog terminated the group before
  its summary.
- **Isolated rerun:** `mise run test:logged -- --name cred-injection -- bun test
  ./apps/backend/tests/claude-credential-injection.test.ts` passed twice (0.6 s each).
  The previous aggregate run on the same commit passed the root group in 107 s.
- **Context:** observed on the web annotations branch, which does not change
  this test or credential injection.
- **Earlier occurrence (2026-09-24):** A focused root-group run on the design
  space branch, `mise run test:logged -- --name root-tests -- bun test ./tests
  --parallel=4 --only-failures`, hit the same 300-second no-output watchdog.
  The file had run for 386 seconds when terminated, with no failed assertions.
  A direct isolated run passed all 28 cases in 0.44 seconds, and the preceding
  full suite on that branch passed. The branch did not change credential code.
- **Occurrence (2026-09-28):** `mise run test:logged -- --name root-tests --
  bun test ./tests --parallel=4` on the disk-state cleanup branch: 4663 pass,
  4 skip, 1 fail. "replaces a stale credential" timed out. The owning file
  passed alone (28/28). The branch changes the test preloads (worktree-root
  and temp-directory isolation) but not credential code.
- **Hypothesis:** none yet. The hang, rather than a slow pass, suggests a child
  process or filesystem wait that never resolves under aggregate load.

## Separate deterministic failure on Linux CI (2026-10-15)

`an empty payload leaves an existing in-container credential intact` failed
with status 1 on every GitHub Actions `main` run after #966 moved this file into
the backend Turbo task. That is not this hang and not a flake. Turbo's strict
environment drops `SHLVL`, so `bash -lc` ran as a top-level login shell, and the
script's early `exit 0` sourced Debian's default `~/.bash_logout`, whose
`clear_console` fails without a terminal; under `set -e` the shell then exited 1.
`buildSyncContainerClaudeCredentialCommand` now guards the write instead of
exiting early, and a test with a failing `~/.bash_logout` reproduces the old
behaviour on any host.
