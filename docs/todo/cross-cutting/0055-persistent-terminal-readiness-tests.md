# PersistentTerminal launch-readiness regression coverage

Status: completed on 2026-10-22 on `speed-up-review-68ad8937158f-r1`.

## Original gaps

Found while replacing real sleeps with controlled time, checked against `main`
at `4a6ff755` (2026-10-22):

- The three non-first-tab readiness cases only asserted that commands had not
  been written before the 300 ms bootstrap timer fired. The mock persisted a
  fresh PTY immediately, which activated the reconnection readiness shortcut
  before any output arrived.
- The replacement-container case retained the first bootstrap in the invocation
  history and never released another bootstrap timer, so it proved no second
  launch.

## Completed work and evidence

- Both tests hold session persistence so a fresh PTY cannot activate the
  restored-session shortcut. Each advances the bootstrap clock before output
  and asserts that no command was sent.
- Each non-first-tab fixture then feeds its matching output, releases the
  newly scheduled bootstrap, and asserts command delivery.
- The container replacement clears the invocation history and changes to a new
  PTY id. The hook mock scopes its bootstrapped state to the PTY and container.
  The test asserts a second request for that PTY only after the replacement
  prompt and another clock release.
- The complete `PersistentTerminal.test.tsx` file passes (135 tests).
- Mutation verification: disabling non-first-tab output readiness makes all
  three output cases fail. Removing the container-change readiness reset makes
  the replacement case fail at its pre-output assertion. Both mutations were
  restored; component behavior needed no change.

## Outstanding work

None.

## Related

- [0030-test-suite-and-ci-health.md](0030-test-suite-and-ci-health.md)
