# System usage read has no timeout, so one stalled disk call hangs every meter

## Task analysis

Analysed 2026-11-05 against `main` at `1c2f12837`.

### Tasks

1. **Bound the disk reading**: a hung `fs.statfs` on the data directory stalls the whole system sample. Status: open.
2. **Give usage reads a client timeout**: a read that never returns is never reported as failed. Status: open (depends on 1 only for the backend half; independent in the renderer).
3. **Confirm the stall on a real slow disk**: the cause is inferred from code, not observed. Status: open.

### 1. Bound the disk reading

**Problem.** If the disk holding the backend's data directory stalls, `get_system_usage` never answers. CPU, RAM and GPU are missing as well as disk, and every later request joins the same hung read, so it does not recover.

**Context.** `createSystemUsageReader` in `apps/backend/src/core/system-usage.ts` waits on RAM, GPU and disk together with `Promise.all` (`:519-525`). The disk figure is `readDiskPercent` (`:137-148`), which calls `fs.statfs` with no timeout; its `catch` handles errors only. In-flight reads are shared through `pendingReads` (`:509-515`), so a hung promise is never replaced. `get_environment_process_usage` joins its own in-flight read the same way (`pendingProcessRead` in `commands-registry-system.ts`) and first calls `storage.loadEnvironments()`.

**Investigation.** Not reproduced. The other sampled sources already carry timeouts (`runCommand` with `timeoutMs: 1_500` for `vm_stat` and the GPU probes); `statfs` is the only awaited source that does not. The tiles are CPU, RAM, GPU and disk, all four empty in the report, which a hung `Promise.all` explains and a disk-only failure would not.

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

**Investigation.** Needs the affected command node while the popover is empty: its diagnostics output, and whether `statfs` on its data directory hangs when run from the same machine.

**Decisions.**

- **How to confirm?**
  - **Read the diagnostics from the affected node (recommended).**
    - Pros: no code change; shows an active `system-usage-sample` attempt with a large age if the cause is right.
    - Cons: only works while the fault is present.
  - **Inject a never-resolving `diskPercent` in a test.**
    - Pros: repeatable; proves the fix.
    - Cons: shows the hang is possible, not that it is the cause here.

## Outstanding work

All three tasks are open. Task 1 and task 2 are independent; task 3 can be skipped if task 1's test already reproduces the hang.

## Needs verification

The fix against an unresponsive data directory (for example a stalled mount), checking that CPU and RAM still arrive and the popover recovers when the disk returns.

## Related

- [0997-process-usage-popover-empty-on-command-node.md](0997-process-usage-popover-empty-on-command-node.md)
- [0741-backend-responsiveness-under-load.md](0741-backend-responsiveness-under-load.md)
