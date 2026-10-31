# Reconnect freshness review-fix validation

- **ID:** 1327
- **Status:** open
- **Date observed:** 2026-10-31
- **Scope:** terminal fallback attempt ownership, credential-probe lifetime, Electron event-stream 401 classification, and direct restart recovery evidence.
- **Fix commits:** `1c152bcf4`, `95830f198`.

## Changed-area validation

All changed-area checks passed:

- `mise run test:logged -- --name reconnect-web -- bun test --cwd apps/web ./src/lib/native/web-gateway-reconnect.test.ts ./src/lib/native/web-gateway-silent-recovery.test.ts ./src/lib/native/terminal-websocket-client.test.ts --parallel=1 --only-failures`: 76 passed after correcting the harness cleanup and the existing keepalive clock race ([1492](../previews-annotations-and-gateway/1492-gateway-keepalive-wall-clock-race.md)).
- `mise run test:logged -- --name reconnect-desktop -- bun test --cwd apps/desktop --preload ../../tests/setup-node.ts ./tests/backend-event-stream.test.ts ./tests/connection-manager-federation.test.ts ./tests/connection-manager.test.ts --parallel=1 --only-failures`: passed.
- Separate complete owners `web-gateway.test.ts` and `web-gateway-contract.test.ts`: passed (4.6 s and 2.5 s logged).
- `playwright-spec-loading.test.ts`, `client-outage-support.test.ts`, and the flake-register guard: passed.
- Scoped `bun check` projects for web, Electron, desktop tests, and E2E; root-invoked oxlint and format checks over the edited TypeScript files: passed. Preparation's passing full static checks and builds were retained rather than repeated.
- Both real `client-outage.spec.ts` direct backend-restart cases passed on a disposable credential-free profile: SSE and WebSocket, four clients per transport, a 45 s outage, and explicit recovery of output generated while clients were cut off (2.4 min). A temporary config selected these two cases through `runIsolatedBrowser`; the helper/config were removed after the run. The first extension incorrectly expected the retired PTY's runtime buffer to survive process restart, then the WebSocket probe omitted the real consumer's main-stream generation reconciliation. The final probe restarts the shell, generates output before restoring the link, and requires recovered bytes through an actual recovery notification/snapshot or exact replay. Evidence contains booleans and timing, not terminal contents.

The complete desktop package also passed in the repository run: 1399 passed,
16 skipped, zero failed across 98 files.

## Exact failed/incomplete preparation command reruns

`mise run test` initially remained queued behind another worktree's complete
aggregate. It was cancelled before any group started (exit 75) and repeated
with the documented `ORKESTRATOR_TEST_ALLOW_CONCURRENT=1` opt-out. The actual
run completed in 1120.5 s, exit 1. Workspace, root and bridge groups failed;
protocol regeneration passed. The failures were in unchanged owners:

- Web: 10887 passed, 10 skipped, three failed. `CoordinatorPanel` focus/shortcut transfer; `AgentNativeTab` maximal command-list filtering; root-change approval over-limit handling.
- Backend: 11672 passed, 103 skipped, four failed. Codex child-card cold restart; design recycle-bin retention; pinned Codex title-parser arguments; storage-writer scan.
- CLI: 355 passed, six skipped, one failed: zsh bashcompinit completion execution.
- Root/support: 3320 passed, one failed: disk-report checkout fixture.
- Codex bridge: 2313 passed, 57 skipped, one failed: disposal of a settling command-catalogue re-read. Other bridge packages passed.
- Desktop, public web, shared protocol and toolchain package tests passed.

`mise run test:logged -- --name agent-electron -- mise run test:agent:electron`
completed with 36 passed, three failed, two skipped and seven not run (18.4 min).
Failures were the unchanged cross-backend service-preview windows, keyboard
annotation handoff, and central workspace-region cases. The connection-outage
scenario passed, including its silent-drop path.

`mise run test:agent:browser:isolated` repeated the capped file-tree failure,
then reached its overall deadline during later scenarios (969.8 s including
cleanup). Its disposable profile `qa-browser-9be0d977-f31` was stopped and reset.
This is incomplete broad browser coverage, not a passing suite.

The `mise run test:browser` retry used `ORKESTRATOR_E2E_PORT=15327` and
`ORKESTRATOR_PUBLIC_E2E_PORT=15328` to avoid preparation's fixture server from
another checkout. It completed with 940 passed, 106 skipped, and 50 failed
(25.7 min). Failures span unchanged design, keyboard/focus, task outcome,
review/pipeline, setup, attachment, and transcript owners. Those failures are
unresolved broad coverage; they are not classified as new flakes without
complete owner reruns. The changed direct restart spec was separately exercised
against the real stack and passed both transports.

## Owning-file diagnosis and limits

- The unchanged complete `CoordinatorPanel.test.tsx` owner passed alone (35.4 s). This establishes intermittence for the focus transfer failure; [1326](../coordinator-and-multi-review/1326-coordinator-shortcut-focus-transfer.md) records it.
- The complete Codex command-catalogue owner remained red, with a different stale/ready settling assertion (29 passed, one failed, 1.5 s). The aggregate's disposal failure did not recur, but this is not a green owner result. The known settling-timing case remains open in the agent-bridges register.
- The complete disk-report owner also retained its five-second deadline and an error between tests (nine passed, one failed, one error, 9.5 s logged). This does not establish a fresh aggregate-only flake; the existing [0259](../environments-and-containers/0259-disk-report-aggregate-timeout.md) history includes isolated failures too.
- Other unchanged failures were not repaired, skipped, or given longer deadlines. No clean-main comparison was run, and no new cause is asserted for those failures.

## Evidence and cleanup

- Full repository output: `/tmp/reconnect-fix-full-test-concurrent.log`; compressed group logs and `summary.json` in `orkestrator-test-run.ojaEt8` under the host temporary directory.
- Other reruns: `/tmp/reconnect-fix-browser.log`, `/tmp/reconnect-fix-electron.log`, `/tmp/reconnect-fix-agent-browser.log`.
- Passing live recovery run: `/tmp/reconnect-fix-outage-complete.log`; `output/agent-testing/qa-browser-2140d65a-ada/browser/results.json`.
- The live recovery profile and every earlier disposable profile created for the focused restart checks were stopped and reset. No live launcher remained for those profiles. The unrelated profile that automatic pruning refused because of uncommitted work was retained.
