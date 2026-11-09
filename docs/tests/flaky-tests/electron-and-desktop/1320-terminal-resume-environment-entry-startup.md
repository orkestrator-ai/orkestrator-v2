# Terminal resume environment entry misses its startup deadline

- **ID:** 1320
- **Status:** open
- **Date observed:** 2026-10-30
- **Test:** `Electron keeps a lost terminal write fenced until Resume, without restarting the PTY`
- **File:** `e2e/agent-testing/terminal-input-resume-electron.spec.ts:100`
- **Original command:** `mise run test:logged -- --name agent-electron -- mise run test:agent:electron`
- **Failure:** preparation reported 43 passed, two skipped and one failed (730.1 s logged). `openEnvironment` timed out at `entry.click()` after 20 seconds. The locator log shows the startup handler dismissing `Continue Without GitHub CLI` before waiting for the environment entry again. This differs from the startup-title symptom in case 0470.
- **Owning file rerun:** `mise run test:logged -- --name terminal-resume-owner -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts e2e/agent-testing/terminal-input-resume-electron.spec.ts --workers=1` passed unchanged (one test, 14.6 s logged).
- **Full rerun:** the exact original command passed (45 passed, two skipped, 398.0 s logged), including terminal resume and every annotation scenario.
- **Cause:** unconfirmed; the startup dialog coincided with the failed navigation. No assertion, timeout, skip, or terminal behavior changed.
- **Evidence:** preparation's `.orkestrator/review-artifacts/review-validation-a8c0e711-25a8-4c84-a30d-03f93a79008b/validation-06.stderr.txt` and bounded failure log `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.hnDoI9/`.

## 2026-11-04 qualification follow-up

Review preparation at `3e14a9bab` reported a different failure in the same test:
`Terminal input failed` never appeared, with the reachability dialog handler
running during the toast assertion. The round's exact Electron command rerun
finished with 29 passed, 11 failed, one skipped and 19 not run (636.3 s), and
this case failed earlier on the initial editor-text assertion. Evidence:
`/tmp/orkestrator-test-run.zRQGtm/agent-electron.log.gz`.

The owning file reproduced the editor-text failure alone. Qualification repairs
restore focus before raw input, wait for the empty editor's ruler rather than
the echoed shell command, and insert the initial text in one chunk so nvim's
per-keystroke redraws do not split it. Refocusing uses a trial click away from
the persistent toast followed by xterm textarea focus: a real click changes
vim's cursor. The exact saved-file and shell-PID assertions remain unchanged.

`mise run test:logged -- --name terminal-electron-owner -- bunx playwright test
--config e2e/agent-testing/playwright.electron.config.ts
e2e/agent-testing/terminal-input-resume-electron.spec.ts --workers=1` passed
(one test, 13.9 s) after these repairs. Earlier isolated failures are retained at
`/tmp/orkestrator-test-run.ey52za`, `/tmp/orkestrator-test-run.fbfqeI`,
`/tmp/orkestrator-test-run.SUsZf8` and `/tmp/orkestrator-test-run.bDd0iF`.
This does not establish the cause of the original environment-entry timeout;
case 1320 remains open for that distinct symptom.

## 2026-11-09 Vim readiness follow-up

Electron 45.2.3 qualification on mini at `4087ff472` reported 68 passed,
5 skipped and 1 failed with one worker (652.2 s): terminal resume waited for
`resume.txt` and `0,0-1`, but the empty editor displayed no ruler. The unchanged
owner reproduced the same assertion alone (1 failed, 13.6 s), so this symptom
is deterministic rather than a new flake recurrence. Mini uses `/usr/bin/vim`
9.1; `vim -u NONE -N -n -es -c 'set ruler?' -c 'qa!'` reports `noruler`.

The fixture now starts its editor with `-c "set ruler"`. It retains the
readiness assertion, saved-file check and same-shell PID checks. The owning
file passed with the change (1 passed, 14.2 s):
`ORKESTRATOR_AGENT_TEST_RUN_ID=address-terminal-fixed mise run test:logged -- --name address-electron-terminal-fixed -- mise run test:agent:electron -- e2e/agent-testing/terminal-input-resume-electron.spec.ts`.
This fixes the editor-default assumption without establishing a cause for the
original environment-entry symptom; case 1320 remains open.

Evidence: `output/agent-testing/electron-smoke/electron/results.json` and
`output/agent-testing/address-terminal-owner/electron/results.json`;
compressed logs under `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.0nN8YW/`
and `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.EXidlT/`.

The final exact Electron suite rerun with the ruler fixture passed (69 passed,
5 skipped, 611.7 s):
`ORKESTRATOR_AGENT_TEST_RUN_ID=address-electron-final mise run test:logged -- --name address-electron-final -- mise run test:agent:electron`.
Evidence: `output/agent-testing/address-electron-final/electron/results.json`.
An intervening adjacent-port setup failure is tracked separately as
[9902](../previews-annotations-and-gateway/9902-seeded-preview-adjacent-port-reservation.md).
