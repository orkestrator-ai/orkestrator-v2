# Decide what happens to a removed project's Kanban, notes and plans

From efficiency batch E3 (Retention and deletion), part `0840`, tasks 1 and 2. **Waiting on the maintainer's decision:** task 1 deletes user content that survives today, so the choice is the maintainer's; that decision is in [7568](../manual-test/7568-manual-test-checklist.md) (moved 2026-11-10), and both tasks here wait on it. Nothing here has been built, and project removal behaves as it did.

The batch file was deleted when E3 was built. It is in Git history at the commit named in [Related](#related).

## Task analysis

Analysed 2026-11-05 against `main` at `0e8958f57`.

### Tasks

1. **Project removal**: implement the maintainer's choice, so Kanban tasks and images, project notes and feature plans either go with the project or are knowingly kept. Status: blocked (waits on 7568: 5820 task 1 decision).
2. **Completion comment records**: give them a delete path. Status: blocked (depends on 1).

### 1. Project removal

**Problem.** Removing a project leaves its Kanban tasks, images, notes and plans in the database and on disk, with nothing able to reach them. No recommendation in the logging and database report covers this; it appears only as a closing sentence of D4.

**Context.** Other stores already go: `removeProject` deletes drafts, permission rules, graph template settings, client state, setup approvals and watched pull requests, and `cleanupProjectForRemoval` handles coordinators, schedules and mail.

**Investigation.** Re-checked 2026-11-05: `apps/backend/src/core/storage-projects.ts:480-507` and `apps/backend/src/core/commands-registry-projects.ts:1199` are the two cleanup paths, and neither calls `KanbanRepository`. Kanban rows carry `owner = projectId` ([storage](../../architecture/storage.md#stores-and-layouts)), so an owner delete is cheap. Images are single files under `kanbanImagesDir` (`storage-files.ts:146`), deleted one by one per task (`storage-kanban.ts:298`, `:658`). The Linear and GitHub sync in `storage-kanban-sync.ts` was not traced for what a delete would propagate.

**Decisions.**

- **Delete with the project?** The maintainer decides, through [7568](../manual-test/7568-manual-test-checklist.md); implement the option chosen there.
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

**Context.** They exist so a pipeline posts once (`storage-kanban.ts:1784`, `:1792`, `:1811`, `:1839`).

**Investigation.** Re-checked 2026-11-05: no delete function exists for either. They are keyed by pipeline or run id.

**Decisions.**

- **How to remove them?** Follows the choice in task 1.
  - **Delete a project's records with it, by way of its pipelines (recommended).**
    - Pros: one removal rule; no age logic.
    - Cons: needs the pipeline-to-project link at removal time, and a pipeline already removed leaves its record behind.
  - **Prune by age, for example past 90 days.**
    - Pros: bounded regardless of project; independent of removal.
    - Cons: a very late retry could post a second comment.

## Constraints and rationale

- A delete of user content must scrub: `updateStore` writes never touch the archive, so a delete made that way scrubs explicitly ([storage](../../architecture/storage.md#durability-and-deletion)).
- These stores are small on the sampled machine (the app's stores held 130 rows and about 0.6 MB), so the case is correctness and privacy, not size.

## Needs verification

- Whether a re-added project gets a new id decides whether old rows can ever be seen again. Traced on 2026-11-05: `createProject` mints a `randomUUID()` (`storage-shared-core.ts:409-411`) for every `add_project`, so as the code stands a re-added project does not see them, and the "reattach" option would need a new identity. What the Linear and GitHub sync does on a re-add was not traced.

## Related

- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (the user part of task 1: the maintainer's decision) moved there on 2026-11-10.
- Batch file E3, part 0840 (deleted): its outcome is the closing check of E3 (`git show 413bd6219:docs/reports/2026-11-06-efficiency-logging-database-outcome.md`), which names the commit that holds the file's last version.
- Logging and database report, D4 (`git show 413bd6219:docs/reports/2026-10-29-logging-and-database-efficiency.md`)
- [Change tracking](../../architecture/change-tracking.md#deleting-an-environment), which covers the ledger half of D4
