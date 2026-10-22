# Claude status plan-mode fixture directory race

- **ID:** 0473
- **Status:** resolved
- **Date observed:** 2026-10-18
- **Test:** `status frames > a failed plan-mode persistence write keeps the current toggle`
- **File:** `bridges/claude-bridge/src/services/session-manager-system-events.test.ts:270`
- **Original command:** `mise run test:logged -- --name merge2-warm-tests -- mise run test`, with the testing guide's GNU-tool PATH, merging `origin/main` at `f51c7252` into pre-merge HEAD `390667ce`.
- **Workers:** workspace/root/bridges/protocol reservations of 4/1/2/1 slots.
- **Failure:** the fixture's `writeFile(<temporary home>/.claude, "not a directory")` failed with `EISDIR` before reaching its persistence assertion (1.28 ms).
- **Owning-file rerun:** `mise run test:logged -- --name merge2-claude-system-owner -- bun test --cwd bridges/claude-bridge --preload ../../tests/setup-node.ts ./src/services/session-manager-system-events.test.ts --parallel=1 --only-failures` passed unchanged, exit 0, in 0.1 seconds.
- **Evidence:** `orkestrator-test-run.ZR4P2k/bridges.log.gz` below the host temporary directory.
- **Assessment:** confirmed intermittent fixture failure. The producer of the racing directory was not established. No implementation, assertion, timeout or skip changed.

The warm aggregate exited 1 in 307.7 seconds; workspace, root/support and protocol groups passed. This fixture failure was its only failing test. The cold aggregate had passed every bridge; its separate Pi staging timeout passed in an owning-file rerun (see [0178](0178-pi-vendor-runtime-aggregate-timeout.md)).

## README follow-up merge recurrence — 2026-10-18

`mise run test:logged -- --name merge3-final-tests -- mise run test`, merging `origin/main` at `a2b36d1d` into `84e228d7`, repeated the same EISDIR fixture setup failure (1.26 ms). The bridge implementation and owning file were unchanged by this follow-up. `mise run test:logged -- --name merge3-claude-system-owner -- bun test --cwd bridges/claude-bridge --preload ../../tests/setup-node.ts ./src/services/session-manager-system-events.test.ts --parallel=1 --only-failures` passed unchanged. Evidence: `orkestrator-test-run.QGIBq2/bridges.log.gz` below the host temporary directory. No implementation, assertion, timeout or skip changed.

The follow-up aggregate completed in 297.4 seconds (exit 1). Workspace, root/support and protocol groups passed; this fixture was its sole failure. The unchanged owner rerun passed in 0.2 seconds. Formatting, lint, typechecking, the production build, Markdown round-trip tests and the final index contract also passed.

## OpenCode provider sign-in review observation — 2026-10-19

`mise run test:logged -- --name full-suite -- mise run test` repeated the
EISDIR fixture setup failure at line 270 (14.20 ms), with 4/1/2/1 reserved
workspace/root/bridge/protocol slots. Claude reported 1575 passed, five skipped
and one failed. Evidence: `orkestrator-test-run.ImZy3W/bridges.log.gz` below
the host temporary directory.

The unchanged owning file passed without the Node preload under
`mise run test:logged -- --name claude-system-events-isolated -- bun test --cwd bridges/claude-bridge ./src/services/session-manager-system-events.test.ts --parallel=1 --only-failures`
(exit 0, 0.1 seconds). That invocation did not match the aggregate preload.
The matching rerun,
`mise run test:logged -- --name claude-system-events-node-isolated -- bun test --cwd bridges/claude-bridge --preload ../../tests/setup-node.ts ./src/services/session-manager-system-events.test.ts --parallel=1 --only-failures`,
also failed with EISDIR (41 passed, one failed, 0.1 seconds). Evidence:
`orkestrator-test-run.ZLIgt6/claude-system-events-node-isolated.log.gz`.
This occurrence therefore does not independently establish a flake. No Claude
implementation, fixture, assertion, timeout or skip changed.

The final `full-suite-final` aggregate with the explicit GNU-tool/Python PATH
passed every group (391.5 seconds logged), including the unchanged Claude
fixture in the bridge group (80.0 seconds). This successful warm execution
does not resolve the fixture race.

## Git scan regression coverage recurrence — 2026-10-20

`mise run test:logged -- --name git-coverage-all -- mise run test` repeated
the same EISDIR at line 270 (1.61 ms), with 4/1/2/1 reserved
workspace/root/bridge/protocol slots. The Claude implementation and test file
were unchanged. Evidence: `orkestrator-test-run.T5B1Ho/bridges.log.gz` below
the host temporary directory.

The unchanged owning file passed with the matching Node preload under
`mise run test:logged -- --name git-coverage-claude-owner -- bun test --cwd bridges/claude-bridge --preload ../../tests/setup-node.ts ./src/services/session-manager-system-events.test.ts --parallel=1 --only-failures`
(exit 0, 0.1 seconds). This occurrence confirms the existing intermittent
fixture failure; no implementation, assertion, timeout or skip changed.

The aggregate completed in 432.0 seconds (exit 1). Root/support and protocol
passed. The only other failure was the Docker maintenance case in
`apps/backend/tests/commands-registry-coverage.test.ts:252`; that owning file
also failed alone, including with the unmodified `commands-files.ts` from HEAD
(`git-coverage-registry-baseline`, exit 1, 0.5 seconds). This Docker failure is
not classified as a flake. Baseline evidence:
`orkestrator-test-run.3JXBkZ/git-coverage-registry-baseline.log.gz`.

## Resolution — 2026-10-22

- **Status:** resolved. Same cause and fix for 0385, 0473 and 0513.
- **Root cause:** `writeTurnInFlightMark` (`session-manager-turn-interruption.ts`)
  records the turn-in-flight mark with an un-awaited `updateSessionPreferences`
  call when a prompt starts. The preference write resolves the Claude home when
  it runs (`withPreferenceFileLock` calls `claudeSessionPreferencesDir()`), not
  when it was queued. The fixtures switch to a fresh temporary home and replace
  `.claude` with a file within about a millisecond of the prompt starting, so the
  write's `mkdir -p .claude/orkestrator/session-preferences` could land first and
  the fixture's `writeFile` hit `EISDIR`. Instrumenting the fixture showed the
  racing directory held only `orkestrator/` (a recursive mkdir in flight), with
  the stack in `updateSessionPreferences`. In 0473 the home is switched after the
  prompt starts, which is why a rerun with the matching preload could also fail.
- **Fix:** `fix(ci): stop the Linux watcher crash and two fixture races keeping
  main red`. `blockClaudeConfigDir` in `session-manager-test-harness.ts` removes
  whatever `.claude` exists and writes the blocking file with `wx`, retrying
  (bounded) only when a concurrent mkdir won; once the file is in place no writer
  can create the directory, which is the state under test. All nine fixtures that
  replace `.claude` after setup use it; the assertions are unchanged. A version
  that waited for every queued preference write instead hung when a previous
  test left a write parked under controlled time, so it was not used.
- **Verification:** before the fix,
  `bun test --preload ../../tests/setup-node.ts ./src/services/session-manager-interactions.test.ts ./src/services/session-manager-system-events.test.ts --rerun-each 30`
  (from `bridges/claude-bridge`, macOS arm64, Bun 1.4.3) failed 10, 8 and 11
  times in three runs of 2,130 cases, all EISDIR. After: 0 failures in three runs
  (2,130 passed each). The Claude bridge package (`bun run test:bridge`) passed.
  CI also hit this on `main` runs 39690434421 and 39701903157.
