# Rootless Docker refuses `docker cp` that environment creation and readiness rely on, and port collisions outlast one retry

## Task analysis

Analysed 2026-11-09 against `main` at `c6de4733c`. Found by
the retired to-do 0109's task 5, the rootless re-run on a
freshly built image
([evidence](../../development/container-qualification.md#rootless-re-run-on-a-freshly-built-image-2026-11-09)).

### Tasks

1. **`docker cp` refused when a read-only bind's source is `nosuid`/`nodev`**: classify the refusal and decide whether to avoid it. Status: open.
2. **`docker cp` into a container that is not running fails with `device or resource busy`**: establish where it happens, then stop project seed files, configured project files and the GitHub ranges seed depending on it there. Status: open.
3. **An automatic port can collide twice in a row**: decide whether the start path's single retry should become a bounded few. Status: open.

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
   store; record which fail. The disposable launcher has no storage-driver
   option yet; add one or start the comparison daemon by hand.
2. Pick the fix below for the affected set and add a live case that creates a
   runtime with a project seed file on a rootless daemon.

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

## Current state

- Start, `exec`, copies into a running container and copies out of any
  container work on the rootless daemon above unless a read-only bind source
  is `nosuid`/`nodev` (task 1).
- The live readiness suite on a rootless daemon needs `TMPDIR` on a
  filesystem mounted without `nosuid`/`nodev`, or its two firewall-failure
  cases report `container-exited` (task 1).

## Related

- The retired to-do 0109 (task 3 classified the start refusal; task 4 added
  the single retry; task 5 found these): its evidence is the
  [rootless re-run record](../../development/container-qualification.md#rootless-re-run-on-a-freshly-built-image-2026-11-09).
- [4730-disposable-docker-daemon-for-live-suites.md](4730-disposable-docker-daemon-for-live-suites.md)
  (the launcher used, which has no storage-driver option).
- [Container lifecycle](../../architecture/container-lifecycle.md)
  ("Portable inputs").
