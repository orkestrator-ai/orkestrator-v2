# 05 — Prevent execution from escaping a permanently closed Cursor session

Status: Planned.  
Depends on: [02](02-mandatory-persistence-and-dispatch-barriers.md),
[03](03-aggregate-persistence-budgeting-and-recovery.md).  
Finding: INC-02.  
Related: [09](09-conversation-retention-and-close-semantics.md) determines
conversation retention; this step fixes ownership regardless of that decision.

## Target behavior

Permanent close synchronously stops admission. Late attach/send results remain
owned until disposed or cancelled, and cannot recreate a session or run another
prompt. A successful close acknowledgement means no tracked operation can later
start unobserved work. Idle detachment remains a separate resumable operation.

## Owners

- [Cursor session lifecycle](../../../../bridges/cursor-bridge/src/agent-session.ts).
- [Cursor routes](../../../../bridges/cursor-bridge/src/http.ts): DELETE,
  prompt, attach, config, and steer.
- [Cursor prompt ownership](../../../../bridges/cursor-bridge/src/prompt.ts).
- [Cursor state](../../../../bridges/cursor-bridge/src/state.ts) and
  [persistence](../../../../bridges/cursor-bridge/src/persistence.ts).
- [Pi permanent close](../../../../bridges/pi-bridge/src/agent-session.ts).
- [Backend teardown intents](../../../../apps/backend/src/core/commands-registry-teardown.ts).

## Lifecycle design

Use a permanent-close marker plus an operation generation/claim or an equivalent
explicit lifecycle owner. A `WeakSet` can prevent attachment resurrection, but
does not by itself own a pending SDK `send`, persist closure, or make cleanup
idempotent. Design all three boundaries together.

| State | Admit new work? | Authoritative activity | Allowed transition |
| --- | --- | --- | --- |
| Open, detached | Yes | Idle | Attach or close |
| Attaching/preparing | Only the existing claim | Working/preparing | Dispatch, failure, or close |
| Running | Existing turn/valid controls | Working/blocked | Settle or close |
| Closing | No | Still working/closing while execution is uncertain | Closed only after owned work is fenced/stopped |
| Closed | No | Missing for active registry | No resurrection; resume creates/adopts a separately owned bridge session |

Do not add a new public status unless needed. Existing `running`/runtime-phase
projection can represent uncertain shutdown; reporting idle early is forbidden.

## Implementation tasks

- [ ] Claim permanent close before the first await. Return one shared close
  promise for concurrent close requests, or a documented conflict that retries
  safely. Do not run cleanup twice against the same resources.
- [ ] Refuse new prompt, attach, config, steer, and idempotent-create mutations
  that target the closing state. Snapshot reads may show closing progress.
- [ ] Give attachment completion an ownership check before assigning `state.agent`,
  provider ID, MCP resources, and warm-workspace release handles. Dispose any
  result whose ownership expired; ensure cleanup failures are observed.
- [ ] Audit every yield in prompt preparation: attachment reads, MCP rotation,
  read-only transitions, attach, and persistence. Revalidate before SDK send.
- [ ] If close wins before `send`, release the claim without sending. If `send`
  is already pending, retain ownership of its promise; cancel and dispose the
  returned run/agent immediately when it arrives. A marker alone cannot cancel
  an operation whose handle does not yet exist.
- [ ] Make callbacks check both turn identity and lifecycle ownership. Existing
  `turnStillOwned` checks on sequence/status must not let a removed session keep
  publishing transcript or usage updates.
- [ ] Release subscriptions, hosted MCP clients, workspace warm-up handles, run
  diagnostics, timers, and the agent exactly once. Keep errors bounded and
  content-free. Do not swallow evidence that execution may still be alive.
- [ ] Separate cleanup completion from the HTTP timeout. If cancellation/disposal
  does not settle within the budget, retain an authoritative closing record or
  owned cleanup operation and report incomplete/uncertain close. The backend's
  durable teardown intent must remain retryable; do not return fake success.
- [ ] Persist removal or a closing tombstone before acknowledging permanent
  close. If the final write fails, retain a retryable state so another DELETE
  cannot return 404 while disk still contains a reopenable live mapping.
- [ ] Restore any new closing marker conservatively across restart. Never
  auto-resume a state explicitly closed before the old process died.
- [ ] Ensure same-client-key creation cannot silently reinsert the old state
  during close. Define whether a later deliberate create gets a new ID only
  after closure has settled.
- [ ] Keep `detachAgent` for idle/unload use without setting permanent-close
  state. Returning to an idle tab must still attach to the same conversation.

## Regression matrix

Proposed files: `agent-session-close.test.ts` and `http-close-races.test.ts` in
the Cursor bridge. Use the existing fake agent with deferred attach/send/dispose.

| Interleaving | Required outcome |
| --- | --- |
| Prompt awaits attach; DELETE arrives | Zero sends after close; late attach disposed |
| Attach awaits provider create; DELETE arrives | Returned agent never becomes a usable live session |
| Prompt awaits journal barrier; DELETE arrives | Barrier completion does not permit send |
| SDK send pending; DELETE arrives | Late run cancelled/observed; no orphan execution |
| Active run; DELETE arrives | Stop is requested and activity stays busy until justified |
| Dispose/cancel rejects or hangs | Bounded request; authoritative cleanup remains visible/retryable |
| Duplicate concurrent DELETE | One cleanup, stable outcome, no double disposal |
| Final removal publication fails | Retry does not falsely treat a stale disk record as already gone |
| Late callback after removal | No transcript, usage, or journal resurrection |
| Ordinary idle detach | Resume/next prompt still works with the retained identity |
| Backend restart during teardown | Durable intent resumes cleanup rather than reopening work |

Include assertions for registry membership, client-key mapping, provider call
counts, live handles, final publication, and authoritative activity. A 200 response
by itself is not adequate proof of closure.

## Validation and acceptance

- [ ] Focused lifecycle/HTTP tests and existing cancellation tests pass.
- [ ] Cursor and backend typechecks pass where affected; teardown integration
  tests prove the backend does not clear its intent on an incomplete close.
- [ ] In an isolated browser fixture, close during startup and during a run,
  switch environment, return/reload, and confirm work/resources are accounted for.
- [ ] The cold-close reproduction from INC-02 produces zero unintended sends.
- [ ] No unmount or disconnected HTTP request invokes permanent close implicitly.
- [ ] Provider conversation deletion is unchanged by this step; step 09 owns
  the product decision about retaining history.

If a lifecycle/schema change is needed, record its old-state defaults and
downgrade behavior. A rollback must not re-enable late work on already-closing
sessions or erase uncertain cleanup ownership.
