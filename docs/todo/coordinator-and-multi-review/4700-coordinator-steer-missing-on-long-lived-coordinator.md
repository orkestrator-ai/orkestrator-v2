# Steer missing on a long-lived Coordinator during a mail-started turn

## Task analysis

Analysed 2026-11-04 against `main` at `96ee1eb3e`.

### Tasks

1. **Capture the failing state**: record the Coordinator's projection when a typed message queues with no Steer. Status: open.
2. **Fix the cause once it is known**: make the queued row offer Steer, or say why it cannot. Status: open (depends on 1).

### 1. Capture the failing state

**Problem.** On 2026-11-04 at about 08:28 UTC the user's main Coordinator (Claude, production 2.36.1) was busy with a turn and Auto-steer was on. A message the user typed sat as "1 queued" for about 1.5 minutes, with only edit and delete on its row: it was not auto-steered and there was no Steer button.

**Context.** The Coordinator page mounts the shared native tab (`CoordinatorPanel.tsx` renders `AgentNativeTab` with `executionPolicy="coordinator-read-only"`). Auto-steer and the row's Steer use the same gate in `AgentNativeTab.controller.tsx`: the turn is `running`, no dispatch is parked (`recoverableDispatch`), and the projection reports `capabilities.actions.steer`. The backend clears that capability only when `HttpBridgeProvider.steerSupported()` returns false, which is whenever its `GET /session/:id/steer/dispatch` qualification request fails (`http-bridge-provider.ts`, `.catch(() => false)` in `native-agent-transcript-projection.ts`).

**Investigation.** The failure did not reproduce. On an isolated `dev:test` profile with a live Claude coordinator, the projection reported `phase: running` and `actions.steer: true`. That held whether the busy turn was started from the composer or by `dispatch_native_agent_intent`. With Auto-steer off the queued row showed Steer, and with it on the message was steered and no row was left. The production log shows what was different about the user's turn. A system mail inject started it at 08:28:04 (`agent-mail inject.dispatched … via=inject`), and the bridge process had been running since before 04:33. Later mail waited with `reason=draft` and then `reason=working`. The turn closed at 08:30:18, and at 08:30:20 the bridge was replaced because the active agent account changed. The queued message was then delivered at 08:30:23. Nothing in the code paths read (projection, provider registry, bridge routes, command routing, the renderer's projection merge) treats a `coordinator:` runtime id differently. The production log has no content-free line recording the projection's steer capability, so the state at 08:28–08:30 cannot be reconstructed.

**Decisions.**

- **How to get evidence?**
  - **Log when steer qualification fails (recommended).** Add a rate-limited, content-free warning in `steerSupported` when the qualification request fails or answers non-OK (agent, status code or error class only), plus a debug line when a projection clears `actions.steer`.
    - Pros: the next occurrence names the cause; cheap; no prompt or session content is logged.
    - Cons: needs a release and another occurrence before it pays off.
  - **Reproduce live on a long-lived coordinator with mail-started turns and an account switch.**
    - Pros: could find the cause without waiting for a release.
    - Cons: needs several worker reports, two Claude accounts and billed turns; it may still miss a timing-dependent cause.

### 2. Fix the cause once it is known

**Problem.** Whatever made the row unsteerable is still unknown.

**Context.** Since this change, a row that cannot be steered while the turn runs says why under its text: the provider cannot steer, an earlier message is still being confirmed, attachments, a command, or the steer refusal itself (`queuedSteerNote` in `auto-steer.ts`). The next occurrence will therefore show which gate closed.

**Investigation.** Not started; it depends on task 1.

**Decisions.**

- **Where to fix?**
  - **Decide after task 1 (recommended).** The fix depends on which gate closed.
    - Pros: no speculative change to steer qualification, which guards at-most-once steering.
    - Cons: the problem can recur until then.
  - **Cache a positive qualification per bridge connection now.**
    - Pros: a transient failed qualification read could no longer hide Steer.
    - Cons: there is no evidence yet that the read failed; it would also hide a bridge that has genuinely lost the route.

## Needs verification

- Whether the user's 2026-11-04 state was `actions.steer: false`, a parked dispatch, or a turn that the renderer did not see as `running`.

## Related

- Ticket cdc7a75f-3633-4353-8d86-112fd74654f1 (Coordinator chat auto-steer and Steer button).
- [0740-coordinator-deliver-now-live-qualification.md](0740-coordinator-deliver-now-live-qualification.md) (mail steered into running turns).
