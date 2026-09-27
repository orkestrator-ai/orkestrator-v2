# 08 — Define lightweight transcript, detail, and history contracts

Status: Complete. Prerequisite: 01. Findings: E05/E06/E07/E13.

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

## Execution record

```text
Status: Complete
Implementation commit / PR: branch implement-efficiency-improvements-7f0993836777-r1,
  "feat(protocol): lightweight bridge transcript summaries, exact details and pages"
  (+ readBridgePartDetail and the NativeAgentTranscriptView.historyPaging field
  in the backend consumption commit)
Protocol or storage decisions:
  - packages/protocol/src/bridge-transcript-summary.ts. Summary envelope
    `version: 2` beside the unchanged v1 envelope; capabilities are read from
    the envelope's own discriminator (an old bridge ignores `version=2` and
    answers v1) plus `capabilities: {details, pages}` in each v2 snapshot.
  - Summary parts: toolOutput/toolError, diff bodies (diff/before/after) and
    an inline `data:image/` fileUrl with no readable path move behind
    `detail: {locator, bytes, fields}` when the payload exceeds 4 KiB; smaller
    bodies stay inline (the backend defers those itself). Diff stats and all
    collapsed-row fields stay. Nested parts/childTools/subagentActions/task
    are summarized recursively (depth 8).
  - Detail locator `bd1.<base64url {m: messageId, p: path, d: digest}>` ≤ 2 KiB:
    path anchored on sourcePartId/toolUseId (trim-stable), digest = sha256 of
    the exact payload. Detail answers ok | missing (message/part gone) |
    expired (body changed) | too-large (4 MiB tool / 16 MiB image) | invalid.
    A per-part WeakMap memo (validated by field references, incl. in-place
    diff fields) avoids re-hashing unchanged heavy parts on each summary.
  - Page cursor `bp1.<base64url {g, e, b}>` ≤ 1 KiB, bound to bridge
    generation + content epoch + exclusive end position; any other epoch is
    `expired`, never reinterpreted. Pages ≤ 200 messages / 1 MiB target, each
    page advances or ends; `complete` only when nothing before was ever lost.
  - Token for v2 carries a representation prefix, so v1 and v2 tokens never
    answer each other. Title/freshness joined the shared token (step 05).
  - Consumer validators (parseBridgeTranscriptSummaryUpdate/Detail/Page)
    bound counts/lengths and reject non-advancing pages and forged image URLs.
  - Backend: optional provider methods transcriptDetail/transcriptPage and
    `representation: "summary"` / `historyCursor` on ProviderTranscriptSnapshot;
    backend direct page cursors are a separate namespace (`v: 2`) from the
    joined sync-v1 cursors (`v: 1`) and never translated into each other.
  - Part-level deltas remain off (step 14 decision).
Tests and isolated profiles: packages/protocol/src/bridge-transcript-summary.test.ts
  (22 tests: summaries, inline threshold, images, nested tools, prompt kept
  in window where v1 drops it, zero-visit unchanged read, v1/v2 token
  separation, memoized heavy parts, exact/expired/missing/invalid details,
  trim-stable lookup, contiguous page walk, byte-limited page advance,
  cross-epoch/generation cursor expiry, incomplete history never complete,
  consumer parser rejection cases, v1 answer recognized as not-a-summary).
Before/after measurements: see step 09 (bytes on the wire) and baseline/.
Compatibility/migration result: additive; old bridges answer v1 and are
  remembered per connection; old clients never ask for v2.
Remaining limitations: detail revisions are digest-checked rather than frozen,
  so a streaming card's reference expires when its body changes (the next poll
  delivers a new one).
```
