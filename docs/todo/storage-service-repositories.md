# Storage service repositories

Checked against `main` at `2459b05c` (2026-10-15).

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
  (`saveStore` and `loadStore` in `storage-base.ts`). An earlier idea of a
  shared JSON file store is superseded by this and is not part of the plan.
- The chain, all in `apps/backend/src/core/` (about 15,000 lines in 14 files):
  `StorageBase` (`storage-base.ts`) → `StorageProjects` → `StorageConfig` →
  `StorageSessions` → `StorageReviews` → `StorageNative` → `StoragePrompts` →
  `StorageBuildPipelines` → `StorageDrafts` → `StorageAgentMail` →
  `StorageKanban` → `StoragePreviewServices` → `StoragePublicOperations` →
  `StorageService` (`storage.ts`).
- `StorageBase` owns the primitives: the database handle, `updateStore`,
  `updateStoreRow`, `serializeMutation`, `atomically` (with its
  `AsyncLocalStorage` scope), `loadJson`/`saveJson`, `announce`, the
  sensitive scrubbing helpers (`scrubPendingNativeAgentDispatchBackups`,
  `scrubPendingNativeAgentSteerBackups`, `scrubDeletedDatabaseContent`) and the
  prompt-queue claim-recovery timer.
- It still declares four abstract hooks that later layers implement:
  `recoverExpiredPromptQueueClaims`, `promptQueueMessageFingerprint`,
  `deleteComposeDraftsByProject` and `deleteSessionBuffer`.
- Lease timeouts on `StorageBase`: `NATIVE_AGENT_SESSION_LOCK_TIMEOUT_MS`
  (180 s), `PROJECT_CREATION_LOCK_STALE_MS` (90 s) and
  `PROJECT_CREATION_LOCK_TIMEOUT_MS` (660 s).
- Revision checks exist but are unused for leased writes.
  `StorageDatabase.writeStore` accepts `expectedRevision` and throws
  `StoreConflictError` on a mismatch, but `saveStore` never passes one.
- Every `saveJson`/`saveSensitiveJson` call found by a text sweep sits inside a
  `serializeMutation` wrapper, directly or through a helper whose callers hold
  the lease: `saveEnvironments` (`storage-projects.ts`),
  `savePromptQueueMutation` (`storage-native.ts`), `saveAgentMailStore`
  (`storage-agent-mail.ts`), `saveNamespaceRecords` and `applyProjectUpdates`
  (`storage-public-operations.ts`). The one unguarded call is `saveLinearAuth`
  (`storage-kanban.ts`), a blind overwrite rather than a read-modify-write.
  No test enforces any of this.
- The only `atomically` caller outside the base is `collectPublicOperations`
  (`storage-public-operations.ts`), which retires public-operation namespaces.
- Concurrency coverage that exists: `storage-store-concurrency.test.ts` (16
  concurrent writes across two `StorageService` instances for sessions,
  project notes, Linear completion comments and feature plans),
  `storage-atomic.test.ts` (the primitives) and
  `storage-kanban-concurrency.test.ts`.
- Tests reach into protected members with 31 `as unknown as` casts across 12
  of the 30 `storage*.test.ts` files.
- `tests/unit/inheritance-chains.test.ts` pins this chain in `PINNED_CHAINS`,
  with `plan: "docs/todo/storage-service-repositories.md"`. The test fails if
  the pinned class list no longer matches the source (a shortened chain is
  reported as stale), and it asserts that the `plan` file exists.

## Outstanding work

### Retired JSON archive

`saveSensitiveJson` (`storage-base.ts`) runs `scrubLegacyJsonStore` after
every database write of a sensitive store, for as long as `legacy-json/` holds
that store (14 days after the import). Its transform keeps each archived
top-level key that the new value still has, but writes the key's **current**
value. So, until the archive is purged:

- every sensitive save to a database store (agent mail, coordinators, prompt
  queues, drafts and handoffs among them) also reads, parses and rewrites the
  store's archived primary and its five `.bak.N` copies synchronously on the
  event loop;
- the archive stops being the pre-migration copy that `storage.md` tells a
  downgrade to restore from. On a live install on 2026-10-15, all six archived
  `agent-mail.json*` copies (178 KB each) and all six `coordinators.json*`
  copies had been rewritten to one identical, current value that afternoon;
- it keeps a second copy of current sensitive content outside the database.

Fix: scrub the archive only when something is deleted, dropping the removed
keys and leaving archived values as they were (`scrubSensitiveJsonBackups`
already does this), and stop calling `scrubLegacyJsonStore` from non-deleting
saves. Multi Review and looped-review workflows no longer save through
`saveSensitiveJson`. Done when a non-deleting sensitive save leaves
`legacy-json/` byte-identical, a delete still removes the key from every
archived copy, and `storage-environment-privacy.test.ts` still passes.

### Code

Each step is its own PR and keeps behaviour identical. **Every step must update
the storage entry in `PINNED_CHAINS` in `tests/unit/inheritance-chains.test.ts`**:
remove the classes the step took out of the chain, and keep `plan` pointing at
this file for as long as the chain exists. When the last step removes the
chain, remove the entry, and delete this file in the same change.

1. **Guard tests first**, while every write path is in view:
   - a static test that `saveJson(` and `saveSensitiveJson(` appear only
     inside a `serializeMutation` or `enqueue*Mutation` callback, or in one of
     the allowlisted helpers above (plus `saveLinearAuth`);
   - and either a test that rejects any store written by both `updateStore`
     and `saveJson`, or a change so that `saveStore` passes the revision seen
     at load time. With the revision, a mixed write throws `StoreConflictError`
     instead of silently deleting the other writer's row. That needs `loadJson`
     to record the revision per atomic scope.
2. **Introduce `StorageContext`.** Move the database handle, atomic scope,
   mutation tails, the store primitives, `resourceGeneration`, change
   observers, `announce` and `scopedChanges` into one object the facade owns.
   `StorageBase` forwards to it. Write the full lease order on
   `StorageContext.serialize`: projects → environments → others, and per-key
   work fence → native session lease → leaf leases.
3. **Extract the leaf repositories**, one layer per PR, each with
   `StorageService` delegating to it:
   - preview services;
   - agent mail;
   - Kanban, except `setAllEnvironmentStatusesForContainer`;
   - drafts (file drafts, handoffs);
   - public operations.
4. **Extract the entangled repositories**, replacing each abstract hook with a
   constructor dependency:
   - projects and environments (project removal fences,
     `deleteComposeDraftsByProject`);
   - sessions (buffers, `deleteSessionBuffer`);
   - native agent sessions and the prompt queue (the claim-recovery timer);
   - reviews;
   - build pipelines. `BuildPipelineService` already calls
     `storage.getBuildPipeline` and `storage.saveBuildPipeline` directly
     (`build-pipeline-context.ts`).
5. **Delete the empty chain.** `StorageService` becomes a plain class holding
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
          dataDir, database, resourceGeneration,
          stores: { read, update, updateRow, save, serialize, atomically },
          changes: { announce, observers, scopedChanges },
        }
```

Done when:

- `StorageService` has no `extends`, `StorageBase` is gone, and the pinned
  entry is removed from `inheritance-chains.test.ts`;
- every database-store write goes through `updateStore`/`updateStoreRow`, or
  through `saveJson` inside a `serializeMutation` callback, and a guard test
  enforces it;
- no store is written by both `updateStore` and `saveJson`, or `saveStore`
  enforces `expectedRevision`.

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
  That is why the guard in step 1 comes first.
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

## Needs verification

- That every `saveJson` call site is really under a lease. The sweep matched
  enclosing-method text, not call graphs; the guard test in step 1 settles it.
- That no store is currently written by both `updateStore` and a leased
  `saveJson`.

## Related

- [native-agent-service-collaborators.md](native-agent-service-collaborators.md):
  its prompt-queue dispatcher must keep its ordering against
  `enqueueNativeAgentSessionMutation`.
- [backend-core-domain-folders.md](backend-core-domain-folders.md): the
  `storage` folder slice is in its last wave; landing the repositories first
  means the move is done once.
- [`storage.md`](../architecture/storage.md) ("Concurrency"), `AGENTS.md`
  ("Storage rules", "Splitting large classes").
- Living-doc drift to fix in `storage.md` "Concurrency": the `atomically`
  bullet still names "the prompt queue to compose-draft transfer" as a user.
  #980 removed that transfer; the remaining caller is the public-operation
  namespace retirement (`collectPublicOperations`). The section also does not
  state the mixed-write hazard described above.

## Replaces

- `docs/2026-10-14/01-storage-json-file-store-and-repositories.md`
