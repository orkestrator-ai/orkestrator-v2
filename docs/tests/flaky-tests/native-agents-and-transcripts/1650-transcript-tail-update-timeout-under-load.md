# Transcript tail update tests time out under load

- **ID:** 1650
- **Status:** resolved
- **Date observed:** 2026-11-01
- **Test:** `build pipeline transcript checkpoints > an active tail update writes one tail chunk, a manifest and the small control record`; `BuildPipelineTranscriptStore > an active tail update writes only the tail chunk and the manifest row`
- **File:** `apps/backend/src/core/build-pipeline-transcript-checkpoints.test.ts`, `apps/backend/src/core/build-pipeline-transcript-store.test.ts`
- **Original command:** `bun test --preload ../../tests/setup-node.ts --parallel=4 --only-failures <110 backend files>` from `apps/backend`, on branch `select-soonest-reset-76510e6abff6-r1` (macOS arm64, Bun 1.4.4), with the worktree on an external volume, beside other work on the host.
- **Failure:** both exceeded the default 5,000 ms (5,000 ms and 5,183 ms). The store test's `commit` then threw `RangeError: Cannot use a closed database` between tests, because its fixture had closed the database under the late call.
- **Isolated rerun:** `bun test --preload ../../tests/setup-node.ts src/core/build-pipeline-transcript-checkpoints.test.ts src/core/build-pipeline-transcript-store.test.ts src/core/control-mcp/coordinator-goals.test.ts --parallel=1` from `apps/backend`: 59 pass, 0 fail.
- **Assessment:** load on a slow disk rather than a defect in the change that saw it, which does not touch these paths. Open until it is seen again or a run on a local disk stays clean.

### Resolution — 2026-11-06

- **Root cause:** setup bound by disk sync latency. Before measuring one update, the store case builds three 1,000-message histories in 8 KiB chunks: 135 chunk and directory fsyncs plus SQLite WAL syncs. The checkpoints case does 36. The two cases took 1.1 s together on tmpfs and 2.4 s on the host's btrfs disk, so most of their cost is fsync. The observed failure came on an external macOS volume under load. The `closed database` error was the fixture tearing down beneath a test that had already timed out.
- **Reproduced:** no; neither case timed out here.
- **Fix:** both active-tail cases get an explicit 30 s budget (`DURABLE_HISTORY_TEST_TIMEOUT_MS`), with the measured cost documented in the tests. The write-count and byte assertions are unchanged.
- **Verification:** `mise run test:logged -- --name n1650-owners -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/build-pipeline-transcript-checkpoints.test.ts ./src/core/build-pipeline-transcript-store.test.ts --parallel=2 --rerun-each=10`, run with `TMPDIR` on the real btrfs disk, passed 380 tests with 0 failures.
