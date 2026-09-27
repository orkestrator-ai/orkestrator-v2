# 06 — Add bounded keyed-record and manifest storage primitives

Status: Complete. Prerequisite: 01. Findings: E04/E14 infrastructure.

## Outcome and decision

Updating one large record no longer requires reading or rewriting unrelated
payloads. Use private, atomically replaced files plus small versioned manifests
for the first implementation. A manifest is the commit point when a record
references several immutable chunks. This is deliberately a focused primitive,
not a replacement for every JSON store in the application.

## Owners and proposed structure

- [Storage base](../../../../apps/backend/src/core/storage-base.ts): existing
  atomic-write, lock, permissions, backup, and recovery conventions.
- [Storage facade](../../../../apps/backend/src/core/storage.ts) and per-domain
  storage classes remain the public access boundary.
- Proposed internal `keyed-record-store.ts` and `record-manifest.ts` with
  separate test files. Do not enlarge the already large storage/projection files.
- Namespaces under the backend data directory: display-cache records and durable
  pipeline transcript records. Exact directory names become schema constants.

## Record design

Each record has schema version, logical-owner identity, revision, byte length,
checksum, and retention class. Filenames derive from a fixed hash of the full
logical key; the decoded header must still match the requested identity. Hashing
a filename is not authorization. Resolve paths inside the owned namespace and
reject symlink/path traversal substitutions according to existing storage rules.

Use compact JSON for metadata and bounded message chunks. Prefer whole-message
chunks with a documented oversized-single-message fallback rather than cutting
JSON at arbitrary byte offsets. Step 16 owns the durable transcript schema;
step 07 can use one independent tail record without chunking.

## Implementation sequence

1. Implement bounded reads: stat/admission before buffering and a byte-counted
   read that still refuses growth past the cap after stat. Validate checksum,
   schema, owner, and revision. Distinguish missing from corrupt/unreadable.
2. Expose per-key serialized mutation and compare-and-swap revision semantics.
   Different keys may stage payloads concurrently under a small count/byte
   semaphore. Never perform a large payload read while holding the global quota
   metadata lock. Audit reuse of `enqueueWrite`: a global serialization queue
   must not accidentally reintroduce one slow large write blocking all records.
3. Reserve aggregate bytes before admitting a write. Under a short quota lock,
   account for existing size, new size, temporary staging, and retained backups.
   Release reservations on every failure. Admission counts both buffered bytes
   and queued operations; it cannot be an unbounded promise tail.
4. Stage to a unique temporary file, set private permissions, validate the
   candidate, then publish atomically. For durable records, flush the file and
   use the supported directory-durability procedure; document platform-specific
   behavior. Display-cache writes may have a weaker documented loss policy.
5. For chunked records, write immutable chunks first, then publish a manifest
   containing their lengths/checksums and ordered references. Readers take one
   manifest revision; never mix chunks from two revisions. Retain the previous
   committed generation until the new manifest is known readable.
6. Build metadata-only enumeration and bounded startup repair. Reconcile orphan
   temporary/chunk files in batches, with age/grace protection for active
   writers. A missing quota index can be rebuilt from headers without parsing
   every payload; conservatively reserve unknown files until classified.
7. Implement deletion of record generations and sensitive backups. Use a
   deletion/migration marker where a legacy reader could otherwise reimport
   deleted data. Markers themselves need finite lifetime/count/byte bounds:
   retire them only after the legacy source and applicable backups are retired.
8. Add migration helpers with source fingerprint, per-record progress, target
   schema, completion marker, and idempotent retry. Never claim multi-file
   atomicity just because each individual rename is atomic.

## Recovery matrix

| Failure | Required recovery |
| --- | --- |
| Before target payload is complete | Ignore temporary data; old record remains |
| Chunks written, manifest not committed | Old manifest wins; orphan GC later |
| New manifest committed, cleanup interrupted | New record readable; old data cleaned later |
| Corrupt cache payload | Explicit cache miss/degraded result; provider recovery |
| Corrupt durable payload | Recover a validated prior generation or report unavailable |
| Concurrent stale writer | CAS conflict; no overwrite of newer committed revision |
| Delete races migration | Deletion wins; source backup cannot resurrect record |
| Quota index unavailable | Bounded repair or reject admission; never assume zero bytes |

## Tests and acceptance

Use temporary exact-owner directories and fault injection at every stage. Verify
two keys progress independently, same-key ordering, byte reservations, private
permissions, interrupted migration, malicious paths, checksum mismatch, and
deletion across backups. Count payload reads/writes to prove one-record work.

Keep no unbounded index or process-global cache of payload objects. Record
payload and metadata limits separately. Durable data is never automatically
evicted for cache pressure. Publish the internal primitive before migrating
callers; its existence alone changes no production format.

## Execution record

```text
Status: Implemented, validation pending
Implementation commit / PR: branch worktree-agent-a56e0fae6b3366331 (see commit
  "perf(backend): keyed record storage and independent display-tail records")
Protocol or storage decisions: see below
Tests and isolated profiles: focused backend suites (see below); no isolated
  real-stack profile run for this internal primitive
Before/after measurements: structural (operation counts) only; no timing profile
Compatibility/migration result: primitive only; first caller is step 07
Remaining limitations: see below
```

### What was implemented

Modules (all under `apps/backend/src/core/`, each well under 800 lines):

| Module | Responsibility |
| --- | --- |
| `keyed-record-format.ts` | Record file format, filename hashing, bounded pinned reads, private exclusive writes, directory fsync |
| `keyed-record-concurrency.ts` | Per-key serial queue, count/byte staging semaphore with a bounded waiter list, short mutex |
| `keyed-record-index.ts` | Rebuildable metadata index with incremental totals; bounded metadata-only reconciliation |
| `keyed-record-meta.ts` | Small private metadata files (bounded read, atomic publish), tombstone and migration-progress schemas |
| `keyed-record-tombstones.ts` | Durable deletion markers with count/lifetime bounds and an explicit overflow flag |
| `keyed-record-store.ts` | `KeyedRecordStore`: get/put/delete/deleteWhere/list/repair |
| `keyed-record-migration.ts` | Idempotent migration helper with source fingerprint, checkpointed progress, completion marker |
| `record-manifest.ts` | `RecordManifestStore`: immutable content-addressed chunks with a manifest commit point (for step 16) |

Record format: one private file `<sha256(namespace \0 key)>.rec` containing a
single-line compact JSON header (`format`, `schema`, full logical `key`,
small `owner` attributes, `revision`, `byteLength`, sha256 `checksum`,
`retentionClass`, `updatedAt`, optional `accountedBytes`), a newline, then the
payload bytes. The header is capped at 4 KiB by default; payload caps are per
namespace. Metadata lives in `<namespace>/_meta/` (`index.json`,
`tombstones.json`, `migration-<id>.json`).

Key decisions:

- **Reads** are lock-free (publication is by rename): `lstat` admission before
  buffering, `O_NOFOLLOW` open, `fstat` identity pin against the `lstat`, then a
  byte-counted read that refuses growth past the cap. Header schema, key and
  retention class must match the request (a file copied under another key's
  hash is `identity-mismatch`), and length and checksum are verified. Missing
  and each corrupt reason are distinct outcomes. A stat fingerprint lets a
  decoded-value cache revalidate with one `lstat` and no read.
- **Writes** serialize per key in-process (optionally also across processes
  through the injected storage mutation lock, recommended for durable use),
  support create-only (`expectedRevision: null`) and revision CAS, and accept an
  async `fence` evaluated inside the key's critical section before staging and
  again before publish. Different keys stage concurrently under a count (2) and
  byte (2 records) semaphore; the waiter list and queued operations are bounded
  (256) and excess is rejected as `busy`, never queued. `StorageBase.enqueueWrite`
  is **not** used, so a large write never blocks unrelated records.
- **Quota**: a reservation is taken under a short quota lock (in-process mutex
  plus the cross-process lock on `_meta/index.json`) before staging and released
  on every path. Cache namespaces admit on in-flight bytes and evict the least
  recently written records on commit (skipping the key just written and keys
  busy in this process, so one key cannot stall convergence). Durable namespaces
  never evict: committed payload + retained previous generation + unclassified
  bytes + reservations must fit, and admission fails closed when the last
  rebuild was incomplete. No payload is read under the quota lock. Payload and
  metadata limits are separate (`maxPayloadBytes`, `maxHeaderBytes`, index cap
  `maxRecords * 2 KiB + 64 KiB`, tombstones 512 KiB, progress 16 KiB).
- **Staging** uses a unique `O_EXCL|O_NOFOLLOW` temp file, mode `0600`
  (explicit `fchmod`), validates the candidate's header/checksum, then renames.
  Durable records fsync the file, hard-link the committed file as `.prev`
  (copy fallback), rename, and fsync the directory (POSIX; on Windows a
  directory cannot be opened for fsync, so durability rests on the rename).
  Cache records skip both barriers: a crash may lose the newest write or leave
  a torn file that reads report as corrupt and repair deletes.
- **Repair/enumeration** is metadata-only: `readdir` in bounded batches, one
  `lstat` per file, and a bounded header read only when the index entry's stat
  fingerprint no longer matches. Temp files older than the grace window (60 s)
  are removed; younger ones are reserved as unclassified. Unknown files are
  never deleted and are reserved. A `.prev` without a current file (interrupted
  delete) is removed: deletion wins. A lost/corrupt index is rebuilt this way.
- **Deletion** removes the current file, the previous generation and the index
  entry, optionally after writing a durable tombstone first. `deleteWhere`
  filters on index metadata only and makes a second pass after settling
  in-flight key operations, so a write that passed its fence just before the
  enumeration cannot survive. Deletion bypasses the write admission bound.
- **Tombstones** are bounded by count (default 1,024) and lifetime (30 days);
  count pressure sets `overflowed` (a corrupt marker file is also treated as
  overflowed) so a consumer can retire its legacy source instead of trusting an
  incomplete set. `retireAll` is called once the legacy source is gone.
- **Migration helper**: stable enumeration, `null` for explicitly skipped
  invalid entries, create-only CAS per record (a live write always wins),
  tombstone check inside the record's critical section, progress checkpointed
  every N records keyed by source fingerprint and target schema, completion
  marker published after the whole enumeration. It does not claim multi-file
  atomicity; retry is safe because of CAS and tombstones.
- **Manifest store**: chunks are immutable and content-addressed per key
  (`<key stem>-<sha256>.chunk`), written before the manifest; unchanged chunks
  can be referenced (only chunks owned by the key's committed generations are
  accepted) and are neither rewritten nor re-read. The manifest is a keyed
  record whose quota accounts for referenced chunk bytes. Readers take one
  manifest revision and verify each chunk's length and checksum. Chunks of the
  displaced generation are deleted only after the new manifest reads back;
  durable manifests retain one previous generation and fall back to it when a
  current chunk is unreadable (reported as `generation: "previous"`), otherwise
  the record is `unavailable`. `repair()` removes unreferenced chunks after the
  grace window, and never when the manifest scan was incomplete.

### Recovery matrix coverage (fault injection)

`keyed-record-recovery.test.ts` and `record-manifest.test.ts` simulate crashes
with a fault hook that never resolves (the instance is abandoned mid-operation)
and restart with a fresh instance on the same directory:

| Failure | Test |
| --- | --- |
| Before target payload complete | old record returned; orphan temp kept within grace, removed after |
| Published, index not updated | restart reads the new record; repair rebuilds the entry from headers |
| Chunks written, manifest not committed | old manifest wins; repair collects the orphan chunks after grace |
| Manifest committed, cleanup interrupted | new record readable; repair removes old chunks |
| Corrupt cache payload | explicit `corrupt` miss; repair deletes it |
| Corrupt durable payload | validated previous generation returned; both corrupt reports `corrupt`, repair keeps files |
| Interrupted delete | retained generation cannot resurrect; repair removes the orphan `.prev` |
| Concurrent stale writer | CAS conflict across two instances; newer revision kept |
| Delete races migration | tombstone checked in the key's critical section; deletion wins in-flight and across two crash/restart cycles |
| Quota index unavailable | corrupt index rebuilt from headers (admission rejects, never assumes zero); incomplete scan fails durable admission closed |

`keyed-record-store.test.ts` covers private modes, hashed filenames, identity
mismatch, symlinked record and namespace, read bounds and growth past the cap,
CAS and same-key ordering, independent progress of two keys while one is
stalled, eviction by count and bytes, reservation release after a failed
write, admission rejection, fencing, generation-complete deletion, metadata
rebuild without payload reads, and zero neighbour payload work with 1/32/128
records (observer counts).

### Tests run

See the step 07 execution record for the exact commands and results; the
same runs covered these files.

### Remaining limitations

- Reservations are per process. Committed usage is shared through the
  cross-process-locked index, so two backends on one data directory can
  overshoot the cache ceiling by at most their in-flight staging before the
  next commit evicts; durable admission rechecks committed totals under the
  lock but cannot see another process's uncommitted reservation.
- The index is written without fsync (it is rebuildable); a crash can leave
  it stale until the next reconciliation, which every new store instance
  performs before its first quota decision.
- No step-01 timing profile was recorded; evidence is structural
  (operation counts in tests).
