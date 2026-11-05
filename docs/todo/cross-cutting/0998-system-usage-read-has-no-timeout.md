# System usage read has no timeout, so one stalled disk call hangs every meter

## Task analysis

Analysed 2026-11-05 against `main` at `1c2f12837`. Re-checked 2026-11-05 against
`main` at `41f9eb638`: none of the files changed, so every finding still held when
tasks 1 and 2 were acted on.

### Tasks

1. **Bound the disk reading**: a hung `fs.statfs` on the data directory stalls the whole system sample. Status: done (2026-11-05); see Assumptions and decisions.
2. **Give usage reads a client timeout**: a read that never returns is never reported as failed. Status: done (2026-11-05); see Assumptions and decisions.
3. **Confirm the stall on a real slow disk**: the cause is inferred from code, not observed. Status: open.

### 1. Bound the disk reading

**Problem.** If the disk holding the backend's data directory stalls, `get_system_usage` never answers. CPU, RAM and GPU are missing as well as disk, and every later request joins the same hung read, so it does not recover.

**Context.** `createSystemUsageReader` in `apps/backend/src/core/system-usage.ts` waits on RAM, GPU and disk together with `Promise.all` (`:519-525`). The disk figure is `readDiskPercent` (`:137-148`), which calls `fs.statfs` with no timeout; its `catch` handles errors only. In-flight reads are shared through `pendingReads` (`:509-515`), so a hung promise is never replaced. `get_environment_process_usage` joins its own in-flight read the same way (`pendingProcessRead` in `commands-registry-system.ts`) and first calls `storage.loadEnvironments()`.

**Investigation.** Not reproduced. The subprocess probes already carry timeouts (`runCommand` with `timeoutMs: 1_500` for `vm_stat`, `ioreg` and `nvidia-smi`). `statfs` is not the only awaited source without one, as first written here: the Linux GPU read (`readLinuxGpuPercent`) reads sysfs with no timeout, and `pendingGpu` shares it. The tiles are CPU, RAM, GPU and disk, all four empty in the report, which a hung `Promise.all` explains and a disk-only failure would not.

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

**Investigation.** Not run live. The panel-side half (showing the failure) is task 2 of [0997](0997-process-usage-popover-empty-on-command-node.md).

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

**Investigation.** Needs the affected command node while the popover is empty: whether `statfs` on its data directory hangs when run from the same machine, and the signs below. Task 1 changed what to look for: a stalled probe no longer holds the `system-usage-sample` attempt open, so that attempt will not show a large age. A stall now writes `[host] usage.probe-stalled` with `scope=disk` (or `gpu`) and `kind=timeout`, repeats counted once a minute, then `throttle.recovered` when the probe answers. The meters show disk as "—" while CPU and RAM keep updating.

**Decisions.**

- **How to confirm?**
  - **Read the log and run `statfs` on the affected node (recommended).**
    - Pros: no code change; `usage.probe-stalled` names the probe if the cause is right.
    - Cons: only works while the fault is present.
  - **Inject a never-resolving `diskPercent` in a test.**
    - Pros: repeatable; proves the fix. Done under task 1.
    - Cons: shows the hang is possible, not that it is the cause here.

## Assumptions and decisions

### Task 1: where the deadline sits

`createSystemUsageReader` races each disk read against `DISK_READ_TIMEOUT_MS` (1.5 s, as recommended) and reports `diskPercent: null`. One `statfs` per path stays in flight until it answers and later polls join it, so a long stall costs one pool thread. The deadline is fixed when the probe starts, so a poll that joins a probe already past it answers at once instead of waiting another 1.5 s. The shared read resolves with the other figures, and the first poll after the disk answers probes afresh, which is how the figure recovers. A late answer is dropped.

### Task 1: the GPU read has the same bound

The re-check found the Linux GPU read has the same fault, so `sampleGpu` got the same deadline: `GPU_READ_TIMEOUT_MS` (6 s), `gpuPercent: null`. The figure is above the slowest healthy probe, because a Mac with failing probes can legitimately take about 4.9 s (two `ioreg` runs and `nvidia-smi`). A GPU hang would otherwise have wedged the shared read exactly as `statfs` did. RAM needs no bound: it is synchronous, or a `vm_stat` under its own timeout.

### Task 1: a stall is logged

The deadline removes the sign task 3 planned to read, so `usage.probe-stalled` replaces it. It is throttled and carries no path.

### Task 1: the process usage read gets no deadline of its own

- **State why it cannot hang (chosen).**
  - Pros: no timer that could fire on a read that was only slow; matches what the code does.
  - Cons: relies on the two facts below staying true; `environment-process-usage.test.ts` pins them.
- **Race the shared read against a deadline.**
  - Pros: protects against a future unbounded await.
  - Cons: guards nothing today. If it clears the shared read, polls pile up behind a real hang; if it keeps the read, it never recovers from one. It cannot fire in the case that matters, below.

Nothing `get_environment_process_usage` awaits can stay pending. `storage.loadEnvironments()` reads `environments`, a database store, through synchronous `bun:sqlite` (`loadJsonCached` to `loadStore`), so its promise is already settled when returned. Every probe is a `runCommand` with a 2 s timeout, which settles even when a child ignores its signals (`shell.test.ts`, "settles and escalates when a descendant ignores SIGTERM"), and `mapWithConcurrency` walks a finite list: at most about 2.1 s for `ps` plus 2.1 s per four containers. `get_system_usage` does not touch the database.

A stalled disk can still stop this read another way: a synchronous SQLite read that blocks holds the backend's event loop, so nothing in the backend answers and no backend timer can fire. Only the client timeout in task 2 covers that. See [0741](0741-backend-responsiveness-under-load.md).

### Task 2: the bound, and what counts as failed

`useUsageRead` rejects a read after `USAGE_READ_TIMEOUT_MS` (10 s), on the coordinator's clock, as recommended. The figure equals `SYSTEM_USAGE_STALE_AFTER_MS`: a sample's age is measured from the start of its read, so a read that takes longer delivers a sample already presented as stale. It is above the backend's own 6 s bound on a usage sample. A process read can take longer with more than about 16 unresponsive containers; the panel then reports a failure until a read finishes in time.

`failed` also had to change, or the panel would still have misreported two states. It read only `status === "error"`, but the coordinator moves to `loading` for each retry, so the panel would have flipped back to "Loading processes…" for the whole of a hung retry. And an unknown command gets `unsupported`, which is never retried, so a backend without the command would have loaded for ever. `failed` now holds from the first failure until a read succeeds, and covers `unsupported`.

## Current state

Done: a stalled disk or GPU read leaves the other figures reporting and recovers by itself, and a usage read that never returns reaches the `error` state and retries on the next poll. Tests use never-resolving reads (`system-usage.test.ts`, `useSystemUsage.test.tsx`). The popover was checked in a browser on an isolated profile with the read held open: failure message after about 10.2 s, recovery by itself once reads answered.

## Outstanding work

Task 3 only. It can be skipped if the reported symptom does not recur.

## Needs verification

The fix against a really unresponsive data directory (for example a stalled mount), checking that CPU and RAM still arrive and the popover recovers when the disk returns. Tests and the browser check simulated the stall; no real disk was stalled.

## Related

- [0997-process-usage-popover-empty-on-command-node.md](0997-process-usage-popover-empty-on-command-node.md)
- [0741-backend-responsiveness-under-load.md](0741-backend-responsiveness-under-load.md)
