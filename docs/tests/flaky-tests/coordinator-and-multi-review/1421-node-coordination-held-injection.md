# Held remote Coordinator mail has not injected at the assertion

- **ID:** 1421
- **Status:** open
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
