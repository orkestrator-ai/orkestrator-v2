# Review fan-out dispatch recovery

Found on 2026-10-25 by the seeded interleaving tests that
[0027-multi-review-scale-and-cost.md](0027-multi-review-scale-and-cost.md)
added (`apps/backend/src/core/review-fanout-interleaving.test.ts`). Checked
against `main` at `ba7cc8d4`. Both bugs affect standalone Multi Review and
Build Pipeline review stages, because both use `ReviewFanoutRunner`.

## Current state

- **A `dispatching` record is treated as sent.** On recovery,
  `ReviewFanoutRunner` (`review-fanout.ts`, the
  `dispatchState === "dispatching"` branch) rewrites a durable `dispatching`
  reviewer to `sent` without asking the provider. `dispatchStatus` exists on
  the provider contract (`agent-provider-contract.ts`), but the runner does
  not call it here, and the HTTP bridges have no `settleTurn`. The store can
  hold `dispatching` for a request that never reached the provider:
  - a peer's commit saves this reviewer's in-memory `dispatching` before its
    own commit and send, and the fence is then lost or the backend dies;
  - a send refused before the prompt was written resets to `prepared`, but
    that commit loses the fence;
  - the backend dies between the durable write and the send.

  The next owner then watches an idle session that was never prompted. A
  tool-transport reviewer gets the result reminder ("your analysis is
  already done") as its first turn; a structured-output reviewer fails as
  idle without its report. Seeds: fence-loss 24 and 34, restart 13, 17 and 24.
- **A takeover mid-continuation counts the old restart twice.** The new
  owner reads the session's status before the in-flight restart continuation
  lands, sees the previous turn's `interruption: "restart"` again, and fails
  the reviewer as restarted twice. Seeds: fence-loss 861 and 1251, which are
  outside the 24 CI seeds; a sweep of
  `ORKESTRATOR_FANOUT_INTERLEAVING_SEEDS=4000` reaches them.
- Both are `test.todo` cases in "runner bugs found by interleaving"; each
  fails on its seeds today. The main suites only require the affected
  reviewers to settle, so CI stays green.

## Outstanding work

### Code

1. **Reconcile a recovered `dispatching` request with the provider** before
   treating it as sent: ask `dispatchStatus` (or the bridge's request
   journal) whether the request id was accepted, send it under the same id
   when the provider says it never arrived, and keep parking it when the
   answer is unknown. Never re-send under a new id (invariant 3 in 0027).
   Bridges without a dispatch-status answer need one, or the runner needs a
   documented fallback. Turn the todo case into a test.
2. **Tie a restart interruption to the request it interrupted.** The
   observation should carry the interrupted request id (or the runner should
   compare it with `requestId`), so an interruption of the request that a
   continuation already replaced is ignored. Turn the todo case into a test,
   and add seeds 861 and 1251 to the CI list.

### Qualification

- None beyond the deterministic tests: both are interleavings no live run can
  force on purpose.

## Constraints and rationale

- The ten fan-out invariants in 0027 apply, above all at-most-once dispatch
  (never retry an ambiguous send under a new request id) and fail-closed
  recovery.
- A fix must keep `dispatching` → send as the only fallible step, and must
  not hold a storage lock across provider I/O.

## Open questions

- Which bridges can answer "did request X arrive" today? Claude has a durable
  prompt journal (`claimPromptDispatch`); Codex and the others need checking.

## Needs verification

- Whether the same `dispatching` recovery gap exists in Multi Review's step
  runner (`MultiReviewService.activeRequest`) and Build Pipeline's
  `pendingPromptAttempt`, which have their own recovery paths.

## Related

- [0027-multi-review-scale-and-cost.md](0027-multi-review-scale-and-cost.md):
  the interleaving tests, invariants and error scopes.

## Replaces

- Nothing; new work found on 2026-10-25.
