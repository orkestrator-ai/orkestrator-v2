# Conversation scroll target: repeat-jump highlight gone after a fixed sleep

- **ID:** 9979
- **Status:** open
- **Date observed:** 2026-11-11 (twice)
- **Test:** `useConversationScrollTarget > a repeat jump to the same message restarts the highlight; another moves it`
- **File:** `apps/web/src/components/native-agent/useConversationScrollTarget.test.tsx`

## First observation

Recorded, unnumbered, in case
[9975](../previews-annotations-and-gateway/9975-terminal-socket-agent-test-expiry-close-before-listener.md#same-run-unnumbered-web-observation)
(base `498b68766`): line 88 received `undefined` (396.98 ms) in a loaded
aggregate; the owner passed alone (11 pass, 2.17 s). That note asked for a
number here if it recurred.

## Recurrence — 2026-11-11 (backend domain restructure review repairs)

- **Branch and base:** `backend-domain-restructure-13639d788e59-r1` at
  `98f77e1d0`, base `14df965440e658e09a7b3ce03530bc1781ac2b01`. The branch
  moves backend web-annotation modules and edits docs and a codemod script;
  it touches no web code.
- **Command:** `mise run test:logged -- --name review-default-tests-rerun -- mise run test`
  (Linux x86_64, Bun 1.4.4), with 14 to 16 of 16 scheduler slots reserved
  and a 15-minute load average of about 45 on 16 cores.
- **Failure:** line 88, `expect(result.current?.messageId).toBe("u-2")`,
  Expected `"u-2"`, Received `undefined` (394.78 ms).
- **Suite counts:** web 14,571 pass, 10 skip, 8 fail (14,589 tests across
  1,008 files); the other failures were flake
  [9932](9932-virtuoso-cancellation-fake-clock-timer-count.md).
- **Isolated rerun:** `NODE_ENV=test bun test ./src/components/native-agent/useConversationScrollTarget.test.tsx --parallel=1`
  from `apps/web`, through `test:logged`: passed (1.8 s).

## Hypothesis

Unconfirmed, as in 9975: the hook shows a 200 ms highlight on wall-clock
time. After the repeat jump the test waits for the new generation, then
sleeps a fixed 120 ms before checking that the highlight is still shown. On a
loaded host the `waitFor` plus the sleep can overrun the restarted 200 ms
period.

## Next evidence

Reproduce under CPU load (for example `--rerun-each` with a busy host) before
changing anything. The likely fix is to drive the highlight timer with
`installControlledTimeout` (`tests/helpers/controlled-timeout.ts`) instead of
fixed sleeps, as the `sleep-before-negative-assertion` guard advises.
