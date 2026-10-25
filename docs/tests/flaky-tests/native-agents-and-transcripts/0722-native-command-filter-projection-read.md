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

## Annotation limitations main merge (2026-10-24)

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`, with `ORKESTRATOR_TEST_AREA_BASE=a5d78cfcd54907a13973463d4bd08497fd025c90` and the GNU shell-tool PATH from the testing guide.
- **Worker configuration:** two workspace package tasks, two Bun workers each; other worktrees were validating on the host.
- **Failure:** the maximal-list filtering case observed two projection reads instead of one at line 607 (3,085.34 ms).
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.8ZKWYk/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Isolated rerun:** `mise run test:logged -- --name merge-0043-rerun-commands -- bun test --cwd apps/web ./src/components/native-agent/AgentNativeTab.commands.test.tsx --parallel=1 --only-failures` passed unchanged (exit 0, 9.0 s).
- **Disposition:** recurrence confirmed by the complete owning-file pass. No assertion, deadline, or skip was changed.

## Design-agent links refresh through d6ed0717d — 2026-10-24

The combined merge repeated a failure in this owner during `mise run test:logged -- --name merge-tests -- mise run test` (workspace/root/bridge/protocol reservations 4/1/2/1, other worktrees active). The complete unchanged owner passed with one worker in 9.3 s: `mise run test:logged -- --name design-links-owner-native-commands -- bun test --cwd apps/web ./src/components/native-agent/AgentNativeTab.commands.test.tsx --parallel=1 --only-failures`. See [0772](../aggregate-validation-runs/0772-design-agent-links-main-refresh-validation.md) for the exact failing cases, durations, counts, parents and artifacts. No assertion, deadline or skip changed; shared-host contention remains a hypothesis.

## Container state observation main merge — 2026-10-24

- **Parents:** feature `66a9736cc0c663bef147a65fc2d158e1951482dd` and main `d6ed0717d00a9a04ba658ba6c50e0978bc2011a6`.
- **Original command:** `mise run test:logged -- --name merge-suite -- mise run test`; workspace/root/bridge/protocol reservations 4/1/2/1, alongside component, isolated-browser, Electron and Docker validation on the same host.
- **Aggregate failure:** the maximal command-list typing case expected one projection read and observed two (2526.47 ms).
- **Complete unchanged owner:** `mise run test:logged -- --name merge-native-commands-owner -- bun test --cwd apps/web ./src/components/native-agent/AgentNativeTab.commands.test.tsx --parallel=1 --only-failures` failed: 18 passed and one failed in 21.11 s; the same case observed three reads instead of one (3781.20 ms).
- **Evidence:** `orkestrator-test-run.bFHIz7/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and `orkestrator-test-run.4FzbbZ/merge-native-commands-owner.log.gz` below the host temporary directory.
- **Assessment:** this observation does not establish a new isolated pass or root cause. The command controller and this owner match the main parent; no implementation, assertion, timeout or skip changed.

## Environment marker review fixes — 2026-10-24

- **Checkout:** `environment-list-ui-748a3b304f7f-r1`, based on `a6ee3d224`.
- **Original command:** `mise run test:logged -- --name repository-tests -- mise run test`; workspace/root/bridge/protocol reservations 4/1/2/1 with two web workers, alongside component browser validation and other worktrees.
- **Failure:** expected one projection read and received two after 1708.00 ms. The web package reported 9461 passed, ten skipped and one failed across 9472 tests in 595 files (274.92 s).
- **Complete unchanged owner:** `mise run test:logged -- --name native-command-isolated -- bun test --cwd apps/web ./src/components/native-agent/AgentNativeTab.commands.test.tsx --parallel=1 --only-failures` passed, exit 0 in 6.8 s logged.
- **Evidence:** `orkestrator-test-run.bSoN4E/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` under the host temporary directory after aggregate completion.
- **Assessment:** recurrence of the existing intermittent extra projection read; shared-host contention remains a hypothesis. No native-command implementation, assertion, timeout or skip changed.

## Local preview discovery review — 2026-10-25

`mise run test:logged -- --name preview-repository -- mise run test` repeated the extra projection read (expected one, received two) at `AgentNativeTab.commands.test.tsx:607`, in 2981.50 ms. The web package used two isolated Bun workers; repository and browser validation were active on the shared host. The complete unchanged owner ran separately with `mise run test:logged -- --name preview-native-commands-owner -- bun test --cwd apps/web ./src/components/native-agent/AgentNativeTab.commands.test.tsx --parallel=1 --only-failures`: 18 passed, one failed (14.1 s). The same assertion received two reads in 2019.10 ms. This observation remains non-green in the owner and is not newly classified as a flake. No native-command implementation, assertion, timeout or skip changed. Evidence: `orkestrator-test-run.0vNQwf/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and `orkestrator-test-run.s52vMF/preview-native-commands-owner.log.gz` under the host temporary directory.
