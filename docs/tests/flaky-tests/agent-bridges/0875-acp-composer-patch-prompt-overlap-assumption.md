# ACP composer patch and prompt race assumes the two requests overlap

- **ID:** 0875
- **Status:** open
- **Date observed:** 2026-10-25
- **Test:** `ACP bridge > rejects a prompt that races an in-flight composer patch`
- **File:** `bridges/acp-bridge/src/acp-prompt.test.ts:901`
- **Original command:** CI `main` run 40179642322 (`2a06be4a6`, #1240), job "Unit and integration tests", `mise run test:full` on `ubuntu-latest` (four cores; bridges group with two worker slots).
- **Failure:** `expect([config.status, prompt.status].filter((status) => status === 409)).toHaveLength(1)` received length 0 (198.85 ms): neither request was refused.
- **Suite counts:** the bridges group failed this case and the Claude Linux sandbox qualification (fixed in todo 0030); every other bridge passed.
- **Occurrences:** 1 of the 44 failing `main` CI runs from 2026-10-23 to 2026-10-25. The sibling case `two composer patches …` (same file, same `Promise.all` pattern) has not failed.
- **Isolated rerun:** not rerun on Linux. The whole ACP package passed twice locally (macOS, `--parallel=4`, 669 pass) on 2026-10-25.
- **Hypothesis (from the code, not reproduced):** the test sends the patch and the prompt with `Promise.all` and assumes they overlap on the server. Two loopback requests are not guaranteed to overlap: if the fake agent finishes the patch before the bridge reads the prompt, both legitimately succeed. The product rule (a patch and a turn never interleave) is not contradicted by this result.
- **Next step:** make the overlap deterministic. Give the fake agent (`bridges/acp-bridge/src/testing/`) a hold for the config RPC (for example a file or message the test releases), send the patch, assert the prompt is refused while the patch is held, release it, and assert the patch completes. Cover the reverse order (a patch during a held turn) the same way.
