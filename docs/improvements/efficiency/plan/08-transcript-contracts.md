# 08 — Define lightweight transcript, detail, and history contracts

Status: Not started. Prerequisite: 01. Findings: E05/E06/E07/E13.

## Outcome

Bridges can window lightweight messages before moving large artifacts, serve
bounded details on demand, and page history without requiring the backend to
reconstruct a full interactive projection. Version negotiation makes mixed
desktop/backend/bridge versions explicit.

## Owners

- [Bridge progressive protocol](../../../../packages/protocol/src/progressive-transcript.ts).
- [Native-agent protocol](../../../../packages/protocol/src/native-agent.ts) and
  [part identity](../../../../packages/protocol/src/transcript-part-ids.ts).
- [Provider contract](../../../../apps/backend/src/core/agent-provider-contract.ts).
- [HTTP progressive adapter](../../../../apps/backend/src/core/http-bridge-progressive.ts).
- [Backend commands](../../../../apps/backend/src/core/commands-registry-native.ts)
  and [frontend wrappers](../../../../apps/web/src/lib/backend/workflows.ts).

## Contract decisions

Use a new bridge summary version, provisionally `version: 2`; keep the existing
v1 payload stable. Advertise separate support for summaries, history pages,
detail reads, progress revisions, and later part deltas. Do not infer all
features from one version number or from a successful HTTP status.

| Concept | Required semantics |
| --- | --- |
| Runtime identity | Logical session + provider session + connection generation |
| History epoch | Changes when prior ordered history is rewritten/replaced |
| Content revision | Advances for transcript-visible changes within an epoch |
| Message/part revision | Identifies a particular immutable observed value |
| Window identity | Count/byte target and representation affect the token |
| Freshness | Cached/current/empty remains independent of action authority |
| Completeness | Distinguish retained full history, pageable remainder, permanent omission |
| Detail locator | Opaque, scoped to session/epoch/part/revision; not a file path |
| Page cursor | Opaque, bound to identity/epoch and a stable before-position |
| Progress revision | Meaningful transcript progress, not polling or access-time churn |

## Implementation

1. Define bounded validators for summary messages and recursively nested parts.
   Limit arrays, nesting, ID/string lengths, operations, encoded bytes, and
   total decoded body size. Keep limits near the contracts used by both sides.
2. Summary parts retain identity, kind, lifecycle, short display text, tool name,
   bounded arguments/preview as needed, diff statistics, and detail availability.
   Large output/error/diff bodies and inline images become typed locators.
   Some arguments/content fields are themselves large; audit them rather than
   moving only fields named `toolOutput`.
3. Specify detail responses as exact revisioned values with explicit missing,
   expired, unavailable, and too-large outcomes. Reuse the current 4 MiB tool
   detail and 16 MiB image-detail ceilings unless measurement justifies a
   separately reviewed change. The response envelope also counts toward its cap.
4. Specify page requests using a bounded cursor/count/byte target; replies
   include identity, epoch, ordered messages, next cursor, and completeness.
   An oversized row has an explicit bounded-detail representation or an
   explicit unpageable result. A cursor must always advance or terminate.
5. Separate the new provider epoch from existing backend `sync-v1` paging
   epochs. Translation lives in one adapter. Never pass a bridge cursor to an
   endpoint expecting a backend cursor or infer sequence position from IDs.
6. Extend provider interfaces with optional summary/detail/page/progress methods.
   Preserve the legacy `messages()` method for compatibility and exact consumers.
   State whether a method touches liveness or attaches; cheap progress/activity
   must do neither. User-requested history may hydrate explicitly.
7. Add bounded capability caching by connection generation and negative-cache
   expiry. Test an old bridge that ignores `version=2` and returns v1: inspect
   the returned discriminator and fall back without misparsing it as summaries.
8. Add new backend/client capability fields additively. Unknown features are
   disabled, not optimistically assumed. Optional part deltas remain off until
   step 14 and have their own negotiated operation vocabulary.

## Protocol tests

Validate cross-session/cross-generation cursor use, stale epochs, cursor expiry,
missing details, oversized bodies, malformed nested parts, unsupported versions,
empty-but-incomplete snapshots, title/freshness-only changes, and an old bridge's
v1 fallback. Include two clients with different window targets and base tokens.

Use a synthetic contract fixture shared across provider adapters. Put no vendor
SDK classes or generated Codex types into renderer-facing messages. Do not edit
Codex's generated app-server protocol for this bridge-owned extension.

## Acceptance and delivery

Land types, validators, capability negotiation, and fallback tests before any
adapter advertises support. Write an explicit old/new compatibility table in
the PR. This step changes no default data path until a bridge implements and
advertises the complete required feature set.
