# startResourceSync > deduplicates the initial connection signal and resyncs on reconnect

- **ID:** 0781
- **Status:** resolved
- **Date observed:** 2026-10-24
- **Test:** `startResourceSync > deduplicates the initial connection signal and resyncs on reconnect`
- **Owning file:** `apps/web/src/lib/resource-sync.test.ts`
- **Original command:** `ORKESTRATOR_TEST_AREA_BASE=a5d78cfcd54907a13973463d4bd08497fd025c90 mise run test:logged -- --name merge-tests -- mise run test`, with the GNU shell-tool PATH from the testing guide.
- **Worker configuration:** aggregate workspace group, two package tasks with two Bun workers per package; other worktrees were validating on the same host.
- **Failure:** Expected resync once, received twice at line 458 (138.37 ms).
- **Suite counts:** web package: 9,347 passed, 10 skipped, 5 failed across 594 files in 1,067.34 s.
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.8ZKWYk/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Isolated rerun:** `mise run test:logged -- --name merge-0043-rerun-resource-sync -- bun test --cwd apps/web ./src/lib/resource-sync.test.ts --parallel=1 --only-failures` passed unchanged (exit 0, 4.7 s).
- **Hypothesis:** timing sensitivity under concurrent host load; the complete unchanged owning file passed with one worker. No root cause has been established. No assertion, deadline, or skip was changed.

## Triage 2026-10-25

- **Disposition:** open.
- **Evidence:** the test waits a fixed `tick(10)` before `resync.mockClear()` (`resource-sync.test.ts:451`). If the initial zero-delay fallback resync runs later than that, it counts against the reconnect assertion.
- **Next step:** wait until the initial resync has been seen before clearing the mock.

### Resolution — 2026-11-06

**Root cause.** The triage above was right. `startResourceSync` arms its
attach-time resync in a zero-delay task once both listen promises resolve, and
the tests waited a fixed `tick(10)` before clearing or counting resyncs. The
10 ms timer is armed before the listen microtasks run. If the worker is
descheduled between the two, the zero-delay task falls due after the tick, so
the attach-time resync lands after `resync.mockClear()`. Because
`connectionAnnounced` is then already set and `bootResyncAt` was never
recorded, both connection signals refetch (2 calls instead of 1).

**Reproduction.** A copy of the unchanged owner whose `listen` mock spins for
15 ms in its microtask, simulating a descheduled worker, failed this case,
`requests an authoritative resync after initial attachment` and
`still dedupes an announcement that lands inside the attach window`.

**Fix.** `apps/web/src/lib/resource-sync.test.ts`: a `startAfterAttachResync()`
helper starts the sync and polls (1 ms steps, 10 s bound) until the
attach-time resync has actually been delivered, and the 14 plain
`startResourceSync()` + `tick(10)` sites use it. Under the same simulated
deschedule, every `startResourceSync` case passes.

**Verification.** `mise run test:logged -- --name web-0781-stress -- bun --cwd=apps/web test src/lib/resource-sync.test.ts --rerun-each=20`
passed (exit 0, 49.8 s).

**Remaining.** The manifest and scoped-manifest cases in the same file
(`startResourceSync({ loadManifest })` and similar, followed by `tick(10|20|30)`)
use the same fixed-sleep pattern and fail under the same simulated deschedule.
They are not recorded flakes and were not changed here.
