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
