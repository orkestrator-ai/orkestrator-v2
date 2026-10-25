# Storage service repositories

Checked against `main` at `2459b05c` (2026-10-15). Step 1 (`StorageContext`)
was done on top of `b83ae534` (2026-10-22). Steps 2 to 4 and the follow-up
were done on `todo-0009-storage-repositories-4696a61ea39f` from `00a0cb82`
(2026-10-25). **Every item below is done.** The durable description is in
[`storage.md`](../../architecture/storage.md) ("Code layout" and
"Concurrency"); the facade's size is followed up in
[0163-storage-facade-size.md](0163-storage-facade-size.md). Delete this file
and its index row once the branch has merged (decision 12).

`StorageService` was one class cut by size into a 14-layer `extends` chain, so
every layer shared `StorageBase`'s protected state and reading one store meant
reading all of them. The goal was one facade with an unchanged public surface,
holding per-store repositories over a shared `StorageContext`, with the SQLite
write rules still enforced by tests so the lost-update bugs closed by the
SQLite migration cannot come back.

## Current state

- Every backend store except `config.json` lives in `orkestrator.sqlite`
  (`STORE_LAYOUTS` in `storage-stores.ts`). `StorageContext`
  (`storage-context.ts`) owns the shared state and the store primitives:
  the database handle and snapshot timers, the `atomically` scope, the
  per-target mutation tails, `serialize` (the lease, with the lease order in
  its doc comment), `acquireLease`, `loadJson`/`saveJson`/`saveSensitiveJson`/
  `deleteStore`, `updateStore`/`updateStoreRow` and the scrubbing helpers. Its
  `changes` (`StorageChanges`) owns announcements, the change journal and the
  revision manifests.
- `StorageService` (`storage.ts`) has no base class. It holds one private
  `StorageContext` and one private `StorageRepositories` registry
  (`storage-repositories.ts`), runs `init` (open, prompt-queue claim recovery,
  snapshots, config schema migration, native-session owner migration, in the
  old order) and `close`, exposes the change journal, and forwards each of its
  other public methods to one repository. Every public method name and
  signature is unchanged.
- The repositories, one per former layer file plus two split out of
  `storage.ts`: `ProjectsRepository`, `ConfigRepository`, `SessionsRepository`,
  `ReviewsRepository`, `NativeAgentSessionsRepository`, `PromptsRepository`,
  `BuildPipelinesRepository`, `DraftsRepository`, `AgentMailRepository`,
  `KanbanRepository`, `PreviewServicesRepository`, `NodesRepository`,
  `PublicOperationsRepository`, `CoordinatorsRepository`
  (`storage-coordinators.ts`) and `AgentAccountsRepository`
  (`storage-agent-accounts.ts`). Each takes the context, the shared path
  helpers (`StorageFiles`, `storage-files.ts`) and the registry, keeping only
  what it uses. `storage-base.ts` is deleted.
- The four abstract hooks are gone: prompt-queue claim recovery runs from the
  facade's `init` on `NativeAgentSessionsRepository`; project removal calls
  `this.repos.drafts.deleteComposeDraftsByProject`; session removal calls
  `this.repos.drafts.deleteSessionBuffer`; the prompt-queue fingerprint is
  `this.repos.prompts.promptQueueMessageFingerprint`. The native layer's
  placeholder coordinator methods are gone too: mail and drafts call
  `this.repos.coordinators` directly. Lease targets, labels and timeouts moved
  with their repository unchanged (`NATIVE_AGENT_SESSION_LOCK_TIMEOUT_MS` is
  now a static of `NativeAgentSessionsRepository`).
- `storage-writer-guards.test.ts` scans `StorageService` and every class it
  reaches through a typed field, resolving each call through the declared
  field types, and follows every repository method to its callers; only the
  facade's public methods are entry points. It also scans raw
  `StorageDatabase` writers elsewhere in the backend (the follow-up).
- `tests/unit/inheritance-chains.test.ts` has no pinned chain left;
  `PINNED_CHAINS` is an empty list kept so a chain a long-lived branch still
  carries fails as new.

## Outstanding work

### Code

1. ~~**Introduce `StorageContext`.**~~ Done 2026-10-22.
2. ~~**Extract the leaf repositories**~~ Done 2026-10-25: preview services,
   agent mail, Kanban, drafts (file drafts, handoffs) and public operations
   are `PreviewServicesRepository`, `AgentMailRepository`, `KanbanRepository`,
   `DraftsRepository` and `PublicOperationsRepository`, with `StorageService`
   delegating to them. `setAllEnvironmentStatusesForContainer`, the Kanban
   layer's one environment-store write, moved to `ProjectsRepository`, which
   owns that store (decision 10).
3. ~~**Extract the entangled repositories**, replacing each abstract hook with
   a dependency~~ Done 2026-10-25: projects and environments
   (`ProjectsRepository`, removal fences, `deleteComposeDraftsByProject` through
   the registry), sessions and pane layouts (`SessionsRepository`,
   `deleteSessionBuffer` through the registry), native agent sessions and the
   prompt queue (`NativeAgentSessionsRepository` with the claim-recovery timer,
   `PromptsRepository`), reviews (`ReviewsRepository`) and build pipelines
   (`BuildPipelinesRepository`). The dependency is the shared registry rather
   than a constructor argument per repository (decision 2).
4. ~~**Delete the empty chain.**~~ Done 2026-10-25: `StorageService` is a plain
   class holding the repositories, `storage-base.ts` is deleted, and the
   storage entry is removed from `PINNED_CHAINS`.

Each "every step" rule was kept, in one branch rather than one PR per step
(decision 1): the writer guard scans every class that writes stores, it
treats `this.context.saveJson`/`saveSensitiveJson`/`deleteStore` as
whole-value writes, `updateStore`/`updateStoreRow` as transactional ones,
`atomically` as the scope and `serialize` as a lease wrapper (target
parameter 0, operation parameter 2), it resolves stores named by a
repository's own `xFile()` helpers, and the "only StorageBase holds the
StorageContext" test became "only the scanned storage classes hold the
StorageContext" (decision 6).

Done when:

- ~~`StorageService` has no `extends`, `StorageBase` is gone, and the pinned
  entry is removed from `inheritance-chains.test.ts`~~ Done:
  `inheritance-chains.test.ts` passes with `PINNED_CHAINS` empty.
- ~~`storage-writer-guards.test.ts` still passes and scans every repository
  that writes stores~~ Done: 29 tests pass; "the scan covers the facade, every
  repository, …" asserts all 15 repositories, `StorageRepositories` and
  `StorageFiles` are scanned, and a class that holds a `StorageContext`
  without the facade reaching it fails the scan.

### Qualification

- ~~Run every `apps/backend/src/core/storage*.test.ts` after each step, plus
  `mise run test` before merging.~~ Done 2026-10-25; see "Validation
  evidence".
- ~~Move the protected-member casts onto repository APIs in the step that
  moves their store.~~ Done 2026-10-25. The per-file
  `(storage as unknown as { database })` casts (14 test files) now call
  `storageDatabase(storage)`, and the tests that patched protected members
  patch the context or the repository through `storageInternals(storage)`
  (`storage-test-support.ts`), the one cast left. Two tests still cast a
  repository to reach a private helper (`ensureAgentMailDirectoryFresh`,
  `buildPipelineTranscriptStore`); they are repository APIs, kept private.

### Follow-ups

- ~~Extend the writer guard to raw `StorageDatabase` writers outside the
  chain: resolve their store-name constants and fail when one writes a store
  the chain writes.~~ Done 2026-10-25: "raw StorageDatabase writers outside
  StorageService" in `storage-writer-guards.test.ts` (decision 11).

## Validation evidence

All on this branch, 2026-10-25.

- **Same write structure as before.** The analysis on `main` (`00a0cb82`, old
  guard) and on this branch (new guard) were dumped per store (kind, leases,
  number of write sites and of lease paths) and per write site (store, kind,
  member, primitive, number of paths and the names of the public methods they
  enter through). After normalising class names and the `context.` prefix the
  two dumps are identical: 40 stores, the same leases, the same 126 write
  sites and entry points.
- **The guard still catches a dropped lease across repositories.** Replacing
  `this.repos.projects.enqueueEnvironmentMutation` in what was then
  `KanbanRepository.setAllEnvironmentStatusesForContainer` with a plain call
  made "every whole-value write holds a lease …" fail on
  `ProjectsRepository.saveEnvironments ← KanbanRepository.setAllEnvironmentStatusesForContainer`;
  restored afterwards.
- **The raw-writer scan names every engine store**: 68 raw writes across 18
  store patterns (`workflow-results`, `environment-cleanup-ledger`,
  `web-annotations/*`, `transcript-artifacts/*`, `usage-history`,
  `design-canvases/dirty/*`, …), none of them a repository store.
- `bun test` of every `apps/backend/src/core/storage*.test.ts`,
  `apps/backend/tests/storage*.test.ts` and
  `tests/unit/inheritance-chains.test.ts`: 846 pass, 0 fail.
- `mise run typecheck`: no errors (backend: 1,531 and 1,036 files).
- `mise run lint`: exit 0, no finding in a changed file.
- First `mise run test` (head `f960eca3`): bridges and codex protocol lockfile
  passed; root failed one test (`mise-tasks.test.ts`: this file told the
  reader to run the backend package script instead of the mise task, fixed); the backend workspace failed 9 of 11,530: the
  8 routing tests above (fixed) and one timeout recorded as flake
  [0905](../../tests/flaky-tests/backend-services-and-tooling/0905-public-api-environment-create-replay-timeout.md)
  (its owner passed alone).
- Second `mise run test` (head `14213a95`, after those fixes): workspace
  (web, backend, desktop, web-public, cli, protocol, toolchain), root and
  agent-support tests and codex protocol lockfile passed; bridges failed one
  test, the known Codex flake
  [0492](../../tests/flaky-tests/agent-bridges/0492-codex-deleted-session-initial-retry-race.md)
  (no bridge code changed here), whose owner passed alone (123 pass).

## Assumptions and decisions

1. **One branch, not one PR per step.** Options: a PR per step as the file
   planned, or every step in this branch as the task asked. Chose one branch.
   Pros: the chain never exists half-converted, and one before/after guard
   comparison covers the whole change. Cons: one large diff (mostly
   mechanical `this.x` → `this.context.x` / `this.repos.y.x` rewrites); the
   review has to lean on the guard comparison above.
2. **Repositories reach each other through one registry.** Options: a
   constructor argument per dependency (needs setter injection for the cycles:
   projects ↔ drafts, native agent sessions ↔ prompts, sessions ↔ drafts),
   the facade itself as the registry (would make the repositories public on
   the facade), or a dedicated `StorageRepositories` class passed to each.
   Chose the registry. Pros: no construction-order or setter problems, one
   construction site, repositories stay private to the facade. Cons: a
   repository's dependencies are not listed in its constructor; grep
   `this.repos.` instead.
3. **Explicit forwarders on the facade.** Options: one written method per
   public method, forwarders generated at run time with an interface merge,
   or exposing the repositories as public fields. Chose explicit forwarders.
   Pros: typed signatures (including `cacheAgentModelCatalog`'s overloads,
   decision 9), greppable, and the writer guard reads them as the entry
   points. Cons: `storage.ts` is 2,464 lines, over the 2,000-line guideline;
   shrinking it needs callers narrowed to repositories, which this file's
   constraints keep out of scope ([0163](0163-storage-facade-size.md)).
4. **One repository per former layer.** Options: the finer target sketch
   (separate environments, pane-layout and prompt-queue repositories), or one
   repository per layer file. Chose per layer, plus `CoordinatorsRepository`
   and `AgentAccountsRepository` out of `storage.ts`. Pros: a mechanical,
   behaviour-identical conversion that keeps file history; each file still
   holds one area. Cons: `ProjectsRepository` holds projects and environments,
   `SessionsRepository` sessions and pane layouts, and prompt-queue code is
   split between `NativeAgentSessionsRepository` (persistence, claim recovery)
   and `PromptsRepository` (operations), as the layers were.
5. **Shared path helpers in `StorageFiles`.** Options: move each `xFile()` into
   its owning repository, store-name constants, or one small class with the
   base's helpers. Chose `StorageFiles` for the helpers the base had (several
   repositories name the same store) and left single-owner helpers private
   in their repository. Pros: the guard keeps grouping stores by helper name,
   unchanged store names in its summaries. Cons: one more shared class.
6. **Writer guard: per-class resolution, facade entry points.** Options: keep
   TypeScript visibility as the entry rule (a public repository method holds
   its own lease), add run-time lease assertions, or resolve calls through
   field types and treat only the facade's public methods as entries. Chose
   the last. Pros: helpers such as `saveEnvironments` can be called by another
   repository under the caller's lease, exactly as before; the result matches
   the old analysis store for store. Cons: correctness depends on nothing
   outside the storage files reaching a repository, so two structural checks
   were added (no backend code outside the storage files names
   `StorageContext` or a repository, and a class holding a `StorageContext`
   the facade does not reach fails), plus "a scanned class extends another"
   and "uses `this.context` as a value outside a constructor".
7. **Test access through `storage-test-support.ts`.** Options: keep the
   per-file casts, add test-only methods to the facade, or one helper.
   Chose `storageInternals` and `storageDatabase`. Pros: one cast, and
   production gets no test surface. Cons: tests that replaced a facade method
   to intercept an internal call must patch the repository instead (a
   repository calls another repository directly); `storage.md` says so.
   The first full `mise run test` found every test that depended on the old
   routing or on a former protected member: three in
   `storage-agent-mail.test.ts` (found earlier), plus
   `native-agent-queued-steer.test.ts` (4 tests),
   `public-api-command-surface.test.ts` (2), `commands-state-sync.test.ts`
   and `build-pipeline-transcript-checkpoints.test.ts`. Each now patches or
   calls the repository; no assertion changed.
8. **Removed `acquireConfigMutationLock` and `acquireEnvironmentMutationLock`.**
   No production code called them; one test took the config lease through
   the first and now takes the same lease (`config.json`, "configuration
   storage") through the context.
9. **`cacheAgentModelCatalog` overloads only on the facade.** The repository
   takes the union implementation signature, so the facade's overloads
   forward without a cast. Callers see the same overloads.
10. **`setAllEnvironmentStatusesForContainer` in `ProjectsRepository`.** Options:
    leave it in Kanban calling through the projects repository, or move it to
    the environment store's owner. Chose the move. Pros: Kanban writes only
    Kanban stores; the environment lease and its writers are in one file.
    Cons: none found; the facade method is unchanged.
11. **Raw-writer guard is static.** Options: a run-time owner tag per store in
    `STORE_LAYOUTS` checked in `StorageDatabase`, or a static scan. Chose the
    static scan, like the rest of the guard. It resolves store names through
    constants, templates, small name functions, constructor-set fields and
    row helpers that take the store as a parameter (followed to their
    callers), fails a write it cannot name, and exempts the legacy import and
    record upgrades (`storage-stores.ts`, `storage-record-upgrades.ts`), which
    run in the migration transaction at open. Pros: no run-time cost, sees
    every call site. Cons: a new engine whose store name is built some other
    way fails until the scan learns it (by design).
12. **Kept this file, marked Finished.** The file said to delete it with the
    last step; the task asked for decisions to be recorded here, so it stays
    until the branch merges, like 0010, 0011, 0013 and 0066.
13. **`PINNED_CHAINS` kept as an empty list.** Deleting the mechanism would let
    a long-lived branch's chain reappear unflagged; an empty list costs
    nothing.

## Constraints and rationale

- `StorageService` keeps every public method name and signature. More than a
  hundred backend files reach it, mostly through `CommandContext.storage`;
  narrowing them to repositories is a separate change
  ([0163](0163-storage-facade-size.md)).
- The facade's `atomically` stays one `AsyncLocalStorage` scope on
  `StorageContext`, shared by every repository.
- Never hold a SQLite transaction across an `await`. Use `updateStore` or
  `updateStoreRow` for a synchronous read-modify-write, `serialize` for one
  that awaits, and under a per-key lease write only that key's row
  (`AGENTS.md` "Storage rules").
- A lease only excludes other lease holders. Mixing an unleased `updateStore`
  writer with a leased `saveJson` writer on one store loses updates, because
  `saveJson` writes the whole value as a row diff against the current rows.
  `storage-writer-guards.test.ts` rejects any store that mixes them.
- Three leases are held across external I/O on purpose: native agent
  sessions, project creation and GitHub completion comment posting.
- `config.json` stays a file, serialised by the `configuration storage` lease.
  The only desktop writer is `applyAgentTestPlatformSelection`
  (`apps/desktop/electron/agent-platform-selection.ts`), which runs for
  agent-test profiles before the backend starts.
- **The writer guard is static and test-only.** A run-time check would only see
  the paths tests exercise and could only tell that *some* lease is held. The
  static scan sees every call site and checks that every writer of a store
  holds the same lease.
- **Mixed writers are rejected, not detected at run time.** Passing the
  revision `loadJson` saw to `saveStore` would turn a code rule into
  production failures.
- **Guard rules.** A lease target built from a key does not count as
  store-wide. Code between the lease callback and the write may not start
  another function, and a helper used as a value fails the scan. An
  `updateStore` reached from inside `atomically` counts as a whole-value write.

## Related

- [0163-storage-facade-size.md](0163-storage-facade-size.md): narrowing callers
  and the facade's size.
- [0010-native-agent-service-collaborators.md](0010-native-agent-service-collaborators.md):
  its prompt-queue dispatcher keeps its ordering against
  `enqueueNativeAgentSessionMutation`.
- [0012-backend-core-domain-folders.md](0012-backend-core-domain-folders.md): the
  `storage` folder slice is in its last wave; the repositories now exist, so
  the move is done once.
- [`storage.md`](../../architecture/storage.md) ("Code layout", "Concurrency"),
  `AGENTS.md` ("Storage rules", "Splitting large classes").

## Replaces

- `docs/2026-10-14/01-storage-json-file-store-and-repositories.md`
