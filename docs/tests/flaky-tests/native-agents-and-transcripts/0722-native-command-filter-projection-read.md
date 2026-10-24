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
