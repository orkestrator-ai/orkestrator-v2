# Legacy prompt-queue claim state

Updated 2026-10-27 after review of the claim retirement.

The prompt-queue claim commands (`claim_prompt_queue_head`,
`acknowledge_prompt_queue_claim`, `reject_prompt_queue_claim`,
`requeue_prompt_queue_message`) were removed on 2026-10-24 by
[0034-mixed-version-compatibility.md](0034-mixed-version-compatibility.md).
Backends up to v2.28.0-beta still expose them and can share this schema's
store. The absence of published renderer callers does not rule out an active
external claim holder, so lease exclusion must remain while those peers can
share the store.

## Current state

- `restoreLegacyPromptQueueClaims` (`storage-record-upgrades.ts`) runs on every
  prompt-queue load, including claims written by a peer after startup. Reads
  do not write the store or increment queue revisions.
- A claim with a message record, nonblank token, readable claim timestamp and
  future expiry is retained verbatim. Queue writes, including writes to an
  unrelated queue, preserve its token and message so the old holder can
  acknowledge or reject it. No new claim commands or writers are introduced.
- Live claims block dispatch and steering reservations, native and tmux queue
  drains, and tmux mail submission. Enqueue deduplicates against the held id.
  A stale whole-list save cannot insert a copy of that id or tombstone it.
- At expiry, or with malformed lease metadata, the message returns to the
  head and replaces any queued copy of the same id. A missing, blank or
  non-string id receives a deterministic recovery id derived from the message
  fingerprint, preserving the body and attachments without blocking the head.
  A claim without a message record is dropped without losing the queue tail.
- The next queue mutation persists the normalized shape. Native keyed
  scheduling keeps a sole live claim due for progress checks, so its expiry
  does not depend on a renderer, a notification or broad discovery.
- Expiry retains the previous recovery semantics: the drainer reserves the
  restored head through the ordinary durable dispatch path. It does not prove
  that an expired holder never submitted; downstream request receipts and tmux
  ambiguity handling retain their existing responsibilities.

## Decisions

The original proposal restored every claim immediately, even during a live
lease, based on the absence of published renderer callers. Review identified
that an external caller of an older backend's command can still hold the
prompt. That assumption did not justify removing exclusion. Live leases now
remain protected until settlement or expiry; only the claim-writing commands,
standalone recovery timer and old usage counter remain retired.

No schema version bump is needed. A bump would prevent supported mixed
versions and downgrades from opening the store. Per-load normalization also
covers claims that another backend writes while this one is running.

The compatibility register retains this read path until claim-writing peers
cannot share the database. There is no new recovery counter: normalization is
a read and counting reads would not count recovered claims.

## Regression coverage

- `storage-record-upgrades.test.ts`: expiry restoration, same-id replacement,
  live claim identity preservation, malformed records, stable repaired ids,
  immutable inputs and unchanged claim-free stores.
- `storage-prompt-queues.test.ts`: live lease preservation through queue edits,
  exact-expiry reservation, startup and runtime peer writes, enqueue dedupe,
  malformed lease metadata and deletion.
- `native-agent-prompt-queue-dispatcher.test.ts`: a separate backend connection
  holds and acknowledges a live claim while this backend loads, normalizes an
  unrelated queue and drains; only the holder submits, including after the
  original expiry. Recurring `listAllPromptQueues` scans dispatch expired and
  malformed-id claims once and leave no stuck head.
- `storage-prompt-queue-idempotent.test.ts`: retry dedupe, fingerprint conflicts,
  stale-save exclusion, tombstone protection and steering refusal.
- `native-agent-queue-scheduling.test.ts`: a sole legacy claim remains due.
- `prompt-queue-drainer.test.ts`: tmux drains and mail respect a live holder.

## Related

- [0034-mixed-version-compatibility.md](0034-mixed-version-compatibility.md)
- [version-compatibility.md](../../architecture/version-compatibility.md)
- [storage.md](../../architecture/storage.md#migrations)
