# A rebuild copy step can hang for an hour on rootless Docker when its helper's input never ends

## Task analysis

Analysed 2026-11-11 against `main` at `498b68766`, on beelink, while doing
to-do 0019 task 5 (retired 2026-11-11; see
[Docker daemon restart during launch and rebuild copy](../../development/container-qualification.md#docker-daemon-restart-during-launch-and-rebuild-copy-task-5)).
Tasks 1 and 2 acted on 2026-11-13 against `main` at `17d28238c`, on beelink2
([evidence](../../development/container-qualification.md#docker-cp-busy-probe-copy-stream-stall-and-port-collision-runs-on-beelink2-2026-11-13)).

### Tasks

1. **Find why the helper never saw end of input**: reproduce the stall and say whether it is the daemon, the CLI or the backend's pipe. Status: blocked (waits on a recurrence: a `replacement.copy-helper-stalled` log line). The stall's shape is reproduced on demand (a helper that never finishes reading after its producer exits, in a unit test and live); the natural stall did not recur in 75 runs on 2026-11-13, so its cause is still open.
2. **Bound a stalled copy step well below an hour**: a step whose producer has exited should not wait out `COPY_TIMEOUT_MS`. Status: done 2026-11-13 (a drain window of 2 minutes plus 1 s per 16 MiB sent plus the streaming time, then the step fails as `helper-input-stalled` and the helper is removed).

### 1. Find why the helper never saw end of input

**Problem.** A legacy-to-volume migration on `docker:disposable`'s rootless
daemon hung in one copy step. The step pipes `docker cp <source>:<path> -`
into `docker run --rm -i … copy-stream <target> 1`
(`pipeContainerPath` in `apps/backend/src/core/container-replacement.ts`).
The `docker cp` producer had exited, but inside the helper `tee` was still
blocked reading the container's stdin 14 minutes later, so the step would
only have ended at `COPY_TIMEOUT_MS` (60 minutes) as a failure.

**Context.** Observed once, in the setup of the C15 daemon-restart scenario
(`container-live-rebuild-faults.test.ts`, "C15 Docker daemon restart during
the rebuild copy"), before that scenario's restart: the step was
`copy-stream /storage/state/pi/bridge-state 1`, whose target was still empty.
The helper started at 02:32:51 UTC, 46 s after the launch-restart scenario
had restarted the same rootless daemon twice (RootlessKit, slirp4netns,
Docker 29.9.2, `live-restore` off); the daemon log around those restarts has
`failed to restore thread's network namespace: operation not permitted`
warnings. The helper's container had `OpenStdin`, `StdinOnce` and
`AttachStdin` all true. No `docker cp` process remained on the host; the
host-side `docker run -i` client was still running.

**Investigation.**
- The same scenario rerun on the same daemon 15 minutes later passed: the
  migration's copy steps all finished.
- Seven `docker run --rm -i` probes on that daemon whose input ended at once
  or after 2 s all received end of input and exited.
- So the stall is intermittent; whether it needs a daemon fresh from a
  restart, an empty or missing source path, or a producer that exits before
  the helper's attach completes is not known.
- On the nested rootful daemons the same day (the restart scenario four
  times, with and without `live-restore`, and the whole rebuild-fault file
  once) every migration finished.
- 2026-11-13, on beelink2's disposable rootless daemon (Engine 29.9.2,
  slirp4netns, containerd store), the minimal loop below ran 75 times: `docker
  cp` from a stopped container of a missing path (the producer fails before
  the helper attaches), an empty directory and a one-file directory into
  `docker run --rm -i --network none busybox sh -c 'cat >/dev/null; echo
  ok'`, 30 on a settled daemon and 45 right after two daemon restarts per
  cycle. Every helper saw end of input. The natural stall is therefore rare
  enough that a reproduction loop cannot be the way to its cause.
- What the 2026-11-11 state does say: the producer had exited and no `docker
  cp` remained, while the host-side `docker run -i` client was still running
  and the helper's `tee` was blocked on the container's stdin. The backend's
  pipe ends the client's stdin when the producer's output ends (and, since
  2026-11-13, explicitly when the producer closes), so the lost end of input
  lies between the CLI and the container: the CLI not half-closing the
  attach connection, or the daemon not closing the container's stdin.
  Telling those two apart needs a stalled helper to look at; the bound now
  logs `replacement.copy-helper-stalled` (producer exit code, bytes sent,
  window) when it fires.
- The stall's shape is reproduced on demand: `container-replacement.test.ts`
  ("a helper that never sees end of input after its producer exits is
  abandoned in the drain window") with a fake helper, and live on the same
  daemon with a real `docker cp` producer and a real `docker run --rm -i`
  helper that never finishes reading: settled as `stalled` 3.2 s after the
  producer closed (3 s window), helper container removed.

Next, on a recurrence: before the drain window ends, read the host `docker
run` client's stdin state (`ls -l /proc/<pid>/fd/0`, `ss -xp` for its
socket to the daemon) and the helper's stdin inside the container, and
compare with the daemon's debug log for that attach.

**Decisions.**

- **How to reproduce it?**
  - **Loop the legacy migration (`createLegacyEnvironment` then a rebuild) on a rootless `docker:disposable` daemon, restarting the daemon between iterations, and record each `copy-stream` step's producer exit code and timing (recommended).**
    - Pros: the observed conditions; disposable, so restarts are safe.
    - Cons: each iteration takes about a minute; a rare stall needs many.
  - **A minimal loop of `docker cp <missing path> - | docker run -i … cat` on the same daemon.**
    - Pros: fast; isolates the CLI and daemon from the backend.
    - Cons: may miss whatever in the migration set it off.

### 2. Bound a stalled copy step well below an hour

**Problem.** Whatever the cause, a step whose producer has finished and whose
helper is still waiting holds the rebuild, and the environment, for up to an
hour before failing.

**Context.** `pipeContainerPath` already discards the producer's output once
the consumer stops reading, and settles on the overall deadline
(`COPY_TIMEOUT_MS`, 60 minutes) plus `PIPE_SETTLE_GRACE_MS` (5 s). It has no
bound on the time between the producer closing and the consumer finishing.

**Investigation.** Built on 2026-11-13 without waiting for task 1's cause:
whatever the cause, a helper still running minutes after its producer
closed holds the rebuild. The drain window covers the helper's own final
checks (it waits up to 60 s for its listings) with a base of two minutes,
plus one second per 16 MiB the producer sent for extraction still in
flight: 2.5 minutes for 512 MiB, about 7.5 for 5 GiB.

**Decisions.**

- **What bound?**
  - **After the producer closes, give the consumer a bounded drain window (a few minutes, scaled to the bytes sent), then kill it and fail the step as `source-read-failed` (recommended, once task 1 shows the helper is not still working).**
    - Pros: a hang costs minutes, not an hour; the original stays authoritative as on any failed copy.
    - Cons: a genuinely slow extract of a large archive needs a window that does not cut it short.
  - **Keep the one-hour deadline.**
    - Pros: no change.
    - Cons: an environment is held for an hour by a step that will never finish.

## Assumptions and decisions

### A drain window after the producer closes, then abandon the step (task 2)

Chose: once the `docker cp` producer closes, `pipeContainerPath` ends the
helper client's stdin and starts `copyDrainWindowMs(bytes, streamedMs)` (2 minutes plus 1 s
per 16 MiB sent, plus the streaming time added in review round 2; see
below). A helper still running then is killed, its container is
removed by name (`orkestrator-copy-<id>`, since killing `docker run` leaves
the container running), `replacement.copy-helper-stalled` is logged, and the
step fails as `helper-input-stalled`, so the rebuild rolls back with the
original kept, as on any failed copy. Why: the recommended option, built
before task 1's cause because the bound does not depend on it; a stalled
step now costs minutes instead of an hour. Alternative: keep the one-hour
deadline, which holds the environment for the whole hour.

### The window also gets the streaming time, checked against the real helper (task 2)

Chose: `copyDrainWindowMs(bytes, streamedMs)` adds the time from spawning
the producer to its close, and `tests/unit/migrate-copy-drain-window.test.ts`
(slow tier) measures the real `copy-stream` helper's time after its input
ends against the default window. Why: review round 2 found the bytes-only
window unchecked against the helper's post-input verification on a large
workspace or a loaded host. Measured on beelink2 (container qualification,
"7705 drain window against the real helper"): 0.63 s after input against a
138 s window, 0.83 s on one CPU. The per-member work happens while the
stream flows, so the post-input time stays a small fraction of the streaming
time, and adding that time keeps a slow legitimate copy inside the window on
a host that slows both. Cost: a stall after a long stream waits that much
longer, still bounded by `COPY_TIMEOUT_MS`. Alternative: a per-file term,
which needs the member count the producer's byte stream does not carry.

### A reason of its own, not `source-read-failed` (task 2)

Chose: `helper-input-stalled`. Why: the producer succeeded, so calling it a
source read failure would point a reader at the wrong side; the reason is
shown in the "failed verification" message.

### Task 1 waits on a recurrence (task 1)

Chose: `blocked` with the stall reproduced by injection rather than a longer
natural loop. Why: 75 natural runs, including right after daemon restarts,
did not stall, and repeating them takes host time other builds share. The
new log line marks a recurrence, which is what task 1 now needs.

## Related

- [Container qualification](../../development/container-qualification.md#docker-daemon-restart-during-launch-and-rebuild-copy-task-5) (the run that found it).
- [7549-rootless-docker-cp-refusals.md](7549-rootless-docker-cp-refusals.md) (another rootless `docker cp` behaviour).
- [Container lifecycle](../../architecture/container-lifecycle.md) (the drain window, under the preserving rebuild's copy).
- [7390-rootless-restart-remaining-settings.md](7390-rootless-restart-remaining-settings.md) (rootless daemon restarts).
