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

## Outcome

Checked item by item against the code on 2026-11-05, on `main` at `69a3b4ca5`, before this file was deleted. All three parts had already been built by #1754 (`bfac1f577`, merged 2026-11-04), after this file was analysed at `a2bba9d8`; its numbers and decisions are in [1202 task 3](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md). So every task's finding no longer holds, and the evidence is that work and its tests, all of which pass on `69a3b4ca5`. This batch added one test, for the container folder read that #1754 left untested. What needs a live install is [5460](../../todo/cross-cutting/5460-renderer-polling-live-evidence.md).

| Part | Task | Outcome | Code, evidence or to-do |
| --- | --- | --- | --- |
| 0620 | 1. Read only the changed environment | No longer holds: built in #1754 | A lone pending announcement reads its one record: `useEnvironmentListSync.ts` calls `refreshEnvironmentSnapshot` (`useEnvironments.ts`), which reads `get_environment_snapshot` (`commands-registry-environments.ts`) and removes the environment on `null`. Tests in `tests/unit/hooks/useEnvironmentListSync.test.ts` under `a lone announced environment`: `reads that record and not the project's list`; `falls back to the list, and stays there, on a backend without the read`; `a change landing during its read is read afterwards, not lost`; `several changes waiting at once read the list once`; `an announcement without a project still reads every list`. In `useEnvironments.test.ts` under `refreshEnvironmentSnapshot`: `updates that environment and keeps the others' objects`; `removes an environment the backend no longer has`; `adds one another client created`; `reports a backend that predates the read, changing nothing`; `a failed read is not mistaken for a missing command`. Backend: `a single environment snapshot reads as the list does, private fields removed` (`commands-registry-environments.test.ts`). |
| 0620 | Decision: patch one record? | No longer holds: the report's recommendation was to wait for a measurement; #1754 measured and built the one-record read | 1202 task 3, in Chromium on a `dev:test` profile: a rename went from 1 list read to 1 record read and 0 lists, a deletion to 2 record reads and 0 lists. The report's cons are covered: a reorder announces several environments, which still read the list once; a removal is a `null` record; the store replaces a record by id, so its project comes from the backend. |
| 0620 | Compatibility with older backends | Done in #1754 | A backend without `get_environment_snapshot` falls back to the list until the next explicit resync; row in the [version compatibility register](../../architecture/version-compatibility.md#register). Test: `falls back to the list, and stays there, on a backend without the read`. |
| 0620 | Needs verification: RPC rate and size during busy periods | Moved to a to-do | Sizes measured here with the backend command fixtures: one record 356 bytes; the list 1,786 bytes for 5 environments, 7,171 for 20, 17,971 for 50. The rate in a busy period needs running agents: [5460](../../todo/cross-cutting/5460-renderer-polling-live-evidence.md) task 1. |
| 0630 | 1. Conditional subtree reads | No longer holds: built in #1754 | `get_local_file_subtree` and `get_file_subtree` take `knownDigest` (`commands-registry-terminal.ts`) and answer `{ unchanged, digest, value? }` through `conditionalSnapshot` (`commands-terminal.ts`). That is the same contract as the report's `snapshotResponse`, without the `view` stamp, which a folder read has no owner for. The renderer keeps each folder's digest (`fileSubtreeDigests`, `file-subtree-loads.ts`, `filesPanelStore.ts`) and leaves `fileSubtrees` alone when a folder is unchanged. Tests: `get_local_file_subtree answers an unchanged directory with no contents` (#1754) and `get_file_subtree answers an unchanged container directory with no contents` (this batch, `d9bd7cb2b`), both in `apps/backend/tests/commands-registry-file-subtrees.test.ts`. The new one fails when the command ignores the digest. In `file-subtree-loads.test.ts`: `a directory re-read with its digest and found unchanged keeps what is held`; `a changed directory replaces the contents and the digest`; `a backend that sends no digest is asked afresh every time`; `a failed re-read keeps the digest, and an unchanged answer then clears the failure`; `a retried or collapsed directory is read without a digest`. |
| 0630 | Decision: how to skip the work? | Done: the recommended option | `knownDigest` on both commands, as above. The second option, skipping reads while a watched snapshot revision is unchanged, was not taken; whether it is worth it depends on 5460 task 2. |
| 0630 | Constraint: an explicit refresh must still re-read | Holds | The explicit read in `useFilesPanel.ts` runs `loadVisible({ refresh: true })` and then `reloadFolders()`. Folder reads are never cached on the backend ("each expansion or refresh reads the directory as it is now"), so every refresh walks the folder; a digest only drops a payload that would be identical. Shown by the changed-listing steps of both backend tests above. |
| 0630 | Constraint: additive command change | Done in #1754 | Without `knownDigest` both commands answer the raw subtree as before (asserted in the new container test). A backend that ignores the digest reads as changed with no digest: `a backend that sends no digest is asked afresh every time`; row in the [version compatibility register](../../architecture/version-compatibility.md#register). |
| 0630 | Needs verification: how many folders stay expanded in real use | Moved to a to-do | Needs real use: [5460](../../todo/cross-cutting/5460-renderer-polling-live-evidence.md) task 2. |
| 0660 | 1. Route polls through the read coordinator | No longer holds: built in #1754 | `startCoordinatedPoll` (`apps/web/src/lib/coordinated-poll.ts`) replaced the bare timer at every site the report names: `App.tsx` (Docker probe, 60 s), `useUserCommands.ts` (3 s), `BugReportSheet.tsx`, `DockerImageStatusPanel.tsx`, both `DockerSettings.tsx` polls, `EnvironmentRecoveryCopies.tsx`, `ProjectCopyDialog.tsx`, `useMachineMaintenance.ts`, and annotation selection in `useAnnotationCapture.ts`. Each keeps its interval. Tests in `coordinated-poll.test.ts`: `stops while the window is hidden and reads once on its return`; `a return before the interval has passed reads nothing extra`; `hidden from the start, it reads only after the window shows`; `stops while the transport is disconnected, and reads on reconnect`; and `<file> polls through the coordinator` for each named file. Also `the running-command poll stops while hidden and reads again on return` (`useUserCommands.test.tsx`). 1202 task 3: a 3 s poll went from 200 reads in 10 min hidden to 0. |
| 0660 | Decision: which polls move? | Done, with one difference from the recommendation | Every named poll moved. The report recommended keeping annotation selection on its own timer with a visibility check; #1754 moved it to the coordinator at `critical` priority instead. Pros: one scheduling owner and no separate catch-up code; the coordinator reads `critical` polls first, within about 50 ms of the window's return. Cons: none found against the recommended option. Its timer would also have needed its own return handling. Tests: `the selection poll stops while the window is hidden and reads at once on return` (`useAnnotationCapture.test.tsx`); `critical polls are read first on return` (`coordinated-poll.test.ts`). |
| 0660 | Constraint: the coordinator never owns commands | Holds | `startCoordinatedPoll` is documented as reads only. The upload retry in `useAnnotationCapture.ts` (`CAPTURE_RESUME_INTERVAL_MS`) is a mutation and stays on its own timer. Test: `the annotation file's only interval left is its upload retry` (`coordinated-poll.test.ts`). |
| 0660 | Constraint: unmount is not cancel | Holds | Only the polls' reads pause; the commands, containers, copies and maintenance jobs they watch run in the backend and are not touched. The stop function only disposes the read subscription: `the stop function ends it, and leaves nothing in the coordinator` (`coordinated-poll.test.ts`). |
| 0660 | Needs verification: how much hidden-window throttling already hides this | No longer holds for the browser; the Electron part moved to a to-do | The polls now issue no reads while the document is hidden, whatever the timer throttling, so throttling no longer changes the cost (0 reads hidden in Chromium, 1202 task 3). Whether a real Electron window reports hidden when minimised, hidden or covered was not checked: [5460](../../todo/cross-cutting/5460-renderer-polling-live-evidence.md) task 3. |
