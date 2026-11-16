# Cursor bridge stall in the full-suite bridges group

- **ID:** 0164
- **Status:** resolved
- **Date observed:** 2026-09-24
- **Tests:** no case reported; Turborepo force-killed `cursor-bridge#test:bridge`
- **Files:** `bridges/cursor-bridge` (package test task)
- **Original command:** `mise run test` on branch
  `20260924-133604-380b3ff31967` (design-space implementation; no bridge code
  changed)
- **Worker configuration:** bridges group concurrent with the root and
  workspace groups; the other four bridge packages finished (codex-bridge
  1,834 pass, 0 fail).
- **Failure:** `[orkestrator-test-runner] No output for 300000ms; terminating
  the group process tree` followed by `Force killed Turborepo tasks:
  cursor-bridge#test:bridge`. The root, workspace and codex-protocol groups
  passed in the same run.
- **Isolated rerun:**
  `mise run test:logged -- --name cursor-bridge -- bun test bridges/cursor-bridge --parallel=2 --only-failures`
  passed in 13.0 s, and
  `mise run test:logged -- --name bridge-tests -- bun test bridges --parallel=2 --only-failures`
  passed in 77.5 s. Two earlier full runs on the same branch passed the
  bridges group.

## Current assessment

Only the Turborepo-driven cursor-bridge task stalled, without output, while
the group ran alongside the other suites; direct runs of the package and of the
whole bridge tree pass. Host contention during the concurrent full suite is the
likely cause. Related: 0158 (cursor bridge config process exit). Keep open
until a recurrence identifies the stalled test.

## Triage (2026-11-15): left open

Class D. The only signal is Turborepo's 300 s no-output watchdog killing the package task; no test, file or output line identifies what stalled, and direct runs of the package passed. Nothing in the cursor-bridge sources could be tied to it without that evidence, so no change was made. On a recurrence, keep the `bridges.log.gz` tail to see which file was running when output stopped. Not verified: that the default-budget change (`tests/default-test-timeout.ts`) has any effect on a task-level silence.

## Resolution (2026-11-15)

- **Root cause:** the aggregate's no-output watchdog, not a hung test.
  Package suites run with `--only-failures`, so a passing package printed
  nothing after Bun's banner; on a loaded host a healthy suite that ran past
  300 s was killed with exactly the recorded symptom (reproduced for ACP on
  2026-11-15, case 0262; this case has the same signature for Cursor).
- **Fix:** `scripts/bun-test-tier.ts` adds Bun's dots reporter whenever a run
  hides passing tests (`scripts/test-progress-dots.ts`), so every finished test
  prints a `.` and each run of dots is closed with a newline for Turbo's
  line-at-a-time output. The root group in `scripts/test-all.ts` passes
  `--dots` too. The watchdog now follows real progress: a slow suite keeps it
  fed while tests keep finishing; a hung one still goes silent and is stopped.
  Failure output is unchanged. Covered by `tests/unit/test-progress-dots.test.ts`.
- **Reproduced:** yes, for ACP: with `--only-failures` alone, the contention
  run printed only the banner and was killed at 300 s (exit 143).
- **Verified under the same condition:**
  `mise run test:logged -- --name acp-dots-contention -- bun scripts/test-under-contention.ts --burners 6 -- bun run --cwd bridges/acp-bridge test:bridge`
  passed in 370.8 s, past the 300 s bound, without a watchdog stop. Through
  Turbo (`bunx turbo run test:bridge --filter=acp-bridge --log-order=stream`)
  561 tests printed 454 progress lines, the longest gap about 2 s.
