# 11 — Control sessions and resolve pending interactions

Status: Planned.
Depends on: [09](09-sessions-and-prompt-dispatch.md),
[10](10-run-completion-and-waiting.md).
Index: [CLI commands plan](00-cli-commands-index.md).

## Target behavior

Operators can stop/steer one active turn, configure supported session controls,
resume/fork history, and answer an exact pending question or approval. Capability
and generation checks prevent a stale script from affecting a different turn.

## Owners and starting points

- [Native command registry](../../../../apps/backend/src/core/commands-registry-native.ts).
- [Native dispatch/control service](../../../../apps/backend/src/core/native-agent-service-dispatch.ts).
- [Interaction protocol](../../../../packages/protocol/src/agent-interactions.ts)
  and [native capabilities/actions](../../../../packages/protocol/src/native-agent.ts).
- [Reconciliation](../../../../apps/backend/src/core/native-agent-service-reconciliation.ts).
- [Native slash-command contract](../../../architecture/native-agent-commands.md).

## Work

1. Implement `session stop` using the native stop operation. Resolve and bind
   expected run/turn identity before cancellation; reject a mismatch if a new
   turn started. A stop action receipt records requested, acknowledged, unknown,
   or failed cancellation and links to the original run's terminal outcome.
2. Implement `session steer` only where supported. Preserve explicit steering
   intent and its request ID through the existing steer journal. Do not answer
   success for idle/mismatched/unknown results or fall back to a new prompt.
3. Implement `session config get/set` through existing live-control validation.
   Return effective provider values after application, including any rejection
   or documented clamping. Setting a live model/mode differs from changing
   inherited environment defaults in step 08; expose those scopes in help.
4. Implement history listing/resume and fork using existing provider capability
   gates. Resolve whether a fork returns a new public session or rebinds an
   existing tab, then expose the resulting identity explicitly. Preserve
   provider history; never implement close/resume with Codex `thread/delete`.
5. Add `session interactions list` over authoritative pending-interaction
   snapshots, including origin, question/approval type, permitted answer shape,
   and generation/version identity. Return only the bounded detail needed to
   make the decision; keep routine session summaries to counts/IDs.
6. Resolve one exact interaction through `resolve_native_agent_interaction`.
   Validate answer type/options and authority. Bind to the live generation and
   handle duplicate answers idempotently; concurrent contradictory answers
   conflict. A lost acknowledgement must be queried, not turned into approval.
7. Preserve backend timeout/disconnect/dead-generation fail-closed behavior.
   CLI exit does not automatically deny a prompt that remains valid for other
   clients, and it never implicitly approves one. A withdrawn interaction must
   return a stale/expired result rather than answer a replacement question.
8. Expose `run retry/discard` only for the existing recoverable prompt/steer
   record identified by that operation. Retry preserves its exact original
   intent/key; discard clears recovery state and explicitly does not undo a
   possibly executed command. Neither operation manufactures a fresh prompt.
9. Keep selected slash commands and durable queue controls out of ordinary
   prompt parsing. If added here, require the authoritative catalogue and
   revisioned intent contract; otherwise leave their capability unavailable.

## Verification

Cover unsupported controls, model rejection/clamping, idle steer, expected-turn
mismatch, stop-before-provider-handle, late stop acknowledgement, and restart
while cancelling. Test concurrent sessions so only the target is affected.

For interactions, cover answers while the UI is unmounted, simultaneous CLI/UI
answers, invalid options, expiration, bridge death, stale generation, duplicate
same answer, conflicting answer, and lost response. Verify no failure path
approves automatically. Resume/fork must preserve the original history.

## Acceptance and handoff

- [ ] Controls target an exact live session/turn and obey provider capabilities.
- [ ] Cancellation success requires authoritative acknowledgement/outcome.
- [ ] Pending interactions rehydrate and remain answerable without a renderer.
- [ ] Stale, malformed, contradictory, or dead-generation answers fail safely.
- [ ] Retry/discard preserve existing uncertainty and at-most-once constraints.

Withdraw individual unqualified capabilities instead of changing their meaning.
Keep already-pending interactions and recovery records accessible to existing
clients during any rollback.
