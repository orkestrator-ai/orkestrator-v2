# Rootless Linux runtime gaps

Found 2026-10-25 against `main` at `ba7cc8d4` (branch
`todo-0021-container-rebuild-state-8b38e460f2a1`).

The first live run on a real rootless Linux daemon (Docker 29.9.1 as a
systemd user service, RootlessKit 3.3.0 with slirp4netns) qualified volume
storage, replacement, restore and the rebuild fault paths. It also found four
places where a rootless runtime works differently from a rootful one. All
four fail safe: nothing leaks and no data is lost. The first two leave an
environment without its provider logins or its agent tools. The evidence is
in [container qualification](../../development/container-qualification.md#rootless-linux-host-2026-10-25).

## Current state

- Staged inputs (`portable-inputs.ts`) are written owner-only (`0700`
  directories, `0600` files) by the backend's user and bind-mounted read-only
  (`stagedInputMountArguments`). On a rootful daemon, host UID 1000 is the
  container's `node`. On a rootless one, the host user is container root and
  `node` maps to a subordinate UID, so `node` cannot open the mounts. The
  entrypoint's copy then skips them: the live C20 test found no
  `~/.codex/auth.json`.
- The backend's agent-tools service is reached at `host.docker.internal`
  (host gateway). Under RootlessKit that address is in the daemon's own
  network namespace, and host loopback is disabled by default
  (`DOCKERD_ROOTLESS_ROOTLESSKIT_DISABLE_HOST_LOOPBACK`).
  `container-host-reachability` already detects this and reports the path
  closed (`host=blocked`).
- Read-only binds (`--mount …,readonly`) of a file whose source filesystem is
  mounted `nosuid` or `nodev` fail under rootless with `remount-ro …
  operation not permitted`, because the user namespace cannot clear locked
  mount flags. The live fixtures hit it with a tmpfs `/tmp`; a data directory
  on such a filesystem would hit it in production.
- Published ports are ephemeral (`127.0.0.1::<port>`). Rootless dockerd picks
  the host port inside its namespace without seeing host listeners, and
  RootlessKit's bind can then collide with a host process. That surfaces as
  `port-conflict`, and a rebuild keeps its original.

## Outstanding work

### Code

1. Make staged inputs readable by `node` on a rootless daemon without
   widening them on a rootful one. Options to weigh:
   - copy the revision in with `docker cp` (the daemon maps ownership) instead
     of binding it;
   - write the revision as the mapped UID (`unshare --map-auto` and chown);
   - give the entrypoint's root phase the copy, so it writes `node`-owned
     files.

   The fix must keep revocation working, because it currently empties files
   inside the bound revision.
2. Agent tools on rootless. Options to weigh:
   - set up the RootlessKit host-loopback route when the daemon is ours;
   - publish the service through the container's own forwarded port;
   - report the environment as "agent tools unavailable" in the environment
     view, rather than only in the reachability diagnostic.
3. Avoid read-only file binds from `nosuid`/`nodev` sources on rootless:
   - stage the GitHub ranges seed and other single-file binds inside the
     environment's input revision, or copy them in;
   - otherwise refuse with a typed error that names the mount.
4. Retry container start once with fresh ephemeral ports when RootlessKit
   reports `address already in use` for a port Docker chose, so a rebuild
   does not fail on a collision the user did not cause.

### Qualification

- Re-run the live lifecycle (C20), network (C22) and readiness suites on the
  rootless host after items 1 to 3. The setup and commands are in the
  evidence section linked above.

## Constraints and rationale

- Never widen staged-input permissions on a rootful daemon to make rootless
  work: other host users can read a `0644` file.
- Never fall back to the shared bridge or `--network host` for reachability.
- A rootless daemon is detected by the topology probe (`name=rootless` in
  `SecurityOptions`); branch on that, not on the host OS.

## Open questions

- Is rootless common enough among users to warrant item 2's network setup,
  or is a clear "agent tools unavailable" state enough?

## Related

- [0019-container-platform-qualification.md](0019-container-platform-qualification.md)
  (the rootless item these came from),
  [0018-container-network-and-credential-isolation.md](0018-container-network-and-credential-isolation.md)
  (staged inputs and host access).
- [Container lifecycle](../../architecture/container-lifecycle.md) ("Portable
  inputs", "Environment networks").

## Replaces

Nothing; new work from the 2026-10-25 rootless run.
