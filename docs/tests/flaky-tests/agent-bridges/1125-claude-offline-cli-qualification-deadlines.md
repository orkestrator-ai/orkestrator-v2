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
