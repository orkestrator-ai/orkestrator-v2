# Native agent consolidation plan

Sequenced plan to finish the consolidation begun in
[`docs/native-agent-tab.md`](../native-agent-tab.md) (PR #345): push every
provider difference as low as it can go, normalize as early as possible, and
leave a single set of provider-neutral components on top.

## Why this exists

PR #345 added a provider-neutral routing seam (`NativeAgentTab` + the adapter
registry) but removed no duplicated logic. Net non-test change was +658 lines;
each of the three large controllers changed by exactly two lines, swapping a
direct normalizer import for an indirect call through the adapter. The
controllers are still 3061 / 3357 / 3407 lines with 21 identically-named
callbacks between them, several byte-identical.

The seam is the right seam. It was placed *above* the duplication rather than
below it, so `loadController()` returns a whole 3000-line component and nothing
was collapsed. This plan moves the boundary down.

## The normalization ladder today

The four providers sit on four different rungs of the same ladder, for no
structural reason:

| Provider | Where wire → `NativeMessage` happens | Controller receives |
| --- | --- | --- |
| Codex | the bridge process | `CodexMessage`: `NativeMessage`-shaped + `modelId`/`revision`/`planReview` |
| OpenCode | the renderer client | `OpenCodeMessage = NativeMessage & { hasError?, errorName?, finishReason? }` |
| ACP | the controller, at render | `AcpMessage` with its own `parts: Array<{type, text}>` |
| Claude | the controller, at render | `ClaudeMessage` with `timestamp` and `ClaudeMessagePart` |

`normalizeOpenCodeNativeMessage` and `normalizeCodexNativeMessage` are
pass-throughs — there is nothing left to normalize because it already happened
lower down. `ClaudeMessagePart` versus `NativeMessagePart` is largely nominal
drift (`timestamp` vs `createdAt`, part-type spelling), not semantic
difference.

Codex is the target state. OpenCode is at its own floor — it has no bridge in
`bridges/`, so the renderer client is as low as it goes. Claude and ACP both
have bridges and do not use them for this.

## Decisions taken

1. **Claude Build/Plan is surfaced.** Claude already has `planMode?: boolean`
   and `PermissionMode: "plan"` in `apps/web/src/lib/claude-client.ts`; it is
   simply not exposed in the composer. All three major providers therefore get
   a real Build/Plan dropdown. Cursor and Grok render it disabled.
2. **Favourites become an Orkestrator-owned global concept.** The existing
   OpenCode-server favourites (`modelPreferences.favorite`) are dropped, not
   migrated. OpenCode's catalog is filtered to the `opencode` and `opencode-go`
   providers for now.
3. **One `agent-native` tab type and one agent component.** Platform is a
   property of the tab data, not of the tab type, and not of the component
   identity. There is one controller component, not five.

### Consequence of decision 3, and how the lost safety is replaced

PR #345 deliberately made the tab type authoritative for the platform so that a
persisted record disagreeing with its tab type could not route a tab to another
provider's client. Collapsing to a single `agent-native` type removes that
coupling, so the same protection has to be re-established explicitly:

- **Validated on read.** `nativeAgentData.platform` is resolved through
  `findNativeAgentAdapter`, which already looks the registry up as an own
  property and returns `undefined` for anything unregistered. `NativeAgentTab`
  already renders a mismatch notice rather than throwing out of the pane.
- **Lock-once.** `platform` is immutable after the first dispatch. The
  pane-layout merge treats it as a lock-once field, so two panes racing to lock
  the same tab converge on one platform and a later conflicting write can never
  re-route a live session.
- **Unassigned is a first-class state**, not a missing field. Restore, merge and
  persistence all round-trip it.

## Target architecture

```text
PaneLeafContainer
  -> AgentNativeTab                      one component, platform is a prop
    -> useNativeAgentSession(adapter)    one lifecycle: send/stop/retry/queue/fork/resume
      -> NativeAgentAdapter              transport + capabilities only
        -> bridge / client               all provider difference terminates here
    -> NativeChatShell                   already provider-neutral
    -> NativeComposeBar                  one composer
      -> AgentModelPicker                provider + model + reasoning + speed + mode
```

Everything above the adapter speaks `NativeMessage`,
`NativeAgentSessionProjection`, `NativeAgentCapabilities` and `AgentModel`. No
provider wire type, catalog type or SDK payload crosses that line.

The protocol contracts for most of this already exist in
`packages/protocol/src/native-agent.ts` and are currently referenced nowhere —
`NativeAgentSessionProjection`, `NativeAgentCapabilities`,
`NativeAgentComposerControl`, `NativeAgentTurnState`,
`NativeAgentDispatchOutcome`. They are the specification for this plan, not dead
code, and must not be deleted ahead of it.

## Track structure

Message normalization and the composer work share no dependencies. The composer
track can start immediately.

```text
P0 ─┬─ A1 messages ───────── A2 session hook ──────────────┐
    └─ P1 identity ─┬─ B1 catalog ─ B2 picker ─ B3 caps ───┼─ C1 composer ─ C2 controller
                    └──────────────────── B4 deferred provider ─┘
```

---

## P0 · Clear the ground

**Effort:** half a day.

Delete `apps/web/src/components/codex/index.ts`. Its only export is
`CodexChatTab`; its only consumer was `PaneLeafContainer`'s
`import("@/components/codex")`, removed in #345. Zero importers remain.

Do **not** delete the unused exports in `packages/protocol/src/native-agent.ts`.
They are this plan's target contract.

---

## P1 · Single `agent-native` tab type with canonical identity

**Effort:** 3–4 days. **Prerequisite for B4.**

The legacy per-provider pane fields cannot represent "no provider chosen yet",
so they must go before deferred selection is possible. Combining that with the
tab-type collapse makes it one migration instead of two.

**Changes**

- `TabType` (`contexts/TerminalContext.tsx:10-21`) loses `claude-native`,
  `codex-native`, `opencode-native`, `cursor-native`, `grok-native` and gains
  `agent-native`. `claude-tmux` is unaffected — it is a terminal surface, not a
  bridge session.
- `TabInfo` drops `claudeNativeData`, `codexNativeData`, `openCodeNativeData`,
  `acpNativeData`. `nativeAgentData` is the only identity.
- `NativeAgentTabData.platform` becomes `AgentPlatform | undefined`; undefined
  means unassigned.
- Remove `NATIVE_AGENT_TAB_PLATFORMS` and `legacyNativeAgentRecord` from
  `types/paneLayout.ts`; `getNativeAgentData` becomes a validation of one field.
  Remove `toLegacyNativeAgentData` and its call in the adapter.
- Collapse the four-branch repetition in `lib/pane-layout-persistence.ts`,
  `lib/pane-layout-restore.ts` (including the four `hostPort` branches in
  `preserveRendererLocalTabFields`), `stores/paneLayoutStore.ts`
  (`updateTabSessionId`), and the tab-type spec table in
  `packages/protocol/src/pane-layout-merge.ts:43-68`.
- Update the ~86 `*-native` references across 13 non-test files. The heaviest
  are `stores/paneLayoutStore.ts`, `components/terminal/TerminalContainer.tsx`,
  `types/paneLayout.ts`, `components/review/ReviewLaunchDialog.tsx`,
  `components/pane-layout/DraggableTab.tsx`.
- Bump `PANE_LAYOUT_VERSION` to 3. The v2 → v3 migration reads a legacy tab type
  plus its provider record and writes `agent-native` + `nativeAgentData`.
  Keep the v2 read path for one release, then delete it.

**Removes:** ~250–350 lines of branch duplication.

**Invariants**

- A v2 layout containing any mix of legacy and canonical records restores to
  exactly the same visible tabs as before.
- `platform` is lock-once in the merge: a conflicting write cannot change an
  already-locked platform.
- Renderer-local `hostPort` still survives a backend snapshot overwrite.

**Gate:** `pane-layout-restore.test.ts`, `pane-layout-merge.test.ts`,
`pane-layout-persistence.test.ts`, `paneLayoutStore.test.ts`, plus new
mixed-version and lock-once cases.

---

## B1 · One model catalog shape

**Effort:** 2 days.

`ClaudeModel`, `CodexModel` and `OpenCodeModel` all already carry `id` and
`name`. Define one shape in `packages/protocol`:

```typescript
export interface AgentReasoningOption {
  id: string;
  label: string;
  description?: string;
  annotation?: string;
}

export interface AgentModel {
  platform: AgentPlatform;
  id: string;
  label: string;
  description?: string;
  /** Claude effort levels, Codex reasoning options, OpenCode variants. */
  reasoning?: AgentReasoningOption[];
  defaultReasoningId?: string;
  /** Claude and Codex true; OpenCode false. */
  supportsSpeed?: boolean;
  /** Build/Plan. False for ACP providers. */
  supportsMode?: boolean;
}
```

Each client gains `listModels(): AgentModel[]` mapping its own catalog.
Provider catalog types become private to `lib/*-client.ts`.

**OpenCode filter:** restrict to models whose provider is `opencode` or
`opencode-go`. OpenCode model ids are `providerID/modelID`, so filter on the
parsed provider segment, not a string prefix match.

**Capability matrix this encodes**

| Platform | Model | Reasoning | Speed | Build/Plan |
| --- | --- | --- | --- | --- |
| Claude | catalog | `low`…`max`, per-model `supportedEffortLevels` | yes | yes (newly surfaced) |
| Codex | catalog | `CodexReasoningOption[]` | yes | yes |
| OpenCode | catalog, filtered | variants + Default | no | yes |
| Cursor | none | none | no | no |
| Grok | none | none | no | no |

---

## B2 · One model picker

**Effort:** 3–4 days.

New `components/chat/AgentModelPicker.tsx`, replacing **both** existing pickers:
`components/chat/NativeModelPicker.tsx` (589 lines, shared) and
`components/opencode/OpenCodeModelSelect.tsx` (413 lines, OpenCode-only). The
latter already implements search, favourites ordering and grouping; lift that
machinery rather than rewriting it.

**Structure**

- **Left rail:** a favourites star at the top, then one icon per platform in
  `config.global.enabledAgentPlatforms`. Icons come from
  `components/icons/AgentIcons.tsx`.
- **Search field** across model label and platform.
- **Rows:** model label, platform name and icon as subtitle, `⌘1`…`⌘N`
  accelerator, and a star toggle on the right.
- **Favourites rail entry** lists starred models across all platforms, with the
  platform shown per row.

**Favourites storage**

New global config: `config.global.favoriteModels: Array<{ platform, modelId }>`.
Ordering is user-controlled and preserved. OpenCode's own
`modelPreferences.favorite` is no longer read; remove
`OpenCodeChatTab.tsx:661-673` and the `favoriteModelIds` prop chain.

**Deletes:** `OpenCodeModelSelect.tsx` entirely, most of `NativeModelPicker.tsx`.

**Invariants**

- The picker is pure presentation over `AgentModel[]` — it imports no provider
  client and no provider catalog type.
- A favourite naming a model that is no longer in any catalog is retained in
  config but rendered as unavailable, never silently dropped.

---

## B3 · Capability-driven controls

**Effort:** 2–3 days.

Populate the already-declared `NativeAgentCapabilities` per adapter and drive
the control strip from `NativeAgentComposerControl[]` instead of hand-written
per-provider JSX.

- Provider, Model, Reasoning and Speed always render. Each is disabled with a
  reason when the selected model does not support it — Speed is disabled for
  OpenCode, Reasoning and Model for ACP.
- Build/Plan is a **separate dropdown**, present for every permutation, disabled
  for Cursor and Grok.
- Surface Claude's Build/Plan by mapping it onto the existing
  `planMode`/`PermissionMode: "plan"` path. Codex `CodexConversationMode` and
  OpenCode `OpenCodeConversationMode` (both already `"build" | "plan"`) collapse
  into one `AgentConversationMode`.

**Invariant:** a disabled control still displays the value in force, so the user
can always see what the turn will run with.

---

## B4 · Deferred provider selection

**Effort:** 4–5 days. **Depends on P1 and B2.**

A tab is created with no platform. The composer is fully usable; no controller
mounts and no bridge starts until the first dispatch.

**Changes**

- `AgentNativeTab` renders composer-only when `platform` is undefined.
- **Composer draft state moves to a provider-neutral store** keyed by
  `sessionKey`. Today draft text, mentions and attachments live in
  `claudeStore` / `codexStore` / `openCodeStore`; an unassigned tab has no store
  to write to, and the draft must survive lock-in without a copy step.
- **Lock on first send:** write `platform`, mount the controller, start the
  bridge, then dispatch. Locking is idempotent and lock-once.
- Tab heading swaps from a neutral agent icon to the provider icon and name
  (`components/pane-layout/DraggableTab.tsx`).
- `TerminalContainer.tsx:1226-1350` stops deciding the platform at creation. The
  `useNativeClaude` / `useNativeCodex` / `useNativeOpenCode` / `useNativeAcp`
  branches collapse into one `agent-native` creation path. Explicit launches
  that already name a provider (build pipeline, review, agent handoff) pass a
  pre-locked platform.

**Invariants**

- Lock-in is atomic with respect to dispatch: a tab never reaches a bridge with
  a platform that was not persisted first.
- Two panes racing to lock the same tab converge on one platform.
- An unassigned tab round-trips through persist → restore → merge unchanged.
- A tab that fails to start its bridge stays locked; it does not silently revert
  to unassigned and offer a different provider.

---

## A1 · Normalize messages at the bridge

**Effort:** 3–4 days. **Runs in parallel with the B track.**

- The Claude bridge emits `NativeMessagePart`-shaped parts, as the Codex bridge
  already does. `ClaudeMessage` becomes `NativeMessage & { modelId?, revision? }`.
- The ACP bridge does the same; `AcpMessage` becomes `NativeMessage`.
- `components/native-agent/normalization.ts` collapses to a pass-through and can
  be deleted along with the adapter's `normalizeMessages` member.
- `ClaudeMessage` and `AcpMessage` disappear from the component layer.

`splitClaudeAssistantTextBlocks` **stays in the renderer.** Splitting one
assistant turn into multiple transcript rows is a display decision, not
normalization; it belongs next to `NativeChatShell`, not in the bridge.

**Watch:** `ClaudeMessagePatch` addresses parts by index, so changing the part
shape is a wire change across the bridge boundary. Version it even though the
bridge and app ship together, and keep the revision-gap detection intact — a
recipient that cannot apply a patch must still refetch the transcript rather
than render a partial turn.

**Gate:** `native-message-adapters.test.ts`, the claude-bridge and acp-bridge
suites, and a fixture replay proving an in-flight patch stream survives the
shape change.

---

## A2 · `useNativeAgentSession`

**Effort:** 5–8 days. **The largest deduplication.**

Wire `NativeAgentSessionProjection`, then lift the 21 duplicated callbacks into
one hook parameterized by the adapter's transport:

`handleSend`, `handleSendRef`, `handleStop`, `handleRetry`, `handleQueue`,
`handleResumeSession`, `handleForkFromMessage`, `forkPlan`, `forkPlanRef`,
`forkInFlightRef`, `promoteNextQueuedPromptToDraft`,
`acknowledgeInitialLaunchOptions`, `initialLaunchOptionsRef`,
`initialLaunchOptionsPendingRef`, `launchPromptRef`, `isInitializedRef`,
`lastInitTimeRef`, `sessionKey`, `sessionMessages`, `providerDisplayMessages`,
`resolveModelLabel`.

`acknowledgeInitialLaunchOptions` is currently byte-identical in all three
controllers. `promoteNextQueuedPromptToDraft` differs only in which store
singleton it calls and which setters run at the end, down to a verbatim-copied
three-line comment.

**Stays below the hook** — all of it transport-specific, and all of it already
required by `AGENTS.md` to settle against an authoritative snapshot before
normalization:

- Codex sparse revision patches and `planReview`
- Claude `message.patched` recovery and background-task snapshots
- OpenCode child-session hydration
- ACP message windows and `baseIndex` eviction

**Invariants (from `AGENTS.md`, non-negotiable)**

- Long-running state stays in the backend, bridge or store — not in mounted
  React state.
- Unmount is not cancellation.
- Live events are incremental updates over authoritative snapshots.
- Every missed event is detectable via revision gap, generation change or
  explicit reconciliation.
- Approvals rehydrate from `/session/:id/approvals`, never from having seen the
  SSE frame.

**Gate:** the inactive-environment path must be re-tested per `AGENTS.md`: start
work, switch environment, let it finish, return, and verify status, messages,
pending prompts and controls.

---

## C1 · One compose bar

**Effort:** 3 days. **Depends on B3 and A2.**

`ClaudeComposeBar` (753) + `CodexComposeBar` (698) + `OpenCodeComposeBar` (889)
collapse into one `NativeComposeBar`.

`components/chat/NativeComposeBarControls.test.tsx` is already a cross-provider
parity harness — it renders all three bars and asserts identical behaviour. It
is the regression gate for this phase and should keep asserting parity right up
until there is only one bar left.

---

## C2 · One agent controller

**Effort:** 4–6 days. **The endgame.**

`ClaudeChatTab` (3061) + `CodexChatTab` (3357) + `OpenCodeChatTab` (3407) +
`AcpChatTab` (301) collapse into one `AgentNativeTab`, driven by
`useNativeAgentSession`, `NativeAgentCapabilities` and the adapter's transport.
`NativeAgentAdapter.loadController` disappears — there is one component and
nothing left to lazily route to.

Provider-specific *cards* (`CodexApprovalCard`, `CodexPlanModeCard`,
`OpenCodeQuestionCard`, `OpenCodePermissionCard`, `ClaudePlanApprovalCard`)
remain as adapter-supplied slots into `NativeChatShell.blockingCards`, which
already exists for exactly this. They are the legitimate residue of real
provider difference.

---

## Sequencing summary

| Phase | Effort | Depends on | Principal outcome |
| --- | --- | --- | --- |
| P0 | 0.5d | — | dead barrel removed |
| P1 | 3–4d | P0 | one tab type, one identity, migration to v3 |
| B1 | 2d | P1 | `AgentModel`, OpenCode filtered |
| B2 | 3–4d | B1 | unified picker, global favourites |
| B3 | 2–3d | B2 | capability-driven controls, Claude Build/Plan |
| B4 | 4–5d | P1, B2 | provider chosen at first send |
| A1 | 3–4d | P0 | normalization at the bridge |
| A2 | 5–8d | A1 | one session lifecycle |
| C1 | 3d | B3, A2 | one compose bar |
| C2 | 4–6d | C1 | one agent controller |

The B track alone delivers the unified picker and deferred provider selection.
The A track alone delivers the line-count reduction. They meet at C.

## Open items

- Whether `claude-tmux` eventually joins `agent-native`. It is a terminal
  surface rather than a bridge session and is deliberately out of scope here.
- Whether favourite ordering should be user-draggable in B2 or land later.
- Whether `NativeAgentDispatchOutcome` replaces each controller's ad-hoc
  dispatch reconciliation in A2, or waits for a follow-up. The `unknown` outcome
  must never be retried blindly; it reconciles via the provider's read path.
