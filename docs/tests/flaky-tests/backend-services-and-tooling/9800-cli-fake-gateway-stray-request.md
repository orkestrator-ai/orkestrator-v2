# CLI fake gateway throws on a stray request from another suite

- **ID:** 9800
- **Status:** resolved
- **Date observed:** 2026-11-15
- **Test:** `orkestrator attention > --follow --jsonl prints each new item once and feeds the cursor back`
- **File:** `packages/cli/tests/attention-ticket-mail-command.test.ts` (harness: `packages/cli/tests/support/client-harness.ts`)
- **Original command:** `mise run test:logged -- --name full-suite -- mise run test` on `fix-flaky-tests-57033d2a4f0e-r1`, base `a8b89f1541e7abb6af36d45121593ae14640a3ca`, Linux x86_64, Bun 1.4.4, host load average around 30 to 40.
- **Worker configuration:** the aggregate's standard groups, run concurrently; the CLI package ran in the workspace group.
- **Failure:** after 430.26 ms, `SyntaxError: Unexpected end of JSON input` at `client-harness.ts:167` (`await request.json()` in the fake gateway's `fetch`), with Bun's `GET - /api/event failed`.
- **Suite counts:** the workspace group and the root group failed; the other root failure (`tests/unit/mise-tasks.test.ts`) also failed alone and was a separate, deterministic assertion already broken on `main`, fixed in the same change.
- **Isolated rerun:** the aggregate's own rerun reported `PASSED ALONE packages/cli/tests/attention-ticket-mail-command.test.ts (2.8s)`.

## Resolution (2026-11-15)

- **Root cause:** a request that was not the CLI's. The CLI client only
  ever sends `POST /__orkestrator/invoke`; `GET /api/event` is OpenCode 2's
  event-stream route, used by backend OpenCode suites running at the same
  time. The fake gateway binds port 0, so the OS can hand it a port another
  suite's client still remembers; that client's reconnect landed on the fake
  gateway, whose handler parsed every request as JSON and threw. Bun reports
  a throw inside a server handler as a failure of the test that is running.
  The outcome therefore depended on which ports the host recycled, not on the
  CLI.
- **Fix:** the fake gateway answers only `POST /__orkestrator/invoke` and
  returns 404 for anything else without parsing or recording it
  (`client-harness.ts`). New `packages/cli/tests/client-harness.test.ts`
  sends a stray `GET /api/event` and a `GET` on the invoke route and expects
  two 404s and no recorded requests.
- **Reproduced:** yes, at the mechanism level: the new test fails against
  `main`'s harness (the handler throws on the stray request) and passes with
  the fix. The aggregate's port reuse itself was not reproduced on demand.
- **Verification:** `bun test --cwd packages/cli --preload ../../tests/setup-node.ts ./tests/attention-ticket-mail-command.test.ts ./tests/client-waits.test.ts ./tests/cli-client.test.ts --parallel=3` passed through `test:logged`.
