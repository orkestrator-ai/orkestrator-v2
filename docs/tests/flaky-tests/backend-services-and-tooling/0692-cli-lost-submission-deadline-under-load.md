# CLI lost-submission lookup misses the shared deadline under load

- **ID:** 0692
- **Status:** open
- **Date observed:** 2026-10-22
- **Test:** `waiting through a lost submission response > submission and an absent-key lookup share one deadline`
- **File:** `packages/cli/tests/client-waits.test.ts:351`
- **Original command:** `mise run test:logged -- --name complete-tests -- mise run test`, default 4/1/2/1 workspace/root/bridge/protocol reservations; CLI used two isolated Bun workers while browser validation ran concurrently.
- **Failure:** the 300 ms shared deadline yielded zero lookups instead of one (321.23 ms observed).
- **Suite counts:** CLI reported 178 passed, one failed across 179 tests in 14 files (34.93 s).
- **Owning-file rerun:** `mise run test:logged -- --name cli-waits-owner -- bun test --cwd packages/cli --preload ../../tests/setup-node.ts ./tests/client-waits.test.ts --parallel=1 --only-failures` passed unchanged (exit 0, 7.4 s).
- **Evidence:** `orkestrator-test-run.92oAQN/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` under the host temporary directory after aggregate completion; outer run `orkestrator-test-run.6yesvR`.
- **Hypothesis:** concurrent load consumes the remainder of the short deadline after the delayed submission; unconfirmed. No CLI implementation, assertion, timeout or skip changed.

The final-source retry, `mise run test:logged -- --name final-complete-tests -- mise run test`, passed every non-iOS group (exit 0, 454.4 seconds). Root/support passed in 141.5 seconds.

## Coordinator adapters main merge — 2026-10-24

Original command: `ORKESTRATOR_TEST_AREA_BASE=$(git merge-base HEAD MERGE_HEAD) mise run test:logged -- --name merge-tests -- mise run test`, workspace/root/bridges/protocol reservations 4/1/2/1. The shared-deadline case failed after 333.11 ms. `mise run test:logged -- --name merge-owner-cli-waits -- bun --cwd=packages/cli test --preload ../../tests/setup-node.ts ./tests/client-waits.test.ts --parallel=1 --only-failures` passed the complete unchanged owner (7.5 s).

Full failure names, counts, evidence paths and unresolved limitations are in [0724](../aggregate-validation-runs/0724-coordinator-adapters-main-merge-validation.md). No implementation, assertion, timeout or skip changed. The original aggregate remains non-green.

## Design resume identity review — 2026-10-25

- **Original command:** `mise run test:logged -- --name resume-repository -- mise run test`; workspace reservation four slots, CLI two isolated Bun workers, with other checkouts sharing the host.
- **Failure:** the shared 300 ms deadline yielded zero lookups instead of one (315.04 ms). CLI: 255 passed, one failed across 256 tests in 23 files (35.57 s).
- **Complete unchanged owner:** `mise run test:logged -- --name resume-cli-waits-owner -- bun test --cwd packages/cli --preload ../../tests/setup-node.ts ./tests/client-waits.test.ts --parallel=1 --only-failures` passed (exit 0, 7.8 s).
- **Evidence:** `orkestrator-test-run.gciHk4/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory; compressed from partial inner logs after the outer watchdog stopped the run. Outer run: `orkestrator-test-run.aqhArP/`.
- **Assessment:** confirmed recurrence; no CLI code, assertion, deadline or skip changed. The original aggregate remains failed.

- **Final aggregate result for this recurrence:** incomplete after the outer 30-minute watchdog stopped the remaining backend run, with observed failures preserved.
