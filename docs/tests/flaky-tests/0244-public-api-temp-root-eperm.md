# Public API test cleanup cannot remove its temporary root

- **ID:** 0244
- **Status:** open
- **Date observed:** 2026-10-15
- **Test:** `request keys and receipts > a replay after a restart returns the original receipt without re-executing`
- **Owning file:** `apps/backend/src/core/public-api/public-api-projects.test.ts:185`
- **Original command:** `mise run test:logged --name decisions-full -- mise run test`
  on `release-channels/04-remote-update` at `01f4e88c`.
- **Worker configuration:** the default `scripts/test-all.ts` pools. Another
  worktree's full suite was also running on the host.
- **Failure:** the test body passed; its `cleanup()` (`test-support.ts:143`)
  threw `EPERM: operation not permitted, rm '/tmp/ork-public-api-y5UD29'`
  (13.14 ms).
- **Suite counts:** backend: 8,094 passed, 39 skipped, 1 failed across 441
  files (265.44 s). Root, bridges and the Codex protocol lockfile groups
  passed; the run took 308.0 s.
- **Isolated owning-file rerun:** `bun test src/core/public-api/public-api-projects.test.ts`
  from `apps/backend` passed unchanged three times in a row (25 passed each).
- **Evidence:** `/tmp/orkestrator-test-run.HA7jlw/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Hypothesis:** something else held or changed the temporary root while
  `fs.rm` walked it (macOS reports `EPERM` for some removals racing another
  process), as in [0235](0235-setup-delete-terminal-history-eperm.md). Not
  reproduced; no investigation beyond the reruns.
- **Changes:** recorded evidence only; no test, timeout, assertion or skip
  changed.
