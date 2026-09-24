# 01 — Domain model, contracts, and state transitions

Status: Not started. Depends on: none. Milestone: A.

## Deliverable

Define one provider-neutral model for annotations, captures, discussion, and
requests. This contract must distinguish trusted human intent, untrusted page
evidence, execution uncertainty, and human acceptance before storage or UI work
starts.

## Code boundaries

Add proposed protocol modules `packages/protocol/src/web-annotations.ts` and
`web-annotations-validation.ts`, with focused tests and the necessary package
export. Extend `browser-preview.ts` for capture transport only. Reuse native
agent identities and dispatch outcomes from `native-agent.ts`; avoid copying
their provider/session model into the annotation types.

## Records

| Record | Required information and semantics |
| --- | --- |
| `WebAnnotation` | ID, environment ID, schema version, metadata revision, content revision, created/updated timestamps, logical page identity, current capture ID, title, open/resolved/deleted state, optional default destination, and resolution record. |
| `AnnotationCapture` | ID, annotation ID, immutable capture revision, producer identity, capture time, document generation, navigation URL metadata, target union, viewport/scroll/zoom/image transform, evidence asset IDs, redaction summary, and complete/stale/missing state. |
| `AnnotationEntry` | ID, annotation ID, monotonic sequence, author kind, provenance, entry kind, body or transcript reference, capture/content revision context, creation time, optional superseded entry ID. |
| `AnnotationDraft` | ID, environment ID, client/editor identity, revision, optional annotation ID/capture ID, multiline human text, unsent action/destination preferences. Persist separately from published discussion. |
| `AnnotationRequest` | ID, environment ID, destination identity, operation, frozen selection and entry IDs, immutable trusted brief, evidence manifest, body hash, dispatch correlation, lifecycle state, timestamps, result references, and reservation/ownership information. |
| `AnnotationResult` | ID, request ID, result revision, per-annotation outcomes, bounded summary, source-file references, checks/evidence references, limitations, and reporting provenance. |
| `AnnotationAsset` | Opaque ID, environment ID, digest, media type, byte/dimension metadata, storage location managed by backend, references, and creation/retention timestamps. |

Separate `metadataRevision` from `contentRevision`: execution progress must not
invalidate a user's content edit on every agent event. Mutations name the
specific expected revision they protect. Result acceptance checks content and
capture revisions, plus the result revision, rather than a timestamp.

Page identity contains an environment-local service identity/port and a sanitized
route, including meaningful query/hash state. Keep display URL and transport URL
separate. Never use a gateway token or the current ephemeral gateway origin as
the durable page identity. Sanitization may remove identity information; mark
that page as requiring user navigation rather than inventing an exact match.

## Provenance and target unions

- [ ] Define entry provenance `host-user`, `legacy-page-comment`, `page-evidence`,
  `agent-reference`, and `system`. The receiving boundary assigns provenance;
  untrusted payloads cannot self-declare `host-user`.
- [ ] A human action may quote or refer to old page comments without silently
  rewriting their provenance. A newly typed host instruction is a new entry.
- [ ] Define targets `element`, `text-range`, `region`, `page`, and
  `legacy-unresolved`. Enable only `element` and migrated unresolved targets in A.
- [ ] Define anchor outcome `matched`, `missing`, `ambiguous`, `stale`, or
  `unsupported`; include matching rule and candidate count, not a fabricated
  numeric confidence score.
- [ ] Keep file/component hints optional, attributed, and verified separately
  from page selectors. A page-provided file path is not a filesystem authority.

## Request lifecycle

Persist execution lifecycle separately from annotation open/resolved state.
The following is the proposed normalized request state machine:

Brief preview/preparation candidates are unsent drafts outside this lifecycle.
The first state below starts only when the user commits Send. An implementation
reservation is acquired then, not while the user is reviewing a draft brief.

| State | Entry condition | Permitted next state / action |
| --- | --- | --- |
| `prepared` | Frozen request and annotation reservation committed | `queued`; cancel before queue publication |
| `queued` | Existing native queue contains the stable request ID | `dispatching`; cancel only through queue removal before its dispatch fence |
| `dispatching` | Existing native dispatch boundary owns the request | `running`, `unconfirmed`, or `failed` with explicit rejection |
| `unconfirmed` | Native dispatch outcome is unknown | Reconcile to `running`/terminal evidence; same-ID native recovery; explicit abandon |
| `running` | Positive dispatch evidence, even if provider turn ID is not available yet | `needs-input`, `completed`, `awaiting-review`, `failed`, `cancelling` |
| `needs-input` | Authoritative pending question/approval for this request | `running`, `cancelling`, or authoritative terminal outcome |
| `cancelling` | Stop requested for the correlated current turn | Remain active until `cancelled`, `failed`, or completion is confirmed |
| `completed` | A discussion turn has ended successfully | Terminal discussion record; no annotation resolution |
| `awaiting-review` | An implementation turn ended and its response is available | Record human review; annotation stays open until accepted |
| `failed` / `cancelled` | Authoritative failure/cancellation or safe pre-dispatch removal | New attempt has a new ID only after prior execution is known settled |
| `abandoned-unconfirmed` | User discarded native recovery without proof of execution outcome | Preserve warning/history; release retry restrictions only after explicit handling of possible prior work |

`blockedReason` is orthogonal: queue held by an existing draft, stopped
environment, unavailable destination, or capacity. A blocked queue is not
failed execution. Completion lacking a result summary shows a transcript link
and “Review response”; it must not invent success criteria or changed files.

- [ ] Define allowed transition validation and duplicate/out-of-order update
  behavior. Generation changes trigger reconciliation, not regression to idle.
- [ ] Default to one active implementation reservation per annotation across
  sessions. Discussion/review may be separate requests; they cannot seize or
  silently replace the implementation reservation.
- [ ] Resolution stores who accepted, which request/result, content revision,
  and capture revision. New substantive feedback reopens the annotation.
- [ ] Delete is a tombstone for active/referenced history. Reject deletion while
  active implementation is unresolved; allow hiding from the default list.

## Initial limits

These are proposed release defaults, not measurements of existing usage. Enforce
both count and serialized UTF-8 byte limits. Existing transport limits remain
ceilings: if smaller, they win and the UI receives an explicit capacity error.

| Resource | Proposed bound |
| --- | --- |
| IDs / title | 200 / 200 characters |
| Human entry / overall request instruction | 8,000 characters each |
| Structured capture metadata | 64 KiB encoded UTF-8 |
| Image | 8 MiB decoded PNG; longest side 2,000 pixels |
| Reference text per annotation | Existing 12,000-character ceiling |
| One dispatched brief | 64 KiB text; 20 annotations; 20 attachments; 16 MiB aggregate decoded attachments or lower provider/transport cap |
| Milestone A request | Exactly one annotation; later batch count remains disabled |
| List page / entry page | 50 items; 256 KiB / 512 KiB response |
| Thread | 500 published entries and 2 MiB textual payload; explicit archive/continuation action at capacity |
| Environment metadata | 2,000 annotations; 5,000 requests; 32 MiB total non-asset payload quota |
| Environment image quota | 512 MiB; reclaim only unreferenced assets |
| Writes / dispatch preparation | 32 queued mutations per environment; 4 simultaneous preparations per backend |
| Pending native capture spool | 4 per preview, 16 per desktop process, 64 MiB aggregate decoded images |
| Sync hints | 256 per environment, 256 KiB ring; 64 environments in memory; eviction yields reset |

Do not increase the old transcript-comment limit globally to accommodate a new
discussion entry. New records get their own limits and prompt summarization
rules. Limits must be enforced before expensive DOM/image allocation where
possible and again at backend trust boundaries.

## Verification and completion

- [ ] Validate malformed IDs, non-finite geometry, over-limit UTF-8 strings,
  duplicate IDs, unknown versions, forbidden provenance, and invalid transitions.
- [ ] Verify new schema parsing leaves legacy transcript annotation parsing
  untouched; require explicit conversion for imported browser entries.
- [ ] Verify stale content cannot be accepted by an old result and progress-only
  revisions do not cause content-edit conflicts.
- [ ] Publish fixtures for each request state and capture type. Later steps use
  those fixtures instead of inventing incompatible payloads.
- [ ] Review the contract against all three milestones and update this file
  before implementing a divergent state, command, or limit.

Done when shared contracts, runtime validation, limits, and state transition
tests are implemented and exported without enabling new UI.
