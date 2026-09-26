# 02 — Make mandatory publication precede dispatch

Status: Planned.  
Depends on: [01](01-contract-baseline-and-regression-fixtures.md).  
Findings: INC-01; explicit overflow failure needed by INC-03.  
Next: [03](03-aggregate-persistence-budgeting-and-recovery.md).

## Target behavior

With persistent state configured, a prompt or steer reaches the provider only
after its prepared record and required session identity have been published.
A mandatory barrier rejects on write, rename, serialization, or budget failure.
Best-effort streaming writes may recover in the background, but their caught
errors must not turn mandatory publication into false success.

Durability here means atomic state-file publication sufficient for process
restart recovery. Power-loss/fsync guarantees are outside this change and must
not be implied by tests that only restart a process.

## Owners

- [Cursor persistence](../../../../bridges/cursor-bridge/src/persistence.ts):
  `schedulePersist`, `persistBarrier`, `persistNow`, `drainPersistence`.
- [Cursor routes](../../../../bridges/cursor-bridge/src/http.ts): prompt, steer,
  config, attach, and acknowledgement sites.
- [Cursor prompt lifecycle](../../../../bridges/cursor-bridge/src/prompt.ts):
  preparation records and run acceptance/completion.
- [Pi reference implementation](../../../../bridges/pi-bridge/src/persistence.ts).
- [HTTP provider](../../../../apps/backend/src/core/http-bridge-provider.ts) and
  [provider errors](../../../../apps/backend/src/core/agent-provider-contract.ts).

## Implementation tasks

### A. Define two write contracts on one serialized queue

- [ ] Keep one write queue per state file. Both streaming publication and
  mandatory barriers must enter it; no direct final write may overlap a queued
  write using the same temporary filename.
- [ ] Have `persistBarrier` create an operation that publishes a snapshot
  containing every mutation preceding the call. Return that operation's own
  rejection to its caller; attach a caught continuation only to the queue tail
  used by future operations.
- [ ] A previously failed best-effort write must not poison all future barriers.
  Conversely, an earlier successful write cannot satisfy a later mutation's
  barrier. Test both orderings explicitly.
- [ ] Keep best-effort coalescing, but do not coalesce away a mandatory caller's
  inclusion guarantee. If the queue needs counters, bound/coalesce pending work
  and reject excess admission before dispatch rather than accumulating promises.
- [ ] Immediately replace the oversized-state early return with an explicit
  publication failure. Step 03 adds shedding so normal large workloads recover;
  until then, failing clearly is safer than claiming successful publication.
- [ ] Close normal write admission before shutdown drain starts. Serialize the
  final publication after admitted writes. A barrier submitted after shutdown
  has begun must reject, not silently resolve because scheduling was disabled.
- [ ] Preserve intentional stateless mode only when no persistent state path is
  configured. Audit managed launchers and test that production paths configure
  one. An invalid configured path is a failure, not stateless mode.

### B. Put the prompt side effect behind the barrier

- [ ] Keep attachment validation and the synchronous session claim before any
  provider dispatch. Resolve cold attachment and identity changes first.
- [ ] Publish the prepared journal entry together with the final provider agent
  identity before `agent.send` can be called. A barrier before attachment alone
  is insufficient if attachment creates or replaces `agentId`.
- [ ] Re-check ownership after the barrier and immediately before invoking the
  SDK. A close/cancel arriving while disk I/O waits must not be bypassed.
- [ ] On pre-dispatch failure, release the claim and restore transient transcript
  bookkeeping. Remove or settle the prepared record only when non-dispatch is
  positively known. If cleanup publication fails, a stale prepared record on
  disk must remain conservative across restart.
- [ ] Keep a completion observer attached as soon as a run exists. Adding a
  post-acceptance write must never cause a live run promise to become unobserved.
- [ ] Review duplicate acknowledgements: an in-memory `accepted` entry whose
  final write is still pending must retain the documented restart semantics.
  Do not claim stronger durable positive proof than the published record gives.

### C. Preserve uncertainty around steer delivery

- [ ] Use the corrected barrier for prepared steering records before `run.steer`.
- [ ] Revalidate that the same active run is still owned after publication.
- [ ] Distinguish publication failure before delivery from failure after delivery.
  If `run.steer` succeeded but acknowledgement persistence failed, retain
  delivered/ambiguous evidence and never call it `absent` or resend automatically.
- [ ] Do not let a second failing barrier in an error handler erase the original
  dispatch classification. Return an actionable, content-free failure while
  maintaining an observed recovery promise.
- [ ] Verify the backend maps unknown outcomes to its existing parked request
  and retry/discard controls. Only an explicitly verified pre-dispatch rejection
  may be treated as safely retryable; HTTP 500 alone proves nothing.

## State/response matrix

| Failure point | Provider may have acted? | Required handling |
| --- | --- | --- |
| Input/attachment validation | No | Reject; no prepared record or side effect |
| Attach before send | No prompt yet | Reject preparation; retain/release attached resources according to ownership |
| Mandatory prepared publication | No | Do not send; surface publication failure |
| Close wins while barrier waits | No if send not started | Stop admission; settle the claim under close ownership |
| SDK call started, transport fails | Possibly | Keep unknown/prepared recovery evidence |
| Steer delivered, result publication fails | Yes or uncertain | Park/reconcile; never manufacture non-delivery |
| Restart with prepared/ambiguous record | Possibly | Unknown; no automatic replay |

The backend already distinguishes `ProviderDispatchPreparationError`,
`PromptRejectedError`, and `AmbiguousPromptDispatchError`. Reuse those meanings
where their evidence actually applies; do not broaden a catch to classify every
provider error as preparation failure.

## Regression tests

Proposed focused files: `persistence-barrier.test.ts` and
`http-dispatch-durability.test.ts` under `bridges/cursor-bridge/src/`.

| Case | Required assertions |
| --- | --- |
| Regular file used as state directory | Barrier rejects; no provider invocation |
| Write held before rename | Prompt and steer call counts remain zero |
| Rename failure after temp write | Old complete file remains authoritative; barrier rejects |
| Earlier queue operation fails | Next corrected barrier can succeed |
| Mutation occurs while earlier write waits | New barrier publishes that mutation before resolving |
| Concurrent barriers | No overlapping writers or lost required records |
| Shutdown races queued write | Final file is valid; new mandatory admission fails explicitly |
| Crash immediately before SDK dispatch | Restored prepared record prevents ambiguous re-dispatch |
| Delivered steer followed by failed write | Backend remains uncertain; SDK receives one delivery |
| No state directory in explicit fixture mode | Existing stateless tests remain supported |

Use synthetic content and assert metadata/side-effect counts. Leave the provider's
SDK idempotency key in place, but do not use it as a substitute for these tests.

## Validation and acceptance

- [ ] New focused durability tests pass alone and alongside existing HTTP and
  persistence suites through the logged runner.
- [ ] Cursor bridge typecheck passes; backend typecheck/tests pass if error mapping changes.
- [ ] Every mandatory caller observes its own failure and no unhandled rejection appears.
- [ ] No prompt or steer starts before the required snapshot publication.
- [ ] Unknown outcomes still reconcile without automatic duplicate execution.
- [ ] Interim aggregate overflow fails explicitly; step 03 is included before
  treating the normal large-session experience as complete.

Compatibility: retain the current persisted format where possible. A barrier
fix does not repair already missing historical records; report those as unknown.
Do not roll back to swallowed mandatory failures if disk issues are discovered
after release—disable new affected dispatches and retain recovery state instead.
