# A rebuild copy step can hang for an hour on rootless Docker when its helper's input never ends

## Task analysis

Analysed 2026-11-11 against `main` at `498b68766`, on beelink, while doing
to-do 0019 task 5 (retired 2026-11-11; see
[Docker daemon restart during launch and rebuild copy](../../development/container-qualification.md#docker-daemon-restart-during-launch-and-rebuild-copy-task-5)).

### Tasks

1. **Find why the helper never saw end of input**: reproduce the stall and say whether it is the daemon, the CLI or the backend's pipe. Status: open.
2. **Bound a stalled copy step well below an hour**: a step whose producer has exited should not wait out `COPY_TIMEOUT_MS`. Status: open (depends on 1).

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

**Investigation.** Not started; it depends on task 1's cause.

**Decisions.**

- **What bound?**
  - **After the producer closes, give the consumer a bounded drain window (a few minutes, scaled to the bytes sent), then kill it and fail the step as `source-read-failed` (recommended, once task 1 shows the helper is not still working).**
    - Pros: a hang costs minutes, not an hour; the original stays authoritative as on any failed copy.
    - Cons: a genuinely slow extract of a large archive needs a window that does not cut it short.
  - **Keep the one-hour deadline.**
    - Pros: no change.
    - Cons: an environment is held for an hour by a step that will never finish.

## Related

- [Container qualification](../../development/container-qualification.md#docker-daemon-restart-during-launch-and-rebuild-copy-task-5) (the run that found it).
- [7549-rootless-docker-cp-refusals.md](7549-rootless-docker-cp-refusals.md) (another rootless `docker cp` behaviour).
- [7390-rootless-restart-remaining-settings.md](7390-rootless-restart-remaining-settings.md) (rootless daemon restarts).
