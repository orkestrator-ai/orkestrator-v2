# Looped review reconciliation times out during main merge validation

- **ID:** 0516
- **Status:** resolved
- **Date observed:** 2026-10-21
- **Test:** `LoopedReviewService > applies new, updated, existing, and coverage-gap reconciliation across allowance rounds`
- **Owning file:** `apps/backend/src/core/looped-review-service.test.ts`
- **Original command:** `mise run test:logged -- --name merge-suite -- mise run test`, merging `origin/main` (`d4171748`) into `5eb444af`. Aggregate reservations were 4/1/2/1 for workspace/root/bridges/protocol; backend used two isolated Bun workers. Browser and Electron validation also ran on the shared host.
- **Failure:** exceeded the 5,000 ms test deadline (8,567.05 ms).
- **Owning-file rerun:** `mise run test:logged -- --name merge-looped-review-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/looped-review-service.test.ts --parallel=1 --only-failures` passed the entire unchanged file, exit 0 in 96.2 seconds.
- **Evidence:** `orkestrator-test-run.0xWTT4/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory; outer run `orkestrator-test-run.s48Tpm`.
- **Hypothesis:** shared-host contention may delay asynchronous work and timeout delivery; load averages above 120 were observed during this run. The cause is not established.
- **Changes:** evidence only; no implementation, assertion, timeout or skip changed.

## Other validation evidence from this merge

- Formatting, lint, all typechecks, the desktop build, changed backend/desktop owners, and both container marker regression owners passed. Touched TypeScript files passed lint with warnings denied. Relative documentation links were checked, including correcting an incoming reference from the nonexistent `0512-terminal-history-backward-page-count.md` to `0513`.
- `merge-docker` (`mise run test:agent:docker`) passed in 90.8 seconds on credential-free fixture profile `merge-credential-docker-20261021`. `dev:stop` and `dev:reset` passed; two exact-owner containers, four volumes, one network and disposable profile state were removed.
- `merge-electron` reported 21 passed, one skipped and one failed in 242.2 seconds. The whole unchanged owning file passed on rerun; see [0515](../electron-and-desktop/0515-electron-nickname-reload-timeout.md).
- `merge-browser` (`mise run test:agent:browser:isolated`) reached its overall deadline after starting 60 of 70 scenarios, without a completed Playwright result summary. It exited 1 after 924.7 seconds. The runner stopped and reset `qa-browser-f2d4f116-b9d`; no profile state was retained. Evidence: `orkestrator-test-run.6OrGbg/merge-browser.log.gz`. This is incomplete browser validation, not a passing suite or a confirmed flaky test.
- The aggregate Codex runtime-helper timeout passed unchanged in its owner rerun; see [0093](../agent-bridges/0093-runtime-environment-refresh-sources-configured-r.md).
- Pi runtime staging exceeded 30,000 ms in root/support and again in the unchanged owning-file rerun (`merge-pi-vendor-owner`, 33.8 seconds logged, three passed and one failed). This observation does not independently establish intermittence; see [0178](../agent-bridges/0178-pi-vendor-runtime-aggregate-timeout.md). Evidence: `orkestrator-test-run.HhNeb2/merge-pi-vendor-owner.log.gz`.
- CLI scenarios, iOS, component/public-site browser and design-only suites were omitted because their implementation areas were unchanged by this merge. Credentialed provider probes retained their opt-ins.

- OpenCode execution-policy qualification failed in both aggregate and the whole unchanged owner. `mise run test:logged -- --name merge-conformance-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/conformance-execution-policy.test.ts --parallel=1 --only-failures` reported 57 passed, 13 failed and 12 between-test errors across 70 cases (282.4 seconds). Every OpenCode shape exceeded 20,000 ms; terminated subprocesses reported exit 143. Evidence: `orkestrator-test-run.cLwbau/merge-conformance-owner.log.gz`. This remains unresolved and is not classified as a flake.
- The unchanged container preview containment owner passed alone; see [0517](../design-canvas-and-artifacts/0517-container-preview-containment-merge-timeout.md).

## Aggregate outcome

`merge-suite` exited 1 at its 1,800.0-second absolute deadline. The logged runner
terminated the remaining workspace process tree; the workspace group never
published a complete result, so no complete non-iOS suite pass is claimed.
Protocol regeneration passed (1.7 seconds); bridges failed (173.6 seconds);
root/support failed (295.4 seconds, 3,151 passed, one skipped and one failed
across 3,153 tests in 149 files). The bridge failure was the Codex runtime helper
and the root failure was Pi runtime staging, described above.

The unfinished backend run also reported failures in filesystem, shell,
terminal-history, cleanup, provider-account and preview tests beyond the
confirmed reruns above. Those remaining failures were not individually
requalified and are not newly classified as flakes. The OpenCode owner stayed
non-green in its separate run. These are unresolved validation gaps, with no
assertions, timeouts, skips or product code changed to hide them. Shared-host
load was measured above 120, peaking near 140 during observation; it is a
possible contributor, not an established explanation for every failure.

Outer failure evidence: `orkestrator-test-run.s48Tpm/merge-suite.log.gz`.
The four private, bounded inner group logs in `orkestrator-test-run.0xWTT4/`
were compressed after the runner terminated because interruption prevented
the aggregate's normal finalization. No disposable browser or Docker profile
state was retained.

## Resolution (2026-10-28)

Retired, not fixed: the Looped Review feature was removed, and its owning test
file was deleted with it. The root cause was never confirmed. No surviving test
runs this case.
