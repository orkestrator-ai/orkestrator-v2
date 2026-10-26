# Transcript-scroll review validation

- **ID:** 0958
- **Status:** open
- **Date observed:** 2026-10-26
- **Change under test:** release follow for idle, unclassified upward departures; document the public at-bottom UI contract; deterministic latest-arrival lifecycle and browser regressions.

`mise run test:logged -- --name repository-tests -- mise run test` exited 1
in 708.2 s. Web reported 9,845 passed, 10 skipped and zero failed. All other
workspace packages except backend passed, as did bridges and the protocol
lockfile. Backend reported 11,785 passed, 97 skipped and two failures in
`apps/backend/src/core/environment-move.test.ts`, both five-second timeouts:

- `move_environment > a failed submodule re-link restores the original checkout`
  (5,049.66 ms).
- `restart recovery re-links submodules of an adopted or abandoned copy`
  (5,048.09 ms), previously tracked in
  [0248](../environments-and-containers/0248-move-restart-recovery-submodule-timeout.md).

The complete unchanged backend owner passed with one worker in 41.2 s:
`mise run test:logged -- --name environment-move-owner -- bun test --cwd apps/backend ./src/core/environment-move.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures`.
No backend implementation, assertion, timeout or skip changed.

The original root group exercised an intermediate scroll implementation and
failed the growth/follow-pause hook regression. That implementation was
replaced, not classified as a flake. The final controller regressions and all
90 hook cases passed. The complete root and agent-support group then passed
with two workers in 78.8 s (`final-root-tests`). Compensation fixtures now
model an actual shrinking scroll height, and the pointer-release test also
checks that compensation leaves the navigation generation unchanged.

`mise run test:logged -- --name browser -- mise run test:browser` reported
744 passed, 102 skipped and 20 failed in 381.0 s. Source edits continued during
this intermediate run, so it is not proof of the final implementation. Failures
were in AgentLaunchDialog, desktop MonacoRuntime, eight desktop MultiReviewFlow
phase cases and nine desktop TranscriptArrival cases.

After the final controller change, the complete four owning browser files ran
with one worker on fixture port 1439:
`ORKESTRATOR_E2E_PORT=1439 mise run test:logged -- --name browser-failures-isolated -- bunx playwright test --config e2e/playwright.config.ts AgentLaunchDialog.spec.ts MonacoRuntime.spec.ts MultiReviewFlow.spec.ts TranscriptArrival.spec.ts --workers=1`.
This reported 121 passed, five skipped and two failed in 193.2 s. Only the
native branch suggestion remained broken on both viewports (`rel` rather than
`release/2.0`), matching the previously established base-commit failure in
[0825](0825-dependency-upgrades-0032-validation.md). No assertion, timeout or
skip in those four owners changed.

The final `NativeFollowStability.spec.ts` owner passed all four desktop/mobile
cases in 7.7 s with two workers on port 1439. It covers both streaming without
button flicker and a bare programmatic departure that remains away after the
dock lays out. `mise run check` passed. The initial component failure prevented
the chained public-site suite from starting; its separate one-worker run
passed in 15.5 s (`public-browser`, port 1440).

Evidence under the host temporary directory:

- `orkestrator-test-run.WHy6xi/repository-tests.log.gz` and
  `orkestrator-test-run.h6nVWG/` (original repository group logs).
- `orkestrator-test-run.8qQ7JR/browser.log.gz` (original browser run).
- `orkestrator-test-run.SFkyGa/browser-failures-isolated.log.gz` (owning browser reruns).

The broad commands remain non-green. Backend owner intermittence is confirmed;
shared-host contention is a hypothesis. The final focused scroll checks pass.
