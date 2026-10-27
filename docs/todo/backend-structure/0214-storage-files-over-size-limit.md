# Storage files over the size limit

Checked against `main` at `93018933` and the 0163 branch
(`todo-0163-storage-facade-size-a8e92b2563c1`), 2026-10-26. Found while
validating [0163-storage-facade-size.md](0163-storage-facade-size.md), whose
scope named only `storage.ts` and `storage-agent-mail.ts`.
Done on `todo-0214-storage-files-over-size-limit-e4d9bb3f3d4f` from `main` at
`863b5782` (2026-10-27). **Every item below is done.** The durable description
is in [`storage.md`](../../architecture/storage.md) (the file table and "Code
layout"). Delete this file and its index row once the branch has merged
(decision 7).

Two storage source files were over the 2,000-line limit in `AGENTS.md`
("General guidance"), unchanged by 0009 and 0163:
`apps/backend/src/core/storage-shared-core.ts` (2,187 lines, the record types
and pure helpers every repository shares, re-exported through
`storage-shared.ts`) and `apps/backend/src/core/storage-native.ts`
(`NativeAgentSessionsRepository`, 2,015 lines).

## Current state

- `storage-shared-core.ts` is 603 lines: the base JSON guards (`isRecord`,
  `isNonBlankString`, `isPortMapping`, …), the Kanban, feature-plan, Linear and
  GitHub record types, `slugify` and the environment/project/session
  constructors, `exists`/`isMissingFileError`, and the protocol names
  re-exported for `shared.X` callers. It imports none of the topic modules.
  The rest moved verbatim into six topic modules, each importing what it uses
  from the core and from the protocol packages directly:

  | Module | Lines | Holds |
  | --- | --- | --- |
  | `storage-shared-pane-layout.ts` | 233 | Pane-layout bounds and generation checks, `paneLayoutLeaves`, the setup handoff helpers |
  | `storage-shared-agent-activity.ts` | 123 | Per-source and frontend-observer activity reads, the structure fingerprint, the aggregate |
  | `storage-shared-records.ts` | 225 | Guards for looped and Multi Review workflows, prompt queues, compose and file drafts, handoffs, build pipelines; the tmux queue-key owner check; build reservation keys |
  | `storage-shared-native-sessions.ts` | 257 | The native session record guard and pre-policy migration, `LoadedNativeAgentSessions`, interaction metadata, the pending dispatch/steer size limits |
  | `storage-shared-model-catalogs.ts` | 357 | Claude, Codex and ACP catalogue normalization and the persisted catalogue cache |
  | `storage-shared-config.ts` | 465 | Config validation, the review-instruction migration, `normalizePersistedConfig`, `defaultConfig`, `defaultRepositoryConfig`, and the OpenCode model helpers' re-export |

  `storage-shared.ts` re-exports all of them (and `storage-shared-extra.ts`,
  unchanged), so no caller of `storage-shared.ts` changed. Of the seven files
  that imported `storage-shared-core.ts` directly, only
  `workflow-tab-actions.ts` used a moved name; it now imports the pane-layout
  helpers from their module. `tests/unit/version-drift.test.ts` reads
  `defaultConfig`'s allowlist from `storage-shared-config.ts`.
- `NativeAgentSessionsRepository` (`storage-native.ts`) is 1,192 lines: the
  session records and their per-key lease, owner migration, create/adopt,
  controls, resume identity, invalidation, display tails, environment
  deletion, the interaction journal, incomplete-turn notices, turn outcomes
  and interrupts, the environment fences and the publication snapshot. Two
  collaborators took the rest, reached through `StorageRepositories` like the
  agent mail classes (0163, decision 6):
  - `PromptQueueStore` (`storage-prompt-queue-store.ts`,
    `repos.promptQueues`): the prompt-queue lease
    (`enqueuePromptQueueMutation`), `loadPromptQueues`, message validation,
    `savePromptQueueMutation` with its removed-origin tombstones and live-claim
    exclusion. [0078](../cross-cutting/0078-legacy-prompt-queue-claim-state.md)
    normalizes expired or malformed legacy claims on every load; the startup
    recovery, timer and usage counter are retired.
  - `NativeAgentDeliveries` (`storage-native-deliveries.ts`, 678 lines,
    `repos.nativeAgentDeliveries`): the dispatch journal
    (`dispatchNativeAgentPromptOnce`, confirm, clear, retire) and the steer
    journal (reserve a queued steer, dispatch, reconcile, recover, confirm,
    clear, the settlement helpers and the steer backup scrub).

  The repository's `enqueueNativeAgentSessionMutation`,
  `assertReadableNativeAgentSession`, `announceNativeAgentRecord` and
  `scrubPendingNativeAgentDispatchBackups` became public, since the
  deliveries call them. `PromptsRepository`, `NativeAgentSessionsRepository`
  and the facade's delivery forwarders call the new owners;
  no facade method changed name or signature.
- No `storage*.ts` source file is over 2,000 lines. Two test files are
  (`storage-agent-mail.test.ts`, 2,292; `storage-writer-guards.test.ts`,
  2,480, plus `storage.test.ts`, 4,322); they were outside this file's scope
  and are not followed up here.

## Outstanding work

### Code

- ~~Split `storage-shared-core.ts` by topic into modules (for example agent
  activity, interaction journal, prompt queue records, model catalogues),
  keeping `storage-shared.ts` as the re-export surface so callers do not
  change.~~ Done 2026-10-27: six topic modules (decisions 1–3).
- ~~Split `NativeAgentSessionsRepository` by responsibility into collaborators
  sharing the context through the `StorageRepositories` registry, as 0163 did
  for agent mail (for example prompt-queue persistence and claim recovery
  apart from the session records), following "Splitting large classes" in
  `AGENTS.md`.~~ Done 2026-10-27: `PromptQueueStore` and
  `NativeAgentDeliveries`, no `extends` (decisions 4–6).

### Qualification

- ~~Run every `apps/backend/src/core/storage*.test.ts`, including
  `storage-writer-guards.test.ts` (its analysis should match before and
  after, store for store, as in 0163), plus `mise run test`.~~ Done
  2026-10-27; see "Validation evidence".

## Validation evidence

All on this branch, 2026-10-27.

- **Same write structure as `main`.** The guard's full analysis was dumped
  with a throwaway test appended to `storage-writer-guards.test.ts` (not
  committed) on the base (`863b5782`) and after the split: per store (kind,
  store-wide leases, site and path counts) and per write site (store, kind,
  writing member, and every path's leases, keyed or not, entry point name and
  problem). Result: 40 stores, identical; 126 write sites, identical except
  for the class of four writing members, with the same store, kind, leases
  and entry points:
  `reservePromptQueueSteer` and `settlePromptQueueSteerSource` now on
  `NativeAgentDeliveries`, `savePromptQueueMutation` and
  `recoverExpiredPromptQueueClaims` on `PromptQueueStore`. No violations
  before or after. The guard now also lists both classes in `REPOSITORIES`,
  so "the scan covers the facade, every repository, …" fails if either drops
  out of the scan. `storage-writer-guards.test.ts`: 36 pass.
- `bun test --parallel=6` of every `apps/backend/src/core/storage*.test.ts`,
  `apps/backend/tests/storage*.test.ts`, `src/core/native-agent*.test.ts`,
  `src/core/prompt-queue*.test.ts`, `project-home-environment.test.ts` and
  `preview-port-publication.test.ts` (103 files): 1,917 pass, 0 fail.
  `native-agent-queued-steer.test.ts` spies on the settlement helper on its
  new owner. `tests/unit/version-drift.test.ts`: 65 pass.
- `mise run typecheck`: no errors. `mise run lint`: exit 0, no finding in a
  changed file (six existing warnings in bridge and e2e tests).
  `mise run format:check`: clean.
- `mise run test` at `555cf0282`: exit 1 (812 s). Bridges and the Codex
  protocol lockfile passed; web 9,941 pass; backend 12,043 pass, 120 skip,
  9 fail; desktop 2 fail; root 3,526 pass, 2 fail. None of the failing files
  is touched or reached by this change. `container-replacement` (two
  five-second deadlines) and `container-storage` (one) passed alone, as
  recurrences of flakes 0244 and 0672. `staged-input-relay` (4),
  `docker-image` pinned identity (2), `profile-cleanup` (2) and `migrate-copy`
  (2) fail alone too, and fail identically on a detached worktree of the base
  `863b5782`, so they were already failing before this change. All of it is
  recorded in flake case
  [1150](../../tests/flaky-tests/aggregate-validation-runs/1150-storage-files-size-0214-validation.md).

## Assumptions and decisions

1. **Six topic modules beside a smaller core, not a core rename.** Options:
   keep `storage-shared-core.ts` as the base and move topics out; dissolve it
   into topic files only (its direct importers and the `storage-shared-extra.ts`
   namespace import would all change); or one `storage-shared-records.ts` for
   every guard. Chose the base plus six topics. Pros: the six direct
   importers that use only base names (`isRecord`, `createEnvironment`,
   `isPortMapping`, `KanbanTask`) did not change, and each topic file reads as
   one subject. Cons: seven files where there was one; the core still carries
   the protocol re-export block, which is what keeps it at 603 lines.
2. **The core imports no topic module.** Options: re-export the topics from
   the core too (so `storage-shared-core.ts` stayed a complete surface) or
   only from `storage-shared.ts`. Chose `storage-shared.ts` only: the topics
   import their helpers from the core, so a core that re-exported them would
   be an import cycle. Pros: no cycle; the one direct importer of a moved name
   now names its module. Cons: `storage-shared-core.ts` is no longer the whole
   surface, which the comment at its top says.
3. **Moved code is byte-for-byte, imports rewritten.** Each topic imports
   protocol names from the protocol package rather than through the core's
   re-exports, and `defaultConfig` went with config normalization, so the
   version-drift test now reads `storage-shared-config.ts`. Pros: a rebase
   over a branch that edited one of these functions moves a hunk, it does not
   merge two versions. Cons: the "interaction journal" topic the item named
   has no module: the core only re-exports the protocol's journal helpers, and
   the journal's storage is on the repository.
4. **Two collaborators: prompt-queue persistence and the delivery journals.**
   Options: prompt-queue persistence alone (about 1,820 lines left, a thin margin);
   that plus the dispatch and steer journals; or also display tails and the
   interaction journal (about 100 lines, each a small cohesive section). Chose
   the two. Pros: the repository keeps the session record and what reads it,
   the deliveries are the one place a request is parked and settled, and the
   file is at 1,192 lines. Cons: `NativeAgentDeliveries` (678 lines) is the
   biggest new file; the queued-steer settlement writes the prompt-queue
   store from the deliveries class, under the queue store's lease, as it did
   from the repository.
5. **Peers in the registry, the session lease kept on the repository.**
   Options: a shared `NativeAgentSessionStore` (lease, load, save, announce)
   passed to every class, as `AgentMailStore` is, or the deliveries calling
   the repository's primitives through `this.repos.nativeAgentSessions`.
   Chose the registry. Pros: the repository's own methods are unchanged
   except for four `private` keywords, so other branches editing
   `storage-native.ts` rebase cleanly, and a test that spies on
   `repos.nativeAgentSessions.saveNativeAgentSession` still sees the
   deliveries' writes. Cons: four methods are public that were private
   (`enqueueNativeAgentSessionMutation`, `assertReadableNativeAgentSession`,
   `announceNativeAgentRecord`, `scrubPendingNativeAgentDispatchBackups`; the
   last stays on the repository because adoption also scrubs a parked
   dispatch); only the storage files can reach them, since nothing outside
   names a repository.
6. **`PromptQueueStore` is a store, not a seventh prompt repository.**
   Options: fold the persistence into `PromptsRepository` (781 lines, the
   queue operations) or a store class of its own. Chose the store, like
   `AgentMailStore`: drafts, build pipelines, the deliveries and the prompts
   repository all go through the same lease and load, and claim recovery has
   one owner the facade's `init` calls. Cons: 36 lines in
   `storage-prompts.ts` changed from `nativeAgentSessions.` to
   `promptQueues.` (the only wide edit in the branch, all mechanical).
7. **Kept this file, marked Finished.** As with 0009–0013, 0066 and 0163, it
   stays until the branch merges so the review can read these decisions.

## Constraints and rationale

- Size and readability only: no behaviour changed, and the guard comparison
  shows the same leases on every write path.
- No `extends` layers; the writer guard rejects a scanned class that extends
  another, and neither new class does.

## Needs verification

- Nothing needs live evidence: the change moves code between files and
  classes without changing a store, lease, timeout or facade signature, and
  the unit suites and the guard cover it.

## Related

- [0163-storage-facade-size.md](0163-storage-facade-size.md): the facade and
  agent mail split, and the before/after guard comparison repeated here.
- [`storage.md`](../../architecture/storage.md) ("Code layout").
