# Storage service repositories

Checked against `main` at `2459b05c` (2026-10-15). Step 1 (`StorageContext`)
was done on top of `b83ae534` (2026-10-22); steps 2 to 4 remain.

`StorageService` is one class cut by size into a 14-layer `extends` chain, so
every layer shares `StorageBase`'s protected state and reading one store means
reading all of them. The goal is one facade with an unchanged public surface,
holding per-store repositories over a shared `StorageContext`. A second goal
is to make the SQLite write rules enforceable by tests, so the class of
lost-update bugs closed by the SQLite migration cannot come back.

## Current state

- Since #969 every backend store except `config.json` lives in
  `orkestrator.sqlite` (`STORE_LAYOUTS` in `storage-stores.ts`). `loadJson` and
  `saveJson` keep their names but route to the database for those stores
  (`saveStore` and `loadStore` in `storage-context.ts`). An earlier idea of a
  shared JSON file store is superseded by this and is not part of the plan.
- The chain, all in `apps/backend/src/core/` (about 15,000 lines in 15 files):
  `StorageBase` (`storage-base.ts`) → `StorageProjects` → `StorageConfig` →
  `StorageSessions` → `StorageReviews` → `StorageNative` → `StoragePrompts` →
  `StorageBuildPipelines` → `StorageDrafts` → `StorageAgentMail` →
  `StorageKanban` → `StoragePreviewServices` → `StorageNodes` →
  `StoragePublicOperations` → `StorageService` (`storage.ts`).
- **Step 1 is done.** `StorageContext` (`storage-context.ts`) owns the shared
  state and the store primitives: the database handle and its snapshot timers,
  the `atomically` scope (one `AsyncLocalStorage` per `StorageService`),
  the per-target mutation tails, the JSON-file write queue and read cache,
  `resourceGeneration`, `updateStore`, `updateStoreRow`, `serialize` (the old
  `serializeMutation`, whose doc comment now records the full lease order),
  `acquireLease`, `loadJson`/`saveJson`/`saveSensitiveJson`/`deleteStore` and
  the archive and WAL scrubbing helpers. Its `changes` member, a
  `StorageChanges` (`storage-changes.ts`), owns the change listener and
  observers, `announce` (deferred through `deferUntilCommit` inside an atomic
  scope), the bounded change journal (formerly `scopedChanges`) and the
  revision manifests.
- `StorageBase` creates the context in its constructor and holds it in a
  `private` field, so no layer above can reach it. It keeps the store-name
  helpers (`kanbanFile()` and so on, which the writer guard groups stores by),
  the `enqueue*Mutation` lease wrappers and lease timeouts, the four abstract
  hooks, the prompt-queue claim timer and lease length, and the native-agent
  pending dispatch/steer scrubbers. Every other member forwards to the context
  under its old name (`serializeMutation` → `serialize`,
  `acquireMutationLock` → `acquireLease`).
- It still declares four abstract hooks that later layers implement:
  `recoverExpiredPromptQueueClaims`, `promptQueueMessageFingerprint`,
  `deleteComposeDraftsByProject` and `deleteSessionBuffer`.
- Lease timeouts on `StorageBase`: `NATIVE_AGENT_SESSION_LOCK_TIMEOUT_MS`
  (180 s), `PROJECT_CREATION_LOCK_STALE_MS` (90 s) and
  `PROJECT_CREATION_LOCK_TIMEOUT_MS` (660 s).
- Revision checks exist but are unused for leased writes.
  `StorageDatabase.writeStore` accepts `expectedRevision` and throws
  `StoreConflictError` on a mismatch, but `saveStore` never passes one.
- `storage-writer-guards.test.ts` enforces the write rules per store (checked
  against `main` at `9906db30`, 2026-10-16). It parses the `StorageService`
  chain with `oxc-parser`, follows lease wrappers and private or protected
  helpers to every caller, and fails when a `saveJson`/`saveSensitiveJson`/
  `deleteStore` holds no store-wide lease, when a call on the way to it is
  neither awaited nor returned, when the whole-value writers of one store share
  no lease, or when a store has both whole-value and `updateStore`/
  `updateStoreRow` writers. A test fails when a backend class outside the
  chain calls those primitives, so an extracted repository cannot drop out of
  the scan unnoticed. Since step 1 it also fails when a layer other than
  `StorageBase` touches `this.context`, when a `StorageBase` member other than
  the matching forwarder reaches a writing context member (`saveJson`,
  `saveSensitiveJson`, `deleteStore`, `updateStore`, `updateStoreRow`,
  `atomically`, `serialize`, `acquireLease`, `database`), when `this.context`
  is used as a value outside the constructor, and when any backend source
  other than `storage-base.ts`, `storage-context.ts` and `storage-changes.ts`
  names `StorageContext`.
- What the guard found on `9906db30`: 22 stores have only leased whole-value
  writers and 9 have only transactional ones; none has both. Helpers reach
  their lease through every caller: `saveEnvironments` (19 call paths),
  `saveAgentMailStore` (19), `savePromptQueueMutation`, `saveNamespaceRecords`,
  `indexWithCurrent` and `applyProjectUpdates`. `project-removal-fences` is
  saved under the environment lease at both of its writers. `saveLinearAuth`
  and `clearLinearAuth` (`storage-kanban.ts`), the last unleased writers, now
  take the `linear-auth.json` lease, so the guard has no exceptions.
- The only `atomically` caller outside the base is `collectPublicOperations`
  (`storage-public-operations.ts`), which retires public-operation namespaces.
- Concurrency coverage that exists: `storage-store-concurrency.test.ts` (16
  concurrent writes across two `StorageService` instances for sessions,
  project notes, Linear completion comments and feature plans),
  `storage-atomic.test.ts` (the primitives through the chain, and Linear auth
  saves and clears waiting on another backend's lease and after a failed
  holder), `storage-context.test.ts` (the context on its own: atomic commit
  with deferred announcements, per-target FIFO, the lease across two contexts
  on one data directory, manifest store mapping) and
  `storage-kanban-concurrency.test.ts`.
- Tests reach into protected members with 31 `as unknown as` casts across 12
  of the 30 `storage*.test.ts` files (counted before step 1). Step 1 moved one:
  `creationQueueSize` in `storage-project-concurrency.test.ts` now reads
  `context.mutationTails`. The `database` casts still work through
  `StorageBase`'s `database` getter.
- `tests/unit/inheritance-chains.test.ts` pins this chain in `PINNED_CHAINS`,
  with `plan: "docs/todo/backend-structure/0009-storage-service-repositories.md"`. The test fails if
  the pinned class list no longer matches the source (a shortened chain is
  reported as stale), and it asserts that the `plan` file exists.

## Outstanding work

### Code

Each step is its own PR and keeps behaviour identical. **Every step must update
the storage entry in `PINNED_CHAINS` in `tests/unit/inheritance-chains.test.ts`**:
remove the classes the step took out of the chain, and keep `plan` pointing at
this file for as long as the chain exists. When the last step removes the
chain, remove the entry, and delete this file in the same change. **Every step
must also keep `storage-writer-guards.test.ts` scanning every class that
writes stores**: once a repository leaves the chain, add it to the scan (and
teach the scan its `StorageContext` primitive names) instead of letting the
"outside the chain" test be relaxed. Concretely, the first repository step
has to: scan the repository class alongside the chain; treat
`this.context.saveJson`/`saveSensitiveJson`/`deleteStore` as whole-value
writes, `this.context.updateStore`/`updateStoreRow` as transactional ones,
`this.context.atomically` as the scope and `this.context.serialize` as a lease
wrapper (target parameter 0, operation parameter 2); resolve stores named by
the repository's own `xFile()` helpers; and only then add its file to the
allowed list of "only StorageBase holds the StorageContext". Step 1 removed no
class from the chain, so it left `PINNED_CHAINS` unchanged.

1. ~~**Introduce `StorageContext`.**~~ Done (see "Current state").
2. **Extract the leaf repositories**, one layer per PR, each with
   `StorageService` delegating to it:
   - preview services;
   - agent mail;
   - Kanban, except `setAllEnvironmentStatusesForContainer`;
   - drafts (file drafts, handoffs);
   - public operations.
3. **Extract the entangled repositories**, replacing each abstract hook with a
   constructor dependency:
   - projects and environments (project removal fences,
     `deleteComposeDraftsByProject`);
   - sessions (buffers, `deleteSessionBuffer`);
   - native agent sessions and the prompt queue (the claim-recovery timer);
   - reviews;
   - build pipelines. `BuildPipelineService` already calls
     `storage.getBuildPipeline` and `storage.saveBuildPipeline` directly
     (`build-pipeline-context.ts`).
4. **Delete the empty chain.** `StorageService` becomes a plain class holding
   the repositories, and `StorageBase` goes away.

Target shape:

```text
StorageService (facade, same public surface)
 ├─ ProjectsRepository / EnvironmentsRepository
 ├─ SessionsRepository / PaneLayoutsRepository
 ├─ ConfigRepository
 ├─ ReviewsRepository
 ├─ NativeAgentSessionsRepository / PromptQueueRepository
 ├─ DraftsRepository / AgentMailRepository / KanbanRepository
 ├─ PreviewServicesRepository / PublicOperationsRepository
 └─ BuildPipelinesRepository
        shared: StorageContext {
          dataDir, database, resourceGeneration, file,
          loadJson, loadStoreRow, loadStoreStrict, ..., saveJson,
          saveSensitiveJson, deleteStore, updateStore, updateStoreRow,
          serialize, acquireLease, atomically, deferUntilCommit,
          changes: StorageChanges { announce, listeners, journal, manifests },
        }
```

Done when:

- `StorageService` has no `extends`, `StorageBase` is gone, and the pinned
  entry is removed from `inheritance-chains.test.ts`;
- `storage-writer-guards.test.ts` still passes and scans every repository
  that writes stores.

### Qualification

- Run every `apps/backend/src/core/storage*.test.ts` after each step, plus
  `mise run test` before merging.
- Move the protected-member casts onto repository APIs in the step that moves
  their store, one store at a time; do not rewrite them up front.

## Constraints and rationale

- `StorageService` keeps every public method name and signature. More than a
  hundred backend files reach it, mostly through `CommandContext.storage`;
  narrowing them to repositories is a separate change.
- The facade's `atomically` must stay one `AsyncLocalStorage` scope on
  `StorageContext`, shared by every repository, not one scope per repository.
- Never hold a SQLite transaction across an `await`. Use `updateStore` or
  `updateStoreRow` for a synchronous read-modify-write, `serializeMutation`
  for one that awaits, and under a per-key lease write only that key's row
  (`AGENTS.md` "Storage rules").
- A lease only excludes other lease holders. Mixing an unleased `updateStore`
  writer with a leased `saveJson` writer on one store loses updates, because
  `saveJson` writes the whole value as a row diff against the current rows.
  `storage-writer-guards.test.ts` rejects any store that mixes them.
- Lease targets, labels and timeouts move with their repository unchanged.
  Three leases are held across external I/O on purpose: native agent sessions,
  project creation and GitHub completion comment posting.
- Cross-store paths that work today because one `this` reaches every store,
  each of which needs an explicit dependency:
  - project removal: projects → environments → compose drafts → sessions;
  - session removal → `deleteSessionBuffer`;
  - prompt-queue claim recovery (timer in the base, logic in the native
    layer);
  - Kanban → environment status (`setAllEnvironmentStatusesForContainer`);
  - sensitive scrubbing for pending native-agent dispatch and steer.
- `config.json` stays a file, serialised by the `configuration storage` lease.
  The only desktop writer is `applyAgentTestPlatformSelection`
  (`apps/desktop/electron/agent-platform-selection.ts`), which runs for
  agent-test profiles before the backend starts. A desktop writer added while
  a backend runs would not be covered by the lease.
- **The writer guard is static and test-only.** A runtime check (an
  `AsyncLocalStorage` of held leases asserted in `saveStore`, plus per-store
  writer kinds) would only see the paths tests exercise, would need the
  `saveStore`/`saveSensitiveJson` code another change is editing, and can only
  tell that *some* lease is held, not that every writer of the store holds the
  same one. The static scan sees every call site, costs nothing at run time,
  and checks the stronger property. If `StorageContext` makes the save
  primitive a single choke point, a test-build assertion there is a cheap
  second net; it is not needed for correctness.
- **Mixed writers are rejected, not detected at run time.** The alternative
  was to have `saveStore` pass the revision `loadJson` saw, so a racing
  writer throws `StoreConflictError` instead of being overwritten. That needs
  per-lease-scope revision tracking in `loadJson`/`saveJson` and turns a code
  rule into production failures. With no mixed writer present, the guard
  keeps it that way at no run-time cost.
- **Guard rules.** A lease target built from a key
  (`native-agent-session-leases/<hash>`, `project-creation-locks/<hash>`)
  does not count as store-wide. Code between the lease callback and the write
  may not start another function (a `forEach` callback could outlive the
  lease), and a helper used as a value (`this.helper` without a call) fails
  the scan. An `updateStore` reached from inside `atomically` counts as a
  whole-value write, because the scope buffers the value and commits it
  whole. `deleteStore` is outside the rules: it removes the store without
  reading it.
- **`saveLinearAuth` takes a lease rather than an allowlist entry.** It reads
  nothing, so unleased it was only last-writer-wins, but an exception in the
  guard would be the precedent for the next one. `saveLinearAuth` and
  `clearLinearAuth` are both serialized on `linear-auth.json` (rare writes, so
  the lease's cost is negligible), and the guard has no allowlist.
- **The guard does not cover raw `StorageDatabase` writers outside the
  chain** (workflow results, environment cleanup ledger and sweeps, design
  canvas signals, native-agent display tails, web annotations, build-pipeline
  transcripts, legacy-cleanup bookkeeping). On `9906db30` each writes only
  stores of its own, none of which the chain writes, but nothing enforces
  that. The schema migrations (legacy JSON import, record-shape upgrades) do
  rewrite chain stores, inside the migration transaction at open and before
  any writer runs.

## Follow-ups

- Extend the writer guard to raw `StorageDatabase` writers outside the chain:
  resolve their store-name constants and fail when one writes a store the
  chain writes.

## Related

- [0010-native-agent-service-collaborators.md](0010-native-agent-service-collaborators.md):
  its prompt-queue dispatcher must keep its ordering against
  `enqueueNativeAgentSessionMutation`.
- [0012-backend-core-domain-folders.md](0012-backend-core-domain-folders.md): the
  `storage` folder slice is in its last wave; landing the repositories first
  means the move is done once.
- [`storage.md`](../../architecture/storage.md) ("Concurrency"), `AGENTS.md`
  ("Storage rules", "Splitting large classes").

## Replaces

- `docs/2026-10-14/01-storage-json-file-store-and-repositories.md`
