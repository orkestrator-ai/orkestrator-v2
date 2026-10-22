# `ActionBar workflow tabs > clears active long-press click suppression when the action bar unmounts` (`apps/web/src/components/layout/ActionBar.test.tsx`)

- **ID:** 0052
- **Status:** resolved
- **Date observed:** 2026-08-16
- **Original command:**
  `bun run test:logged -- --name web-pkg-tests -- bun --cwd=apps/web test --parallel=4 --only-failures`
- **Worker configuration:** four Bun workers, while a *separate* worktree on this
  host was running a full aggregate `bun run test` concurrently. Host contention
  was therefore well above a normal single-suite run.
- **Failure:** `getElementError` from `tests/bounded-test-diagnostics.ts:28`,
  raised at `ActionBar.test.tsx:2989` — the
  `screen.getByRole("dialog", { name: "Configure code review" })` assertion found
  no dialog. The case fires a touch `pointerDown` on the Code review button, then
  waits a bare `setTimeout` of 575 ms for the long-press threshold to elapse
  before asserting the dialog opened.
- **Suite counts:** `5002 pass, 1 fail. Ran 5004 tests across 215 files. [40.04s]`
- **Isolated rerun:** `bun --cwd=apps/web test src/components/layout/ActionBar.test.tsx`
  → 166 passed, 0 failed in 15.67 s. The same aggregate command then passed three
  consecutive times (40.3 s, 49.1 s, 50.8 s).
- **Hypothesis:** the fixed 575 ms sleep is the whole margin over the component's
  long-press threshold, so it is a race against the wall clock rather than against
  application state. Under contention the timer fires late, or the React commit
  that mounts the dialog lands after the sleep resolves, and the immediate
  `getByRole` misses it. A `waitFor` around the dialog assertion would remove the
  race without weakening it — the case's real subject is the `createTabMock`
  assertion after `unmount()`, not the dialog's arrival latency. Nothing in the
  failing path touches agent skills, extension discovery, or the ACP bridge, which
  are the only areas the commit that observed this changed.
