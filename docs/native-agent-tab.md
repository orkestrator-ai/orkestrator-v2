# Native agent tab architecture

Every native provider enters the pane renderer through the same
`AgentNativeTab` controller and `useNativeAgentSession` state machine. Provider
transport, reconciliation and authoritative long-running state terminate in
the backend or bridge layer.

```text
PaneLeafContainer
  -> AgentNativeTab
    -> useNativeAgentSession
      -> provider-neutral backend commands + resource invalidation
        -> NativeAgentService
          -> NativeAgentRuntimeProvider
            -> Claude/Codex/OpenCode/ACP transport adapter
    -> NativeChatShell
    -> NativeComposeBar
```

## Boundaries

- Pane layout stores `NativeAgentTabData`: platform, environment, container and
  provider-session identity. The platform is durable and locks on the first
  dispatch; an unassigned tab is also a valid durable state.
- `NativeAgentAdapter` contains metadata and capabilities only. It cannot load
  or return React components.
- `NativeAgentService` owns the bounded, reconstructible session projection.
  Providers and bridges remain the ultimate sources of truth.
- The renderer reads `NativeAgentSessionProjection<NativeMessage>` and sends
  neutral intents for dispatch, stop, queue, controls, interactions, resume and
  fork. It never receives bridge credentials, SDK clients or provider wire
  envelopes.
- Resource events are invalidation hints. Mount, activation, generation change
  and revision discontinuity all reconcile through a complete authoritative
  snapshot.
- A tab unmount never means cancellation. Backend timers, provider sessions,
  prompt queues, pending interactions and OpenCode recovery continue without a
  mounted React tree.
- Provider-specific UI is restricted to typed presentation components, such as
  the Codex plan-mode card and Claude background-task card. Those components do
  not own transport or session lifecycle.
- `claude-tmux` remains separate because it is a terminal/tmux surface rather
  than a native bridge session.

## Projection contents

The shared projection includes stable logical/provider identity, title and
sharing state, connection and semantic turn phase, normalized messages and
interactions, composer state and live model metadata, controls, queue state,
context usage and rate limits, runtime inventory, notices, background tasks,
suggested prompts, turn boundaries, slash commands, revision, generation and
cursor.

Provider-specific snapshot behavior is normalized before that boundary:

- Codex generations, semantic cancelling/recovering phases, config and plan
  review;
- Claude plan mode, prompt suggestions and background tasks;
- OpenCode live provider/model discovery, model-specific image support,
  execution profiles, permissions/questions, share-state rehydration,
  incomplete-turn recovery and bounded child transcripts; and
- ACP composer snapshots, message windows and approvals.

## Shared interaction behavior

The component tree is unified; capabilities decide what is shown. Unsupported
controls are omitted instead of routing the tab to a provider-specific React
controller.

| Surface | Claude | Codex | OpenCode | Cursor/Grok ACP |
| --- | --- | --- | --- | --- |
| Send/stop, model, reasoning, speed/mode when reported | Yes | Yes | Yes | Yes |
| Durable compose drafts and first-prompt provider lock | Yes | Yes | Yes | Yes |
| Queue, resume and per-message fork | Yes | Yes | Yes | No |
| Files/images | Yes | Yes | Files and model-gated images | No |
| Slash commands | Built-ins plus plugins | Provider commands | Provider commands | No |
| Typed questions/approvals | Yes | Yes | Yes | Yes |
| Provider controls | agents, local settings, suggestions | plan review, steer | execution profiles | reported ACP controls |
| Session actions | compact, rewind files | compact, review, steer | compact, undo/redo, share | No |
| Background tasks | Yes | No | No | No |

Assigned prompt drafts remain namespaced by platform and logical tab, including
the legacy persistence keys. Before the first send, an unassigned tab uses one
stable `agent-native` record containing its text, attachments, selected
platform, model, reasoning, speed and mode; a reload therefore cannot restore
the text under a different default provider. Attachments are restored only on
platforms that can consume them. Keyboard submission restores the editor
focus; mouse submission leaves focus on the clicked control.

Forking preserves each provider's actual boundary semantics: Claude uses
inclusive source-message boundaries, Codex uses turn boundaries, and OpenCode
uses its exclusive message boundary. Fork-and-edit restores the prompt in the
new tab; attachments are deliberately not copied and the user is told when any
were dropped. Forking the first prompt creates a fresh empty provider session
instead of accidentally cloning the complete conversation.

Stopping a turn records a content-free, session-scoped marker in the shared
renderer store. It survives inactive-tab unmounts and is cleared when a new
turn is accepted or the provider-session identity changes.

Raw container log panes are not part of the shared projection. Connection
failures expose bounded provider errors, recovery notices and an explicit Retry
action; this preserves the actionable diagnostic path without moving prompts,
transcripts, attachments, credentials or unbounded process output into renderer
state.

## Adding a provider

1. Add the platform to the shared agent-platform protocol.
2. Implement a backend `NativeAgentRuntimeProvider` transport adapter that
   returns bounded provider-neutral snapshots.
3. Register metadata and capabilities in `nativeAgentAdapters`.
4. Add provider and shared-controller contract coverage. Do not add a pane-level
   React controller or renderer-owned event loop.
