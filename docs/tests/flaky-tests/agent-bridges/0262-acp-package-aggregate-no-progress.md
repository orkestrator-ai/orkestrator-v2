# ACP package stops publishing output in the aggregate

- **ID:** 0262
- **Status:** resolved
- **Date observed:** 2026-10-16
- **Owner:** `bridges/acp-bridge` package suite (`test:bridge`); the aggregate output did not identify an individual active file.
- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test` on `fix/coordinator-hosted-network-lockdown` while merging `origin/main`.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1 slots on macOS arm64 with Bun 1.4.3. Each bridge used one isolated worker; a component browser suite also ran during the start of the aggregate.
- **Failure:** ACP printed the Bun test startup banner but no further output. After 300000 ms without bridge-group output, the no-progress watchdog terminated `acp-bridge#test:bridge`. The bridge group ended after 349.3 seconds, with four of five package tasks successful. The other four bridges reported zero failed tests. The aggregate exited 1 after 352.2 seconds; separate backend timeouts are recorded in 0162 and 0187. Root and protocol passed.
- **Isolated package rerun:** `mise run test:logged -- --name merge-acp-isolated -- bun run --cwd bridges/acp-bridge test:bridge` passed unchanged (exit 0) in 61.9 seconds, with the package script's default `--parallel=1`.
- **Evidence:** `/tmp/orkestrator-test-run.TpifY7/bridges.log.gz` and `summary.json`; outer artifact `/tmp/orkestrator-test-run.jvncxJ/merge-tests.log.gz`.
- **Assessment:** the unchanged package passing alone establishes an intermittent aggregate stall, but the absent file-level output does not establish its cause. No test, assertion, timeout, skip or production code changed.

- **Final aggregate rerun:** `mise run test:logged -- --name merge-tests-final -- mise run test` passed all four groups (exit 0, 277.5 seconds), including all five bridges (88.0 seconds). No tests, assertions, timeouts or skips changed.

## Merge-resolution prompt validation recurrence — 2026-10-22

- **Command:** `mise run test:logged -- --name merge-full -- mise run test`
  with the standard workspace/root/bridges/protocol allocation of 4/1/2/1 slots.
- **Failure:** ACP printed only its Bun startup banner. After 300000 ms without
  bridge-group output, the watchdog terminated `acp-bridge#test:bridge`.
  The bridge group ended after 385.2 seconds; the other four bridge packages
  passed. No active ACP owner file was identified in the output.
- **Isolated package rerun:** `mise run test:logged -- --name merge-acp-isolated -- bun run --cwd bridges/acp-bridge test:bridge`
  passed unchanged, exit 0 in 64.6 seconds, using the script's default
  `--parallel=1`.
- **Evidence:** `orkestrator-test-run.9S56xJ/bridges.log.gz` below the host
  temporary directory; outer artifact
  `orkestrator-test-run.JR9Bbt/merge-full.log.gz`.
- **Assessment:** recurrence of the recorded aggregate stall. Its cause remains
  unknown; no implementation, tests, assertions, timeouts or skips changed in
  the ACP package.
- **Confirmation:** `mise run test:logged -- --name merge-full-confirm -- mise run test`
  passed all four groups, exit 0 in 432.6 seconds; the bridge group passed
  in 109.2 seconds.

## Investigation (2026-11-15) — left open

- **Likely mechanism, observed on this host:** the stall is the runner's
  output watchdog, not a hung test. `scripts/test-all.ts` (also used by
  `test:logged`) ends a group after 300 s without output, and the ACP
  package runs with `--only-failures`, so a package that is passing prints
  nothing between Bun's banner and its summary. On 2026-11-15
  `mise run test:logged -- --name repro-acp-after-p1 -- bun scripts/test-under-contention.ts --burners 6 -- bun test --cwd bridges/acp-bridge --preload ../../tests/setup-node.ts ./src/acp-reconciliation.test.ts ./src/acp-persistence.test.ts ./src/acp-rows.test.ts ./src/acp-context.test.ts ./src/acp-generalization.test.ts --parallel=1`
  printed only `bun test v1.4.4 (…) 1x PARALLEL`, then
  `[orkestrator-test-runner] No output for 300000ms; terminating the group process tree.`
  (exit 143): the recorded symptom. The same files then passed when the
  watchdog was raised with `ORKESTRATOR_TEST_NO_PROGRESS_TIMEOUT_MS` (see 0015
  for that run). The recorded aggregate ACP package durations (263 to 328 s in
  0034 and 0219) straddle the 300 s bound.
- **Not fixed here:** the fix belongs to the test runner
  (`scripts/test-all.ts` or `scripts/bun-test-tier.ts`), shared by every
  group and outside this flake's owner. Options: print one line per finished
  file from the tier wrapper so a quiet passing package still shows progress
  (recommended; the watchdog keeps detecting a real stall, which prints
  nothing at all); or drop `--only-failures` for bridge packages (noisier
  logs); or raise the watchdog (hides real stalls longer). 0164 (Cursor) has
  the same signature.

## Resolution (2026-11-15)

- **Root cause:** the aggregate's no-output watchdog, not a hung test.
  Package suites run with `--only-failures`, so a passing package printed
  nothing after Bun's banner; on a loaded host a healthy suite that ran past
  300 s was killed with exactly the recorded symptom (reproduced for ACP on
  2026-11-15, see the investigation above).
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
