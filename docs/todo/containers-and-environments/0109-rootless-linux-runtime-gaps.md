# Rootless Linux runtime gaps

Found 2026-10-25 against `main` at `ba7cc8d4` (branch
`todo-0021-container-rebuild-state-8b38e460f2a1`). Code items done
2026-10-26; the review follow-up qualified the affected paths on a real
host rootless daemon with the complete environment image.

The first live run on a real rootless Linux daemon (Docker 29.9.1 as a
systemd user service, RootlessKit 3.3.0 with slirp4netns) qualified volume
storage, replacement, restore and the rebuild fault paths. It also found four
places where a rootless runtime works differently from a rootful one. All
four fail safe: nothing leaks and no data is lost. The first two leave an
environment without its provider logins or its agent tools. The evidence is
in [container qualification](../../development/container-qualification.md#rootless-linux-host-2026-10-25).

## Current state

As found on 2026-10-25. All four are handled in code since 2026-10-26 (see
the items below); the affected paths subsequently passed the review
qualification described below.

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

1. ~~Make staged inputs readable by `node` on a rootless daemon without
   widening them on a rootful one.~~ Done 2026-10-26 (branch
   `todo-0109-rootless-linux-runtime-d03790b22a6c`): the entrypoint's root
   phase relays a mount `node` cannot read (`relay_staged_inputs` in
   `docker/network-policy-entrypoint.sh`, `staged-inputs=3`), and
   `entrypoint.sh`/`workspace-setup.sh` read the relayed copy
   (`staged_input_path`). Revocation still works: the relay is rebuilt from the
   (emptied) mounts on every boot, and revoking also removes the relayed
   copies from the running container (`stagedInputRelayPaths`). A rootless
   container on an older image is flagged (`unreadableOnRootless`, inputs
   section; a creation log line). Evidence: `staged-input-relay.test.ts`
   (relay, bounds, links, revocation, resolution), the mirror test in
   `portable-inputs.test.ts`, and a live rootless run (container
   qualification, "Rootless follow-up").
2. ~~Agent tools on rootless.~~ Done 2026-10-26: on a rootless daemon the
   reachability check also probes RootlessKit's host loopback address
   (`10.0.2.2`); when it answers, new containers and gateways name it for
   `host.docker.internal` and the alias repair uses it, and when it does not,
   the verdict is `blocked` with a rootless remediation (the systemd drop-in
   and its cost) instead of firewall rules. The environment settings network
   pane shows "Agent tools unavailable" (`EnvironmentAgentToolsStatus`).
   Evidence: `container-host-reachability.test.ts` ("rootless Docker"),
   `docker-image.test.ts` (rootless alias), `egress-gateway.test.ts`,
   `EnvironmentAgentToolsStatus.test.tsx`, and live verdicts on both a
   loopback-enabled and the default rootless daemon.
3. ~~Avoid read-only file binds from `nosuid`/`nodev` sources on rootless.~~
   Done 2026-10-26: the GitHub ranges seed, the only single-file bind outside
   the input revision, is copied into the created runtime or gateway
   (`copyGithubRangesSeed`); a refused read-only remount on any start is an
   `unsupported-topology` error naming the source and target
   (`bindMountRefusedError`). The failure itself did not reproduce on this
   host's runc 1.5.2 (see the evidence). Evidence: `github-ranges-cache.test.ts`,
   `docker-image.test.ts`, `container-start.test.ts`.
4. ~~Retry container start once with fresh ephemeral ports.~~ Done
   2026-10-26: `startDockerContainer` (`container-start.ts`) for runtimes,
   rebuild candidates and gateways. Live, the failed start detached the
   container from its network, so the helper reconnects it before the retry
   and stops a retried container that still has none. Evidence:
   `container-start.test.ts` and a live collision on the default bridge and a
   user network.

### Qualification

- C20, C22, the two C09 readiness fixtures and authenticated agent-tools
  access passed on a disposable host rootless daemon with host loopback
  enabled. The all-mount suite also exercised every declared staged mount
  through the image's actual root bootstrap and node consumers. See the
  [review qualification evidence](../../development/container-qualification.md#rootless-review-qualification-2026-10-26)
  for commands, image identity and limits: the existing full image's
  bootstrap scripts matched this branch, but its older agent pins were not
  rebuilt. No user daemon configuration was changed.

## Constraints and rationale

- Never widen staged-input permissions on a rootful daemon to make rootless
  work: other host users can read a `0644` file.
- Never fall back to the shared bridge or `--network host` for reachability.
- A rootless daemon is detected by the topology probe (`name=rootless` in
  `SecurityOptions`); branch on that, not on the host OS. The relay itself
  branches on what `node` can read, which is the fact that matters and is
  never true of a rootful daemon whose host user is UID 1000.

## Open questions

- ~~Is rootless common enough among users to warrant item 2's network
  setup?~~ Answered by the decision below: Orkestrator does not change the
  daemon; it uses host loopback when the user enabled it and says how
  otherwise.

## Assumptions and decisions

1. **Staged inputs on rootless (item 1).** Options: `docker cp` the
   revision in; write it as the mapped UID (`unshare --map-auto` and chown);
   relay it in the entrypoint's root phase. Chosen: the root-phase relay,
   decided in the container by what `node` can read. `docker cp` puts
   credentials in the container layer where revocation cannot empty them
   before the next start, and has to be redone on every start;
   `unshare --map-auto` needs `newuidmap` and a subordinate range on the
   backend host and would make the host files unreadable to the backend's own
   user. The relay keeps the bound revision as the single source (so
   revocation and login renewal through `replaceStagedInputFile` keep
   working), touches nothing on the host, and does nothing on a rootful
   daemon. Cons: it needs a new image (`staged-inputs=3`; an older image on
   rootless is flagged, not fixed), the relayed copy lives in `/run` for the
   container's life (as readable to `node` as the mount is on a rootful
   daemon), and revocation must remove it explicitly.
2. **Relay trigger.** Options: an environment flag from the backend's
   topology probe; the container's own readability test. Chosen: the
   readability test. It needs no new creation input that a stale runtime
   could carry, also covers a rootful host whose user is not UID 1000, and
   the backend still branches on the topology flag for what it reports. Con:
   a relay can happen on a rootful daemon in that non-1000 case, which is the
   correct outcome.
3. **Project seed binds.** `/project-env` and `/opencode-project-json` have
   the same problem when the files are owner-only, so they are in the relay
   list. Con: a slightly wider scope than the item named.
4. **Agent tools on rootless (item 2).** Options: set up RootlessKit's host
   loopback when the daemon is ours; publish the service through the
   container's forwarded port; report "agent tools unavailable". Chosen:
   detect and use host loopback when the user has enabled it, otherwise a
   clear unavailable state with the exact daemon setting. Orkestrator never
   owns or restarts the user's daemon, and enabling host loopback lets every
   container of that daemon reach every host loopback service, a security
   trade only the user can make. A reverse tunnel through a forwarded port
   would need a multiplexing relay in every container for one diagnostic
   path. The host's LAN address was also tried live and refused. Cons:
   existing gateway runtimes need a rebuild after host loopback is enabled
   (their gateway snapshots the host address at boot), and `10.0.2.2` is the
   slirp4netns/vpnkit address, so other RootlessKit drivers stay `blocked`
   with the remediation until probed.
5. **Unavailable state placement.** Options: the sidebar item; the
   environment settings network pane. Chosen: the network pane, beside the
   environment's applied network policy, sharing the existing check's dialog.
   A per-item badge would add one subscription per environment for a state
   that is host-wide. Con: less visible than a sidebar badge; the app-wide
   banner still appears.
6. **`nosuid`/`nodev` binds (item 3).** Options: stage single-file binds in
   the revision; copy them in; refuse with a typed error. Chosen: copy the
   GitHub seed in (it is not a secret, nothing revokes it, and a file bind
   already pinned it at creation) and classify any refusal as a typed error.
   The staged-input file binds stay binds, because revocation empties them in
   place. Reused `unsupported-topology` rather than a new error code, so
   older clients still parse it. Con: the remount failure was not reproduced
   here, so the classifier's pattern comes from the 2026-10-25 report rather
   than a captured message; the full live suite is still owed.
7. **Port retry (item 4).** Retried on any daemon, not only rootless: the
   condition is the error itself (an automatic port collided), which a
   rootful daemon practically never reports. Pro: one start path. Con: none
   found.

### Multi Review outcome (2026-10-26)

The Multi Review (workflow `action-bd8c83c32f72db1961f694ff1ffdd8da`)
reported four P1 findings; all were real and fixed, none rejected:

1. An existing container's alias repair could replace a working
   `10.0.2.2` alias with the namespace gateway while the first reachability
   check was still running or had failed. `ensureContainerAgentToolsHost`
   now keeps a `10.0.2.2` alias on a rootless daemon when no address is
   known (the reviewer's second alternative). Chosen over awaiting
   discovery in every repair, which would put a check of up to 45 s in
   front of bridge starts and preflights.
2. The worktree-signal installer repaired the alias without the selected
   host address. It now passes `containerHostAddress()`, like the Claude
   state-signal installer.
3. Claude's plugin-enablement merge, added on `main` after this work began,
   read `/claude-config/settings.json` from the mount `node` cannot open
   under rootless Docker. It now reads through `staged_input_path`.
4. A failed retry, or a fixed-port collision, could leave the container
   detached from its network, so a later successful start ran without
   network or published ports. `startDockerContainer` now reconnects the
   network after every collision failure before returning it.

The coverage gaps it listed now have tests: the pending-probe alias repair
and explicit address override (`commands-process-coverage.test.ts`), the
worktree-signal address (`container-worktree-signal-install.test.ts`),
`unreadableOnRootless` for rootless, rootful, failed-inspect and
failed-manifest cases (`portable-input-status.test.ts`), the plugin merge
through the relay (`staged-input-relay.test.ts`), and detached-start
recovery (`container-start.test.ts`, plus the live-only
`container-start-docker.test.ts` and rootless assertions in the C20/C22
live suites, which run only with `RUN_LIVE_DOCKER_TESTS=1` and were not run
here at that point). The follow-up qualification above subsequently passed
the affected full-image rootless paths.
The review's fix pass also made `container-readiness.test.ts` build its tar
fixture with one 512-byte record (`-b 1`): GNU tar's default 10 KiB padding
exceeded the 8 KiB boot-record bound added on `main`, which failed that test
on `main` too.

## Related

- [0019-container-platform-qualification.md](0019-container-platform-qualification.md)
  (the rootless item these came from),
  [0018-container-network-and-credential-isolation.md](0018-container-network-and-credential-isolation.md)
  (staged inputs and host access).
- [Container lifecycle](../../architecture/container-lifecycle.md) ("Portable
  inputs", "Environment networks").
- [0350-rootless-tests-fail-on-macos.md](0350-rootless-tests-fail-on-macos.md):
  six of this file's unit tests fail on macOS hosts.

## Replaces

Nothing; new work from the 2026-10-25 rootless run.
