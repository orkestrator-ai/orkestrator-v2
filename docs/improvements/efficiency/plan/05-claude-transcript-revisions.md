# 05 — Give Claude a content revision for conditional transcript reads

Status: Not started. Prerequisite: 01. Finding: E03. Priority: urgent.

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
