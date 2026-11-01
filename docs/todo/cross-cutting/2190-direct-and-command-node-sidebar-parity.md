# One presentation for a machine's environments, direct or through a command node

## Task analysis

Analysed 2026-11-01 against `main` at `b965aea44`. Tasks 2–6 and part of 7
were acted on the same day; see Assumptions and decisions.

### Tasks

1. **Merged PR icon on another machine's rows**: the command node's rows for another machine never showed the merged icon. Status: done (2026-11-01).
2. **One environment row component**: replace the duplicated `RemoteEnvironmentItem` JSX with the row `EnvironmentItem` renders, fed by one row model. Status: done (2026-11-01): `EnvironmentRow` plus `environmentRowModel`, with `localEnvironmentRowFacts` and `nodeEnvironmentRowFacts` as the two adapters; one delete dialog and one row frame.
3. **Summary fields the row needs**: carry agent-mail counts, failed-mail state and the leaf's Docker availability in `NodeEnvironmentSummary`, and confirm the activity it carries is the runtime one. Status: done in part (2026-11-01): `agentMailUnread`, `agentMailFailed` and `buildActive` added and re-read on agent-mail changes. Open: Docker availability (not relayed) and live confirmation that the summary's activity keeps up with the machine's runtime activity.
4. **One project header component**: replace `RemoteProjectGroup`'s copy of `SortableProjectGroup`. Status: done (2026-11-01): `ProjectGroupHeader`, with the hover card, mail badges and project-home activity on both.
5. **One activity list and one priority order**: the bound machine's activity rows change order and lose their controls bar the moment another machine is visible. Status: done (2026-11-01): `compareActivity` and `ActivityEnvironmentList` serve both.
6. **A parity guard for future changes**: a rule agents read before editing either path, and a test that renders both paths from one fixture. Status: done (2026-11-01): the rule in `docs/architecture/federation.md` and `environment-row-model.parity.test.ts`.
7. **Smaller divergences**: shift-range selection order in merged views, empty states, drag overlay, chevron click propagation and the selected-row hover fade. Status: done in part (2026-11-01): chevron propagation, selected-row hover fade and shift-range order in the activity view are fixed by the shared components. Open: shift-range across projects in merged project/repository lists, empty states, drag overlay.

### 1. Merged PR icon on another machine's rows

**Problem.** An environment with a merged PR showed the violet merged icon on its own machine (RKMBP) but not when the same machine was viewed through the command node.

**Context.** This window's rows render `EnvironmentItem`; every other machine's rows render `RemoteEnvironmentItem` (`apps/web/src/components/federation/RemoteMachineTree.tsx`), a separate component whose comment says it is "laid out like `EnvironmentItem`" but which copies the JSX. `EnvironmentItem` had a `prState === "merged"` branch; the copy only had the auto-merge icon, so it also showed auto-merge on a merged PR.

**Investigation.** The data was never missing: the leaf's `get_environment_snapshots` record carries `prState`, `toNodeEnvironmentSummary` copies it (`packages/protocol/src/node-summaries.ts`), and `federation-ui.test.tsx` already set it for the name-signal tests.

**Decisions.**

- **How to fix it?**
  - **Share the icons in one component (recommended, done).** `EnvironmentNameIcons` renders the pipe, merged and auto-merge icons; both rows use it.
    - Pros: a new name icon cannot be added to one row only; small change.
    - Cons: only the name icons are shared; the rest of the row is still duplicated (task 2).
  - **Add the branch to `RemoteEnvironmentItem`.**
    - Pros: smallest diff.
    - Cons: leaves the same trap for the next icon.

### 2. One environment row component

**Problem.** Every addition to `EnvironmentItem` has to be repeated by hand in `RemoteEnvironmentItem`, and several have not been.

**Context.** Shared today: `EnvironmentStatusMarker`, `EnvironmentNameShimmer`, `EnvironmentNameIcons`, `UnreadBellIcon`, `EnvironmentChangeBadge`, `EnvironmentTooltipBody`, `EnvironmentMenuItems`. Duplicated: the row container, spinner/marker branch, name and "Build:" strip, machine dot, subtitle, mobile dropdown, tooltip wiring, the fork/power/restart/delete menu list, the delete dialog.

**Investigation.** Row differences found on 2026-11-01 (`EI` = `EnvironmentItem.tsx`, `RMT` = `RemoteMachineTree.tsx`, line numbers at `b965aea44`):

| Item | This window | Another machine | Data for the remote row |
| --- | --- | --- | --- |
| Unread agent-mail count | `EI:272-283,573-580` | absent | not produced (task 3) |
| Failed-mail dot | `EI:284-290,581-586` | absent | not produced (task 3) |
| Dim while stopping | `opacity-60` stopping or deleting (`EI:479`) | deleting only (`RMT:867`) | in summary (`status`) |
| Legacy diff-stats fallback, `~`, freshness | `EI:596-626` | none; a leaf without `changes_get_view` shows no badge | not in summary |
| Hover card name | `displayName` | raw `name` | — |
| Hover card fallback details | full record | `projectHome`, `branch`, `environmentType` until `get_environment` answers; drops `createdAt` (in summary) | partly in summary |
| Port line in hover card | clickable, copies address | "port N on that machine" | on demand |
| "Copy Address", "Copy Initial Prompt" | `EI:395-414` | absent | not in summary (prompt is excluded by design) |
| Fork local gate | disabled without a checkout (`EI:421`) | not checked (`RMT:815`) | `project.pathName` is in summary |
| Fork container / Start / Stop gate | `dockerAvailable` | `writable`, `busy` | Docker availability not produced |
| Delete dialog | project-home, worktree, running, open-PR and design notes (`EI:730-780`) | generic text naming the machine | `projectHome`, `environmentType`, `status` in summary; `prUrl` not |
| Delete label | "Delete" | "Delete…", disabled when not writable | — |
| Name signal "waiting" | runtime activity (`useEnvironmentDisplayActivity`) | persisted `activity` and `live` | see task 3 |
| Shimmer `id` for `aria-describedby` | set (`EI:531`) | not set (`RMT:902`) | — |
| Row element | `div role=button`, modifier-click selection | `<button>` with machine in `aria-label`, `aria-current` | — |

Intended differences, not defects: clicking a remote row opens the owner's workspace; "Open workspace" and "Copy link" exist only remotely; writes are disabled while the owner is unavailable; a remote row has no multi-select.

**Decisions.**

- **How should the two rows share code?**
  - **One `EnvironmentRow` fed by a row model, with two adapters (recommended).** `toEnvironmentRowModel(environment, stores)` for this window and `fromNodeEnvironmentSummary(summary, machine)` for others produce the same plain object (name, icons, marker state, signals, badges, mail counts, menu availability); `EnvironmentRow` renders only that model plus an actions object. `EnvironmentItem` and `RemoteEnvironmentItem` become thin wrappers.
    - Pros: a new row element is added once and the type forces both adapters to supply it; the adapters are pure and unit-testable side by side.
    - Cons: a large refactor of a hot, well-tested component; the stores `EnvironmentItem` reads must move into its adapter hook.
  - **Keep two components, share more leaf components.**
    - Pros: incremental, low risk.
    - Cons: what this task exists to stop: the container JSX stays duplicated and the next addition can still land in one place.
  - **Render other machines through `EnvironmentItem` with a fake `Environment`.**
    - Pros: no new abstraction.
    - Cons: `EnvironmentItem` reads this window's stores by environment id, so a synthesized record would show this machine's mail, diff and build state for another machine's id.

### 3. Summary fields the row needs

**Problem.** Some row elements cannot be shown for another machine because the leaf never sends their data.

**Context.** The command node builds summaries in `apps/backend/src/core/nodes/node-read-model.ts` (`readEnvironments`) from the leaf's `get_environment_snapshots`, passed through `toNodeEnvironmentSummary`. Summaries are bounded and content-free (`node-summaries.ts` header).

**Investigation.** Missing from the producer: per-environment unread agent-mail count and failed-inject state; the leaf's Docker availability; per-project mail counts (task 4). Not verified: whether the leaf's persisted `agentActivityState` lags the runtime `containerStates` that `useEnvironmentDisplayActivity` reads on the leaf itself, which would make "waiting" and the activity ring disagree between the two paths.

**Decisions.**

- **Where do the extra fields come from?**
  - **Add bounded optional fields to `NodeEnvironmentSummary` and the leaf snapshot (recommended).** Counts only (`unreadMailCount`, `failedMailCount`), a machine-level `dockerAvailable`, absent from older leaves.
    - Pros: one read the command node already makes; counts carry no content; older leaves degrade to today's display.
    - Cons: touches `packages/protocol`, which needs the full suite; mail summaries change often, so the summary fingerprint changes more.
  - **Read them on demand per row through `invoke_on_node`.**
    - Pros: no protocol change.
    - Cons: one call per visible row per refresh; idle rows never update.
- **Activity source.**
  - **Check first, then make the snapshot report the runtime activity if it lags (recommended).**
    - Pros: fixes it at the source for every client.
    - Cons: needs a live two-machine check.
  - **Accept the persisted value.**
    - Pros: nothing to do.
    - Cons: "waiting" can differ by path.

### 4. One project header component

**Problem.** `RemoteProjectGroup` (`RMT:420-665`) is a copy of `SortableProjectGroup`, and lacks parts of it.

**Context.** Item list of the project context menu is already pinned by `federation-ui.test.tsx` ("another machine's menus offer what this machine's do").

**Investigation.** Only on this window: project-level unread and failed mail (`SortableProjectGroup.tsx:129-146,211-224`); the hover card with Git URL, path and "N environments (M running)" (`:227-245`); the project-home activity indicator (`:302`, `ProjectHomeActivity`), whose `activity` and `hasUnreadWork` are already in the summary. Smaller: the GitHub link is built from `repositoryHint` remotely and from `gitUrl` locally; "Copy to Machine" is always offered remotely; the remote chevron does not stop click propagation; the remote home lookup does not skip a deleting home.

**Decisions.**

- **How to share the header?**
  - **One `ProjectGroupHeader` fed by a header model, as in task 2 (recommended).**
    - Pros: same reasons as task 2.
    - Cons: the drag handle and actions differ and must be passed in.
  - **Port the missing parts into `RemoteProjectGroup`.**
    - Pros: quick; the home indicator needs no protocol change.
    - Cons: leaves the duplication.

### 5. One activity list and one priority order

**Problem.** In "By activity", this window's own rows change when any other machine becomes visible: `HierarchicalSidebar` switches from its local tree to `FederatedActivityList` (`HierarchicalSidebar.tsx:559-568`).

**Context.** Documented as intended in `docs/architecture/federation.md` ("Federated priority recency uses the activity snapshot timestamp …; local priority uses `lastActivityAt`").

**Investigation.** The switch changes: priority recency (`activityUpdatedAt ?? lastActivityAt` vs `lastActivityAt`, `aggregate.ts:90-93` vs `HierarchicalSidebar.tsx:183-187`), tie-breaks (backend id, environment id vs project order, environment order, id), the sticky controls bar with "Create environment" and the total and waiting counts (absent), project-home activity rows (absent), row-move animation (absent), and the selected-row class (the remote one fades its accent on hover).

**Decisions.**

- **One policy or two?**
  - **One sort function and one list for both (recommended).** Use one recency rule (snapshot timestamp falling back to `lastActivityAt` is the safer of the two, because snapshot writes are filtered), the same tie-breaks, and render the bar, home rows and animation whenever the list is shown.
    - Pros: the user's rows do not reorder because a filter changed.
    - Cons: changes a documented behaviour; `HierarchicalSidebar.activity-sort.test.tsx` and `aggregate.test.ts` must be merged.
  - **Keep both and document them.**
    - Pros: nothing to change.
    - Cons: the bifurcation stays visible.

### 6. A parity guard for future changes

**Problem.** Nothing stops the next change from landing on one path only; the merged icon is the example.

**Context.** Area rules are listed in the root `AGENTS.md` table and Claude Code loads `AGENTS.md` files next to the code.

**Investigation.** Parity tests exist for some elements (`federation-ui.test.tsx`: markers, name signal, transition dots, change badge, project menu items). None cover mail badges, the project hover card, the delete dialog, sort policy or the activity bar.

**Decisions.**

- **What guard?**
  - **Rule plus a model-level parity test (recommended).** The rule (in `docs/architecture/federation.md`, "One presentation for both paths", linked from the root `AGENTS.md` table) landed 2026-11-01. After task 2, add a test that builds the row model from an `Environment` and from the equivalent `NodeEnvironmentSummary` and asserts they are equal, field by field.
    - Pros: the test fails when a field is added to one adapter only.
    - Cons: needs task 2.
  - **Rule only.**
    - Pros: available now.
    - Cons: depends on every agent reading it.

### 7. Smaller divergences

**Problem.** Minor differences that do not belong to tasks 2–5.

**Context.** Found reading the code on 2026-11-01.

**Investigation.**
- Shift-click range selection uses the plain tree's order (`HierarchicalSidebar.tsx:829-858`), which differs from the on-screen order in merged and federated-activity views. Inferred from code, not reproduced.
- Empty states differ ("No projects yet" with an add button locally; plain text in merged lists and machine sections).
- No `DragOverlay` in `RemoteMachineTree` or `MergedProjectList`, including for this window's projects inside a merged list.
- Offline machines are hidden in "By project"/"By repository" but shown dimmed in "By machine" and "By activity".

**Decisions.**

- **Fix individually or with tasks 2–5?**
  - **Fold each into the task that rewrites its code; fix shift-range on its own after reproducing it (recommended).**
    - Pros: no throwaway fixes.
    - Cons: they wait for the refactors.
  - **Fix now.**
    - Pros: quick wins.
    - Cons: most touch code tasks 2–5 replace.

## Current state

Every environment row, row frame, delete confirmation, project header, project
home indicator and activity list is one component used for this window's
machine and for other machines through a command node. The adapters gather
facts; `environment-row-model.parity.test.ts` feeds one environment through
both and requires the same row. The rule for future changes is in
`docs/architecture/federation.md`, "One presentation for both paths".

## Outstanding work

- Task 3: relay a machine's Docker availability, or decide it stays a known
  gap (container actions on another machine are gated by it being writable).
- Task 3: confirm on two real machines that a remote row's activity keeps up
  with the owner's own row (the owner reads runtime activity events; the
  summary carries the persisted activity).
- Task 7: shift-click range selection across projects in merged
  project/repository lists follows the bound project tree's order, not the
  on-screen order; empty states differ (no "Add your first project" in merged
  lists); merged lists have no drag overlay.

## Constraints and rationale

Summaries stay bounded and content-free: counts and states, never prompts, mail bodies or URLs. A field added to a summary is optional so older leaves keep working.

## Needs verification

- No `dev:test` fixture runs two paired machines, so none of this has been seen
  through a real command node by an agent. Check on RKMBP through the command
  node: the merged icon, agent-mail badges, project home indicator, activity
  bar and the shared delete confirmation.
- Whether the leaf's persisted activity lags its runtime activity (task 3).
- The shift-range selection mismatch in merged lists (task 7).

## Assumptions and decisions

### Task 1: shared component rather than a branch

Chose a shared `EnvironmentNameIcons` so the pipe, merged and auto-merge icons cannot drift again; the wider row stays for task 2.

### Task 6: where the rule lives

Put the rule in `docs/architecture/federation.md` with a row in the root `AGENTS.md` table rather than new `AGENTS.md` files in three component folders, so there is one copy.

### Task 2: the row model decides; adapters only gather facts

Chose one pure `environmentRowModel(facts)` and one `EnvironmentRow` over
sharing more leaf components, because a fact both adapters must supply is a
type error when one forgets it, and the parity test can compare the two
adapters directly. Rendering another machine's row through `EnvironmentItem`
with a synthesized record was rejected: `EnvironmentItem` reads this window's
stores by environment ID.

### Task 2: which side's behaviour won where they differed

- Delete stays enabled while an environment is marked deleting, as on this
  window's rows: a failed deletion keeps its marker and deleting again retries
  it. Another machine's rows used to disable it.
- Rows dim while stopping on both (only this window's did).
- The menu says "Delete" on both, and both confirm with the same dialog, which
  names the machine whenever the client shows machines.
- Where machines are shown, a row's button is labelled "name, on machine,
  activity" on both (only other machines' rows were), and its grip is labelled
  "Reorder name" on both.
- Fork local is disabled for another machine's project without a checkout
  (`pathName`), as this window disables it for a project without `localPath`.
- The hover card's fallback details for another machine now include the
  creation date, which the summary already carried.

### Task 3: Docker availability is not relayed

This window learns it from a `check_docker` probe of its own; relaying it would
add a machine-level field and a refresh path for a rare state. Another
machine's container actions stay gated by the machine being writable. Recorded
as outstanding.

### Task 3: agent-mail changes re-read every project of the machine

`agent-mail-summary` changes name no project, so `NodeReadModel` schedules every
known project of that machine through the existing per-node debounce, rather
than a full hydrate per message.

### Task 4: the hover card replaces the native title

Another machine's project header had only a `title` tooltip; it now has the same
hover card as this window's, whose last line says where a click goes ("Click to
open on Machine A"). Keeping both would show two tooltips. The "+" button shows
on hover through the same CSS rule on both.

### Task 4: opening another machine's home lands on its Home tab

`openMachineWorkspace` and `WorkspaceRealmHost` ignored `boardTab` when an
environment was also named; both now apply it, and `RealmBoardTab` accepts
`home`, so the home indicator opens the same view on every machine.

### Task 5: the priority order uses the snapshot time on both

Chose the cross-machine rule (activity snapshot time, falling back to the last
activity time) because snapshot writes are already filtered from it, and the
sidebar's own tie-breaks (project order, then environment order) for both,
after the machine ID. Every existing ordering test passed unchanged under the
shared comparator.
