# Codex deleted-session initial-prompt retry returns a transport error

- **ID:** 0492
- **Status:** open
- **Date observed:** 2026-10-18
- **Test:** `at-most-once dispatch > a deleted session cannot dispatch its delayed initial-prompt retry`
- **File:** `bridges/codex-bridge/src/app-server-runtime-prompt.test.ts:231`
- **Original command:** `mise run test:logged -- --name merge-full-tests -- mise run test`, with the testing guide's GNU-tool PATH prefix, merging `origin/main` into pre-merge HEAD `f2971d54c8f464381ebfa0313a6e6f9c3cead0c4`.
- **Workers:** workspace/root/bridges/protocol reservations of 4/1/2/1 slots; one isolated Bun worker per bridge package, alongside browser checks and other worktrees on the shared host. Bridge admission waited 846.1 seconds.
- **Failure:** the pending initial-prompt response returned status 503 and `Unknown app-server thread handle: thread-1` instead of the expected 404 after deletion (191.45 ms).
- **Package counts:** Codex reported 2230 passed, 34 skipped and one failed across 2265 tests in 82 files. Every other bridge package passed.
- **Owning-file rerun:** `mise run test:logged -- --name merge-codex-prompt-owner -- bun test --cwd bridges/codex-bridge --preload ../../tests/setup-node.ts ./src/app-server-runtime-prompt.test.ts --parallel=1 --only-failures` passed unchanged, exit 0, in 5.9 seconds.
- **Evidence:** `orkestrator-test-run.B1tmFx/bridges.log.gz` below the host temporary directory after aggregate completion.
- **Assessment:** the unchanged isolated pass establishes intermittence. A deletion racing the delayed retry's transport work is a hypothesis; no implementation, assertion, timeout or skip changed.

## Cross-service read policy validation recurrence — 2026-10-23

`mise run test` with the 0054 change (no bridge source changes) failed this case and three neighbouring `at-most-once dispatch` cases at host load about 43. The unchanged owning file passed alone in 10.6 s (`codex-runtime-prompt-alone`). Details in [0696](../aggregate-validation-runs/0696-cross-service-reads-validation.md). No assertion, timeout or skip changed.

## PR monitor shutdown validation recurrence — 2026-10-25

- **Original command:** `mise run test:logged -- --name residual-state-suite -- mise run test`, on `todo-0066-residual-module-state-40e8f98a7ef0`, Bun 1.4.4.
- **Workers:** workspace/root/bridges/protocol reservations of 4/1/2/1 slots; one isolated Bun worker per bridge package. Bridges waited 90.8 seconds for shared host capacity.
- **Failure:** the same pending response returned 503 with `Unknown app-server thread handle: thread-1` instead of 404 (87.00 ms).
- **Package counts:** Codex reported 2355 passed, 40 skipped and two failed across 2397 tests in 88 files; the other failure was [0800](0800-codex-command-catalogue-armed-delay-race.md).
- **Owning-file rerun:** `mise run test:logged -- --name codex-prompt-owner -- bun test --cwd bridges/codex-bridge --preload ../../tests/setup-node.ts ./src/app-server-runtime-prompt.test.ts --parallel=1 --only-failures` passed unchanged, exit 0, in 7.1 seconds.
- **Evidence:** `orkestrator-test-run.jMkwTI/bridges.log.gz` under the host temporary directory after aggregate completion.
- **Assessment:** recurrence of the existing intermittent failure; this change touches no bridge source or assertions.

## Storage repositories validation recurrence — 2026-10-25

- **Original command:** `mise run test` on `todo-0009-storage-repositories-4696a61ea39f` (head `14213a95`, Bun 1.4.4), with another worktree's full suite and a live Docker suite on the host.
- **Failure:** the same assertion at `app-server-runtime-prompt.test.ts:231` (103.01 ms). Every other group passed.
- **Owning-file rerun:** `bun test --preload ../../tests/setup-node.ts src/app-server-runtime-prompt.test.ts` from `bridges/codex-bridge` passed unchanged: 123 pass, 0 fail, 7.46 s.
- **Assessment:** recurrence of the existing intermittent failure; todo 0009 changes backend storage only and touches no bridge source or assertions.

## Codex typed-prompt validation recurrence — 2026-10-26

- **Original command:** `mise run test:logged -- --name codex-focused -- bun test --parallel=4 bridges/codex-bridge/src/history bridges/codex-bridge/src/prompts bridges/codex-bridge/src/sessions bridges/codex-bridge/src/app-server-runtime-typed-prompts.test.ts bridges/codex-bridge/src/app-server-runtime-sessions.test.ts bridges/codex-bridge/src/app-server-runtime-prompt.test.ts bridges/codex-bridge/src/app-server-runtime-lifecycle.test.ts bridges/codex-bridge/src/transcript-routes.test.ts`, on `prompt-display-bug-7b20be78777d-r1` (todo 0211), Bun 1.4.2, four parallel workers.
- **Failure:** a new shape at the same assertion (`app-server-runtime-prompt.test.ts:231`, 135.01 ms): the pending prompt resolved `ok: true` with turn `must-not-run`, so the 30 ms delayed retry dispatched before `deleteSession` had fenced the session. Earlier recurrences returned 503 instead. Counts: 774 passed, 1 failed across 775 tests in 22 files.
- **Owning-file rerun:** `bun test bridges/codex-bridge/src/app-server-runtime-prompt.test.ts` passed three times in a row: 124 pass, 0 fail each.
- **Evidence:** `orkestrator-test-run.hbIll4/codex-focused.log.gz` under the host temporary directory.
- **Assessment:** recurrence of the existing intermittent race between the deletion and the delayed retry; under load the deletion can take longer than the 30 ms retry delay. Todo 0211 records a typed prompt only after a turn is accepted, outside the retry path. No assertion, timeout or skip changed.
