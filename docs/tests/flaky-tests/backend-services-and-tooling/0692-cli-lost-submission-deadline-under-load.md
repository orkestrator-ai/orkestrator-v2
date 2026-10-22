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
