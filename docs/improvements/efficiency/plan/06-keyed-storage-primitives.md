# 06 — Add bounded keyed-record and manifest storage primitives

Status: Not started. Prerequisite: 01. Findings: E04/E14 infrastructure.

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
