# Decide what happens to a removed project's Kanban, notes and plans

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Project removal**: Kanban tasks and images, project notes and feature plans either go with the project or are knowingly kept. Status: open.
2. **Completion comment records**: give them a delete path. Status: open (depends on 1).

### 1. Project removal

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

### 2. Completion comment records

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

## Constraints and rationale

- A delete of user content must scrub: `updateStore` writes never touch the archive, so a delete made that way scrubs explicitly (`docs/architecture/storage.md:521-525`).
- These stores are small on the sampled machine (the app's stores held 130 rows and about 0.6 MB), so the case is correctness and privacy, not size.

## Open questions

- Task 1's choice is the user's, because it deletes user content that survives today.

## Needs verification

- Whether a re-added project gets a new id was not traced. The answer decides whether old rows can ever be seen again.

## Related

- [Logging and database report, D4](../2026-10-29-logging-and-database-efficiency.md#d4-the-rest-of-the-ledger-never-shrinks-medium-growing)
- [0730](0730-r16-ledger-retention.md), which covers the ledger half of D4
