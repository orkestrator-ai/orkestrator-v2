# 01 — StorageService: from a 14-class chain to per-store repositories

Status: Revised 2026-10-15. The SQLite migration (`c95479da`, #969) replaced
the JSON persistence this plan was written against. The `JsonFileStore` step
and the four lost-update gaps are obsolete: the gaps are closed and
regression-tested in `storage-store-concurrency.test.ts`. The
inheritance-chain decomposition still applies (steps 1–4 below; none started).
Priority: first among the decomposition plans, but no longer a correctness
fix.

## What changed since the first draft

The first draft (2026-10-14, written against `d4dfa11d`) proposed a shared
`JsonFileStore<T>` + `FileLock` to replace about a dozen copy-pasted
`enqueueXMutation` bodies, and to close four unserialised JSON
read-modify-write writers. #969 landed the same day and made most of that
moot:

| First-draft concern | Now |
| --- | --- |
| Every store is a JSON file written via `writeAtomic` + backup ladder | Every backend store except `config.json` lives in `orkestrator.sqlite` (`storage-stores.ts` `STORE_LAYOUTS`). `loadJson` / `saveJson` keep their names but route to the database for those stores (`storage-base.ts` `saveStore`, `loadStore`). |
| Cross-process file lock, hand-rolled per store | `serializeMutation(target, label, op, opts)` (`storage-base.ts`): an in-process tail per lease name plus a database lease (`StorageDatabase.acquireLease`). This *is* the shared primitive the draft wanted. |
| `enqueueXMutation` bodies copy-pasted and drifting | Each `enqueueXMutation` is now a one-line wrapper over `serializeMutation` that fixes the lease target, label and timeout. No `xMutation` queue fields remain. |
| No safe RMW without a lock | `updateStore` / `updateStoreRow`: a synchronous read-modify-write in one `IMMEDIATE` SQLite transaction. SQLite's write lock serialises it across backends; no lease needed. |
| No multi-store commit | `atomically(op)` buffers every store write and commits them in one transaction. |
| Backups, sensitive-mode 0600, backup scrubbing | The database file is private. Records deleted from sensitive stores are scrubbed via `secure_delete` plus WAL truncation (`scrubDeletedDatabaseContent`), and imported legacy archives are scrubbed too (`scrubLegacyJsonStore`). The backup ladder survives only for `config.json`. |

The rules are in `AGENTS.md` ("Storage rules") and
`docs/architecture/storage.md` ("Concurrency").

### The four gaps are closed

| Store | First-draft finding | Now |
| --- | --- | --- |
| `sessions` | No serialisation | `createSession`, `updateSession`, `removeSession`, `removeSessionsByEnvironment`, `disconnectEnvironmentSessions` and `reorderSessions` all use `updateStore` (`storage-sessions.ts`, `storage-drafts.ts`) |
| `project-notes` | No serialisation | `saveProjectNotes` uses `updateStore` (`storage-kanban.ts`) |
| `linear-completion-comments` | No serialisation | `saveLinearCompletionComment` uses `updateStore`; so does the GitHub equivalent |
| `feature-plans` | In-process queue only | `mutateFeaturePlans` uses `updateStore` |

`storage-store-concurrency.test.ts` runs 16 concurrent writes split across two
`StorageService` instances on one data directory, for each of the four stores,
and asserts that none are lost. It passes on the current code. As a check,
reverting `saveProjectNotes` to `loadJson → await → saveJson` makes the
project-notes case fail (`Expected: "note 0"`, `Received: ""`).
`storage-atomic.test.ts` covers the primitives themselves: `serializeMutation`
excludes two backends, a failed mutation does not wedge the queue, and
`updateStore` serialises two backends without a lease.

### Audit of the remaining write paths (2026-10-15)

A scripted sweep of the non-test `storage*.ts` files found:

- Every `saveJson` / `saveSensitiveJson` call is inside a `serializeMutation`
  wrapper. Some are reached through helpers (`saveEnvironments`,
  `saveAgentMailStore`, `savePromptQueueMutation`, `saveNamespaceRecords`,
  `applyProjectUpdates`), and every caller of those helpers holds the lease.
  The one unguarded call is `saveLinearAuth`, which is a blind overwrite, not
  a read-modify-write.
- No store is written both by `updateStore` (no lease) and by
  `saveJson`-under-lease. This matters: see the next section.

The sweep matched enclosing-method text, not real call graphs, so it is a
heuristic. The guard test proposed below would make it enforceable.

## Concurrency gaps that remain

None is a known bug today. Each is a way to reintroduce one:

1. **Mixing the two write paths on one store loses updates.** A lease only
   excludes other lease holders. `saveJson` on a database store writes the
   whole value as a row diff against the *current* rows, without
   `expectedRevision`. Suppose someone adds an `updateStore` writer to a store
   that is otherwise written under a lease, such as `kanban` or
   `environments`. That write can commit between the lease holder's
   `loadJson` and its `saveJson`, and the `saveJson` then silently deletes it.
   Today no store mixes the two paths.
   - *Cheap fix:* have `saveStore` pass the revision observed at load time
     (`expectedRevision`), so this race throws `StoreConflictError` instead of
     losing data. That needs `loadJson` to record the revision per scope.
   - *Or:* add a guard test that rejects a store with both `updateStore` and
     `saveJson` writers.
2. **Unguarded `saveJson` is still callable.** The draft's "`mutate` is the
   only write API" property does not hold. A new `loadJson → await → saveJson`
   outside a lease would race just as the four old gaps did. Add a grep or
   AST test: `saveJson(` / `saveSensitiveJson(` may only appear lexically
   inside a `serializeMutation` / `enqueue*Mutation` callback or an allowlisted
   helper.
3. **`config.json` is still a file.** Backends serialise on the
   `configuration storage` lease. The desktop process
   (`apps/desktop/electron/backend-process.ts`) only writes it when seeding a
   new data directory, before the backend starts, so no live race is known. A
   desktop writer added later would not be covered by the lease.

## Still applies: decompose the inheritance chain

The chain is unchanged by #969:

`StorageBase → StorageProjects → StorageConfig → StorageSessions →
StorageReviews → StorageNative → StoragePrompts → StorageBuildPipelines →
StorageDrafts → StorageAgentMail → StorageKanban → StoragePreviewServices →
StoragePublicOperations → StorageService`

That is about 14.2k lines across the 14 files. `StorageBase` still declares
abstract hooks that later layers implement (`recoverExpiredPromptQueueClaims`,
`promptQueueMessageFingerprint`, `deleteComposeDraftsByProject`,
`deleteSessionBuffer`). Every layer still shares `StorageBase`'s protected
state. The persistence primitives (`database`, `updateStore`,
`updateStoreRow`, `serializeMutation`, `atomically`, `announce`, the
atomic-scope `AsyncLocalStorage`) all live on `StorageBase`, so they move out
first.

### Target design

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

`StorageContext` replaces the draft's `JsonFileStore`. It wraps the existing
`StorageBase` primitives unchanged, including the atomic scope, so
repositories share one buffered transaction when the facade runs
`atomically`. Lease targets, labels and timeouts stay where they are:
`NATIVE_AGENT_SESSION_LOCK_TIMEOUT_MS` (180 s) and the project-creation stale
and timeout values (90 s / 660 s) move with their repository.

`StorageService` keeps every public method name and signature, and delegates.
Consumers (`CommandContext.storage`, `commands-registry-types.ts`, about 148
backend files) don't change. Narrowing them to repositories is a separate
change.

### Steps (each a separate PR)

1. **Introduce `StorageContext`.** Move the database handle, `atomicScope`,
   `mutationTails`, `updateStore` / `updateStoreRow` / `loadJson` /
   `saveJson` / `serializeMutation` / `atomically`, `resourceGeneration`,
   change observers, `announce` and `scopedChanges` into one object the facade
   owns. `StorageBase` forwards to it. Behaviour-preserving; the existing
   storage tests are the oracle. Add the guard tests from "Concurrency gaps
   that remain" (2) here, while every write path is in view.
2. **Extract leaf repositories** that make no cross-store calls: preview
   services, agent mail, Kanban (minus `setAllEnvironmentStatusesForContainer`),
   drafts (file drafts, handoffs), public operations. Each PR moves one layer's
   methods into `XRepository`, has `StorageService` delegate to it, and removes
   the layer from the chain.
3. **Extract the entangled ones**: projects and environments (project removal
   fences, `deleteComposeDraftsByProject`), sessions (buffers), native agent
   sessions and the prompt queue (the claim-recovery timer), reviews, build
   pipelines. Replace each abstract hook in `StorageBase` with an explicit
   constructor dependency.
4. **Delete the empty chain.** `StorageService` becomes a plain class that
   holds the repositories. `StorageBase` goes away.

### Cross-store transactions to watch

These work today because one `this` reaches every store. Each needs an
explicit dependency:

- Project removal: projects → environments → compose drafts → sessions
- Session removal → `deleteSessionBuffer`
- Prompt queue claim recovery (timer in base, logic in native)
- Environment status updates called from Kanban
  (`setAllEnvironmentStatusesForContainer`)
- Sensitive scrubbing for pending native-agent dispatch and steer
  (`storage-base.ts`, `transformSensitiveJsonBackups` on
  `nativeAgentSessionsFile`)
- Any caller of `atomically` that spans repositories: the scope must stay one
  `AsyncLocalStorage` on `StorageContext`, not one per repository

Lease order is already documented on `enqueueNativeAgentSessionMutation`
(per-key work fence → native session lease → leaf leases). Write the full
order (projects → environments → others) on `StorageContext.serialize`.

## Tests

- Existing: `apps/backend/src/core/storage-*.test.ts`, including
  `storage-atomic.test.ts` and `storage-store-concurrency.test.ts`. Run all of
  them after every step.
- About 30 `as unknown as` casts across 12 storage test files reach into
  protected members. Move each one to the repository API in the step that
  moves its store.

## Done when

- `StorageService` has no `extends`, and `StorageBase` is gone.
- Every database-store write goes through `updateStore` / `updateStoreRow`,
  or through `saveJson` inside a `serializeMutation` callback, and a guard
  test enforces it.
- No store is written by both `updateStore` and `saveJson`, or `saveStore`
  enforces `expectedRevision`.
