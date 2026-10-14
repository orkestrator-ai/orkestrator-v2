# Backend storage

The backend's authoritative state lives in one SQLite database,
`orkestrator.sqlite`, in the data directory (`~/Library/Application
Support/orkestrator-v2/` on macOS, `${XDG_CONFIG_HOME:-~/.config}/orkestrator-v2/`
on Linux). It replaced 29 JSON store files (plus one file per public-operation
namespace), their per-file lock files and five-deep backup ladders.

| File | Purpose |
| --- | --- |
| `apps/backend/src/core/storage-database.ts` | `StorageDatabase`: connection, migrations, stores, leases |
| `apps/backend/src/core/storage-stores.ts` | Store registry and layouts, migrations, the legacy JSON import, archive retention |
| `apps/backend/src/core/storage-record-upgrades.ts` | One-shot upgrades of record shapes only older builds wrote |
| `apps/backend/src/core/storage-backups.ts` | Pre-migration and daily snapshots, rotation |
| `apps/backend/src/core/storage-base.ts` | `StorageService` primitives: `loadJson`/`saveJson` routing, `updateStore`, `serializeMutation`, `atomically` |
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
  that makes the library rescan (`design-coordination.ts`).
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
| Native display tails | `native-agent-display-tail-records` (one row per session, owner = environment) | LRU eviction inside the put transaction (128 rows, 64 MiB); old cache files are deleted, not imported |
| Build-pipeline transcripts | `build-pipeline-transcripts/manifests` (one row per session, owner = pipeline), `/totals`, `/legacy-manifest-migration` | Chunks are written and fsynced first; the manifests commit in the same transaction as the pipeline record; old `.rec` manifests import in the background |
| Web annotations | `web-annotations/<environmentId>` (envelope: annotations, captures, entries, requests, results, assets metadata, receipts, drafts, records, meta) | Each commit is one transaction that reloads whatever another backend committed; old JSON is imported lazily per environment |

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
project's board or one environment's sessions without assembling the store.

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
- **`atomically(operation)`**: buffers every database-store write and delete
  made inside it and commits them in one transaction. Resource announcements
  made inside are published only after that commit. Reads inside see the
  buffered state. Use it for pure storage work spanning stores (the prompt
  queue to compose-draft transfer, the public-operation namespace retirement).
  Never wrap work that must be durable *before* an external side effect, such
  as a native `pendingDispatch` written before the provider send.

Reads are cached per store and revalidated against the committed revision on
every read (one indexed lookup), which also observes other processes' writes.
`getResourceSnapshotRevision` hashes the database identity and that revision.

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
- `daily-<stamp>.sqlite`, checked a minute after start-up and every six hours,
  taken when the newest is a day old; the newest three are kept. A failed
  daily snapshot only logs.
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
