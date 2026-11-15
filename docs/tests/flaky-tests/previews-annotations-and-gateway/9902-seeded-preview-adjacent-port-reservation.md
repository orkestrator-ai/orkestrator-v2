# Seeded preview setup cannot find adjacent free ports

- **ID:** 9902
- **Status:** open
- **Date observed:** 2026-11-09
- **Observing branch base:** `64a5b4cfb207820f07956615e43be7791bb56b05`
- **Test:** `1. the browser button opens the seeded service, which waits for this environment's server and loads once Run starts it`
- **File:** `e2e/agent-testing/service-preview-seeded-electron.spec.ts:567`
- **Original command:** `ORKESTRATOR_AGENT_TEST_RUN_ID=address-electron-fixed mise run test:logged -- --name address-electron-rerun -- mise run test:agent:electron`
- **Worker configuration:** one Playwright worker on mini, macOS arm64, Electron 45.2.3; commit `54aead6ff`.
- **Failure:** the file's beforeAll threw `No two adjacent free loopback ports` at `freePortPair` line 128, called at line 495. The test body never started. Suite: 63 passed, 1 failed, 5 skipped, 5 did not run; 583.7 s logged.
- **Isolated rerun:** `ORKESTRATOR_AGENT_TEST_RUN_ID=address-seeded-owner mise run test:logged -- --name address-electron-seeded-owner -- mise run test:agent:electron -- e2e/agent-testing/service-preview-seeded-electron.spec.ts` passed unchanged: 6 passed, 12.1 s logged.
- **Evidence:** `output/agent-testing/address-electron-fixed/electron/results.json`, `output/agent-testing/address-seeded-owner/electron/results.json`, and `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.4IsZos/address-electron-rerun.log.gz`.
- **Cause:** not established. The helper rejects base ports at or above 65000 and probes the next port after releasing the base reservation. Candidate ports and bind errors were not captured, so neither a rejected high port nor a competing listener is proven. No application code, assertion, timeout or skip was changed for this observation.
- **Related:** [4470](4470-seeded-preview-moved-port-link-not-printed.md) concerns a later moved-port terminal-link wait, a different failure.

The final exact full-suite rerun passed: 69 passed, 5 skipped, 611.7 s,
`ORKESTRATOR_AGENT_TEST_RUN_ID=address-electron-final mise run test:logged -- --name address-electron-final -- mise run test:agent:electron`.
Evidence: `output/agent-testing/address-electron-final/electron/results.json`.
The allocation helper remains unchanged and this case stays open.

## Observation, 2026-11-15 (mbp3)

A different symptom in the same test. On `mbp3` (MacBook Pro, macOS 27.2,
Apple M5 Max, two external displays; Electron 45.2.3), observing branch base
`a8b89f154`, one Playwright worker, a host loaded by other builds (load
averages 79 to 169 on 18 cores between runs), the full suite
`ORKESTRATOR_TEST_GROUP_TIMEOUT_MS=5400000 ORKESTRATOR_AGENT_TEST_SHOWN_WINDOWS=1 mise run test:logged -- --name t2181-mbp3-electron -- mise run test:agent:electron`
failed this test with `electronApplication.firstWindow: Timeout 90000ms
exceeded while waiting for event "window"` (`service-preview-electron-launch.ts:154`;
Vite was ready in 1 s and Electron printed nothing), and the run then reported
`Worker teardown timeout of 120000ms exceeded` for it. Suite: 37 passed,
38 skipped, 7 failed, 952.6 s. The port helper did not fail this time. Rerun
alone after rebasing onto `47110af03`:
`ORKESTRATOR_AGENT_TEST_RUN_ID=t2181-alone-5 mise run test:logged -- --name t2181-alone-5 -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts service-preview-seeded-electron.spec.ts:567`
passed. Recorded with the rest of that run in to-do
[2181](../../todo/cross-cutting/2181-dev-test-electron-opens-on-the-linux-desktop.md)
("Real-display run on mbp3") and
[8300](../../todo/cross-cutting/8300-electron-suite-on-a-shared-mac-desktop.md).
Cause not established; the case stays open.
