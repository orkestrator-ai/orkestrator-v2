# Pi staged runtime load timeout

- **ID:** 0178
- **Status:** open
- **Date observed:** 2026-10-02
- **Original command:** `mise run test:logged -- --name steer-suite -- mise run test`
- **Worker configuration:** normal aggregate host allocation; root and agent-support group used three workers. Browser validation also ran on the host.
- **Failure:** `Pi bridge runtime vendoring > loads Pi's supported SDK from the staged runtime closure` in `tests/unit/pi-bridge-vendor.test.ts` exhausted its 30-second test timeout (30002.12 ms).
- **Isolated rerun:** `mise run test:logged -- --name steer-pi-vendor-isolation -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` passed in 4.5 seconds.
- **Evidence:** aggregate artifact `orkestrator-test-run.kPWByh/root-and-agent-support-tests.log.gz`; aggregate failed with this single root test failure. Workspace and protocol groups passed.
- **Hypothesis:** staging and loading the SDK runtime took longer under aggregate host load. The steering fixes do not change Pi runtime vendoring. No timeout was raised and no test was skipped; the cause remains unconfirmed.
