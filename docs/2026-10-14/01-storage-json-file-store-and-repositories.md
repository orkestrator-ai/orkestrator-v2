# 01 — StorageService: a shared `JsonFileStore<T>` and per-store repositories

Status: Proposed (2026-10-14). Priority: first. This is the only chain where
the refactor also fixes correctness gaps.

## Problem

`StorageService` (`apps/backend/src/core/storage.ts`) is the bottom of a
14-class `extends` chain:

`StorageBase → StorageProjects → StorageConfig → StorageSessions →
StorageReviews → StorageNative → StoragePrompts → StorageBuildPipelines →
StorageDrafts → StorageAgentMail → StorageKanban → StoragePreviewServices →
StoragePublicOperations → StorageService`

It is about 16.8k non-test lines. The chain comes from the mechanical module
split in `7aee8366` (#417). It is not a designed hierarchy: every layer shares
the protected state in `storage-base.ts`, and the base declares abstract
methods (`recoverExpiredPromptQueueClaims`, `deleteComposeDraftsByProject`,
`deleteSessionBuffer`, …) that later layers implement.

### The persistence primitive is copy-pasted, and the copies have drifted

`storage-base.ts:720-1027` holds about a dozen near-identical
`enqueueXMutation` methods. More copies live in `storage-config.ts` (two model
catalogues), `storage-native.ts` (prompt queue), `storage-prompts.ts` (compose
drafts), `storage-drafts.ts` (file drafts, handoffs), `storage-agent-mail.ts`
and `storage-kanban.ts`. Each one hand-writes the same steps:

1. an in-process promise queue field (`xMutation: Promise<unknown>`),
2. `acquireMutationLock(file, label, opts)` for the cross-process file lock,
3. `try { op() } finally { release() }`,
4. the `next.then(() => undefined, () => undefined)` tail.

Because every store re-implements this, coverage is inconsistent:

| File | Writers | Serialization |
| --- | --- | --- |
| `sessions.json` | `createSession` (`storage-sessions.ts:153`), `updateSession`, `removeSession`, `removeSessionsByEnvironment` (`storage-drafts.ts:697-726`) | **None.** Plain load → mutate → save |
| `project-notes.json` | `saveProjectNotes` (`storage-kanban.ts:476`) | **None** |
| `linear-completion-comments.json` | `saveLinearCompletionComment` (`storage-kanban.ts:812`) | **None** |
| `feature-plans.json` | `mutateFeaturePlans` (`storage-kanban.ts:500`) | In-process queue only, no cross-process lock |
| Most others | `enqueueXMutation` | Queue plus file lock |

`storage-base.ts:188` states that other backend processes may share the data
directory, so the first four rows can lose updates. These gaps come from
reading the code; no lost write has been reproduced yet. Step 1 adds tests
that should show them.

## Target design

```text
StorageService (facade, same public surface)
 ├─ ProjectsRepository        ─┐
 ├─ EnvironmentsRepository     │
 ├─ SessionsRepository         │  each owns one or more
 ├─ PaneLayoutsRepository      │  JsonFileStore<T> instances
 ├─ ConfigRepository           │
 ├─ ReviewsRepository          │
 ├─ NativeAgentSessionsRepo    │
 ├─ PromptQueueRepository      │
 ├─ DraftsRepository           │
 ├─ AgentMailRepository        │
 ├─ KanbanRepository           │
 ├─ PreviewServicesRepository  │
 └─ PublicOperationsRepository ┘
        shared: StorageContext { dataDir, resourceGeneration, changes (announce/observers), lockFactory }
```

### `JsonFileStore<T>`

A new file, `apps/backend/src/core/storage/json-file-store.ts`:

```ts
interface JsonFileStoreOptions<T> {
  file: string;                 // absolute path
  lockLabel: string;            // "project storage", used in timeout errors
  fallback: () => T;
  sensitive?: boolean;          // 0600 + backup scrubbing (saveSensitiveJson path)
  lock?: { staleMs?: number; acquireTimeoutMs?: number } | false; // false = in-process only, must be explicit
  migrate?: (raw: unknown) => T;
  cache?: boolean;              // the loadJsonCached fingerprint cache
}

class JsonFileStore<T> {
  read(): Promise<T>;                                   // no lock, may use the cache
  mutate<R>(fn: (value: T) => R | Promise<R>): Promise<R>; // queue + lock + load + fn + atomic save
  withLock<R>(fn: () => Promise<R>): Promise<R>;        // for multi-file transactions that already exist
}
```

- `mutate` is the only write API, so an unlocked read-modify-write can't be
  written by mistake. If `fn` throws, nothing is saved and the queue moves on,
  as `mutateFeaturePlans` already does.
- It reuses the existing `writeAtomic`, `rotateBackups`,
  `recoverJsonFromBackups`, `loadJson` / `loadJsonCached` and
  `acquireMutationLock` code, moved out of `StorageBase` into the store and a
  `FileLock` helper. Locking behaviour and timeouts stay as they are.
- Every store keeps its current lock label and timeout. In particular,
  `NATIVE_AGENT_SESSION_LOCK_TIMEOUT_MS` stays at 180 s, and the
  project-creation lock keeps its stale and timeout values.
- Resource change events (`announce`) remain the caller's job, in
  `StorageContext`. The store doesn't know about resource kinds.

### The facade

`StorageService` keeps every public method name and signature. Each method
delegates to a repository. The ~148 non-test backend files that use
`storage.*`, `CommandContext.storage` and `commands-registry-types.ts` don't
change. Consumers can be narrowed to the repositories they use later, as a
separate change.

## Steps (each one is a separate PR)

1. **Add `JsonFileStore` and close the gaps.**
   - Add `JsonFileStore` and `FileLock` with unit tests: in-process
     serialization, cross-process lock (two `StorageService` instances on one
     `dataDir`), throw-means-no-save, sensitive mode, backup recovery.
   - Add failing concurrency tests for `sessions.json`, project notes, Linear
     completion comments and feature plans: run N concurrent `createSession` /
     `saveProjectNotes` calls and assert none are lost.
   - Route those four files through `JsonFileStore.mutate` while they still
     live in the inheritance chain. The tests should go green.
2. **Replace the remaining `enqueueXMutation` copies** with `JsonFileStore`
   instances held as fields on `StorageBase`. Delete the per-store
   `xMutation` queue fields. This is behaviour-preserving, and the existing
   storage tests are the oracle.
3. **Introduce `StorageContext`.** Move `dataDir`, `resourceGeneration`,
   change observers, `announce` and `scopedChanges` into one object that the
   facade owns.
4. **Extract the repositories one at a time**, starting with the leaves that
   have no cross-store calls: preview services, agent mail, kanban, drafts,
   public operations. Then do the entangled ones: projects and environments
   (project removal fences, `deleteComposeDraftsByProject`), sessions (buffers),
   native and prompt queue (claim recovery timer). Each PR moves a layer's
   methods into `XRepository`, has `StorageService` delegate to them, and
   removes the layer from the chain.
5. **Delete the empty chain.** `StorageService` becomes a plain class holding
   repositories. `StorageBase` goes away.

## Cross-store transactions to watch

These currently work because one `this` can reach every queue. Each one needs
an explicit dependency, passed in through the repository constructor:

- Project removal: projects → environments → compose drafts → sessions
- Session removal → `deleteSessionBuffer`
- Prompt queue claim recovery (timer in base, logic in native)
- Environment status updates called from kanban
  (`setAllEnvironmentStatusesForContainer`)
- Sensitive backup scrubbing for pending native-agent dispatch and steer

Never take two store locks in different orders. Write down the lock order
(projects → environments → others) in the `JsonFileStore` doc comment.

## Tests

- Existing: `apps/backend/src/core/storage-*.test.ts`. Run all of them after
  every step.
- New: `json-file-store.test.ts`, plus concurrency tests per migrated store.
- Check for tests that reach into `StorageBase` protected members
  (`as unknown as`). Migrate them to the repository API in the step that moves
  their store.

## Done when

- No `enqueueXMutation` methods or `xMutation` queue fields remain.
- Every JSON read-modify-write goes through `JsonFileStore.mutate`. Add a grep
  test that rejects `saveJson(` / `saveSensitiveJson(` outside
  `storage/json-file-store.ts`.
- `StorageService` has no `extends`.
