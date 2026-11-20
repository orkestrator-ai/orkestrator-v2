# OpenCode stop: the settle window ran past its cleanup abort on a slow server

- **ID:** 9816
- **Status:** resolved
- **Date observed:** 2026-11-20
- **Base commit:** 918d7caaf5e173b121a06a209f518d1108398803 (`main` after #2515); fixed on branch `fix-ci-round-3-8ad0c62eed90` from 627bdc500.
- **Test:** `OpenCode stop with a pending-request reject the server refuses > still completes the graceful ladder and records a notice` and `... > still completes the force-stop ladder and records a notice`.
- **File:** `apps/backend/src/core/native-agent/service-opencode-stop.test.ts:45`.
- **Original command:** CI push run 44766068326 (`main` at 918d7caaf), job "Tests (backend)" 136391063960, `mise run test:full` backend shard.
- **Worker configuration:** the CI backend shard, run concurrently with the other test groups on one GitHub runner.
- **Failure:** `ProviderUnavailableError: OpenCode 2.x stop is still pending` from `OpenCode2Provider.abort` (`apps/backend/src/core/opencode2/provider.ts:598`), after 4,632.98 ms and 5,508.50 ms. Backend shard: 23,754 pass, 2 fail, 382 skip.
- **Isolated rerun:** the aggregate runner reran the file alone on the same runner and it passed (15.8 s). Locally `bun test src/core/native-agent/service-opencode-stop.test.ts` from `apps/backend` passed (5 pass, 15.75 s), and still passed with 48 CPU-bound processes running on 16 cores.
- **Reproduction:** a copy of the test file that delays every `FakeOpenCode2Server` response by 12 ms failed three of its five cases with the same error, each after about 4.2 s.
- **Root cause:** a product race. `OpenCode2BackgroundWork.stop` (`apps/backend/src/core/opencode2/background-subagents.ts`) polls the server for its settle window, `OPENCODE2_STOP_SETTLE_MS` (3 s), but counted the window as 31 polls with a 100 ms sleep between them. Each poll also makes three or more server reads, so a slow reply made the loop longer than 3 s. A wall-clock abort at `OPENCODE2_STOP_CLEANUP_MS` (4 s) then fired inside the loop, `stop` returned "not quiet", and the provider reported the stop as still pending even though the turn had stopped. A user with a slow or busy OpenCode server would get the same failed stop.
- **Fix:** the loop also ends once 3 s of wall-clock time have passed since it started, which is the clock the cleanup abort uses, so the final reconciliation always keeps its 1 s. When reads are fast, or a test injects `sleep`, the 31-poll bound still applies, so the number of polls is unchanged.
- **Verification:** the 12 ms and 30 ms delayed copies passed 5 of 5 after the fix. `mise run test:logged -- --name opencode2-dir -- bun test --cwd apps/backend src/core/opencode2 --parallel=6 --only-failures` passed, and so did the owning file together with `background-subagents.test.ts`, `provider.test.ts` and `interactions.test.ts`.
- **Disposition:** resolved.
