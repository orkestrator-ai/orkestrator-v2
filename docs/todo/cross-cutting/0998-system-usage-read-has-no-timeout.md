# System usage read has no timeout, so one stalled disk call hangs every meter

## Task analysis

Analysed 2026-11-05 against `main` at `1c2f12837`.

### Tasks

1. **Bound the disk reading**: a hung `fs.statfs` on the data directory stalls the whole system sample. Status: done (2026-11-05).
2. **Give usage reads a client timeout**: a read that never returns is never reported as failed. Status: done (2026-11-05).
3. **Confirm the stall on a real slow disk**: the cause is inferred from code, not observed. Status: open (the hang and the fix are shown on a stalled mount; whether it is what happened on the affected node needs that node).

### 1. Bound the disk reading

**Problem.** If the disk holding the backend's data directory stalls, `get_system_usage` never answers. CPU, RAM and GPU are missing as well as disk, and every later request joins the same hung read, so it does not recover.

**Context.** `createSystemUsageReader` in `apps/backend/src/core/system-usage.ts` waits on RAM, GPU and disk together with `Promise.all` (`:519-525`). The disk figure is `readDiskPercent` (`:137-148`), which calls `fs.statfs` with no timeout; its `catch` handles errors only. In-flight reads are shared through `pendingReads` (`:509-515`), so a hung promise is never replaced. `get_environment_process_usage` joins its own in-flight read the same way (`pendingProcessRead` in `commands-registry-system.ts`) and first calls `storage.loadEnvironments()`.

**Investigation.** Corrected on 2026-11-05: `statfs` was not the only unbounded source. The spawned probes carry timeouts (`runCommand` with `timeoutMs: 1_500` for `vm_stat` and the GPU probes), but `readLinuxGpuPercent` also reads `/sys/class/drm` with none, and it waits in the same `Promise.all`. The tiles are CPU, RAM, GPU and disk, all four empty in the report, which a hung `Promise.all` explains and a disk-only failure would not.

**Decisions.**

- **How to bound the disk read?**
  - **Race `statfs` against a short timeout and report `diskPercent: null` (recommended).**
    - Pros: the field is already nullable and handled by the UI; CPU and RAM keep flowing; a late result is simply dropped.
    - Cons: the underlying `statfs` call stays pending in a worker thread until the disk answers, so repeated polls on a long stall could pile up calls unless one is kept in flight and reused.
  - **Sample disk on its own slower schedule and cache it.**
    - Pros: takes disk I/O out of the hot path entirely.
    - Cons: a larger change; a cached figure can look current when it is not.
- **What timeout?** Match the 1.5 s used by the other probes unless measurement shows `statfs` is legitimately slower on network disks.
- **Clearing a hung shared read.** The shared read must also be bounded, or a stuck promise keeps absorbing requests. Keep one in-flight `statfs` per path and let the timeout resolve the shared read.

### 2. Give usage reads a client timeout

**Problem.** The renderer has no timeout around a usage read, so a read that never returns never sets `failed`, and the panel shows "Loading processes…" forever.

**Context.** `useUsageRead` in `apps/web/src/hooks/useSystemUsage.ts` reads through `useCoordinatedRead`; `failed` is `state?.status === "error"`. A pending read never reaches `error`. A grep of `apps/web/src/lib/read-coordinator.ts` and `useCoordinatedRead.ts` for read timeouts found none that apply here.

**Investigation.** Neither `invoke` transport can be aborted, a cost the options below did not list: a request that times out stays open. Each retry alongside it would add another, and a browser allows few connections per origin on HTTP/1.1, shared with the whole app. The panel-side half (showing the failure) is task 2 of [0997](0997-process-usage-popover-empty-on-command-node.md). Run live on 2026-11-05 with requests held at the network: "Loading processes…" until 20 s, then the failure, with one request per key over 52 s, and full recovery about 20 s after the requests settled.

**Decisions.**

- **Where to time out?**
  - **In `useUsageRead`'s `read`, rejecting after a bound (recommended).**
    - Pros: local to the usage hooks; turns a hang into the existing `error` state; the next poll retries.
    - Cons: the abandoned request keeps running on the backend.
  - **In the shared coordinator for every read.**
    - Pros: protects every coordinated read.
    - Cons: wide-reaching; other reads may legitimately take long.

### 3. Confirm the stall on a real slow disk

**Problem.** The explanation fits the report but nothing has shown a hung `statfs` or a long-aged `system-usage-sample`.

**Context.** `get_recurring_work_diagnostics` reports per-kind active attempts and worst ages.

**Investigation.** Run on 2026-11-05 with the real reader and `fs.statfs` against a stalled FUSE mount (it answers INIT and nothing else). Raw `statfs` hung while Bun's event loop kept running, which the bound depends on. Each poll answered in about 1.5 s with CPU and RAM and `diskPercent: null`, three polls held one call, another path read normally during the stall, and the figure returned after the mount was released. This was a standalone script, not a backend whose data directory had stalled: its database would stall too.

Whether this is what happened on the affected node still needs that node. A bounded sample no longer shows a long-aged `system-usage-sample` attempt, so the signal to look for is now `[host] usage.source-stalled` in its backend log.

**Decisions.**

- **How to confirm?**
  - **Read the backend log from the affected node (recommended).**
    - Pros: no further code change; `usage.source-stalled` names the source and stays in the log after the fault ends.
    - Cons: needs a build with this fix on that node.
  - **Inject a never-resolving `diskPercent` in a test.**
    - Pros: repeatable; proves the fix.
    - Cons: shows the hang is possible, not that it is the cause here.

## Outstanding work

Task 3 only: read the log on the affected node.

## Needs verification

A running backend whose data directory has stalled, end to end. The reader was checked against a stalled mount on its own, and the popover's failure and recovery with requests held at the network.

## Assumptions and decisions

### Task 1: also bound the Linux GPU read

Chose to bound `readLinuxGpuPercent` as well as `statfs`, since a hung sysfs read stalls the same `Promise.all` and bringing only the disk under a timeout would leave the reported symptom reachable. The bound sits on the sysfs read rather than around all GPU probing: a Mac's `ioreg` samples and `nvidia-smi` have their own timeouts and can legitimately take longer than 1.5 s together.

### Task 1: keep one hung call per path

A hung filesystem call cannot be cancelled and holds a worker thread, so `createBoundedRead` keeps it in flight and later reads wait on it. Each poll on a stalled disk therefore takes up to 1.5 s, which is within the 5 s cadence. Answering at once while a call is known to be overdue would save that wait but add state for a rare case.

### Task 1: log the stall

Added `usage.source-stalled` to the `host` log area through `log.throttled`, because the bound removes the long-aged attempt that task 3 relied on as evidence. Recovery is logged only when the last stalled key settles: a live run showed a healthy path otherwise reporting recovery during a stall.

### Task 2: the timeout value

20 s, above the slowest answer the backend can legitimately give, which is a process list waiting on `docker exec` timeouts at four probes at a time. Too short a bound would discard real answers on every poll; too long only delays the message.

### Task 2: one outstanding request per key

After a timeout, the key fails at once until its request settles, and the late answer is dropped because it describes the past. A retry that ignored the open request would add one per retry, as described above. The cost: a request that never settles keeps that key failing until a reload or a server switch (each connection generation starts clean). A dead connection does eventually settle; the failure message is also what the user should see meanwhile.

## Related

- [0997-process-usage-popover-empty-on-command-node.md](0997-process-usage-popover-empty-on-command-node.md)
- [0741-backend-responsiveness-under-load.md](0741-backend-responsiveness-under-load.md)
