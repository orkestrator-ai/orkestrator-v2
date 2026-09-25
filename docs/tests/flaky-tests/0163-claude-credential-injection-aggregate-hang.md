# Claude credential injection hangs in the aggregate root group

- **ID:** 0163
- **Status:** open
- **Date observed:** 2026-09-25
- **File:** `tests/unit/claude-credential-injection.test.ts`
- **Original command:** `mise run test` (four aggregate groups; root group with
  3 worker slots).
- **Failure:** the root group's no-progress watchdog fired after 300 s with
  this file still running (316 s). No assertion failed; the group was reported
  `INCOMPLETE`. Workspace, bridges and protocol-lockfile groups passed.
- **Suite counts:** not available; the watchdog terminated the group before
  its summary.
- **Isolated rerun:** `mise run test:logged -- --name cred-injection -- bun test
  ./tests/unit/claude-credential-injection.test.ts` passed twice (0.6 s each).
  The previous aggregate run on the same commit passed the root group in 107 s.
- **Context:** observed on the web annotations branch, which does not change
  this test or credential injection.
- **Hypothesis:** none yet. The hang, rather than a slow pass, suggests a child
  process or filesystem wait that never resolves under aggregate load.
