# 12 — Read bounded transcripts and resume observation

Status: Planned.
Depends on: [04](04-shared-actions-and-discovery.md),
[09](09-sessions-and-prompt-dispatch.md), [10](10-run-completion-and-waiting.md).
Index: [CLI commands plan](00-cli-commands-index.md).

## Target behavior

`session transcript` returns a bounded, ordered page with explicit continuation
and truncation information. Snapshot polling supports reconnecting observers.
Optional event following improves responsiveness while retaining exact snapshot
recovery; it is not required for the first release.

## Owners and starting points

- [Native paging/update commands](../../../../apps/backend/src/core/commands-registry-native.ts).
- [Projection service](../../../../apps/backend/src/core/native-agent-service-projection.ts).
- [Control MCP bounded transcripts](../../../../apps/backend/src/core/control-mcp-server.ts).
- [Gateway handlers](../../../../apps/backend/src/gateway-handlers.ts),
  [event replay](../../../../apps/backend/src/gateway-event-replay.ts), and
  [native protocol](../../../../packages/protocol/src/native-agent.ts).

## Required snapshot work

1. Expose normalized native message pages by stable session ID using existing
   backend pagination. Fix ordering, default/max message and byte budgets,
   continuation cursor, generation, and `truncated`/expired indicators.
   Validate counts/cursors before expensive reads.
2. Keep run/session summary reads metadata-only. Transcript reads are explicit
   content access and can hydrate the selected session within bounds; they must
   not scan every rollout or repeatedly fetch the entire session to tail it.
3. Define output for text, tool calls/results, errors, and unavailable details.
   Large tool bodies/attachments use explicit detail retrieval or omission
   metadata, not silent partial JSON. Preserve native normalized message IDs.
4. Implement bounded `--limit`, page/cursor, and JSON modes. Transcript content
   goes only to the requested output/artifact; routine diagnostics never echo
   it. Reuse test artifact sanitization when test runs retain that content.
5. Reconnect polling using authoritative state revisions. Expired/mismatched
   cursors return an explicit reset/full-snapshot requirement. A missing session
   and an unavailable provider are different from a successful empty transcript.

## Optional event-following extension

1. Advertise follow support only after a bounded JSONL event contract exists.
   Include event type, source identity, generation/revision, and recovery cursor.
   Do not add another SSE server or subscribe directly to provider private stdio.
2. Reuse gateway replay semantics: subscribe before calculating/flushing replay,
   preserve the client's requested cursor in connected frames, and detect gaps,
   generation changes, expired history, and reconciliation frames.
3. Reconcile state from a snapshot after every detected gap. Dedupe replayed
   updates by identity/revision and resume after the snapshot boundary. Never
   infer a run result from an event stream that silently skipped an interval.
4. Bound decoded frames, JSONL records, pending writes, and replay buffers.
   A slow stdout consumer must not block a bridge read loop or grow memory
   indefinitely. Disconnect/reset the observer explicitly on overflow; do not
   silently drop authoritative events. Retain terminal desync/snapshot semantics
   if terminal following is exposed later.
5. Propagate auth expiration and shutdown as observation outcomes. Reader cancel,
   abort, stream closure, and broken-pipe promises must all be handled without
   unhandled rejection or stopping accepted backend work.

## Verification

Test empty/large transcripts, tool detail limits, content-byte boundaries,
multibyte text, cursor expiry, session deletion, provider outage, and old-client
fallback. Assert summary polling remains independent of transcript hydration.

For following, test mutation during replay setup, disconnect mid-replay, restart,
auth expiration, duplicate frames, gaps, slow consumers, oversized frames,
broken stdout, and resumption from an authoritative snapshot. Verify bounded
memory/queues and that provider progress continues with no observer.

## Acceptance and handoff

- [ ] Explicit transcript reads are ordered, bounded, and recoverable by cursor.
- [ ] Empty, unavailable, truncated, and expired states are distinguishable.
- [ ] Content never enters routine telemetry or accidental error dumps.
- [ ] Snapshot-only operation is complete and independently usable.
- [ ] If following ships, replay/gap/backpressure tests prove exact recovery.

Ship snapshot/paging first if event following needs more qualification. Rollback
of follow support must keep snapshots and run receipts usable.
