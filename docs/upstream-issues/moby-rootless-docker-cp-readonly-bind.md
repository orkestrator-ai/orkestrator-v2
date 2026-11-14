# Moby: rootless `docker cp` fails on a container with a read-only bind from a `nosuid`/`nodev` filesystem

**Tracker:** Moby, <https://github.com/moby/moby/issues> (bug report template)
**Status:** draft
**Source:** [7549](../todo/containers-and-environments/7549-rootless-docker-cp-refusals.md) task 1 (the draft is in its Investigation); filed through the [manual-test checklist](../todo/manual-test/7568-manual-test-checklist.md)'s "file the upstream reports marked ready" item
**Filed:** —

## Issue text

**Title:** rootless: `docker cp` fails with `remount-ro … operation not permitted` when a read-only bind's source is on a `nosuid`/`nodev` filesystem

**Summary.** On a rootless daemon, once a container has a read-only bind mount whose source sits on a filesystem mounted `nosuid` or `nodev`, every `docker cp` into or out of that container fails, running or stopped. Starting the container and `docker exec` work, because runc keeps the locked mount flags. Only the daemon's archive path remounts without them.

**Reproduction** (rootless daemon; `/tmp` is a `rw,nosuid,nodev` tmpfs):

```sh
d=$(mktemp -d /tmp/x.XXXX)
id=$(docker run -d -v "$d":/ro:ro busybox sleep 300)
docker cp "$id":/etc/hostname -          # fails
docker exec "$id" cat /etc/hostname      # works
```

The same container with the bind source on a filesystem mounted without `nosuid`/`nodev` copies in and out normally.

**Actual.**

```text
Error response from daemon: remount-ro <data-root>/rootfs/overlayfs/<id>/<target>, flags: 0x1021: operation not permitted
```

On overlay2 the path is `<data-root>/overlay2/<id>/merged/ro`. `0x1021` is `MS_BIND | MS_REMOUNT | MS_RDONLY` without `MS_NOSUID`/`MS_NODEV`, which are locked in the user namespace and may not be cleared. For a copy into a directory the CLI hides the daemon's message: a tar stream into `/` reports `destination "<id>:/" must be a directory`, and a copy into `/tmp/` reports `no such directory`.

**Expected.** The archive path keeps the source mount's locked flags when it remounts read-only, as runc does at start, so `docker cp` works.

**Versions.** Docker Engine 29.9.2 rootless, containerd v2.4.2, runc 1.5.2, RootlessKit 3.3.0. Reproduced on Linux 7.2.15 x86-64 (2026-11-09) and Linux 7.1.8 (2026-11-10), on the containerd image store and on overlay2. Still reproducing on 2026-11-11.

**Impact.** Any tool that bind-mounts read-only inputs from a data directory on such a filesystem (a separately mounted `/home` with `nosuid,nodev`, or a tmpfs) loses every `docker cp` to its containers: reading a boot record from an exited container, seeding files into a created one, copying for a rebuild. The only workarounds are moving the data directory or running rootful.

## Existing-report search

None known; the sources record no search. Search moby/moby (and rootless-containers/rootlesskit) for: `remount-ro operation not permitted`, `docker cp rootless read-only`, `flags: 0x1021`, `nosuid nodev docker cp`, `archive remount locked flags`.

## Before filing

- [ ] Re-run the reproduction on the current rootless Engine release and attach `docker version` and `docker info` output, which the bug template asks for.
- [ ] Search for duplicates.

## After filing

Record the URL and date under **Filed**, set **Status** to `filed`, and record the URL in [7549](../todo/containers-and-environments/7549-rootless-docker-cp-refusals.md) task 1.
