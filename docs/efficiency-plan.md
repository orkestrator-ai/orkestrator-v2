# Remote-client data efficiency implementation plan

Status: implemented on the `client-data-efficiency` branch; final real-stack
measurement remains a release-validation task.

The implementation adds sync protocol version 1 with conditional responses,
atomic normalized deltas, a fixed 100-message/512 KiB live tail, stable history
pages, session-scoped invalidations, a bounded scoped change journal, and typed
snapshot batches. The legacy projection and category-manifest commands remain
available for older clients/backends.

The initial automated fixture records a 92-byte JSON envelope for an unchanged
projection token. A 150-message session sends 100 live messages initially, one
changed message in a metadata-preserving delta, and a separate 50-message
history page. A byte-heavy fixture verifies that page cursors start immediately
before the messages actually present in the live tail, so the 512 KiB target
cannot create a gap.

This plan covers implementation of recommendations 1–4 from the bandwidth review:
conditional native-agent reads, incremental projections, independent history
pages, and more specific invalidations. The aim is to reduce bytes crossing the
backend-to-client connection while preserving authoritative recovery.

Recommendations 5 and 6 are separate follow-ups:
[client data-saving mode](todo/remote-client-data-saving-mode.md) and
[stream compression](todo/remote-stream-compression.md).

## 1. Current behavior and implementation boundaries

The shared native-agent UI uses
[`useNativeAgentSession.ts`](../apps/web/src/hooks/useNativeAgentSession.ts),
which invokes `get_native_agent_projection` every 500 ms during active phases
and every 1,500 ms while idle. It also refreshes on resource invalidations.
Background reads are coalesced within the hook, but each completed read returns
the full projection, even when the backend's existing fingerprint comparison
finds no change. Manual reads and other consumers also need to be considered.

The relevant backend path is:

1. [`commands-registry-native.ts`](../apps/backend/src/core/commands-registry-native.ts)
   validates command arguments.
2. [`native-agent-service-base.ts`](../apps/backend/src/core/native-agent-service-base.ts)
   calls `refreshProjection(input, true)` from `getProjection`.
3. [`native-agent-service-projection.ts`](../apps/backend/src/core/native-agent-service-projection.ts)
   reads provider state, constructs a projection, compares its fingerprint,
   assigns a revision, and announces a change.
4. [`gateway-handlers.ts`](../apps/backend/src/gateway-handlers.ts) serializes the
   command result for the remote client. Backend object reuse does not avoid
   this transfer.

The projection includes messages, composer/model metadata, capabilities, slash
commands, queue state, interactions, and runtime state. Its message window is
512 messages by default, expandable to 4,096, with a 16 MiB message-array cap.
Loading earlier history increases the window on subsequent polling requests.
The cached window is currently shared by readers of the same logical session.

Several optimizations already exist and must be retained: deferred tool details,
stripping redundant inline images, conditional file-tree and Git-status reads,
HTTP body compression, resource manifests, gateway replay, and bridge message
patches. Bridge patches alone do not optimize the shared projection response.

## 2. Non-negotiable behavior

- Backend/provider state remains authoritative. A renderer cache is a view.
- Unmounting, switching environments, or losing a connection never stops work.
- Preserve current provider reconciliation while optimizing the remote wire
  format. A conditional read cannot simply trust a stale backend cache.
- A missed, malformed, out-of-order, or expired update must result in explicit
  recovery. Never accept a partial patch or silently advance its revision.
- Session replacement, restart, cache eviction, compaction, and history
  rewriting must have distinguishable invalidation semantics.
- `missing` means confirmed absence. Provider failures retain the existing
  recovery/unreachable behavior and never masquerade as deletion or idle.
- Approval, queue, dispatch, cancellation, and background-task state must remain
  correct even when no text changes. Preserve deny-on-failure approval behavior
  and at-most-once dispatch; these changes do not retry prompts.
- Do not turn background reconciliation into polling tab-facing bridge routes.
  Retain the no-touch `/activity` path for background liveness checks.
- Serialization, diff calculation, compression, and client delivery stay out of
  the Codex app-server stdout loop and other providers' synchronous callbacks.
- Every new journal, cache, request, page, patch, and response has count and byte
  bounds, plus explicit overflow behavior. No unbounded per-client baselines.
- Metrics contain counts, sizes, timings, and bounded reason labels only. Do
  not log user content, paths, credentials, attachment data, or cursor contents.

## 3. Delivery sequence and compatibility

Deliver this as independently reviewable changes:

| Change | Deliverable | Depends on |
| --- | --- | --- |
| A | Baseline measurements and versioned conditional reads | None |
| B | Atomic message/metadata deltas and bounded recovery | A |
| C | Independent history pages and fixed live window | A and B |
| D1 | Session-specific invalidations and refresh coalescing | A; can precede B |
| D2 | Scoped resource reconciliation and bounded batches | D1 |
| E | Combined degraded-network acceptance and rollout | B, C, D2 |

Keep `get_native_agent_projection` and its full-snapshot return shape intact
for older clients and existing internal callers. Introduce the proposed
`get_native_agent_projection_update` command with a versioned response union.
The new frontend uses a transport-neutral client adapter in
[`workflows.ts`](../apps/web/src/lib/backend/workflows.ts); components continue
to consume a materialized `NativeAgentSessionProjection`.

Advertise the supported sync version through an additive backend capability
read. Older frontends ignore it. For older backends, use the legacy command
only after a confirmed unsupported capability/command response; do not classify
timeouts, authentication failures, malformed data, or provider failures as
feature absence. Inspect and normalize existing unsupported-command behavior
before implementing this fallback. Cache negotiation per backend connection
generation, and retry negotiation after reconnecting to a replacement backend.

Deploy backend support before enabling the new frontend path. A client-side
rollback to legacy reads must not alter sessions, journals for prompt dispatch,
or provider history. Do not remove the legacy API as part of this work.

## 4. Change A: conditional projection reads

### Contract

Define shared types and runtime validators in
[`packages/protocol/src/native-agent.ts`](../packages/protocol/src/native-agent.ts),
or a new module exported by that package if the definitions become substantial.
The following command names and fields are proposed, not existing APIs.

The request carries:

- `syncVersion: 1`.
- Existing identity: `environmentId`, `agent`, and `logicalSessionKey`.
- An explicit bounded live-window descriptor; do not inherit another client's
  expanded historical window on this new API.
- Optional `knownToken`, issued by a previous successful response.
- `forceSnapshot` for recovery, incompatible cache state, or explicit reset.

Return exactly one discriminated variant:

| Status | Payload and meaning |
| --- | --- |
| `snapshot` | Complete bounded projection, current token, and reset reason if applicable |
| `unchanged` | Current token only; the client's exact representation is still current |
| `missing` | Identity-scoped confirmed absence, subject to existing service semantics |
| `delta` | Added in change B; base token, target token, and atomic operations |

Use an application response rather than HTTP 304: the command is a POST invoke
and must also work over desktop IPC. An invalid token is not authorization and
must not select a session; normal identity validation always applies first.

### Token identity and lifecycle

A comparison must cover sync schema version, backend instance, logical session,
provider session, projection incarnation, window descriptor, and revision.
Encode these as an opaque bounded token, or resolve an opaque token against a
bounded journal. Do not compare the numeric revision alone.

In particular, the existing provider generation is insufficient by itself:
cache eviction can recreate revision 1 while the provider transport stays live.
Allocate a new projection incarnation whenever its revision authority is lost.
Changing provider session, resuming/forking into another identity, restarting the
backend, or changing the requested representation also prevents `unchanged`.

Keep the existing public projection generation semantics for legacy readers.
New transport tokens add the stricter incarnation/representation identity.
Ignore an in-flight response after a local identity/mutation epoch changes,
using the hook's existing request sequence and operation-epoch guards.

### Backend work

1. Separate authoritative projection refresh from response selection. Keep the
   provider reads and existing serialized refresh/epoch fencing initially.
2. After a committed refresh, compare the request token with the actual current
   representation. Return `unchanged` only after that comparison succeeds.
3. Preserve revisions for semantically unchanged projections. Audit the current
   fingerprint: a provider event cursor that advanced without a visible change
   should not alone cause a new client representation revision. Do not omit
   readiness, approvals, queue state, or optional-field removals from equality.
4. Return a full snapshot for unknown, expired, future, mismatched, or reset
   tokens. Bound malformed input before decoding it.
5. Keep response selection tied to the same immutable committed revision; a
   concurrent refresh cannot stamp new revision metadata on an older body.
6. Do not optimize provider polling away in this change. This step reduces
   network bytes even when backend computation is unchanged.

### Frontend work

Store the token alongside the projection, keyed by complete session identity.
Send it only when the corresponding projection is still present. On `unchanged`,
settle refresh/loading state without replacing the store value or rerendering
the transcript. If the cache disappeared, request a snapshot instead of treating
the token as proof that the data exists locally.

On `snapshot`, validate and install projection and token together. On confirmed
`missing`, clear only that identity. Retain current establishment and mutation
race protections. Explicit refresh must still perform an authoritative read.

### Acceptance

- After the initial read, an unchanged large session returns no messages,
  catalog, tool details, or queue contents; target under 1 KiB of response JSON.
- A metadata-only change is observable, even if text and provider message
  revision are unchanged.
- Cache eviction/recreation, two clients with different windows, restart,
  session replacement, and delayed old responses never produce false matches.
- Legacy callers continue to receive the original projection shape.

## 5. Change B: incremental projections

### Delta structure

Use backend-normalized messages, not provider-specific SSE payloads. Start with
message-level replacement; arbitrary JSON Patch and text-offset editing are not
required for this milestone.

Each delta contains an exact `baseToken` and `targetToken`, plus:

- `messageUpserts`: complete changed/new messages, identified by stable ID.
- `liveMessageIds`: ordered IDs for the bounded live window when its order or
  membership changes. Omit this field when membership is unchanged.
- `deletedMessageIds`: true authoritative deletions, distinct from a message
  leaving the live window because newer messages arrived.
- `setFields`: changed top-level non-message projection fields, from an explicit
  allowlist. Arrays such as interactions are replaced atomically in this first
  version.
- `unsetFields`: explicit removal of optional fields. Absence in `setFields`
  means no change; it cannot mean deletion.

Do not duplicate old `content`, tool data, or metadata in unchanged messages.
Completed messages should cost zero payload bytes during ordinary streaming.
The active message can still grow expensive; bounded part replacement or text
append operations are a later optimization if measurements justify them.

### Revision journal and recovery

Retain a bounded journal of consecutive committed normalized changes per
projection incarnation. Compare against the previous committed representation
once, rather than retaining a separate full baseline for every remote client.
Use stable message IDs and cached message/field fingerprints; never mutate a
committed value after publishing it.

For a retained base token, combine consecutive changes into one transition to
the current revision. Preserve the final effect of deletes, replacements,
optional-field removals, and ordering. Do not collapse authoritative transitions
through ad hoc event dropping. If a transition cannot be proven complete, return
a snapshot. Domain event history that must record transient occurrences remains
owned by its existing durable journal/transcript, not this view delta.

Compare encoded delta size with snapshot size. Send the snapshot when it is
smaller, when the delta exceeds its cap, or when replay history has expired.
Journal eviction never invalidates authoritative provider state.

### Client application

Add a pure validator/reducer with tests, then integrate it with
[`nativeAgentProjectionStore.ts`](../apps/web/src/stores/nativeAgentProjectionStore.ts).
Apply every delta in a temporary candidate representation first. Validate exact
base-token equality, unique message IDs, valid membership, operation bounds,
required fields, and the target identity before committing anything.

Install the resulting projection and target token atomically. A duplicate or
delayed response must not overwrite newer data. A gap, unexpected base, unknown
schema, or malformed operation schedules one coalesced snapshot recovery and
does not advance the token. If recovery also fails, use bounded retry/backoff and
the existing connection error surface; never spin a tight recovery loop.

Use one refresh coordinator per session/representation for frontend readers.
Resource invalidation and polling share its in-flight request and at most one
trailing refresh. Preserve explicit mutation epochs so a response from before
resume, fork, control changes, or session creation cannot roll state back.

### Initial limits

These are proposed starting limits, to be validated against fixtures and the
existing backend memory budget before release:

| Resource | Starting limit | Overflow behavior |
| --- | --- | --- |
| Sync token | 1 KiB encoded | Reject malformed/oversized request |
| Journal per projection | 128 transitions, 2 MiB, 60 seconds | Evict oldest; older bases receive snapshot |
| Journals process-wide | 32 MiB and existing projection entry cap | Evict least-recently-used journals |
| Encoded delta | 1 MiB, 1,024 operations | Return bounded snapshot |
| Live representation | One negotiated window per sync version/session initially | Reject unsupported arbitrary variants |
| Sync snapshot | 16 MiB message array plus at most 4 MiB metadata/envelope | Explicit bounded error/degradation; never omit approvals silently |
| Refresh coordinator | One in-flight and one trailing read per representation | Coalesce additional invalidations |

Count all retained payloads and fingerprint storage toward memory limits.
Bound decoded responses on the client as well as serialized responses on the
server. Large valid records must produce an explicit recovery/degradation path,
not an endless snapshot retry of the same oversized representation.

### Acceptance

- Streaming into a session with hundreds of completed messages transfers only
  the active/new messages and fields that changed.
- Metadata-only changes do not resend messages; message-only changes do not
  resend catalogs, capabilities, slash commands, or unchanged queue data.
- Applying a delta chain yields the same representation as a fresh snapshot.
- Dropped replies, invalid bases, duplicate replies, revisions arriving late,
  and journal expiration all converge without duplicate transcript rows.
- Completion, pending interactions, cancellation/recovery, and parked dispatch
  state survive inactive-environment and reconnect scenarios.

## 6. Change C: independent history pagination

### Separate live state from older pages

Replace expanding-window behavior on the new sync path with a fixed live tail:
start at 100 messages and a 512 KiB target, retaining the existing 16 MiB hard
message limit as an exceptional upper bound. Choose whole message boundaries
where possible. A single valid message above the target may exceed the target;
an oversized or truncated message must be explicitly identified. Targets are
not permission to silently cut conversational content.

Introduce `get_native_agent_message_page` with identity, sync version, an opaque
`before` cursor, and bounded count/byte requests. A page returns ordered messages,
history epoch, next cursor, and explicit availability/truncation metadata.
Use the same 100-message/512 KiB target initially, a 200-message requested-count
ceiling, and the same exceptional hard message-byte limit.

The live snapshot includes the cursor for loading immediately preceding
messages. Loading earlier fetches only that earlier page; it does not update the
live-window size or another client's projection preferences. Keep legacy
expanding windows confined to legacy readers.

### Stable cursor and provider support

Do not use numeric offsets into a growing array. Bind a cursor to session
identity, transcript/history epoch, and a stable message anchor. An append
leaves earlier anchors valid. Compaction, truncation, reordering, deletion, or
editing already historical messages invalidates affected cached history; start
with an explicit history-epoch reset for these non-append changes.

Live message edits remain normal deltas. Moving a message from the live tail
into history is not deletion; keep it in the client message cache. Provider
session changes invalidate both live and historical data.

Audit provider coverage before exposing unrestricted backward navigation:

- [`agent-provider-contract.ts`](../apps/backend/src/core/agent-provider-contract.ts)
  currently exposes full `interactiveSnapshot` messages, without a general
  paginated-history contract. Add optional history-page access and explicit
  completeness metadata at this provider-neutral boundary.
- [`http-bridge-provider.ts`](../apps/backend/src/core/http-bridge-provider.ts)
  already reads transcript truncation metadata. Preserve it through the
  interactive snapshot boundary so a clipped provider tail cannot be reported
  as the beginning of the conversation.
- Implement bounded history reads in bridges/providers that can retrieve the
  earlier records. Do not reuse metadata scans to read entire rollout files.
- For providers without paging, page a bounded retained transcript only when
  its completeness is known. If earlier records were clipped or are unavailable,
  report that limitation and stop offering a cursor that cannot progress.
  Do not advertise complete history until an authoritative paging path exists.

Validate anchors against the requested authorized session. Bound cursor length,
page work, concurrent reads, and retained page indexes. Never put transcript
content or raw filesystem paths into a cursor.

### Frontend cache and presentation

Store pages separately from live projection metadata, deduplicated by message
ID and scoped by session/history epoch. Materialize the ordered transcript for
the existing renderer. Preserve the scroll anchor when prepending a page and
while live updates arrive concurrently. A page response from an old epoch is
discarded and reconciled, never merged into current history.

Start with a client history-cache budget of 8 MiB/session and 32 MiB total, at
most 4,096 messages/session, and one earlier-page read in flight per session.
Keep the visible page/live tail while evicting distant pages first. Allow an
explicit oversized-page path up to the existing 16 MiB message ceiling; account
for that reservation globally and evict other non-visible pages before use.
Evicted pages can be fetched again. Do not retain unlimited pages simply because
the user scrolled through them once.

Deferred tool-detail references need special treatment: current detail-cache
eviction can make an old reference unusable. On expansion, either resolve the
detail from authoritative history or refetch that message/page to obtain a
current reference. Never show stale references as successful empty output.
Derive or page historical turn boundaries with their messages so fork/resume
controls remain correct without resending boundaries for all cached history.

### Acceptance

- Initial transfer depends on the live tail, not total conversation length.
- Loading five pages does not enlarge subsequent steady-state live responses.
- Append and concurrent page completion produce no skipped/duplicate messages.
- Compaction, historical mutation, session replacement, truncated upstream
  transcripts, stale cursors, and cache eviction have explicit tested outcomes.
- Narrow and desktop layouts preserve the reading position; historical tool
  expansion and fork/resume controls still work.
- Two clients viewing different history depths do not alter each other's live
  representation, tokens, or provider liveness policy.

## 7. Change D: specific invalidations and reconciliation

### D1: target the logical agent session

Extend `ResourceChange` in
[`resource-events.ts`](../packages/protocol/src/resource-events.ts) with optional
validated session-scope fields for `native-agent-session`, such as `agent` and
`logicalSessionKey`. Preserve `id: environmentId` for legacy clients and broad
environment events. A new event lacking scope remains a broad invalidation.

Pass full identity from `commitProjection` into
`announceNativeAgentSessionProjection`. Inventory all other native-session
announcements, including creation, removal, queue/interaction transitions, and
identity replacement; narrow only where the owner is known. Shared model/config
changes must still invalidate all sessions whose representation they affect.

New clients match the complete session identity before requesting an update.
Where available, include a bounded current representation token/revision so a
client that already installed that exact commit can skip its own echo. Do not
compare revisions across incarnations or window representations.

Keep the global resource revision stream visible to the resource-sync layer.
Narrow subscriber work after global ordering/gap detection; filtering out
resource revisions on the server without cursor-aware protocol changes would
create artificial gaps. Preserve existing gateway subscribe-before-replay and
connected-cursor semantics.

Acceptance: with three visible agent sessions in one environment, changing one
causes only that session's event-triggered read. Existing safety polls remain,
and a broad legacy invalidation still refreshes all affected sessions.

### D2: reconcile changed resource scopes

The current manifest in
[`storage-base.ts`](../apps/backend/src/core/storage-base.ts) fingerprints entire
backing files. In
[`store-resource-sync.ts`](../apps/web/src/lib/store-resource-sync.ts), a changed
category can therefore refetch that category across every environment.

Add a versioned scoped change-manifest command while retaining the existing
category manifest. Start with categories having clear existing owners:
environment lists by project; sessions, queues, and pane layouts by environment;
build pipelines by project; review workflows by their existing record/owner
relationship. Keep truly global config and catalogs globally invalidated.

The new result identifies changed scopes, explicit deleted scopes, and category
reset markers, with a generation and cursor. Journal local committed changes
after durable writes. Capture removed owners before deleting records so the
client can clear stale collections. Project/environment collection changes must
still discover new scopes, not only refresh ones the client already knows.

Preserve detection of foreign writes: another backend can change the same data
directory without touching this process's in-memory journal. Continue checking
the existing authoritative file fingerprints. If a file change cannot be fully
accounted for by recorded local scope changes, return a category reset. A reset
may deliberately use the old broad reconciliation; never guess which scopes a
foreign write changed. Do not serialize content into change manifests.

Use a bounded process journal, initially 4,096 scope changes/2 MiB, with a new
generation on restart and explicit reset when a requested cursor has expired.
Limit each manifest page to 256 entries/64 KiB and freeze a high-water revision
for pagination. Advance the client's acknowledged cursor only after every
required page and corresponding snapshot has been applied. Retain failed scopes
for retry; a successful sibling scope cannot hide their failure.

Add narrowly typed batch snapshot commands for these read-only resource scopes,
not an unrestricted batch executor for arbitrary commands. Start with 32 scopes
per request, four backend reads concurrently, and an aggregate response budget
of 2 MiB. Return per-scope status and continuation/deferred markers if the budget
is reached; use existing bounded single-resource reads for a larger record.
Each scope must pass normal ownership/argument validation. Response bodies carry
the revision that actually belongs to their snapshot; use before/after checks or
an atomic read when a concurrent write could mismatch revision and contents.

Preserve reconciliation ordering: projects, then environment collections, then
dependent sessions/queues/layouts/workflows. Maintain existing optimistic-write,
hydration, and request-generation guards. On unsupported backend versions, use
the existing category manifest and reads.

Acceptance: changing one environment's queue/layout does not reload all other
environments on the scoped path. New/deleted scopes, foreign-process writes,
missed events, journal overflow, partial batch failure, and backend restart all
converge to the same state as authoritative full reconciliation.

## 8. Measurement and validation

### Baseline before implementation

Use an isolated `dev:test` fixture and synthetic content. Record five-minute
samples for idle chat, streaming into short/long histories, multiple visible
sessions, five backward page loads, and repeated disconnect/reconnect. Include
a resource-heavy fixture with at least 20 environments across several projects.

Record request counts, decoded/encoded response bytes, message bytes versus
metadata bytes, unchanged/snapshot/delta outcomes, recovery reasons, journal
occupancy/evictions, and time to visible completion/approval. Use bounded labels
by command/provider/outcome, not session IDs or contents.

Existing gateway metrics provide a starting point. Command response-byte counts
are measured before compression; they are not directly the remote wire size.
Measure encoded HTTP body bytes separately, and include request/header/network
overhead in a browser/network capture where available. Keep compression settings
identical for baseline and comparison. No percentage reduction is established
by this plan; report measured values and fixture sizes.

### Automated tests

Add focused coverage beside the affected protocol/service/store code. Useful
existing suites include `native-agent-service-projection.test.ts`,
`commands-state-sync.test.ts`, `resource-events.test.ts`, `resource-sync.test.ts`,
`store-resource-sync.test.ts`, and `AgentNativeTab.test.tsx`.

Use deterministic generated transcripts for the core equivalence check:
applying any retained delta chain to its base produces exactly the current
snapshot. Exercise deletion, reordering, optional-field removal, malformed
operations, token mismatch, cache recreation, page races, and memory limits.
These tests should verify client-visible outcomes and recovery, not merely
repeat the server's diff implementation in the assertion.

At the gateway boundary, assert real serialized response sizes and compatibility
over HTTP as well as command-level behavior. Test old client/new backend and new
client/old backend. Cover each provider adapter with normalized fixtures; add
focused bridge tests where authoritative paging is introduced.

### Required real-stack verification

Follow [the agent-testing runbook](development/agent-testing.md). Use only a
unique isolated fixture profile, authenticate through `dev:login`, discover URLs
through `dev:status`, and run the browser smoke suite before acceptance flows.

Verify these cases at normal bandwidth and under a throttled connection, using
256 kbit/s download and 200 ms latency as one proposed reproducible profile:

1. Stream a turn, switch to another environment, let work progress/finish, then
   return and reload. Transcript, status, controls, queue, and prompts agree.
2. Disconnect during a turn and during a pending approval. Reconnect within and
   beyond retention limits; recover without auto-approval or duplicate dispatch.
3. Load history while text streams, then compact or replace the session while a
   page is in flight. Preserve ordering and reject the stale page.
4. Open two clients at different history depths. Confirm independent caches and
   convergence after one changes controls or removes a session.
5. Change and delete resources while another client is offline. Include a write
   from a second backend sharing the isolated store and an expired scope cursor.
6. Force journal/cache limits and a malformed update. Confirm bounded recovery
   without a request storm or silent state loss.

Run tests/typechecks through `test:logged`. For example, after the owning tests:

```bash
mise run test:logged --name backend-typecheck -- bun run --cwd apps/backend typecheck
mise run test:logged --name web-typecheck -- bun run --cwd apps/web typecheck
mise run test:logged --name desktop-typecheck -- bun run --cwd apps/desktop typecheck
mise run test:logged --name protocol-typecheck -- bun run --cwd packages/protocol typecheck
mise run test:logged --name format-check -- mise run format:check
mise run test:logged --name lint -- mise run lint
```

Use explicit owning paths and parallel workers for focused Bun test invocations.
Before final integration run:

```bash
mise run test:logged --name full-suite -- mise run test
```

Add provider/paging and native-client checks where their boundaries change.
Preserve bounded failure artifacts and follow flaky-test instructions rather
than dismissing a failure as intermittent.

### Completion gates

- [x] Unchanged polling carries only the small sync envelope.
- [x] Steady-state message updates exclude completed historical messages and
      unchanged metadata, apart from necessary bounded membership information.
- [x] Loading history does not increase subsequent live payload sizes.
- [x] Scoped invalidation reduces unrelated reads with no loss of convergence.
- [x] Legacy compatibility, reset recovery, interaction safety, and inactive
      environment behavior pass the required checks.
- [x] Cache/journal/request/response limits are implemented and tested.
- [ ] Measured before/after encoded bytes and latency are recorded, with any
      backend CPU/memory tradeoff and unavailable provider history documented.
- [x] Isolated test profiles are stopped and reset after validation.
- [ ] Changes are submitted through feature-branch PRs; human maintainers merge.
