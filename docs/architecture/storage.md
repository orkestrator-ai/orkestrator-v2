# Backend storage

The backend's authoritative state lives in one SQLite database,
`orkestrator.sqlite`, in the data directory (`~/Library/Application
Support/orkestrator-v2/` on macOS, `${XDG_CONFIG_HOME:-~/.config}/orkestrator-v2/`
on Linux). It replaced 29 JSON store files (plus one file per public-operation
namespace), their per-file lock files and five-deep backup ladders.

| File | Purpose |
| --- | --- |
| `apps/backend/src/core/storage-database.ts` | `StorageDatabase`: connection, migrations, stores, leases |
| `apps/backend/src/core/storage-stores.ts` | Store registry and layouts, migrations, the legacy JSON import, archive retention and scrubbing |
| `apps/backend/src/core/storage-record-upgrades.ts` | One-shot upgrades of record shapes only older builds wrote |
| `apps/backend/src/core/storage-backups.ts` | Pre-migration and daily snapshots, rotation |
| `apps/backend/src/core/storage-context.ts` | `StorageContext`, the state every store shares: database handle, `loadJson`/`saveJson` routing, `updateStore`, `serialize` (with the lease order), `atomically` |
| `apps/backend/src/core/storage-changes.ts` | `StorageChanges`: resource announcements, the change journal and the revision manifests |
| `apps/backend/src/core/storage-base.ts` | Base of the `StorageService` chain: store names, lease wrappers, and forwarders to its `StorageContext` |
| `packages/protocol/src/node/storage-database.ts` | On-disk format and a read-only reader for Bun scripts |
| `apps/backend/src/core/storage-test-support.ts` | Test helpers: seed, read and inspect stores |

## What stays a file

- `config.json` and `agent-platforms.json`. The Electron main process and the
  toolchain installer read them, and on first run write them, before the
  backend starts. Those run under Node, which has no `bun:sqlite`. They keep
  the atomic-rename writer and backup ladder; `config.json` is written 0600
  because it holds API keys.
- Descriptor files other processes read: `backend-instance.json`,
  `control-mcp.json`, `gateway-auth.json`.
- Design canvases (records, pending operations, history checkpoints, the
  user-facing `.orkdes` exports and their backups): a record can be 6 MiB and
  is rewritten per edit, which a synchronous database write would block on.
  Their cross-process correctness comes from database leases instead: a
  per-canvas lease around every edit, a per-process liveness lease that
  startup recovery consults before interrupting anything, and a change signal
  that makes the library rescan (`design/coordination.ts`).
- Terminal history: up to gigabytes of rolling output appended several times
  a second per terminal, which would churn the database and compete for its
  single write lock.
- MCP management state (`mcp-management/`).
- Blobs: build-pipeline transcript chunks (`build-pipeline-transcripts/chunks/`,
  immutable and content-addressed), web-annotation images
  (`web-annotations/<env>/assets/`), Kanban images, terminal buffers, logs,
  toolchains.

### Engines on the database

These keep their own modules but store their state as database rows:

| Engine | Stores | Notes |
| --- | --- | --- |
| Environment cleanup ledger | `environment-cleanup-ledger` (envelope `entries`), `environment-cleanup-sweeps` | Each step is one `updateStore`; imported by the version 2 import |
| Workflow results | `workflow-results` (envelope `entries`), `workflow-result-tools` | Row-level writes; reads validate one row; fails closed on an invalid store; 64 MiB of row bytes |
| Native display tails | `native-agent-display-tail-records` (one row per session, owner = environment) | LRU eviction inside the put transaction (128 rows, 64 MiB); old cache files are deleted, not imported. Checkpoint policy: [native-transcripts.md](native-transcripts.md#restart-previews-display-tails) |
| Build-pipeline transcripts | `build-pipeline-transcripts/manifests` (one row per session, owner = pipeline), `/totals`, `/legacy-manifest-migration` | Chunks are written and fsynced first; the manifests commit in the same transaction as the pipeline record; old `.rec` manifests import in the background |
| Web annotations | `web-annotations/<environmentId>` (envelope: annotations, captures, entries, requests, results, assets metadata, receipts, drafts, records, meta) | Each commit is one transaction that reloads whatever another backend committed; old JSON is imported lazily per environment |
| Compatibility-path usage | `compatibility-path-usage` (document: per path id, a count and the first and last use) | Counts are merged at most once a minute, on read and at shutdown, in one transaction; content-free ([version-compatibility.md](version-compatibility.md#usage-counters)) |
| Host maintenance | `host-maintenance` (document: the current or last update job, the pending check request, the last check) | Each change is one transaction; a job left in progress by the previous process is settled at startup from the running version, never resumed |
| Agent usage history | `usage-history` (one row per agent session, owner = environment) | Each recorded turn is one `updateStoreRow`; reports walk every row uncached and never prune (retention is swept from the write path); day buckets past 400 days and the least recently used rows above 20,000 are pruned hourly. Turn ids are scoped by provider session, because a row outlives the conversation in its tab. A turn is bucketed by the day its bridge finalized it (`NativeAgentTurnUsage.at`), falling back to the day it was first seen. Rows outlive the environment they came from and are deleted only on request |

Large engines read and write through `database.rows(store)`, an uncached
row API, so they never hold a whole store in memory; the cached APIs stay
correct because every row write bumps the store's revision.

## Stores and layouts

A store is named by the JSON path it replaced, without `.json` (`kanban`,
`public-operations/index`). `storage-stores.ts` maps each store to a layout:

| Layout | Persisted as | Used for |
| --- | --- | --- |
| `document` | One JSON value | Small settings-like stores (catalogue, journal, accounts, auth) |
| `array` | One row per item, keyed by `id` (or a named field), order kept | Projects, environments, sessions, Kanban, feature plans, notes, comment records |
| `record` | One row per key | Native sessions, prompt queues, drafts, handoffs, reviews, pipelines, pane layouts |
| `envelope` | A document plus named record collections as rows | Agent mail (mailboxes, idempotency, counterparts), coordinators, catalogue, preview services |

Business code still reads and writes a store's whole logical value through
`loadJson`/`saveJson`. The database writes only rows whose serialized value or
position changed, so a mail send rewrites one mailbox row instead of up to
32 MiB of JSON. A write that changes nothing is skipped and does not bump the
revision. An array that cannot be keyed (a duplicate or missing key) is stored
whole as a document; the row layout returns on the next keyable write.

Rows carry an optional indexed `owner` (`projectId` for environments and
Kanban, `environmentId` for sessions). `loadStoreRowsByOwner` reads one
project's board or one environment's sessions without assembling the store,
and `loadStoreRow` reads one row by key the same way.

Each store row records its layout, so `assembleStoredValue` rebuilds the value
without the registry. Scripts use `readStorageDatabaseStore`, which opens the
database read-only and never migrates.

## Concurrency

`bun:sqlite` is synchronous and its busy handler blocks the event loop, so **a
SQLite transaction is never held across an `await`**. Four primitives follow
from that.

- **`updateStore(file, fallback, mutate)`**: a synchronous read-modify-write in
  one `BEGIN IMMEDIATE` transaction. SQLite's write lock serializes it across
  every connection and process; no lease or queue is involved. Use it whenever
  the mutation does not await (sessions, project notes, feature plans,
  completion comments).
- **`updateStoreRow(file, key, mutate, { collection })`**: the same for one row
  of a `record` store or of one `envelope` collection. It neither parses nor
  rewrites the other rows, so a write costs O(row) and holders of different
  keys' leases cannot overwrite each other.
- **`serializeMutation(target, description, operation, options)`**: an
  asynchronous critical section. An in-process FIFO per target plus a
  cross-process **lease** in the `leases` table (owner token and heartbeat;
  stale after `staleMs`, default 15 s; acquisition times out after
  `acquireTimeoutMs`, default 20 s). The claim-or-reclaim check is one
  transaction, so two waiters cannot both take a stale lease. Lease names are
  data-dir relative (`environments.json`,
  `project-creation-locks/<sha256>`). The `enqueue*Mutation` methods are thin
  wrappers over it. Three leases are deliberately held across external I/O
  and size their timeouts for it: native agent sessions (provider create and
  send, 180 s acquire), project creation (Git and `gh`, 90 s stale and 660 s
  acquire) and GitHub completion comment posting.

  Native agent sessions take **one lease per session key**
  (`native-agent-session-leases/<sha256(key)>`), and every write under it is a
  single-row `updateStoreRow`, so a slow provider call for one session never
  stalls another. Order: the service's per-key work fence, then the session
  lease, then leaf leases (prompt queue, display tails); never hold two
  session leases at once. Deleting an environment's sessions takes each key's
  lease in turn, and inserts check the environment's deletion tombstone inside
  their commit, so a create that overlaps the deletion cannot leave a record
  behind. Lease rows whose holder stopped heartbeating an hour ago are purged
  at start-up.

  Looped and Multi Review workflows keep **one lease per store for writers**:
  a save awaits its environment check, and launch and the environment sweep
  scan every workflow. Each write is still a single-row `updateStoreRow` that
  re-checks the controller fence and revision inside its own transaction.
  Reads, including the controller fence check a supervisor runs around
  nearly every provider call, read one row with `loadStoreRow` and take no
  lease. A lease held for a read is released before the caller acts on the
  answer, so it would cost two write transactions per check and protect
  nothing; the commit's own check is what stops a controller that lost its
  lease.
- **`atomically(operation)`**: buffers every database-store write and delete
  made inside it and commits them in one transaction. Resource announcements
  made inside are published only after that commit. Reads inside see the
  buffered state. Use it for pure storage work spanning stores (today only the
  public-operation namespace retirement in `collectPublicOperations`). Never
  wrap work that must be durable *before* an external side effect, such as a
  native `pendingDispatch` written before the provider send.

`saveJson` and `saveSensitiveJson` write a store's complete value as a row diff
against the rows committed at that moment, so they belong inside a lease taken
for that store, and every such writer of the store must hold the same lease. A
lease only excludes other holders of it. A store therefore has one kind of
writer: either leased whole-value saves or `updateStore`/`updateStoreRow`
transactions, never both, because a leased save would silently revert or delete
rows that an unleased transaction committed after the save's read. An
`updateStore` inside `atomically` counts as a whole-value write, since the scope
buffers the value and commits it whole, and so does `deleteStore`. Each write,
helper call and `atomically` call on the way must be awaited or returned inside
the lease, and a lease taken inside `atomically` does not count, because the
scope commits after it is released. `storage-writer-guards.test.ts` parses the
`StorageService` chain and enforces all of this per store, following private,
protected and `#private` helpers to every caller, with no exceptions; a write
it cannot follow fails.
The primitives are implemented on `StorageContext` (`storage-context.ts`,
whose `serialize` also records the lease order) and the chain reaches them
only through `StorageBase`'s forwarders of the same names. The guard fails a
layer that touches `this.context` directly, and any class other than
`StorageBase` that names `StorageContext`, so a repository that takes the
context has to be added to the scan first.

Whole-store reads are cached per store and revalidated against the committed
revision on every read (one indexed lookup), which also observes other
processes' writes. Keyed reads and mutations fetch only their named row even
on a cold connection or after another process writes; keyed mutations invalidate
any whole-store cache after commit. A keyed read on a connection that already
caches the store at the committed revision takes its row from that cache and
fetches nothing; a miss does not fill the cache. Legacy document representations retain the
whole-document fallback. `getResourceSnapshotRevision` hashes the database
identity and that revision.

Reads are charged to the innermost recurring job by what the caller got, not
by where the rows came from, so an extra read shows however warm the cache
is. Decoding a whole store, one owner's rows or one row is a `storage-read`,
even when the cache serves it, because a cached whole-store read still parses
every row. A revision check that lets a caller reuse values it already decoded
is a `storage-stat`. That covers a write diffing against cached rows, row-size
accounting, the build-pipeline control-record cache and the remaining file stat
cache, and a hit in the workflow-result entry index. Every query through the
uncached `StorageDatabase.rows()` that returns rows or keys (display tails,
build-pipeline transcript manifests, deletion fences, web annotations,
artifact grants) is a `storage-read`; its writes charge nothing there. Every
connection `openBackendDatabase` opens reports this way, not only
`StorageService`'s. Content fetched from the database (a cache miss's whole
store, a single-row or owner query, a `rows()` read) also charges its
serialized length as `bytes` (`observeFetch`), so a cache miss shows bytes
beside its read while a cache-served read shows none. Blob files outside the
stores (terminal session buffers, Kanban images) are `file-read`s.

Several backends may share a data directory (the desktop app and `orkestrator
serve` default to the same one). WAL lets them read concurrently, and the
primitives above serialize their writes.

## Durability and deletion

- WAL with `synchronous = FULL`: a committed write survives a crash, and a
  torn write is impossible.
- `secure_delete = ON` zeroes the freed pages of deleted content.
  `scrubDeletedDatabaseContent()` (called where the JSON stores used to scrub
  their backups) returns up to 16 MiB of freed pages to the filesystem
  (`auto_vacuum = INCREMENTAL`, set when the database is created) and runs a
  truncating WAL checkpoint so old frames do not keep the content either.
  `storageFilesContain(dataDir, marker)` checks this in tests.
- The database file is 0600; SQLite gives `-wal` and `-shm` the same mode.

### Snapshots

WAL covers crashes and torn writes, not a bad migration, a bug that deletes
data or damage to the file. `storage-backups.ts` keeps snapshots in
`<dataDir>/backups/` (0700, files 0600), each a consistent `VACUUM INTO` copy
verified with `quick_check` before it is renamed into place:

- `pre-migration-v<from>-<stamp>.sqlite` before an existing database is
  migrated to a newer schema (a failed snapshot aborts the open instead of
  migrating unprotected); the newest two are kept.
- `hourly-<stamp>.sqlite`, checked a minute after start-up and every five
  minutes, taken when the newest is an hour old **and** the content changed
  since it: any store's revision, the deletion bookkeeping in `storage_meta`
  or the schema version. Lease heartbeats and writes that change nothing do
  not count. A failed hourly snapshot only logs.
- Rotation keeps the newest six hourly snapshots plus one a day as it ages
  (each the first taken a day or more after the previous one), from the
  youngest at least three days old onwards. So there is always a copy about a
  day old and one about three days old; the one about two days old in between
  is what becomes the next three-day copy. At most about ten files.
- Anything older than seven days is deleted. That is also the privacy cost:
  content deleted from the live database can survive in a snapshot until it
  ages out.

Restore: stop the app, replace `orkestrator.sqlite` with a snapshot and delete
`orkestrator.sqlite-wal` and `-shm`. Snapshots are off by default under the
test runner (`new StorageService(dir, { snapshots: true })` turns them on).

## Migrations

`StorageDatabase` applies numbered migrations in one `BEGIN EXCLUSIVE`
transaction and records the version in `PRAGMA user_version`. A database
newer than the build refuses to open (`StorageDatabaseVersionError`) instead
of being written by older code. Add a migration to `STORAGE_MIGRATIONS` in
`storage-stores.ts` with the next version; it must be synchronous.

A database only ever holds data written by this build or a newer one (a newer
database refuses to open; older builds never open it). So an older record
shape, which can only arrive through the legacy import, is upgraded **once**
by a migration (`storage-record-upgrades.ts`, version 3: native-session
version/origin/policy, Codex-named coordinator bridge fields, first-generation
prompt-queue dispatch errors) and its readers have no legacy branch. Readers
that default or normalize values current writers may still omit (environment
setup phase, agent settings, mail defaults) stay where they are. Only shapes
no current writer can produce belong in an upgrade migration.

Version 4 (`change-tracking/ledger-schema.ts`) adds the change-tracking
ledger: the first engine with its own indexed tables (worktrees, evidence,
snapshots, turn boundaries, measurements, selections, outbox, restore
records) because its queries need joins and range scans. Its file contents
live under `<dataDir>/change-tracking/` (a content-addressed object store and
evidence bodies), so a backup of change history must include that directory
as well as `orkestrator.sqlite`. See [change-tracking.md](change-tracking.md).

### Version 2: legacy JSON import

On the first open of a data directory, every legacy store file is imported:

1. The primary file, else the newest readable `.bak.1`…`.bak.5`.
2. A file that exists but that neither it nor any backup can repair is carried
   over as an unreadable document. Lenient readers then treat it as absent, as
   before. Pane-layout reconciliation reports it unavailable, and the
   public-operation ledger refuses admission, so corruption is never mistaken
   for an empty store.
3. A file that cannot be read at all (`EACCES`, `EIO`) fails the open, and
   nothing is committed. The import retries on the next start.

After the commit, the files and their backup, lock and temp siblings move to
`legacy-json/<timestamp>/` (0700) and are deleted after 14 days. A JSON store
file that appears later is never imported. An older backend still running
against the directory would write one; it is archived on the next open with a
warning.

Downgrading after the import leaves the older build without its JSON files.
Restore them from `legacy-json/` within the retention window if needed.

The archive stays that pre-migration copy, except that deletes reach it:

- A sensitive save (`saveSensitiveJson`) that removes nothing leaves
  `legacy-json/` byte-identical.
- A save that removes content prunes only that content from every archived
  copy and keeps the rest as archived (`pruneRemovedContent` in
  `storage-stores.ts`). Removed content means a record key that is gone, an
  array item with no counterpart, or a value cleared to `null`. Array items
  are matched by `id`, else by equal content, so an item without an `id` that
  was edited in place counts as removed.
- `deleteStore` removes every archived copy of the store.
- Deleting boundaries that know exactly what they removed (environments,
  drafts, handoffs, prompt queues, reviews, build pipelines) scrub with an
  attributable predicate through `scrubSensitiveJsonBackups` or
  `scrubLegacyJsonStore`. Writes through `updateStore` or `updateStoreRow`
  never touch the archive, so a delete made that way must scrub explicitly.

## Testing

Use `storage-test-support.ts` rather than writing files into a data directory:
`seedStore`, `seedUnreadableStore`, `readStoredValue`, `hasStore`,
`deleteStoredValue` and `storageFilesContain`. To exercise the import and the
one-shot upgrades, write legacy files into a directory without a database
(`writeLegacyStore`) or copy a live one out in an older shape
(`exportStoresAsLegacyJson`). Each opens its own connection,
which behaves like another backend process. To simulate another backend
holding a lock, acquire its lease from `openBackendDatabase(dataDir)`; to
simulate a crashed holder, set its `heartbeat_at` to 0.
