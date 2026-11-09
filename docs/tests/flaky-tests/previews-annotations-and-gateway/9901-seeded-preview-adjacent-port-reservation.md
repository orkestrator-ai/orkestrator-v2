# Seeded preview setup cannot find adjacent free ports

- **ID:** 9901
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
