# Linux native menu: DevTools not reported open within the poll

- **ID:** 9935
- **Status:** open
- **Date observed:** 2026-11-10

Test: `Help offers Open Developer Tools only while a renderer has debug logging on`
in `e2e/agent-testing/application-menu-electron.spec.ts`.

Workflow: "Native application menu", job `Native menu (ubuntu-latest)`. The
same test's Windows failures are [9929](9929-windows-native-menu-devtools-app-closed.md);
this symptom differs (Electron stayed up, DevTools never reported open), so it
is a separate case.

## Observation

| Run | Branch | Head | Merge base with `main` | Repetition | Result |
| --- | --- | --- | --- | --- | --- |
| 42833338750 | `continuous-improvement-loop-894d9e3cdfc3-r1` (#2092) | `3eb00bcc` | `887cdfb5` | 1 of 5 | 1 failed, 24 passed (3.0 m) |

Original command (from the workflow, under `xvfb-run -a`):

```sh
mise run test:logged -- --name native-menu-linux -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts application-menu-electron.spec.ts electron-cleanup.spec.ts renderer-log-boundary-electron.spec.ts --repeat-each=5 --retries=0
```

Failure: after the Help menu's Open Developer Tools item was clicked through
`MenuItem.click`, `expect.poll(devToolsOpen).toBe(true)` (line 87) saw
`isDevToolsOpened()` false for the whole default five-second poll
(`Timeout 5000ms exceeded while waiting on the predicate`). The menu item was
present, so `reportRendererDebug(true)` had taken effect. The trace has no
browser output after the click. The four later repetitions of the same test in
that job passed, and so did the macOS and Windows jobs of the run.

The branch did not touch the spec, its fixture
(`e2e/fixtures/application-menu-electron.ts`) or
`apps/desktop/electron/renderer-debug-tools.ts`; the workflow ran because the
branch changed `GlobalSettings*`.

## Isolated rerun

On this host (Linux, no display, Xvfb not allowed), headless:

```sh
ORKESTRATOR_AGENT_TEST_HEADLESS_ELECTRON=1 mise run test:logged -- --name native-menu-headless -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts application-menu-electron.spec.ts -g "Open Developer Tools" --repeat-each=10 --retries=0
```

Passed 10 of 10 (59.1 s) on 2026-11-10 at `53340356c`. This is weaker
evidence than an Xvfb rerun: headless Electron does not create the detached
DevTools window the way Xvfb does.

## Assessment

`openDevTools({ mode: "detach" })` creates a separate window and
`isDevToolsOpened()` turns true only once the DevTools front end has loaded
in it. The failure was in the first repetition, which starts Electron and the
DevTools front end on a cold runner. A slow first load past five seconds is
a plausible cause but unconfirmed. No assertion, timeout or retry was changed.

## Next evidence

- If it recurs, attach the Electron main-process log and a screenshot of the
  Xvfb display at the poll's end, to tell a DevTools window that is still
  loading from one that was never created.
- Run the spec alone on `ubuntu-latest` under `xvfb-run` with
  `--repeat-each=20` and record first-repetition timings for the DevTools
  load before deciding whether the test should await the `devtools-opened`
  event instead of polling.
