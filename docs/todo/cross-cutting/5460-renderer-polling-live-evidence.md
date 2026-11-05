# Renderer polling: live evidence left from efficiency report 0620

## Task analysis

Analysed 2026-11-05 against `main` at `69a3b4ca5`.

What was left of `docs/reports/efficiency-logging-database/0620-e23-renderer-polling.md` (batch E23) once its code was done. That report is deleted; read it with `git show 69a3b4ca5:docs/reports/efficiency-logging-database/0620-e23-renderer-polling.md`, or at the parent of its deletion commit, where it ends with its outcome table. The code of all three parts landed in #1754 (`bfac1f577`); its numbers and decisions are in [1202 task 3](1202-efficiency-review-follow-ups.md) under "WEB-12, WEB-13, WEB-14, WEB-16, WEB-18 and WEB-19". Each task below is one of the report's "Needs verification" items that only a live install can settle.

### Tasks

1. **Environment reads during busy periods**: part `0620` (WEB-12), its Needs verification item. Status: open.
2. **How many folders stay expanded in real use**: part `0630` (WEB-13), its Needs verification item. Status: open.
3. **Hidden-window pauses in a real Electron window**: part `0660` (WEB-18), its Needs verification item. Status: open.

### 1. Environment reads during busy periods

**Problem.** The report asked for the rate and size of environment reads during busy periods, and nothing has measured either on a real install.

**Context.** Each `environment` announcement names its record and project. `useEnvironmentListSync` (`apps/web/src/hooks/useEnvironmentListSync.ts`) now reads that one record through `get_environment_snapshot` when it is the only change waiting. Several waiting at once (a reorder announces once per moved environment), an announcement with no project, and every explicit resync still read the project's list through `get_environment_snapshots`. Announcements come from many storage writes (`storage-projects.ts`, `storage-public-operations.ts`) and from PR health (`announceEnvironmentPrHealth`, `storage.ts`), so a busy period is mostly running environments changing status and PR state.

**Investigation.** Measured here on 2026-11-05 with the backend command fixtures (`createEnvironment`, which makes small records): one record is 356 bytes of JSON; the list is 358 bytes for 1 environment, 1,786 for 5, 7,171 for 20 and 17,971 for 50. Real records carry more fields, so both numbers grow, but the ratio stays one record against N. 1202 task 3 counted reads in Chromium on a `dev:test` profile: one rename is 1 record read and 0 list reads, one deletion 2 record reads and 0 list reads. Not run: how many announcements per minute a busy project produces, and what share of them arrive alone rather than in a burst. A busy period needs running agents, and this batch could not run a real provider turn.

**Decisions.**

- **How to measure it?**
  - **Count `get_environment_snapshot` and `get_environment_snapshots` calls and response bytes in the browser under test, as 1202 task 3 did, on a live `dev:test` profile with several agents running for an hour (recommended).**
    - Pros: real announcement mix, including PR health and status changes; the same counting as the existing before and after numbers.
    - Cons: needs real provider turns, so it costs money; the result depends on the project.
  - **Replay a recorded announcement stream through the hook in a test.**
    - Pros: free and repeatable.
    - Cons: there is no recorded stream yet, and making one needs the same live run.
- **If list reads still dominate?**
  - **Read each pending record separately when only a few are waiting, falling back to the list above a small count (recommended).**
    - Pros: a short burst costs a few rows instead of the whole project; the list stays the answer for reorders.
    - Cons: a second threshold to tune; more requests for a medium burst.
  - **Leave it.**
    - Pros: the burst collapse already bounds a burst to one list read.
    - Cons: a large project still pays its whole list for every burst.

### 2. How many folders stay expanded in real use

**Problem.** While the All files tab is open, every visible expanded truncated folder is still listed by the backend every 5 s. The report's impact for this was reasoned, not measured, and how many such folders people keep open is unknown.

**Context.** `get_file_subtree` and `get_local_file_subtree` now take `knownDigest` and answer `{ unchanged: true, digest }` with no contents when a folder has not changed (`conditionalSnapshot`, `apps/backend/src/core/commands-terminal.ts`). The renderer keeps each folder's digest beside its contents (`apps/web/src/lib/file-subtree-loads.ts`). The backend still walks every folder on each read, because that walk is what notices a change in an ignored folder; for a container it is one `docker exec` per folder per tick. The report's second option, skipping folder reads while a watched worktree's snapshot revision is unchanged, was not taken.

**Investigation.** Proven here: unchanged answers for both commands (`get_local_file_subtree answers an unchanged directory with no contents` and `get_file_subtree answers an unchanged container directory with no contents` in `apps/backend/tests/commands-registry-file-subtrees.test.ts`), and 1202 task 3's Chromium count of 2 reads with 2 `unchanged` answers in 12 s for one expanded folder. Not run: a count of expanded truncated folders in real sessions, and the cost of the per-folder walk in a large container worktree.

**Decisions.**

- **How to find out?**
  - **Read the expanded folders and loaded subtrees from the Files panel store (`expandedFolders`, `fileSubtrees`) on the maintainer's own installs over a working week (recommended).**
    - Pros: no code change; sends nothing anywhere.
    - Cons: one person's habits; read by hand from the renderer.
  - **Count folder reads and their `unchanged` answers in the backend's `recurringWorkMetrics`, as the whole-tree read already does.**
    - Pros: readable from any reachable install at `/__orkestrator/metrics`.
    - Cons: a new counter for one question; it counts reads, not how many folders a person keeps open.
- **If many folders stay expanded?**
  - **Skip a folder read while a watched worktree's snapshot revision is unchanged, keeping the 5 s read for unwatched targets (recommended).**
    - Pros: no walk and no request at all for the common local case.
    - Cons: only helps watched targets; a missed hint leaves a folder stale until the next full refresh.
  - **Keep the walk on every tick.**
    - Pros: always current, including ignored folders the watcher does not report.
    - Cons: one walk, and for containers one `docker exec`, per folder every 5 s.

### 3. Hidden-window pauses in a real Electron window

**Problem.** The report asked how much hidden-window timer throttling already hid these polls. The polls now issue no reads at all while the document is hidden, so throttling no longer matters to the browser; what is left is whether a real Electron window reports itself hidden when it is minimised, hidden or covered, which is what makes the pause happen there.

**Context.** `startCoordinatedPoll` (`apps/web/src/lib/coordinated-poll.ts`) hands every poll the report names to the read coordinator, which pauses on `document.visibilityState === "hidden"` (`apps/web/src/lib/read-coordinator.ts`) and reads once on return when the interval has passed. The desktop app leaves Electron's `backgroundThrottling` at its default. A window that stays `visible` while covered would keep polling at full rate, as before.

**Investigation.** Proven here: `coordinated-poll.test.ts` (`stops while the window is hidden and reads once on its return`; 200 reads by a 3 s poll in 10 min hidden became 0), the hidden-window tests in `useUserCommands.test.tsx` and `useAnnotationCapture.test.tsx`, and 1202 task 3's Chromium run (8 commands in 12 s visible, 0 hidden). Not run: a real Electron window, minimised, hidden and fully covered on macOS, Linux and Windows. 1202 lists the same gap for `local-gateway-transport-electron.spec.ts`, which needs a disposable display.

**Decisions.**

- **How to check it?**
  - **Run the Electron agent suite on a disposable display with a spec that minimises, hides and covers the window and counts renderer commands (recommended).**
    - Pros: the real main process and window; repeatable.
    - Cons: needs a host with a disposable display, and covering a window is platform-specific.
  - **Check by hand in a packaged build with the gateway's request metrics.**
    - Pros: no new spec.
    - Cons: not repeatable.
- **If a covered window stays `visible`?**
  - **Also pause on the window's blur and occlusion events relayed from the main process (recommended).**
    - Pros: covers what the page cannot see itself.
    - Cons: a new desktop-to-renderer signal with its own compatibility row.
  - **Accept it.**
    - Pros: no change; minimised and hidden windows still pause.
    - Cons: a covered window keeps polling.

## Constraints and rationale

- The read coordinator is read-only and must never own commands; upload retries in `useAnnotationCapture` stay on their own timer for that reason.
- [Report invariants](../../reports/2026-10-27-efficiency.md#invariants-every-fix-must-keep): only the view's reads pause, never the work they watch, and a missed event stays detectable through the list resync.
- Use an isolated `dev:test` profile for anything run locally; never point a check at a production instance.

## Related

- [1202 efficiency follow-ups](1202-efficiency-review-follow-ups.md), task 3
- [Version compatibility](../../architecture/version-compatibility.md#register): rows for the single-environment read and the conditional folder reads
- [Efficiency report, D](../../reports/2026-10-27-efficiency.md#d-renderer-appswebsrc)
