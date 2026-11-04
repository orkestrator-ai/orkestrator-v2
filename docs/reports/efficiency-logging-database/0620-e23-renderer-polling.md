# E23: Renderer polling

This file combines 3 reports into one batch to build together. Background refetches.

For the lane, order and conflicts, see [Parallel running](0000-index.md#parallel-running) in this folder's index.

Analysed 2026-11-03 against `main` at `a2bba9d8`.

## Parts

| Part | Criticality | Covers |
| --- | --- | --- |
| [0620](#0620-one-environment-change-refetches-the-projects-whole-environment-list) | Low | WEB-12: One environment change refetches the project's whole environment list |
| [0630](#0630-expanded-truncated-folders-are-re-read-every-5-s-without-a-digest) | Low | WEB-13: Expanded truncated folders are re-read every 5 s without a digest |
| [0660](#0660-some-renderer-polls-keep-running-while-the-window-is-hidden) | Low | WEB-18: Some renderer polls keep running while the window is hidden |

## 0620: One environment change refetches the project's whole environment list

### Task analysis

#### Tasks

1. **Read only the changed environment**: fetch one record when the change names it. Status: open.

#### 1. Read only the changed environment

**Problem.** Each environment change re-reads every environment of its project.

**Context.** `ResourceChange.id` is the record id for record-scoped resources, but its comment adds that clients refetch collections (`packages/protocol/src/resource-events.ts:205-214`).

**Investigation.** `apps/web/src/hooks/useEnvironmentListSync.ts:84-92` calls `refreshProjectOnce`, which collapses bursts into one follow-up read per project (`:46-79`). The hook is used by `HierarchicalSidebar.tsx:356` and `WorkspaceRealmHost.tsx:56`.

**Decisions.**

- **Patch one record?**
  - **Keep the project read until a measurement shows it matters (recommended).**
    - Pros: a reorder or a deletion changes more than one record's meaning, and the burst collapse already bounds the cost; the read is one RPC per project.
    - Cons: the list's cost scales with the project's environments.
  - **Read one environment by `change.id` and merge it.**
    - Pros: one row per change.
    - Cons: the merge has to handle order changes, removals and an event for a record that moved project, all of which the whole read gets for free.

### Needs verification

- RPC rate and size during busy periods. The report's confidence here is Medium and nothing was measured.

## 0630: Expanded truncated folders are re-read every 5 s without a digest

### Task analysis

#### Tasks

1. **Conditional subtree reads**: answer `unchanged` for a folder that has not changed. Status: open.

#### 1. Conditional subtree reads

**Problem.** While the All files tab is open, every visible loaded folder is re-read in full on each tick.

**Context.** The whole tree and change list already use a digest (`knownDigest`, `apps/backend/src/core/commands-registry-terminal.ts:201-205`, `:912-917`).

**Investigation.** `reloadFolders` runs on each coordinated read for that tab (`apps/web/src/hooks/useFilesPanel.ts:644-663`, `:774`, at the 5 s interval from `:32` and `:758`). Its comment records that subtrees sit outside the snapshot's digest (`:642-643`). `get_local_file_subtree` and `get_file_subtree` take no digest (`commands-registry-terminal.ts:921`, `:1221`). The read already pauses while the document is hidden, through the read coordinator.

**Decisions.**

- **How to skip the work?**
  - **Add `knownDigest` to both subtree commands using the existing `snapshotResponse` helper (recommended).**
    - Pros: the contract every other Files panel read uses; no payload when nothing changed.
    - Cons: the backend still walks the folder; older backends need the additive fallback.
  - **Skip the folder reload while a watched worktree's snapshot revision is unchanged.**
    - Pros: no read at all.
    - Cons: only works for a watched target; a missed hint leaves a folder stale until a full refresh.

### Constraints and rationale

An explicit refresh must still re-read (`useFilesPanel.ts:795`). Command changes follow `docs/architecture/version-compatibility.md`: additive only.

### Needs verification

- How many folders stay expanded in real use; the report's impact is reasoned, not measured.

## 0660: Some renderer polls keep running while the window is hidden

### Task analysis

#### Tasks

1. **Route polls through the read coordinator**: pause presentation polls while the document is hidden. Status: open.

#### 1. Route polls through the read coordinator

**Problem.** These polls keep issuing reads while nobody can see the result.

**Context.** `apps/web/src/lib/read-coordinator.ts` pauses automatic reads while the document is hidden and reconciles once on return, and `apps/web/src/hooks/useCoordinatedRead.ts` is the hook for it. 1202 task 3 decided (GW-13) that `useUserCommands` keeps its 3 s backstop rather than losing it; that concerns removing the poll, not pausing it while hidden.

**Investigation.** Plain `setInterval`s, none of which check visibility:

- Docker probe, 60 s: `apps/web/src/App.tsx:683`.
- User commands, 3 s while one runs: `apps/web/src/hooks/useUserCommands.ts:68`.
- Dialogs and panels: `components/bug-report/BugReportSheet.tsx:183`, `components/docker/DockerImageStatusPanel.tsx:97`, `components/docker/DockerSettings.tsx:105`, `:214`, `components/environments/EnvironmentRecoveryCopies.tsx:119`, `components/federation/ProjectCopyDialog.tsx:171`, `components/settings/machines/useMachineMaintenance.ts:136`.
- Annotation selection, 400 ms, only while selecting: `components/browser/annotations/useAnnotationCapture.ts:491`.

**Decisions.**

- **Which polls move?**
  - **All of them except annotation selection, which keeps its timer and gains a visibility check (recommended).**
    - Pros: one scheduling owner; annotation selection is a short, user-started operation whose status the user is waiting on.
    - Cons: many small migrations, each of which has to keep its cadence.
  - **Add a visibility check to each timer.**
    - Pros: smaller diffs.
    - Cons: each one needs its own catch-up on return, which is what the coordinator already does.

### Constraints and rationale

The coordinator is read-only and must never own commands, per its header comment. "Unmount is not cancel" in the report's [invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep) applies: only the view's reads pause, not the work they watch.

### Needs verification

- How much hidden-window timer throttling already hides this in Electron and browsers. Not checked.

## Related

- [Efficiency report, D](../2026-10-27-efficiency.md#d-renderer-appswebsrc)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md), task 3
