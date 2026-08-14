# Native agent consolidation plan v2

**Status:** implemented; completion audit 2026-08-14

**Predecessor:** [`native-agent-consolidation-plan.md`](native-agent-consolidation-plan.md)

**Architecture:** [`../native-agent-tab.md`](../native-agent-tab.md)

The consolidation is complete: there is one `agent-native` React controller.
Provider lifecycle, transport, reconciliation and wire formats terminate in
backend or bridge adapters. The renderer consumes a typed, provider-neutral,
authoritative projection and sends provider-neutral intents.

## Completion audit

| Milestone | Result | Evidence |
| --- | --- | --- |
| R0 · Parity contract | Complete | The protocol and adapter registry cover attachments, queue, resume, fork, slash commands, interactions, controls, context, notices and background tasks. Provider and shared-controller tests exercise the normalized contracts. |
| R1 · Backend projection core | Complete | `NativeAgentService` owns a bounded reconstructible projection cache, monotonic revisions/generations/cursors, provider snapshot refresh and `native-agent-session` resource invalidation. |
| R2 · Shared state machine | Complete | `useNativeAgentSession` reads the full projection, refreshes on mount/activation/resource events, and exposes neutral send, stop, queue, interaction, control, resume, fork, background-task and suggestion intents. |
| R3 · ACP | Complete | Cursor and Grok use the shared controller; ACP snapshot/window/approval handling is normalized below React; `AcpChatTab` is deleted. |
| R4 · Codex | Complete | Semantic phases, generation/revision state, controls, interactions, context, plan review, queue, resume and fork are projected; the renderer background reconciler and Codex controller/composer are deleted. |
| R5 · Claude | Complete | Messages, plan mode, interactions, suggestions and background tasks are authoritative projection fields; Claude controller/composer are deleted. |
| R6 · OpenCode | Complete | The backend owns SDK lifecycle and recovery, hydrates bounded child transcripts, projects interactions/notices, and fences manual dispatch against automatic recovery; OpenCode controller/composer are deleted. |
| R7 · Router cleanup | Complete | `NativeAgentAdapter` is metadata-only, `AgentNativeTab` is the sole pane controller, and all providers render the same shell/compose path. Provider stores that remain serve tmux, launch/settings, handoff and compatibility surfaces—not native-tab authority. |

## Final architecture

```text
PaneLeafContainer
  -> AgentNativeTab
    -> useNativeAgentSession
      -> neutral backend commands + resource invalidation
        -> NativeAgentService
          -> NativeAgentRuntimeProvider
            -> Claude bridge adapter
            -> Codex app-server bridge adapter
            -> OpenCode SDK adapter
            -> Cursor/Grok ACP bridge adapter
    -> NativeChatShell
    -> NativeComposeBar
      -> capability-driven controls
      -> typed interaction and provider-specific presentation slots
```

`BuildPipelineProvider` remains the narrow workflow interface. The sibling
`NativeAgentRuntimeProvider` carries interactive snapshot, controls, resume,
fork, slash-command and typed auxiliary intents.

## Implemented contract

`NativeAgentSessionProjection<NativeMessage>` contains:

- stable session identity, connection state and semantic turn phase;
- normalized messages and pending interactions;
- capability-driven composer/model/reasoning/speed/mode state;
- durable queue state and blocked-send errors;
- context usage, recovery notices and turn boundaries;
- Claude background tasks and prompt suggestions;
- bounded slash-command and live model discovery;
- authoritative OpenCode session title/share state and runtime inventory; and
- monotonic revision, provider generation and reconciliation cursor.

The renderer exposes neutral intents for ensure/adopt, dispatch, stop, queue
mutation/retry, interaction resolution, control updates, resume, fork,
background-task stop and suggestion dismissal. Dispatch preserves stable request
IDs and distinguishes accepted, rejected and unknown outcomes.

## Provider-specific behavior retained below the boundary

- Codex app-server generations, cancelling/recovering phases, config and plan
  review;
- Claude prompt suggestions, plan mode and background tasks;
- OpenCode execution agents, permissions/questions, incomplete-turn recovery
  bounded child-session hydration, live model/image capabilities and sharing;
  and
- ACP message windows, polling and approvals.

Typed presentation-only components may still show distinct provider semantics.
They do not own clients, polling, event subscriptions, transcript state or
dispatch.

## Safety properties

- Long-running work survives tab unmount and inactive environments.
- Remount and activation rehydrate complete authoritative snapshots.
- Live resource events are invalidation hints, never the only source of truth.
- Revision/generation changes make missed state detectable and recoverable.
- Provider reads and caches have explicit item/byte/concurrency bounds.
- Ambiguous dispatch is not blindly retried.
- OpenCode manual dispatch cannot race automatic incomplete-turn continuation.
- Approval timeout, disconnect, malformed answers and dead generations remain
  fail-closed.
- Diagnostics do not contain prompts, transcripts, attachments or credentials.

## Definition-of-done audit

- `AgentNativeTab` is the only pane-level native-agent controller.
- `NativeAgentAdapter` cannot return a React component.
- `AcpChatTab`, `ClaudeChatTab`, `CodexChatTab` and `OpenCodeChatTab` are deleted.
- Provider composer hooks and the renderer-owned Codex background reconciler are
  deleted.
- The shared hook consumes the full neutral projection and exposes neutral
  intents.
- Every provider rehydrates messages, turn state, interactions, queue and
  controls from authoritative snapshots.
- All providers render `NativeChatShell` and `NativeComposeBar` through the same
  component path.
- Provider-specific residue in that path is typed and presentation-only.
- Platform-specific controls are capability-gated inside the shared component;
  there are no provider-specific tab implementations.
- Ordinary drafts, first-prompt options, queued-message editing, handoff,
  stop markers, model defaults and provider-specific fork boundaries retain
  their pre-consolidation behavior.
- The old raw container-log drawer is intentionally represented by bounded
  provider errors, recovery notices and Retry. Unbounded process output is not
  copied into renderer state because it can contain prompt/file data.

Verification results and any environment-dependent exceptions belong in the
change handoff rather than this durable architecture record.
