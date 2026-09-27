# 05 — Give Claude a content revision for conditional transcript reads

Status: Complete — validated on a real Claude session through an isolated profile (step 19). Prerequisite: 01. Finding: E03. Priority: urgent.

## Outcome

Claude can answer a matching transcript token without enumerating or serializing
message contents. Every display-relevant mutation still invalidates that token.

## Owners

- [Session types](../../../../bridges/claude-bridge/src/types/index.ts).
- [Session route](../../../../bridges/claude-bridge/src/routes/session.ts).
- [Session services](../../../../bridges/claude-bridge/src/services/session-manager-core.ts),
  prompt-stream, messages, persistence, lifecycle, background-tasks, and title/
  preference update sites.
- [Shared token helper](../../../../packages/protocol/src/progressive-transcript.ts).

## Implementation

1. Introduce a session-local transcript content revision and a history epoch.
   Keep these distinct from turn generation, activity timestamps, usage/status
   revisions, and the SSE replay revision. Initialization and overflow rules
   must never make an old token valid for different content.
2. Add a narrow `markTranscriptChanged` helper and an epoch-reset variant. Audit
   writes to message arrays, message content, parts, nested tool output/diffs,
   task decoration, model attribution, system notices, hydration overlays,
   title fields carried in the envelope, rewinds, and deletions. Use explicit
   mutation sites rather than deep comparison inside the HTTP route.
3. Mark changes after the corresponding mutation is installed synchronously.
   Async hydration must check ownership before publishing; a stale completion
   cannot advance a new session's revision or replace its messages.
4. Treat full history replacement/rewind as an epoch change. Normal append and
   in-place streaming updates advance revision only. Eviction/unhydrated preview
   transitions must alter token identity/freshness so clients do not mistake a
   preview for a current empty transcript.
5. Pass the revision into `bridgeTranscriptUpdate`. Ensure the token covers all
   semantically visible envelope fields through either the revision contract
   or explicit token components. In particular test title, freshness, and
   completeness changes that do not alter message text.
6. Keep the content-hash fallback for legacy callers of the helper, but add a
   test that every current Claude route uses revisions. Do not replace a
   reliable hash with a counter missing mutation paths.
7. Keep revisions runtime-local if durable provider history is rehydrated under
   a new bridge generation. Persisting a second revision ledger is unnecessary
   unless a current consumer explicitly needs it across generations.

## Mutation coverage tests

Build a table-driven route test: obtain token, perform one real mutation path,
read with old token, assert snapshot; read again, assert unchanged. Cover text,
thinking, tool partial/complete result, nested activity, image/detail metadata,
title-only change, local notices, overlay install, hydration, rewind, and epoch
replacement. Include a status/usage-only change that should not force transcript
serialization when its data belongs solely to the state domain.

Use serialization hooks to prove zero message visits on an unchanged 1,000-row
session. Ensure mutations during a slow prior request cannot be lost behind a
cached token. Test idle eviction and a new bridge generation against a token
issued before shutdown.

## Acceptance and compatibility

The existing v1 envelope remains readable; tokens are opaque and can change.
Old client tokens receive a fresh snapshot once. The mutation audit is part of
the PR evidence. Run the Claude route/service suites and shared token tests;
then isolated native chat QA including an inactive tab and a background task.

## Execution record

```text
Status: Implemented, validation pending
Implementation commit / PR: see branch implement-efficiency-improvements-7f0993836777-r1 (commit "perf(claude-bridge): answer unchanged transcript reads from a content revision"); no PR yet
Protocol or storage decisions: see below
Tests and isolated profiles: focused Bun suites below; no isolated Electron/browser profile was started
Before/after measurements: unchanged 1,000-row read through the real route: 0 message serialization visits (was 1,000 per the E03 probe); a changed read visits only its <=100-message window
Compatibility/migration result: v1 envelope unchanged; tokens gain one component, so every held token misses once and receives a snapshot
Remaining limitations: see below
```

### What changed

- `packages/protocol/src/progressive-transcript.ts`: the shared
  `bridgeTranscriptToken` now includes a digest of `title` and `freshness`
  (defaulting to `current`). Before, a title-only change was answered
  `unchanged` by every bridge that passes a revision (Codex, Cursor, Pi, ACP).
  The content-hash fallback for callers without a revision is kept.
- `bridges/claude-bridge/src/services/transcript-revision.ts` (new):
  `markTranscriptChanged` (append/in-place edit), `resetTranscriptEpoch`
  (wholesale replacement or loaded-state flip) and `readTranscriptVersion`.
  Revisions and epochs come from one process-global monotonic counter, so a
  deleted-and-recreated session under the same id, a re-materialized object or
  a fork can never reproduce an `(epoch, revision)` pair an old token was
  issued for; a restart is covered by the route's per-process generation.
  `readTranscriptVersion` is O(1) and also repairs (and counts) a replaced
  array or changed length that skipped its marker; tests assert the repair
  count stays zero, so it is a guard, not the mechanism.
- `SessionState` gains `transcriptRevision` / `transcriptEpoch`, documented as
  distinct from `NormalizedMessage.revision` (SSE patch counter), the turn
  generation and status/usage state. Runtime-only; nothing is persisted.
- `GET /session/:id/transcript` passes `revision` and
  `contentEpoch: "${hydrated|preview}:${epoch}"`, reads messages, loaded state
  and version together, serializes the response, and only then starts
  background hydration. It also reports a session as a cached, incomplete
  preview while a prompt's own pre-turn read is in flight
  (`persistedHydration` set after `sendPrompt` claimed
  `persistedMessagesLoaded = true`), instead of a complete, current and empty
  transcript.

### Mutation audit

Every write to `session.messages`, to a message object in it, or to a part
reachable from it, found by grepping for `.messages` assignments/pushes,
`.parts`/`.content`/`.revision`/`.sdkUuid`/`.modelId`/`.toolState` writes and
every `message.updated`/`message.patched` emitter. Parts are otherwise
immutable (`ToolTracker` replaces tool objects; the rebuilds are covered).

| Site | Kind | Marker |
| --- | --- | --- |
| catalog `appendSteerUserMessage`, `answerIdleSteerPrompt` | append | mark |
| commands `appendLocalCommandResult` | append | mark |
| messages `appendInterruptedNotice`, `appendSubagentInterruptedNotice` | append | mark |
| messages `refreshSettledToolRows` | in place (parts) | mark when changed |
| persistence `applyLocalTranscriptOverlay` | append | mark when appended |
| persistence `hydratePersistedSessionMessages` install (after ownership check) | replacement | epoch |
| persistence `evictIdleHydratedTranscripts` | replacement | epoch |
| prompt-stream `flushStreamedAssistantMessage` create/update | append / in place | mark |
| prompt-stream `emitCurrentAssistantMessage` SSE `revision` stamps (3) | in place (serialized field) | mark |
| prompt `settlePendingApiRetry` (`toolState`) | in place | mark |
| prompt `appendTranscriptNotice` (compaction, retry, status, memory, denial rows) | append | mark |
| prompt `sendPrompt` claim `persistedMessagesLoaded = true`, startup-failure restore | loaded flip | epoch |
| prompt `sendPrompt` pre-turn hydration install | replacement | epoch |
| prompt `sendPrompt` user message | append | mark |
| prompt informational row rewrite | in place | mark |
| prompt permission-denied part rebuild | in place | mark |
| prompt assistant create / content+parts+modelId+sdkUuid update | append / in place | mark |
| prompt tool-result part rebuild | in place | mark |
| prompt `userMessage.sdkUuid` from the result | in place | mark |
| prompt `tool_progress` part replacement | in place | mark |
| prompt `conversation_reset` | replacement | epoch |
| prompt `finally` after a failed pre-turn read (`persistedMessagesLoaded = false`) | loaded flip | epoch |
| title: `generateAndSetSessionTitle`, `renameSessionDurably`, listing reconcile | envelope field | shared token component (no content mark) |
| construction (`createSession`, reconcile, materialize, fork) / deletion | new or dropped object | fresh global epoch on first read; old objects unreachable |

Stale async completions: route-started hydration installs only after
`sessions.get(id) === session`, and markers act on the session object they are
given, so a completion for a replaced object cannot advance the new one (tested).
Background-task snapshots, usage, rate limits, plan mode, activity and thinking
estimates belong to the state domain and are not transcript content.

### Tests run (all passing)

- `mise run test:logged -- --name proto-e03 -- mise exec -- bun test --cwd packages/protocol --preload ../../tests/setup-node.ts ./src/progressive-transcript.test.ts --parallel=1 --only-failures`
  (13 tests; title-, cleared-title-, freshness- and completeness-only changes
  snapshot then stabilize; zero `toJSON` visits on an unchanged 1,000-message
  read with a revision; legacy hash fallback still invalidates)
- `mise exec -- bun test --cwd packages/protocol --preload ../../tests/setup-node.ts ./src --parallel=2`: 1217 pass
- `mise exec -- bun test ./bridges/claude-bridge/src/services/session-manager-transcript-revision.test.ts --parallel=1`:
  27 pass. Table-driven route test against the real session manager (token →
  real mutation → old token snapshots → new token unchanged) for streamed
  text, streamed thinking, tool call start, tool result completion, nested
  subagent activity, tool progress, model attribution, informational rewrite,
  API retry settle, prompt uuid, conversation reset (new epoch), user
  interruption, image-attachment prompt, local command result, idle steer;
  plus preview hydration, overlay install, idle eviction (cached preview, new
  epoch, then re-hydration), title-only rename (revision and epoch unchanged,
  token changed), plan-mode and rate-limit changes (token stays valid), a
  mutation during a slow hydration, a prompt's pre-turn read, a stale
  hydration against a recreated session, a new bridge generation, zero
  message visits on an unchanged 1,000-row read, and a source check that every
  `bridgeTranscriptUpdate` call in `src/routes` passes `revision`. Disabling
  `markTranscriptChanged` fails 17 of these; disabling `resetTranscriptEpoch`
  fails 4.
- `mise run test:logged -- --name br-e03-claude2 -- mise exec -- bun test ./bridges/claude-bridge/src --parallel=2 --only-failures`: PASS (1062 pass, 0 fail)
- Shared-token consumers: `bun test` of `bridges/acp-bridge/src/acp-http.test.ts`,
  `bridges/cursor-bridge/src/http.test.ts`, `bridges/codex-bridge/src/index-routes.test.ts`
  (151 pass), `bridges/pi-bridge/src/transcript.test.ts` (19 pass), and
  `apps/backend/src/core/native-agent-service-progressive.test.ts` (55 pass)
- `mise exec -- bun run --cwd bridges/claude-bridge typecheck`, `mise exec -- bun run --cwd packages/protocol typecheck`,
  `mise run format`, `mise run format:check`, `mise run lint`: clean

### Remaining limitations

- Isolated native chat QA (inactive tab, background task) was not run in this
  change; the full `mise run test` also was not run here.
- The route reports a prompt's claimed transcript as a preview only while its
  pre-turn read is in flight. The short window between the claim and the start
  of that read (only when the prompt first persists a plan-mode change) still
  reads as loaded, as before this change.
- When a prompt's pre-turn read fails, the transcript reads as loaded until the
  turn ends (pre-existing); the epoch is reset when the flag is cleared.
- `session-manager-prompt.ts` was already over 2,000 lines; this change adds
  only marker calls to it.

