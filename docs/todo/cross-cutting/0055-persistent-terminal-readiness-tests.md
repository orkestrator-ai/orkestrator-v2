# PersistentTerminal launch-readiness regression coverage

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Retire the finished file**: every item is done (the folder index marks it Finished: Yes); decide what happens to the file. Status: done.

### 1. Retire the finished file

**Problem.** The file has no outstanding work, but the README rules say a finished file is deleted once its durable behaviour has a home elsewhere. It still occupies a row in the folder index.

**Context.** The coverage was added on `speed-up-review-68ad8937158f-r1` (2026-10-22) while replacing real sleeps with controlled time; the parent work is [0030-test-suite-and-ci-health.md](0030-test-suite-and-ci-health.md). The file records no product behaviour, only test coverage and mutation evidence.

**Investigation.** The tests are on `main`: `holdSessionPersistence()` at `apps/web/src/components/terminal/PersistentTerminal.test.tsx:524`, the parametrised "marks a non-first tab ready after %s" case at `:3066` (it holds persistence at `:3067` and asserts delivery at `:3095`), and "resets launch readiness when the terminal moves to a replacement container" at `:3392`. Last touched by `182a4031` (#1265). Nothing in `docs/architecture/` or `docs/development/` describes the non-first-tab readiness gate or the container-change reset, so the only durable fact (why the tests hold persistence) lives in this file and in the test code. Newly noticed: `PersistentTerminal.test.tsx` is 5,627 lines, far over the 2,000-line guideline in `AGENTS.md`; that is separate work for a new todo file, not this one.

**Decisions.**

- **What to do with the file?**
  - **Delete it now, moving one sentence into the test (recommended).** Add a short comment above `holdSessionPersistence()` saying a fresh PTY must not reach the restored-session shortcut, then delete the file and its index row.
    - Pros: follows the README rule; the reason sits next to the code that needs it; only the folder index links here (0054 merely mentions it as precedent for keeping a finished file).
    - Cons: the mutation-verification evidence is lost from the docs (it remains in git history).
  - **Move the readiness rules into `docs/architecture/` first, then delete.** Write a short section on terminal launch readiness (first tab waits for setup output, non-first tabs for their own output, a container change resets it).
    - Pros: documents real product behaviour that is currently undocumented anywhere.
    - Cons: larger change than the file asked for; the behaviour belongs to terminal architecture work, not to a test-coverage todo.
  - **Keep the file as a record.**
    - Pros: no work.
    - Cons: contradicts the README rule; a finished row keeps cluttering the index.

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
