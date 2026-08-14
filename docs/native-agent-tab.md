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
- Only the active renderer tab refreshes tab-facing bridge snapshots. The
  backend never polls `/session/:id`, `/status` or `/messages` from a background
  cache reconciler, so inactive Codex sessions can detach and inactive Claude
  transcripts can evict normally.
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
sharing state, connection and semantic turn phase, normalized messages and their
window, interactions, composer state and live model metadata, controls, queue
state, context usage and rate limits, runtime inventory, notices, background
tasks, suggested prompts, recoverable-dispatch state, turn boundaries, slash
commands, revision, generation and cursor.

The projection title is what labels the tab, for every provider — including the
ACP agents, which never had a provider store to write one into.

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
| Attach or mention a workspace file; model-gated images | Yes | Images only | Yes | Images only |
| Slash commands | Built-ins plus plugins | Provider commands | Built-ins plus configured commands | No |
| Typed questions/approvals | Yes | Yes | Yes | Yes |
| Provider controls | agents, local settings, suggestions | plan review, steer | execution profiles | reported ACP controls |
| Session actions | compact, rewind files | compact, review, steer | compact, undo/redo, share | No |
| Background tasks | Yes | No | No | No |

Behavior that is shared rather than per-provider, decided by capability:

- The workspace picker offers **both** "attach" and "mention" wherever file
  search works. Attaching is refused with a reason when the agent or the
  selected model cannot read that kind of file, and one ceiling bounds how many
  attachments a prompt may carry.
- Shift+Tab cycles conversation mode for any provider that reports modes.
- A submission that names a **session action** runs that action instead of being
  sent or queued. `/steer` is the only one today, gated on
  `capabilities.actions.steer`, so it reaches the running turn instead of
  queueing behind it. The same commands are merged into the slash-command menu,
  and are removed from it for providers that cannot perform them.
- A submission that names one of the **provider's** own commands is dispatched
  as that command rather than as prompt text. Only interactive dispatch opts in;
  a workflow prompt beginning with a slash stays literal.
- `cancelling` and `recovering` phases render distinct status text, the file
  tree is re-read when the mention menu opens, and a file-search failure is
  reported instead of showing an empty menu.
- Accepting a suggested prompt appends it to the draft and consumes the
  suggestion; providers that track suggestions are told.
- The resume picker is one component for every provider: sorted by most recent
  activity in the backend, with provider-reported status and transcript size.
- The transcript is a bounded window. When older messages exist, the transcript
  says so and offers to load them; the expanded window is resent on every read
  so a reconnect or foreground refresh cannot silently collapse it.

Assigned prompt drafts remain namespaced by platform and logical tab, including
the legacy persistence keys. Before the first send, an unassigned tab uses one
stable `agent-native` record containing its text, attachments, selected
platform, model, reasoning, speed and mode; a reload therefore cannot restore
the text under a different default provider. A prompt that is waiting for the
first environment rename also persists its stable request id, so a remounted
tab can retry without creating a duplicate provider turn. Attachments are
reconciled against the selected agent's capabilities per type, not
all-or-nothing: a draft that changes provider, or is restored under one, keeps
only the kinds that agent accepts. This matters because a bridge may refuse the
whole prompt rather than drop the entry it cannot use — Codex takes images and
rejects files with `400` — so an unreconciled draft would fail the send with an
error naming an attachment the composer had stopped offering. Keyboard
submission restores the editor focus; mouse submission leaves focus on the
clicked control.

Forking preserves each provider's actual boundary semantics: Claude uses
inclusive source-message boundaries, Codex uses turn boundaries, and OpenCode
uses its exclusive message boundary. Fork-and-edit restores the prompt in the
new tab; attachments are deliberately not copied and the user is told when any
were dropped. Forking the first prompt creates a fresh empty provider session
instead of accidentally cloning the complete conversation.

Stopping a turn records a content-free, session-scoped marker in the shared
renderer store. It survives inactive-tab unmounts and is cleared when a new
turn is accepted or the provider-session identity changes.

Interactive dispatch is journaled before provider I/O. If acknowledgement is
lost, the backend retains the exact replay payload in its sensitive store while
the projection exposes only a content-free request id and timestamp. Every
provider therefore uses the same backend-owned Retry intent and the original
idempotency key; renderer remounts never have to reconstruct a request from a
draft or guess whether a turn ran.

Provider terminal errors and external aborts are normalized into stable system
rows before the projection reaches React. Provider adapters only recognize
their wire-specific error envelopes; message construction and presentation are
shared.

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
