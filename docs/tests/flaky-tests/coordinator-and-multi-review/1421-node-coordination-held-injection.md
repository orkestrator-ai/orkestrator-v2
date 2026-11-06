# Held remote Coordinator mail has not injected at the assertion

- **ID:** 1421
- **Status:** resolved
- **Date observed:** 2026-10-31
- **Test:** `a command node's deliverNow on this leaf > node coordinator requests stay pending while held, until injection`
- **Owning file:** `apps/backend/src/core/nodes/node-coordination.test.ts:348`
- **Original command:** `mise run test` in review preparation, using the aggregate runner's default worker allocation (backend defaults to two isolated workers).
- **Failure:** after `world.finishTurn`, the mail row still had `placement: pending-inject`; expected `injected` (197.66 ms). Backend counts: 11,353 passes, 103 skips, two failures across 11,458 tests in 777 files, 149.53 s. The other failure was a missing pinned Codex binary.
- **Owner rerun:** `mise run test:logged -- --name node-coordination-owner -- bun test --cwd apps/backend ./src/core/nodes/node-coordination.test.ts --parallel=1 --only-failures` passed the complete unchanged owning file in 7.4 s.
- **Additional evidence:** `mise run test:logged -- --name recorded-backend-failures -- bun test --cwd apps/backend ./src/core/nodes/node-coordination.test.ts ./src/core/session-title-runners.test.ts --parallel=1 --only-failures` first passed the node owner while retaining the missing-binary failure (31 passes, one failure), then passed both complete owners after installing the repository-pinned binary (9.7 s).
- **Preparation evidence:** `.orkestrator/review-artifacts/review-validation-286a5434-af1f-4def-9d5c-99886a528e83/validation-04.stdout.txt`.
- **Hypothesis:** asynchronous mail delivery had not settled under aggregate contention; root cause remains unconfirmed. No assertion, deadline or skip changed.

- **Exact aggregate rerun:** `mise run test` passed all four default-tier groups after these review fixes and pinned-toolchain preparation (754.0 s including 574.5 s waiting for the shared-host lease). Workspace, root/support, bridges and Codex protocol lockfile checks all passed; no failing owner was skipped or weakened.

## Main merge validation — 2026-10-31

The third main-merge pass ran `mise run test:logged -- --name merge-pass3-default -- mise run test`.
The default aggregate failed only this unchanged case at line 348 after 109.57 ms:
the mail record still had `placement: pending-inject` when `injected` was expected.
The backend used four isolated file workers and reported 11,922 passed, 103 skipped
and one failed across 812 files (108.24 s). Every other workspace package and the
root, bridge and protocol groups passed. The logged aggregate took 356.9 s,
including about 172.1 s waiting for the shared-host scheduler.

The complete unchanged owner then passed (exit 0, 2.3 s):

```sh
mise run test:logged -- --name merge-pass3-node-coordination -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/nodes/node-coordination.test.ts --parallel=1 --only-failures
```

Evidence below the host temporary directory:
`orkestrator-test-run.mlceSU/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
and `orkestrator-test-run.th3zhT/merge-pass3-default.log.gz`.
This repeats the existing asynchronous delivery symptom; no new cause was
established and no owning source, assertion, deadline or skip changed.

## Goal main-merge validation — 2026-10-31

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`.
  The default aggregate reserved workspace/root/bridge/protocol worker budgets
  of 6/1/2/1; web and desktop used two isolated file workers and backend used
  four. No browser suite ran alongside it in this worktree. The logger reported
  679.9 s total, including about 342 s waiting for the shared-host scheduler.
- **Failure:** after `finishTurn`, the row still had `placement: pending-inject`
  when `injected` was expected (302.98 ms). Backend reported 12,241 passed,
  103 skipped and one failed across 822 files.
- **Complete unchanged owner:** `mise run test:logged -- --name merge-node-coordination-owner -- bun test --cwd apps/backend ./src/core/nodes/node-coordination.test.ts --parallel=1 --only-failures`
  passed, exit 0, in 2.0 s.
- **Evidence:** `orkestrator-test-run.Am7yHz/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
  and `orkestrator-test-run.lhybBa/merge-tests.log.gz` below the host temporary
  directory. The aggregate remained non-green. The complete unchanged owner
  passed separately; no owning implementation, assertion, deadline or skip
  changed. The cause remains unconfirmed.


### Resolution — 2026-11-06

- **Stale; fixed by `b965aea44` (#1547, merged 2026-11-01 12:34 UTC).** In the
  `held` variant the test sent "Uses the first wake budget." to a busy recipient
  and left that message pending, with its busy backoff, when it released the
  second message. The next `finishTurn` drain could then deliver the first
  message ahead of the released one. That delivery consumed the turn, so the
  released message stayed `pending-inject` with `userReleasedAt` set at
  revision 2, which is exactly the recorded symptom. `b965aea44` settles the
  first delivery (`await world.finishTurn(recipient)`) before sending and
  releasing the second.
- **Every recorded sighting predates that fix.** The 2026-10-31 runs predate it,
  and the 2026-11-01 run on `visual-change-image-05b2937be199-r1` came from
  `ec08062d8` (#1521, merged 11:21 UTC), which does not contain `b965aea44`. No
  recurrence has been recorded since.
- **Reproduced:** yes, for the pre-fix test. With the settle line temporarily
  removed,
  `mise run test:logged -- --name coord-node-prefix -- bun --cwd=apps/backend test ./src/core/nodes/node-coordination.test.ts -t "stay pending while held" --rerun-each=30`
  failed 1 of 30 on an unpinned host (70.8 ms), with the identical
  `pending-inject` / `userReleasedAt` / revision 2 record.
- **Verification of the current test:** `coord-node-postfix` (`--rerun-each=300`):
  300/300 pass. `coord-node-held-stress` (`--rerun-each=100`, pinned to one core
  beside 6 busy loops): 100/100 pass. `coord-node-file-stress` (whole owner,
  `--rerun-each=10`, same contention): pass. No source changed.

