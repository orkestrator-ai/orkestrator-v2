# Rootless Linux runtime gaps

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Staged inputs readable by `node` on rootless (Code 1)**: a root-phase relay to `/run/orkestrator-inputs`. Status: done (`1aabf049`, #1307).
2. **Agent tools on rootless (Code 2)**: probe RootlessKit's host loopback, otherwise show a clear unavailable state. Status: done.
3. **Read-only binds from `nosuid`/`nodev` sources (Code 3)**: copy the GitHub seed in, and give a typed refusal. Status: done; the refusal itself was never captured live.
4. **Start retry on port collision (Code 4)**: `startDockerContainer` retries once and reconnects the network. Status: done.
5. **Rootless re-run on a freshly built image (Qualification)**: C20, C22 and readiness on a rootless daemon with an image built from current `main`. Status: partly done (passed on an existing image with older agent pins; rootful CI passed on a fresh build).
6. **Retire the file**: decide when the file is Finished and deleted. Status: open (after 5).

### 1. Staged inputs readable by `node` on rootless

**Problem.** Under rootless Docker, `node` could not read the owner-only staged mounts, so the environment started without the provider logins.

**Context.** Decisions 1–3 chose a root-phase relay, triggered by what `node` can read, that also covers the project seed binds.

**Investigation.** Present at HEAD: `relay_staged_inputs` (`docker/network-policy-entrypoint.sh:165`, called at `:196`), `staged_input_path` (`docker/entrypoint.sh:51`), the capability marker `staged-inputs=3` (`docker/entrypoint.sh:32`), `stagedInputRelayPaths` (`apps/backend/src/core/portable-inputs.ts:950`) and `unreadableOnRootless` (`portable-input-status.ts:172-187`).

Rootful CI on GitHub runners, where the runner's uid is not 1000, now exercises decision 2's "rootful host whose user is not UID 1000" case. C20 failed there before the relay (run 40333566613: `cat: /home/node/.codex/auth.json: No such file or directory`) and passed with it (run 40409285999, linux-x64 and linux-arm64).

The same run still failed "C14 legacy migration with staged provider inputs" (`apps/backend/tests/container-live-replacement.test.ts:239`). Its precondition reads the raw mount `/codex-home/config.toml` as `node`, and on a non-1000 host that is now correctly unreadable. This is a test bug (found in todo 0058's analysis, retired on 2026-10-29; tracked in [0728](0728-container-ci-c14-assumes-uid-1000.md)), not a relay bug. No release has the relay yet: `v2.33.0-beta` (`225a91f3`) predates `1aabf049`.

**Decisions.** None: the item is done. The C14 precondition belongs to a new todo, as 0058's analysis recommends.

### 2. Agent tools on rootless

**Problem.** A rootless container could not reach the agent-tools service, and the user was not told why.

**Context.** Decision 4: never change the user's daemon; use host loopback when they have enabled it.

**Investigation.** Present at HEAD: the loopback alias is kept when no address is known (`apps/backend/src/core/commands-environment.ts:2375`, Multi Review finding 1), the probe uses `ROOTLESSKIT_HOST_LOOPBACK_ADDRESS` (`container-host-reachability.ts:796-798`), and `EnvironmentAgentToolsStatus` exists (`apps/web/src/components/environments/EnvironmentAgentToolsStatus.tsx`). Other RootlessKit network drivers (pasta, lxc-user-nic) still report `blocked`, as decision 4 says.

**Decisions.** None: done. Other RootlessKit drivers are a known limit, not open work.

### 3. Read-only binds from `nosuid`/`nodev` sources

**Problem.** A read-only file bind from a `nosuid`/`nodev` filesystem failed to start under rootless.

**Context.** Decision 6: copy the GitHub seed in, and classify any other refusal as `unsupported-topology`.

**Investigation.** `copyGithubRangesSeed` (`apps/backend/src/core/github-ranges-cache.ts:120`) and `bindMountRefusedError` (`container-start.ts:100-113`) exist. The classifier matches `REMOUNT_REFUSED` plus "operation not permitted". The pattern comes from the 2026-10-25 report: the review qualification could not reproduce the refusal, either on a tmpfs data root or on on-disk storage.

**Decisions.**

- **Is an unreproduced classifier good enough?**
  - **Yes; keep it and record the next real occurrence's message (recommended).**
    - Pros: the error fails safe either way (start refused); only the wording depends on the match.
    - Cons: a different runc message would surface as a generic start failure.
  - **Hunt for a reproducing runc and kernel combination now.**
    - Pros: a captured message.
    - Cons: open-ended work for a rare, fail-safe path.

### 4. Start retry on port collision

**Problem.** A rootless start could collide on an automatically picked host port and fail with `port-conflict`.

**Context.** Decision 7: retry on any daemon, because the condition is the error itself.

**Investigation.** `startDockerContainer` is at `apps/backend/src/core/container-start.ts:185`. "Live start and port recovery" (`container-start-docker.test.ts`) passed in CI on both architectures in run 40409285999.

**Decisions.** None: done and live-tested.

### 5. Rootless re-run on a freshly built image

**Problem.** The rootless qualification ran on an existing image whose bootstrap scripts matched the branch but whose pinned agents were older. Nothing has proved a freshly built image on a rootless daemon.

**Context.** The folder index names this as the only remaining work. Decision 6 says "the full live suite is still owed". 0019 owns the wider rootless matrix, for example a host without `cpu` delegation.

**Investigation.** `docs/development/container-qualification.md:293-340` records the review run: C20, C22, C09 readiness, all 13 mounts and start recovery, on `orkestrator-review-rootless:d03790`. Rootful CI built a fresh qualification image and passed every suite except the C14 staged case (run 40409285999). The difference between the two images is only the agent CLI pins, which the relay, the probe and the start paths do not depend on.

**Decisions.**

- **Is a fresh-image rootless run still needed?**
  - **Yes, but fold it into 0019's next rootless session rather than running it alone (recommended).**
    - Pros: one rootless setup covers both files; it confirms the shipped image rather than a lookalike.
    - Cons: 0109 stays open until then.
  - **Accept the review run plus rootful CI and close the item now.**
    - Pros: the evidence covers every changed script byte for byte; agent pins are irrelevant to these paths.
    - Cons: the index's stated gate was a new image; a packaging difference (for example image layer ownership) would go unseen.
- **Where to run it?**
  - **A disposable host rootless daemon, as in the review run, with `DOCKER_HOST` pointed at it and the suites run through `test:logged` (recommended).**
    - Pros: never touches the user's daemon; the recipe is already proven.
    - Cons: host loopback has to be enabled on that daemon, so the default-disabled path is covered only by the earlier verdict run.
  - **A rootless CI job.**
    - Pros: repeatable on every change.
    - Cons: GitHub runners need a rootless daemon set up per job; that is new workflow work.

### 6. Retire the file

**Problem.** Every code item is done. The file stays open only for task 5.

**Context.** README rule: once the last item is done, move durable behaviour into `architecture/` and delete the file.

**Investigation.** `docs/architecture/container-lifecycle.md` already covers portable inputs and environment networks (named in Related). The decisions and Multi Review notes here are history.

**Decisions.**

- **When to delete it?**
  - **After task 5, moving decisions 1, 4 and 6 into one paragraph each in `container-lifecycle.md` (recommended).**
    - Pros: follows the README; keeps the rationale where maintainers look.
    - Cons: some editing work on the architecture doc.
  - **Delete it now and move the rootless re-run into 0019.**
    - Pros: one fewer open file.
    - Cons: 0019 may not take new items under the README rules, so the run would need yet another new file.

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
- [Testing guide](../../development/testing-guide.md#macos-shell-test-prerequisites)
  ("macOS shell-test prerequisites"): six of this file's unit tests failed on
  macOS hosts; since todo 0350 (finished 2026-10-28, retired on 2026-10-29)
  they run there with Homebrew's GNU tools, or skip with the reason.

## Replaces

Nothing; new work from the 2026-10-25 rootless run.
