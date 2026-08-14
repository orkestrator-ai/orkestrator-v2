# Native agent consolidation plan v2

**Status:** remaining-work plan, audited 2026-08-14  
**Predecessor:** [`native-agent-consolidation-plan.md`](native-agent-consolidation-plan.md)

This document updates the original consolidation plan after auditing what
actually landed. The first plan established the right product direction and
delivered much of the common presentation layer, but it did not complete the
session-lifecycle consolidation that makes one native tab real.

The central decision remains unchanged and is made more explicit here:

> There is one `agent-native` React controller. Provider-specific lifecycle,
> transport, reconciliation and wire formats terminate in backend or bridge
> adapters. The renderer consumes a typed, provider-neutral, authoritative
> session projection and sends provider-neutral intents.

`AcpChatTab`, `ClaudeChatTab`, `CodexChatTab` and `OpenCodeChatTab` are migration
scaffolding, not the target architecture.

## Why a v2 is needed

The codebase now looks unified at its outer edges:

- one `agent-native` pane type and canonical `NativeAgentTabData`;
- one provider-neutral entry component, `AgentNativeTab`;
- one `NativeChatShell`;
- one `NativeComposeBar`;
- one `AgentModelPicker` and one backend-normalized model catalog;
- deferred provider selection with a durable, lock-once first dispatch; and
- a capability registry for all five native providers.

But the central lifecycle is still split. `AgentNativeTab` asks
`NativeAgentAdapter.loadController()` for a complete provider React component.
The result is a shared facade over these controllers:

| Controller | Current size |
| --- | ---: |
| `ClaudeChatTab.tsx` | 3,063 lines |
| `CodexChatTab.tsx` | 3,357 lines |
| `OpenCodeChatTab.tsx` | 3,392 lines |
| `AcpChatTab.tsx` | 390 lines |
| **Total provider controllers** | **10,202 lines** |

`useNativeAgentSession` is only 68 lines. It shares session identity, launch
option acknowledgement and a few lifecycle refs, but its own comment states
that provider controllers still own transport reconciliation. The declared
`NativeAgentSessionProjection` is used only as a three-field identity pick; no
backend service produces the complete projection.

This is the “half implemented” state: presentation converged while connection,
rehydration, streaming, dispatch reconciliation, interaction handling, resume,
fork, queue and stop behavior remain inside mounted provider components.

## Audit of the original plan

| Original phase | Status | Current evidence | Remaining gap |
| --- | --- | --- | --- |
| P0 · Clear the ground | Complete | The dead Codex barrel is gone. | None. |
| P1 · One tab type | Complete | Pane layout v3 uses `agent-native`; platform is lock-once and unassigned is durable. | Legacy names remain only where teardown compatibility still requires them. |
| B1 · One model catalog | Complete | `AgentModel` is shared and `get_native_agent_model_catalog` normalizes provider catalogs in the backend. | Live catalog refresh still follows provider-specific paths. |
| B2 · One model picker | Complete | `AgentModelPicker` and global favorites are shared across native launch and compose surfaces. | None required for controller consolidation. |
| B3 · Capability-driven controls | Partial | Adapters publish capabilities and shared controls exist. | Each provider composer hook still hand-assembles controls; `composerControls` is not projected by the runtime. |
| B4 · Deferred provider selection | Complete | `AgentNativeTab` owns the unassigned composer and persists the provider lock before dispatch. | Draft ownership diverges again after the provider controller mounts. |
| A1 · Normalize messages low | Partial | Codex and OpenCode are close to `NativeMessage`; shared renderer normalization exists. | Claude and ACP still cross into the renderer with provider-shaped messages, and display normalization remains mixed with wire normalization. |
| A2 · Shared session hook | Skeleton only | The hook shares identity and a few refs. | The provider-neutral projection, lifecycle state machine and intents are not wired. This is now the critical path. |
| C1 · One compose bar | Complete at the visual component boundary | Claude, Codex, OpenCode, Cursor, Grok and the unassigned state render `NativeComposeBar`. | Provider hooks still own draft stores, menus, queue wiring and control construction. |
| C2 · One controller | Not started | `loadController()` still lazy-loads four full controller implementations. | All provider controllers, including `AcpChatTab`, remain. |

## Current architecture and failure mode

```text
PaneLeafContainer
  -> AgentNativeTab                         shared facade and unassigned state
    -> NativeAgentAdapter.loadController()  provider selects a React component
      -> ClaudeChatTab                      renderer-owned lifecycle
      -> CodexChatTab                       renderer-owned lifecycle
      -> OpenCodeChatTab                    renderer-owned lifecycle
      -> AcpChatTab                         renderer-owned lifecycle
    -> NativeChatShell                      shared presentation
    -> NativeComposeBar                     shared visual composer
```

The separate controllers are currently functional owners, not harmless view
wrappers. For example, `AcpChatTab` performs bridge readiness, session adoption,
snapshot rehydration, incremental message-window merging, approval reads,
polling, reconnect backoff, durable dispatch and cancellation. The larger
controllers do the equivalent work with more provider-specific states.

Deleting those files before moving their authority would only inline four
state machines into `AgentNativeTab` and replace file duplication with a giant
provider switch. That is explicitly not this plan.

## Revised target architecture

```text
PaneLeafContainer
  -> AgentNativeTab
    -> useNativeAgentSession
      -> NativeAgentClient                  provider-neutral commands + resource stream
        -> NativeAgentRuntimeService        backend authority and projection owner
          -> ClaudeRuntimeAdapter           Claude bridge protocol
          -> CodexRuntimeAdapter            Codex bridge/app-server protocol
          -> OpenCodeRuntimeAdapter         OpenCode SDK/server protocol
          -> AcpRuntimeAdapter              Cursor/Grok ACP protocol
    -> NativeChatShell
    -> NativeComposeBar
      -> capability-driven controls
      -> typed interaction/card slots
```

Everything above `NativeAgentClient` speaks only protocol types:

- `NativeAgentSessionProjection<NativeMessage>`;
- `NativeAgentCapabilities`;
- `NativeAgentComposerControl`;
- `NativeAgentDispatchOutcome`;
- normalized interaction and queue types; and
- `AgentModel`.

No provider SDK object, bridge payload, sparse patch, ACP window, raw question,
approval request or provider store type crosses into `AgentNativeTab`.

### Why the backend owns the projection

The backend already owns durable native-session identity, at-most-once dispatch,
activity sweeps, prompt queues and unattended workflow coordination. Making a
mounted React component the remaining lifecycle authority conflicts with the
application’s background reliability rules:

- inactive or unmounted tabs must not stop work;
- a remount must rehydrate from an authoritative snapshot;
- live events are incremental hints over that snapshot;
- missed events must be detectable and recoverable; and
- pending interactions must survive a renderer disconnect.

Bridges or upstream providers remain the ultimate source of truth for their
own sessions. The backend projection is the normalized authoritative view for
Orkestrator clients: it reads provider snapshots, tracks bounded reconciliation
state, emits revisions and never depends on a particular tab being mounted.

## Contract changes

### 1. Separate interactive runtime from the workflow provider interface

`BuildPipelineProvider` is intentionally narrow: create, send, status,
activity, messages, structured output and abort. Do not turn it into a UI
interface with dozens of optional fields.

Add a sibling backend contract, tentatively `NativeAgentRuntimeProvider`, that
may compose a `BuildPipelineProvider` but has interactive-session semantics:

```typescript
interface NativeAgentRuntimeProvider {
  readonly platform: AgentPlatform;
  readonly capabilities: NativeAgentCapabilities;

  ensure(input: EnsureNativeAgentSessionInput): Promise<string>;
  adopt(input: AdoptNativeAgentSessionInput): Promise<string>;
  snapshot(sessionId: string): Promise<NativeAgentProviderSnapshot>;
  dispatch(sessionId: string, intent: NativeAgentDispatchIntent): Promise<NativeAgentDispatchOutcome>;
  stop(sessionId: string): Promise<NativeAgentStopOutcome>;
  resolveInteraction(
    sessionId: string,
    interactionId: string,
    resolution: NativeAgentInteractionResolution,
  ): Promise<void>;

  updateControls?(sessionId: string, controls: NativeAgentControlUpdate): Promise<void>;
  listResumableSessions?(): Promise<NativeAgentResumeEntry[]>;
  fork?(sessionId: string, turnId: string): Promise<string>;
  dispose?(): Promise<void> | void;
}
```

The exact names can change during implementation. The important boundary is
that provider adapters return typed provider-neutral snapshots and outcomes,
not React components or `unknown[]`.

### 2. Finish `NativeAgentSessionProjection`

The existing projection is the seed, not the finished schema. Extend it only
with behavior already required by current controllers:

- stable logical and provider session identity;
- connection state and semantic turn phase;
- normalized messages;
- normalized pending interactions;
- capabilities and current composer controls;
- queue snapshot and blocked-send error;
- context usage where supported;
- resumable/forkable turn metadata;
- typed notices such as recovery warnings or incomplete-turn state;
- background-task summaries where supported; and
- `revision`, provider `generation` and replay `cursor`.

Do not add a generic provider payload escape hatch. If a feature must reach the
renderer, give it a bounded discriminated protocol type. Otherwise provider
wire formats will leak back across the boundary and recreate the current tabs
inside one union.

### 3. Add provider-neutral intents

The renderer sends intent, not provider HTTP:

- ensure or adopt;
- dispatch, including attachments and chosen controls;
- stop;
- enqueue, remove from queue and retry blocked queue entries;
- resolve an interaction;
- update model/reasoning/speed/mode;
- resume;
- fork from a normalized turn boundary; and
- explicit refresh/reconcile.

Every dispatch carries a stable request id. `unknown` dispatch outcomes are
reconciled against the authoritative snapshot and are never blindly retried.

### 4. Use the backend resource stream

Add native-session projection events to the existing resource/event transport
rather than opening one renderer-owned provider stream per tab.

The stream contract must preserve the repository invariants:

- subscribe before calculating replay;
- the connected frame echoes the client cursor;
- every projection event has a monotonic revision within a generation;
- generation changes and revision gaps force snapshot reconciliation;
- expired cursors produce an explicit reconciliation frame;
- authoritative state events are never silently dropped; and
- all rings, queues and decoded frames have byte and count bounds.

Provider stream readers must never await renderer delivery. ACP polling moves
into its backend adapter and publishes only changed projections.

## What remains provider-specific

Provider-neutral does not mean pretending providers have identical protocols.
These differences stay below the runtime contract:

- Codex sparse revision patches, app-server generations, plan review and
  cancelling/recovering phases;
- Claude message patches, prompt suggestions, background tasks and plan
  approval semantics;
- OpenCode child-session hydration, execution agents, variants, permissions,
  questions and incomplete-turn recovery;
- ACP message windows, `baseIndex` eviction, bridge polling and its smaller
  capability set; and
- provider model-catalog and session-create payload mapping.

Small presentation components may remain provider-specific when the user must
see genuinely different semantics, such as a structured plan approval. They
are selected from typed projection data and injected into shared
`NativeChatShell` slots. They do not own sessions, clients, polling, reconnects
or dispatch.

## Work plan

The migration is provider-by-provider. A provider can use the new runtime while
another still uses its legacy controller, but a single logical session must
never have two dispatch owners.

### R0 · Freeze the parity contract

**Effort:** 1–2 days.

Before moving authority, inventory the externally visible behavior of every
controller and encode it in a provider capability/parity matrix.

**Changes**

- Enumerate send, stop, queue, resume, fork, controls, attachments, slash
  commands, interactions, plan cards, context usage, prompt suggestions,
  background tasks and reconnect behavior.
- Add provider-neutral projection fixtures for idle, running, blocked,
  cancelling, recovering, error and missing sessions.
- Add contract tests that render `NativeChatShell` and `NativeComposeBar` from
  those fixtures without importing a provider client.
- Record current inactive-environment and generation-restart behavior as
  integration gates.

**Gate**

The fixture matrix covers every capability published by the adapter registry
and every blocking-card type rendered by the current controllers.

### R1 · Backend projection core and resource stream

**Effort:** 4–6 days.

Create `NativeAgentRuntimeService` beside the existing native-agent service, or
evolve that service behind a deliberately separate interactive interface.

**Changes**

- Implement validated `getNativeAgentProjection` and provider-neutral intent
  commands.
- Add a bounded projection cache keyed by durable native-session identity.
- Make the cache reconstructible from provider snapshots; it is never the only
  source of truth.
- Emit revisioned `native-agent-session` resource events.
- Add common interaction, queue, context and composer-control protocol types.
- Keep logs and metrics content-free.
- Implement the ACP runtime adapter first because it is small and already uses
  backend-owned durable dispatch.

**Gate**

- ACP work continues while its tab is inactive or unmounted.
- Remount returns messages, turn state and pending approvals from one
  authoritative projection.
- A missed event, stale cursor or bridge generation change is detected and
  reconciled.
- Backend restart and bridge restart tests preserve the durable mapping.

### R2 · Make `useNativeAgentSession` the shared state machine

**Effort:** 4–6 days.

Expand the existing hook instead of adding a second shared hook.

**Responsibilities**

- acquire the authoritative projection;
- subscribe to the shared resource stream;
- apply only contiguous incremental revisions;
- reconcile gaps and generation changes;
- expose provider-neutral send, stop, queue, interaction, control, resume and
  fork intents;
- manage transient UI state such as a draft-send spinner without claiming
  long-running authority; and
- rehydrate on mount or activation without treating unmount as cancellation.

The hook returns data and intents. It never returns provider SDK clients,
bridge URLs, bearer tokens or wire payloads.

**Gate**

A test harness runs the same lifecycle cases for each runtime fixture with no
provider component imports.

### R3 · Migrate ACP and delete `AcpChatTab`

**Effort:** 2–3 days after R1–R2.

This is the first proof that the abstraction removes a controller rather than
wrapping it.

**Changes**

- Render Cursor and Grok directly from `AgentNativeTab` using the shared hook.
- Render ACP approvals from normalized interactions.
- Move ACP reconnect, message-window polling and approval hydration fully into
  the runtime adapter.
- Preserve current capability restrictions through projected controls.
- Remove the ACP `loadController` branch.
- Delete `components/acp/AcpChatTab.tsx` and replace its component tests with
  runtime contract and shared-tab integration tests.

**Gate**

Cursor and Grok pass manual dispatch, cancellation, reconnect backoff,
background completion, remount rehydration and approval-resolution tests with
no ACP React lifecycle component.

### R4 · Migrate Codex

**Effort:** 5–7 days.

Codex is the reference rich bridge provider because its messages are already
closest to the target shape.

**Changes**

- Move sparse-patch and replay reconciliation below the renderer client
  boundary.
- Project cancelling and recovering as semantic turn phases.
- Normalize approvals, interactions, plan review, context usage and session
  controls.
- Move queue promotion, dispatch ambiguity reconciliation, resume and fork
  orchestration into the common lifecycle/runtime boundary.
- Delete `CodexChatTab.tsx` and `useCodexNativeComposer.tsx` once parity gates
  pass; retain genuinely reusable Codex card components.

**Special gates**

- The app-server stdout loop never awaits projection rendering or event writes.
- Ambiguous dispatch is reconciled and never automatically retried.
- Cancelling/recovering never appears idle.
- Approval timeout, disconnect, malformed answer and generation death deny.

### R5 · Migrate Claude

**Effort:** 5–7 days.

**Changes**

- Normalize Claude bridge messages before they enter the projection.
- Move patch-gap recovery, server-log/retry state, prompt suggestions and
  background-task snapshots below the renderer.
- Project plan/build controls and plan approvals through typed contracts.
- Move resume, fork, queue and stop behavior to the shared lifecycle.
- Delete `ClaudeChatTab.tsx` and `useClaudeNativeComposer.tsx` after parity.

**Special gates**

- Background tasks and pending interactions rehydrate after an entire turn
  completes while the environment is inactive.
- Patch gaps refetch the authoritative transcript rather than rendering a
  partial message.

### R6 · Migrate OpenCode

**Effort:** 6–8 days.

V1 treated the renderer client as OpenCode’s lowest practical normalization
layer because OpenCode has no repository bridge process. V2 deliberately moves
the interactive OpenCode runtime behind the backend boundary instead. The
backend already has OpenCode provider and recovery machinery; keeping a second
interactive SDK lifecycle in React would leave the central architectural
problem unsolved.

**Changes**

- Backend-own the interactive SDK client, event subscription and authoritative
  snapshot recovery.
- Project child-session messages, permissions, questions, context usage,
  execution-agent controls and incomplete-turn notices.
- Preserve the existing manual-prompt claim that fences automatic incomplete
  turn recovery.
- Move resume, fork, queue and stop behavior to the shared lifecycle.
- Delete `OpenCodeChatTab.tsx` and `useOpenCodeNativeComposer.tsx` after parity;
  retain typed question/permission presentation components if still useful.

**Special gates**

- A question or permission cannot be lost when the renderer disconnects.
- Manual prompt dispatch and automatic recovery cannot race.
- Child-session hydration has explicit bounds and an authoritative refetch
  path.

### R7 · Remove the controller router and provider stores

**Effort:** 3–5 days.

After all providers use the shared runtime:

- remove `NativeAgentAdapter.loadController` and the lazy controller cache;
- make adapters metadata/runtime registrations rather than component factories;
- make `AgentNativeTab` the only pane-level native agent controller;
- converge provider draft/queue/control state onto provider-neutral stores or
  backend projections as appropriate;
- remove renderer bridge-readiness and provider-client code no longer used by
  non-tab surfaces;
- update `docs/native-agent-tab.md` to describe the final architecture; and
- retain `claude-tmux` as a separate terminal surface.

**Gate**

An `rg` audit finds no pane-level imports or lazy loads of `ClaudeChatTab`,
`CodexChatTab`, `OpenCodeChatTab` or `AcpChatTab`, and no adapter member capable
of returning a React component.

## Migration safety

### Cut over one provider at a time

Use an internal provider registration or compile-time migration switch while a
provider is being moved. It may select either the legacy controller or the new
runtime, never both. Remove the switch when that provider’s old controller is
deleted.

### Shadow reads are allowed; shadow writes are not

During validation, the backend may compute a projection and compare bounded,
content-free properties with the legacy controller’s snapshot: revision,
message count, last message id, turn phase, interaction count and queue length.
Never duplicate send, stop, resolve, resume or fork operations for comparison.

### Preserve compatibility at external boundaries

- Keep pane layout v2 read compatibility for its planned support window.
- Keep existing bridge routes while their legacy controller is still live.
- Version bridge message-shape changes.
- Do not change provider session ids during renderer migration.

### Fail closed

Approval and question resolution remains fail-closed. A timeout, disconnect,
dead generation, malformed answer or stale interaction id never becomes an
approval because of migration fallback.

## Test strategy

Every runtime adapter runs a shared conformance suite:

1. ensure and adopt are idempotent;
2. initial prompt dispatch is at most once;
3. accepted, rejected and unknown dispatch outcomes are distinct;
4. stop reconciles ambiguous outcomes;
5. snapshots are authoritative and bounded;
6. incremental events apply only across contiguous revisions;
7. generation changes force reconciliation;
8. interactions rehydrate and resolve exactly once;
9. capability-disabled intents are rejected before provider I/O;
10. unmount does not stop a turn;
11. remount recovers a turn completed while inactive; and
12. logs, metrics and diagnostics contain no prompt, transcript, attachment,
    credential or file content.

Provider suites then add their real differences. Shared renderer tests cover
the matrix of capabilities and typed card slots once, not once per provider.

When running aggregate or parallel suites, capture complete output to log files
as required by `AGENTS.md`. A failure that passes when its owning file is rerun
alone must be handled through `docs/flaky-tests.md`; consolidation must not hide
it by weakening or skipping the test.

## Definition of done

The consolidation is complete only when all of the following are true:

- `AgentNativeTab` is the only pane-level native agent React controller.
- `NativeAgentAdapter` cannot load or return a React component.
- `AcpChatTab.tsx`, `ClaudeChatTab.tsx`, `CodexChatTab.tsx` and
  `OpenCodeChatTab.tsx` are deleted.
- The renderer does not own provider polling, event streams, reconnect loops or
  authoritative transcript state.
- `useNativeAgentSession` consumes the full
  `NativeAgentSessionProjection<NativeMessage>` and exposes neutral intents.
- Every provider rehydrates messages, turn state, pending interactions, queue
  and controls from an authoritative snapshot.
- Every missed event is detectable and recoverable.
- All native providers render `NativeChatShell` and `NativeComposeBar` through
  the same component path.
- Provider-specific UI residue is limited to typed, presentation-only slots.
- The inactive-environment, bridge-restart, backend-restart, approval and
  ambiguous-dispatch gates pass for every provider.

## Expected result

This v2 does more than remove `AcpChatTab`. It removes the architectural reason
for any provider tab component to exist. Adding a future native provider means
registering backend transport, normalization, capabilities and optional typed
cards; it does not mean copying a React session controller.
