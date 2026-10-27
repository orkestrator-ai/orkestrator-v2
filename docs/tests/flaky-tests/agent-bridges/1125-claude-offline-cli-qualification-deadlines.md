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
