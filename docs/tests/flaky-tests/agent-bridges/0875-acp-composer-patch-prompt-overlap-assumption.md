# ACP composer patch and prompt race assumes the two requests overlap

- **ID:** 0875
- **Status:** resolved
- **Date observed:** 2026-10-25
- **Test:** `ACP bridge > rejects a prompt that races an in-flight composer patch`
- **File:** `bridges/acp-bridge/src/acp-prompt.test.ts:901` (now line 939)
- **Original command:** CI `main` run 40179642322 (`2a06be4a6`, #1240), job "Unit and integration tests", `mise run test:full` on `ubuntu-latest` (four cores; bridges group with two worker slots).
- **Failure:** `expect([config.status, prompt.status].filter((status) => status === 409)).toHaveLength(1)` received length 0 (198.85 ms): neither request was refused.
- **Suite counts:** the bridges group failed this case and the Claude Linux sandbox qualification (fixed in todo 0030); every other bridge passed.
- **Occurrences:** 1 of the 44 failing `main` CI runs from 2026-10-23 to 2026-10-25. The sibling case `two composer patches …` (same file, same `Promise.all` pattern) has not failed.
- **Isolated rerun:** not rerun on Linux. The whole ACP package passed twice locally (macOS, `--parallel=4`, 669 pass) on 2026-10-25.
- **Hypothesis (from the code, not reproduced):** the test sends the patch and the prompt with `Promise.all` and assumes they overlap on the server. Two loopback requests are not guaranteed to overlap: if the fake agent finishes the patch before the bridge reads the prompt, both legitimately succeed. The product rule (a patch and a turn never interleave) is not contradicted by this result.
- **Next step:** make the overlap deterministic. Give the fake agent (`bridges/acp-bridge/src/testing/`) a hold for the config RPC (for example a file or message the test releases), send the patch, assert the prompt is refused while the patch is held, release it, and assert the patch completes. Cover the reverse order (a patch during a held turn) the same way.

## Fix, 2026-10-25

**Root cause.** The hypothesis held. The test sent the patch and the prompt
with `Promise.all` and assumed they overlapped on the bridge. The fake agent
answered `session/set_config_option` at once, so the patch could finish before
the bridge read the prompt; then both succeeded, which the product rule
allows. The sibling `two composer patches …` case had the same gap and
also patched to `composer-2.5`, the fake's default model, so even a winning
second patch changed nothing.

**Fix (test-only; no production file changed).**

- `bridges/acp-bridge/src/testing/fake-agent-session.ts`: the composer RPCs
  (`session/set_config_option`, `session/set_mode`, `session/set_model`) go
  through `answerConfigRpc`. It logs each request to
  `FAKE_ACP_CONFIG_REQUEST_FILE` and, when `FAKE_ACP_HOLD_CONFIG_FILE` is set,
  waits to answer until the test creates that file (the same `whenFileExists`
  primitive as `FAKE_ACP_HOLD_TURN_FILE`). Without the variables, behaviour is
  unchanged.
- `bridges/acp-bridge/src/acp-prompt.test.ts`: the new helper
  `spawnHeldConfigBridge` sets both variables for one bridge. Each test waits
  until the agent holds exactly one composer RPC, which proves the bridge has
  claimed the session.
  - `rejects a prompt that races an in-flight composer patch`: with the patch
    held, the prompt gets 409 `Session is already running` and the agent sees
    no `session/prompt`. After release the patch returns 200 and `gpt-5.5` is
    selected. The same requestId is then accepted as a fresh turn (exactly
    `{ accepted: true }`, not a duplicate and not "still preparing"), which
    proves the refused turn was never journaled, and it reaches the agent.
  - `rejects a second composer patch that races one already applying`: with
    the first patch (`gpt-5.5`) held, a second real change
    (`reasoningId: "high"`) gets 409 and never reaches the agent, and the
    composer is unchanged. After release the first patch returns 200 with
    `gpt-5.5` and reasoning still `medium`, and the agent saw only the one RPC.
  - New, reverse order: `rejects a composer patch that races a running turn`.
    With a turn held by `FAKE_ACP_HOLD_TURN_FILE` (`CURSORTASKHELD`), the patch
    gets 409, no composer RPC reaches the agent, the model is unchanged and the
    turn is still running. After the turn settles to idle, the same patch
    returns 200 and selects `gpt-5.5`.

**Mutation check** (`acp-http.ts` config route, reverted after each; `git diff`
of the file is empty):

- Drop `state.dispatching = true` (no claim): the patch-then-prompt test fails
  (prompt 202, not 409), and the two-patches test fails (the second patch is
  not refused and waits on the held RPC).
- Drop the config route's busy check: the reverse-order test fails (200, not
  409), and the two-patches test fails.

**Stress and suite runs** (macOS arm64, from `bridges/acp-bridge`):

- `bun test src/acp-prompt.test.ts --preload ../../tests/setup-node.ts`, 10
  runs in a row, run alongside the full package: 39 pass, 0 fail each time.
- `bun test src --preload ../../tests/setup-node.ts --parallel=4`: 670 pass,
  0 fail (673 tests, 45 files).
- `bun fmt`, `bunx oxlint` on both files, and `bun run typecheck`: clean.

