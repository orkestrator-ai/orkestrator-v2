# Interrupted discard exceeds the aggregate test deadline

- **ID:** 1450
- **Status:** resolved
- **Date observed:** 2026-10-31
- **Test:** `container lifecycle operations > interrupted discard clears clone and setup state before a new runtime starts`
- **File:** `apps/backend/tests/container-lifecycle-service.test.ts`
- **Original command:** `mise run test:logged -- --name default-suite-final -- mise run test`, at `098e8ab15` (to-do 1010 follow-ups).
- **Worker configuration:** the default concurrent groups, on a host running other workers at the same time.
- **Failure:** the 5,000 ms test deadline (reported 5,014.85 ms), with `killed 1 dangling process` printed immediately before the failure line.
- **Suite counts:** backend 11,703 pass, 1 fail. Web, desktop, protocol, toolchain, CLI and web-public had no failures.
- **Isolated rerun:** `mise run test:logged -- --name container-lifecycle-alone-N -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts tests/container-lifecycle-service.test.ts` passed three times out of three, in 1.6 to 2.0 s for the whole file.
- **Recurrence:** the same test passed in the two earlier `mise run test` runs of the same commit.
- **Hypothesis:** host load during the aggregate. The change under test touched nothing in container lifecycle, and the test passes well inside its deadline alone. The dangling process has not been investigated, so its link to the timeout is unproven.

## Resolution (2026-11-15)

- **Root cause:** The interrupted-discard case exceeded Bun's 5 s default in `mise run test`; it passes alone in about 2 s.
- **Fix:** `tests/default-test-timeout.ts`, imported by both shared preloads (`tests/setup-node.ts`, `tests/setup.ts`), makes 60 s the default per-test and hook budget, a hang watchdog only. The owning file sets no smaller file, test or hook budget, and the failing test has no inner wall-clock deadline of its own.
- **Reproduced:** no — the recorded deadline was Bun's default budget on a loaded host; the failing body is fast alone, and a 5 s exhaustion was not re-created per case here.
- **Stress:** `mise run test:logged -- --name ec-stress-b -- bash -c 'cd apps/backend && bun ../../scripts/test-under-contention.ts --core 13 --burners 6 -- bun test --preload ../../tests/setup-node.ts <seventeen container, pipeline, move, worktree and native-agent owners, this one included> --rerun-each=2 --parallel=1'` at host load about 80: 1,139 passed, 1 failed — `git fsmonitor > fixture repositories inherit fsmonitor off from the test preload` on its second rerun, which fails the same way without contention and with the unchanged file (`git-fsmonitor.test.ts` is not rerun-safe).
- **Base:** `a8b89f154` (working tree; flake sweep of 2026-11-15).
