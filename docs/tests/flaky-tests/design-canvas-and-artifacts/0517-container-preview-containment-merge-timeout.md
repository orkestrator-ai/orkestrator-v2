# Container preview containment probe times out during merge validation

- **ID:** 0517
- **Status:** resolved
- **Date observed:** 2026-10-21
- **Test:** `credential isolation and resource escape > container isolation: no sink is reached and no canary leaves the worker`
- **Owning file:** `apps/backend/src/core/transcript-artifacts/preview-escape.test.ts`
- **Original command:** `mise run test:logged -- --name merge-suite -- mise run test`, merging `origin/main` (`d4171748`) into `5eb444af`, workspace/root/bridges/protocol reservations 4/1/2/1, backend with two isolated Bun workers. Other application validation also ran on the shared host.
- **Failure:** the blocked-request assertion expected a positive count but received zero at `expectContained` line 260; the case took 41,928.04 ms and logged `render_timeout`.
- **Owning-file rerun:** `mise run test:logged -- --name merge-preview-escape-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/transcript-artifacts/preview-escape.test.ts --parallel=1 --only-failures` passed the entire unchanged file, exit 0 in 61.5 seconds.
- **Evidence:** `orkestrator-test-run.0xWTT4/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory; outer run `orkestrator-test-run.s48Tpm`.
- **Hypothesis:** preview startup may time out before the adversarial requests are attempted under shared host load; load averages above 120 were observed during this run. No credential escape was established by this failure; the missing blocked-request observation prevents qualification.
- **Changes:** evidence only; no implementation, assertion, timeout or skip changed.

## Resolution (2026-11-15)

- **Class:** product deadlines in the test configuration decided the outcome, plus fixed sleeps around negative assertions (B).
- **Root cause:** the runner used its default readiness/wall budgets, so on a starved host the worker hit `render_timeout` before the hostile document had issued its requests, leaving nothing blocked for `expectContained` to count. Separately, `runPreview` slept 1.5 s before checking that no sink was reached, and the unrestricted control case slept 2.5 s and redirected on a 1.2 s timer, racing its own ICE (UDP) request.
- **Fix (`apps/backend/src/core/transcript-artifacts/preview-escape.test.ts`):**
  - The process and container runners get `GENEROUS_BUDGETS` (readiness 30 s, worker wall 90 s, operation 120 s). These are hang watchdogs: the cases end on the worker's own result.
  - `runPreview` replaces the sleep with `drainSinks()`, which sends a marker request on a fresh connection and a marker datagram, then waits until both sinks have processed them. Egress the terminated worker sent earlier has been recorded by then; the drain's own connection is not counted.
  - The control case waits on sink events (`untilObserved`) until every sink except the redirect has been reached, then navigates to the redirect itself and waits for it. `setContent` uses `waitUntil: "commit"`, because without the timed redirect the page's `load` stays pending. The test budgets (240 s, 300 s) are watchdogs over those waits.
  - Every assertion is unchanged.
- **Reproduced:** no. The unchanged file passed under `--core 11 --burners 6` with `--rerun-each=2`. On this host the container case itself is skipped, because the `orkestrator-artifact-preview-worker:1` image is absent; only the process-mode case and the control case ran.
- **Stress:** `mise run test:logged -- --name new0517c -- bun scripts/test-under-contention.ts --core 11 --burners 6 -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/transcript-artifacts/preview-escape.test.ts --rerun-each=3` passed (127.6 s; container case skipped). An earlier run without `waitUntil: "commit"` failed in the control case (`setContent` timed out waiting for `load`), which led to that change.
- **Not verified:** the container case under load.
