# 07 — Move display tails to independent records and bounded checkpoints

Status: Not started. Prerequisite: 06. Finding: E04.

## Outcome

Reading/writing a tail touches that tail and small metadata only. Continuous
streaming produces a recent restart preview within a documented maximum age.
The preview remains explicitly non-authoritative for actions and history
completeness.

## Owners

- [Display-tail schema and stripping](../../../../apps/backend/src/core/native-agent-display-tails.ts).
- [Storage methods](../../../../apps/backend/src/core/storage-native.ts).
- [Projection scheduling and shutdown](../../../../apps/backend/src/core/native-agent-service-projection.ts).
- Existing display-tail, storage-native, progressive, and lifecycle test owners.

## Implementation

1. Keep the public storage methods and logical keys stable. Implement them using
   step 06 with 512 KiB per-record, 128-record, and 64 MiB compact-data ceilings.
   Account temporary and backup disk usage separately. Cache validated decoded
   tails by record revision within an explicit memory/count bound.
2. Keep the existing payload stripping, checksum, history-completeness, and
   message-window rules. A cache miss is not evidence that the session has no
   transcript. Deferred detail references in a restored preview remain hints
   until the current provider/generation confirms or replaces them.
3. Store eviction metadata independently of payloads. Update changed byte totals
   incrementally; use timestamps/revisions to choose victims without serializing
   every tail. One key must not prevent global eviction from converging.
4. Replace timer reset on every update with per-key dirty state, a quiet-period
   deadline, and a maximum checkpoint deadline. Start with the existing 2-second
   quiet period and a proposed 10-second maximum age for evaluation; document
   any adjusted value from step-01 disk/latency results. One pending latest value
   per key is enough; never enqueue every intermediate tail.
5. Use a small shared write scheduler with count/byte admission. If an update
   arrives during a write, mark dirty and issue one trailing write. Capture the
   session identity/generation and reject stale completion after deletion or
   session replacement.
6. On shutdown, stop accepting new dirty entries before bounded draining.
   Attempt the newest pending tail once per key; if the deadline expires,
   report aggregate skipped counts and rely on provider recovery. Do not block
   exit indefinitely for a display cache or cancel running agents to flush it.
7. On explicit deletion, fence in-flight writers and delete current record,
   prior generations, and any legacy copies under the migration protocol.
   Remove scheduler entries so a late timer cannot recreate the tail.

## Migration

Read v1/v2 legacy tails using their existing validators. On first migration,
process the shared file in a bounded offline/background pass and write each
valid target record. Publish the completed migration marker after enumeration.
Until then, a missing target may fall back to the legacy record unless tombstoned.
Do not reread the whole legacy file on every request: share one bounded import
operation and allow the provider to supply the foreground preview if import is
still running. Oversized/corrupt cache input may be skipped explicitly.

After successful verification, retire the legacy cache and its sensitive
backups according to the cache retention policy. Do not dual-write it forever.
Downgrading may lose only the restart preview, not provider conversation data;
test that older code treats the absent cache as a cache miss. Do not enable
legacy fallback after a completed migration/deletion.

## Validation

- Update/read one key with 1/32/128 records; unchanged neighbors have zero payload
  reads/checksum computations/writes during steady state.
- Stream continuously beyond the maximum checkpoint interval; restart and check
  preview age, then authoritative state/transcript recovery.
- Race update, eviction, shutdown, deletion, and provider generation replacement.
- Crash halfway through import; restart twice and prove idempotence and no
  resurrected deleted records.
- Verify no approvals, credentials, inline tool results, or excluded attachment
  bytes enter persisted tail records or backups.

Ship storage migration and scheduler changes as separate PRs if useful. Both
need to land before E04 is marked resolved.
