# Native command filtering observes an extra projection read

- **ID:** 0722
- **Status:** open
- **Date observed:** 2026-10-24
- **Test:** `AgentNativeTab commands > typing after the sigil filters a maximal list without fetching, refreshing or scanning`, `apps/web/src/components/native-agent/AgentNativeTab.commands.test.tsx:607`.
- **Original command:** `ORKESTRATOR_TEST_AREA_BASE=8454d18b8648d7482897c2544b538f0d915bc18c mise run test:logged -- --name merge-repository -- mise run test`, merging parents `e35d581044e5627566c5dbe06f908977ced611e3` and `712274379cc0a83226b8d2ab4b04e9a329fbcb14` on macOS with Bun 1.4.3. Workspace/root/bridges/protocol reserved 4/1/2/1 slots; the web package used two isolated Bun workers alongside nine component-browser workers and other worktrees.
- **Failure:** expected one projection read, received two, after 2146.28 ms. The web package reported 9183 passed, ten skipped and one failed across 9194 tests in 572 files (452.83 s).
- **Complete unchanged owner:** `mise run test:logged -- --name merge-native-commands-owner -- bun test --cwd apps/web ./src/components/native-agent/AgentNativeTab.commands.test.tsx --parallel=1 --only-failures` passed, exit 0 in 6.1 s.
- **Evidence:** host temporary artifact `orkestrator-test-run.GCa83B/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Assessment:** an intermittent extra read; this observation does not establish its cause. No implementation, assertion, timeout or skip changed. The original aggregate remains failed.


## Per-machine accounts merge — 2026-10-24

- **Parents:** feature `9f67a5963` and main `5282e441a`.
- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`; workspace/root/bridge/protocol reservations 4/1/2/1, two web workers, alongside component and isolated browser suites and other worktrees.
- **Failure:** the same projection-read assertion expected one read and received two after 1637.28 ms.
- **Complete unchanged owner:** `mise run test:logged -- --name merge-native-command-owner -- bun test --cwd apps/web ./src/components/native-agent/AgentNativeTab.commands.test.tsx --parallel=1 --only-failures` passed, exit 0 in 5.2 s logged.
- **Evidence:** `orkestrator-test-run.jFRynx/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` under the host temporary directory after aggregate completion.
- **Assessment:** confirmed recurrence of the existing extra projection read. No implementation, assertion, timeout or skip changed for this test.


## Latest-main refresh of per-machine accounts — 2026-10-24

- **Parents:** merge `e25b6123` and main `553da7f54`.
- **Original command:** `mise run test:logged -- --name update-main-tests -- mise run test`; workspace/root/bridge/protocol reservations 4/1/2/1 alongside component/isolated-browser validation, with two web workers.
- **Failure:** Native-command filtering again observed an extra projection read (1977.52 ms).
- **Complete unchanged owner:** `mise run test:logged -- --name update-native-command-owner -- bun test --cwd apps/web ./src/components/native-agent/AgentNativeTab.commands.test.tsx --parallel=1 --only-failures` passed, exit 0 in 4.3 s logged.
- **Evidence:** `orkestrator-test-run.fA9A1i/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` under the host temporary directory after aggregate completion.
- **Assessment:** confirmed recurrence of the existing intermittent failure. No implementation, assertion, timeout or skip changed.
