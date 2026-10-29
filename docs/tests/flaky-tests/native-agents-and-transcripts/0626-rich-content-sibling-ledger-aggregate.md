# Sibling rich-content ledger is empty in the aggregate

- **ID:** 0626
- **Status:** open
- **Date observed:** 2026-10-21
- **Test:** `conversation deletion clears that conversation's protected rich content > the backend's transcript-artifact hint for a deleted conversation clears it once`
- **File:** `apps/web/src/lib/chat/rich-conversation-revocation.test.tsx:187`
- **Original command:** `mise run test:logged -- --name reorder-suite -- mise run test`, default workspace/root/bridges/protocol reservations of 4/1/2/1 on the shared macOS host.
- **Failure:** the sibling ledger had length 0 instead of 1 after deletion of the other conversation (151.90 ms).
- **Owning-file rerun:** `mise run test:logged -- --name reorder-rich-revocation-owner -- bun test --cwd apps/web ./src/lib/chat/rich-conversation-revocation.test.tsx --parallel=1 --only-failures` passed the complete unchanged owner (exit 0, 2.4 seconds logged).
- **Evidence:** `orkestrator-test-run.U6kMZC/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory after aggregate completion.
- **Assessment:** confirmed intermittent failure; cause unknown. The remote reorder changes do not touch rich-content ledgers. No implementation, assertion, timeout or skip in this owner changed.


## Desktop recovery validation — 2026-10-26

`mise run test:logged -- --name recovery-repository -- mise run test` repeated
this failure on Linux x64 with two web workers: the sibling ledger had length
0 instead of 1 (274.56 ms). The default repository groups ran alongside Electron
validation and other worktrees. The complete unchanged owner passed alone with
`mise run test:logged -- --name unrelated-rich-content-owner -- bun test --cwd apps/web ./src/lib/chat/rich-conversation-revocation.test.tsx --parallel=1 --only-failures`
(exit 0, 3.3 seconds). This is a recurrence of the tracked intermittent failure;
its cause remains unconfirmed. No rich-content implementation, assertion,
timeout or skip changed. Aggregate evidence is in
`/tmp/orkestrator-test-run.DpxCwj/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
after completion; the outer summary is `/tmp/orkestrator-test-run.vHWLs2/summary.json`.

## Comparison-base review fixes — 2026-10-29

`mise run test:logged -- --name root-tests -- mise run test` repeated the
sibling-ledger failure on Linux (229.74 ms): expected one sibling ledger row,
received zero at line 187. The complete unchanged owner passed separately:
`mise run test:logged -- --name unrelated-rich-content-owner -- bun test --cwd apps/web ./src/lib/chat/rich-conversation-revocation.test.tsx --parallel=1 --only-failures`
(exit 0, 3.0 seconds logged). This is a recurrence of the existing intermittent
failure; its cause remains unconfirmed. No rich-content implementation,
assertion, timeout or skip changed. Aggregate evidence is in
`/tmp/orkestrator-test-run.eqUv2v/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
after finalization; the outer summary is
`/tmp/orkestrator-test-run.0MSwpb/summary.json`.
