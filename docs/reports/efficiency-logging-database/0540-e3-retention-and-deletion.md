# E3: Retention and deletion

This file combines 3 reports into one batch to build together. All decide what gets deleted and when.

For the lane, order and conflicts, see [Parallel running](0000-index.md#parallel-running) in this folder's index.

Analysed 2026-11-03 against `main` at `a2bba9d8`.

## Parts

| Part | Criticality | Covers |
| --- | --- | --- |
| [0730](#0730-retain-the-change-ledger-by-age-and-environment) | High | R16 (D4): purge on environment deletion and age-based ledger retention. |
| [0540](#0540-activeturns-scans-every-turn-boundary-and-the-rows-are-never-removed) | Low | ST-19 (rest): `activeTurns()` scans every turn boundary, and the rows are never removed |
| [0840](#0840-decide-what-happens-to-a-removed-projects-kanban-notes-and-plans) | Medium | D4's last sentence, which no recommendation covers: Kanban, notes, plans and completion comments survive project removal. |

## 0730: Retain the change ledger by age and environment

### Task analysis

#### Tasks

1. **Purge on environment deletion**: deleting an environment removes its ledger rows and evidence bodies. Status: open.
2. **Age-based retention**: rows of finalized turns past the archive window are deleted. Status: open.
3. **Retention scan and batch costs**: the retention pass's full scans and one-snapshot transactions. Status: open (depends on 2).

#### 1. Purge on environment deletion

**Problem.** Nothing in change tracking runs when an environment is deleted, so its history, thread baselines and evidence bodies stay indefinitely. Evidence bodies are patches and raw payload slices (`evidence-body-store.ts:1-3`).

**Context.** Report D4. Other subsystems already follow the shape to copy: `deleteEnvironment` calls `transcriptArtifacts`, `transcriptMediaPins`, `design` and `webAnnotations`, each logging `delete.step-failed` on failure (`commands-servers.ts:1714-1745`).

**Investigation.** `deleteEnvironment` (`commands-servers.ts:1500`) has no reference to change tracking. `WorktreeRegistry.tombstone` exists (`worktree-owner.ts:704-706`) and nothing calls it, in tests or production. `EvidenceBodyStore.remove` (`evidence-body-store.ts:74`) has no caller. `environment_id` is on `change_bindings`, `change_operations`, `change_thread_segments` and `change_turn_boundaries` (`ledger-schema.ts:48`, `:82`, `:191`, `:209`), with an index only on bindings. A physical worktree can be shared: one capture serves turns of other environments aliasing it (`turn-boundaries.ts:621-625`). Bodies and objects are content-addressed, so one may be shared too.

**Decisions.**

- **Synchronous or tombstone then purge?**
  - **Tombstone the worktree in the delete path, purge in bounded batches from the retention pass (recommended).**
    - Pros: the report's shape; a delete never holds the write lock for a large ledger; late events cannot resurrect it (`worktree-owner.ts:704`).
    - Cons: content lingers until the next pass, up to an hour, so run a pass soon after a delete.
  - **Purge in the delete path.**
    - Pros: done when the delete is done.
    - Cons: an unbounded synchronous delete on the event loop, and deletion already has many failure-tolerant steps.
- **How are shared snapshots and bodies handled?**
  - **Delete only references and rows, and let the existing reachability sweep take objects; add a body sweep the same way (recommended).**
    - Pros: `ObjectStore.sweep` already handles sharing and grace; aliased environments are safe.
    - Cons: needs a body reachability listing, which does not exist yet.
  - **Remove by id at purge time.**
    - Pros: immediate.
    - Cons: would delete a body another environment still references.

#### 2. Age-based retention

**Problem.** Frames, operations, evidence, chunks, bodies, gaps, capture attempts, boundaries, windows, segments, bindings, restore tokens and operations, and `opturn:`/`turnops:` meta keys are never deleted. Turn and segment measurements stay "two per owner" forever because owners are never retired.

**Context.** The report projected +70 to 100 MB a day retained on the one machine sampled (2026-10-28), so about 3 GB a month. A 90-day window exists for objects (`archivedBodyRetentionDays`, `policy-registry.ts:97`), which releases turn endpoint pins (`retention.ts:89-93`) but deletes no row.

**Investigation.** `change-ledger.ts` has `DELETE` statements only for snapshots (`:806`), measurement files, diff identities and measurements (`:1175-1182`), references, the outbox and live identities (`:1239`). The meta keys are written at `service.ts:686-691`. Restore needs `change_restore_operations` for a running restore (`change-ledger.ts:1164`) and an unexpired token (`:1163`).

A search for `DELETE FROM change_turn_boundaries` under `change-tracking` finds nothing. Retention releases finished turns' references but keeps their rows (`releaseTurnEndpoints`, `apps/backend/src/core/change-tracking/retention.ts:144`), and `nextTurnOrdinal` and `latestTurnForThread` read these rows (`change-ledger.ts:924`, `:939`).

**Decisions.**

- **What is the window?**
  - **The same 90 days as `archivedBodyRetentionDays`, measured from `finished_at` (recommended).**
    - Pros: past it restore already answers `body-expired`, so little is lost; one number to explain.
    - Cons: a row's history goes even with quota to spare.
  - **A separate, shorter ledger window.**
    - Pros: flatter growth.
    - Cons: a measurement can outlive or predate its bodies, which is two rules to explain.
- **What happens to a thread baseline?**
  - **Keep a segment and its baseline pin while any turn in it is retained (recommended).**
    - Pros: `retention.ts` documents baselines as pinned; a live thread keeps working.
    - Cons: a very long-lived thread holds a baseline forever, as it does now.
  - **Expire by age regardless.**
    - Pros: a hard bound.
    - Cons: thread-net on a live thread would turn `baseline-unavailable`.
- **Do finished turn boundaries go with the rest?**
  - **Leave them until a measured table size justifies a policy (recommended).**
    - Pros: each row is small, about one per turn, and [0540](#0540-activeturns-scans-every-turn-boundary-and-the-rows-are-never-removed) task 1 removes the only per-hint scan the report names; no risk to ordinals or history. Deleting an environment still removes its boundaries under task 1.
    - Cons: the table still grows for the life of the data directory.
  - **Prune boundaries past the archived-body retention window.**
    - Pros: bounded.
    - Cons: needs an audit of every reader, including anything that expects a thread's ordinals to be continuous.

#### 3. Retention scan and batch costs

**Problem.** The pass scans whole tables and writes one transaction per snapshot, and task 2 adds more work to it.

**Context.** Report D7 and R16's last bullet. [1202](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md) task 7 owns ST-19 (`activeTurns()`), so this file does not repeat it.

**Investigation.** `turnsByAge` selects every turn (`change-ledger.ts:948-952`) and `releaseTurnEndpoints` walks it, one transaction per release. `retention.ts:181` deletes one snapshot per transaction. `pruneLiveIdentities` filters by `LIKE` over `identity_json` (`change-ledger.ts:1236-1239`).

**Decisions.**

- **Batch how?**
  - **Tens of turns or snapshots per transaction with a yield between, as `pruneMeasurements` does (recommended).**
    - Pros: the report's size; an existing pattern.
    - Cons: a batch failure retries more work.
  - **Leave as is until a measurement shows it.**
    - Pros: no change to a working pass.
    - Cons: once task 2 lands, a first run faces the whole backlog.

### Current state

Measurement pruning and quota release exist (`retention.ts`). Nothing else in this recommendation has landed.

### Constraints and rationale

- A pass must keep yielding between transactions; one long transaction blocks every request.
- A first run on an old database has a large backlog. Bound it per pass.
- `docs/architecture/change-tracking.md`, "Retention and backup", needs the new rules.

### Needs verification

- Growth figures are the report's estimate from one installation.
- Whether a client depends on old `change_frames` or `change_operations` for anything beyond a turn's own view was read from the service, not exercised.

## 0540: `activeTurns()` scans every turn boundary, and the rows are never removed

### Task analysis

#### Tasks

1. **Query active turns through the lifecycle index**: replace the `NOT IN` with a form the index can serve. Status: open.

#### 1. Query active turns through the lifecycle index

**Problem.** `activeTurns()` reads the whole table, and the provisional pass that runs per hint calls it.

**Context.** The report's fix is `lifecycle IN (...)` or a partial index.

**Investigation.** The query is `lifecycle NOT IN (...)` (`apps/backend/src/core/change-tracking/change-ledger.ts:931-936`). An index on `lifecycle` exists (`apps/backend/src/core/change-tracking/ledger-schema.ts:226`), but `NOT IN` will not seek it. Callers include `apps/backend/src/core/change-tracking/turn-boundaries.ts:479`, `:632` and `:693`, and `change-tracking/service.ts:1101`.

**Decisions.**

- **Which form?**
  - **`lifecycle IN (...)` over the non-terminal states, using the existing index (recommended).**
    - Pros: no schema change.
    - Cons: a new non-terminal state added later must join the list, or its turns silently stop being active.
  - **A partial index with the current `NOT IN` predicate.**
    - Pros: the query text stays, so the terminal list stays the only list.
    - Cons: a ledger schema change, and the planner must match the predicate exactly.

### Current state

Whether finished boundaries are ever removed is decided with the rest of the ledger, under [0730 task 2](#2-age-based-retention).

Superseded measurements are pruned, both per publish and in hourly retention (`pruneSupersededMeasurements`, `change-ledger.ts:1144`; `apps/backend/src/core/change-tracking/measurement-service.ts:213`; `retention.ts:122`; 8a6bc2f84, #1363). That half of the finding is done, although 1202 still lists ST-19 as open.

### Needs verification

- Real table size on a long-lived data directory.

## 0840: Decide what happens to a removed project's Kanban, notes and plans

### Task analysis

#### Tasks

1. **Project removal**: Kanban tasks and images, project notes and feature plans either go with the project or are knowingly kept. Status: open.
2. **Completion comment records**: give them a delete path. Status: open (depends on 1).

#### 1. Project removal

**Problem.** Removing a project leaves its Kanban tasks, images, notes and plans in the database and on disk, with nothing able to reach them. No recommendation in the report covers this; it appears only as a closing sentence of D4.

**Context.** Other stores already go: `removeProject` deletes drafts, permission rules, graph template settings, client state, setup approvals and watched pull requests, and `cleanupProjectForRemoval` handles coordinators, schedules and mail.

**Investigation.** `apps/backend/src/core/storage-projects.ts:476-502` and `commands-registry-projects.ts:1192` are the two cleanup paths, and neither calls `KanbanRepository`. Kanban rows carry `owner = projectId` (`docs/architecture/storage.md:188-191`), so an owner delete is cheap. Images are single files under `kanbanImagesDir` (`storage-files.ts:146`), deleted one by one per task (`storage-kanban.ts:298`, `:658`). The Linear and GitHub sync in `storage-kanban-sync.ts` was not traced for what a delete would propagate.

**Decisions.**

- **Delete with the project?**
  - **Yes, in `removeProject`, matching its other stores, with the confirmation text saying so (recommended).**
    - Pros: consistent; the data is unreachable anyway once the project goes; removes user content the user asked to remove.
    - Cons: not recoverable beyond hourly snapshots, and a user re-adding the same repository may have expected their board back.
  - **Keep it, reattach when the same repository is re-added.**
    - Pros: nothing lost by a mistaken removal.
    - Cons: needs an identity between old and new project, and content stays on disk after the user removed the project.
  - **Keep it, offer an explicit "also delete tickets and notes" choice.**
    - Pros: the user decides.
    - Cons: one more dialog option, and a default still has to be chosen.

#### 2. Completion comment records

**Problem.** Linear and GitHub completion comment records have no delete path, so they stay for good.

**Context.** They exist so a pipeline posts once (`storage-kanban.ts:1784`, `:1792`, `:1839`).

**Investigation.** No delete function exists for either. They are keyed by pipeline or run id.

**Decisions.**

- **How to remove them?**
  - **Delete a project's records with it, by way of its pipelines (recommended).**
    - Pros: one removal rule; no age logic.
    - Cons: needs the pipeline-to-project link at removal time, and a pipeline already removed leaves its record behind.
  - **Prune by age, for example past 90 days.**
    - Pros: bounded regardless of project; independent of removal.
    - Cons: a very late retry could post a second comment.

### Constraints and rationale

- A delete of user content must scrub: `updateStore` writes never touch the archive, so a delete made that way scrubs explicitly (`docs/architecture/storage.md:521-525`).
- These stores are small on the sampled machine (the app's stores held 130 rows and about 0.6 MB), so the case is correctness and privacy, not size.

### Open questions

- Task 1's choice is the user's, because it deletes user content that survives today.

### Needs verification

- Whether a re-added project gets a new id was not traced. The answer decides whether old rows can ever be seen again.

## Related

- [Logging and database report, R16](../2026-10-29-logging-and-database-efficiency.md#r16-retain-the-rest-of-the-ledger-by-age-and-environment-d4) and [D4](../2026-10-29-logging-and-database-efficiency.md#d4-the-rest-of-the-ledger-never-shrinks-medium-growing)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md) task 7 (ST-19)
- [the measurement row cap](../../architecture/change-tracking.md#retention-and-backup), [0840](#0840-decide-what-happens-to-a-removed-projects-kanban-notes-and-plans)
- [Efficiency report, E](../2026-10-27-efficiency.md#e-storage-change-tracking-git-and-files)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md), task 7
- [Logging and database report, D4](../2026-10-29-logging-and-database-efficiency.md#d4-the-rest-of-the-ledger-never-shrinks-medium-growing)
- [0730](#0730-retain-the-change-ledger-by-age-and-environment), which covers the ledger half of D4

## Outcome

Built on 2026-11-05 against `main` at `54911a112` and checked back against this file item by item. The findings were re-checked first and all of them still held: `deleteEnvironment` (`commands-servers.ts:1513`) had no reference to change tracking, `WorktreeRegistry.tombstone` and `EvidenceBodyStore.remove` had no caller, no row of frames, operations, evidence or windows was ever deleted, `turnsByAge` selected every turn, `retention.ts` deleted one snapshot per transaction, and `activeTurns()` was `lifecycle NOT IN (...)`. Tests named below are in `apps/backend/src/core/change-tracking/retention-deletion.test.ts` unless another file is named.

| Part | Task | Outcome | Code, evidence or to-do |
| --- | --- | --- | --- |
| 0730 | 1. Purge on environment deletion | Done, with the recommended tombstone then bounded purge | `deleteEnvironment` calls `ChangeTrackingService.environmentDeleted`, which tombstones and records `purge-env:<id>`; the pass runs `LedgerRetirement.purgeEnvironmentBatch`. Tests: "purges its ledger rows, evidence bodies and objects, and no more than that", "every other kind of owner an environment has goes too", "the delete itself only tombstones and records", "a restarted backend resumes the purge", `commands-environment-cleanup.test.ts` "records its change-tracking purge, and a failure does not strand deletion". |
| 0730 | 1. Decision: content lingers, so run a pass soon | Done | `scheduleRetentionSoon`, 30 s after a delete and again while a purge is waiting. Test: "a pass soon after the delete removes rows; the entry waits out the grace". |
| 0730 | 1. Decision: late events cannot resurrect it | Done | `deletedEnvironments` drops scans, pulls and turn starts, and the entry outlives the rows by the orphan grace, so a late write is found. Tests: "late events cannot write rows for it", "a pass soon after the delete". A tombstone also retires the identity key, because a reused checkout otherwise hit the row's unique key: "a new environment at a kept checkout gets a fresh worktree row". |
| 0730 | 1. Decision: shared snapshots and bodies, with a body sweep | Done, with the recommended reachability sweep | Purges delete rows and references only. `EvidenceBodyStore.sweep`, `evidenceBodiesPage` and `chunkBodiesPage` are the body listing; `EvidenceBodyStore.remove`, which had no caller, is gone. Tests: "a snapshot both environments reference survives the first purge", "an evidence body another environment names survives the first purge", "the evidence body store's sweep". |
| 0730 | 1. Constraint: a running restore and an unexpired token keep what they need | Done | `heldMeasurements` defers the environment's purge, and `heldSnapshots` is a sweep root. Tests: "an unexpired token defers the purge", "a running restore holds the purge past its token's expiry", "a token on another environment's measurement does not hold this purge", "an alias can still apply its token", "quota pressure cannot take the endpoints of an unexpired token". |
| 0730 | 2. Age-based retention | Done | `retireExpiredTurns`, `retireExpiredFrames`, `retireExpiredOperations`, `retireExpiredProviderTurns`, `retireExpiredSegments` and `retireExpiredRecords` in `ledger-retirement.ts`, with the bodies swept once nothing names them. Tests: "a finished turn past the window keeps only its boundary row", "restore records, cursors, gaps and empty bindings past the window go", "nothing inside the window is touched". |
| 0730 | 2. Decision: the window | Done as recommended | The same 90 days as `archivedBodyRetentionDays`, from `finished_at` (falling back to `started_at`, as the release already did). |
| 0730 | 2. Decision: thread baselines | Done, narrowing the recommendation | A closed segment goes once no turn in it is retained; an open one stays whatever its age, because the recommendation's "any turn retained" alone would let an idle live thread lose its baseline, against this work's constraint. Purging the environment removes it. Tests: "a live thread keeps its baseline, and its next turn still measures from it", "a closed segment with nothing retained goes with its baseline pin", "a closed segment with a turn still in the window stays". |
| 0730 | 2. Decision: finished turn boundaries | Done as recommended: left in place | Their rows stay and `turnRetired` answers `history-expired` for a retired one. Test: "a closed segment with nothing retained" (ordinals). The measurement that could change it moved to [5821](../../todo/cross-cutting/5821-ledger-retention-live-evidence.md) task 2. |
| 0730 | 3. Retention scan and batch costs | Done as recommended | `turnsByAge` is gone: a durable cursor walks `change_turn_boundaries_age`, and quota release seeks turns holding references. 16 turns or 256 rows per transaction, 32 snapshots (`retire` in `sweep`), a page of diff identities (`pruneLiveIdentitiesPage`, replacing the whole-table `LIKE`), each followed by a yield, and at most 4,096 batches per pass. Tests: "a large backlog goes in batches, resuming from a durable cursor", "a large environment goes in many short transactions", "the age walk seeks its index", `review-regressions.test.ts` (64, 64, then 3 quota releases). |
| 0730 | Constraint: `change-tracking.md` needs the new rules | Done | "Deleting an environment" and "Age-based retention" under [Retention and backup](../../architecture/change-tracking.md#retention-and-backup), a known limitation on segment activity, and a row in `docs/development/disk-usage.md`. |
| 0730 | Needs verification: growth figures | Moved to a to-do | [5821](../../todo/cross-cutting/5821-ledger-retention-live-evidence.md) task 1. |
| 0730 | Needs verification: a client's use of old frames and operations | Moved to a to-do | Backend answers are tested ("a finished turn past the window keeps only its boundary row"); a real renderer is [5821](../../todo/cross-cutting/5821-ledger-retention-live-evidence.md) task 4. |
| 0730 | Not in this file: a first run on a real backlog, and environments deleted before this change | Moved to a to-do | [5821](../../todo/cross-cutting/5821-ledger-retention-live-evidence.md) tasks 3 and 5. |
| 0540 | 1. Query active turns through the lifecycle index | Done as recommended | `lifecycle IN (...)` from `TURN_LIFECYCLES` in `change-ledger.ts`. The recommendation's risk, a new state silently falling out of the list, is closed by the `TurnLifecycle` type on the row, which a state must join to be stored. Tests: "every lifecycle state answers as it did under the old NOT IN", "the query seeks the lifecycle index". |
| 0540 | Current state: whether finished boundaries are removed | Decided under 0730 task 2 | See above. |
| 0540 | Current state: superseded measurements | No longer holds as a finding | Already pruned per publish and hourly (`pruneSupersededMeasurements`), unchanged here. |
| 0540 | Needs verification: real table size | Moved to a to-do | [5821](../../todo/cross-cutting/5821-ledger-retention-live-evidence.md) task 1. |
| 0840 | 1. Project removal | Moved to a to-do, waiting on the maintainer's decision | [5820](../../todo/cross-cutting/5820-removed-project-kanban-notes-plans.md) task 1, with its options. Project removal is unchanged: `storage-projects.ts` and `commands-registry-projects.ts` are not in this change. |
| 0840 | 2. Completion comment records | Moved to a to-do | [5820](../../todo/cross-cutting/5820-removed-project-kanban-notes-plans.md) task 2. |
| 0840 | Open question: the choice is the user's | Moved to a to-do | [5820](../../todo/cross-cutting/5820-removed-project-kanban-notes-plans.md). |
| 0840 | Needs verification: does a re-added project get a new id | Answered and moved to a to-do | It does: `createProject` mints a `randomUUID()` (`storage-shared-core.ts:409-411`). Recorded in [5820](../../todo/cross-cutting/5820-removed-project-kanban-notes-plans.md). |

Older clients and nodes: the indexes are created without a schema version, so an older build still opens the ledger. The reason key is additive, and `changeReason` has a readable fallback in a renderer that lacks it. No compatibility path is added to [version-compatibility.md](../../architecture/version-compatibility.md).
