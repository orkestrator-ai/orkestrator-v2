# Registry coverage shares a newer-schema temporary database

- **ID:** 0508
- **Status:** environmental
- **Date observed:** 2026-10-20
- **Test:** `direct backend command registry coverage > reports Docker maintenance state; unreviewed removal is refused`
- **Owner:** `apps/backend/tests/commands-registry-coverage.test.ts:252`

## Main merge validation

- **Original command:** the GNU-tool PATH from the testing guide, followed by `mise run test:logged -- --name merge-full-tests -- mise run test`; workspace/root/bridges/protocol reservations were 4/1/2/1 worker slots.
- **Failure:** `get_orkestrator_containers` rejected at the expected-success assertion (156.23 ms). Backend counts: 9,573 passed, 41 skipped, two failed across 533 files (539.09 seconds). The separate Chromium hook failure is recorded in 0507. The aggregate finished with exit 1 in 579.8 seconds; root, bridges, protocol and all other workspace packages passed.
- **Owning-file rerun:** `mise run test:logged -- --name merge-command-registry-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-registry-coverage.test.ts --parallel=1 --only-failures` reproduced it (14 passed, one failed; 0.7 seconds).
- **Cause:** this owner uses the fixed `path.join(os.tmpdir(), "ork-command-registry-data")`. A direct ledger read at that exact fixture path raised `StorageDatabaseVersionError`: schema 4 is newer than this build supports (3). The directory predated this validation. Its contents were retained; no shared database was removed or downgraded.
- **Clean temporary-root rerun:** `mise run test:logged -- --name merge-command-registry-clean-owner -- env TMPDIR=/tmp/ork-merge-registry-8EC4i5 bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-registry-coverage.test.ts --parallel=1 --only-failures` passed all 15 unchanged tests (exit 0 in 0.7 seconds). That explicitly created temporary root was removed afterwards.
- **Evidence:** `orkestrator-test-run.le6gpX/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and `orkestrator-test-run.uu33y5/merge-command-registry-owner.log.gz` below the host temporary directory.
- **Assessment:** deterministic contamination from shared fixture state, not a newly confirmed flake. No source, assertions, deadlines or skips changed during merge validation.
