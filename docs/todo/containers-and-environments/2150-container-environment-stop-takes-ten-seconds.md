# Stopping a container environment takes about 10 seconds

## Task analysis

Analysed 2026-11-01 against `main` at `93b99bfb`. Re-checked and acted on
2026-11-02 against `main` at `38d55ee1`: the stop path, the drain and the
image's PID 1 chain were unchanged since the first analysis. Task 3 done
2026-11-11 against `main` at `498b6876`, by to-do 0022's second probe run.

### Tasks

1. **Attribute the 10 seconds**: find which step of `stop_environment` waits. Status: done (2026-11-02). It was the drain waiting its whole 10 s grace for an interactive shell that ignores SIGTERM. PID 1 and Docker's stop grace are not involved.
2. **Fix it, or record why it must wait**: then make the benchmark measure what a user waits for. Status: done in code (2026-11-02). The drain hangs up interactive shells instead of waiting for them, and the benchmark times `stopEnvironmentOnce`. Users get it when their image is rebuilt from a release that carries it.
3. **Confirm in the real stack**: re-run 0022's multi-environment UI probe on an image built from this change. Status: done (2026-11-11). Stops from the page took 1.3–2.4 s, against 10.5–11.6 s before.
4. **Full live suites on a full image**: the live lifecycle suite (C09, C11, C12, C20) and the benchmark's `stop_environment` case on a full image that carries the drain change. Status: open.

### 1. Attribute the 10 seconds

**Problem.** To-do 0022's (retired 2026-11-11)
multi-environment UI probe stopped and started an idle fixture container
environment 9 times on 2026-11-01. Each `stop_environment` took 10.5–11.6 s,
with or without load in other containers. The benchmark's warm stop measured
0.10–0.59 s (0022, 0729). A stop of about 10 s looked like Docker's default
stop grace (`docker stop` sends SIGTERM, waits 10 s, then sends SIGKILL),
which would mean something in the runtime ignores SIGTERM.

**Context.** `stopEnvironmentOnce`
(`apps/backend/src/core/commands-environment.ts`) proves ownership, stops
review validation and goal-check workers, then runs a `stop` container
operation. On an image with the `graceful-shutdown` capability, that
operation persists `draining`, runs `/usr/local/bin/orkestrator-drain.sh`
through `docker exec`, persists `stopping`, then calls
`stopRuntimeContainer` (`apps/backend/src/core/egress-gateway.ts`). That runs
`docker stop` on the runtime with no `-t`, then on its egress gateway, and
finally inspects the exit code to record `forced`. The runtime's PID 1 chain
is `docker-init` → `sudo` → `sleep infinity`. The entrypoints `exec` their
way down to the keepalive, and `sudo` relays SIGTERM to it. A fixture
environment has a setup terminal: `docker exec -it <runtime> zsh -lc
'<setup>; zsh -l'`, so an interactive login zsh stays open. Terminal tabs
open `bash -lc '… exec zsh -l'`.

**Investigation.** Done on beelink (16 CPUs, Docker Engine 29.9.2, load
average 7–20), on containers created for the purpose from the released
`2.34.4-beta` image, with `--init` and full network mode:

- `docker stop` took 0.12–0.47 s in every case and the container always
  exited 143, so PID 1's chain honours SIGTERM. `docker stop -t 0` took
  0.20–0.72 s and also exited 143, so a shorter timeout would save nothing.
- The drain took 63–220 ms with nothing open. With a login zsh open (setup
  terminal) or `bash -lc '… exec zsh -l'` (terminal tab) it took
  9.3–10.1 s, reporting `signalled=1 remaining=1`.
- `/proc/<pid>/status` of interactive zsh and bash shows SIGTERM in
  `SigIgn` (mask `0x4000`) and SIGHUP caught. SIGHUP ended both at once.
- The benchmark's new `stop_environment` case ran `stopEnvironmentOnce`
  against a restricted runtime with its egress gateway, with a login shell
  open (n=5). It took 10.42 s median (10.31–10.83 s). The drain's
  `docker exec` took 9.50 s of that, the runtime's `docker stop` 116 ms, the
  gateway's 585 ms, the goal-check exec about 117 ms, and everything outside
  the operation 116 ms. Idle (n=3) took 531 ms.

The benchmark's own warm stop missed it because it opens no terminal, so the
drain had nothing to wait for.

**Decisions.**

- **How to attribute it?**
  - **Time each step of `stopEnvironmentOnce` and compare `docker stop -t 0` with `docker stop` on owned containers (recommended, taken).**
    - Pros: tells Docker's grace apart from backend waits in one pass.
    - Cons: needs containers created for the purpose and a benchmark run.
  - **Read the code only.**
    - Pros: cheap.
    - Cons: the PID 1 chain's signal handling depends on the image at runtime; reading alone kept the wrong hypothesis.

### 2. Fix it, or record why it must wait

**Problem.** Every stop with a terminal open waited the full drain grace, and
it was recorded as `forced` because the shell was still there after the
drain. Rebuilds and the stop half of other lifecycle operations drain the
same way.

**Context.** The drain exists so that processes started by `docker exec`
(bridges, terminals, dev servers) get a chance to flush before the container
goes. An interactive shell has nothing to flush on SIGTERM and never acts on
it. A closed terminal sends SIGHUP, which a shell handles by exiting and
hanging up its jobs. The benchmark target "Warm stop ≤ 1 s"
([container-qualification.md](../../development/container-qualification.md#benchmarks))
did not see this.

**Investigation.** With the changed drain copied into a local image built
`FROM` `2.34.4-beta`:

- Bare drain with a login shell open: 92–195 ms (`signalled=1 remaining=0
  hungup=1`).
- A process that takes 2 s to exit on SIGTERM next to a login shell: 2.37 s.
  The process got its time and the shell was hung up afterwards.
- A script ignoring SIGTERM without a terminal, and one on a terminal that
  ignores SIGHUP as well: 150–170 ms, reported as remaining.
- `stop_environment` (benchmark, n=5) with a login shell open: 645 ms median
  (578–926 ms). The drain exec took 119 ms. Idle (n=3) took 636 ms. The
  gateway's `docker stop` (about 0.35–0.6 s) is now the largest step.

**Decisions.**

- **What to change?**
  - **Make PID 1's chain exit on SIGTERM (`exec` the shell, or trap and forward) (the recommendation before task 1).**
    - Pros: would fix a PID 1 that ignored SIGTERM.
    - Cons: PID 1 already exits on SIGTERM, so it would change nothing; `CMD` and the entrypoint chain stay as they are.
  - **Pass a short `-t` to `docker stop`.**
    - Pros: one line.
    - Cons: `docker stop` is not where the time goes. It would kill processes that would have exited cleanly.
  - **Shorten the drain grace.**
    - Pros: one line in the backend; works on existing images.
    - Cons: cuts the time real work (an agent flushing a transcript) gets, and still waits that time for every open shell.
  - **Drain waits only for processes that can act on SIGTERM and hangs up interactive shells (recommended, taken).**
    - Pros: a stop with terminals open takes as long as the real work needs; a process that handles SIGTERM still gets the whole grace; the shell exits the way a closed terminal makes it, so `forced` is no longer recorded for every stop with a terminal.
    - Cons: an image change, so only rebuilt runtimes get it; SIGHUP goes to a process that may treat it differently from a closed terminal.
- **Benchmark?**
  - **Time `stop_environment` through the backend as well (recommended, taken).**
    - Pros: measures what users wait for, with a terminal open as in a real environment.
    - Cons: one more benchmark case and target.
  - **Open a terminal in the existing warm stop loop.**
    - Pros: no new case.
    - Cons: still a bare `docker stop`, without the gateway or the backend's steps.

### 3. Confirm in the real stack

**Problem.** The fix is measured on bare containers and through
`stopEnvironmentOnce` in the benchmark, not through the gateway and the page
the way 0022 measured 10.5–11.6 s.

**Context.** `e2e/perf/multi-environment-ui-perf.ts` against a `dev:test`
profile started with `--fixture-environments container`. That builds the
workspace image from `docker/Dockerfile`.

**Investigation.** Not done on 2026-11-02: building the full workspace
image on a host shared by about ten builds was out of proportion once the
benchmark had measured the backend path.

Done 2026-11-11 on beelink, as part of to-do 0022 task 3: the probe ran with
default options against a profile on `orkestrator-v2:dev-3f9489ce4342`,
built from `main` at `498b6876`, which carries the drain change.
`stop_environment` sent from the page took a median of 1.43 s idle, 1.93 s
with three busy containers and 1.42 s idle again (1.29–2.38 s over all nine
stops), with the sidebar showing the result 64–72 ms after each reply. On
2026-11-01 every stop took 10.5–11.6 s. The host was saturated by other
builds (load average 36–58), so these are a busy-host sample. The full table
is in [container-qualification.md](../../development/container-qualification.md#ui-response-under-multi-environment-load-second-busy-host-run-2026-11-11).

**Decisions.**

- **How to confirm?**
  - **Re-run the 0022 probe once on an image from this branch and compare its stop times with 2026-11-01 (recommended).**
    - Pros: the same measurement as the report, through the page.
    - Cons: needs a full image build and a container profile.
  - **Accept the benchmark figures.**
    - Pros: no further run.
    - Cons: does not show what the page waits for.

### 4. Full live suites on a full image

**Problem.** Only C11 and the `stop_environment` case were run on 2026-11-02,
on an image that differed from the released one only in the drain script.
The rest of the live lifecycle suite was never run against the change.

**Context.** The commands are in
[container-qualification.md](../../development/container-qualification.md#suites)
(live lifecycle, benchmarks). Run them on beelink with Docker through
`apps/desktop/scripts/dev/docker-qualification-bin` and an image from
`mise run docker:build:dev`.

**Investigation.** Moved here unchanged from Outstanding work on 2026-11-11.
That day to-do 0022 ran the benchmark's baseline case and the UI probe on a
full image built from `main` at `498b6876`, so the stop path through the
page is confirmed (task 3); C09, C11, C12, C20 and the `stop_environment`
case were not run on it.

**Decisions.**

- **Which runs close it?**
  - **The live lifecycle suite plus `-t stop_environment`, once, on one full image (recommended).**
    - Pros: covers every case the drain change can affect, with the target the change set.
    - Cons: needs an image build and about a quarter of an hour of Docker time on a shared host.
  - **Rely on the weekly Linux Engine CI workflow.**
    - Pros: no local run.
    - Cons: CI uploads the benchmark report but nobody compares it with the `stop_environment` target unless asked.

## Assumptions and decisions

### Task 1: PID 1 was not the cause

Chose to measure before changing anything, as the file recommended. The
ticket allowed for that outcome ("if the timing confirms it"). PID 1 exits on
SIGTERM, so `docker/Dockerfile` (`CMD`, `ENTRYPOINT`) is unchanged, which
also keeps clear of to-do 1202 task 14's concurrent Dockerfile change.

### Task 2: SIGHUP only to processes with a terminal

The drain waits for every process that does not ignore SIGTERM, as before.
After that it sends SIGHUP to a process that ignores SIGTERM only when it
has a controlling terminal and does not ignore SIGHUP, then waits for those
within the same grace. I chose the terminal condition because a process on a
terminal that ignores SIGTERM is in practice an interactive shell, and
SIGHUP is exactly what it receives when its terminal closes. A daemon
without a terminal may treat SIGHUP as "reload", so it is not sent one. It
is not waited for either, because it has declared it will not act on
SIGTERM. It counts as remaining, so the stop is still recorded as `forced`
for it.

### Task 2: hang up after the SIGTERM wait, not with it

Shells are hung up only once every process that can act on SIGTERM has
gone. A zsh that gets SIGHUP passes it to its jobs, which would cut short a
job still flushing on SIGTERM.

### Task 2: report shape

The drain's line gains `hungup=<n>` at the end. The backend's parser
(`drainContainerProcesses`) is unchanged and ignores the field, so no
persisted detail or protocol type changes. The capability stays
`graceful-shutdown=1` because the backend needs nothing new from the image.
An older image keeps the old drain and its 10 s until the runtime is rebuilt.

### Task 2: benchmark case and target

The benchmark gained a separate `stop_environment` test (`-t
stop_environment`) on its own restricted runtime: 3 idle stops and 5 with a
login shell open. It reports the operation's phases, each Docker call's
duration and the time outside the operation. The report is now written from
`afterAll`, so either test alone produces one. I set the target at 1.5 s,
not the warm stop's 1 s, because this path also stops the egress gateway
(about 0.35–0.6 s on beelink).

### Task 1: review fixes for EOF readers and suspended jobs

The drain now sends SIGCONT after successfully sending SIGTERM so stopped
jobs can run their handlers. After terminal hangup it waits for pipe readers
within the original deadline, preserving EOF-driven log writers' final output.
Waiting after hangup avoids holding an interactive producer's output pipe open.
Non-reader processes ignoring TERM/HUP still count as remaining without a wait.
Owned-process Linux regressions exercise these branches with real PTYs and the
image log-writer script. C11 also covers a suspended producer's final partial
line through the image writer and a terminal ignoring both TERM and HUP.

### Task 2: report failures must not skip cleanup

Reporting and resource cleanup now run through a teardown helper that always
attempts cleanup and retains both errors if both fail. A regression injects a
report error, checks owner-filtered Docker removals, and verifies the temporary
directory was removed.

## Current state

- `docker/orkestrator-drain.sh` hangs up interactive shells and waits only
  for processes that can act on SIGTERM and, after hangup, EOF-driven pipe
  readers. Stopped workloads receive SIGCONT to handle their pending TERM.
- `apps/backend/tests/container-benchmarks.test.ts` has the
  `stop_environment` case. Its target is in container-qualification.md.
- `apps/backend/tests/container-live-qualification.test.ts` C11 opens a
  login shell and requires the drain to finish well inside its grace. It
  fails on the released image and passes on the changed drain.
- Figures are in
  [container-qualification.md](../../development/container-qualification.md#stop-attribution-the-drain-waited-on-interactive-shells-2026-11-02).

## Outstanding work

- Task 4: the full live lifecycle suite (C09, C11, C12, C20) and the
  `stop_environment` case on a full image.

## Constraints and rationale

- Do not shorten the drain grace or `docker stop`'s timeout to hide waits:
  both cut short work that does flush on SIGTERM.
- The drain never escalates to SIGKILL; `docker stop` does, and the backend
  records it as `forced`.

## Related

- To-do 0022 (retired 2026-11-11): the UI probe that measured the 10 s stops and confirmed the fix; its runs are in [container-qualification.md](../../development/container-qualification.md#ui-response-under-multi-environment-load)
- [0729-container-benchmark-target-misses.md](0729-container-benchmark-target-misses.md): the benchmark's earlier warm stop figures
- [container-lifecycle.md](../../architecture/container-lifecycle.md#stop-and-drain): the stop and drain contract
