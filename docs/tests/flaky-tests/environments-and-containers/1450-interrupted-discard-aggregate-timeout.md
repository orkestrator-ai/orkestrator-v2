# Interrupted discard exceeds the aggregate test deadline

- **ID:** 1450
- **Status:** open
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
