# Evidence body rename has not happened at the aggregate assertion

- **ID:** 9836
- **Status:** open
- **Date observed:** 2026-11-06
- **Test:** `EvidenceBodyStore.put > syncs the file before the rename, then the directories, before resolving`
- **File:** `apps/backend/src/core/change-tracking/evidence-body-store.test.ts`
- **Original command:** `mise run test:logged -- --name review-default-suite -- mise run test`, on `f88e595d2` with the floating-notice repairs in progress.
- **Worker configuration:** backend `--parallel=4`; aggregate workspace allocation six workers, root one, bridges two, protocol one.
- **Failure:** line 111 expected `existsSync(target)` to be true, received false; 35.83 ms.
- **Suite counts:** backend 16367 pass, 134 skip, 3 fail; web 13119 pass, 10 skip, 24 fail (notice announcement compatibility failures subsequently repaired); root 3676 pass, 1 fail.
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.synJsP/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; outer runner `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.RRKHmW/review-default-suite.log.gz`.
- **Isolated rerun:** `mise run test:logged -- --name evidence-store-isolated -- bun test --cwd apps/backend src/core/change-tracking/evidence-body-store.test.ts --parallel=1 --only-failures` passed, exit 0, 1.0 s. Passing output was deleted by the logged runner; no isolated test counts are inferred.
- **Hypothesis:** the aggregate assertion ran before the asynchronous rename completed. The different observation under isolation establishes intermittency, not a root cause. This owner and its implementation were unchanged; no deadline or assertion was weakened.

This is a different assertion from case 6550 (ingestion has not called put).
