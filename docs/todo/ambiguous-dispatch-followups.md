# Ambiguous dispatch: deferred follow-ups

Status: open. Two items deliberately left out of the fix for "The previous
dispatch could not be confirmed. Retrying is idempotent."

That banner is rendered from `NativeAgentSessionProjection.recoverableDispatch`,
which the backend derives from a persisted `pendingDispatch` record
(`apps/backend/src/core/native-agent-service.ts`, projection assembly). The
record is written *before* the provider is contacted and cleared when the
provider acknowledges, so anything that loses the acknowledgement leaves it
behind. The investigation found four causes and one UX trap; the fixes shipped
were:

1. `prompt`/`attach` bridge timeout kinds at 90s, so a cold agent start can no
   longer abort the dispatch mid-flight (`http-bridge-transport.ts`).
2. `ProviderUnreachableError` for connect-phase failures, so a bridge that was
   never reached is a rejection rather than an ambiguity
   (`agent-provider-contract.ts`, `http-bridge-transport.ts`).
3. `POST /session/:id/attach` plus the `prepareDispatch` provider capability,
   moving the cold start outside the at-most-once window.
4. `GET /session/:id/dispatch?requestId=` on all three HTTP bridges plus the
   `dispatchStatus` capability, so a parked record is settled from the
   provider's own journal instead of by the user.
5. A typed `PendingNativeAgentDispatchError`, a discard path, and a banner that
   offers both ways out.

The two items below were scoped out. Both describe behaviour that predates the
fix rather than anything it introduced, but the first limits how far the fix
reaches, and the second is a pre-existing contention problem that the fix
measurably widens.

---

## Item 1 — OpenCode still classifies every send failure as ambiguous

### Current behaviour

`OpenCodeProvider` (`apps/backend/src/core/opencode-provider.ts:108`) is a
separate implementation from `HttpBridgeProvider`; it talks to the OpenCode
server through `@opencode-ai/sdk/v2`, not to an Orkestrator bridge. Its `send`
wraps **every** thrown SDK error in `AmbiguousPromptDispatchError`:

```ts
} catch (error) {
  // The request may have reached OpenCode before the response was lost.
  // The reservation keeps the same ID until transcript reconciliation.
  throw new AmbiguousPromptDispatchError(
    "OpenCode prompt dispatch outcome is unknown",
    { cause: error },
  );
}
```

It implements neither `prepareDispatch` nor `dispatchStatus`, so for OpenCode
sessions:

- **Fix 1 does not apply.** The 90s budget lives in `bridgeFetch`, which
  OpenCode does not use. Its per-request timeout comes from
  `this.requestOptions()` and `connection.requestTimeoutMs`
  (`opencode-provider.ts:1446`).
- **Fix 2 does not apply.** A refused connection to a stopped OpenCode server is
  indistinguishable, at this layer, from a response lost mid-flight. Both park a
  recoverable dispatch.
- **Fix 3 does not apply.** No warm-up is performed before the at-most-once
  window opens.
- **Fix 4 degrades safely but does nothing.** `settleAmbiguousDispatch` checks
  `provider.dispatchStatus` first and returns `false` when it is absent, so an
  OpenCode record is never settled automatically. It stays until the user clicks
  Retry send or Discard.

Fix 5 *does* apply — the composer lock, the actionable message, and the
discard path are provider-neutral — so an OpenCode session no longer wedges.
It just still shows the banner in cases where the other providers now resolve
silently.

### Why it was left out

OpenCode's at-most-once story is genuinely different from the bridges', and it
already has three interlocking recovery mechanisms that a naive change could
break:

1. **Deterministic message IDs.** `OpenCodeMessageIdCoordinator`
   (`packages/protocol/src/opencode-message-id.ts:281`) resolves a stable
   `messageID` for a `requestId`. `send` reads the bounded newest transcript
   first, and `resolve()` returns the *materialized* id when
   `findOpenCodeMessageId(entries, requestId)` finds one — otherwise it hands
   out a reservation. The idempotency key is therefore recovered from OpenCode's
   own history, not from an Orkestrator journal.
2. **Manual-prompt claims.** `claimOpenCodeManualPrompt` /
   `releaseOpenCodeManualPrompt` (`native-agent-service.ts`) fence an
   interactive prompt against the automatic recovery sweep, using
   `openCodeManualPromptClaims` and `openCodeRecoveryDispatches`.
3. **Incomplete-turn recovery.** `opencode-turn-recovery.ts` detects a stalled
   assistant message and continues it under a durable id from
   `openCodeIncompleteTurnRequestId(assistantMessageId)`, routed through
   `dispatchNativeAgentPromptOnce` so the continuation is itself at-most-once.
   Its outcome surfaces as `openCodeIncompleteTurnNotice` on the session.

Adding a `dispatchStatus` that reported `dispatched` wrongly would clear a
pending record for a turn that never ran, silently dropping the user's prompt.
Adding one that interacts badly with (2) or (3) could let a manual prompt and a
recovery continuation both proceed. That needed more care than the rest of the
change, so it was deferred rather than rushed.

### Why it is very likely fixable

The primitive already exists and is already trusted on the dispatch path.
`findOpenCodeMessageId(entries, requestId)` answers exactly the question
`dispatchStatus` asks: *does OpenCode's transcript already contain a message
carrying this request's marker?* The marker is
`openCodeRequestMarker(requestId)` → `_ork_<encoded>`
(`packages/protocol/src/opencode-message-id.ts:53`), embedded by the same code
that dispatches, and `send` relies on finding it to recover an accepted
ambiguous dispatch after a restart.

### Proposed approach

1. Implement `dispatchStatus(sessionId, requestId)` on `OpenCodeProvider`:
   - Read the bounded newest transcript exactly as `send` does: a
     `client.session.messages` call limited to
     `OPEN_CODE_MESSAGE_HISTORY_LIMIT`, passed through
     `boundedOpenCodeMessageHistory`. Reuse the same helper so the byte bound
     (`OPEN_CODE_MESSAGE_HISTORY_MAX_BYTES`) cannot drift.
   - Return `"dispatched"` when `findOpenCodeMessageId(history, requestId)`
     resolves, `"unknown"` otherwise.
   - Every failure — unreachable server, malformed payload, oversized
     history — must return `"unknown"`, never throw a positive.
     `settleAmbiguousDispatch` already swallows throws, but the provider
     should not depend on that.
   - Do **not** take the `messageIds.runExclusive(scope, …)` lock. This is a
     read-only probe; taking the per-session dispatch lock would let a
     reconciliation stall a real dispatch.

2. Consider narrowing the ambiguous bucket. The SDK surfaces `response.error`
   with an HTTP status for answered requests, which `send` already inspects; the
   remaining gap is thrown transport errors. If the SDK's thrown error exposes a
   cause with a connect-phase code, the same `isConnectPhaseFailure` helper
   (exported from `http-bridge-transport.ts`) can classify it as
   `ProviderUnreachableError`. **Verify against the real SDK error shape before
   relying on this** — the bridge classifier was written against observed
   Bun and undici errors, and the OpenCode SDK may wrap them differently.

3. Optionally implement `prepareDispatch` as a cheap liveness/session probe.
   Lower value than for the ACP bridges: OpenCode's server is a long-lived
   process started with the environment, not a per-prompt cold start, so there
   is much less to warm.

### Risks and required tests

- **The false positive is the dangerous direction.** A `dispatched` answer
  clears the record *and* burns the request id via
  `confirmNativeAgentDispatch`, so a prompt reported as landed when it did not
  is lost with no banner. Prefer `unknown` in every uncertain case.
- Test that a transcript containing the marker settles the record, that one
  without it leaves the record parked, and that a transcript read failure leaves
  it parked.
- Test the interaction with an in-flight manual-prompt claim and with an
  `openCodeIncompleteTurnNotice` continuation, so reconciliation cannot settle a
  record that recovery is about to act on.
- Test that the probe does not acquire the message-ID scope lock — e.g. by
  running a settle concurrently with a dispatch and asserting the dispatch
  is not delayed.

Owning files: `apps/backend/src/core/opencode-provider.ts`,
`packages/protocol/src/opencode-message-id.ts`,
`apps/backend/src/core/opencode-turn-recovery.ts`,
`apps/backend/src/core/native-agent-service.ts`.

---

## Item 2 — Interactive dispatch holds two global mutation queues across
the provider call

### Current behaviour

`NativeAgentService.dispatchPromptInternal` dispatches like this:

```
runWithLiveEnvironment(environmentId, "Native agent prompt", () =>
  dispatchNativeAgentPromptOnce(key, requestId, async (durable) => {
    …
    await provider.send(durable.providerSessionId, input.prompt, { … });
    …
  }, pendingDispatch))
```

Both wrappers are serializing queues, and the provider call happens inside
**both**:

- `runWithLiveEnvironment` (`storage.ts:5959`) runs on
  `enqueueEnvironmentMutation` — one in-process promise chain plus a
  cross-process file lock on `environments.json`.
- `dispatchNativeAgentPromptOnce` (`storage.ts:5718`) runs on
  `enqueueNativeAgentSessionMutation` (`storage.ts:2604`) — one in-process
  promise chain plus a cross-process file lock on `native-agent-sessions.json`.

Holding the native-agent lock across the provider call is deliberate and
documented in place:

```ts
// Keep the cross-process lock until the provider has acknowledged this
// stable request id. If the process dies after provider acceptance but
// before this write, recovery retries the same id rather than inventing a
// second turn.
```

That reasoning is sound for the *native-agent* lock. The *environment* lock
being held too looks incidental — `runWithLiveEnvironment` exists to assert
the environment is live and not being deleted, which is a read, but it does so
by entering the environment mutation queue and keeping it for the whole
callback.

### Why it matters more after the fix

The prompt request budget went from 30s to 90s (`BRIDGE_ATTACH_TIMEOUT_MS`).
That was the right fix for the reported symptom, but it triples the worst-case
time either queue can be held by one dispatch.

What queues behind the environment lock includes hot paths:
`updateEnvironment` (3102), `recordEnvironmentActivity` (3497),
`setEnvironmentAgentActivity` (3530), `setEnvironmentUnread` (3848),
`recordEnvironmentCompletion` (3781), `setTabTeardownIntent` (3359),
`reorderEnvironments` (3881), and `expireFrontendAgentActivityLeases` (3681).
There are 18 `enqueueEnvironmentMutation` call sites in `storage.ts` in total,
of which `runWithLiveEnvironment` is one. The backend's activity sweep runs
every two seconds for every persisted session, so a long-held environment lock
stalls activity bookkeeping across *every* environment, not just the one
dispatching.

Behind the native-agent lock: `getOrCreateNativeAgentSession`,
`adoptNativeAgentSession`, `updateNativeAgentSessionControls`,
`invalidateNativeAgentSession`, `deleteNativeAgentSessionsByEnvironment`,
`confirmNativeAgentDispatch`, `clearPendingNativeAgentDispatch`,
`setOpenCodeIncompleteTurnNotice`, and every other dispatch.

### The cross-process timeout is the sharp edge

`acquireMutationLock` (`storage.ts:2672`) defaults to
`acquireTimeoutMs = 20_000` and `staleMs = 15_000`, with the holder
heartbeating the lock file every ~5s. Because the holder heartbeats, the stale
path never fires — so a *second process* waiting on a lock held across a slow
provider send fails after 20s with:

```
Timed out waiting for <description> lock
```

The in-process queue has no such timeout; it simply waits. So the failure mode
is asymmetric: within one backend everything just gets slower, but a second
process sharing the same data directory (standalone backend alongside the
desktop app, or the CLI) gets a hard error after 20s while the holder is still
legitimately working for up to 90s.

This is reachable today. It was reachable before the fix too, with a 30s hold
against a 20s acquire timeout — the fix widens an existing gap rather than
opening a new one.

### Mitigation already in place

`prepareDispatch` is called in `dispatchPromptInternal` **before**
`runWithLiveEnvironment`, so the cold agent start — the slowest and most
variable part — is paid outside both locks. In the common case the work inside
the locks is now a fast local HTTP round trip. The tail case (a child that died
between attach and prompt) still pays the full cold start inside them.

### Options, roughly in increasing order of risk

1. **Stop holding the environment lock across the provider call.** Read and
   validate the environment, then release, then dispatch. This is the smallest
   change with the largest benefit, since the environment queue has the hottest
   contenders and the weakest reason to be held. It needs a decision about what
   "still live" means: today the environment cannot be marked for deletion
   *during* the dispatch, and dropping the lock relaxes that to a check at the
   start. Consider re-validating after the send, or fencing on
   `deletionRequestedAt` at the point the result is persisted.

2. **Raise `acquireTimeoutMs` for the two dispatch-carrying locks** so a
   cross-process waiter outlives a legitimate 90s hold. Cheap and safe, but it
   only converts a hard error into a longer wait; it does not reduce contention.

3. **Shard the native-agent lock per logical session.** The file is one JSON
   document, so a per-session in-process lock still needs a global lock for the
   read-modify-write. A split — per-session critical section around the
   provider call, global lock only for the persist — would preserve
   at-most-once while letting independent sessions dispatch concurrently.
   This is the real fix and the most invasive one.

4. **Move the pending-dispatch record out of `native-agent-sessions.json`** into
   a per-session journal file, mirroring how the codex bridge keeps its dispatch
   journal (`bridges/codex-bridge/src/sessions/dispatch-journal.ts`). That
   removes dispatch from the shared-document contention entirely, at the cost of
   a storage migration.

### Invariants any change must preserve

- The pending record is persisted **before** the provider is contacted, and the
  lock covering it is not released until the provider has acknowledged that
  request id. A crash in between must be recoverable as the *same* id.
- A second request id must still be refused while one is parked
  (`PendingNativeAgentDispatchError`), and that refusal must remain scoped to
  the session it belongs to.
- `confirmNativeAgentDispatch` must keep clearing the record and appending to
  `dispatchedRequestIds` atomically — clearing alone would let a retry run the
  turn twice.

### Required tests

- Existing coverage to keep green:
  `apps/backend/src/core/storage-native-agent-sessions.test.ts` (cross-process
  dispatch-once, competing request refusal, confirm-as-spent) and
  `storage-prompt-queue-dispatch-boundary.test.ts`.
- New: a slow provider send must not block an unrelated environment's activity
  write beyond an agreed bound.
- New: two backend processes, one dispatching slowly, the other performing an
  ordinary environment mutation — assert the second does not fail with a lock
  timeout.

Owning files: `apps/backend/src/core/storage.ts`,
`apps/backend/src/core/native-agent-service.ts`.
