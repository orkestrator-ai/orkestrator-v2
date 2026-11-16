# Address-pool error fixture times out in aggregate validation

- **ID:** 0724
- **Status:** resolved
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

## Resolution (2026-11-15)

- **Root cause:** The address-pool case runs fake Docker network commands; it exceeded Bun's 5 s default.
- **Fix:** `tests/default-test-timeout.ts`, imported by both shared preloads (`tests/setup-node.ts`, `tests/setup.ts`), makes 60 s the default per-test and hook budget, a hang watchdog only. The owning file sets no smaller file, test or hook budget, and the failing test has no inner wall-clock deadline of its own.
- **Reproduced:** no — the recorded deadline was Bun's default budget on a loaded host; the failing body is fast alone, and a 5 s exhaustion was not re-created per case here.
- **Stress:** `mise run test:logged -- --name ec-stress-b -- bash -c 'cd apps/backend && bun ../../scripts/test-under-contention.ts --core 13 --burners 6 -- bun test --preload ../../tests/setup-node.ts <seventeen container, pipeline, move, worktree and native-agent owners, this one included> --rerun-each=2 --parallel=1'` at host load about 80: 1,139 passed, 1 failed — `git fsmonitor > fixture repositories inherit fsmonitor off from the test preload` on its second rerun, which fails the same way without contention and with the unchanged file (`git-fsmonitor.test.ts` is not rerun-safe).
- **Base:** `a8b89f154` (working tree; flake sweep of 2026-11-15).
