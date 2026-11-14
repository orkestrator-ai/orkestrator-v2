# Prove ledger retention on a real data directory

## Task analysis

Analysed 2026-11-14 against main at `dc90609bf`.

From efficiency batch E3 (Retention and deletion), parts `0730` and `0540`: their "Needs verification" items, the finished-boundary policy that waits on a measurement, and one gap the work exposed. The batch file was deleted when E3 was built; it is in Git history at the commit named in [Related](#related). Tasks 4 and 5 were done on 2026-11-14 (see [Assumptions and decisions](#assumptions-and-decisions)); what is left waits on a measurement of a real ledger, which only the user can take.

### Tasks

2. **Decide on finished turn boundaries from that measurement**: keep leaving them, or prune them past the window. Status: blocked (waits on 7568: 5821 task 1).

### 2. Decide on finished turn boundaries from that measurement

**Problem.** Finished boundaries stay for the life of the data directory, except when their environment is deleted, so the table still grows.

**Context.** 0730 task 2 chose to leave them until a measured table size justifies a policy. `nextTurnOrdinal`, `latestTurnForThread` and `getHistory` read these rows, and a retired boundary still lists in a thread's history. Since task 5, boundaries of environments deleted before purges were recorded are purged by the startup reconcile, so what still grows is the boundaries of live environments.

**Investigation.** Not run; depends on task 1, the measurement on a copy of a real ledger, which is in the manual-test checklist (7568: 5821 task 1). Each row is small, about one per turn, and `activeTurns()` no longer reads finished rows. The age walk never revisits a retired row. Task 4's renderer check (2026-11-14) showed what a retained boundary buys: the turn history still lists the retired turn, as "Unavailable" with the expiry reason in its tooltip.

**Decisions.**

- **Prune them?**
  - **Leave them unless task 1 shows the table matters (recommended).**
    - Pros: no risk to ordinals or history.
    - Cons: the table keeps growing.
  - **Prune boundaries past the window.**
    - Pros: bounded.
    - Cons: needs an audit of every reader, including anything that expects a thread's ordinals to be continuous, and the next ordinal must not restart from a pruned maximum.

## Assumptions and decisions

### Task 3: ledger durability and archive window

On 2026-11-09, implemented the agreed ledger-only NORMAL synchronization and
30-day archive window. FULL retains power-loss durability but syncs each ledger
commit; NORMAL avoids those per-commit syncs while keeping WAL consistent and
commits safe across application crashes or SIGKILL. Recent ledger commits may
roll back after power loss or an OS crash. The main store stays FULL.
Keeping 90 days retains more bodies but increases maintenance work; 30 days
reduces that backlog. Worker threads and a size cap remain out of scope.
Existing batch limits and yields are unchanged. Task 3 remains open for live
disk-contention evidence; the fixture proves scheduling behavior, not a maximum
stall duration on a real disk.

### Task 4: a client against retired rows

On 2026-11-14 the recommended route was taken: an isolated `dev:test` profile with a hand-aged ledger, with no provider login and nothing billed. The policy's window was not shortened (it has no setting); every timestamp was moved 40 days back instead, which reaches the same rows.

- Profile: `ORKESTRATOR_HOST_REACHABILITY_CHECK=off mise run dev:test --profile ledger-5821 --fixture --no-agent-credentials --no-host-seed --agent-platforms pi --headless` on beelink2, at commit `1add7b492` (this branch). No Docker.
- Model: `e2e/agent-testing/idle-observation-fake-pi.ts` on loopback, named in the profile's own Pi `models.json` and set as Pi's saved default in its `settings.json`.
- Turn: the `orkestrator` CLI created a local fixture environment and started one Pi session with "run this shell command and wait for it: printf … > retention-probe.txt". The ledger recorded a finalized turn, an open segment, turn, segment and operation measurements, and five frames.
- Before: headless Chromium (Playwright) showed the thread header "Thread changes +1 -0 · Final", the turn history row "This turn's changes +1 -0 · Final" with a control to open the turn, and the tool card's "Tool change: measured in the workspace around this tool +1 -0".
- Ageing: with the profile stopped, every `*_at` timestamp in `change-tracking.sqlite` except `expires_at` was moved back 40 days; the profile was started again and its first retention pass ran two minutes later.
- After the pass the ledger held the turn's boundary row and the open segment with its measurements; the turn and operation measurements, the operations and the frames were gone.
- After, on a fresh page load: the turn history row read "changes ? · Unavailable", with "Past the retention window, so its details were removed" as its tooltip, and offered no control to open the turn. The tool card showed the bridge's own changed-file list (`retention-probe.txt +1`, "Contents were not kept; files open in their current state.") instead of the measured tool change. The thread header and the Thread changes tab still showed +1 -0, read from the open segment's baseline.

Result: no renderer surface depends on retired frames, operations or measurements beyond the turn's own view, and each degraded state says why. No code change was needed. Recorded in [change tracking, age-based retention](../../architecture/change-tracking.md#age-based-retention).

### Task 5: environments deleted before this change

Chose the recommended option: one reconcile after startup, from a store read that succeeded, only for ids absent from it. It runs once, just before the first retention pass (two minutes after start), and requests the ordinary purge (`environmentDeleted`) for each environment id the ledger names that `loadEnvironmentIdsForCleanup` does not return (`apps/backend/src/core/change-tracking/deleted-environment-reconcile.ts`).

- **Which store read.** `loadEnvironmentIdsForCleanup`, the strict read the other orphan sweeps use, not `loadEnvironments`: it throws on a missing, corrupt or incomplete store instead of answering empty, which would have requested a purge for every environment. A throw purges nothing and logs `deleted-environments.reconcile-failed`.
- **Order of reads.** Each ledger page is read before its own store read, so an environment created while the store is being read has no ledger rows yet and is not a candidate. A minimum age, as the disk-state sweeps use, was not added: ledger rows are written only for environments the store already holds.
- **Which ids.** Bindings, turn boundaries, thread segments and environment-net measurements, read as a skip scan (one index seek per distinct id; `ledger-scan-plans.test.ts` plans the statements). The ids are read in pages of up to 4,096 (`ledgerEnvironmentIdPage`, a cursor in the ledger's byte order) until the last page, so live or excluded ids ahead of an orphan cannot starve it; a first version stopped at 4,096 ids with no cursor, which Multi Review caught. Coordinator (`coordinator:`) and bug-report (`bug-report:`) runtime ids are never candidates, because the environment store never holds them; whether those runtimes leave rows that need the same treatment was not investigated.
- **Once, not hourly.** Ids an environment delete leaves behind are already covered by its recorded purge; the reconcile clears the backlog from before that and any delete that never reached the step, which a restart picks up.

Tests: `deleted-environment-reconcile.test.ts` (purge of a missing id including its open segment, a failed read, every live id kept, coordinator and bug-report ids, paging past a full page of live and excluded ids, a backlog larger than one page, a store read after every page, an environment created during the read, a purge already pending, shutdown during the read, read order, and the production first-pass scheduling) and `backend-wiring.test.ts` (the factory hands the strict read to the service). Live: on the task 4 profile, a made-up environment's turn and open segment were copied into the ledger with no store record and no purge entry; the restart's first pass requested its purge and deleted its rows, and the live environment kept its own. The first run on the user's real install is a checklist item (7568: 5821 task 5 (user part)).

## Related

- Batch file E3, parts 0730 and 0540 (deleted): its outcome is the closing check of E3 (`git show 413bd6219:docs/reports/2026-11-06-efficiency-logging-database-outcome.md`), which names the commit that holds the file's last version.
- [Change tracking](../../architecture/change-tracking.md#age-based-retention)
- [5361](5361-retention-pass-on-a-large-real-store.md), the object store side of the pass
- [5820](5820-removed-project-kanban-notes-plans.md), the rest of the same batch
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (task 1, measuring a copy of a real ledger; task 3, timing a first retention run on a copy of an old real ledger) moved there on 2026-11-10, and task 5's first run on the user's real install on 2026-11-14.
