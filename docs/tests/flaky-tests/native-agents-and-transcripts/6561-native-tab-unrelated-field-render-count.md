# Native tab render count after an unrelated environment update

- **ID:** 6561
- **Status:** open
- **Observed:** 2026-11-06 on macOS
- **Test:** `an unrelated environment field does not render a tab holding a transcript`
- **File:** `apps/web/src/components/native-agent/AgentNativeTab.render-count.test.tsx:365`
- **Original command:** `mise run test:logged -- --name review-default-tests -- mise run test`, at `a563467df`.
- **Workers:** the web package used two workers in the concurrent default aggregate. A five-worker component-browser run was also active during this round.
- **Failure:** expected zero commits after the unrelated field write, received two; 1872.79 ms.
- **Aggregate totals:** web package: 13,051 passed, 10 skipped, five failed and one error; 13,066 tests across 860 files in 874.91 s. The broader workspace group remained non-green.

The unchanged complete owner passed alone, exit 0, in 7.5 s:

```sh
mise run test:logged -- --name review-native-render-owner -- bun --cwd=apps/web test src/components/native-agent/AgentNativeTab.render-count.test.tsx --parallel=1 --only-failures
```

Passing output was deleted by the logged runner, so individual passing counts
were not retained. Aggregate evidence is
`/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.Mv0c3i/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

The isolated pass establishes intermittence, not its cause. A late initial
render overlapping the measurement is a hypothesis; this run did not trace
the two commits. The branch changes the native tab controller, so this entry
does not establish that the failure is unrelated. No test, assertion, timeout
or implementation was changed to hide the failure.
