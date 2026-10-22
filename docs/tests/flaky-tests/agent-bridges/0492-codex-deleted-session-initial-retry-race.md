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
