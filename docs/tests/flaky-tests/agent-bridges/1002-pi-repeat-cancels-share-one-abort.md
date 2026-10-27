# Pi: repeat cancels of an accepted run

- **ID:** 1002
- **Status:** open
- **Date observed:** 2026-10-26
- **Test:** `concurrent cancels for one claim > repeat cancels of an accepted run share one abort`
- **File:** `bridges/pi-bridge/src/prompt-cancel-preflight.test.ts`
- **Original command:** `mise run test` on branch `todo-0109-rootless-linux-runtime-d03790b22a6c` (omarchy-hp, shared host), bridges group with two workers.
- **Failure:** `expect(await responses[0]!.json()).toEqual({ cancelled: true })` received a different body (one-line diff) after 37.32 ms.
- **Suite counts:** pi-bridge 632 pass, 1 fail; every other bridge passed.
- **Isolated rerun:** `mise run test:logged -- --name a-pi -- bun test --cwd bridges/pi-bridge --preload ./src/testing/test-isolation.ts src/prompt-cancel-preflight.test.ts --parallel=1` passed.
- **Hypothesis:** the first cancel answered before the run was accepted (`pending`) under load; the branch did not change the Pi bridge.
