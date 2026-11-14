# Claude offline CLI qualification deadlines under host load

- **ID:** 1125
- **Status:** open
- **Date observed:** 2026-10-27. The host was a macOS arm64 Mac with 18
  logical cores, Bun 1.4.2, and many other worktrees active. `uptime` load
  averages were 111 / 129 / 165.
- **Tests:** `Claude coordinator sandbox qualification > *` and
  `Claude CLI execution policy qualification > *`
- **Files:** `bridges/claude-bridge/src/conformance-coordinator-sandbox-live.test.ts`
  (20 s per case); `bridges/claude-bridge/src/conformance-execution-policy-live.test.ts`
  (15 s abort deadline inside the case).
- **Branch:** `search-projects-environments-d964ef18680e-r1`. It changes web
  search, the protocol node summaries and the backend read model. It does
  not change any bridge, the vendored SDK or the conformance fixtures.

## Runs

| Command | Result |
| --- | --- |
| `mise run test` (bridges group), branch verification | Four Claude bridge failures. They also appeared on a detached `origin/main` worktree in the same verification. One reported symptom was the Anthropic SDK's `AbortSignal` `setMaxListeners` TypeError. |
| `bun run test:bridge` in `bridges/claude-bridge` (owner group alone, one worker) | 1702 pass, 4 fail: `coordinator-sandbox-reads` (17.0 s), `unavailable-hook-refuses-glob` (15.8 s), `unavailable-hook-refuses-abbreviation` (17.0 s), execution-policy `escape` (15.1 s). |
| `bun test src/conformance-execution-policy-live.test.ts --preload ../../tests/setup-node.ts` (file alone), run 1 | 3 pass, 1 fail: `unavailable` (18.4 s). |
| The same command, run 2 | 2 pass, 2 fail: `control` (17.9 s) and `network` (17.5 s). Each failed `expect(controller.signal.aborted).toBe(false)` at line 115, which means the 15 s deadline fired. |

## Assessment

A different set of scenarios fails on every run, and each failing case runs
past its deadline. That makes this a deadline race against a scripted CLI
spawn under heavy host load, not a deterministic defect. The previous
verification also saw the failures on `origin/main`. Nothing was rerun on an
idle host. No test, deadline or implementation was changed.

## Recurrence: build pipeline step rewind (2026-10-27)

- **Branch:** `pipeline-step-rewind-70c8e9f5c40d-r1` at `f8d7bcfb4`. It
  changes the build pipeline service, its protocol fields and the web flow
  graph. It does not change any bridge, the vendored SDK, the pinned CLI, the
  toolchain manifest or the conformance fixtures.
- **Host:** the same macOS arm64 host (18 logical cores), with other worktrees
  active.

| Command | Result |
| --- | --- |
| `mise run test` (bridges group), branch verification (`orkestrator-test-run.UHPP4u`) | claude-bridge 1732 pass, 6 skip, 10 fail. Eight were these cases, each at its ~17 s deadline: six `Claude coordinator sandbox qualification` cases (`coordinator-sandbox-refuses`, `coordinator-sandbox-reads`, `coordinator-hook-refuses`, `unavailable-hook-refuses-quoted`, `unavailable-hook-refuses-escaped`, `unavailable-hook-refuses-glob`) and execution-policy `control` and `escape`. The same run also timed out real-Git move tests. |
| `bun test ./src/conformance-coordinator-sandbox-live.test.ts ./src/conformance-execution-policy-live.test.ts --preload ../../tests/setup-node.ts --parallel=1` from `bridges/claude-bridge`, branch, both files alone (load 3.7–16) | 9 pass, 4 fail in 157.5 s: `unavailable-hook-refuses-escaped`, `unavailable-hook-refuses-glob`, `control`, `escape`, each at 17.0 s. |
| The same command in a standalone clone (`git clone --no-local`, no links into the worktree) of `origin/main` `405bb445e`, run 1 (load 16–25) | 12 pass, 1 fail in 118.8 s: `unavailable-hook-reads` at 17,015 ms with `Claude Code process aborted by user` (`errorClass: "aborted"`). |
| The same `origin/main` clone, run 2 (load 10–16) | 13 pass, 0 fail in 55.8 s. |
| The same branch command, run 2 (load 9–11) | 13 pass, 0 fail in 32.2 s. |

The deadline race reproduces on `origin/main` with the same symptom, and the
set of failing cases changes between runs. No test, deadline or
implementation was changed.

## Recurrence: macOS sandbox test at the 2026-11-06 pins (2026-11-14)

- **Branch:** `20261114-021211-2416d34e2ca0`, base commit `dc90609bf`
  (`git merge-base HEAD origin/main`). `mise run flaky:recurrence -- 1125
  --base dc90609bfd46ee0302d3c1a2841e0faa99482c64 --registry-ref origin/main` answered "open. Record the
  failure as a recurrence". The branch changes only documentation; the
  pinned CLI is 2.1.319 (Agent SDK 0.3.319), unchanged since 2026-11-06.
- **Host:** arktech-mini, macOS 27.2 arm64, 18 logical cores, Bun 1.4.4,
  other worktrees active. Load averages were about 14 / 12 / 9 straight
  after the failing run.

| Command | Result |
| --- | --- |
| `mise run test:logged -- --name coordinator-sandbox-conformance -- bun test --cwd bridges/claude-bridge ./src/conformance-coordinator-sandbox-live.test.ts --preload ../../tests/setup-node.ts --parallel=1` (file alone, one worker), run straight after `verify:claude:sandbox-live` | 16 pass, 1 skip, 2 fail in 119.3 s: `default-sandbox-writes` (15.3 s) and `unavailable-hook-refuses-abbreviation` (15.9 s), each at `expect(controller.signal.aborted).toBe(false)` (`test-fixtures/coordinator-sandbox-qualification.ts:361`), so the 15 s turn deadline fired. |
| The same `bun test` command, rerun at once without `test:logged` | 18 pass, 1 skip, 0 fail in 74.9 s. |
| The same command three more times in a row (load 15.9 / 15.8 / 15.7) | 18 pass, 1 skip, 0 fail each time, in 56.0 s, 42.1 s and 28.8 s. |

Same symptom as before: the failing cases differ from earlier runs, each
fails only by running past its deadline, and the same cases pass on the next
run. The skip is `read-only-required-refused`, which is pinned on Linux
only. No test, deadline or implementation was changed.
