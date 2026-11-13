# Rootless Docker refuses `docker cp` that environment creation and readiness rely on, and port collisions outlast one retry

## Task analysis

Analysed 2026-11-09 against `main` at `c6de4733c`; tasks 1 and 3 acted on
2026-11-10 against `main` at `04639b12b`
([evidence](../../development/container-qualification.md#rootless-host-loopback-and-docker-cp-refusals-on-beelink-2026-11-10));
tasks 1 and 2 re-checked and task 4 found on 2026-11-11 against `main` at
`498b68766`
([evidence](../../development/container-qualification.md#rootless-daemon-restart-with-live-restore-and-on-gvisor-tap-vsock-and-the-7549-re-checks-2026-11-11));
task 4 acted on the same day
([evidence](../../development/container-qualification.md#backend-chosen-host-ports-on-rootless-docker-2026-11-11));
task 2 acted on 2026-11-13 against `main` at `17d28238c`, on beelink2
([evidence](../../development/container-qualification.md#docker-cp-busy-probe-copy-stream-stall-and-port-collision-runs-on-beelink2-2026-11-13)).
Found by the retired to-do 0109's task 5, the rootless re-run on a
freshly built image
([evidence](../../development/container-qualification.md#rootless-re-run-on-a-freshly-built-image-2026-11-09)).

### Tasks

1. **`docker cp` refused when a read-only bind's source is `nosuid`/`nodev`**: classify the refusal and decide whether to avoid it. Status: done (2026-11-10, the classification; still passing on 2026-11-11); the upstream report to Moby moved to the [manual-test checklist](../manual-test/7568-manual-test-checklist.md).
2. **`docker cp` into a container that is not running fails with `device or resource busy`**: establish where it happens, then stop project seed files, configured project files and the GitHub ranges seed depending on it there. Status: blocked (waits on a recurrence: a `copy-in.snapshot-busy` log line, or the busy refusal on any host). Done 2026-11-13: the probe on beelink2 (kernel 7.2.15) did not reproduce on either image store, and the three copies now retry a busy refusal twice and then fail with a typed error naming it. The bind delivery below waits for a host that fails again.
3. **An automatic port can collide twice in a row**: decide whether the start path's single retry should become a bounded few. Status: done 2026-11-10 (three retries; raised to ten on 2026-11-13 by 7750 (retired)).
4. **Automatic ports still collide past three retries right after a rootless daemon restart**: decide how the start path should stop drawing ports that loopback churn holds. Status: done 2026-11-11 (on a rootless daemon the backend chooses automatic host ports itself; qualified on a disposable rootless daemon).

### 1. `docker cp` refused when a read-only bind's source is `nosuid`/`nodev`

**Problem.** On a rootless daemon, once a container has a read-only bind
mount whose source sits on a filesystem mounted `nosuid` or `nodev`, every
`docker cp` into or out of that container is refused, running or stopped:

```
Error response from daemon: remount-ro <data-root>/rootfs/overlayfs/<id>/<target>, flags: 0x1021: operation not permitted
```

`0x1021` is `MS_BIND | MS_REMOUNT | MS_RDONLY` without the locked `nosuid`
and `nodev` flags, which a user namespace may not clear. Starting the
container works (runc keeps the locked flags) and so does `docker exec`;
only the daemon's own archive path remounts without them.

**Context.** This is the refusal 0109 task 3 classified for container start
from the 2026-10-25 report and never reproduced. It does not happen at start
on Engine 29.9.2 with runc 1.5.2; it happens in `docker cp`. A runtime's
read-only binds are the staged input revision, the project Git mirror and
the project seed binds, all under Orkestrator's data directory, so a data
directory on such a filesystem (a separately mounted `/home` with
`nosuid,nodev`, or a tmpfs) breaks every `docker cp` the backend runs
against its runtimes: the exited-boot record (`readExitedBootFailure` in
`container-readiness.ts`, which then reports `container-exited` instead of
the recorded code), project files (`commands-project-files.ts`), project
seed files (`container-project-seed-files.ts`), the rebuild copy
(`pipeContainerPath` in `container-replacement.ts`) and the GitHub seed
(`copyGithubRangesSeed`). None of these errors is classified as a topology
problem today.

**Investigation.** Reproduced on 2026-11-09 on beelink2 (kernel 7.2.15, a
disposable host rootless Engine 29.9.2, containerd v2.4.2, runc 1.5.2,
RootlessKit 3.3.0): a container with a read-only bind from a `mktemp -d`
under the tmpfs `/tmp` (`rw,nosuid,nodev`) refused `docker cp` out and in
while running and out after stopping, while `docker exec` worked; the same
container shape with the source on the btrfs home filesystem copied in and
out normally. The live readiness suite hit it through the git mirror bind
when `TMPDIR` was `/tmp`: "a missing firewall script" and "a DNS-broken
network" got `container-exited` instead of `firewall-missing` and
`firewall-failed`, and both passed with `TMPDIR` on the home filesystem.
`bindMountRefusedError` (`container-start.ts`) would match this message
(`remount` plus "operation not permitted") but only the start path calls it.

On 2026-11-10 on beelink (kernel 7.1.8, disposable rootless Engine 29.9.2)
the refusal reproduced on the containerd image store and on overlay2
(`remount-ro <data-root>/overlay2/<id>/merged/ro, …`). The CLI hides it for
a copy into a directory: the seed files' tar stream into `/` reports
`destination "<id>:/" must be a directory`, and a copy into `/tmp/` reports
`no such directory`, so a message match alone misses the creation-time
copies. A copy out of a path that cannot exist repeats the remount refusal
on an affected container and answers `Could not find the file` on a healthy
one.

What was built (see "Assumptions and decisions"): every copy path above now
classifies the refusal. `docker-copy-refusal.ts` matches the daemon's
message and, when the CLI hid it, asks the daemon once with that probe.
Project seed files and configured project files fail creation with
`unsupported-topology` and the remedy; a rebuild's copy step reports
`unsupported-topology` (`source-copy-refused`); the exited-boot read
reports `boot-record-copy-refused` instead of `container-exited`; the
GitHub seed logs `refusal=read-only-bind-remount`. The opt-in live test
`apps/backend/tests/docker-copy-refusal-docker.test.ts` drives all of them
at a real container and passed on both stores.

The upstream report was not filed: it is an outward-facing action, which
this repository's rules leave to the user (moved to
[7568](../manual-test/7568-manual-test-checklist.md) on 2026-11-10). A draft, from the evidence above:
"Rootless dockerd 29.9.2 (runc 1.5.2, RootlessKit 3.3.0): `docker cp` into or
out of a container with a read-only bind whose source filesystem is mounted
`nosuid` or `nodev` fails with `remount-ro <rootfs>/<target>, flags: 0x1021:
operation not permitted`, on the containerd snapshotter and on overlay2,
running or stopped. Starting the container and `docker exec` work, since
runc keeps the locked flags. Reproduce: `d=$(mktemp -d /tmp/x.XXXX)` on a
`nosuid,nodev` tmpfs, `docker run -d -v $d:/ro:ro busybox sleep 300`, then
`docker cp <id>:/etc/hostname -`. Expected: the archive path keeps the
source mount's locked flags as runc does."

**Decisions.**

- **What to do about it?**
  - **Classify it: route `docker cp` failures through `bindMountRefusedError` (or a sibling) so they surface as `unsupported-topology` with the existing remedy, and report the daemon behaviour upstream to Moby (recommended).**
    - Pros: small; the user is told the real cause (move the data
      directory or run rootful) instead of a generic copy or
      `container-exited` failure; the fix belongs in the daemon, which
      already preserves the flags at start through runc.
    - Cons: affected users still cannot use those features until they move
      the data directory or the daemon is fixed.
  - **Check at environment creation, on rootless, whether any bind source's filesystem is `nosuid`/`nodev`, and refuse up front.**
    - Pros: one clear failure before anything is created.
    - Cons: refuses environments that would start and run (start and
      `exec` work); needs a mount-flag probe per bind source.
  - **Replace `docker cp` with `docker exec … tar` for running containers.**
    - Pros: avoids the daemon's remount for every running-container copy.
    - Cons: a stopped or created container has no `exec`, so the boot
      record, rebuild and creation-time copies stay affected; a second copy
      mechanism to maintain.

### 2. `docker cp` into a container that is not running fails with `device or resource busy`

**Problem.** On the same daemon, copying into a created or stopped container
of the environment image fails every time, with no `nosuid`/`nodev` source
involved:

```
Error response from daemon: failed to mount <data-root>/rootfs/overlayfs/<id>: mount source: "overlay", … fstype: overlay, flags: 0, data: "workdir=…,upperdir=…,userxattr,lowerdir=…", err: device or resource busy
```

Copying into a running container and copying out of any container work.

**Context.** Three creation paths copy into a created, not yet started
container: project seed files (`copyProjectSeedFilesIntoContainer`),
configured project files (`stageConfiguredProjectFilesForContainer`) and
the GitHub ranges seed (`copyGithubRangesSeed`, for runtimes and egress
gateways). The first two remove the container and fail the creation when
the copy fails (`commands-containers.ts`, around the
`copyProjectSeedFilesIntoContainer` call), so on such a daemon a project
with a `.env` seed file or configured project files cannot get a container.
The seed copy is best effort and only logs `github-ranges.seed-not-copied`
(`reason=unclassified`); the firewall then fetches GitHub's ranges from
`api.github.com/meta` itself on every restricted boot. That request is
unauthenticated and limited to 60 an hour per address, so a host that
creates restricted containers quickly runs out and the next boots fail
closed (`firewall-failed`, or the gateway's "could not apply its network
policy").

**Investigation.** On 2026-11-09, on the disposable daemon of task 1, which
uses the containerd image store (`driver-type io.containerd.snapshotter.v1`,
the default for a new Engine 29 data root): `docker create` of the
78-layer environment image followed by `docker cp file <id>:/tmp/` failed
three times in a row, also after a 5 s wait, also as `docker cp -a -` with a
tar stream (the seed files' form), and also after the container had been
started and stopped. A one-layer `busybox` container failed the first copy
and accepted the second. The readiness runs logged
`github-ranges.seed-not-copied` for runtimes and gateways alike. A
readiness rerun that finished at 23:15 UTC, about 20 minutes after the first
live suite started, failed four restricted-boot cases with
`firewall-failed` or the gateway policy failure, cases that had each passed in
an earlier run; a minute later the host's unauthenticated GitHub API
allowance read 0 of 60. Other processes on the host share that address, so
not every request was these runs'. Not yet known: whether a rootless daemon
on the `overlay2` graph driver, a rootful containerd-store daemon or another
kernel do the same. The 2026-10-25 and 2026-10-26 rootless runs used a
systemd user service whose storage was not recorded, and their creation
paths did not copy project seed files.

Steps:

1. On disposable daemons, run the probe above (`docker create` of the
   environment image, then `docker cp` of a file into it) on rootless
   containerd store (reproduced), rootless `overlay2`, and rootful containerd
   store; record which fail. Partly done 2026-11-10: the launcher now takes
   `--storage containerd|overlay2`; on beelink (kernel 7.1.8) the probe
   passed on rootless containerd store and rootless overlay2 alike (busybox,
   `oven/bun:1.4.4` and the 78-layer `orkestrator-v2:dev-8bff8877f7f8`, three
   copies each, the tar-stream form, after a start and stop, and with the
   runtime's two named volumes and a read-only bind). So on this host neither
   store fails, and the rootful comparison could not separate them and was
   not run. beelink2 failed on kernel 7.2.15; repeat the probe there (or on
   any host that fails) on both stores, with
   `mise run docker:disposable -- start --storage overlay2` for the second.
   Done 2026-11-13 on beelink2 itself (kernel 7.2.15,
   [evidence](../../development/container-qualification.md#docker-cp-busy-probe-copy-stream-stall-and-port-collision-runs-on-beelink2-2026-11-13)): not reproduced on
   rootless containerd store (an environment image built in the daemon, and
   one copied in with `load-image`) or rootless overlay2, with busybox,
   `oven/bun`, 78- and 80-layer probe images and the 78-layer environment
   image, after a start and stop, with volumes and a read-only bind, with six
   creates and copies at once, right after daemon restarts, and with a
   recursive watcher on the data root. That kernel has overlayfs `index=Y`,
   under which a second mount of an upper directory still in use by another
   overlay mount fails with exactly `EBUSY`; the snapshot mounts on today's
   daemon pass `index=off`, which disables that check. What held the
   container's upper directory on 2026-11-09, and whether that daemon's
   mount omitted `index=off`, is not known: an attempt to hold a snapshot
   mounted by hand was rejected with `EINVAL`.
2. Pick the fix below for the affected set and add a live case that creates a
   runtime with a project seed file on a rootless daemon. Partly done
   2026-11-13: the three copies retry a busy refusal and then fail with a
   typed error ("Assumptions and decisions"), and seed-file delivery into a
   created environment-image container passed live on beelink2's rootless
   daemon (`container-project-seed-docker.test.ts`). The recommended bind
   delivery is still not built: with no failing host it could not be shown
   to fix anything, and it is an image contract change in the input-staging
   code. Act on it when the refusal recurs.

**Decisions.**

- **How should creation deliver files to a container that is not running?**
  - **Deliver them through a bind the backend already makes: project seed files and configured project files in the per-environment input revision, the GitHub seed beside it, read by the entrypoint as the staged inputs are (recommended, pending step 1).**
    - Pros: start accepts read-only directory binds on rootless (start
      recovery's rootless mount case passes); no daemon archive path at
      creation; revocation and renewal already work for that revision.
    - Cons: an image contract change (new mounts and entrypoint reads, a
      capability bump) and task 1's `docker cp` refusal still applies to the
      other copies when the data directory is `nosuid`/`nodev`.
  - **Start the container first and copy into the running container before setup reads the files.**
    - Pros: copies into a running container work here.
    - Cons: the entrypoint and the firewall read these files during boot,
      so it needs a new wait-for-inputs handshake in the image; a restricted
      boot cannot wait on the seed without a deadline.
  - **Retry the copy.**
    - Pros: trivial.
    - Cons: it fails every time for the environment image; only the
      one-layer probe ever succeeded on a retry.
- **Should the firewall's GitHub fetch stop depending on the anonymous allowance?**
  - **No; fix the seed delivery above so the fetch is the exception again (recommended).**
    - Pros: the seed exists so that boots do not fetch; no token goes near a
      container.
    - Cons: a host whose seed is older than a day still fetches per boot.
  - **Pass a token to the firewall's fetch.**
    - Pros: 5000 requests an hour.
    - Cons: puts a credential in every restricted container's root phase.

### 3. An automatic port can collide twice in a row

**Problem.** In one of the 2026-11-09 readiness runs, an egress gateway's
start collided on an automatic port (`start.port-collision-retrying …
port=33124`), retried once as `startDockerContainer` does, collided again and
failed the start with `port-conflict`. The test ("a gateway that cannot apply
its firewall") expected the gateway's `not-ready` refusal; it passed in the
four other runs of that file.

**Context.** 0109 task 4 added the single retry: rootless dockerd chooses an
automatic host port inside its own namespace, RootlessKit then binds it on
the host, and the bind fails when a host socket already holds it. The same
day C10's bare `docker restart` collided on port 33014, which is why C10 now
restarts through the start path.

**Investigation.** Right after the double collision no host socket listened
anywhere in 33000–33299 (39 listeners in the whole 32768–60999 range,
which is also the host's `ip_local_port_range`). So the holders were
short-lived, most likely outbound loopback connections, which take their
local port from the same range; beelink2 runs a production Orkestrator whose
backend polls its bridges over loopback every two seconds. Not confirmed:
nothing recorded which socket held 33124. Rootless dockerd hands out
automatic ports in sequence, so a retry draws the next port in the same busy
neighbourhood.

**Decisions.**

Done 2026-11-10: `startDockerContainer` retries up to
`PORT_COLLISION_RETRIES` (3 then; 10 since 2026-11-13, 7750 (retired)) times, reconnecting the network before each
retry and stopping a started container that still has none; a collision past
the retries is the existing `port-conflict`. Unit tests cover three collisions
then a start, and four collisions; the live start-recovery suite
(`container-start-docker.test.ts`) passed 3/3 on a disposable rootless daemon
with its fault injection raised past the retries.

- **How many times should a start retry an automatic-port collision?**
  - **A bounded few (for example three), each still reconnecting the network first, as the single retry does now (recommended).**
    - Pros: a small change in `startDockerContainer`; each retry draws a new
      port, so transient holders stop mattering; still bounded.
    - Cons: a start on a pathological host takes a few extra Docker calls
      before failing.
  - **Keep one retry.**
    - Pros: no change.
    - Cons: a busy host fails some starts with a `port-conflict` that names
      no port the user can free.
  - **Publish from a host port range outside `ip_local_port_range`.**
    - Pros: no collision with outbound sockets at all.
    - Cons: the range has to be chosen per host and kept free; fixed ranges
      collide between environments instead.

### 4. Automatic ports still collide past three retries right after a rootless daemon restart

**Problem.** On 2026-11-11 an egress gateway's start, the first after a
disposable rootless daemon's restart, collided on automatic host ports four
times in a row (`start.port-collision-retrying` for 32772, 32776 and 32777,
then the fourth attempt), so the start failed with `port-conflict`. The
start before the restart had collided once (32776) and then succeeded. The
same case passed a minute later.

**Context.** Task 3's three retries assumed each retry draws a fresh port
away from short-lived holders. A rootless daemon allocates automatic ports
inside RootlessKit's namespace from the bottom of that namespace's
`ip_local_port_range` (32768–60999), and a restarted daemon starts there
again. The host's own outbound connections take their local ports from the
same range, and Linux gives `connect()` even ports by preference.

**Investigation.** Right after the failure no socket listened on any of
those ports; the host held about 1,650 TCP sockets in `TIME-WAIT`, mostly
loopback, among them `127.0.0.1:32772`, `:32776`, `:32792` and `:32798` to
one short-lived local server on port 34037 (other pipelines' tests were
running). A `TIME-WAIT` socket on a port makes RootlessKit's bind of that
port fail for up to 60 s. Docker drew 32776 twice across the attempts, so a
retry does not always move away from a held port.

Measured the same day on that daemon (`l7390`): with host listeners on the
14 ports after the daemon's next automatic port, a container publishing
three automatic ports failed 14 starts in a row (the network reconnected
before each, as `startDockerContainer` does), each on the next held port
in turn: 32778, 32779, … 32789, then 32791 and 32793, skipping only the
free ports. So each failed start moves the daemon's cursor on by one port,
and a run of held ports longer than the retry budget defeats any retry
count. Without the reconnect the second start "succeeded" with no published
ports, the Docker 29.9 behaviour the start path already handles.

Steps:

1. Done 2026-11-11: what each retry draws (above).
2. Done 2026-11-11: built the recommended fix (below) with unit tests, and
   qualified it on a disposable rootless daemon with host listeners holding
   the next automatic ports.

What was built (see "Assumptions and decisions"): when the daemon is
rootless, container creation (`commands-containers.ts`) passes every
automatic loopback mapping through `chooseBackendHostPorts`
(`container-host-ports.ts`), which binds `127.0.0.1:0` on the host for each,
keeps them all bound until every port is chosen, releases them and
publishes them as fixed ports, with the `orkestrator-backend-host-ports`
label on the container that owns the namespace (the gateway when there is
one). `startDockerContainer` reads the label: a collision on a labelled
port is retried on the same port after 1, 2 and 4 s
(`PORT_HOLD_RETRY_DELAYS_MS`); a port the user fixed is still never
retried, and Docker's own automatic ports keep the fresh-port retry.
`container-host-ports.test.ts` and `container-start.test.ts` cover the
choice, the label and both retry kinds. Live, on a disposable rootless
daemon: with the seven ports after Docker's next automatic port held, a
container with Docker's automatic mapping failed past the retries while the
same container with a backend-chosen port started first time, and a start
whose chosen port was held retried it after a pause and started once the
holder went (`container-start-docker.test.ts`, 4 runs). The daemon-restart
case of `container-live-egress-conditions.test.ts`, which failed on task 4
earlier that day, passed 3/3 and now asserts that a rootless gateway
publishes only backend-chosen ports and keeps them across both restarts.

**Decisions.**

Done 2026-11-11: the recommended option, with a label telling
backend-chosen ports from ports the user fixed and a same-port retry after a
pause instead of recreating the container.

- **How should a start avoid ports that loopback churn holds?**
  - **On a rootless daemon, have the backend choose each automatic host port itself (a host `bind` to port 0) and publish it explicitly, marked as backend-chosen (recommended).**
    - Pros: the host kernel hands out only a port nothing holds, and it
      prefers odd ports for `bind`, away from outbound sockets; no walk
      through a held run.
    - Cons: ports are fixed at create time, so a later start reuses the
      same port and a collision then needs a new port, which means
      recreating the container or a label telling backend-chosen ports from
      ports the user fixed (which the start path never retries).
  - **Raise the retry count (for example to eight).**
    - Pros: one constant; enough for a few isolated holders.
    - Cons: measured to advance one port per attempt, so it only adds
      Docker calls before the same failure when a run of ports is held.
  - **Keep three retries and accept the failure.**
    - Pros: no change; the hold lasts at most the 60 s of `TIME-WAIT`, and
      the next start usually succeeds.
    - Cons: a start fails with a `port-conflict` that names no port the
      user can free, most often right after a daemon restart.

## Current state

- Start, `exec`, copies into a running container and copies out of any
  container work on a rootless daemon unless a read-only bind source is
  `nosuid`/`nodev` (task 1). When it is, every copy the backend runs is
  reported as that refusal with its remedy, but the features still fail
  until the data directory moves or the daemon is fixed.
- The live readiness suite on a rootless daemon still needs `TMPDIR` on a
  filesystem mounted without `nosuid`/`nodev`; from `/tmp` its two
  firewall-failure cases now report `boot-record-copy-refused` instead of
  `container-exited` (task 1).
- Copies into a created container work on beelink (kernel 7.1.8) on both
  image stores (again on 2026-11-11 on the containerd store) and, since
  2026-11-13, on beelink2 (kernel 7.2.15) on both, where they were refused on
  2026-11-09 (task 2). A copy into a created container the daemon refuses as
  busy is retried after 1 and 3 s; one still refused fails with
  `unsupported-topology` naming the busy filesystem (seed files and project
  files), or is logged as `refusal=snapshot-busy` (the GitHub seed).
- On a rootless daemon, runtimes and gateways created from now on publish
  host ports the backend chose; they keep them across starts and daemon
  restarts, and a start that finds one held waits for it a few seconds
  (task 4). Containers created earlier keep Docker's automatic ports, and
  with them the collisions past three retries, until they are rebuilt.
- Chosen ports never repeat a port the same create fixes, a port labelled on
  another container of the same owner, or one this backend chose in the
  last 30 minutes (task 4). A program outside Orkestrator that keeps a
  stopped container's port bound still blocks that container's start: after
  the same-port retries it fails with a `port-conflict` that says to stop the
  holder or rebuild the environment.

## Outstanding work

- Task 2 (blocked on a recurrence): when a host refuses copies as busy
  again (`copy-in.snapshot-busy` in the backend log, or the typed error),
  record the daemon's full mount options and whether `index=off` is among
  them, then build the recommended bind delivery and its live case.

## Assumptions and decisions

### Classify by asking the daemon when the CLI hides the refusal (task 1)

Chose: match the daemon's `remount-ro … operation not permitted` in the
copy's own error, and when it is not there (and the failure is not a
timeout or an outage), run one `docker cp <id>:/.orkestrator-copy-probe-absent -`
and match its answer. Why: the seed files' tar stream and the directory
copies surface only `must be a directory` or `no such directory`, which a
message match cannot tell from a real path problem; the probe costs one
mount and stat, only on a copy that already failed. Alternative: classify on
the message alone, which would have missed exactly the creation-time copies
this task names.

### A refused boot record is its own failure code, not a topology error (task 1)

Chose: `boot-record-copy-refused`, still `not-ready`, with the remedy in the
message. Why: the boot failed for some other reason the record would name;
calling the whole boot an unsupported topology would misstate it, and
`container-exited` read as "no record".

### The GitHub seed stays best effort (task 1)

Chose: log `refusal=read-only-bind-remount` and carry on. Why: the
firewall's own fetch still covers it; failing the runtime or gateway would
turn a slower boot into no boot.

### Three retries (task 3)

Chose `PORT_COLLISION_RETRIES = 3`, per the recommendation. Why: each retry
draws the next sequential port, and the observed holders were short-lived;
three keeps a pathological host to a few more Docker calls.

### `--storage` in the disposable launcher (task 2, step 1)

Chose a `--storage containerd|overlay2` start option (in both modes) and an
image identity check that accepts a different id when the layer digests,
creation time and architecture match. Why: step 1 needs the comparison
daemon, and overlay2's image id is the config digest while the containerd
store's is the manifest digest, so the old id check refused every image
copied into an overlay2 instance.

### Retry a busy copy twice, then fail with a typed error (task 2)

Chose: `copyIntoContainer` (`docker-copy-refusal.ts`) runs the seed-file,
project-file and GitHub-seed copies; when the daemon answers `failed to mount
… device or resource busy` it retries after 1 and 3 s
(`COPY_BUSY_RETRY_DELAYS_MS`), and a copy still busy fails with an
`unsupported-topology` error that names the busy filesystem (the GitHub seed
logs `refusal=snapshot-busy` and carries on). Why: the 2026-11-09 busybox
container accepted its second copy, so a short retry covers the transient
case at no cost to a healthy daemon, and the creation failure now says why
instead of passing on a raw daemon message. The failed attempt never
extracted anything (the mount failed first), so repeating the whole copy is
safe. This is not the recommended fix: the environment image refused three
copies 5 s apart, which no retry covers. Alternative: build the bind
delivery now, which with no failing host could not be shown to fix
anything and changes the image contract in the input-staging code another
build is editing.

### Task 4 kept in this to-do (task 4)

Chose: record the collision past the retries as task 4 here rather than a
new to-do. Why: it is task 3's retry path failing under a condition task 3
did not see, and this file already holds that evidence and decision.

### The backend chooses ports only on rootless daemons (task 4)

Chose: choose host ports on the host only when `detectDockerTopology`
reports rootless; rootful daemons keep `127.0.0.1::<port>`. Why: a rootful
daemon allocates in the host's own namespace and already skips ports host
sockets hold, so the change would only move the choice without fixing
anything there.

### A held backend-chosen port is retried on the same port after a pause, never recreated (task 4)

Chose: retry the same port after 1, 2 and 4 s within the existing three
retries. Why: the observed holders are short-lived loopback connections,
and the chosen ports are odd, which outbound `connect` avoids, so a held
chosen port should be rare and brief. Recreating the container with a new
port would be a lifecycle operation of its own (durable operation records,
storage, the gateway's workload), far larger than the failure it covers.
Alternative: fail at once with `port-conflict`, which would turn a hold of a
second into a failed start.

### The label marks the backend's ports so the start path can tell them from the user's (task 4)

Chose: the `orkestrator-backend-host-ports` label lists the chosen ports,
and a labelled port the bindings do not fix is ignored. Why: once published
they look exactly like ports the user fixed, which the start path must keep
refusing to retry.

### Chosen ports avoid ports another container or the same create already claims (task 4)

Chose: before probing, collect the host ports the same request fixes (by
protocol), the ports labelled on every container of the backend's owner
(`docker ps -a`, running or stopped) and the ports this process chose in
the last 30 minutes, and refuse a probe result that matches one, holding it
so the next probe cannot return it (at most 32 probes per mapping). Why: a
stopped container's fixed port holds no host socket, and neither does a
fixed port Docker has not bound yet, so the kernel alone would hand them
out again and the later start would fail on the same port every time. The
in-process reservation covers the window before a newly created container
appears in `docker ps`, so two concurrent creates cannot receive the same
port. A listing Docker cannot answer is logged
(`host-ports.owned-list-failed`) and treated as no ports rather than
failing the create. Alternative: a persisted reservation registry of
chosen ports, which would duplicate what the label already records on the
container itself and could drift from Docker's state.

### A backend-chosen port held past the retries says to rebuild (task 4)

Chose: when the same-port retries run out, the start fails with a
`port-conflict` that names the port and says to stop its holder or rebuild
the environment, which chooses new ports. Why: the user's port mappings are
not the cause, so the generic "change the port mappings" advice was wrong
for this case. Recreating the runtime automatically stays out of the start
path for the reason in the decision above.

## Related

- The retired to-do 0109 (task 3 classified the start refusal; task 4 added
  the single retry; task 5 found these): its evidence is the
  [rootless re-run record](../../development/container-qualification.md#rootless-re-run-on-a-freshly-built-image-2026-11-09).
- To-do 4730 (retired 2026-11-10; the launcher is in [container qualification](../../development/container-qualification.md#disposable-docker-daemon))
  (the launcher used, which has no storage-driver option).
- [Container lifecycle](../../architecture/container-lifecycle.md)
  ("Portable inputs").
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (the user part of task 1: approving and filing the upstream Moby report) moved there on 2026-11-10.
