# Backend storage

The backend's authoritative state lives in one SQLite database,
`orkestrator.sqlite`, in the data directory (`~/Library/Application
Support/orkestrator-v2/` on macOS, `${XDG_CONFIG_HOME:-~/.config}/orkestrator-v2/`
on Linux). The change-tracking ledger has its own file beside it,
`change-tracking.sqlite` (see [Version 7](#migrations)). It replaced 29 JSON store files (plus one file per public-operation
namespace), their per-file lock files and five-deep backup ladders.

| File | Purpose |
| --- | --- |
| `apps/backend/src/core/storage-database.ts` | `StorageDatabase`: connection, migrations, stores, leases |
| `apps/backend/src/core/storage-database-rows.ts` | How a value splits into rows under its layout, row ids and positions; no SQLite |
| `apps/backend/src/core/storage-stores.ts` | Store registry and layouts, migrations, the legacy JSON import, archive retention and scrubbing, the native-session owner backfill |
| `apps/backend/src/core/storage-record-upgrades.ts` | One-shot upgrades of record shapes only older builds wrote |
| `apps/backend/src/core/storage-retired-features.ts` | The migrations that remove data of retired features (Looped Review, the OpenCode 2 preview's session record) |
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
| `apps/backend/src/core/storage-writer-guards-test-support.ts` | The writer guard's static analysis; its tests are `storage-writer-guards.test.ts` (the facade's stores), `storage-writer-guards-raw.test.ts` (raw `StorageDatabase` writers) and `storage-writer-guards-analysis.test.ts` (fixtures for the analysis itself) |

## Code layout

`StorageService` (`storage.ts`) is a facade with no base class. Callers
(mostly through `CommandContext.storage`) reach a store in one of two ways:

- a public method of the facade, which forwards to the repository that owns
  the store (`storage.loadEnvironments()`);
- an area field, typed as a `Pick` of one repository's entry points and
  holding that repository (`storage.kanban.addKanbanTask()`, where
  `KanbanStorage = Pick<KanbanRepository, "addKanbanTask" | …>`).

The area fields are `kanban` (`KanbanStorage`), `linear` (`LinearStorage`), `coordinators`
(`CoordinatorsStorage`), `publicOperations` (`PublicOperationsStorage`),
`nodes` (`NodesStorage`), `previewServices` (`PreviewServicesStorage`),
`agentAccounts` (`AgentAccountsStorage`), `graphTemplates`
(`GraphTemplatesStorage`), `graphRuns` (`GraphRunsStorage`), `graphEffects`
(`GraphEffectsStorage`), `clientState` (`ClientStateStorage`), `setupApprovals`
(`SetupApprovalsStorage`), `suborks` (`SuborksStorage`), `watchedPullRequests`
(`WatchedPullRequestsStorage`) and `openCode2Sessions`
(`OpenCode2SessionsStorage`). Each area type is declared next to
its repository and re-exported from `storage.ts`, and lists only the methods
code outside the storage files calls; a consumer that needs a few of them
takes `Pick<KanbanStorage, "listAllFeaturePlans">` (or a nested
`{ coordinators: Pick<CoordinatorsStorage, …> }` beside facade methods) rather
than the whole service. New areas follow the same shape; the remaining
forwarders move to areas as their callers are narrowed. Forwarders are written
out, never generated at run time: the writer guard reads them and the area
`Pick`s as its entry points, and the surface stays greppable. The facade itself only
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
| `PromptQueueStore` | `storage-prompt-queue-store.ts` | The prompt-queue lease, row reads and row writes, and recovery of claims older backends left |
| `PromptsRepository` | `storage-prompts.ts` | Prompt-queue operations for dispatch, the compose-draft lease |
| `BuildPipelinesRepository` | `storage-build-pipelines.ts` | Build pipelines and their transcripts |
| `DraftsRepository` | `storage-drafts.ts` | Compose and file drafts, agent handoffs, session buffers, and the session and pane-layout edits they make |
| `AgentMailRepository` | `storage-agent-mail.ts` | Agent mail: sending, replies, per-message state, conversations, deletion and retention (an environment's deletion is planned in `storage-agent-mail-deletion.ts`) |
| `AgentMailboxDirectory` | `storage-agent-mail-directory.ts` | Mailbox synchronisation from pane layouts and coordinators, descriptors and snapshots, mailbox policy |
| `AgentMailInjects` | `storage-agent-mail-injects.ts` | Inject scheduling: the pending queue, claim and settle, retries and verification, delegation and stored-mail holds |
| `AgentMailBudgets` | `storage-agent-mail-budgets.ts` | Routed mail budgets: pair loop budget and hourly limit, resets, releases and the held-mail notice |
| `KanbanRepository` | `storage-kanban.ts` | Kanban, project notes, feature plans, Linear and GitHub completion comments |
| `LinearRepository` | `storage-linear.ts` | Linear board links per repository, disconnects to apply on other machines, and `create_linear_issue` request keys ([tickets.md](tickets.md#linear)), reached as `storage.linear` |
| `KanbanSyncRepository` | `storage-kanban-sync-repository.ts` | Kanban sync across machines ([tickets.md](tickets.md#sync-across-machines)), reached as `storage.ticketSync`; shares `KanbanBoardStore` (`storage-kanban-board.ts`: the Kanban lease, its reads and the commit that stamps each change for sync) with `KanbanRepository` |
| `PreviewServicesRepository` | `storage-preview-services.ts` | Preview services and settings, the backend profile and identity |
| `NodesRepository` | `storage-nodes.ts` | Command-node stores |
| `PublicOperationsRepository` | `storage-public-operations.ts` | The public-operation ledger, and the project and config writes it admits |
| `CoordinatorsRepository` | `storage-coordinators.ts` | Coordinator workspaces and workflow associations |
| `AgentAccountsRepository` | `storage-agent-accounts.ts` | The provider account registry |
| `GraphTemplatesRepository` | `storage-graph-templates.ts` | `graph-templates`: user graph templates (one row each, revision compare-and-swap inside the row's transaction) and per-project trust records and capability ceilings; a project's row is deleted with the project. Item 405 adds `sharing` (one row: the installation's share-bundle signing key, whose private half no command returns, and the trusted public keys) and `approvals` (one row per project: approved template copies for review diffs, bounded per template and per project, and rejected digests), deleted with the project too |
| `GraphRunsRepository` | `storage-graph-runs.ts` | Graph runs (`graph-runs`, one row per run, revision compare-and-swap) and their artifacts (`graph-artifacts`: one row per artifact plus a per-run usage row that enforces the budgets); run writes and deletions announce the `graph-run` resource. Runs leave with their environment; an environment-less mock run (item 213) is removed by `deleteEnvironmentlessGraphRun` (mock-run retention) |
| `GraphEffectsRepository` | `storage-graph-effects.ts` | The system-node effect journal (item 207): one row per side effect of a run, `intended` before the effect and `done`/`failed` after it, keyed by the action's idempotency key. Rows live in `graph-artifacts` beside the run's artifacts (`<run>/effect:<sha256 of the key>`, owned by the run, marked by `effectFormatVersion`), so they leave with the run on environment deletion; writes share the graph runs' lease. A mock run records `simulated` rows instead (`recordSimulatedGraphEffect`, data `{ wouldRun }`, item 213) |
| `SuborksRepository` | `storage-suborks.ts` | `native-agent-suborks`: one row per `ask_agents` call, holding each target's branch record, its bounded answer and the delivery state ([suborks.md](suborks.md)); revision compare-and-swap inside the row's transaction; owned by the environment, deleted with it. Its transcripts share the content-addressed transcript store |
| `GraphDescribeRepository` | `storage-graph-describe.ts` | `graph-describe` (item 215): one row per environment holding its latest "Describe a graph" job (the runner's branch record, the description, the compile context and, once completed, the draft), owned by the environment and deleted with it; revision compare-and-swap inside the row's transaction; writes announce the `graph-describe` resource |
| `ClientStateRepository` | `storage-client-state.ts` | Presentation state every client shares that used to live in one browser's localStorage. `coordinator-pane-layouts` (one row per project, the coordinator page's tab groups, revision compare-and-swap, announces `coordinator-pane-layout`) and `coordinator-upstream-declines` and `coordinator-upstream-auto-merge` (one row per project each, written only by older clients through the retired decline and auto-merge commands; `check_coordinator_upstream_merge` no longer reads them, not announced) are deleted with the project; `notice-dismissals` (one row: dismissed notice occurrences per session identity, bounded in both dimensions, oldest-touched sessions leave first, announces `notice-dismissal`). Commands: `commands-registry-client-state.ts`; clients learn which of these a backend owns from `get_client_state_capabilities`, import their browser copy once and then stop reading it |
| `WatchedPullRequestsRepository` | `storage-watched-pull-requests.ts` | `coordinator-watched-pull-requests`: one row per project holding the pull requests its coordinator watches ([coordinator.md](coordinator.md#watched-pull-requests)), at most 100 (least recently seen first out), plus the keys settled in the last week; deleted with the project |
| `SetupApprovalsRepository` | `storage-setup-approvals.ts` | `setup-approvals`: one row per project holding the hashes of the `setupLocal` command lists the user approved on this machine ([setup-approval.md](setup-approval.md)), bounded per project, oldest first out; deleted with the project |
| `ScheduledJobsRepository` | `storage-scheduled-jobs.ts` | Adapts the scheduled-job engine to the shared context; the engine owns its single-row writes |
| `PermissionRulesRepository` | `storage-permission-rules.ts` | Adapts the permission-rule store ([permission-rules.md](permission-rules.md)) to the shared context; the store owns its row transactions |

A store written by more than one repository is written under the same lease
by each, or only through transactions; the guard checks that per store. The
four agent mail classes share one `AgentMailStore`
(`storage-agent-mail-store.ts`): the `agent-mail.json` lease (`enqueue`), its
load and its size-checked save, plus the pure helpers on the persisted shape.
Read-only paths (the directory, inboxes, status, the inject sweep and the UI
summaries) use `snapshot()` instead of `load()`: one deeply frozen value shared
between calls and rebuilt only when the store's committed revision moves,
which any writer in any process bumps. A rebuild reads the serialized rows
from the connection's revision-validated cache (`loadStoreSerialized`) and
re-parses only rows whose serialized value changed, so an unchanged store
costs one revision query and a send re-parses about three rows instead of
every mailbox. Read-modify-write paths still take a mutable copy with `load()`
inside `enqueue`. The 32 MiB limit is checked on the serialized rows the save
writes anyway (`maxBytes` on `saveSensitiveJson`), not by serializing the
store a second time. Deleting an environment's mail plans its change from
`snapshot()` under the lease and commits only the rows it changes
(`saveRows`, through `updateStoreRows`): the removed mailboxes and idempotency
records, the rewritten mailboxes, the new counterparts, and the envelope's
revision and inject queue. A change that shrinks the store always commits, even
past the limit. Inside an atomic scope, or while a retired JSON copy of the
store remains, it falls back to `load()` and `save()`.

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
  because it holds API keys (see [Provider secrets at rest](#provider-secrets-at-rest)).
- Descriptor files other processes read: `backend-instance.json`,
  `control-mcp.json`, `gateway-auth.json`.
- Design canvases (records, pending operations, intent queues, history
  checkpoints, the user-facing `.orkdes` exports and their backups): a record can be 6 MiB and
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
| Health summary | `health-summary` (one row per sample or marker) | One row every five minutes, pruned to 2,016 rows in the write's own transaction; numbers and job kinds only; on its own connection, and not counted as content for the hourly snapshot ([logging.md](logging.md#health-summary-and-the-clean-exit-marker)) |
| Scheduled jobs | `scheduled-jobs` (one row per schedule, owner = the owner key) | Every write is one `updateStoreRow`, which is also the exactly-once fire claim across backends; bounded history inside the row; an environment's agent schedules are deleted with it ([scheduled-jobs.md](scheduled-jobs.md)) |
| Agent usage history | `usage-history` (one row per agent session, owner = environment) | Each recorded turn is one `updateStoreRow`; reports walk every row uncached and never prune (retention is swept from the write path); day buckets past 400 days and the least recently used rows above 20,000 are pruned hourly, 250 rows per transaction with the event loop free between batches. Each row is read and decided inside its transaction, so a turn recorded during the sweep stays and a row it refreshed is not dropped. Turn ids are scoped by provider session, because a row outlives the conversation in its tab. A turn is bucketed by the day its bridge finalized it (`NativeAgentTurnUsage.at`), falling back to the day it was first seen. Rows outlive the environment they came from and are deleted only on request |

Large engines read and write through `database.rows(store)`, an uncached
row API, so they never hold a whole store in memory; the cached APIs stay
correct because every row write bumps the store's revision.

`list({ values: false })` reports each row's size without reading its value. It
uses `octet_length(value)`, which reads the length from the record header, and
falls back to `length(CAST(value AS BLOB))` on a SQLite older than 3.43: Bun on
macOS loads the system library, so the version follows the macOS release (3.54.0
on macOS 27 and 3.53.4 in Bun's Linux image, both with Bun 1.4.4). It also scans
the primary key and sorts in JavaScript instead of using `ORDER BY`, because
`store_rows` is `WITHOUT ROWID`: a seek compares whole cells, reading their
overflow pages, so seeking each row through `store_rows_position` costs as much
as reading the values whichever size expression is used.

## Stores and layouts

A store is named by the JSON path it replaced, without `.json` (`kanban`,
`public-operations/index`). `storage-stores.ts` maps each store to a layout:

| Layout | Persisted as | Used for |
| --- | --- | --- |
| `document` | One JSON value | Small settings-like stores (catalogue, journal, accounts, auth) |
| `array` | One row per item, keyed by `id` (or a named field), order kept | Projects, environments, sessions, Kanban, feature plans, notes, comment records |
| `record` | One row per key | Native sessions, prompt queues, drafts, handoffs, reviews, pipelines, pane layouts, public operation namespaces |
| `envelope` | A document plus named record collections as rows | Agent mail (mailboxes, idempotency, counterparts), coordinators, catalogue, preview services |

Business code still reads and writes a store's whole logical value through
`loadJson`/`saveJson`. The database writes only rows whose serialized value or
position changed, so a mail send rewrites one mailbox row instead of up to
32 MiB of JSON. A write that changes nothing is skipped and does not bump the
revision. An array that cannot be keyed (a duplicate or missing key) is stored
whole as a document; the row layout returns on the next keyable write.

Rows carry an optional indexed `owner` (`projectId` for environments and
Kanban, `environmentId` for sessions and native agent sessions).
`loadStoreRowsByOwner` reads one project's board or one environment's sessions
without assembling the store, and `loadStoreRow` reads one row by key the same
way. `listStoreRowKeysByOwner` lists one owner's keys without reading a value,
plus the store's rows that have no owner, for the caller to check.

Native agent sessions gained their owner after rows existed, and an older build
sharing the directory writes rows without one. At every open
`backfillNativeAgentSessionOwners` gives those rows their environment in one
transaction, changing no value and no schema version. Rows with no owner have a
partial index of their own (`store_rows_unowned_native_agent_sessions`, from
`unownedRowIndexes`), so finding them reads only them; the backfill keeps it
empty apart from unreadable records.

`store_rows_position` indexes `(store, collection, position)`, so an insert's
next position (`max(position) + 1` of its collection) is one index lookup
rather than a scan of the collection. It changes no stored value, so
`StorageDatabase` creates it on open instead of through a numbered migration:
the schema version does not move and an older build still opens the database.
The unowned-row partial indexes are created the same way.

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
  the mutation does not await (project notes, feature plans, completion
  comments).
- **`updateStoreRow(file, key, mutate, { collection, archiveCleanup })`**: the
  same for one row of a `record` store, of a keyed `array` store or of one
  `envelope` collection. It neither parses nor rewrites the other rows, so a
  write costs O(row) and holders of different keys' leases cannot overwrite each
  other. An array item keeps its position when updated, a new one goes last, and
  its value must carry the row's key in the layout's key field. A store held
  whole as a document falls back to a whole-value read-modify-write. An
  unparsable row refuses the write, unless `unreadableRow: "replace"` hands it
  to `mutate` as absent. `archiveCleanup` commits an attributable archive cleanup
  with the row.
  `updateSensitiveStoreRow` is the same for a record store holding sensitive
  content: it also prunes what the row's new value drops from the retired JSON
  archive, as `saveSensitiveJson` does (see "Retired JSON archive").
- **`updateStoreRows(file, rows, { document, maxBytes })`**: several rows of a
  record store or of an envelope's collections, and an envelope's document, in
  one transaction that neither parses nor reserializes the other rows. It
  commits a change planned from an earlier read, so like a whole-value save it
  runs inside the store's lease, and the writer guard counts it with them. It
  answers `false` (the caller saves the whole value) inside an atomic scope,
  while a retired JSON copy remains, or for a store held as a document.
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
  stalls another. A mutation reads its record with
  `readNativeAgentSessionUnderLease`, which fetches that one row and refuses that
  key's unreadable record; another key's bad row is neither read nor rewritten.
  The value is a fresh parse, never a frozen snapshot object. Whole-store loads
  remain for what walks the store and holds no key's lease: the owner migration,
  the catalogue list and a store held as a document. The environment sweep
  finds its keys by owner (above), and loads the store whole only when it is
  held as a document or buffered by an atomic scope. Order: the service's per-key work fence, then the session
  lease, then leaf leases (prompt queue, display tails); never hold two
  session leases at once. Deleting an environment's sessions takes each key's
  lease in turn, and inserts check the environment's deletion tombstone inside
  their commit, so a create that overlaps the deletion cannot leave a record
  behind. Lease rows whose holder stopped heartbeating an hour ago are purged
  at start-up.

  Compose drafts keep the store's lease, because a save awaits its owner
  checks (environment, coordinator conversation or project) and must stay
  ordered against the owner deletion sweeps. Inside it a save or a single
  delete is one `updateSensitiveStoreRow` that checks the owner and the
  draft's `revision` in its own transaction, so typing never decodes or
  rewrites the other drafts. An owner sweep is one `updateStore` that removes
  only that owner's rows and writes nothing when the owner has none.

  Prompt queues keep the store's lease, because some writers await between the
  read and the write (an idempotent append and a job reservation read the native
  session in between) and all must stay ordered against deletion. A session lease
  is taken before it, never under it. Inside it a mutation is one
  `updateSensitiveStoreRow` that decodes and writes only its queue, so a queue
  holding attachments (up to 32 MiB) costs only its own mutations. A row gets the
  claim recovery and validation a load applies, and an unreadable or invalid row
  reads as absent, so that queue's next write replaces it; another queue's row is
  never read or rewritten, so a record this build cannot read survives. Only
  what walks the store still decodes every row: the listings behind the drain
  scans and environment deletion. Both parse row by row, because no write would
  clear a bad row now, and read whole it would hide every queue for good.
  Deletion writes one row per queue, so a crash part-way leaves the rest for the
  caller's retry. It also removes rows that name no environment, and keeps a row
  naming another one. `storage-writer-guards.test.ts` holds the lease on every
  row write of this store (`LEASED_ROW_STORES`).

  Environments keep their store lease too, because a write awaits between its
  read and its commit (a caller's `shouldUpdate` observation, the removal's
  usage label) and must stay ordered against other writers and against
  deletion. Inside it a writer reads its environment's row and commits it with
  `updateStoreRow`. A writer of several environments (a reorder, the activity
  lease sweeps, a container status change) commits only the rows it changed, in
  one transaction. A row write also refuses a row that has gone since the read,
  so a holder whose lease was taken over cannot bring back a removed environment.
  `storage-writer-guards.test.ts` requires the lease on every row write of this
  store (`LEASED_ROW_STORES`), since a row transaction alone would not serialize
  the read before it.

  Projects keep their store lease for the same reason: a write can await between
  its read and its commit (`addProject`'s caller-supplied validation), and the
  uniqueness of a remote and a checkout path is decided against the other
  projects. Inside it a writer commits one row (`saveProject`), or the rows an
  arrangement changed, in one transaction. A one-field edit reads one row; only
  an add, a new remote or a new checkout path reads the whole store, and those
  still write one row. The store is in `LEASED_ROW_STORES` too. A gesture that
  moves a project to the far end of a long list changes every row's `order`, so
  it costs one row write each, slower than the whole-value diff it replaced
  (about 6 ms against 3 ms at 500 projects).

  Terminal sessions take no lease, because no writer awaits. Each mutation is one
  transaction over only the rows it names: `updateStoreRow` for one session, and
  the environment's rows by their owner column for a create, a reorder, a
  disconnect or a removal, read inside that transaction so the order and the
  per-environment cap are decided against what it commits next to.

  Looped and Multi Review workflows keep **one lease per store for writers**:
  a save awaits its environment check, and launch and the environment sweep
  scan every workflow. Each write is still a single-row `updateStoreRow` that
  re-checks the controller fence and revision inside its own transaction.
  Reads, including the controller fence check a supervisor runs around
  nearly every provider call, read one row with `loadStoreRow` and take no
  lease. A lease held for a read is released before the caller acts on the
  answer, so it would cost two write transactions per check and protect
  nothing; the commit's own check is what stops a controller that lost its
  lease. The same rule applies to the interaction journal's read
  (`getAgentInteractionResolutionJournal`, whose prune only filters the copy it
  returns). Agent mail backoff resets always take the writer lease, even when
  nothing needs clearing, so a reset observes earlier queued backoff writes.
  A reset with no matching backoff leaves the store revision unchanged.
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

The guard is static and test-only on purpose. A run-time lease assertion
would see only the paths tests exercise and could only tell that *some* lease
is held; the scan sees every call site and checks that every writer of a store
holds the same one. Likewise a mixed-writer store is rejected by the scan
rather than detected in production by revision checks on save.

Engines with stores of their own (workflow results, the cleanup ledger,
display tails, web annotations, transcript artifacts, usage history, design
signals, …) write through `StorageDatabase` directly, outside that scan.
`storage-writer-guards-raw.test.ts` resolves the store each of those writes
names, through constants, template literals, small name functions
(`webAnnotationStoreName`), constructor-set fields and row helpers that take
the store as a parameter, and fails a write whose store it cannot name or
that a repository also writes. It parses a backend file only when the file's
text can name a raw writer method, when a store name being resolved is
imported from it, or when it can call a row helper whose store parameter is
being followed. The text check decodes `\u` escapes, so it never skips a file
in which a full parse would find a write.
The import and record upgrades in `storage-stores.ts`,
`storage-record-upgrades.ts` and `storage-retired-features.ts` are exempt: they
run inside the migration transaction at open, before any writer.

Whole-store reads are cached per store and revalidated against the committed
revision on every read (one indexed lookup), which also observes other
processes' writes. Keyed reads and mutations fetch only their named row even
on a cold connection or after another process writes; keyed mutations invalidate
any whole-store cache after commit. A keyed read on a connection that already
caches the store at the committed revision takes its row from that cache and
fetches nothing; a miss does not fill the cache. Legacy document representations retain the
whole-document fallback. `getResourceSnapshotRevision` hashes the database
identity and that revision.

Read-only background callers that walk every environment or native session
(the activity sweep, the interaction tracker, the tmux reconcile, the
human-prompt monitor and worker activity reads) use
`readEnvironmentsSnapshot` and `readNativeAgentSessionsSnapshot` instead of
`loadEnvironments` and `listNativeAgentSessions`. These return one deeply
frozen decoded copy per committed revision (`FrozenStoreSnapshot`, the
pattern of the agent mail read model): an unchanged store costs one revision
check, and a changed one re-decodes only the rows whose serialized value
changed. Each repository keeps one copy and does not keep a store whose
serialized rows exceed 64 MiB. Writing to a record from a snapshot throws,
so a caller that changes what it read uses the mutable loaders.

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

- The main storage database uses WAL with `synchronous = FULL`: a committed
  write survives a crash, and a torn write is impossible. `StorageDatabase`
  defaults to FULL; only the separate [change ledger](change-tracking.md#age-based-retention)
  explicitly selects NORMAL, trading power-loss durability for fewer commit syncs.
  The one exception inside the main file is the `leases` table: a lease
  claim, heartbeat or release commits at NORMAL (`leaseCommit`), so it appends
  to the WAL without syncing and the next FULL commit's sync covers it. A lease
  is coordination between live processes, so a power loss that drops one
  loses nothing (no holder survives it, and a lost release is a stale row the
  next waiter reclaims). Before, every leased store write cost three FULL
  syncs, claim, write and release; on btrfs on beelink2 that was 8 ms and
  255 KB of disk writes against 2.5 ms and 95 KB with the lease at NORMAL
  (to-do 7562).
- "Survives a crash" means an application or operating-system crash. Whether a
  commit also survives sudden power loss depends on the platform's sync call.
  On macOS, Bun links the system SQLite (`/usr/lib/libsqlite3.dylib`, 3.54.0
  on macOS 27.2), and a FULL commit there calls plain `fsync`, which does not
  flush the drive's write cache, so a power cut can lose the last commits
  (WAL checksums stop recovery at the first torn frame, so it does not
  corrupt the file). Apple's build also maps `PRAGMA fullfsync = ON` to
  `F_BARRIERFSYNC` (ordering, no cache flush) on APFS and HFS+, not to
  `F_FULLFSYNC`, so that PRAGMA cannot buy full power-loss durability there;
  it costs about four to six times a plain commit. Evidence: Apple's library
  reports `aapl` in `sqlite_source_id()` and is built with
  `DEFAULT_CKPTFULLFSYNC`, `DEFAULT_SYNCHRONOUS=2` and
  `DEFAULT_WAL_SYNCHRONOUS=1`; its `_unixSync`
  (`dyld_info -disassemble /usr/lib/libsqlite3.dylib`) issues `F_BARRIERFSYNC`
  for a full sync and `F_FULLFSYNC` only on a file system named `lifs`, else
  `fsync`. Measured on mini's internal APFS SSD on 2026-11-10 (macOS 27.2,
  Bun 1.4.4), one-row commit, 200 interleaved runs:

  | Series | Median ms | p95 ms |
  | --- | --- | --- |
  | FULL, `fullfsync` off (main file) | 0.193 | 0.717 |
  | FULL, `fullfsync` on | 0.716 | 3.635 |
  | NORMAL (ledger) | 0.054 | 0.186 |
  | OFF (floor) | 0.028 | 0.115 |
  | raw `fsync` | 0.076 | 0.203 |
  | raw `F_BARRIERFSYNC` | 0.703 | 2.162 |
  | raw `F_FULLFSYNC` | 4.098 | 8.744 |

  A truncating checkpoint after 50 commits took 1.66 ms median with
  `checkpoint_fullfsync` on and 0.46 ms off. `scripts/benchmark-sqlite-sync.ts`
  repeats the timing on another release; the full write-up is
  `git show 498b68766:docs/todo/cross-cutting/5180-sqlite-durability-tiers.md`
  (task 3).
- Whether to tier `synchronous` and `secure_delete` further by data (beyond the
  ledger's NORMAL) waits on a busy real session's commit counts
  ([commits and reads](#commits-and-reads)) and the maintainer's sign-off; both
  are in the [manual-test checklist](../todo/manual-test/7568-manual-test-checklist.md)
  (5180, retired, tasks 1 and 2). The maintainer's deferral (to-do 1202 task 2,
  ST-12: "unchanged, revisited only if fsync cost still shows") stands.
- Every connection sets `checkpoint_fullfsync = ON`, so a checkpoint, which
  copies WAL frames into the database file and then resets the WAL, syncs
  with a write barrier on macOS. Apple's SQLite already defaults to that
  (`DEFAULT_CKPTFULLFSYNC`); setting it keeps the ordering if the library or
  its build changes. It changes nothing on Linux, which has no such call.
  `fullfsync` (each commit) stays off.
- `secure_delete = ON` zeroes the freed pages of deleted content.
  `scrubDeletedDatabaseContent()` (called where the JSON stores used to scrub
  their backups) runs a truncating WAL checkpoint so old frames do not keep
  the content either. `storageFilesContain(dataDir, marker)` checks this in
  tests. It never throws. It does not return the freed pages to the
  filesystem (`auto_vacuum = INCREMENTAL`, set when the database is created):
  they already hold zeros, so that only gives space back. The main file's
  five-minute upkeep does it in a child process (below) and the ledger's
  retention pass does it for the ledger. Until 2026-11-11 the scrub also ran
  a 16 MiB `incremental_vacuum` on the backend's connection; on a 512 MiB
  database that held the event loop 252–444 ms p50 (up to 510 ms) on a loaded
  host, against 7–9 ms p50 (up to 16 ms) for the checkpoint alone
  (`apps/backend/scripts/storage-maintenance-stall.ts --scrub-only`, to-do 7210
  task 1). A file stays larger for up to five minutes after a deletion.
- The scrub's checkpoint never waits. A truncating checkpoint calls the busy
  handler until every reader has moved past it, so a reader holding an older
  snapshot (an hourly copy in progress, another backend's long read) used to
  block the event loop for the whole ten-second busy timeout
  (`storage-database-upkeep.test.ts` shows the wait). It now runs with
  `busy_timeout = 0`: it checkpoints what it can and reports the rest busy. A
  busy or failed scrub is retried from a timer, also without waiting, five
  seconds later and doubling up to a minute, until the WAL truncates or the
  connection closes (one last try). So deleted content leaves the WAL within
  a minute of the last older reader finishing. Each deferral and failure is
  logged as `[storage] scrub.checkpoint-failed`, throttled, with a
  `throttle.recovered` line once it succeeds. macOS's system SQLite calls the
  busy handler in a truncating checkpoint as Linux's does (checked on macOS
  27.2, SQLite 3.54.0); `bun test src/core/storage-database-upkeep.test.ts` in
  `apps/backend` repeats the check on another release.
- `foreign_keys` is off: no table declares a foreign key, so the PRAGMA would
  promise checks nothing enforces. A migration that declares keys turns it on
  in `StorageDatabase`'s constructor.
- `PRAGMA optimize` keeps the planner's statistics current, bounded by
  `analysis_limit = 400` and never waiting for another writer: on the main
  database after every snapshot check, on the ledger after every retention
  pass, and on every connection as it closes. On a generated 666 MB ledger the
  first run took under a millisecond. On the main database it stays on the
  backend's connection, every five minutes: `optimize` analyses the tables
  that connection's own queries used, so a child's connection would not know
  which to look at, and it held the event loop 11–13 ms p50 (up to 44 ms) on a
  512 MiB database (decided 2026-11-11, `git show 498b68766:docs/todo/cross-cutting/7210-storage-work-left-on-the-event-loop.md`
  task 3).
- Cache sizes (`cache_size`, `mmap_size`, `temp_store`) are SQLite's defaults.
  They are revisited only with a measured read problem
  ([5181](../todo/cross-cutting/5181-sqlite-cache-sizes.md)); the read
  timings in [commits and reads](#commits-and-reads) are what a busy profile is
  measured with.
- Every open sets the database file to 0600, along with any `-wal`, `-shm` or
  `-journal` already beside it, because SQLite only gives the file's mode to
  companions it creates. A new database's file exists at the default mode only
  until that first open sets it, before any content is written.

### Snapshots

WAL covers crashes and torn writes, not a bad migration, a bug that deletes
data or damage to the file. `storage-backups.ts` keeps snapshots in
`<dataDir>/backups/` (0700, files 0600), each a consistent `VACUUM INTO` copy
verified with `quick_check` before it is renamed into place. The hourly copies
hold `orkestrator.sqlite` only; the change-tracking ledger has its own file
and its own, daily, best-effort copies (below):

- `pre-migration-v<from>-<stamp>.sqlite` before an existing database is
  migrated to a newer schema (a failed snapshot aborts the open instead of
  migrating unprotected); the newest two are kept.
- `hourly-<stamp>.sqlite`, checked ten minutes after start-up and every five
  minutes, taken when the newest is an hour old **and** the content changed
  since it: any store's revision, the deletion bookkeeping in `storage_meta`
  or the schema version. Lease heartbeats, writes that change nothing and
  health summary rows do not count. A failed hourly snapshot only logs.
- The hourly copy and its `quick_check` run in a child process at low
  priority (`copyDatabaseInChildProcess`): on a large database both take
  minutes of disk I/O and must never block the backend's event loop. That child
  also reads `dbstat` on the finished copy, never the live file, and the largest
  12 tables and indexes by bytes go to `backups/.top-tables.json`, one set per
  database. Bun 1.4.4 on Linux has `dbstat`; a SQLite without it reports nothing
  and the copy still counts. Because nearly every store shares `store_rows`, the
  same child also sums `octet_length(value)` per store over the copy (through
  `length(CAST(value AS BLOB))` on a SQLite older than 3.43) and folds store
  names to families with `leaseFamily`'s rules before anything leaves it
  (`web-annotations/<environmentId>` counts as `web-annotations`): the largest
  12 families, with their value bytes and row counts, are stored as `stores`
  beside the tables. A database without `store_rows` (the ledger) has none, and a
  file an older backend wrote has none either. Keys and index pages are not
  counted, so the families add up to less than `store_rows`. A separate
  responsive supervisor kills and reaps the copy worker when the backend's pipe
  closes (including SIGKILL), or the independent two-hour deadline expires. The
  pre-migration snapshot stays in-process, because the open waits for it: it
  runs before anything is served, so the event loop has no other work then,
  and a failed copy must abort the open rather than migrate unprotected. It
  took 1.5–1.9 s p50 (up to 2.9 s) for 512 MiB on 2026-11-06, once per schema
  version (decided 2026-11-11, `git show 498b68766:docs/todo/cross-cutting/7210-storage-work-left-on-the-event-loop.md`
  task 2).
- An hourly copy is skipped when the disk has less free space than the
  compact database estimate plus as much again (at least 2 GiB). The estimate
  uses live SQLite pages, including committed WAL content, excluding free pages.
  Older databases without incremental auto-vacuum may remain physically large
  after pruning; freed pages are reused. Existing snapshots are budgeted on every
  check, including recent, unchanged and backoff checks. Older hourly snapshots
  give way after a successful copy so all snapshots together stay under 16 GiB;
  the newest hourly one is always kept. Space for the incoming copy is checked
  without first deleting recovery history; a skipped or failed copy does not
  trigger eviction for incoming bytes. A failed or skipped copy backs off
  15 minutes, doubling per consecutive failure up to six hours (`backups/.hourly-backoff.json`, so the
  backoff survives a restart).
- Temporary copies (`.<name>.<pid>.tmp` and their `-journal`, `-wal`, `-shm`)
  left by a process that died mid-copy are removed at start-up and before each
  copy; a live process's copy is kept unless untouched for an hour.
- Rotation keeps the newest six hourly snapshots plus one a day as it ages
  (each the first taken a day or more after the previous one), from the
  youngest at least three days old onwards. So there is always a copy about a
  day old and one about three days old; the one about two days old in between
  is what becomes the next three-day copy. At most about ten files, and
  within the size cap above.
- Anything older than seven days is deleted. That is also the privacy cost:
  content deleted from the live database can survive in a snapshot until it
  ages out.
- `change-tracking-daily-<stamp>.sqlite` copies `change-tracking.sqlite`, by
  the same check, after the hourly one and under the same lease: when the
  newest is a day old. Each due interval creates a recovery point, including
  ownership and binding-only edits; no ingestion fingerprint gates it. Same child-process copy and
  `quick_check`; its own backoff file, `backups/.ledger-backoff.json`. The
  newest two are kept. They are best effort: they give way first to the 16 GiB
  budget, and a copy that would not fit beside every other snapshot is skipped
  (`[storage] snapshot.ledger-skipped`) rather than displacing one.
  `change-tracking-pre-migration-v<from>-<stamp>.sqlite` is taken before the
  ledger file's own schema migrates; the newest two are kept.
- Neither ledger copy holds `<dataDir>/change-tracking/` (objects and
  evidence bodies), so a restored ledger can name bodies that are gone;
  readers report those as expired, as they do for a pruned body.

Restore: stop the app, replace `orkestrator.sqlite` with an `hourly-` or
`pre-migration-` snapshot and delete `orkestrator.sqlite-wal` and `-shm`. The
ledger restores the same way and independently: `change-tracking.sqlite` from
a `change-tracking-` snapshot, deleting its `-wal` and `-shm`. Nothing joins or
writes across the two files, so either can be restored alone. A ledger older
than the app database lacks the measurements newer transcript rows and
handoffs name, which then read as not retained; a newer ledger holds rows
nothing names yet, which retention prunes as usual. Restoring a
`pre-migration-v6-` snapshot (from before the ledger moved) brings the old
ledger back inside `orkestrator.sqlite`, and the next start moves it out again,
replacing `change-tracking.sqlite`. Snapshots are off by default under the
test runner (`new StorageService(dir, { snapshots: true })` turns them on).

### Size, waits and what fills the file

`/__orkestrator/metrics` (`database`), `get_database_stats` and Settings → Debug read
one summary (`database-summary.ts`), refreshed at most once a minute: file, WAL and
free bytes of both databases, backup count and bytes, the last scheduled change
retention pass and the top tables and store families above, which the Debug page
lists as "Inside `store_rows`, by store" under the main database's tables. Top tables
are as old as the last copy, so they are absent until one runs, and a machine with no
changes takes no copy.

`acquireLease` records every wait in a fixed-bucket histogram per lease family
(`storage-lease-metrics.ts`): `native-agent-session-leases/<hash>` counts as
`native-agent-session-leases`, a path outside the data directory as
`outside-data-dir`, and the table holds at most 64 families. A timeout also writes
`storage` `lease.timed-out` with the lease's name and `holderAgeMs`, the time since its
holder's last heartbeat: a large one is a dead or stalled holder, and a small one a live
holder keeping it for longer than the waiter would wait. A transaction that gives up
with `SQLITE_BUSY` is counted as `transactionsBusy`.

#### Commits and reads

`database.activity` in the same three places counts what this process's connections
did since its first one opened (`since`), per file (`main`, `ledger`, `other`), in
fixed-bucket histograms (`bucketsMs`, 0.1 ms to 1 s and an overflow bucket)
(`storage-activity-metrics.ts`). `instrumentSqliteConnection`
(`storage-slow-operations.ts`) classifies each completed call, a prepared statement
once:

- `commits`: a transaction that ran an INSERT, UPDATE or DELETE that changed a row,
  a schema change or an `incremental_vacuum`, and such a statement outside a
  transaction. Each appends to the WAL and, under `synchronous = FULL`, syncs it,
  so this is the commit rate the durability tiers turn on (see
  [durability and deletion](#durability-and-deletion)). Timed from the
  end of the transaction's body to its return (its COMMIT and sync), or the whole
  statement outside a transaction. A write transaction that changed nothing, and
  one that failed, are not counted.
- `checkpoints`: explicit `wal_checkpoint` calls (the scrub's, the copies').
  Automatic checkpoints run inside a commit and are in its time.
- `reads`: every other transaction that ran a statement, and every SELECT outside
  one, timed by the time spent in SQLite statements (not the JavaScript that
  decodes rows), by store family as lease waits name them, or `table:<name>` when
  no store was named; at most 64 series a file, the rest in `other`
  (`readsOverflowed`). A read the row cache served still runs the revision check,
  so the histogram holds both: cache hits in the lowest buckets, whole-store
  fetches above them.

Counts only grow, so a rate is the difference of two snapshots over the time
between them. On a `dev:test` profile on 2026-11-11 (mini, credential-free, the
fixture project), creating and starting one local environment took the main file
from 48 to 105 commits and stopping and deleting it to 220, 11 of them followed by
the deletion scrub's checkpoint; the ledger went from 4 to 8. Every commit took
under 6 ms, nearly all under 1 ms, and the slowest read series
(`table:stores`, `environments`) stayed under 2 ms. Counting a call costs a
histogram update and, for the statement's kind, a classification: once per
prepared statement (`query`, `prepare`), but on every call of `db.run` and
`db.exec`, which carry their SQL per call, so each of those lowercases and
matches the first 512 characters of its SQL. Over 200,000 calls the difference
from no counting was within run-to-run noise (about 2 µs a call either way).
A rolled-back savepoint inside a transaction that then commits is still a commit:
SQLite writes the pages it touched to the WAL at COMMIT. An INSERT, UPDATE or
DELETE read through `get`, `all` or `values` (a `RETURNING` statement) reports no
change count, so it is counted as a commit whatever it returned. Nothing a statement carries is kept: a series is a family or a table name.

## Provider secrets at rest

**Accepted risk (2026-11-05, security finding L17):** the stored provider secrets
are plaintext in owner-only files. No keychain or `safeStorage` storage path
exists for them, and none is planned while the reasoning below holds.

The fields are `githubToken`, `anthropicApiKey`, `cursorApiKey` and
`openCodeZenApiKey`, in `global` of the app config. They live here and nowhere
else in the data directory:

| File | Holds | Mode |
| --- | --- | --- |
| `config.json` | All four | 0600, set by every save and every backend start (`restrictConfigFileModes`) |
| `config.json.bak.1` to `.bak.5` | Earlier values of all four | The same |
| `.config.json.<uuid>.tmp` (also recovery and backup atomic-save remnants) | All four, if a save was interrupted | Created 0600; existing regular remnants tightened to 0600 at backend start |
| `portable-inputs/<environment>/<revision>/claude-config/.orkestrator-anthropic-key` | `anthropicApiKey`, for a container whose image takes staged inputs | 0600 in a 0700 directory |

`orkestrator.sqlite`, `change-tracking.sqlite`, their `-wal` and `-shm` and the
snapshots in `backups/` do not hold these fields, because `config.json` is not a
database store. They are 0600 (the directory 0700) for the other sensitive
content they hold.

**What protects them:**

- The file modes above, against other users on the machine.
- A container has no bind that reaches these files. Its binds are the project's
  Git mirror directory, its own `portable-inputs` revision and, on an image older
  than staged inputs, individual agent homes; none is the data directory.
- Answers to clients leave them out. `redactGlobalConfig` reports only whether
  each is configured, `stripRendererCredentials` ignores them in a settings save,
  and a leaf node never inherits them from its command node.

**What does not protect them:**

- Anything running as the same user can read them, including an agent in a local
  environment and any other program that user runs. So can root.
- Backups and disk images hold them in plaintext: a Time Machine or `rsync` copy
  of the data directory, or an image of an unencrypted disk. A copy made outside
  the app can also lose the 0600 mode.
- Clearing or replacing a key does not remove the old value from the backup
  ladder until five further config saves have rotated it out. Interrupted-save
  remnants are retained and tightened at startup, rather than deleted because
  another backend may still be writing one. They can retain old keys indefinitely
  until manually removed while all backends are stopped. A staged Anthropic
  key also remains in its `portable-inputs` revision while any container of that
  environment references it, including stopped containers and recovery copies.
  Changing the setting does not rewrite that revision or the key already copied
  into the container. Unreferenced revisions are eligible for pruning; a key that
  may have leaked has to be revoked at its provider.
- The modes guard the file, not the value. A container is deliberately given the
  keys its settings allow: the Anthropic key as the staged file above, or an
  environment variable on an older image; the Cursor key as an owner-only file in
  the container, or an environment variable on an older image; `githubToken` when
  [`containerGitHubCredential`](github-cli.md#container-credential) is `pat`. An
  agent in that container can read what it was given. `openCodeZenApiKey` stays on
  the host, where it reads plan usage.

**Why this is accepted:**

- A process running as the same user can already read the host logins and tokens
  beside these files (`~/.claude`, `~/.codex`, `gateway-auth.json`,
  `control-mcp.json`). Encrypting four fields would not change what it can reach,
  and on Linux libsecret does not separate applications of one user either.
- The backend also runs standalone. `safeStorage` belongs to Electron, and a
  headless host has no session keyring, so a keychain would be a second storage
  path with a migration, and either a backend that cannot start alone with its
  config or a standalone install that gains nothing.
- It matches Control MCP's credentials, which stay in plaintext at 0600 so Copy
  setup works at any time
  ([decision 2](../todo/mcp/0041-control-mcp-voice-surface.md#decisions)).

Look at this again if a same-user process stops being able to read those host
logins (for example, if every local agent runs in a sandbox that denies them), or
if a container gains a bind on the data directory.

`storage-secrets-at-rest.test.ts` checks the modes and scans a data directory to
show that only `config.json` and its backups hold the fields.
`container-data-directory-reach.test.ts` checks a container's binds and the staged
key, and `commands-secret-sweep.test.ts` plants canaries and calls every
registered command.

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

One upgrade cannot run once: a backend up to v2.29.0-beta can write a
prompt-queue claim (`outstandingClaim`), and one that opened the database before
version 5 keeps writing until it stops, because the version is checked only at
open. So `restoreLegacyPromptQueueClaims` (`storage-record-upgrades.ts`) runs on every
read of a prompt queue, one row or the whole list: live leases retain exclusion
and survive queue writes until settlement or expiry. Expired or malformed
leases restore their message to the head, and the next write of that queue
persists that; until then every read recovers it again. Malformed message ids
receive a stable recovery id.

Version 4 (`change-tracking/ledger-schema.ts`) adds the change-tracking
ledger: the first engine with its own indexed tables (worktrees, evidence,
snapshots, turn boundaries, measurements, selections, outbox, restore
records) because its queries need joins and range scans. Version 7 moves them
to their own file. Its file contents live under `<dataDir>/change-tracking/`
(a content-addressed object store and evidence bodies), so a backup of change
history must include that directory as well as `change-tracking.sqlite`. See
[change-tracking.md](change-tracking.md).

Version 5 (`retire-looped-reviews`) retires the removed Looped Review
feature's data: it deletes the `looped-reviews` store, prunes looped-review
claims from the agent interaction resolution journal, and deletes the
native-agent-session records Looped Review started (`looped-review:` logical
keys). Multi Review and review fan-out sessions that shared the
`looped-review` origin are kept and relabelled `automated-review`. Before deleting
records, the migration copies their provider identities (environment, agent and
provider session ID) into `retired-looped-review-sessions`. Startup reconnects
to each runtime, requests abort, and removes an identity only after the provider
confirms idle or missing. Unreachable and still-running turns remain queued for
minute-by-minute retry and survive backend restarts.

Version 6 (`backfill-build-pipeline-review-reports`,
`storage-record-upgrades.ts`) fills `testResults.notRun` on the structured
review reports a stored pipeline carries, written before the field existed. The
current contract requires it, and the renderer no longer repairs a report it
reads. The legacy localStorage import applies the same backfill.

Version 7 (`move-change-ledger`, `change-tracking/ledger-schema.ts`) moves the
change-tracking ledger out of `orkestrator.sqlite` into
`change-tracking.sqlite`, so the hourly snapshot no longer copies it with every
small change to an app store (on one machine, 6.2 GB of snapshots for stores
of about 0.6 MB). A second connection attaches the main file and copies the
committed ledger rows in one transaction on the ledger file, replacing what it
held; the migration then drops the tables with `secure_delete` enabled so
legacy databases cannot retain recoverable ledger bytes on free pages. A crash before the commit
repeats the copy. A new database creates no ledger file here: the ledger
opens it on first use. The ledger file is versioned on its own (`user_version`
2, `CHANGE_LEDGER_FILE_SCHEMA_VERSION`), refuses to open when newer than the
build, and takes its own pre-migration snapshot. Change tracking opens the
main database before the ledger, so the move has always run before the ledger
is first written. On a generated ledger of 2 million file rows (666 MB) the
move took about 8 s with secure deletion disabled (a historical measurement;
the corrected migration keeps it enabled and has not been remeasured); the hourly
copy afterwards was 48 KB in 19 ms. The move logs `[storage] ledger.moved` at
info with `rows` and `durationMs`, so a real installation's one-time cost can be
read from its first start after the upgrade. The pages the ledger freed are returned to
the filesystem after start-up by the snapshot check's upkeep
(`runDatabaseUpkeep`, every five minutes after the copies). It runs
`PRAGMA optimize` on the backend's own connection, whose queries that reads,
and, when there are free pages, starts a child process under the copy's
supervisor (`releaseFreePagesInChildProcess`) with its own connection and the
backend's `synchronous`, `secure_delete` and `journal_size_limit`. The child
returns at most 1 GiB per check, 1 MiB per transaction, checkpoints its own
frames after each one (so the backend's next commit does not pay for them),
pauses 5 ms between them and stops when the database is busy. In-process,
those steps had held the event loop 30–190 ms each (to-do 1202 task 7).
It also stops after any step that took longer than 100 ms
(`UPKEEP_RELEASE_SLOW_STEP_MS`), and the next check carries on. A step reads
the pages it moves while it holds the write lock, so on a busy disk one step
can hold it for seconds. A backend writer waits behind that step, and because
`bun:sqlite` is synchronous, the event loop waits with it. With four processes
fsyncing on the same disk, a 1 GiB release that ran to its budget held backend
writes for 1.7–4.2 s, with 2–7 writes of at least 1 s each. A longer pause, a
smaller step and `synchronous = NORMAL` in the child did not change that. The
waiting writer is not starved between steps: Bun's SQLite is built with
`SQLITE_ENABLE_SETLK_TIMEOUT`, so a writer blocked on the lock gets it as soon
as the step commits. On a quiet disk a step takes 5–60 ms and the release runs
its whole budget. Other work on the host can still stop it early, which moves
the rest to the next check. `apps/backend/scripts/storage-release-writer-stall.ts`
measures this (to-do 7210 task 4, retired:
`git show 498b68766:docs/todo/cross-cutting/7210-storage-work-left-on-the-event-loop.md`).
Each pass writes one `storage` `upkeep.finished` line with how long
`optimize` held the event loop, the pages released and left, and why the
release stopped (`slow-step` for the case above); slow SQLite calls on either file write `operation.slow`
([what ran during a stall](logging.md#what-ran-during-a-stall)).

Version 8 (`retire-opencode2-sessions`, `storage-retired-features.ts`)
deletes the `opencode2-sessions` store. The OpenCode 2 preview recorded there
which workflow sessions it had put on OpenCode 2, so a router could keep them
off OpenCode 1.x; with 1.x retired every OpenCode session is a 2.x session and
nothing reads it. It held only environment and session ids.

Version 9 (`public-operation-rows`, `storage-public-operation-rows.ts`)
rewrites each public operation namespace (`public-operations/ns-…`) from one
`{ version: 1, namespace, operations: [...] }` document into a `record` store,
one row per operation keyed by its `operationId`, in admission order. Before
it, every admission and every state change parsed, re-validated and rewrote the
whole namespace, which takes admissions for seven days, so each FULL-synced
commit grew with the run (to-do 7562). `PublicOperationsRepository` now writes
one row (`updateSensitiveStoreRow`) under the public operation store lock and
keeps each namespace's validated rows by serialized value, re-parsing only rows
whose value changed (`loadStoreSerialized`). A namespace that is unreadable, or
whose records cannot be keyed, is left as it was, and the reader still refuses
admissions on it. Retirement still deletes a namespace whole under the same
lock; `storage-writer-guards.test.ts` allows that deletion beside the leased
row writes and nothing else.

Every startup also extracts identities from stray `looped-reviews.json` files
and their retained `legacy-json/` copies, including backups and interrupted
writer temps, then immediately removes those retired copies. No review context,
diffs or reports survive in that queue, and unrelated archives retain their
normal retention policy. File removal failures leave their source and queued
identities for retry on reopen; storage initialization reports the failure.

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
- Deleting boundaries that know exactly what they removed (drafts, handoffs,
  prompt queues, reviews, build pipelines) scrub with an attributable predicate
  through `scrubSensitiveJsonBackups` or `scrubLegacyJsonStore`. Writes through
  `updateStore` or `updateStoreRow` touch the archive only when asked, so a
  delete made that way must scrub explicitly.
- Environments commit their scrub with the row: `updateStoreRow`'s
  `archiveCleanup` journals `delete-item` (a removed environment) or
  `drop-item-field` (its superseded launch attachments) in the row's transaction
  through `commitWithLegacyJsonCleanup`. The intent names the row and holds none
  of its content, and it replays on reopen after a crash. A routine row write
  leaves the archive byte-identical. A build that predates these two kinds
  removes the store's archived copies if it replays one, which it can see only
  after a crash followed by a downgrade: the deletion holds and only that
  recovery copy is lost.
  `updateSensitiveStoreRow` commits a keyed pruning intent with the row
  mutation, including inside `atomically()`. After commit it prunes what the
  row's new value drops from that record's archived copies; when it replaced
  an unreadable store it prunes every copy against the whole new value.
  Failed cleanup replays on reopen or the next journaled write, before another
  mutation can obscure a removal (including a later re-add).

## Testing

Use `storage-test-support.ts` rather than writing files into a data directory:
`seedStore`, `seedUnreadableStore`, `readStoredValue`, `hasStore`,
`deleteStoredValue` and `storageFilesContain`. `withTemporaryStorage(run)`
runs `run` against an initialised service in a fresh data directory and
removes the directory afterwards. `storageDatabase(storage)` and
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
