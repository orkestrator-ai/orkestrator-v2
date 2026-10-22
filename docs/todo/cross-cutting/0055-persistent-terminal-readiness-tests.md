# PersistentTerminal launch-readiness tests that prove less than their names

Checked against `main` at `4a6ff755` (2026-10-22).

Two `PersistentTerminal` tests pass without exercising the behaviour they are
named after, so a regression in non-first-tab launch readiness could ship with
a green suite.

## Current state

- Found on 2026-10-22 while moving `apps/web/src/components/terminal/PersistentTerminal.test.tsx`
  from real sleeps to controlled time (branch `speed-up-review-68ad8937158f-r1`).
  That change kept both tests' original meaning rather than fixing them.
- **"marks a non-first tab ready after %s"** (`it.each`, about line 3040). In
  this mock setup the launch is already scheduled before any terminal output
  arrives. The assertion that `initialCommands` were not written before the
  output passes only because the 300 ms bootstrap delay has not elapsed, not
  because the output gates the launch. The three cases (a zsh prompt, a
  workspace path, substantial shell output) therefore do not show that any of
  them is what makes the tab ready.
- **"resets launch readiness when the terminal moves to a replacement
  container"** (about line 3322). After the rerender with `containerId`
  `container-2`, the second `waitFor(... toContain("echo ready\n"))` passes
  immediately: `"echo ready\n"` from the first launch is still in what
  `bootstrapWrites()` reads, even after `writeMock.mockClear()`. No second
  launch into the replacement container is proven.
- The readiness logic under test lives in
  `apps/web/src/components/terminal/PersistentTerminal.tsx` (launch bootstrap
  delay about line 74, launch scheduling about line 1920).

## Outstanding work

### Code

1. **Make the non-first-tab readiness cases depend on the output.** Arrange
   the mocks so the launch is not scheduled until terminal output arrives
   (or advance past the bootstrap delay first), then assert that nothing is
   written before the output and the commands are written after it, for each
   of the three cases. Confirm by removing the readiness check in
   `PersistentTerminal.tsx` locally and seeing all three cases fail.
2. **Prove the second launch after a container move.** Clear or snapshot the
   source `bootstrapWrites()` reads before the rerender (or count writes per
   container), then assert a new `echo ready` write after the replacement
   prompt. Confirm by breaking the readiness reset on container change and
   seeing the test fail.

## Constraints and rationale

- Fix the tests, not the component, unless the corrected tests show a real
  bug; if they do, record it here before changing behaviour.
- Keep the controlled-time helpers (`installTerminalClocks`,
  `releaseBootstrapAttempt`) the file now uses rather than reintroducing
  sleeps.

## Open questions

- None.

## Related

- [0030-test-suite-and-ci-health.md](0030-test-suite-and-ci-health.md)

## Replaces

- Nothing; found during the 2026-10-22 test-suite speed-up.
