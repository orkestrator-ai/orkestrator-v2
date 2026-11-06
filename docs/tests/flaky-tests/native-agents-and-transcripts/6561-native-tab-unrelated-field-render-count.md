# Native tab render count after an unrelated environment update

- **ID:** 6561
- **Status:** resolved
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

### Resolution — 2026-11-06

- **Root cause:** the fixture's progressive-read mocks answered every read with a full `snapshot`, including the tab's background polls (every 500-1500 ms) that send the `knownToken` they already hold. Each identical snapshot committed the tab. A commit timeline of the first test showed two or three such poll commits within 3.6 s of mount, 0.7 s after `settle()` returned on a quiet host. When a loaded host stretched the initial render, `settle()` ended close to the next poll tick and its commits landed inside the "zero commits" measurement. The environment-store selectors were never involved.
- **Reproduced:** yes. Holding the tab for 3 s after `renderTab()` and before `writeUnrelatedFields()` failed the unchanged test with 3 commits instead of 0.
- **Fix:** `AgentNativeTab.render-count.test.tsx` now answers the transcript, session-state and discovery reads the way the backend does: `unchanged` when the read names the current token and does not force a snapshot, a snapshot otherwise. Tokens now include the tab's session key, and the state token includes the queued items, so a changed fixture still produces a new snapshot. No assertion, timeout or product code changed.
- **Verification:** with the 3 s and 7 s holds in place (temporary), the test passed with 0 commits. `mise run test:logged -- --name n6561-owner -- bun --cwd=apps/web test src/components/native-agent/AgentNativeTab.render-count.test.tsx --rerun-each=5` passed. `mise run test:logged -- --name n6561-stress -- bun --cwd=apps/web test src/components/native-agent/AgentNativeTab.render-count.test.tsx src/components/native-agent/AgentNativeTab.progressive.test.tsx --parallel=2 --rerun-each=4` passed 316 tests with 0 failures, at a host load average of about 20-30.
