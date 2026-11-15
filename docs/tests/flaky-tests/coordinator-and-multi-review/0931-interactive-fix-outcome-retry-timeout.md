# Interactive Fix outcome retry exceeds the state wait under load

- **ID:** 0931
- **Status:** resolved
- **Date observed:** 2026-10-25
- **Test:** `interactive Fix retries unknown outcome evidence and recovers`
- **File:** `apps/backend/src/core/multi-review-service.test.ts:11869`
- **Original command:** `mise run test:logged -- --name resume-repository -- mise run test`; default workspace/root/bridge/protocol reservations 4/1/2/1, with multiple checkout suites sharing host capacity.
- **Failure:** `runInteractiveFix` reached the five-second `waitUntil` deadline, throwing `Timed out waiting for Multi Review state` (5689.94 ms test duration).
- **Complete unchanged owner:** `mise run test:logged -- --name resume-multi-review-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/multi-review-service.test.ts --parallel=1 --only-failures` passed (exit 0, 55.6 s).
- **Evidence:** `orkestrator-test-run.gciHk4/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` under the host temporary directory; compressed from partial inner logs after the outer watchdog stopped the run. Outer run: `orkestrator-test-run.aqhArP/`.
- **Hypothesis:** concurrent host load delayed the retry/reconciliation work beyond the short state wait; not established as the root cause. No Multi Review implementation, assertion, deadline or skip changed. The original aggregate remains failed.

- **Suite result:** the outer 30-minute watchdog stopped the aggregate after a 876.2 s workspace capacity wait. Backend had three failed cases and no final test counts; the aggregate is incomplete, with its observed assertion failures preserved.

## Resolution (2026-11-15)

- **Class:** wall-clock deadline in the test helper (B). The test is now `interactive Address Findings retries %s outcome evidence and recovers` in `apps/backend/src/core/multi-review-service-part-4.test.ts` (renamed by c1eb2a042, file split since); it uses `runInteractiveAddressFindings` from `multi-review-service-test-support.ts`.
- **Root cause:** `waitUntil` in the test support gave each wait a 5 s wall-clock deadline. Every wait drives the workflow itself (`service.advanceNow` inside the predicate) and ends on the workflow's own state (`phase === "ready"`, `addressPromptPending`, `stepRuntimes.fix.completedAt`), so the deadline only measured host speed.
- **Fix:** `waitUntil`'s default is now 45 s and documented as a hang watchdog, below the 60 s default test budget so a stuck wait still names the state it waited for. The predicates, the read count (`reads === 3`) and the auto-PR assertions are unchanged.
- **Reproduced:** no; the 5.7 s observation was not recreated on this host.
- **Stress:** `mise run test:logged -- --name c0931 -- bun scripts/test-under-contention.ts --core 10 --burners 6 -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/multi-review-service-part-4.test.ts -t "outcome evidence" --rerun-each=5` passed (10.3 s).
