# Windows native menu: Electron closes after DevTools opens

- **ID:** 9929
- **Status:** open
- **Date observed:** 2026-11-10

Test: `Help offers Open Developer Tools only while a renderer has debug logging on`
in `e2e/agent-testing/application-menu-electron.spec.ts`.

Workflow: "Native application menu", job `Native menu (windows-latest)`. No
existing index entry matched this test; this records a new case, not a
counted recurrence.

## Observations

Both failures are on `windows-latest` only, in one of the five
`--repeat-each=5 --retries=0` repetitions. The Linux and macOS jobs of the same
runs passed.

| Run | Branch | Head | Merge base with `main` | Repetition | Result |
| --- | --- | --- | --- | --- | --- |
| 42751443658 | `effect-adoption-abb590f0b0d0-r1` | `962d512b` | `04639b12` | 3 of 5 | 1 failed, 14 passed (1.0 m) |
| 42811193704 | `electron-sigtrap-crash-15d5092711e3-r1` | `12447425` | `4dc220f7` | 2 of 5 | 1 failed, 14 passed (1.1 m) |
| 42846589920 | `chore/release-2.37.4-beta` | `28ed0507` | `a57ea870` | 3 of 5 | 1 failed, 14 passed (1.2 m) |

Original command (from the workflow):

```sh
mise run test:logged -- --name native-menu-windows -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts application-menu-electron.spec.ts electron-cleanup.spec.ts --repeat-each=5 --retries=0
```

Failure, identical in both runs: the menu item opened DevTools,
`expect.poll(devToolsOpen).toBe(true)` passed, and the next main-process call
(line 88, `closeDevTools()` over `electronApplication.evaluate`) failed with
`Target page, context or browser has been closed`. The Electron browser log's
last line in both runs was
`ERROR:third_party\crashpad\crashpad\client\crashpad_client_win.cc:887] not connected`.

The next run of the same workflow on each branch passed every repetition on
Windows (42811237362 on `electron-sigtrap-crash-15d5092711e3-r1`; 42782130200
and 42782180949 on `effect-adoption-abb590f0b0d0-r1`). Those are reruns of the
whole job on a later head, not an isolated rerun of the owning file on the
same host. The failure could not be rerun here: this host is Linux, and the
spec's DevTools path is only exercised under the Windows job.

## Recurrence (2026-11-10)

Run 42846589920, the release pull request for 2.37.4-beta (merged as
`53340356c`), failed the same way: repetition 3 of 5 (`-repeat2`), the
`closeDevTools()` evaluate at line 88 answered `Target page, context or
browser has been closed`, and the Electron log's last line was the same
crashpad `not connected`. The release branch changed only version numbers.
`mise run flaky:recurrence -- 9929 --base 53340356c --registry-ref origin/main`
answered **open**, so this is counted as a recurrence. Still Windows only;
the Linux failure of the same test on run 42833338750 has a different
symptom and is [9933](9933-linux-native-menu-devtools-open-poll.md).

## Assessment

The Electron process (or its only window) went away between DevTools opening
and the test closing it; the test did not reach its own close. Cause
unconfirmed. Neither failing branch touched the fixture
(`e2e/fixtures/application-menu-electron.ts`) or the spec. No assertion,
timeout or retry was changed for this record.

## Next evidence

- Download the `error-context.md` and `trace.zip` artifacts from a failing run
  and check whether the main process exited (exit code, crash dump) or only
  the window closed.
- If it recurs, run the spec alone on `windows-latest` with
  `--repeat-each=20` to measure the rate before changing the fixture.
