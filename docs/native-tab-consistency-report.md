# Native tab consistency & consolidation

Record of the audit of `ClaudeChatTab`, `CodexChatTab` and `OpenCodeChatTab`
(plus their compose bars, stores, dialogs and cards) and the consolidation that
followed. Findings covered only differences **not** forced by the underlying
agent framework; genuine protocol differences were left alone and are listed at
the end.

Status: implemented. Line references below are post-change.

---

## Shared modules introduced

| Module | Replaces |
| --- | --- |
| `components/chat/NativeChatShell.tsx` | the three tabs' connecting/error/render trees |
| `components/chat/NativeResumeSessionDialog.tsx` | three ~140-line resume dialogs |
| `components/chat/QuestionCard.tsx` | Claude's and OpenCode's question wizards |
| `components/chat/QueuedPromptsDialog.tsx` | three copies of the queue manager |
| `components/chat/BlockingPromptCard.tsx` | two competing card treatments |
| `components/chat/SlashCommandMenu.tsx` | `claude/SlashCommandMenu` + `opencode/OpenCodeSlashCommandMenu` |
| `components/chat/compose-metrics.ts` | per-agent input sizing constants |
| `hooks/useNativeComposeSubmit.ts` | three copies of the submit controller |
| `hooks/useNativeMessageQueue.ts` | three queue drains with three bug profiles |
| `hooks/useSlashCommandMenu.ts` | three slash detection effects + key handlers |
| `hooks/useEscapeToStop.ts` | three byte-identical Escape handlers |
| `hooks/useManualSessionRefresh.ts` | three watermark refresh effects |
| `hooks/useStalledTurnWatchdog.ts` | Codex's watchdog, now used by all three |
| `lib/chat/slash-commands.ts` | `parseSlashCommands` |
| `lib/chat/file-mentions-equal.ts` | `fileMentionsEqual` ×3 |
| `lib/chat/agent-model-preferences.ts` | Claude's inline persistence, now shared |
| `lib/format-relative-time.ts` | `formatRelativeTime` ×4 |
| `stores/createNativeChatStore.ts` (extended) | event-subscription slice, declarative `clearEnvironment` |
| `hooks/useGlobalActivityMonitor.ts` (`subscribeNativeActivity`) | three ~110-line activity derivations |

Deleted: `claude/SlashCommandMenu.tsx`, `opencode/OpenCodeSlashCommandMenu.tsx`
and their tests. Added: `components/claude/index.ts` (the missing barrel).

---

## Behavioural fixes

**Codex reported `waiting` activity.** `useGlobalActivityMonitor` derived Codex
activity from `session.isLoading` alone, ignoring `pendingApprovals`. An
environment blocked on a command approval showed **green/idle** in the sidebar —
the exact state the amber icon exists for. Now derived through the shared
`subscribeNativeActivity`, whose `isWaiting` config makes the omission
structurally impossible. Pinned by a test in `useGlobalActivityMonitor.test.tsx`
covering both the block and the release.

**Blocking prompts are pinned above the composer in all three tabs.** Claude and
OpenCode rendered questions/permissions inside the virtualised list footer,
where they scroll away while the turn sits blocked. Codex's pinned placement is
now the shared behaviour. `NativeComposeDock` gained a `pinnedContent` slot that
renders in both centred and docked layouts — `topAccessory` is hidden while
centred, which would have hidden an approval that arrived before the transcript
had any messages.

**One visual language for blocking prompts.** Claude/OpenCode used a neutral
`bg-card` panel; Codex used an amber-accented one. Amber won — it is the only
one that reads as "waiting for you" rather than as another message.

**Inline images work in all three tabs.** Only Claude passed `containerId` to
`NativeMessage`, so screenshots the agent wrote inside a Docker environment
rendered in Claude tabs and showed as bare paths in the other two.

**Slash-menu keys agree.** Codex wrapped around the list ends and did not accept
on Tab; Claude and OpenCode clamped and did. Clamping + Tab-to-accept is now
shared (`useSlashCommandMenu`).

**Composer max height agrees.** Codex capped at 160px against 256px elsewhere.

**OpenCode queued prompts are editable.** Its queue dialog rendered the prompt
as static markup — delete-and-retype only. All three now share
`QueuedPromptsDialog`.

**Every interrupted turn leaves a transcript marker.** OpenCode left none, so an
interrupted turn was indistinguishable from one that produced nothing. Codex
cannot write it at request time (`turn/interrupt` is asynchronous), so it writes
the marker when the turn actually settles.

**Queued-send failures surface the same way.** Codex only set the transient
error banner; it now also records which queued prompt failed in the transcript.

**Codex's Retry does a full reset.** It previously flipped local flags only, so
a retry reconnected on top of a stale client and session. Its error screen also
gained the Show/Hide Log toggle instead of dumping the log unconditionally.

**Codex has an empty state** with a Resume Session action.

**OpenCode's resume list orders by activity.** It sorted on `createdAt`, so the
most recently used session was not necessarily at the top. `OpenCodeSession`
gained `updatedAt`, normalized from the SDK's `time.updated`.

**OpenCode persists the composer's model choice** to `global.opencodeModel`,
matching Claude and Codex, via the shared `persistAgentModelDefault`.

**OpenCode model/variant/composing state is session-scoped.** It was keyed by
environment, so two OpenCode tabs in one environment silently shared a model
selection. This was type-invisible (both keys are strings), so every call site
was audited by hand.

**OpenCode sessions get titles.** `session.updated` now carries the title into
the store, and the tab chrome reads titles for all three agents rather than
Claude only.

**Claude and OpenCode have a stalled-turn watchdog.** Only Codex polled for a
turn that stopped reporting; the other two relied on SSE alone, so a dropped
frame left the composer disabled until a manual refresh. `AGENTS.md` requires
the UI be able to catch up from status APIs when events are missed.

---

## Correctness picked up along the way

**The queue drain now uses Codex's semantics everywhere.** Claude reset its
re-entrancy flag on a `setTimeout(…, 100)` and never re-drove the drain, so a
queue could strand; OpenCode re-entered through an unconditional
`queueMicrotask` with no queue-length or loading check. `useNativeMessageQueue`
takes `blockedByDraft` as an input so clearing the draft re-triggers a drain
that was parked behind it.

**OpenCode's question card no longer drops typed answers.** Claude's card kept
uncommitted custom text across question navigation and included it at submit;
OpenCode's discarded it, so a user who typed an answer and pressed Submit lost
it. Both now use the shared `QuestionCard`.

**`clearEnvironment` is declarative.** All three hand-maintained a list of maps
to purge, which made adding a new map a silent leak; the three had already
drifted on what they cleaned up. `buildClearEnvironmentPatch` names the
environment-keyed and session-keyed maps explicitly.

**`sessionID` → `sessionId`.** OpenCode's normalized `QuestionRequest` and
`PermissionRequest` used the SDK's spelling while Claude and Codex used
`sessionId` — two spellings two lines apart in the activity monitor. Normalized
at the client boundary; the SDK's wire fields still use `sessionID` and the
rehydration paths that previously blind-cast now normalize properly.

**`createClaudeSessionKey` / `createCodexSessionKey` / `createOpenCodeSessionKey`
are gone** in favour of `createSessionKey`. The terminal store's unrelated
3-argument `createSessionKey` is now imported under an explicit alias.

**Backend server commands are table-driven.** `stop_*`, `get_*_server_status`
and `get_*_server_log` differed only by port, pkill pattern and log path; they
are registered from one `NATIVE_SERVERS` table. `start_*` stays per-agent, since
each builds a different container script.

---

## Scale

Roughly 3,700 lines added and 3,900 removed across production code, against 17
new shared modules. The tabs and compose bars shrank from ~9,200 lines to
~7,980, with the duplication moved into shared modules rather than merely
relocated:

| File | Before | After |
| --- | --- | --- |
| `ClaudeChatTab.tsx` | 1,810 | 1,623 |
| `CodexChatTab.tsx` | 2,205 | 2,026 |
| `OpenCodeChatTab.tsx` | 2,146 | 1,949 |
| `ClaudeComposeBar.tsx` | 933 | 751 |
| `CodexComposeBar.tsx` | 876 | 692 |
| `OpenCodeComposeBar.tsx` | 1,065 | 938 |
| `ClaudeQuestionCard.tsx` | 539 | 108 |
| `OpenCodeQuestionCard.tsx` | 320 | 62 |
| three resume dialogs | 443 | 128 |

---

## Deliberately not done

**Codex context-usage indicator.** Codex's composer is still the only one
without a context wheel. app-server does emit `thread/tokenUsage/updated`, but
the bridge neither surfaces it nor the model's context window
(`Config.model_context_window`), so wiring this end-to-end is a bridge feature
rather than a UI consolidation. A `contextUsage` map was added to `codexStore`
during this work and then removed again rather than leaving state nothing
writes.

**Unifying the pending-request shape onto Codex's session-keyed arrays.** The
premise did not survive contact with the removal path: Claude's and OpenCode's
removals arrive carrying only a `requestId` (`removePendingQuestion(requestId)`
from an SSE frame), with no session key to hand. Session-keying them would
require either a reverse index or a scan on every removal — trading one scan for
another. The per-render scans that motivated this are already `useMemo`'d over
maps that hold zero to two entries. The real inconsistency here was the field
name, which is fixed.

**A unified model-catalog shape.** Claude's `ClaudeModelCatalogSnapshot`
(with `source`/`stale`/`fetchedAt`, persisted and refreshed by the backend) is
the richest of the three, but generalising it to Codex and OpenCode means new
backend commands and per-environment catalog storage for both — a feature, not a
consolidation.

**A unified effort/reasoning type.** Claude's `effort`, Codex's
`reasoningEffort` and OpenCode's `variant` are three names for "how hard should
it think", but the value sets and their per-model availability rules genuinely
differ. A shared type would be a name change over three unrelated domains.

## Explicitly out of scope (framework-driven)

- Codex holding `isLoading` through `cancelling`/`recovering` — required by
  `turn/interrupt` semantics and documented in `AGENTS.md`. Its refusal to send
  mid-turn without a queue is likewise app-server-specific (a second concurrent
  prompt is rejected with a 409) and is now an explicit
  `refuseWhenBusyWithoutQueue` opt-in rather than shared behaviour.
- Codex's dispatch journal and `requestId` idempotency on queue entries.
- OpenCode's model `variant` concept and its 20 MB data-backed attachments.
- Claude's plan mode and its message-patch revision protocol.

---

## Verification

`bun run --cwd apps/{web,backend,desktop} typecheck` all clean. Web suite
2,293 tests green; bridges 1,128 green; protocol 40 green; root `tests/` green
apart from two pre-existing flakes (`FeaturesView lifecycle and navigation` and
the `download-*.sh` script tests), both reproduced at the same rate on a stashed
baseline and both passing in isolation.
