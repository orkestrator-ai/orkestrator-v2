# Electron suite on a shared Mac desktop: follow-ups from the mbp3 run

## Task analysis

Analysed 2026-11-15 against `main` at `47110af03`, on the MacBook Pro `mbp3`
(macOS 27.2, Apple M5 Max, the built-in display and two 6016x3384 external
displays, Electron 45.2.3). The full Electron suite ran there on 2026-11-15
for [2181](2181-dev-test-electron-opens-on-the-linux-desktop.md) task 1, at
`a8b89f154`; the reruns below were made after rebasing onto `47110af03`. The
suite's results are recorded in 2181's Current state ("Real-display run on
mbp3"). This file keeps the agent work that run left.

### Tasks

1. **Register the run's flakes**: five cases failed in the full suite and passed when rerun alone, and none could be filed. Status: open.
2. **Name a lost window focus in the keyboard annotation case**: the case fails with a bare "inactive" focus result when another application takes the key window during the run. Status: open.

### 1. Register the run's flakes

**Problem.** The full-suite run on `mbp3` failed seven cases. One was a defect
in the spec, fixed in 2181's change (`renderer-permissions-electron.spec.ts`).
One depends on the desktop's focus (task 2). The other five passed when their
owning file or case was rerun alone, which makes them flakes, but none has a
case in [`docs/tests/flaky-tests/`](../../tests/flaky-tests/0000-index.md): the
flake numbers given to that pipeline (9850 to 9859) were all claimed by then,
and the four-digit register's highest number, 9999, is also taken.

**Context.** The host was heavily loaded by other builds throughout: load
averages from 79 to 169 on 18 cores were read between the runs. The suite
command was
`ORKESTRATOR_TEST_GROUP_TIMEOUT_MS=5400000 ORKESTRATOR_AGENT_TEST_SHOWN_WINDOWS=1 mise run test:logged -- --name t2181-mbp3-electron -- mise run test:agent:electron`,
one Playwright worker: 37 passed, 38 skipped, 7 failed, 952.6 s, plus
`Worker teardown timeout of 120000ms exceeded` after the seeded preview case.
Failure log: `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.dODfoO/t2181-mbp3-electron.log.gz`
(a temporary directory on `mbp3`).

| Case (file:line at `a8b89f154`) | Full-suite failure | Alone |
| --- | --- | --- |
| `Help offers Open Developer Tools only while a renderer has debug logging on` (`application-menu-electron.spec.ts:30`) | `electronApplication.firstWindow` timed out after 30 s | Passed (`application-menu-electron.spec.ts:30`) |
| `a real window sends its startup markers to the main process and none of its logger lines` (`renderer-log-boundary-electron.spec.ts:204`) | `electronApplication.evaluate: TypeError: Object has been destroyed` at line 319 | Passed |
| `history, app zoom, DevTools, screenshots and capture work after reattach` (`service-preview-electron.spec.ts:944`) | `electronApplication.evaluate: Target page, context or browser has been closed`; the rest of the serial file did not run | Passed with its whole file (22 passed, 1 skipped, 1 failed); alone by line it cannot run, because it needs the earlier serial cases |
| `a remote terminal link opens the native localhost forward in a separate browser` (`service-preview-electron.spec.ts:3140`) | Did not run (serial, after the failure above) | Failed in that whole-file run: `page.evaluate: TypeError: Failed to fetch` from `node-transport.ts` `invokeImmediately` |
| `hidden, minimised and covered windows on a desktop pause their polls` (`window-visibility-polls-electron.spec.ts:517`) | The `restored` step reached `visible`, then read `hidden` with no read in 2 s | Passed 4 of 4 |
| `a hidden window's polls read only while Electron reports it visible` (`window-visibility-polls-electron.spec.ts:456`) | Passed | Timed out at 90 s in 2 of 5 runs alone at load averages near 145 (the page load in a never-shown window had not finished); passed in the other 3 |

The seeded preview case (`service-preview-seeded-electron.spec.ts:567`) failed
too (`firstWindow` timed out after 90 s, then the worker teardown timed out)
and passed alone. It already has case
[9902](../../tests/flaky-tests/previews-annotations-and-gateway/9902-seeded-preview-adjacent-port-reservation.md),
where this observation was added.

**Investigation.** For each row, add a case in the matching group folder and
its index row, as the flake procedure says: the observing branch base is
`a8b89f154` for the full-suite failures and `47110af03` for the reruns, and
`mise run flaky:recurrence` should be run first. Check whether an open case
already covers the same test under another symptom before adding one (9929
and 9935 cover the first row's test, but for DevTools not opening on Windows
and Linux CI, not for a window that never appeared). Since 2181's change the
window-visibility spec is one line longer, so its cases are at lines 457 and
518.

**Decisions.**

- **How should the five be filed?**
  - **One case per test, in its group folder, as soon as numbers are free (recommended).**
    - Pros: each test is found by name in its group index, which is how the register is searched.
    - Cons: five numbers; one more pipeline-level allocation is needed.
  - **One aggregate case for the run, like the branch-validation cases in `aggregate-validation-runs/`.**
    - Pros: one number.
    - Cons: a later failure of one of these tests is not found by searching for its name in its own group.

### 2. Name a lost window focus in the keyboard annotation case

**Problem.** `keyboard alone creates a note and sends it, with focus handed to
the native view and back` (`web-annotations-electron.spec.ts:2221`) failed on
`mbp3` in the full suite (line 2314, the preview never became the focused
view) and again alone (line 2213, `Save note` was the active element but the
document was `inactive`). Alone, the case had recorded `window-focused: true`
at its start: the window had the key focus, then lost it mid-case.

**Context.** The case already tolerates a window that never gets focus ("Another
app, or a locked session, may keep the key window"), but not one that loses it
part-way. On `mbp3` the user's production Orkestrator was the front
application, and other worktrees' Electron runs (which call
`app.focus({ steal: true })`) were sharing the desktop. The failure message
says only "inactive", so it reads like a focus-handoff regression.

**Investigation.** When a focus expectation in this case fails, read
`BrowserWindow.isFocused()` and, on macOS, the front application
(`lsappinfo front`, as `hidden-dialogs-electron.spec.ts` does), and fail with
a message that names the loss. Do not skip or retry: a real handoff bug would
then pass. The run at a desktop nobody else uses is in
[7568](../manual-test/7568-manual-test-checklist.md) ("2181 task 1: the
keyboard annotation case at an idle Mac").

**Decisions.**

- **What should the case do when the window loses focus mid-run?**
  - **Keep failing, but name the lost focus and the application that took it (recommended).**
    - Pros: the assertion is unchanged; the failure says it was the desktop, not the handoff.
    - Cons: the case still fails on a busy shared desktop.
  - **Skip when focus was lost.**
    - Pros: green on a shared desktop.
    - Cons: a handoff that drops focus would be skipped instead of reported.

## Related

- [2181](2181-dev-test-electron-opens-on-the-linux-desktop.md), whose task 1 ran the suite.
- [7568](../manual-test/7568-manual-test-checklist.md), "2181 task 1: the keyboard annotation case at an idle Mac".
- Flake [9902](../../tests/flaky-tests/previews-annotations-and-gateway/9902-seeded-preview-adjacent-port-reservation.md), which took the seeded preview observation.
