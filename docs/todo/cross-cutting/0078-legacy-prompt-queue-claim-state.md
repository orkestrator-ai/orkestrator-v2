# Legacy prompt-queue claim state

Checked against `main` at `8454d18b` plus the 0034 branch (2026-10-24).

The prompt-queue claim commands (`claim_prompt_queue_head`,
`acknowledge_prompt_queue_claim`, `reject_prompt_queue_claim`,
`requeue_prompt_queue_message`) were removed on 2026-10-24 by
[0034-mixed-version-compatibility.md](0034-mixed-version-compatibility.md). No
client had called them since at least 2026-08-01. Releases up to v2.28.0-beta
still have them, and such a backend can share a data directory with a newer
one, so the claim state they wrote is still read. This file owns retiring that
read.

## Current state

- Nothing writes `PersistedPromptQueue.outstandingClaim` any more.
- It is still read: storage validation drops a record with a malformed claim
  (`storage-shared-records.ts`), `reservePromptQueueHeadForDispatch` refuses to
  reserve while a claim is outstanding (`storage-prompts.ts`), enqueue dedupes
  against the claimed id, web-annotation dispatch and `native-agent-service.ts`
  treat a claimed prompt as queued, and `recoverExpiredPromptQueueClaims`
  (`storage-prompt-queue-store.ts`) puts an expired claim's prompt back at the head at
  startup and on a lease timer.
- Each restored claim counts as `prompt-queue.legacy-claim-recovered`
  ([version-compatibility.md](../../architecture/version-compatibility.md#usage-counters)).

## Outstanding work

### Code

1. **Retire the claim read once the window allows.** When the floor of the
   support window is at or above the first Stable release without the claim
   commands (the first Stable after v2.28.0-beta; the floor reaches it 60 days
   after that release is published), replace the reads above with one record
   upgrade in `storage-record-upgrades.ts` that restores any stored claim's
   prompt to the head of its queue, then drop the field, the recovery timer
   and their tests. Check the counter on reachable machines first. Done when
   no code reads `outstandingClaim` except that upgrade.

## Constraints and rationale

- Restoring the prompt to the head is what the lease expiry always did, so the
  record upgrade changes no behaviour. It must never dispatch the prompt
  directly: an older renderer may already have sent it.

## Open questions

None.

## Needs verification

None.

## Related

- [0034-mixed-version-compatibility.md](0034-mixed-version-compatibility.md)
- [`version-compatibility.md`](../../architecture/version-compatibility.md)

## Replaces

Nothing; split out of 0034 on 2026-10-24.
