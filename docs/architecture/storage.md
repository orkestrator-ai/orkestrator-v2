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
| `apps/backend/src/core/storage.ts` | `StorageService`, the facade every caller uses: forwarders, plus area fields typed as a `Pick` of one repository |
| `apps/backend/src/core/storage-repositories.ts` | `StorageRepositories`, which builds every repository over one context |
| `apps/backend/src/core/storage-files.ts` | `StorageFiles`: the paths of shared stores and of the files beside the database |
| `apps/backend/src/core/storage-<area>.ts` | One repository per store group (`ProjectsRepository`, `KanbanRepository`, …; see [Code layout](#code-layout)) |
| `apps/backend/src/core/storage-shared.ts` | The record types and pure helpers every repository shares, re-exported from `storage-shared-core.ts` (base guards, record types, protocol names) the topic modules `storage-shared-<topic>.ts` (pane layouts, agent activity, persisted records, native sessions, model catalogues, config normalisation) and `storage-shared-extra.ts` (OpenCode catalogues, the storage error classes) |
| `packages/protocol/src/node/storage-database.ts` | On-disk format and a read-only reader for Bun scripts |
| `apps/backend/src/core/storage-test-support.ts` | Test helpers: seed, read and inspect stores |

## Code layout

`StorageService` (`storage.ts`) is a facade with no base class. Callers
(mostly through `CommandContext.storage`) reach a store in one of two ways:

- a public method of the facade, which forwards to the repository that owns
  the store (`storage.loadEnvironments()`);
- an area field, typed as a `Pick` of one repository's entry points and
  holding that repository (`storage.kanban.addKanbanTask()`, where
  `KanbanStorage = Pick<KanbanRepository, "addKanbanTask" | …>`).

The area fields are `kanban` (`KanbanStorage`), `coordinators`
(`CoordinatorsStorage`), `publicOperations` (`PublicOperationsStorage`),
`nodes` (`NodesStorage`), `previewServices` (`PreviewServicesStorage`) and
`agentAccounts` (`AgentAccountsStorage`). Each area type is declared next to
its repository and re-exported from `storage.ts`, and lists only the methods
code outside the storage files calls; a consumer that needs a few of them
takes `Pick<KanbanStorage, "listAllFeaturePlans">` (or a nested
`{ coordinators: Pick<CoordinatorsStorage, …> }` beside facade methods) rather
than the whole service. New areas follow the same shape; the remaining
forwarders move to areas as their callers are narrowed. The facade itself only
opens and closes the database, runs the start-up steps (`init`) and exposes
the change journal.

| Repository | File | Stores |
| --- | --- | --- |
| `ProjectsRepository` | `storage-projects.ts` | Projects, environments, project removal fences, the project-creation lease |
| `ConfigRepository` | `storage-config.ts` | `config.json`, `agent-platforms.json`, model catalogues |
| `SessionsRepository` | `storage-sessions.ts` | Sessions, pane layouts |
| `ReviewsRepository` | `storage-reviews.ts` | Looped and Multi Review workflows |
| `NativeAgentSessionsRepository` | `storage-native.ts` | Native agent sessions: records and their lease, owners, controls and resume identity, the interaction journal, display tails, turn outcomes and interrupts |
| `NativeAgentDeliveries` | `storage-native-deliveries.ts` | The dispatch and steer journals on a session record, and a queued steer's reservation and settlement in the prompt queue |
| `PromptQueueStore` | `storage-prompt-queue-store.ts` | The prompt-queue lease, load and save, and recovery of claims older backends left |
| `PromptsRepository` | `storage-prompts.ts` | Prompt-queue operations for dispatch, the compose-draft lease |
| `BuildPipelinesRepository` | `storage-build-pipelines.ts` | Build pipelines and their transcripts |
| `DraftsRepository` | `storage-drafts.ts` | Compose and file drafts, agent handoffs, session buffers, and the session and pane-layout edits they make |
| `AgentMailRepository` | `storage-agent-mail.ts` | Agent mail: sending, replies, per-message state, conversations, deletion and retention |
| `AgentMailboxDirectory` | `storage-agent-mail-directory.ts` | Mailbox synchronisation from pane layouts and coordinators, descriptors and snapshots, mailbox policy |
| `AgentMailInjects` | `storage-agent-mail-injects.ts` | Inject scheduling: the pending queue, claim and settle, retries and verification, delegation and stored-mail holds |
| `AgentMailBudgets` | `storage-agent-mail-budgets.ts` | Routed mail budgets: pair loop budget and hourly limit, resets, releases and the held-mail notice |
| `KanbanRepository` | `storage-kanban.ts` | Kanban, project notes, feature plans, Linear and GitHub completion comments |
| `PreviewServicesRepository` | `storage-preview-services.ts` | Preview services and settings, the backend profile and identity |
| `NodesRepository` | `storage-nodes.ts` | Command-node stores |
| `PublicOperationsRepository` | `storage-public-operations.ts` | The public-operation ledger, and the project and config writes it admits |
| `CoordinatorsRepository` | `storage-coordinators.ts` | Coordinator workspaces and workflow associations |
| `AgentAccountsRepository` | `storage-agent-accounts.ts` | The provider account registry |
| `ScheduledJobsRepository` | `storage-scheduled-jobs.ts` | Adapts the scheduled-job engine to the shared context; the engine owns its single-row writes |
| `PermissionRulesRepository` | `storage-permission-rules.ts` | Adapts the permission-rule store ([permission-rules.md](permission-rules.md)) to the shared context; the store owns its row transactions |

A store written by more than one repository is written under the same lease
by each, or only through transactions; the guard checks that per store. The
four agent mail classes share one `AgentMailStore`
(`storage-agent-mail-store.ts`): the `agent-mail.json` lease (`enqueue`), its
load and its size-checked save, plus the pure helpers on the persisted shape.

Every repository takes the one `StorageContext` (`this.context`), the
`StorageFiles` path helpers (`this.files.kanbanFile()`) and the
`StorageRepositories` registry (`this.repos.projects`), and keeps only what it
uses. Repositories call each other through the registry, which is how the
paths that cross stores work: project removal deletes compose drafts
(`this.repos.drafts`), session removal deletes the session buffer, public
operations write projects and environments under those stores' leases
(`this.repos.projects.enqueueEnvironmentMutation`). A lease
wrapper (`enqueueEnvironmentMutation`, `enqueueConfigMutation`, …) lives in
the repository that owns its store, with its target, label and timeout
unchanged.

Nothing outside the `storage*.ts` files names a repository, the registry or
`StorageContext` (callers name the area types instead);
`storage-writer-guards.test.ts` checks both. Tests that need
a primitive or a repository helper the facade does not expose use
`storageInternals(storage)` or `storageDatabase(storage)` from
`storage-test-support.ts`.

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
| Scheduled jobs | `scheduled-jobs` (one row per schedule, owner = the owner key) | Every write is one `updateStoreRow`, which is also the exactly-once fire claim across backends; bounded history inside the row; an environment's agent schedules are deleted with it ([scheduled-jobs.md](scheduled-jobs.md)) |
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
- **`serialize(target, description, operation, options)`**: an
  asynchronous critical section. An in-process FIFO per target plus a
  cross-process **lease** in the `leases` table (owner token and heartbeat;
  stale after `staleMs`, default 15 s; acquisition times out after
  `acquireTimeoutMs`, default 20 s). The claim-or-reclaim check is one
  transaction, so two waiters cannot both take a stale lease. Lease names are
  data-dir relative (`environments.json`,
  `project-creation-locks/<sha256>`). The `enqueue*Mutation` methods of the
  repositories are thin wrappers over it. Three leases are deliberately held across external I/O
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
scope commits after it is released. `storage-writer-guards.test.ts` parses
`StorageService` and every class it reaches through a typed field (the
registry, `StorageFiles` and every repository) and enforces all of this per
store, with no exceptions; a write it cannot follow fails. It resolves each
call through the declared types of the fields on the way
(`this.repos.projects.saveEnvironments()`, `this.context.saveJson()`), and
follows every repository method, whatever its visibility, to all of its
callers. The entry points are the facade's public methods and the members its
area fields pick; a public facade field that is not such a `Pick` (a whole
repository, or a copy of a private field) fails the scan, as does a `Pick` of
a name the repository does not have publicly.
The primitives are implemented on `StorageContext` (`storage-context.ts`,
whose `serialize` also records the lease order). The guard fails a class
that holds a `StorageContext` without the facade reaching it, a scanned class
that uses `this.context` as a value outside a constructor, a scanned class
that extends another, and any backend code outside the storage files that
names `StorageContext` or a repository.

Engines with stores of their own (workflow results, the cleanup ledger,
display tails, web annotations, transcript artifacts, usage history, design
signals, …) write through `StorageDatabase` directly, outside that scan. The
same test resolves the store each of those writes names, through constants,
template literals, small name functions (`webAnnotationStoreName`),
constructor-set fields and row helpers that take the store as a parameter,
and fails a write whose store it cannot name or that a repository also
writes. The import and record upgrades in `storage-stores.ts` and
`storage-record-upgrades.ts` are exempt: they run inside the migration
transaction at open, before any writer.

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

One upgrade cannot run once: a backend up to v2.28.0-beta shares this schema
version and can still write a prompt-queue claim (`outstandingClaim`). So
`restoreLegacyPromptQueueClaims` (`storage-record-upgrades.ts`) runs on every
load of the prompt queues (`loadPromptQueues`): live leases retain exclusion
and survive queue writes until settlement or expiry. Expired or malformed
leases restore their message to the head, and the next save persists that.
Malformed message ids receive a stable recovery id. A new migration would have made
every older release refuse the database.

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
`deleteStoredValue` and `storageFilesContain`. `storageDatabase(storage)` and
`storageInternals(storage)` reach a running service's database, context and
repositories, for injecting a failure into a primitive or patching one
repository method. Patch the repository, not the facade: a repository calls
another repository directly, so a facade method replaced in a test is not
seen by storage code. An area field is the repository itself, so patching
`storage.kanban.getKanbanTasks` is also seen by the repository's own calls;
a patch that calls back into the same repository must let those through. To exercise the import and the
one-shot upgrades, write legacy files into a directory without a database
(`writeLegacyStore`) or copy a live one out in an older shape
(`exportStoresAsLegacyJson`). Each opens its own connection,
which behaves like another backend process. To simulate another backend
holding a lock, acquire its lease from `openBackendDatabase(dataDir)`; to
simulate a crashed holder, set its `heartbeat_at` to 0.
