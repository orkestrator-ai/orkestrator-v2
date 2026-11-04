# Incoming node mail placement races automatic injection

- **ID:** 1780
- **Status:** open
- **Date observed:** 2026-11-02
- **Test:** `CO-05/UP-02 coordinator mail to and from a leaf agent > delivers as ordinary incoming mail and routes the agent's answer to that command node's outbox`
- **Owning file:** `apps/backend/src/core/nodes/node-coordination.test.ts:119`

## Observation

`mise run test:logged -- --name validation-test-index-repaired -- mise run test`
failed after 301.8 s. Workspace had six worker slots, root one, bridges two,
and protocol-lockfile one. This test expected `pending-inject` and received
`injected` at 75.67 ms. Root passed (222.4 s), web passed (11407 pass, zero
fail, 11417 tests), bridges and protocol-lockfile passed. Evidence:
`/tmp/orkestrator-test-run.exaMuO/validation-test-index-repaired.log.gz`
and inner artifact directory `/tmp/orkestrator-test-run.F3tqff`.

## Isolated reruns

`mise run test:logged -- --name node-mail-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/nodes/node-coordination.test.ts --parallel=1 --only-failures`
passed unchanged on this branch in 1.9 s. The same owner command with log name
`main-node-mail-owner` passed in 1.5 s on independently installed detached
`origin/main` at `d7cdfaa8b`. The temporary worktree was removed.

## Interpretation

The failure is consistent with injection advancing before the assertion, but
no cause or target-branch failure was reproduced. This is a credible flake
because the complete unchanged owner passed alone. It does not excuse the
failed aggregate run. Coordinator workflow retention changes do not touch
this owner or the mail implementation. No unrelated code or test was changed.

## Recurrence, 2026-11-03

`ORKESTRATOR_TEST_GROUP_TIMEOUT_MS=2700000 mise run test:logged -- --name full-default -- mise run test`
on branch `debug-ci-failures-a629816c8619-r1` (on `main` at `62e99ff59`, 16-core
Linux host) repeated the line 119 assertion: expected `pending-inject`, received
`injected` (51.14 ms). It was the only failure in the run: root, bridges and the
codex protocol lockfile groups passed. The unchanged owner then passed alone three
times (`bun test src/core/nodes/node-coordination.test.ts` from `apps/backend`,
24 pass each). It did not fail in any of the six GitHub Actions CI runs checked
between `d6040915c` and `b0dcf1660`.

## 2026-11-04 image-mail repair validation

The five-file focused image-mail suite, `mise run test:logged -- --name
image-mail-fixes -- bun --cwd=apps/backend test
./src/core/mail-attachments.test.ts ./src/core/coordinator-worker-mail.test.ts
./src/core/coordinator-mail-attachments.test.ts ./src/core/nodes/node-files.test.ts
./src/core/nodes/node-coordination.test.ts --parallel=2 --only-failures`,
observed the same expected `pending-inject`, received `injected` assertion
at 100.32 ms (95 pass, 2 fail; the other failure was a new test assertion
subsequently corrected). Evidence: `/tmp/orkestrator-test-run.POBTE6/image-mail-fixes.log.gz`.
The owning file passed alone through `test:logged --name node-coordination-alone`
with the same Bun command and only `./src/core/nodes/node-coordination.test.ts`
(5.0 s). The corrected five-file suite then passed (8.0 s, 97 tests).
The new lifecycle regression does not change injection timing; automatic
injection racing the admission assertion remains an open hypothesis.
