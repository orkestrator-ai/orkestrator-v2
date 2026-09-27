# Frontend, background work, and other transcript consumers

See [the review index](README.md) for priorities and
[transcripts.md](transcripts.md) for the main data path.

## E10: Retained frontend history is reserialized on live updates

**P2 · source-confirmed main-thread work.**

In [`useNativeAgentSession`](../../../apps/web/src/hooks/useNativeAgentSession.ts#L89),
`encodedBytes` creates a JSON string and a UTF-8 buffer. The progressive
installation path computes the size of the retained historical prefix again
when a live view arrives; the sync materialization and paging-budget paths also
measure retained history. That history can reach 4,096 messages/8 MiB per
session. See the retained-prefix accounting around
[`line 1210`](../../../apps/web/src/hooks/useNativeAgentSession.ts#L1210).

Then [`setProjection`](../../../apps/web/src/stores/nativeAgentProjectionStore.ts#L129)
serializes the combined message array whenever its array identity changes.
Live updates create a new joined array even if almost all historical objects
are unchanged. `setProgressiveCache` similarly remeasures discovery data when
updating the progressive cache, rather than keying its size to a discovery
revision. This is frontend work that message-list virtualization cannot remove.

There are useful protections already: unchanged-source reads can avoid a
transcript installation; `setProjection` reuses size for the exact same message
array; message normalization uses WeakMaps; and the DOM list is virtualized.
This finding concerns changed updates after substantial history has been loaded,
not an assertion that every idle poll rerenders the entire transcript.

**Improve:** store sizes with immutable messages/history pages and update totals
only for upserts, deletions, or page changes. Keep retained pages separate from
the changing tail through more of the display pipeline. Preserve message
identity when unchanged, and reuse the discovery size for the same revision.
Consider moving genuinely large normalization work off the main thread only
after eliminating repeated work.

**Verify:** load near the history budget, stream into one current message, and
measure serialization visits, allocation, input latency, and long tasks. Repeat
with another environment active and after global history eviction/remount.
Accounting must actually release evicted history, including mounted-hook refs.

## E11: Polling is tab-aware but not document-visibility-aware

**P2 · source-confirmed scheduling opportunity.**

[`useNativeAgentSession`](../../../apps/web/src/hooks/useNativeAgentSession.ts#L2373)
polls every 500 ms during running/blocked/cancelling/recovering phases and every
1,500 ms otherwise. It gates on `enabled` and the selected tab's `isActive`,
and also refreshes on scoped invalidations. That scheduling block has no
`document.visibilityState` gate. The files panel likewise polls every five
seconds while open. Browser/OS timer throttling may reduce actual frequency,
but it is not an application-level visibility policy.

At the backend, the two-second activity sweep groups sessions and bounds worker
concurrency. Within a group,
[`reconcileAgentActivityOnce`](../../../apps/backend/src/core/native-agent-service-reconciliation.ts#L301)
uses `activityBatch` when available; HTTP bridge providers implement individual
`observeActivity` calls. Those per-session reads are sequential within a group.
An environment with many retained sessions therefore still makes many small
requests, and a slow read delays later sessions in that group.

**Improve:** pause presentation-only polling while the document is hidden and
reconcile immediately on visibility/reconnect. Coalesce invalidations and
recovery polls by session/view identity. Add a bounded no-touch batch activity
endpoint for HTTP bridges. Retain background supervision and pending-interaction
recovery; do not solve request volume by relying on mounted React subscribers.

The existing [data-saving proposal](../../todo/remote-client-data-saving-mode.md)
already covers visibility and optional backoff. Treat an event-only design or
longer idle intervals as experiments, not universally safe replacements.

**Verify:** compare request counts for a visible, hidden, and resumed document,
and activity-sweep latency with 1/10/100 sessions. Include pending approvals,
completion, an offline period, and two clients with different visibility.

## E12: Unchanged file-tree responses still enumerate the workspace

**P2 · source-confirmed non-transcript I/O.**

The files panel's conditional requests save response payload and redundant
store updates. However,
[`get_local_file_tree`](../../../apps/backend/src/core/commands-registry-terminal.ts#L736)
builds the file tree before checking its digest, and
[`get_file_tree`](../../../apps/backend/src/core/commands-registry-terminal.ts#L899)
runs a container enumeration via `dockerExec`, parses it, and then calls
[`conditionalSnapshot`](../../../apps/backend/src/core/commands-terminal.ts#L103).
That helper hashes a freshly serialized value.

The tree is bounded at 5,000 nodes and excludes `.git`/`node_modules`, so this is
bounded repeated work rather than an unlimited traversal. Nonetheless, every
relevant five-second refresh can pay for enumeration, sorting, subprocess work,
and hashing even when the tree is unchanged. Git-status paths already have some
snapshot caching; they should not be described as uniformly uncached.

**Improve:** cache file-tree values and their digests by environment/root and a
watcher generation, with TTL reconciliation for missed events. Invalidate on
directory-affecting mutations; content-only changes need not always rebuild
the tree. Share in-flight scans across clients and coordinate with the existing
worktree watcher. Container paths need explicit restart/overflow recovery.

**Verify:** count enumeration and Docker exec calls over an unchanged interval,
then create/rename/delete files, switch roots, overflow/restart a watcher, and
reconnect. Every missed change must become visible through reconciliation.

## E13: Multi-review transcripts bypass the progressive native chat path

**P2 · source-confirmed whole-transcript reads.**

[`MultiReviewReviewerTab`](../../../apps/web/src/components/review/MultiReviewReviewerTab.tsx#L42)
uses a separate transcript read model and polls every four seconds while an
active reviewer is pending/running. The backend's
[`reviewerTranscript`](../../../apps/backend/src/core/multi-review-service.ts#L494)
calls `provider.messages` and then truncates by count. The HTTP provider fetches
the legacy `/messages` body before slicing. This path does not use the native
chat transcript token/delta contract, so native chat optimizations do not
automatically benefit these views.

Separately, [`MultiReviewProgressTracker`](../../../apps/backend/src/core/multi-review-progress.ts#L38)
probes at most once per 60 seconds and asks its caller for the newest message.
Its own source comment correctly notes that the HTTP transport still transfers
the full legacy response. The cadence is already throttled and the retained
progress digest is fixed-size; the remaining waste is upstream of the slice.

**Improve:** reuse conditional transcript windows for the reviewer display and
provide a cheap transcript-progress revision or digest for supervision. Scope
that progress signal to meaningful transcript mutations; a generic status or
access-time change must not keep a stalled workflow alive. Use a bounded tail
request as fallback when a provider cannot expose a suitable progress signal.

**Verify:** unchanged reviewer polls should return a small response without a
legacy history fetch. Progress must still detect nested-agent changes, survive
bridge restart, and preserve the existing warning/abandonment semantics. Finished
and hidden reviewer views already stop interval polling; retain that behavior.

## E14: Build pipelines embed transcripts in the shared workflow store

**P1 · source-confirmed duplication and persistence amplification.**

Build pipelines tick every 1.5 seconds. The running-stage path calls
[`refreshTranscript`](../../../apps/backend/src/core/build-pipeline-service-supervisor.ts#L882),
which normally fetches `provider.messages`, keeps the array in `PipelineSession`,
and records a `messagesFingerprint`. That fingerprint is not a digest:
[`transcriptFingerprint`](../../../apps/backend/src/core/build-pipeline-service-helpers.ts#L519)
returns the message count plus the entire serialized last message. The workflow
therefore retains another textual copy of its current tail message.

Transcript-only persistence is already throttled to five seconds, and final
state is persisted immediately. That is helpful, but
[`saveBuildPipeline`](../../../apps/backend/src/core/storage-drafts.ts#L704)
still embeds the transcript/fingerprint in a snapshot and rewrites the shared
build-pipelines file with normal backup rotation. Reads also load the whole
file rather than one pipeline. Historical stages and other pipelines increase
the cost of unrelated workflow updates. The 32 MiB per-snapshot rejection can
eventually make otherwise small control-state updates fail when enough display
data accumulates; no production occurrence was reproduced here.

**Improve:** make workflow state reference provider sessions and separately
stored bounded transcript chunks/tails. Keep task inputs, structured reports,
dispatch journals, and completion evidence durable under their existing
semantics. Preserve a defined offline transcript recovery policy instead of
simply removing the embedded history. As a smaller first change, store a
fixed-size digest rather than the raw serialized tail fingerprint and use a
conditional bounded read during active supervision.

This can share storage primitives with E04, but a build's durable review result
is not an expendable preview cache. The two need different retention policies.

**Verify:** run several pipelines with long histories and completed stages,
measure file bytes rewritten per active update, and restart between dispatch
and completion. Verify controls still persist near transcript limits and
completed structured results remain available after provider detachment.

## Areas inspected without a new high-priority finding

| Area | Existing protection | Follow-up measurement |
| --- | --- | --- |
| Remote gateway | Bounded replay, compression admission/buffers, explicit reconciliation, encoded-byte metrics | Actual supported remote proxy latency and compression CPU/bytes |
| Bridge SSE | Coalesced snapshots, scoped delivery/cursors, bounded slow-consumer handling | Redundant bytes between snapshot reads and event subscribers |
| Terminal history | Backend-owned terminal state, archive/checkpoint separation, shared in-flight snapshot request | Snapshot serialization during reconnect storms and many noisy terminals |
| Electron transport | Shared backend command interface and renderer IPC boundary | Allocation per large response; optimize payload shape before adding a new transport |
| OpenCode | Revisioned incremental stream cache and conditional transcript reads | Normalization on changed tails, cold SDK reads, child-session hydration |
| Codex/Claude lifecycle | Idle detachment/eviction and dedicated no-touch activity routes | Aggregate memory across many environments and cost of legitimate rehydration |

These rows are measurement targets, not claims that no defects exist. In
particular, a per-cache JSON byte limit is not a process heap budget: raw
provider state, parsed records, projected objects, retained revisions, encoded
responses, and client buffers can coexist. Measure their combined peak with
several environments before increasing any existing limit.

Do not switch transports or enable stream compression globally based on this
source review. The deferred [compression evaluation](../../todo/remote-stream-compression.md)
already defines the appropriate experiment. Reducing repeated source reads and
serialization should generally precede tuning encoded wire size.
