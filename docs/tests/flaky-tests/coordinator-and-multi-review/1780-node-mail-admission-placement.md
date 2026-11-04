# Incoming node mail placement races automatic injection

- **ID:** 1780
- **Status:** resolved
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


## Recurrence, 2026-11-04 (input stamps review)

Preparation at `6ceb37b3422f1eec61d2b7b0808080dc5c229619` recorded the same
assertion at line 120 in `mise run test`: expected `pending-inject`, received
`injected` (29 ms). The package triage marks it related through the shared
`image-manifest.ts` import and known-flaky; this is not an aggregate pass.
The unchanged owner passed alone during repair:
`mise run test:logged -- --name mail-failure-triage -- bun test --cwd apps/backend ./src/core/nodes/node-coordination.test.ts --parallel=1 --only-failures`
(exit 0, 1.0 s). Preparation evidence remains in
`.orkestrator/review-artifacts/review-validation-51211246-bf75-4cea-b58b-3053677ba760/validation-04.stdout.txt`.
The aggregate remains unresolved for verification; no mail behavior was changed.

## Root cause and fix, 2026-11-04

`AgentMailService.init()` subscribes to `agent-mail` storage changes and starts
`drainInjects()` in the background whenever mail is stored. `deliverIncoming`
stores the mail and returns, and the test then read the message back from
storage, so the stored placement depended on whether that background drain
had already dispatched to the idle simulated worker. Loaded aggregate runs let
the drain win. The production behavior is correct (the mail is admitted as
`pending-inject` and then wakes the agent); the assertion raced it.

Reproduction: the unchanged test with a 100 ms pause between `deliverIncoming`
and the read-back failed with the recorded message (expected
`pending-inject`, received `injected`).

Fix: the test asserts the admission placement from `deliverIncoming`'s own
result (`pending-inject`), settles the drain with `MailWorld.deliver()`
(`drainInjects` coalesces with an in-flight pass and awaits it), then asserts
the stored message is `injected` and that the worker received exactly that
body. The collected-leaf-mail test at the end of the file read the coordinator
inbox back in the same way and received the same treatment.

Verification: `bun test ./src/core/nodes/node-coordination.test.ts` from
`apps/backend` passed (24 pass); six concurrent
`bun test --rerun-each 15` runs of the file passed 2,160 tests with 0 failures.
No mail implementation code was changed.
