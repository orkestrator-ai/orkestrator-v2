# Container preview containment probe times out during merge validation

- **ID:** 0517
- **Status:** open
- **Date observed:** 2026-10-21
- **Test:** `credential isolation and resource escape > container isolation: no sink is reached and no canary leaves the worker`
- **Owning file:** `apps/backend/src/core/transcript-artifacts/preview-escape.test.ts`
- **Original command:** `mise run test:logged -- --name merge-suite -- mise run test`, merging `origin/main` (`d4171748`) into `5eb444af`, workspace/root/bridges/protocol reservations 4/1/2/1, backend with two isolated Bun workers. Other application validation also ran on the shared host.
- **Failure:** the blocked-request assertion expected a positive count but received zero at `expectContained` line 260; the case took 41,928.04 ms and logged `render_timeout`.
- **Owning-file rerun:** `mise run test:logged -- --name merge-preview-escape-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/transcript-artifacts/preview-escape.test.ts --parallel=1 --only-failures` passed the entire unchanged file, exit 0 in 61.5 seconds.
- **Evidence:** `orkestrator-test-run.0xWTT4/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory; outer run `orkestrator-test-run.s48Tpm`.
- **Hypothesis:** preview startup may time out before the adversarial requests are attempted under shared host load; load averages above 120 were observed during this run. No credential escape was established by this failure; the missing blocked-request observation prevents qualification.
- **Changes:** evidence only; no implementation, assertion, timeout or skip changed.
