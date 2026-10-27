# Storage facade size

Checked against the 0009 branch (`todo-0009-storage-repositories-4696a61ea39f`,
on `main` at `00a0cb82`, 2026-10-25). Follow-up from
[0009-storage-service-repositories.md](0009-storage-service-repositories.md).
Done on `todo-0163-storage-facade-size-a8e92b2563c1` from `main` at `93018933`
(2026-10-26). **Every item below is done.** The durable description is in
[`storage.md`](../../architecture/storage.md) ("Code layout", "Concurrency",
"Testing"). Delete this file and its index row once the branch has merged
(decision 9).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Retire this finished file**: both code items (area fields for six repositories, the agent mail split) and the qualification run are done and merged (#1284); only the file's own retirement remains. Status: done.

### 1. Retire this finished file

**Problem.** The file is marked Finished and says to delete it once its branch merged (decision 9). It still holds rank 5 in the folder index, and `docs/README.md:64` links to it from the `storage.md` row as the place the size follow-up was done.

**Context.** Follow-up from [0009](0009-storage-service-repositories.md); the two storage files still over the limit moved to [0214](0214-storage-files-over-size-limit.md). The README rule is to move durable behaviour into `architecture/`, delete the file and remove its row.

**Investigation.** The branch merged as `b9a06f65` (#1284). The six area fields exist (`apps/backend/src/core/storage.ts:114` to `:119`) and `storage-writer-guards.test.ts` treats their picks as entry points (`apps/backend/src/core/storage-writer-guards.test.ts:1787`, fixtures at `:2164`, `:2188`). Agent mail is five classes, none over 2,000 lines: `storage-agent-mail.ts` 1,229, `-directory` 780, `-injects` 780 (was 746), `-budgets` 356, `-store` 311 (was 299). `storage.ts` has grown from 1,821 to 1,840 lines since the file was written (#1310 and #1312 added agent mail forwarders), so it is 160 lines under the limit and drifting upward, because agent mail still goes through forwarders (decision 2). The durable description is already in `docs/architecture/storage.md`: area fields and the `Pick` pattern in "Code layout" (lines 24 to 46), the agent mail collaborator rows in its table, the area entry rule in "Concurrency", and "patching an area method also patches the repository" in "Testing" (from line 403). The decisions that are not in `storage.md` are 2 (which areas and why agent mail and drafts kept forwarders) and 5 (only caller-free forwarders dropped). Stale reference: decision 10 names `environments-and-containers/0887-container-rebuild-dialog-after-reload.md`, which `main` has since renumbered to [0953](../../tests/flaky-tests/environments-and-containers/0953-container-rebuild-dialog-after-reload.md).

**Decisions.**

- **What to do with this file now that its branch has merged?**
  - **Delete it now, after a one-line note in `storage.md` (recommended).** Add to "Code layout" which areas still forward and why (decision 2: agent mail kept on the facade to avoid ~800 call-site changes, drafts because its section mixes sessions), update the `docs/README.md:64` row and the links from 0009 and 0214, and remove the index row.
    - Pros: follows the README rule; whoever next narrows an area (for example agent mail, the main source of facade growth) finds the reasoning beside the code layout.
    - Cons: the validation evidence (the guard dump comparison) survives only in git history, although 0214 needs to repeat it and describes it in its own words.
  - **Keep it until 0214 is done.** Retire the storage series together.
    - Pros: 0214's qualification links here for the before/after guard comparison method.
    - Cons: contradicts the README rule; 0214 is low priority and may sit open for a long time.
- **Should the facade's renewed growth be tracked?**
  - **Note it in `storage.md` and leave it untracked (recommended).** State that new agent mail entry points should go on an area field rather than a forwarder.
    - Pros: at about 10 lines per feature the file has many months of headroom; a rule stops the growth at the source.
    - Cons: a rule in prose is not enforced; the file could cross 2,000 lines unnoticed.
  - **Open a new todo to move agent mail to an area field.** A new numbered file, per the README rule against adding to existing files.
    - Pros: removes the largest remaining forwarder block (the ~800 call sites) and the growth with it.
    - Cons: a large mechanical diff for a size-only gain that 0163 rated low.

0009 replaced the `StorageService` inheritance chain with a facade over
per-store repositories. To keep every public method name and signature (a
constraint of 0009), the facade forwarded each of its 327 repository methods
explicitly, so `storage.ts` was 2,464 lines of one-line forwarders, over the
2,000-line limit in `AGENTS.md` ("General guidance"). `storage-agent-mail.ts`
(`AgentMailRepository`, 3,284 lines on `main`) was over the limit too. (This
file originally called it the one repository file over the limit;
`storage-native.ts` was also over, by 15 lines, see
[0214](0214-storage-files-over-size-limit.md).)

## Current state

- `storage.ts` is 1,821 lines. Six areas are reached through public facade
  fields typed as a `Pick` of their repository's entry points instead of
  forwarders: `storage.kanban` (`KanbanStorage`, 34 methods),
  `storage.coordinators` (`CoordinatorsStorage`, 24), `storage.publicOperations`
  (`PublicOperationsStorage`, 14), `storage.nodes` (`NodesStorage`, 16),
  `storage.previewServices` (`PreviewServicesStorage`, 7) and
  `storage.agentAccounts` (`AgentAccountsStorage`, 3). Each type sits next to
  its repository and is re-exported from `storage.ts`. The other areas keep
  their forwarders (242 facade methods remain).
- 55 non-test backend files and 75 test files now call through an area field
  or name an area type. Consumers that need a few methods take a narrow type:
  `discoverFeaturePlanning(storage: Pick<KanbanStorage, "listAllFeaturePlans">)`,
  `AgentRegistry`'s `Pick<StorageService, …> & { coordinators: Pick<CoordinatorsStorage, …> }`,
  and the hand-written storage interfaces of the node service
  (`NodeServiceStorage`, `ControllerSettingsStorage`), previews
  (`PreviewRegistryStorage`, `PreviewRuntimeStorage`), MCP management
  (`TargetStorage`, `McpServiceStorage`) and scheduled jobs now hold
  `nodes` / `previewServices` / `coordinators` sub-objects.
- `storage-writer-guards.test.ts` treats the members an area field picks as
  entry points, like the facade's public methods, and fails a public facade
  field that exposes a whole class (by type or by copying a field) or a `Pick`
  of a name the repository does not have publicly.
- Agent mail is five classes sharing one `AgentMailStore`
  (`storage-agent-mail-store.ts`, 299 lines: the `agent-mail.json` lease,
  load, size-checked save and the pure helpers on the persisted shape):
  `AgentMailRepository` (`storage-agent-mail.ts`, 1,229: send, reply,
  per-message state, conversations, deletion and retention),
  `AgentMailboxDirectory` (`storage-agent-mail-directory.ts`, 780: mailbox
  synchronisation, descriptors, snapshots, policy), `AgentMailInjects`
  (`storage-agent-mail-injects.ts`, 746: the inject queue, claim/settle,
  retries, delegation and stored-mail holds) and `AgentMailBudgets`
  (`storage-agent-mail-budgets.ts`, 356: pair loop budget, hourly limit,
  resets, releases, the held-mail notice). They reach each other through the
  `StorageRepositories` registry (`agentMail`, `agentMailboxes`,
  `agentMailInjects`, `agentMailBudgets`). None of them is over 2,000 lines.
  Two storage files outside this file's scope still are
  (`storage-shared-core.ts`, 2,185; `storage-native.ts`, 2,015, both
  unchanged from `main`); they are followed up in
  [0214-storage-files-over-size-limit.md](0214-storage-files-over-size-limit.md).

## Outstanding work

### Code

- ~~Narrow callers by area to an interface the owning repository satisfies
  (for example a `KanbanStorage` type for the Kanban commands), one area per
  PR, and drop the forwarders no caller uses any more. Keep the facade's
  public methods the only entry points the writer guard follows: an area
  interface must be implemented by the facade, or the guard must learn the new
  entry points first.~~ Done 2026-10-26 for six areas (Kanban, coordinators,
  public operations, nodes, preview services, agent accounts), in this one
  branch (decisions 1–4). The guard learned the new entry points in the same
  change (decision 3). Forwarders with no caller left were dropped:
  `deleteAgentUsageHistoryByEnvironment` (and its dead repository method),
  `deleteNativeAgentDisplayTail`, `deleteNativeAgentDisplayTailsByEnvironment`,
  and, by leaving them out of their areas, `listAllCoordinatorWorkflowAssociations`
  and `loadPublicOperationIndex` (decision 5).
- ~~Split `AgentMailRepository` by responsibility into collaborators (the mail
  store, mailbox directory synchronization, inject scheduling and budgets),
  following "Splitting large classes" in `AGENTS.md`.~~ Done 2026-10-26: the
  four collaborators above plus the shared `AgentMailStore`, no `extends`
  (decisions 6–7).

### Qualification

- ~~Run every `apps/backend/src/core/storage*.test.ts`, including
  `storage-writer-guards.test.ts`, after each step, plus `mise run test`.~~
  Done 2026-10-26; see "Validation evidence".

## Validation evidence

All on this branch, 2026-10-26.

- **Same write structure as `main`.** The guard's full analysis was dumped on
  `main` (old guard, old sources) and on this branch (new guard, new
  sources): per store (kind, store-wide leases) and per write site (store,
  kind, writing member, leases on every path, entry point names with the
  class dropped). After the area step: identical (40 stores, 126 write
  sites, no violations). After the mail split: identical except that the
  `agent-mail.json` write site is `AgentMailStore.save` instead of
  `AgentMailRepository.saveAgentMailStore`, with the same store, lease and
  21 entry points.
- **The guard sees an area entry.** "the facade's area fields make their
  picked members entry points" drops the lease from
  `KanbanRepository.saveLinearAuth` in the production sources and requires
  the violation "no store-wide lease reaches this write from
  KanbanRepository.saveLinearAuth" (before this change the method had no
  internal caller, so it would have been reported only as "has no caller").
  Fixture tests cover a picked method losing its caller's lease, an
  unpicked one keeping it, a whole repository exposed as a public field (by
  type and by copying a private field) and a `Pick` of a missing name.
  `storage-writer-guards.test.ts`: 36 pass.
- `bun test` of every `apps/backend/src/core/storage*.test.ts`,
  `agent-mail*`, `coordinator*`, `nodes/*`, `commands-registry-mail*` and
  `apps/backend/tests/storage*.test.ts`: 1,312 pass, 0 fail (after the split).
- Backend suite before the mail split (`bun test src tests --parallel=8`):
  11,754 pass, 15 fail. Of those, the 9 `tests/standalone.test.ts` cases need
  the built `dist/main.js` (`mise run test` builds it) and every other
  failure was a five-second timeout under load whose file passes alone
  (`backend-runtime`, `build-pipeline-result-reminder`, `commands-state-sync`,
  `index-resource-events`, `native-agent-service-activity-batch`,
  `storage.test`: 406 pass; `terminal-history`: 25 pass). One real failure
  found earlier was fixed (decision 8).
- `mise run typecheck`: no errors. `mise run lint`: exit 0, no finding in a
  changed file. `mise run format`: applied.
- `mise run test` at `7e64cd377`: bridges and codex protocol lockfile
  passed; the workspace group failed one backend test (11,768 pass, 97 skip,
  1 fail): the terminal-history five-second deadline, already flake
  [0213](../../tests/flaky-tests/backend-services-and-tooling/0213-terminal-history-aggregate-timeout.md)
  (recurrence recorded; its owner passed alone, 25 pass). The root group
  failed one test, `flaky-tests-index.test.ts`, which also fails on `main`:
  flake case 0887 (environments and containers, from #1279) lacked the
  register's metadata header. Fixed here (decision 10); the test passes
  (11 pass).

## Assumptions and decisions

1. **Six areas in one branch, not one area per PR.** Options: one area per PR
   as the file suggested, or every area needed to bring `storage.ts` under
   2,000 lines in this branch, as the task asked. Chose the branch. Pros: the
   file is under the limit with margin (1,821 lines), and one before/after
   guard comparison covers it. Cons: a large, mostly mechanical diff (about
   1,000 call sites rewritten by a typecheck-driven script, then the fakes
   by hand); the review leans on the typecheck, the guard comparison and the
   suite.
2. **Which areas.** Options: the largest sections (native sessions, agent
   mail, projects), or the areas whose callers churn least per line saved.
   Chose Kanban (201 lines), coordinators and agent accounts (206), public
   operations (120), nodes (72) and preview services (34). Pros: few callers
   per line, each a self-contained repository, coherent names
   (`storage.kanban.addKanbanTask`). Cons: projects, config, sessions, native
   sessions, prompts, reviews, build pipelines, drafts and agent mail still
   forward; drafts was skipped because its section mixes sessions and pane
   layouts, which would read badly as `storage.drafts.getSession`. Agent mail
   was kept on the facade so its split (item 2) did not also change ~800
   call sites; its forwarders now point at the collaborators.
3. **Area fields typed as `Pick<Repository, …>`, entries taught to the guard.**
   Options: an interface the facade implements (keeps every forwarder, so
   the file does not shrink), forwarders generated at run time (ruled out by
   this file's constraints), a hand-written interface per area (duplicates
   every signature), or a public field holding the repository typed as a
   `Pick` of its entry points. Chose the `Pick` field. Pros: one signature
   per method, greppable explicit entry list next to the repository,
   TypeScript keeps outside code to the picked names, and the guard reads
   the same list. Cons: the guard had to learn `Pick` aliases; a consumer
   that mixes areas needs a nested type (`{ coordinators: Pick<…> }`).
4. **Consumers' own storage interfaces take nested area objects.** Options:
   adapters at the wiring site (`{ getNodeRegistry: () => storage.nodes.… }`,
   forwarders again, elsewhere), or nested `nodes` / `previewServices` /
   `coordinators` members in those interfaces. Chose nesting. Pros: the
   service still receives `StorageService` itself; no new forwarders. Cons:
   their in-memory fakes changed shape (`MemoryNodeStorage` exposes itself as
   `nodes` and `previewServices`).
5. **Dropped only forwarders with no caller anywhere.** Test-only callers
   (`deleteComposeDraftsByProject`, `deleteSessionBuffer`,
   `getResourceSnapshotRevision`, the two agent mail pull-tab resolvers) kept
   their forwarders: they are cheap and the tests exercise them as API. The
   one `loadPublicOperationIndex` test read now uses `storageInternals`.
   `SessionsRepository.deleteAgentUsageHistoryByEnvironment` was removed with
   its forwarder; `UsageHistoryStore.deleteByEnvironment` stays, tested.
6. **Agent mail collaborators through the registry, sharing an
   `AgentMailStore`.** Options: collaborators owned by `AgentMailRepository`
   (it would forward their methods, moving the forwarders into the mail file),
   or peers in `StorageRepositories` sharing one store object. Chose peers.
   Pros: each class is one responsibility, the facade forwards straight to
   the owner, and the guard scans every class through typed fields. Cons:
   four more registry entries; `recipientTab`, `descriptor` and
   `ensureAgentMailDirectoryFresh` became public on the directory (called by
   the other classes; one test no longer needs a cast to reach the last).
7. **Pure helpers moved as functions.** `findMessage` and
   `promoteStoredMessages` used no instance state, so they became exported
   functions of the store module rather than methods of one class. Three doc
   comments that sat stacked above the wrong method in the old file were
   moved to their methods (`resolveCoordinatorAddress`, `recipientTab`,
   `releaseDelegationHeldAgentMail`).
8. **Patching an area method also patches the repository.** An area field
   is the repository object, so a test that replaces
   `storage.agentAccounts.loadAgentAccounts` is also seen by the repository's
   own `mutateAgentAccounts`. One test that re-entered the repository from its
   patch deadlocked on the lease; it now lets the repository's own read
   through. Three production `typeof storage.x === "function"` checks (kept
   for partial fakes) use `storage.area?.x`. `storage.md` ("Testing") says so.
9. **Kept this file, marked Finished.** The README says to delete a finished
   file; like 0009–0013 and 0066 it stays until the branch merges so the
   review can read these decisions.
10. **Fixed a register case that breaks `main`'s suite.** Options: leave
    `tests/unit/flaky-tests-index.test.ts` failing as pre-existing, or give
    case 0887 (`environments-and-containers/0887-container-rebuild-dialog-after-reload.md`)
    the `- **ID:**`/`- **Status:**` header every other case has. Chose the
    fix: it is a doc-format change with no content change, and it keeps
    `mise run test` meaningful for this branch. Cons: an unrelated file in the
    diff.

## Constraints and rationale

- Leaving the remaining forwarders changes no behaviour: they are mechanical
  and typed, and the writer guard checks every path through them. New areas
  follow decision 3.
- Do not generate forwarders at run time (prototype assignment with interface
  merging): the guard would lose the explicit entry points it reads, and the
  surface would no longer be greppable.

## Related

- [0009-storage-service-repositories.md](0009-storage-service-repositories.md),
  decision 3 (explicit forwarders).
- [0012-backend-core-domain-folders.md](0012-backend-core-domain-folders.md):
  the storage folder move.
- [`storage.md`](../../architecture/storage.md) ("Code layout").
- [0214-storage-files-over-size-limit.md](0214-storage-files-over-size-limit.md):
  the two storage files still over the limit.
