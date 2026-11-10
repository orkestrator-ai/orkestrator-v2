# Backend event-loop stalls grew over a long busy soak

## Task analysis

Analysed 2026-11-10 against `main` at `c98b20e6f`. Written from the 4960 busy
soak of that day ([Change tracking: busy live
soak](../../architecture/change-tracking.md#busy-live-soak-of-the-row-cap-2026-11-10)),
which measured the change-tracking row cap and saw this on the side.

### Tasks

1. **Find what makes the stalls grow over a long busy run**: reproduce the growth and attribute it. Status: open.
2. **Decide the fix once the cause is known**. Status: open (depends on 1).

### 1. Find what makes the stalls grow over a long busy run

**Problem.** On the 97-minute busy soak the backend's event-loop stall log
(`[event-loop] stalled`, [logging](../../architecture/logging.md)) reported
106 stalls with a p50 of 3.8 s and a maximum of 11.6 s. They grew over the
run rather than tracking the load: the longest stall was 1.3 s in the first
10 minutes, 2.4 to 4.1 s from 09:50 to 10:29, 5.4 s from 10:30, and 11.2 to
11.6 s in every 10-minute window from 10:40 to the end. A stall of that length
delays every command, poll and SSE frame the backend serves.

**Context.** The run: `scripts/recurring-live-ab.ts --busy-rounds 50
--busy-clients 0,1,2 --busy-environments 10 --busy-burst-files 2500
--busy-turn-files 2500` on a headless `dev:test` profile on beelink (16
cores), loopback fake model, 150 rounds and 443 turns. Each round wrote and
removed 2,500 files in each of 10 worktrees and wrote 2,500 more inside the
held turn. Backend RSS had a median of 429 MiB and a maximum of 751 MiB over
the busy window. The host's load average was 50 to 64 for most of the run,
partly from the run itself, and the stalls appear with
`commandsInFlight` of 0 to 7, so host load explains part of their length but
not their steady growth. `start_local_pi_server_cmd` was the most frequent
slow command (34 `command.slow` lines).

**Investigation.** Not attributed. Things that grew during the run and are
worth separating, none of them measured as a cause:

- The change-tracking ledger, from 41 MiB at 11 minutes to a 151 MiB peak
  (555,456 file rows), then 92 MiB after the hourly pass and 134 MiB at the
  end. Its stall did not fall after the pass shrank it, which argues against
  it.
- One Pi session in `busy-1` took two turns per round (about 295 turns), so its
  transcript grew for the whole run; native activity sweeps and live updates
  read it.
- Recursive worktree watches on Linux: every round created and removed a
  2,500-file directory in 11 worktrees
  ([7560](7560-large-ignored-trees-in-the-worktree-watch.md) is the related
  walk cost of a large tree).

A run that keeps the workload but turns one of these off (no held-turn files;
a fresh session every N rounds; smaller bursts), with the backend's CPU
profile captured around a long stall, would separate them.

**Decisions.**

- **How to attribute it?**
  - **A/B soaks of the same driver with one growth source removed, plus a CPU profile at a long stall (recommended).**
    - Pros: uses the existing busy driver and stall log; each arm names or clears one suspect.
    - Cons: each arm is a run of over an hour on a host whose load also varies.
  - **Instrument the suspects (transcript size, ledger query time, watch count) in `/metrics` first.**
    - Pros: one run then shows all of them over time.
    - Cons: new product surface before the cause is known.

### 2. Decide the fix once the cause is known

**Problem.** Depends on task 1.

**Context.** [0741](0741-backend-responsiveness-under-load.md) owns load
qualification with the stall log; this file is one observation for it.

**Investigation.** None yet.

**Decisions.**

- **Where should the fix live?**
  - **In the component task 1 attributes the growth to (recommended).**
    - Pros: fixes the cause rather than the symptom.
    - Cons: unknown until task 1 is done.
  - **A general yield or budget in the busiest recurring loops.**
    - Pros: bounds any single stall whatever its cause.
    - Cons: hides a growth that would come back elsewhere.

## Needs verification

- Whether the growth appears at a normal host load; the soak ran at a load
  average of 50 to 64.

## Related

- [0741](0741-backend-responsiveness-under-load.md)
- [7560](7560-large-ignored-trees-in-the-worktree-watch.md)
- [0048 recurring work qualification](../transcripts-and-observation/0048-recurring-work-qualification.md)
