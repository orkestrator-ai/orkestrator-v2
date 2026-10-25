# Address-pool error fixture times out in aggregate validation

- **ID:** 0724
- **Status:** open
- **Date observed:** 2026-10-24
- **Test:** `environment networks > reports exhausted address pools without falling back`
- **Owning file:** `apps/backend/tests/container-network.test.ts`
- **Original command:** `mise run test:logged -- --name watcher-full-suite -- mise run test`
- **Worker configuration:** the standard aggregate leases; workspace reserved four slots and backend used two isolated workers. Other checkout validation was active on the host.
- **Failure:** Bun's five-second default expired at 5000.28 ms, with a dangling process killed.
- **Owning-file rerun:** `mise run test:logged -- --name watcher-network-owner -- bun test --cwd <checkout>/apps/backend ./tests/container-network.test.ts --parallel=1 --only-failures` passed unchanged in 6.4 seconds.
- **Hypothesis:** the subprocess fixture crossed its outer deadline in the aggregate. The owner pass establishes intermittence; no root cause has been isolated. The failing network-creation behavior was not modified by the worktree signal fixes.
- **Evidence:** `orkestrator-test-run.iTzv5K/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` under the host temporary directory. The aggregate result remains failed.
- **Final aggregate counts:** backend 10705 passed, 116 skipped, 20 failed and five between-test errors across 10841 tests (747.20 seconds). Fourteen failures were the unchanged OpenCode conformance expectation for CLI 1.19.0 versus the installed 1.19.4; the other six were the timing cases recorded here and in companion records. The complete repository run exited 1 after 1189.0 seconds, including time queued for shared worker capacity.

## Triage 2026-10-25

- **Disposition:** open.
- **Evidence:** single observation. The case (`container-network.test.ts:102`) runs a subprocess fixture under Bun's default five seconds; the file has no explicit budgets.
- **Next step:** give the case an explicit budget if it recurs; if it does not recur by the next sweep, reclassify it as environmental.
