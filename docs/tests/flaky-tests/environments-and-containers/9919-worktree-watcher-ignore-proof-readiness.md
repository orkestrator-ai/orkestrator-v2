# Real worktree watcher assertions raced the initial ignore proof

- **ID:** 9919
- **Status:** resolved
- **Date observed:** 2026-11-10
- **Test:** `worktree watcher on this platform's real watch > a write under an ignored node_modules goes unreported while a source write is noticed`; `worktree watcher on this platform's real watch > replacing an ignored directory with a symlink refreshes proof and reports it`
- **File:** `apps/backend/tests/worktree-watcher-real.test.ts`
- **Host:** macOS arm64, Bun 1.4.4.
- **Observing head:** `310f4fd7ae6d64395d5f5bc3e3548485489be2f0`.
- **Observing branch base:** `08d3da4a23cfe2ecc34fba663ca27e765f7924a9`.

## Observation

`mise run test:logged -- --name coverage-real-final -- bun test --cwd apps/backend ./tests/worktree-watcher-real.test.ts ./tests/worktree-watcher.test.ts ./src/core/worktree-snapshots-git.test.ts --parallel=1 --only-failures`
failed with 54 pass, 3 skip and 2 fail across three files in 50.52 s.
The ignored-write test collected both `node_modules/pkg-1/lib/installed.js`
and `packages/app/node_modules/pkg-1/lib/installed.js` instead of an empty
list (811.38 ms). The symlink test reached `expect(proof).toContain(...)`
with an undefined proof (1809.31 ms).

Evidence: `orkestrator-test-run.60XCj6/coverage-real-final.log.gz` in the
host's temporary directory.

`mise run test:logged -- --name coverage-real-isolated -- bun test --cwd apps/backend ./tests/worktree-watcher-real.test.ts --parallel=1 --only-failures`
passed in 14.2 s. The passing logger did not retain counts.

## Reproduction and fix

On macOS, a recursive root can announce qualified coverage before Git finishes
the initial ignore-proof read. `watchWorktree` waited for coverage alone, and
a source event was not evidence that the independent Git read had completed.
The tests therefore started their ignore-rule assertions too early. This is
a test-fixture readiness race: the production watch correctly covers the whole
tree while the proof is pending.

A temporary preload wrapped `listIgnoredDependencyTrees` and
`worktreeWatchPlanIo.listExcluded` with `await Bun.sleep(2000)` before calling
the original reader. With the two tests selected by
`--test-name-pattern 'a write under an ignored node_modules|replacing an ignored directory with a symlink'`
and `--parallel=1 --only-failures`, both failed before the fix (0 pass, 2 skip,
2 fail; 1.60 s). Evidence:
`orkestrator-test-run.nyYXws/coverage-proof-race-both-before.log.gz`.

The fixture now waits for both native coverage and completion of the initial
proof read. It preserves injected plan readers and `plan: null`; it does not
alter production qualification, assertions, or delivery deadlines.
Both cases passed under the same two-second delay in 7.8 s.

## Resolution (2026-11-10)

- **Root cause:** native watcher coverage and the initial Git ignore-proof read
  are independent; the fixture used coverage alone as its readiness barrier.
- **Fix:** `watchWorktree` now waits for completion of the initial proof read
  as well as qualified native coverage, preserving the configured plan reader.
- **Reproduced:** yes — delaying both proof-reader entry points by two seconds
  reproduced both failures before the fix; both passed with the same delay
  after the fix (`coverage-proof-race-fixed`, 7.8 s).
- **Stress:** the same delayed-proof command with `--rerun-each=5` passed
  (`coverage-proof-race-stress`, 41.6 s). No assertion, delivery deadline,
  or production watcher behavior was weakened.

The stress command used the isolated checkout and temporary two-second-delay
preload described above:

```sh
mise run test:logged -- --name coverage-proof-race-stress -- \
  bun test --cwd "$PROOF_WORKTREE/apps/backend" ./tests/worktree-watcher-real.test.ts \
  --preload "$PROOF_DELAY_PRELOAD" \
  --test-name-pattern 'a write under an ignored node_modules|replacing an ignored directory with a symlink' \
  --rerun-each=5 --parallel=1 --only-failures
```

`PROOF_WORKTREE` denotes the isolated checkout of the observing head plus
this fixture fix; `PROOF_DELAY_PRELOAD` denotes the temporary preload.

