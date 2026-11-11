# Container qualification

Status: Living — C01–C30 scenario matrix, live Docker suites and benchmark
targets.

Unit and integration tests run the container lifecycle against a fake
`docker`. That cannot prove filesystem retention, packet rules, mount
permissions, name conflicts or signal delivery, so lifecycle, storage, network
and image changes are also qualified against a real daemon. How the lifecycle
works is in [container-lifecycle.md](../architecture/container-lifecycle.md);
the platforms and providers still waiting for evidence are in the
[containers to-do folder](../todo/containers-and-environments/0000-index.md)
and, for runs that need the user, the
[manual-test checklist](../todo/manual-test/7568-manual-test-checklist.md).
To-do 0019, which tracked the qualification until 2026-11-11, is retired;
its evidence record is in Git history (`git show 498b68766:docs/todo/containers-and-environments/0019-container-platform-qualification.md`).

## Rules

- Never run against a production installation or the packaged user's Docker
  resources, and never use or retag `orkestrator-v2:latest` as the
  qualification image.
- Every resource a suite creates carries a per-run label and an owner label
  derived from a private temporary data directory; `afterAll` removes exactly
  those resources, one per call, and fails if any is left
  (`removeLabelledResources` in `apps/backend/tests/container-live-cleanup.ts`).
  Docker Desktop 4.95 intermittently answered a multi-argument `docker rm -f`
  or `docker volume rm` under load with `404 page not found`, which a single
  call that ignored errors leaked silently. Never prune, globally or by owner.
- Synthetic file, network and lifecycle scenarios need no credentials.
  Provider runs use only an authorized agent-test profile's credential
  sources, and one provider's success never qualifies another.
- A skipped or timed-out run is incomplete, not a pass. Record flakes in the
  [registry](../tests/flaky-tests/0000-index.md) instead of weakening
  assertions.
- Inject faults only through test fixtures at the lifecycle-service boundary;
  no production setting lets a client bypass ownership or write operation
  phases.

## Suites

Wrap any command in `mise run test:logged -- --name <name> --` for a logged
run. Run the backend suites with `--cwd apps/backend`: the root `bunfig.toml`
ignores `apps/backend/tests/**`, so a repository-root path matches no file.

| Suite | Command | Scenarios |
| --- | --- | --- |
| Unit and integration | `mise run test` | Every scenario without a live suite below, against a fake `docker` |
| Live lifecycle | `RUN_LIVE_DOCKER_TESTS=1 ORKESTRATOR_QUALIFICATION_IMAGE=<image> bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/container-live-qualification.test.ts` | C09, C11, C12, C20 |
| Live start recovery | same command, `./tests/container-start-docker.test.ts` | Fixed-port collision and detached automatic-port failures past the start path's retries, then network and HTTP publication recovery. Add `RUN_ROOTLESS_MOUNT_TESTS=1` on rootless to exercise read-only file mounts; use `TMPDIR` on `nosuid,nodev` for that topology. |
| Claude config allowlist (M8) | same command, `./tests/claude-config-filter-docker.test.ts`; also run by `mise run test:agent:docker:isolated` | A fake host `~/.claude.json` staged from a throwaway HOME reaches `node` only as its allowlist, and interactive Claude starts in `/workspace` on it with no network and fake credentials |
| All staged mount consumers | same command, `./tests/staged-input-relay-docker.test.ts` | Every declared mount through the full root bootstrap, node entrypoint and workspace setup; rootless raw-mount denial, relayed imports and unchanged owner-only host files. |
| Project Git mirror | same command, `./tests/project-git-mirror-docker.test.ts` | Clone from the mirror, read-only mount, a foreign owner, fallback, a start with the source gone |
| Bridge credential (H4) | same command, `./tests/bridge-credential-docker.test.ts`; set `ORKESTRATOR_QUALIFICATION_OLDER_IMAGE` to add an image without `bridge-credential` | All five bridges start from the root-only token with a verifier; `node` finds the token nowhere, including `/proc`; what it can read gets 401 from the approval routes and the backend's token passes; planted `bunfig.toml` and `/opt` writes do nothing; a wider policy is refused live and taken after a restart; an older backend's unprefixed bridge keeps working; no credentials and no provider turns |
| Live replacement | same command, `./tests/container-live-replacement.test.ts` | C14–C19 |
| Live network | same command, `./tests/container-live-network.test.ts` | C22, C24, C26; on a gateway image C22 runs behind the egress gateway |
| Live firewall | same command, `./tests/container-live-firewall.test.ts` | C23 and the policy 3 tuples; on a gateway image also root tampering from the runtime, published ports through the gateway and a gateway restart. Point `ORKESTRATOR_QUALIFICATION_IMAGE` at an image that does not declare `egress-gateway` for the in-container firewall |
| Live egress conditions | same command, `./tests/container-live-egress-conditions.test.ts` | Gateway IPv6 (the daemon's IPv6 default, or with `ORKESTRATOR_LIVE_IPV6_NETWORK=1` an IPv6 network the test attaches), DNS rotation through a controlled resolver, and with `ORKESTRATOR_LIVE_DAEMON_RESTART_COMMAND` a Docker daemon restart. Point that command only at a disposable daemon. |
| Live egress name checks (M12) | same command, `./tests/container-live-egress-filter.test.ts`; set `ORKESTRATOR_QUALIFICATION_OLDER_IMAGE` to add an image without `egress-filter` | The gateway's TLS SNI, HTTP Host and DNS checks: an allowed name, a foreign SNI on its address, a Host check on a named port against a local fixture, bodies both ways, a server-first protocol, GitHub SSH, DNS refusals over UDP, TCP and straight to an outside resolver, a live edit, the daemon killed and restarted, a restart, a full-mode runtime, the rollback switch and an older image. Set `ORKESTRATOR_QUALIFICATION_EVIDENCE=<file>` to keep its topology line: whether the daemon is rootless, how Docker names its DNS upstreams in the gateway, and the gateway's nat redirections. Outside traffic only to registry.npmjs.org, nodejs.org and GitHub |
| Live agent CLIs without telemetry hosts | same command, `./tests/container-live-telemetry-hosts.test.ts`; set `ORKESTRATOR_TELEMETRY_HOSTS_TRACE=<file>` to record each turn's lookups and connections | With `sentry.io`, `statsig.anthropic.com`, `statsig.com` and the CLIs' Sentry ingest hosts refused, Claude Code (print, Agent SDK stream-json, a provider error), Codex (a turn and a provider error), OpenCode and Pi each finish a turn against a fake provider on the runtime's loopback within 90 s. No credentials and no provider turns; outside traffic only to registry.npmjs.org (OpenCode installs its provider package) and GitHub (to-do 6100) |
| Live rootless loopback | same command, `./tests/container-live-rootless-loopback.test.ts`, plus `ORKESTRATOR_LIVE_ROOTLESS_HOST_LOOPBACK=disabled` (printed by the [disposable daemon](#disposable-docker-daemon)); skips unless `docker info` also reports rootless, so the Linux Engine workflow lists it but it skips on the rootful runners | On a rootless daemon refusing host loopback (RootlessKit's default): host discovery reports `blocked` with the rootless remediation, and a restricted runtime behind its gateway cannot reach a host listener |
| Live readiness faults | same command, `./tests/container-live-readiness.test.ts` | C09 faults (missing firewall, DNS, permissions, torn status write, restart during launch; on derived images that do not declare `egress-gateway`, so the firewall stays in the runtime), a gateway that cannot apply its firewall, C10, C22 host-service reply, C23 re-run. On a rootless daemon put `TMPDIR` on a filesystem mounted without `nosuid`/`nodev`: from `/tmp` the two firewall-failure boots report `boot-record-copy-refused` (before 2026-11-10, `container-exited`), because the daemon refuses `docker cp` from those containers ([7549](../todo/containers-and-environments/7549-rootless-docker-cp-refusals.md)) |
| Live copy refusal | `ORKESTRATOR_COPY_REFUSAL_TEST_IMAGE=<image with sleep>` and a rootless `DOCKER_HOST`, `./tests/docker-copy-refusal-docker.test.ts` | Every `docker cp` the backend runs against a runtime (project seed files, configured project files, the GitHub seed, the boot record) against a container with a read-only bind from a `nosuid`/`nodev` directory (`/tmp`, or `ORKESTRATOR_COPY_REFUSAL_NOSUID_DIR`) is the typed refusal ([7549](../todo/containers-and-environments/7549-rootless-docker-cp-refusals.md) task 1) |
| Live rebuild faults | same command, `./tests/container-live-rebuild-faults.test.ts` | C15: daemon disconnect mid-copy (a `DOCKER_HOST` proxy in the test process), kill just before and after the commit write |
| Live build pipeline code rewind | same command, `./tests/build-pipeline-code-rewind-docker.test.ts` | "Rewind code to here" on fake providers through `createPipelineEnvironmentGit` and `docker exec`: preview, backup ref, reset, restart and lease push; a paused container refused with a readable reason; a reset journaled before the container stopped finishing once it answers (to-do 0405, task 7) |
| Live MCP delivery | same command, `./tests/mcp-overlay-live.test.ts` | Cursor `mcp.json` copy, container writer, environment overlay across stop/start and replacement, real rebuild re-staging (todo 0040) |
| Benchmarks | `RUN_CONTAINER_BENCHMARKS=1 ORKESTRATOR_QUALIFICATION_IMAGE=<image> bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/container-benchmarks.test.ts` | C28 |
| Final image | `bash docker/tests/final-image-smoke.sh <image>` (CI runs it on the native amd64 and arm64 builds in `validate-bun-runtime.yml`) | C27 |
| Real stack, Docker | `mise run dev:test --profile <p> --fixture --fixture-environments local,container`, then `ORKESTRATOR_AGENT_TEST_PROFILE=<p> mise run test:agent:docker` | C29 (`container-rebuild-cycle.spec.ts`), container settings (`container-settings.spec.ts`), deletion through the ledger (`browser-gateway.spec.ts`), design export into an Orkestrator container (`design-container-export.spec.ts`) |
| Real stack, live approval | The Docker profile above started with `--credential-source claude`, then `ORKESTRATOR_AGENT_TEST_PROFILE=<p> ORKESTRATOR_AGENT_TEST_LIVE_CONTAINER_APPROVAL=1 mise run test:agent:docker` | C11 approval half (`container-approval-stop.spec.ts`, a real Claude turn) |
| Real stack, root terminal | Included in `test:agent:docker`; start the profile with `--fixture-network full` for the full-network half | **New root terminal**: uid 0, outbound access by network mode (`container-root-terminal.spec.ts`) |
| Real stack, terminal close | Included in `test:agent:docker`; any Docker fixture profile, no agent or login | Closing a container terminal ends its shell and its job in the container, and removes the shell's PID record (`container-terminal-close.spec.ts`, to-do 7081, retired 2026-11-10; see [Terminal close](../architecture/container-lifecycle.md#terminal-close)) |
| Real stack, local | `mise run test:agent:browser:isolated` | C30 |
| Provider resume | `scripts/qualify-session-resume.sh <profile> <agent> [environment-name]` | C13 |
| OpenCode seeded data | `container-live-data-contracts.test.ts` (also `scripts/qualify-opencode-seeded-data.sh <image>`) | Real OpenCode turns, diff, revert and unrevert with and without host seeds on both database paths. Active console accounts in SQLite must retrieve provider configuration using their bearer token and selected organization from a local console fixture. Inotify checks the omitted host paths; no external credentials or billing. |
| Volume copy metadata | `container-live-data-contracts.test.ts` | Production `copy-volume` between real Docker volumes with a read-only source; compare raw `user.*` file/directory attributes and `security.capability` bytes before and after. Missing xattr or setcap support fails qualification. |
| Registry | `scripts/measure-registry-image.sh [--transfer <platform>] [--dind <platform>] [--json <file>] <image-ref>` | Compressed manifest and layer bytes, blob transfer time, cold pull |
| Upgrade and rollback | `bun scripts/qualify-backend-upgrade-rollback.ts [--old-ref <ref>] [--floor-ref <ref>] [--main-ref <ref>] [--report <file>]` | Backend upgrade over an older release's data and containers; the floor's refusal of a newer directory |
| Real stack, terminal Claude | The Docker profile above started with `--credential-source claude`, then `ORKESTRATOR_AGENT_TEST_PROFILE=<p> ORKESTRATOR_AGENT_TEST_LIVE_CLAUDE_TERMINAL=1 mise run test:agent:docker`. With no login and no billed turn: start the profile with `--no-agent-credentials --agent-platforms claude` and set `ORKESTRATOR_AGENT_TEST_FAKE_CLAUDE_API=1` instead, which points the image's `claude` at a fixture Messages API on the container's loopback (`container-fake-claude-api.ts`) | A real `claude` turn in a **Claude CLI** tab, foreground and background: the Claude state signal's working and waiting latency against the activity and completion budgets, no missed ring, no bypass-consent or auto-mode offer, and nothing of the tab left in the container after close (`container-claude-terminal-signal.spec.ts`). The containers must reach the profile's agent tools port: a Linux host firewall that drops it fails the spec at its first check, naming the port; start the profile with `--agent-tools-port` in the range one firewall rule admits ([agent-testing.md](agent-testing.md#containers-behind-a-host-firewall---agent-tools-port), [7080](../todo/containers-and-environments/7080-linux-host-firewall-blocks-profile-signals.md)) |
| Real stack, Claude read-only Multi Review | A Docker profile started with `--no-agent-credentials --agent-platforms claude`, then `ORKESTRATOR_AGENT_TEST_PROFILE=<p> ORKESTRATOR_AGENT_TEST_FAKE_CLAUDE_REVIEW=1 mise run test:agent:docker`. No login and no billed turn: the image's `claude` answers from a scripted Messages API on the container's loopback (`container-fake-claude-review-api.ts`), staged as Claude managed settings because read-only turns load no settings files. On a host whose firewall drops container traffic to the profile, run the profile on `mise run docker:disposable -- start --host-loopback` (its `DOCKER_HOST` exported for both the profile and the spec) | A two-reviewer Multi Review with Claude reviewers and a Claude consolidation, every read-only turn without the CLI's command sandbox (the image ships neither bubblewrap nor socat): the review settles `ready`; reviewers and consolidation carry the sandbox-off note in the snapshot and the inspector, worded for a container; `ls` runs, the package's `diffCommand` and a write are refused by the hook, the reviewers read the sealed diff file instead, and that file matches `diffCommand`'s output (`container-multi-review-read-only.spec.ts`, to-do [0190](../todo/agent-engines/0190-claude-read-only-turns-without-working-sandbox.md)). Passed on beelink on 2026-11-10 in 51 s |
| Linux Engine, CI | `.github/workflows/container-live-qualification.yml` (weekly, on demand, and on pull requests that change the suites, the signal scripts or the benchmark harness) | Every live suite on `ubuntu-24.04` and `ubuntu-24.04-arm`, both container change-signal live tests, the design export test (`export-container.test.ts`), the exec-cost script, then the benchmarks (C28); the numbers are uploaded as `container-benchmarks-<platform>` |
| Egress gateway prototype | `scripts/qualify-egress-gateway.sh [image]` | The 2026-10-22 prototype of the gateway topology; the backend's own gateway is covered by the live firewall, network, readiness and replacement suites above |

`test:logged` kills a command that prints nothing for 300 s, and Bun prints
a test's output only when the test finishes, so run the readiness and
rebuild-fault suites with `ORKESTRATOR_TEST_NO_PROGRESS_TIMEOUT_MS=2400000`.
Set `ORKESTRATOR_QUALIFICATION_EVIDENCE=<file>` to keep the rebuild-fault
suite's per-scenario observations as JSON lines (no contents), since a
passing logged run deletes its output.

The image must carry a manifest (`mise run docker:build` or
`docker/build.sh <tag>`). The network and firewall suites need outbound
internet access; each file's header names the hosts. Before a real-stack
Docker run, rebuild the profile image with `mise run docker:build:dev
--profile <p>` if it already existed and recreate fixture runtimes so they use
it. Stop and reset the profile afterwards; `mise run dev:reset` also removes
the profile's exact-owner volumes and networks. Profile handling is in
[agent-testing.md](agent-testing.md).

`qualify-session-resume.sh` plants a codeword in a session, rebuilds the
environment onto a new runtime generation and checks the resumed session
repeats it: exit 0 pass, 1 fail, 2 setup error. A provider that passes is
added to `RESUME_QUALIFIED_PROVIDERS` (`container-replacement.ts`); until then
the rebuild preview marks its resume unverified. `QUALIFY_MODEL` and
`QUALIFY_REASONING` pick a model the login accepts (Codex and Pi defaults are
refused for a ChatGPT-account login), `QUALIFY_REQUEST_TIMEOUT` (default
`5m`) covers a slow provider start, and `QUALIFY_AMBIGUOUS=1` adds a pass in
which a prompt whose outcome is unknown must stay parked and unsent across
the rebuild.

`measure-registry-image.sh` reads sizes from the manifests alone, and
optionally times every layer blob through the registry API or a cold `docker
pull` into a throwaway, labelled `docker:dind` with its own empty volume; it
never touches the local Docker cache. `qualify-backend-upgrade-rollback.ts`
runs each release's own headless backend from a detached worktree over one
private data directory (agent-test flavour, no credentials), snapshots files,
store rows, lifecycle records and owned Docker resources, and removes exactly
what it created.

`qualify-egress-gateway.sh` starts a gateway container that owns a network
namespace and runs the working tree's `init-firewall.sh` with `NET_ADMIN`,
joins a workload to it with no added capability, and checks policy 3
egress, root tampering, live edits, published and host-service ports, and
restarts of either side: exit 0 pass, 1 fail, 2 setup error. It predates the
backend's gateway (`egress-gateway.ts`) and records the policy itself rather
than using the image's `orkestrator-egress-gateway` entrypoint; the live suites
exercise the production path.

Live tests start runtimes through `tests/container-live-start.ts`
(`startRuntime`): Docker refuses a runtime whose egress gateway is not
running, so a bare `docker start` of a restricted runtime fails on a gateway
image.

### Disposable Docker daemon

Live suites that need free address pools, or that restart the daemon, run on
a private daemon that one command starts and one command removes
(`scripts/disposable-docker-daemon.ts`, to-do
4730, retired 2026-11-10).
It has two modes behind the same commands: a host rootless daemon (the
default, below) and a nested rootful one (`--mode rootful`, see
[Nested rootful mode](#nested-rootful-mode)).

```bash
mise run docker:disposable -- start --name q1 --image <image>
eval "$(mise run docker:disposable -- env --name q1)"
RUN_LIVE_DOCKER_TESTS=1 ORKESTRATOR_QUALIFICATION_IMAGE=<image> \
  mise run test:logged -- --name <suite> -- bun test --cwd apps/backend \
  --preload ../../tests/setup-node.ts ./tests/<suite>.test.ts --parallel=1
mise run docker:disposable -- stop --name q1
```

`start` prints `DOCKER_HOST`, `ORKESTRATOR_DISPOSABLE_DOCKER_MODE`
(`rootless` or `rootful`), `ORKESTRATOR_LIVE_ROOTLESS_HOST_LOOPBACK`,
`ORKESTRATOR_DISPOSABLE_DOCKER_SHARED_DIR` (rootful only) and
`ORKESTRATOR_LIVE_DAEMON_RESTART_COMMAND` as `export` lines (`--json` for a
document); `env` prints them again for a running instance, `status` lists
instances, and `load-image --name <n> <reference>` copies another image in.
Options: `--net slirp4netns` (default), `gvisor-tap-vsock`, `pasta` or
`vpnkit`; `--host-loopback` to let containers reach the host's loopback
(off by default, as in RootlessKit); `--address-pool`
(default `172.30.0.0/16` as /24s, which exists only in the daemon's own
namespace); `--storage containerd` (default, Engine 29's containerd image
store) or `overlay2` (the classic graph driver, `containerd-snapshotter`
off), in either mode, to compare a daemon behaviour across image stores.

The rootless mode rejects `--live-restore`: restarting its whole RootlessKit
tree cannot preserve shim and network state safely (the rootful mode accepts
it). Restart accepts no daemon
settings overrides; choose settings at start. Lifecycle and tool publication
use separate interprocess `flock` locks (a host prerequisite). Exported suite
variables clear Docker context and TLS selection so the private socket wins.

- **What it runs.** The host's own `dockerd`, `containerd` and `runc` under
  RootlessKit, through `dockerd-rootless.sh`. RootlessKit and
  `dockerd-rootless.sh` come from Docker's static rootless extras 29.9.2 and
  slirp4netns from its 1.3.3 release, downloaded once into
  `output/disposable-docker/tools/` and checked against pinned SHA-256
  digests before anything is unpacked or run. Host prerequisites, which
  `start` checks and names: an unprivileged user, `newuidmap` and
  `newgidmap`, ranges for the user in `/etc/subuid` and `/etc/subgid`,
  unprivileged user namespaces, and `/dev/net/tun`.
- **What it owns.** The instance directory
  `output/disposable-docker/<name>/` (git-ignored) holds the record, the
  `daemon.json`, the log, a private `HOME` and the data root. A short
  runtime directory, `$TMPDIR/ork-ddd-<uid>-<name>/`, holds the socket
  (mode `0700` directory: access to it is root-equivalent over that daemon),
  the exec root, the pid file and RootlessKit's state, and is the daemon's
  `XDG_RUNTIME_DIR`. The caller's `DOCKER_HOST`, `~/.config/docker` and the
  user's own rootless daemon are never read. The daemon's systemd cgroup
  driver creates each container's transient scope in the user's own systemd
  manager over the session bus; those scopes go when the containers stop.
- **What it never touches.** The host's Docker daemon is only read, by
  `docker save` of an image the caller names; its tags are left alone, and
  `orkestrator-v2:latest` is refused. Bridges, iptables rules and pools live
  in RootlessKit's network namespace, so the host's firewall, routes and
  interfaces are unchanged. Nothing runs as root.
- **Images.** `--image` and `load-image` stream `docker save <reference>`
  from the caller's daemon into `docker load` on the instance and check that
  the image id matches, or, when the two daemons use different image stores
  (the containerd store's id is the manifest digest, overlay2's the config
  digest), that the layer digests, creation time and architecture do. A
  5.45 GB environment image took about 100 s on beelink.
- **Restart.** `restart` stops the whole RootlessKit tree and starts it
  again on the same data root, so the daemon, RootlessKit, its network
  namespace and slirp4netns are all new: a real rootless daemon restart.
  It is the command printed as `ORKESTRATOR_LIVE_DAEMON_RESTART_COMMAND`,
  and it works from a test runner's private `TMPDIR` because the record
  keeps the runtime directory it started with.
- **Stop and leftovers.** A process is signalled only after its identity is
  confirmed: the start time recorded at spawn and an instance marker in its
  environment that only the launcher sets, which every process the daemon
  starts inherits. `stop` sends SIGTERM to RootlessKit, then SIGKILL to
  anything still carrying the marker, and removes the runtime and instance
  directories; files owned by subordinate ids are removed inside a
  RootlessKit user namespace. Removal refuses any path outside the instance
  root or the temporary directory, and any symbolic link. `start` first
  removes instances whose daemon is no longer running, and nothing else.
- **Not covered by it.** C22 cases that need the outer host as their
  service host cannot pass on a daemon that refuses host loopback; start
  one with `--host-loopback` for those.

#### Nested rootful mode

`--mode rootful` starts the recipe the 2026-10-31 and 2026-11-06 rootful runs
built by hand, as a repository command
(`scripts/disposable-docker-daemon-nested.ts`):

```bash
mise run docker:disposable -- start --mode rootful --name r1 --image <image> [--ipv6] [--live-restore]
eval "$(mise run docker:disposable -- env --name r1)"
# run suites as above; ORKESTRATOR_LIVE_DAEMON_RESTART_COMMAND restarts the inner dockerd
mise run docker:disposable -- stop --name r1
```

- **What it runs.** `docker:29.9.3-dind`, pinned by its multi-architecture
  index digest, in one privileged container on the **outer daemon**:
  `--outer-host unix://...`, else the caller's `DOCKER_HOST`, else the
  current context's endpoint. The outer daemon must be a local Linux Engine
  reached through a Unix socket (bind mounts are paths on this machine);
  Docker Desktop and TCP or SSH endpoints are refused. The container joins
  the outer default bridge, so the outer daemon needs no free address pool
  and no network is created on it; nothing is published. A supervisor loop
  runs `dind dockerd` and starts it again whenever it exits, writing a
  generation number into the runtime directory each time.
- **The inner daemon.** Its own data volume (`/var/lib/docker`), its socket in
  the instance's `0700` runtime directory (`$TMPDIR/ork-ddd-<uid>-<name>/`,
  bind-mounted, socket group set to the caller's gid), `bip` `10.213.0.1/24`,
  the `--address-pool` (default `172.30.0.0/16` as /24s) and `live-restore`
  off unless `--live-restore`. `--ipv6` adds the pool `2001:db8:100::/56` and
  turns IPv6 on by default for new bridge networks, as the 2026-10-31 IPv6
  case needs. Its bridges and iptables rules live in the container's network
  namespace, never the host's.
- **Shared directory.** `output/disposable-docker/<name>/share/` is mounted at
  the same path inside the container and printed as
  `ORKESTRATOR_DISPOSABLE_DOCKER_SHARED_DIR`. Suites that bind-mount
  temporary files (readiness C09, C10) need `TMPDIR` there, because the inner
  daemon resolves bind sources inside its container.
- **What it makes on the outer daemon.** The pinned dind image when it was
  missing (recorded as pulled), one volume and one container, each named
  `ork-ddd-<uid>-<name>-<marker>` and labelled
  `orkestrator-disposable-docker=<marker>`, a random marker only this
  instance's record holds. The outer daemon is never restarted, configured
  or pruned, and its tags are left alone.
- **Restart.** `restart` sends SIGTERM to the inner `dockerd` through
  `docker exec` (a pid in the container's own namespace), waits for the next
  generation and for its socket to answer. With `live-restore` off the inner
  containers stop, as on a host daemon restart. The outer daemon is the one
  recorded at start, so the command works from a suite whose `DOCKER_HOST`
  selects the inner daemon.
- **Stop.** Nothing is removed until its marker label is read back and
  matches. `stop` removes the container (which ends every inner process), then
  files the user cannot delete in the runtime and shared directories through
  a throwaway `--network none` container of the same image, then the volume,
  then the dind image if this instance pulled it and nothing else uses it,
  then the instance and runtime directories. If the outer daemon does not
  answer, `stop` fails and keeps the record, and `start`'s reaping leaves
  that instance for a later `stop` rather than guess.
- **Images.** `--image` and `load-image` copy from the recorded outer daemon,
  whatever `DOCKER_HOST` says at the time.
- **Prerequisites.** Linux, `docker` and `flock` on PATH, and access to the
  outer daemon's socket. The host's rootless prerequisites are not needed.
- **On a rootless outer daemon.** It works, but the nested daemon is then
  root only inside the outer daemon's user namespace; `start` says so and the
  record keeps `outerRootless: true`. Such a run proves the launcher and
  rootful `dockerd` behaviour, not a privileged container on a rootful host.

`tests/unit/disposable-docker-daemon.test.ts` covers the arguments, the
private paths and environment, the removal boundaries and a start, restart
and stop of a stand-in process tree, with no Docker. The cases that spawn or
inspect processes read `/proc`, so they run only on Linux and skip elsewhere.
`tests/unit/disposable-docker-daemon-nested.test.ts` covers the rootful mode
against a fake Docker CLI: the run arguments and inner configuration, outer
daemon selection, a start, restart and stop with exactly what was made
removed, the pulled-image rule, root-owned leftovers, a forged marker and an
unreachable outer daemon.

## Linux Engine CI results and Docker daemon restarts (2026-11-11)

The last two tasks of to-do 0019 (retired 2026-11-11; its earlier evidence
record is in Git history,
`git show 498b68766:docs/todo/containers-and-environments/0019-container-platform-qualification.md`):
recording the Linux Engine CI results (task 1) and a daemon-wide Docker
restart during a launch and during a rebuild copy (task 5). Run in worktree
`orkestrator-v2-20261111-021056-7529cd0810ee` at `main` `498b68766` plus
this change, on beelink.

### Linux Engine CI (task 1)

Read on 2026-11-11 from the public GitHub Actions API without signing in
(run, job and step results and the check-run annotations). Step logs and
artefact downloads need a signed-in client, so these runs' image digests,
Engine version and benchmark reports were not read; the 2026-10-26 runs
reported Engine 28.0.4, and the benchmark numbers through run 40746551838
are in [Benchmarks on Linux Engine CI](#benchmarks-on-linux-engine-ci-and-the-call-and-start-time-misses-2026-10-28).
Every run below covers `ubuntu-24.04` (linux-x64) and `ubuntu-24.04-arm`
(linux-arm64), with the same result on both.

| Run | Event, commit | Date | Result |
| --- | --- | --- | --- |
| 40304582303 | weekly, `main` `f1223e0bb` | 2026-10-26 | Only "Live lifecycle" failed: C20 found no `~/.codex/auth.json` because the runner's uid is not 1000; fixed by the staged-input relay (to-do 0109, retired) |
| 41443896856 | weekly, `main` `7f094c21a` | 2026-11-02 | Only "Live staged mount consumers" failed: `staged-input-relay-docker.test.ts:64`, the test's own mount list lacked `agents-skills`, which the entrypoint had declared since #1589. The list was updated in `6ae99a3ed` (#1670, 2026-11-03) |
| 42620164217 | weekly, `main` `448e9fffb` | 2026-11-09 | Every step passed except "Live build pipeline code rewind": `build-pipeline-code-rewind-docker.test.ts:514` expected the backlog move without `preserveDoneStatus: true`, which the pipeline had started sending. The expectation was updated in `1e491c075` (#2004), merged the same day after this run |
| 42914911207 | pull request #2105, a merge of `main` (merged as `85732c93e`) | 2026-11-10 | **Every step passed**, all 30 live steps and the benchmarks, on both architectures |

- **C14 on any host uid.** "Live replacement (C14-C19)" passed on both
  architectures in 42620164217 and 42914911207, the green CI run to-do 0728
  waited for (retired 2026-11-11; its fix is recorded in
  [C14 staged inputs on any host uid](#c14-staged-inputs-on-any-host-uid-linux-engine-2026-10-28)).
- **C22 host-level reachability verdict: pass.** macOS reports host-level
  reachability as not applicable; on Linux Engine it is a real result.
  "Live network (C22, C24, C26)" passed on both architectures in
  42620164217 and 42914911207. The C22 case asserts that the backend's own
  host discovery reports `reachable`, that exactly the agent-tools service
  port leaves a restricted runtime for `host.docker.internal`, and that
  another host port and a sibling's published port are refused (curl exit 7).
  "Live rootful host reach without a host firewall" passed in the same runs.
- Neither red weekly run was a product failure: both were test
  expectations that had fallen behind a change made elsewhere, and both are
  fixed on `main`.

### Docker daemon restart during launch and rebuild copy (task 5)

Two scenarios, each run only when `ORKESTRATOR_LIVE_DAEMON_RESTART_COMMAND`
names a command that restarts the suite's daemon (never point it at a
shared daemon):

- `container-live-readiness.test.ts`, "C09/readiness: a Docker daemon
  restart during launch never releases the previous boot": a launch is held
  before `ready` (the held-boot image), the whole daemon restarts, and the
  launch must either wait for the boot that survived or be refused, typed and
  retryable, with nothing dispatched; an explicit retry then reaches
  `ready` on a new boot.
- `container-live-rebuild-faults.test.ts`, "C15 Docker daemon restart
  during the rebuild copy": a preserving rebuild of a volume-backed
  environment with a 3 GiB workspace file
  (`ORKESTRATOR_LIVE_RESTART_COPY_MIB` lowers it) restarts the daemon the
  moment a copy helper is running. Nothing may commit, the failure must name
  the outage, the original stays authoritative with its files, Git state and
  provider databases intact, the `--rm` helper must not outlive the restart,
  a kept candidate set is listed, not restorable and discards cleanly, and a
  second rebuild once Docker is back must succeed with the same files.

```bash
mise run docker:disposable -- start --mode rootful --name q19r --image <image>   # also --live-restore, and the rootless default
eval "$(mise run docker:disposable -- env --name q19r)"
export TMPDIR=$ORKESTRATOR_DISPOSABLE_DOCKER_SHARED_DIR/tmp   # rootless: a directory without nosuid/nodev
RUN_LIVE_DOCKER_TESTS=1 ORKESTRATOR_QUALIFICATION_IMAGE=<image> ORKESTRATOR_QUALIFICATION_EVIDENCE=<file> \
  mise run test:logged -- --name daemon-restart -- bun test --cwd apps/backend \
  --preload ../../tests/setup-node.ts ./tests/container-live-readiness.test.ts --parallel=1 \
  --test-name-pattern 'Docker daemon restart'
# the same with ./tests/container-live-rebuild-faults.test.ts
mise run docker:disposable -- stop --name q19r
```

Image `orkestrator-v2:qual-0019-498b6876` (`sha256:cf14de85…`, built with
`docker/build.sh` from this worktree). Daemons: `docker:disposable`'s nested
rootful daemon (`docker:29.9.3-dind`) with `live-restore` off and, as a
second instance, on; and its rootless daemon (Docker 29.9.2 under
RootlessKit, slirp4netns, `live-restore` off), all on beelink (Linux
7.1.8, x86_64). Observations come from each scenario's evidence line.

| Daemon | Launch restart | Rebuild-copy restart |
| --- | --- | --- |
| Rootful, `live-restore` off | Pass (three times; the restart took 2.8, 3.7 and, in the whole-file run with earlier scenarios' containers still running, 12.9 s). The restart stopped the held container; the launch was refused `not-ready` `failed:container-exited`, nothing launched, and the retry reached `ready` on a new boot | Pass (three times). The restart (1.8–3.4 s) landed 0.3–0.4 s into a copy that took 14.5–18.9 s undisturbed, with `copy-volume /source /storage/workspace` running; the rebuild failed `daemon-unavailable` before `verified`, the helper was gone after the restart, one failed-candidate set was kept and discarded, and the retry rebuilt with identical files |
| Rootful, `live-restore` on | Pass. Before the fix below the launch was refused as `container-exited` although the container and its boot kept running; after it, the launch waited through the restart (3.1 s) and became ready on the boot that survived, with exactly one agent launch | Pass. The restart (7.7 s) landed 0.6 s into a 14.6 s copy; `daemon-unavailable`, nothing committed; the helper kept running past the restart and was gone shortly after; failed candidate discarded, retry identical |
| Rootless | Pass. Restart 3.7 s; refused `failed:container-exited`, retry ready on a new boot | Pass on the second attempt. The restart (2.8 s) landed 0.4 s into a 5.9 s copy; `daemon-unavailable`, nothing committed, helper gone, failed candidate discarded, retry identical. The first attempt never reached the restart: the setup's legacy migration hung in a `copy-stream` helper whose input never ended, 46 s after the launch scenario had restarted this daemon twice; recorded in [7705](../todo/containers-and-environments/7705-rootless-copy-stream-stdin-never-closes.md) |

**Found and fixed: a daemon outage read as an exited container.** The
readiness wait asks `docker inspect` whether a container it cannot reach is
still running, and it took a failed `inspect` to mean "not running". During
a daemon restart that turned an unreachable daemon into a `container-exited`
refusal even when the container never stopped (`live-restore`), so a launch
that would have become ready a few seconds later had to be retried by hand.
`containerRunState` (`container-readiness.ts`) now reports an unanswered
daemon (the CLI's "cannot connect" wording, or a timeout) as unknown, and the
wait keeps polling until its deadline; a failed `inspect` for any other
reason (a container that no longer exists) still reads as exited. Unit
tests in `container-readiness.test.ts` cover a daemon that returns, one that
never does (a `timed-out` refusal, never `container-exited`), and an
`inspect` that hangs past its timeout; the first and last fail without the
fix.

**CI.** `container-live-qualification.yml` gains two last steps, "Live
Docker daemon restart during launch (C09)" and "... during rebuild copy
(C15)", one per scenario so a failure in one still reports the other. They run
the scenarios with
`ORKESTRATOR_LIVE_DAEMON_RESTART_COMMAND="sudo systemctl restart docker"`
(the runner's own daemon, `live-restore` off) and a 1 GiB copy, so the
restart is qualified weekly on both architectures. They run after every other
step so no other suite shares a restarted daemon. Their first run is this
change's pull request; they had not run when this was written.

**Also run.** The whole readiness file on the rootful daemon: 9/10, the
tenth being the C22 host-service reply, which reports itself INCOMPLETE
because beelink's host firewall closes the agent-tools path from the nested
daemon's containers (see the disposable daemon's "Not covered by it" above
and [7080](../todo/containers-and-environments/7080-linux-host-firewall-blocks-profile-signals.md)).
The whole rebuild-fault file on the rootful daemon: 6/6.

**Not covered.** A Docker Desktop quit (the macOS VM going away) during a
launch and a rebuild copy: it needs a Mac whose Desktop nothing else is
using, and is an item in the
[manual-test checklist](../todo/manual-test/7568-manual-test-checklist.md)
("0019 (retired) task 5"). The gateway's own daemon-restart case is the
[live egress conditions](#suites) suite's, which CI still runs without a
restart command.

## Benchmarks on a saturated host (2026-11-11)

To-do 0022 (retired 2026-11-11) task 5 asked whether the 5,000-file copy
still meets its target, the condition for building an
[in-process tar hasher](#optimisations-measured-and-not-taken). The baseline
case (`container-benchmarks.test.ts -t "fresh environment, warm stop"`) ran
once on beelink (16 CPUs, Docker Engine 29.9.2 rootful) with image
`orkestrator-v2:dev-3f9489ce4342` (`main` at `498b6876`), under the built-in
default (applied: no CPU cap, 8 GiB, 4,096 PIDs), Docker through
`apps/desktop/scripts/dev/docker-qualification-bin`. Other builds saturated
the host throughout: load average 56 at the start and 44–49 at the end, on
a daemon shared with other worktrees' containers. beelink is not the
reference host, so these numbers do not gate anything; they are recorded
because they are the nearest the copy has come to its condition.

| Measure | Target | Median (min–max) |
| --- | --- | --- |
| Fresh restricted environment to ready | ≤ 3 s | **8.94 s** (7.80–13.25 s): storage 1.44 s, create 1.02 s, gateway 2.39 s, runtime start 0.27 s, ready 2.49 s |
| Incomplete fresh boots | none | none |
| Docker calls per fresh environment | ≤ 27 | 19 (18–25) |
| Three concurrent, slowdown | ≤ 1.5× | 1.02× |
| Warm stop | ≤ 1 s | 0.47 s |
| Warm start | ≤ 2 s | **2.04 s** (1.91–2.21 s) |
| Rebuild copy and verify, 5,000 files | ≤ 20 s | **30.7 s** (30.4–31.3 s, n = 3); whole rebuild 40.9 s |
| Rebuild copy and verify, 200 files | — | 2.9 s (n = 5) |
| Docker calls per minute, view open | ≤ 36 | 24 |
| Log followers after the idle grace | 0 | 0 |

Every timed step slowed, not only the copy: fresh boots took about three
times their target with the same 19 calls, and the copy ran at about 6.1 ms
per file against 2.6–2.9 ms on the 4-CPU CI runners (2026-10-26). The copy's
source side runs one `sha256sum` per tar member, 5,000 short-lived processes,
which is the work a saturated host slows most, so this run is consistent with
host contention rather than a regression. The condition for the hasher is
unchanged (a miss on the reference host or the CI runners), and the weekly
Linux Engine CI run is the next comparison.

## UI response under multi-environment load, second busy-host run (2026-11-11)

To-do 0022 (retired 2026-11-11) task 3, with the
[probe](#ui-response-under-multi-environment-load) at `498b6876` and default
options, after the [first run](#ui-response-under-multi-environment-load-first-run-on-a-busy-host-2026-11-01).
Like that run it is a sample of a busy shared host, not a reference figure;
a run on a quiet reference host is item "0022 (retired) task 3" in the
[manual-test checklist](../todo/manual-test/7568-manual-test-checklist.md).

- **Host:** beelink (Arch Linux, kernel 7.1.8, x86_64, 16 CPUs, 62 GiB),
  Docker Engine 29.9.2 rootful. Other builds rose through the run: the load
  average was 36.5, 44.6 and 57.7 at the three phase starts, and the host CPU
  was 96.3–99.6% busy. Unlike the first run, the daemon was shared: 15–22
  containers were running, of which 10 were this profile's.
- **Image and profile:** `orkestrator-v2:dev-3f9489ce4342`, built from this
  commit (so with the [stop fix](#stop-attribution-the-drain-waited-on-interactive-shells-2026-11-02)).
  `dev:test --fixture-environments container --no-agent-credentials
  --agent-platforms claude --headless` with
  `ORKESTRATOR_HOST_REACHABILITY_CHECK=off`, Docker through
  `apps/desktop/scripts/dev/docker-qualification-bin`. Three busy
  environments, one target and the fixture container, all restricted and
  under the built-in default (applied: no CPU cap, 8 GiB, 4,096 PIDs). No
  provider turns.
- **Load:** each busy container used 158–176% CPU in the busy phase and
  0–11% in the idle phases.

Medians with p95 in brackets, in milliseconds unless stated:

| Measure | Idle 1 | Busy | Idle 2 |
| --- | --- | --- | --- |
| Row selected and painted | 7.0 (12.4) | 9.0 (12.9) | 9.3 (15.8) |
| `<main>` settled after a switch | 261 (367) | 504 (959) | 270 (413) |
| Frame interval; stalls over 50 ms | 16.7 (16.8), max 33.3; 0 | 16.7 (16.8), max 83.3; 3 | 16.7 (16.8), max 66.7; 2 |
| Long tasks | 0 | 1 (58 ms) | 2 (153 ms in all) |
| Timer lag (250 ms timer) | 0.2 (2.6) | 0.7 (15.1) | 0.9 (12.7) |
| `get_environments` round trip | 7.1 (23.0) | 14.9 (73.6) | 11.5 (51.1) |
| `stop_environment` round trip | 1.43 s (1.57 s) | 1.93 s (2.38 s) | 1.42 s (1.58 s) |
| `start_environment` round trip | 5.3 s (5.5 s) | 6.1 s (6.3 s) | 5.5 s (8.1 s) |
| Sidebar after the stop reply | 64 (71) | 72 (97) | 69 (80) |
| Sidebar after the start reply | 2 (55) | 50 (116) | −22 (84) |

The first visit to each environment: selected in 11.5 ms and settled in
148 ms (medians of 4). There were no failures, missed signals or renderer
reloads. The one dialog dismissed was "Claude Code Is Not Logged In". It
opened after the environments were created, past the probe's startup check,
and its overlay swallowed the first switch's clicks. The probe now dismisses
any open dialog again before its first click and at each phase start, and
reports it as before.

What the two runs show:

- **Stops are fixed in the real stack.** `stop_environment` from the page
  took 1.3–2.4 s in every phase, against 10.5–11.6 s on 2026-11-01. That
  confirms [2150](../todo/containers-and-environments/2150-container-environment-stop-takes-ten-seconds.md)'s
  drain change through the gateway and the page.
- **The renderer holds up.** Selection painted within a frame in every phase
  of both runs. This run had a few stalls and long tasks, as many in the
  second idle phase as in the busy one, while the host load kept rising, so
  they follow the host rather than the containers.
- **The backend's busy-phase slowdown recurs but is not attributed.**
  `get_environments` rose 1.3–2.1× against the idle phases (1.4–1.5× on
  2026-11-01) and `start_environment` 1.10–1.13× (1.24–1.27×). Both runs had
  a saturated host, and this one shared its daemon, so neither separates the
  containers' cost from the other builds'. `<main>` settle times also roughly
  doubled in the busy phase this time, where the first run's idle phases
  differed more than idle and busy did.

## Egress gateway on Linux Engine: qualification closed (2026-11-11)

To-do 0018 (retired 2026-11-11) task 1 asked for the egress gateway to be
qualified on rootful Linux Engine, amd64 and arm64. It is closed on the
evidence already recorded in this guide, with no new run:

- **amd64:** the self-managed rootful run on beelink
  ([Egress name checks on rootful Linux Engine](#egress-name-checks-on-rootful-linux-engine-2026-11-06)),
  the gateway conditions on a disposable rootful daemon
  ([Egress gateway conditions on Linux Engine](#egress-gateway-conditions-on-linux-engine-2026-10-31)),
  and the hosted `ubuntu-24.04` runner below.
- **arm64:** the hosted `ubuntu-24.04-arm` runner (Engine 28.0.4). Runs
  40338400817 (`e8306626`, 2026-10-26) and 40999226305 (`79c35c0b`,
  2026-10-30) passed replacement, network 4/4, firewall 2/2 (tamper refusals
  and gateway restart) and readiness 9/9 behind the gateway, and run
  42128741746's arm64 job passed M12, network 4/4 and readiness 9/9 (its two
  failures were the test defects fixed with it). Docker Desktop on Apple
  Silicon, which runs a Linux arm64 kernel, passed the production gateway
  path on 2026-10-25
  ([Egress gateway on Docker Desktop](#egress-gateway-on-docker-desktop-2026-10-25)).
- **Rootless:** the daemon restart and gateway suites on a disposable
  rootless daemon
  ([Rootless daemon restart on a disposable daemon](#rootless-daemon-restart-on-a-disposable-daemon-2026-11-06),
  [Rollout-cap retirement review qualification](#rollout-cap-retirement-review-qualification-2026-11-04));
  the remaining rootless settings and rootless arm64 are
  [7390](../todo/containers-and-environments/7390-rootless-restart-remaining-settings.md).

Decision: the hosted arm64 runner counts as the arm64 Linux Engine
qualification. It runs the same suites, against an image built from the
branch, with exit statuses on record. A self-managed arm64 Linux host would
add a second kernel and Engine build but no check the hosted runner does not
already make, and no fleet machine offers one with a host daemon this work
may use. The C14 migration failure in run 40409285999 and the weekly run's
lifecycle failure are outside the gateway; they were tracked in to-dos 0728
and 0019 (both retired 2026-11-11; their outcome is under
[Linux Engine CI](#linux-engine-ci-task-1)).

## Egress name checks on rootless Docker (2026-11-10)

To-do [6101](../todo/containers-and-environments/6101-egress-name-checks-platform-coverage.md)
task 2: the gateway's name checks (`egress-filter=1`) on rootless Docker,
where the container network lives in RootlessKit's namespace. Run in
worktree `orkestrator-v2-20261110-012508-43321f71f84f` at `main`
`04639b12b` plus this change.

- **Host:** beelink (Arch Linux, kernel 7.1.8, x86_64, cgroup v2). The
  host's rootful Engine 29.9.2 was only read, for the images.
- **Daemons:** `mise run docker:disposable -- start` twice, each a host
  rootless Engine 29.9.2 (containerd v2.4.2, runc 1.5.2) under RootlessKit
  3.3.0 with `--detach-netns`, the builtin port driver, host loopback
  refused, `live-restore` off, the systemd cgroup driver and pool
  `172.30.0.0/16` as /24s:
  - `q6101r`: slirp4netns 1.3.3 (the default). Started with the image in
    47 s; the older image copied in 43 s.
  - `q6101g`: `--net gvisor-tap-vsock`, RootlessKit's built-in driver.
- **Image:** `orkestrator-v2:dev-8bff8877f7f8`
  (`sha256:afdb91660fa791fa89694d4588984cd222dd2df3c147fbfc72990026be328ab4`,
  6.04 GB, `2.37.3-beta`, source `53e936b37`), already on the host and
  copied in by id. Capabilities include `egress-gateway=1`,
  `egress-filter=1`, `network-policy=3` and `network-refresh=1`. Its
  `init-firewall.sh`, `update-firewall.sh`, `orkestrator-egress-gateway`,
  `orkestrator-egress-filter`, `firewall-domains.sh`, `entrypoint.sh` and
  `network-policy-entrypoint.sh` match the checkout byte for byte
  (SHA-256); `docker/` differs from `04639b12b` only in
  `orkestrator-bridge-launch.sh` and a log-writer test. Older image, read
  only: `ghcr.io/orkestrator-ai/orkestrator-v2:2.34.4-beta`
  (`egress-gateway=1`, no `egress-filter`), on `q6101r` only.

Each suite ran through `test:logged` with the variables from
`docker:disposable -- env`, `RUN_LIVE_DOCKER_TESTS=1`,
`ORKESTRATOR_HOST_REACHABILITY_CHECK=off`, `--parallel=1`, a JUnit report
kept, and `TMPDIR` on a directory on the home filesystem (btrfs), not the
`nosuid,nodev` `/tmp` ([7549](../todo/containers-and-environments/7549-rootless-docker-cp-refusals.md)).
GitHub's anonymous allowance stayed above 40 throughout.

| Daemon | Suite | Result |
| --- | --- | --- |
| slirp4netns | Live egress name checks (M12), with the older image | **6/6, 124 assertions**, 53.9 s, and again 55.7 s |
| gvisor-tap-vsock | Live egress name checks (M12) | **5 pass, 1 skip** (older image not loaded there), 109 assertions, 50.3 s |
| slirp4netns | Live egress conditions, `ORKESTRATOR_LIVE_IPV6_NETWORK=1` and the printed restart command | **3/3, 66 assertions**, 49.6 s: IPv6 4.8 s, DNS rotation 16.8 s, daemon restart 25.7 s (two rootless daemon restarts) |

- **The rootless questions.** Every M12 case passed in RootlessKit's
  namespace, so the three mechanisms the to-do asked about behave as on
  rootful Engine: the name-check daemon set `SO_MARK` on its sockets while
  the workload got `EPERM` as `node` and as root; the gateway's `nat` rules
  redirected TCP to allowed addresses to its own address and DNS to its
  resolver port, and `127.0.0.11:53` to the same port; and the relay found
  each connection's real destination through `SO_ORIGINAL_DST`. The
  headline cases: an allowed name answered 200, a foreign SNI on its
  address got `access denied`, the HTTP Host check refused a request before
  it reached the fixture, a name off the list got `REFUSED` with EDE 18
  over UDP, over TCP and sent to `192.0.2.53`, a killed daemon failed closed
  and came back on refresh, and a full-mode runtime was not filtered.
- **Topology recorded by the suite** (identical on both drivers apart from
  Docker's embedded resolver ports):

  ```json
  {"daemonRootless":true,
   "resolvers":["nameserver 127.0.0.11","# ExtServers: [host(127.0.0.53)]"],
   "nat":["-A OUTPUT -p tcp -m tcp ! --dport 53 -m mark ! --mark 0x6f726b -m set --match-set allowed-domains dst,dst -j DNAT --to-destination 172.30.1.3:31443",
          "-A OUTPUT -d 127.0.0.11/32 -p tcp -m tcp --dport 53 -m mark ! --mark 0x6f726b -j REDIRECT --to-ports 31453",
          "-A OUTPUT ! -d 127.0.0.0/8 -p tcp -m tcp --dport 53 -m mark ! --mark 0x6f726b -j DNAT --to-destination 172.30.1.3:31453",
          "-A OUTPUT -d 127.0.0.11/32 -p udp -m udp --dport 53 -m mark ! --mark 0x6f726b -j REDIRECT --to-ports 31453",
          "-A OUTPUT ! -d 127.0.0.0/8 -p udp -m udp --dport 53 -m mark ! --mark 0x6f726b -j DNAT --to-destination 172.30.1.3:31453",
          "-A DOCKER_OUTPUT -d 127.0.0.11/32 -p tcp -m tcp --dport 53 -j DNAT --to-destination 127.0.0.11:34675",
          "-A DOCKER_OUTPUT -d 127.0.0.11/32 -p udp -m udp --dport 53 -j DNAT --to-destination 127.0.0.11:36307"]}
  ```

  With `--detach-netns` the rootless daemon stays in the host's network
  namespace, so Docker names the host's stub resolver as `host(...)` and
  contacts it itself: the name checks used Docker's embedded resolver for
  every query, as on Docker Desktop. The addressed-upstream path (6101 task
  3) ran on rootless only through the suite's controlled-upstream case,
  which passed on both drivers.
- **Suite change.** The topology line above is new: the M12 suite's first
  case prints it and appends it to `ORKESTRATOR_QUALIFICATION_EVIDENCE` when
  set. It asserts nothing.
- **Cleanup.** Every suite's `afterAll` removed its labelled resources, and
  afterwards each daemon held no container, custom network or volume.
  `docker:disposable -- stop` took 3.9 s and 2.9 s and left no instance,
  runtime directory or `docker-*` user scope. Other builds' disposable
  daemons running on the host at the same time were not touched.
- **Not covered:** pasta (not installed on beelink; 6101 task 4), VPNKit,
  arm64, host loopback enabled, `live-restore` on, a real addressed upstream
  on rootless (the daemon here named its upstream through `host(...)`), and
  a rootless daemon restart on gvisor-tap-vsock
  ([7390](../todo/containers-and-environments/7390-rootless-restart-remaining-settings.md)).
  No provider turns, credentials or app profile were used.

## Agent-tools peer gate on nested rootful Linux Engine (2026-11-10)

To-do [6820](../todo/containers-and-environments/6820-agent-tools-peer-gate-linux-evidence.md)
task 1: `apps/backend/scripts/agent-tools-peer-evidence.ts` on a rootful
Linux daemon, through the launcher's [nested rootful mode](#nested-rootful-mode).

- **Host:** beelink (Omarchy, kernel 7.1.8, x86_64), host Engine 29.9.2,
  rootful, which this account may use. It was the outer daemon
  (`outerRootless: false`), so the dind container was privileged on a rootful
  host. The script's networks were created on the inner daemon only.
- **Daemon:** `start --mode rootful --name s6820rf` (12.9 s with the dind
  pull). Inner Engine 29.9.3, Alpine 3.24 (containerized), no `rootless`
  option, `bip` `10.213.0.1/24`, pool `172.30.0.0/16`, `INPUT` policy
  `ACCEPT`. The pinned busybox was pulled into it.
- **Runner:** the script ran in an `oven/bun:1.4.4` container on the outer
  daemon with `--network container:<dind container>`, so the server, the
  inner bridges and `host-gateway` shared one namespace as on a host. It ran
  as uid 1000 with the worktree mounted read-only, the instance's runtime
  directory (the inner socket) mounted, the qualification shim first on
  `PATH` and the dind image's static `docker` CLI behind it
  (`ORKESTRATOR_QUALIFICATION_DOCKER`). The exact command is in the to-do.
- **Result, twice, identical:** environment-network (`172.30.0.2`) and
  default-bridge (`10.213.0.2`) containers arrived from their own addresses,
  were admitted by subnet and got 405; the unowned network's `172.30.1.2` was
  refused (connection reset, no response). The environment-container probe
  and both host-check probes were `reachable`/405. The host's own addresses
  (`172.17.0.2` and the three bridge gateways) were closed with no bytes, each
  arriving from `172.17.0.2`. Admitted subnets `10.213.0.0/24` and
  `172.30.0.0/24`, then `10.213.0.0/24` after the environment network was
  removed. No leftovers; exit 0.
- **Cleanup:** `stop` removed the dind container, its volume, the runtime
  directory and the dind image it had pulled. The busybox and
  `oven/bun:1.4.4` images were already on the host and were left.

## Rootless budget read-back without `cpu` delegation (2026-11-10)

To-do 0019 (retired 2026-11-11)
task 2: on a rootless daemon whose user is delegated `memory pids` but not
`cpu`, does Docker's reported capacity match what the cgroup enforces, and
does the budget read-back stay truthful?

- **Why a container as the host.** The launcher's rootless daemon gets the
  delegation of the user manager it runs under, and beelink's
  `user@1000.service` delegates `cpu memory pids`. Changing that needs root
  and a user-manager restart that would end this user's sessions on a shared
  host, so a throwaway systemd host was built instead (the 0019 decision
  records the options).
- **The systemd host.** Built from this Dockerfile, with Docker's static
  `docker-29.9.2.tgz` (SHA-256
  `9ac225999fd5e863f7694c728ef23d480616b1e5639328fa309befd4243d69eb`,
  downloaded from `download.docker.com`) beside it in `dl/`:

  ```dockerfile
  FROM oven/bun:1.4.4
  RUN apt-get update \
   && apt-get install -y --no-install-recommends systemd systemd-sysv dbus dbus-user-session uidmap iproute2 iptables util-linux procps ca-certificates \
   && rm -rf /var/lib/apt/lists/*
  COPY dl/docker-29.9.2.tgz /tmp/docker.tgz
  RUN tar -xzf /tmp/docker.tgz -C /usr/local/bin --strip-components=1 --no-same-owner && rm /tmp/docker.tgz
  RUN echo 'bun:100000:65536' > /etc/subuid && echo 'bun:100000:65536' > /etc/subgid \
   && mkdir -p /etc/systemd/system/user@.service.d \
   && printf '[Service]\nDelegate=\nDelegate=memory pids\n' > /etc/systemd/system/user@.service.d/delegate.conf \
   && systemctl mask getty.target console-getty.service systemd-networkd-wait-online.service \
   && mkdir -p /var/lib/systemd/linger && touch /var/lib/systemd/linger/bun
  STOPSIGNAL SIGRTMIN+3
  ENTRYPOINT ["/sbin/init"]
  ```

  Run as `docker run -d --privileged --cgroupns=private --tmpfs /run --tmpfs
  /run/lock --tmpfs /tmp:exec,mode=1777 --tmpfs
  /home/bun/ddd:exec,uid=1000,gid=1000,size=2g -v "$PWD:$PWD:ro" -v
  "$PWD/output/disposable-docker/tools:/home/bun/ddd/tools:ro" <image>`
  (the tools are the launcher's verified download from a host start). The
  lingering `bun` user (uid 1000) gets `user@1000.service`; `user.slice`,
  `user-1000.slice` and `user@1000.service` all listed `memory pids` as
  their controllers. Three details mattered: `Delegate=` lists merge, so
  without the empty reset Debian's own `cpu` stayed delegated; RootlessKit's
  tap setup runs `ip`, so `iproute2` is required; and the data root must be
  on the tmpfs, since overlayfs refused an upper directory on the
  container's overlay root (`failed to mount ... overlay ... invalid argument`).
- **The daemon.** As `bun`, with `XDG_RUNTIME_DIR=/run/user/1000` and the
  user bus: `bun scripts/disposable-docker-daemon.ts start --name s0019md
  --root /home/bun/ddd`, then the pinned busybox pulled into it. `docker
  info`: Engine 29.9.2, cgroup v2, systemd driver, `rootless`; warnings for
  CPU CFS quota, period and shares, cpuset and every `io` axis.
- **The check.** `DOCKER_HOST=<its socket> bun
  apps/backend/scripts/rootless-budget-readback-evidence.ts`, then the same
  script against a `docker:disposable` rootless daemon started directly on
  beelink (`s0019rl`) as the control.

  | | `memory pids` delegated | `cpu memory pids` delegated (control) |
  | --- | --- | --- |
  | Production capacity (`cpuQuota`, `memoryLimit`, `pidsLimit`) | false, true, true | true, true, true |
  | Built-in default | 8192 MiB, 4096 PIDs, no CPU cap, nothing unenforced | same |
  | Admission of 64 MiB, 32 PIDs | accepted | accepted |
  | Admission of the same plus 0.5 CPU | refused, `unsupported-topology` (CPU) | accepted |
  | Container `cgroup.controllers` | `memory pids` | `cpu memory pids` |
  | `cpu.max` with no CPU limit | absent | `max 100000` |
  | `memory.max`, `memory.swap.max`, `pids.max` | 67108864, 0, 32 | same |
  | Inspect read-back and environment policy | `{ cpus: null, memoryMiB: 64, pids: 32 }`, `unsupported: []` | same |
  | 100 MiB held under 64 MiB | OOM-killed (`oom_kill` 2) | OOM-killed |
  | 40 forks under 32 PIDs | stopped, `pids.peak` 32, `max 1` | same |
  | CPU time of a 3 s busy loop | 2.97 s (no limit) | 2.94 s, and 1.51 s under 0.5 CPU |
  | `docker run --cpus 0.5` | refused by Docker: `NanoCPUs can not be set, as your kernel does not support CPU CFS scheduler or the cgroup is not mounted` | created, `cpu.max` `50000 100000`, read-back `cpus: 0.5` |

  The table is the fourth run on the `memory pids` daemon. The first ran
  before the data root moved to the tmpfs, so no container started; the next
  two had probe defects (busybox `sleep` as PID 1 left the PID probe's
  zombies holding the limit, and with `--init` the OOM kill stopped the
  shared container). The script now runs the CPU and PID probes in a
  container with `--init` and the memory probe in a separate one. Capacity,
  admission and Docker's CPU refusal were the same in all four runs, and the
  read-back the same in the three that created containers.
- **What this means.** Docker's report matched the cgroup on both daemons,
  and a CPU limit cannot reach a container where it would not be enforced,
  so the read-back cannot misreport one. No code change. Not covered: a
  host whose `user-<uid>.slice` exposes a controller its `user@<uid>.service`
  does not; both matched here.
- **Cleanup.** The inner daemon was stopped by its launcher, the systemd
  container and image removed, `s0019rl` stopped, and the tarball and tools
  cache deleted. The BuildKit cache of the image builds stays on the host
  daemon: removing it would take a prune, which the rules forbid. Evidence
  (git-ignored): `output/agent-testing/s0019/memory-pids.json` and
  `cpu-memory-pids-control.json`.

## Nested rootful disposable daemon on beelink2 (2026-11-09)

To-do 4730 (retired 2026-11-10)
task 1: the launcher's [nested rootful mode](#nested-rootful-mode), live.

- **Host:** beelink2 (Arch Linux, kernel 7.2.15, x86_64), host Engine 29.9.2.
  This user is not in the `docker` group, so the host daemon was neither
  used nor touched. The outer daemon was the launcher's own rootless one
  (`start --name outer`, slirp4netns, 3.1 s), so the nested daemon was root
  only inside that daemon's user namespace (`start` says so). A rootful
  host as the outer daemon is 4730 task 4, now in the
  [manual-test checklist](../todo/manual-test/7568-manual-test-checklist.md).
- **Image:** `ghcr.io/orkestrator-ai/orkestrator-v2:2.37.3-beta`, the
  published build of `480cf0296` (no `docker/` change between it and the
  tested branch), pulled into the outer daemon without credentials (3 min 8 s).
- **Start:** `start --mode rootful --image <image>` pulled
  `docker:29.9.3-dind` (by digest) into the outer daemon, ran it, and copied
  the 6.0 GB image in: 2 min 15 s. The inner daemon reported Engine 29.9.3
  with no `rootless` security option; an inner container got `10.213.0.2` on
  the inner default bridge and fetched `registry.npmjs.org` (200).
- **Suites** (`DOCKER_HOST` and `ORKESTRATOR_LIVE_DAEMON_RESTART_COMMAND`
  from the launcher, `ORKESTRATOR_HOST_REACHABILITY_CHECK=off`, the network
  shim on `PATH`, JUnit reports kept under `output/qualification-4730/`):
  - `container-live-egress-conditions.test.ts`: **3 of 3 pass** (55
    assertions, 69 s), twice. Each run restarted the inner `dockerd` twice
    through the launcher; the supervisor log shows generations 1 to 5. The
    IPv6 case did one assertion: this daemon had no IPv6 default.
  - The same suite on a `--ipv6` instance: **3 of 3 pass** (66 assertions,
    79 s: IPv6 12, DNS rotation 25, daemon restart 29), the counts of the
    hand-built 2026-10-31 run.
  - The same suite on a `--live-restore` instance: 2 of 3 failed at first,
    every gateway refusing to start. A gateway started by hand on that daemon
    logged `curl: (22) ... 403` from `api.github.com/meta`: this host's
    unauthenticated GitHub limit (60 an hour) was spent, the reset was about
    40 minutes away, and its fetch is how the firewall loads GitHub's ranges.
    Rerun after the reset: **3 of 3 pass** (63 assertions, 61 s; daemon
    restart 37, as on 2026-10-31 with `live-restore` on). One run of this
    suite made 7 GitHub requests.
  - `container-live-readiness.test.ts`, C09 "restart during launch" and C10
    only (`-t`), with `TMPDIR` on the printed shared directory: **2 pass**
    (54 s, 38 s). On 2026-11-06 both failed on a hand-built nested daemon
    until `TMPDIR` was moved to a directory mounted at the same path.
- **Restart by hand:** the printed command took 12.5 s with a `sleep`
  container running, which it stopped (exit 137, `live-restore` off), and
  2.3 s on a `--live-restore` instance, where the container kept running.
- **Stop:** 3.9 s and 4.6 s. Afterwards the outer daemon held no container
  and no volume, the dind image the launcher had pulled was gone, and the
  instance and runtime directories were removed.

Created and removed: the instances `nested`, `nested6`, `nestedlr`,
`nestedlr2` and `nestedrd` with their containers, volumes and directories; the dind image,
pulled and removed by the launcher each time; a diagnostic gateway container
and network (`q4730-*`) on one inner daemon; and finally the outer rootless
daemon with the pulled environment image, removed by its own `stop` (2.5 s),
and the launcher's downloaded tools. Another worktree's rootless instance
running at the time was left alone.

## Rootless host loopback and `docker cp` refusals on beelink (2026-11-10)

To-dos 7548 (done, and retired with this run) and [7549](../todo/containers-and-environments/7549-rootless-docker-cp-refusals.md),
run in worktree `orkestrator-v2-20261110-012450-21c9283e4a80` (branch
`rootless-loopback-docker-21c9283e4a80-r1`, from `main` at `04639b12b`).

- **Host:** beelink (Omarchy, Arch Linux, kernel 7.1.8, x86_64, 16 cores),
  `/home` on btrfs (`rw,noatime`), `/tmp` a tmpfs (`rw,nosuid,nodev`).
  Neither slirp4netns, pasta nor vpnkit is installed on the host. The host's
  rootful daemon was only read (`docker save` of the images named below).
- **Daemons:** two disposable host rootless daemons, both Engine 29.9.2,
  containerd v2.4.2, runc 1.5.2, RootlessKit 3.3.0:
  - `r7548g`: `mise run docker:disposable -- start --name r7548g --net
    gvisor-tap-vsock --host-loopback`, containerd image store
    (`io.containerd.snapshotter.v1`).
  - `r7549o`: `mise run docker:disposable -- start --name r7549o --storage
    overlay2`, slirp4netns 1.3.3, the overlay2 graph driver (`userxattr`,
    backing filesystem btrfs).
- **Images:** the pinned busybox probe image (pulled into each daemon),
  `oven/bun:1.4.4`, and `orkestrator-v2:dev-8bff8877f7f8` (78 layers, built
  2026-11-10 from a worktree near `main`), copied in with `load-image`.

### gvisor-tap-vsock host loopback (7548)

`apps/backend/scripts/agent-tools-peer-evidence.ts --platform-linux`
against `r7548g`, with `ORKESTRATOR_HOST_REACHABILITY_CHECK=off` and a
throwaway data directory, before and after the change:

| | `host-gateway` | `10.0.2.2` | `10.0.2.1` | Host check |
| --- | --- | --- | --- | --- |
| Before (`main`) | Refused (RootlessKit's own bridge) | Host is unreachable | Not probed | `blocked`, remediation "enable host loopback" (already enabled) |
| After | Refused | Host is unreachable | HTTP 405 from the real server, peer `127.0.0.1` (admitted) for the environment network, the default bridge and an unowned network | `reachable`, `hostAddress` `10.0.2.1` |

The environment-container probe through `10.0.2.1` was `reachable` too.
Output was kept under `output/agent-testing/r7548/` (local, git-ignored).

### `docker cp` refusals (7549)

- **Task 1, the refusal reproduced on both image stores.** A busybox
  container with a read-only bind from a `mktemp -d` under `/tmp` refused
  `docker cp` in and out, running and stopped, on `r7548g` (`remount-ro
  <data-root>/rootfs/overlayfs/<id>/ro, flags: 0x1021: operation not
  permitted`) and on `r7549o` (`remount-ro
  <data-root>/overlay2/<id>/merged/ro, …`); `docker exec` worked. The same
  container with the source under the worktree (btrfs) copied normally. The
  CLI hides the daemon's answer for a copy into a directory: a tar stream
  into `/` reports `destination "<id>:/" must be a directory` and a copy into
  `/tmp/` `no such directory`, while a copy out of a path that does not exist
  repeats the remount refusal (and answers `Could not find the file` on a
  healthy container). That probe is how the backend now classifies a failed
  copy. `docker-copy-refusal-docker.test.ts` passed 1/1 on both daemons.
- **Task 2, `device or resource busy` not reproduced.** On kernel 7.1.8 every
  copy into a created container worked, three in a row, for busybox,
  `oven/bun:1.4.4` and the 78-layer environment image, on the containerd
  store (`r7548g`) and on overlay2 (`r7549o`); so did the tar-stream form,
  a copy after start and stop, and a created container with two named
  volumes and a read-only bind (the runtime's shape). beelink2's failures
  were on kernel 7.2.15 with the containerd store; which of the kernel, the
  host's storage or something else decides it is still open. The rootful
  containerd-store comparison was not run: with nothing failing rootless on
  this host it could not tell the stores apart.
- **Task 3, retries.** `container-start-docker.test.ts` passed 3/3 (1
  skipped: the rootless mount case, not requested) on `r7548g` with
  `oven/bun:1.4.4`, including the case that detaches the container on more
  failed starts than the retries allow and then starts it with its ports.
- **Cleanup.** Every probe container and volume was removed by name; both
  daemons were stopped with `docker:disposable -- stop`.

## Rootless re-run on a freshly built image (2026-11-09)

To-do 0109 (retired on 2026-11-10; its decisions are in
[container lifecycle](../architecture/container-lifecycle.md#portable-inputs-staged-inputs))
task 5: C20, C22 and readiness on a rootless daemon with an image built from
current `main`, which the 2026-10-26 review run did not have. Run in worktree
`orkestrator-v2-20261109-224622-88ac356e9705` at `main` `c6de4733c`.

- **Host:** beelink2 (Omarchy, kernel 7.2.15, x86_64, 16 cores, 62 GB),
  `cpu memory pids` delegated to the user slice. The user cannot reach the
  host's rootful socket, so nothing was read from it.
- **Daemon:** `mise run docker:disposable -- start --name q0109
  --host-loopback`: host rootless Engine 29.9.2, containerd v2.4.2, runc
  1.5.2, RootlessKit 3.3.0, slirp4netns 1.3.3, systemd cgroup driver on
  cgroup v2, containerd image store (`io.containerd.snapshotter.v1`
  overlayfs), data root on btrfs. Host loopback was enabled because C22's
  selected host-service port is reached through `10.0.2.2`; the default
  (refused) path is the 2026-11-06 rootless loopback run above.
- **Image:** `orkestrator-v2:q0109-rootless-c6de4733`
  (`sha256:c20afcd40585517c4c14c87b7550af001d688263a11f5e063a31657f6a76a14e`,
  6.04 GB, 78 layers), built inside that daemon with `docker/build.sh`
  (509 s from an empty cache). Manifest `appVersion` `2.37.3-beta`,
  `sourceRevision` `c6de4733c…`; capabilities include `staged-inputs=5`,
  `egress-gateway=1`, `egress-filter=1`, `network-policy=3`; Claude Code
  2.1.319 and Codex 0.167.0 as pinned on `main`. The installed
  `entrypoint.sh` and `network-policy-entrypoint.sh` match the checkout
  (SHA-256 `1a8db83b…`, `a511d927…`).

Each suite ran through `test:logged` with the variables from
`docker:disposable -- env`, `RUN_LIVE_DOCKER_TESTS=1`,
`ORKESTRATOR_QUALIFICATION_IMAGE` set to the image, `--parallel=1` and a JUnit
report kept for the per-test results; readiness also had
`ORKESTRATOR_TEST_NO_PROGRESS_TIMEOUT_MS=2400000`.

| Suite | Result |
| --- | --- |
| Live lifecycle (C09, C11, C12, C20) | 8/8, 40.4 s and again 33.7 s. C20 ("a staged-inputs runtime can read only the allowlist of enabled providers") 6.7 s |
| Live network (C22, C24, C26) | 4/4, 65.3 s. C22 behind the egress gateway 21.7 s; C24 with `cpu memory pids` delegated |
| Live start recovery, `RUN_ROOTLESS_MOUNT_TESTS=1`, `TMPDIR` on the `nosuid,nodev` tmpfs `/tmp` | 4/4, 11.5 s, including the rootless read-only file bind (accepted and read-only, no refusal) |
| All staged mount consumers, `TMPDIR=/tmp` | 1/1, 27.2 s |
| Live readiness faults, `TMPDIR=/tmp` | 7/9, 280 s. The two firewall-failure boots reported `container-exited` instead of `firewall-missing`/`firewall-failed`: see the first finding |
| Live readiness faults, `TMPDIR` on the home filesystem (btrfs, no `nosuid`/`nodev`) | **9/9, 258.8 s** on the last of four runs. Earlier: 7/9 (C10's bare restart collided on a port; C22's gateway could not apply its policy), 5/9 after the C10 repair (four restricted boots `firewall-failed` or the gateway policy failure, with the GitHub allowance spent), 8/9 after the allowance reset (a gateway port collided twice, past the single retry) |

"A missing firewall script" and "a DNS-broken network", the two cases the
`/tmp` run lost, passed in all four runs with `TMPDIR` on the home
filesystem. C22's authenticated agent-tools reply passed in the `/tmp` run
and the last two home-filesystem runs (HTTP 405 from the real service
through `10.0.2.2` in 151 ms, another host port refused).

Findings, all new and all in
[7549](../todo/containers-and-environments/7549-rootless-docker-cp-refusals.md):

- **`docker cp` refused when a read-only bind's source is `nosuid`/`nodev`.**
  With `TMPDIR=/tmp` the readiness fixtures put the project Git mirror on the
  tmpfs, and `docker cp` out of the exited container failed with `remount-ro
  <data-root>/rootfs/overlayfs/<id>/orkestrator-git-mirror, flags: 0x1021:
  operation not permitted`, so readiness could not read the boot record and
  reported `container-exited`. A hand probe showed the refusal for copies in
  and out of a running container and out of a stopped one, while start and
  `docker exec` worked; with the source on the home filesystem all copies
  worked. This is the refusal 0109 task 3 classified for start and never
  reproduced; it comes from the daemon's copy path instead.
- **`docker cp` into a container that is not running fails with `device or
  resource busy`.** An overlay mount of the container's rootfs fails, every
  attempt, for a created or stopped container of the environment image,
  including the tar-stream form project seed files use. Copies into a
  running container and out of any container work. So the GitHub ranges seed
  is never copied (`github-ranges.seed-not-copied`, logged for runtimes and
  gateways), every restricted boot fetches `api.github.com/meta` itself, and
  once the host's anonymous allowance ran out (0 of 60 at 23:16 UTC) a
  readiness rerun failed four restricted boots with `firewall-failed` or
  the gateway's policy failure. Project seed files and configured project
  files use the same copy and would fail creation on this daemon.
- **An automatic port collided twice in a row.** A gateway start logged
  `start.port-collision-retrying … port=33124`, collided again on the retry
  and failed `port-conflict`. Afterwards no host socket listened in
  33000–33299, so the holders were short-lived, most likely outbound
  loopback connections drawing from the same ephemeral range.

- **Harness repair.** C10's bare `docker restart` of a full-mode runtime
  collided on an automatic port (`RootlessKit PortManager.AddPort(): listen
  tcp4 127.0.0.1:33014: bind: address already in use`). It now restarts
  through `restartRuntime`, the production start path with task 4's retry.
- **Cleanup.** Every suite's `afterAll` removed its labelled resources;
  afterwards the daemon held no container, network or volume. The hand
  probes' containers were removed one by one. `docker:disposable -- stop`
  took 13 s and left no instance process, runtime directory or `docker-*`
  scope; the instance directory, data root (with the image) and tools cache
  were removed.
- **Not covered:** the default refused host loopback on this image (covered
  on 2026-11-06), arm64, other RootlessKit network drivers, a host without
  `cpu` delegation (0019), the rootful daemon on this host, and whether the
  `device or resource busy` failure also happens on `overlay2` or rootful
  daemons (7549 task 2).

## Host loopback, rootful reach and workload firewalls on Linux Engine (2026-11-09)

To-do [5510](../todo/previews-and-annotations/5510-linux-gateway-qualification-gaps.md)
tasks 2 and 3, run in worktree `orkestrator-v2-20261109-224629-a4b698fad8f5`
(branch at `c6de4733c` plus this change).

- **Host:** beelink2 (Omarchy, Arch Linux, kernel 7.2.15, x86_64, 16 cores,
  load average 50–60 from other work during the runs). The host's rootful
  Docker socket is not usable by the build user (not in the `docker` group,
  no sudo) and ufw is active; neither was touched.
- **Daemon:** `mise run docker:disposable -- start --name q5510 --host-loopback`:
  the host's rootless Engine 29.9.2 under RootlessKit with slirp4netns,
  `DOCKERD_ROOTLESS_ROOTLESSKIT_DISABLE_HOST_LOOPBACK=false`, systemd cgroup
  driver on cgroup v2, pool `172.30.0.0/16` as /24s.
- **Image:** built inside that daemon, since the host's daemon could not be
  read: `docker build $(bun scripts/docker-image-build-args.ts) -t orkestrator-v2:q5510-c6de4733c -f docker/Dockerfile .`,
  id `sha256:946805d6e63ed2d9d53a9d56381206c21f903d6cf02c36d02b058a2aab931524`,
  amd64, `2.37.3-beta`, manifest source `9ad5d2f25` (`c6de4733c` plus a
  test-fixture fix; `docker/` identical), capabilities including
  `egress-gateway=1`, `egress-filter=1`, `network-policy=3`. The first build
  failed in the log-writer self-test, a test bug fixed in this change
  ([flake 9916](../tests/flaky-tests/environments-and-containers/9916-log-writer-marker-data-split-printf.md));
  the retry, still without the fix, passed because the failure depends on
  timing.

### Rootless with host loopback enabled (task 2)

```bash
eval "$(mise run docker:disposable -- env --name q5510)"
RUN_LIVE_DOCKER_TESTS=1 ORKESTRATOR_QUALIFICATION_IMAGE=orkestrator-v2:q5510-c6de4733c \
  ORKESTRATOR_LIVE_REPORT=<file> [ORKESTRATOR_LIVE_GITHUB_RANGES_SEED=<file>] \
  bun test --cwd apps/backend --preload ../../tests/setup-node.ts \
  ./tests/container-live-rootless-host-loopback.test.ts --parallel=1
```

- **Setup.** Three listeners on the host's loopback: the named service port
  (the agent tools port the firewall admits, a stand-in answering 200), a
  real `OrkestratorGateway` in agent-test mode bound to `127.0.0.1` (test
  token, no provider), and an unnamed port. The backend's host check reported
  `reachable` with `hostAddress` `10.0.2.2` after both `host-gateway` probes
  were refused. Three runtimes were created and started through the
  backend's own paths: restricted behind its egress gateway; full; and
  restricted from a variant image whose manifest and label drop
  `egress-gateway` and `egress-filter`, which puts the firewall in the
  workload with `NET_ADMIN`. Both restricted firewalls reported `applied`.
  Probes ran as `node` with `curl` (exit 7: refused or rejected).
- **Result: passed 1/1** (28.1 s, 64 assertions), and again with the seed
  below (31.3 s), with the same matrix.

  | Target, from inside the container | Restricted, gateway | Restricted, workload firewall | Full |
  | --- | --- | --- | --- |
  | Named service port, by `host.docker.internal` or `10.0.2.2` (positive control) | 200 | 200 | 200 |
  | Unnamed loopback port, by either address | Rejected | Rejected | 200 |
  | Real gateway, by `host.docker.internal` | Rejected | Rejected | 421 (Host check) |
  | Real gateway, by `10.0.2.2`, or by alias with `Host: 127.0.0.1:<port>` | Rejected | Rejected | 401 |
  | Gateway's agent-test login route (loopback peers only), same two ways | Rejected | Rejected | 401, not 404 |
  | Gateway's login-code mint, `POST`, no token | Rejected | Rejected | 401 |

  Each restricted firewall's `OUTPUT` REJECT counter rose from 2 to 11, the
  nine refused probes. Every listener saw the peer as `127.0.0.1`.
- **Runtime root.** `docker exec -u orkroot … iptables -I OUTPUT 1 -j ACCEPT`
  failed in the gateway runtime (`CapEff` has no `CAP_NET_ADMIN`), which then
  still got exit 7 from the gateway. In the workload-firewall runtime it
  succeeded, and the same probe then got the gateway's 401.
- **What this means:**
  - With host loopback on, the restricted firewall keeps a container to the
    named service port, as with it off. Unlike the 2026-11-05 run, the named
    port answered here, so the refusals are not just an unreachable host.
  - A full container reaches every service bound to the host's loopback, and
    arrives as `127.0.0.1`. That is the trade the rootless remediation
    already describes (todo 0109 decision 4, retired on 2026-11-10; now in
    [container lifecycle](../architecture/container-lifecycle.md#agent-tools-reachability-container-host-reachabilityts)). The gateway still needs its credential. Its Host check
    refused the alias, but a client that writes its own Host header gets
    past it, as the check's own comment says.
  - Two gateway paths trust a loopback peer. The agent-test bootstrap
    routes, on `dev:test` profiles only, are served to such a container, but
    minting still needs the token. The traffic summary believes
    `X-Forwarded-For` from a loopback peer (for Tailscale Serve), so such a
    container can choose the source address its requests are logged under.
    That is attribution in a log only; nothing is granted.
  - A workload firewall holds against `node`, but not against runtime root.
    The gateway boundary holds against both.
- **Variant, not a historical image.** The workload-firewall runtime used the
  current firewall scripts. An image actually built before the gateway was
  not run.

### Rootful daemon with no host firewall (task 3)

A rootful-mode `dockerd` in a `docker:29-dind` container on the same
disposable daemon (Engine 29.9.3, `--privileged` inside RootlessKit's user
namespace, overlayfs, cgroup v2; `docker info` reports no `name=rootless`;
pool `172.31.0.0/16`). The daemon's host namespace is that container: eth0
`172.30.0.2`, `docker0` `172.31.0.1`, `INPUT` and `OUTPUT` policy `ACCEPT`,
and only Docker's own `FORWARD` and NAT rules, so no host firewall stands
between the bridges and the host. The same image was copied in (same id).
Earlier rootful runs in this record used the same nesting on a rootful host.

The suite, `apps/backend/tests/container-live-rootful-host-reach.test.ts`,
ran inside that namespace, from a `--network host` container of the
qualification image (`bun` as entrypoint, the worktree mounted read-only,
the nested daemon's socket and its static `docker` CLI mounted), with
`ORKESTRATOR_LIVE_HOST_FIREWALL=none` and a GitHub ranges seed:

```bash
# The nested daemon: socket in a directory shared with the host (reached
# through a short symlink, as the full path exceeds the unix socket limit).
docker run -d --name q5510-dind --privileged -e DOCKER_TLS_CERTDIR= \
  -v "$PWD/output/q5510-dind-run:/run/dind" -v "$PWD:$PWD:ro" docker:29-dind \
  dockerd --host=unix:///run/dind/docker.sock --default-address-pool base=172.31.0.0/16,size=24
# The suite, in the nested daemon's host namespace.
DOCKER_HOST=unix:///tmp/ork-q5510-dind.sock docker run --rm --network host -u root \
  --entrypoint bun -v /run/dind/docker.sock:/var/run/docker.sock \
  -v /usr/local/bin/docker:/usr/local/bin/docker:ro -v /run/dind:/report \
  -v "$PWD:$PWD:ro" -w "$PWD" -e RUN_LIVE_DOCKER_TESTS=1 \
  -e ORKESTRATOR_QUALIFICATION_IMAGE=orkestrator-v2:q5510-c6de4733c \
  -e ORKESTRATOR_LIVE_HOST_FIREWALL=none -e ORKESTRATOR_HOST_REACHABILITY_CHECK=off \
  -e ORKESTRATOR_LIVE_REPORT=/report/rootful.json \
  -e ORKESTRATOR_LIVE_GITHUB_RANGES_SEED=/report/github-ranges.txt \
  orkestrator-v2:q5510-c6de4733c test --cwd apps/backend \
  --preload ../../tests/setup-node.ts ./tests/container-live-rootful-host-reach.test.ts --parallel=1
```

- **Setup.** Host listeners: the named service port and an unnamed port on
  `0.0.0.0`, an unnamed port on `127.0.0.1`, and two real gateways in
  agent-test mode, one on `0.0.0.0` (standing for a LAN or Tailscale-address
  bind) and one on `127.0.0.1`. The backend's host check reported
  `reachable` (firewall `unknown`: the runner container cannot read the
  host's tools). One restricted runtime behind its egress gateway and one full
  runtime, through the backend's create and start paths.
- **Result: passed 1/1** (9.4 s, 30 assertions).

  | Target, from inside the container | Restricted, gateway | Full |
  | --- | --- | --- |
  | Named service port, by `host.docker.internal` (positive control) | 200 | 200 |
  | Named service port, by the host's address `172.30.0.2` | Rejected | 200 |
  | Unnamed port on `0.0.0.0`, by either address | Rejected | 200 |
  | Gateway on `0.0.0.0`, by `host.docker.internal` | Rejected | 421 (Host check) |
  | Gateway on `0.0.0.0`, by `172.30.0.2` | Rejected | 401 |
  | Its agent-test login route, with `Host: 127.0.0.1:<port>` | Rejected | 404 |
  | Gateway or port on `127.0.0.1`, by either address | Rejected | Refused |

  The egress gateway's REJECT counter rose from 2 to 12, the ten refused
  probes. The `0.0.0.0` listener saw the full runtime as `172.31.2.2`, its
  address on its environment network; the loopback listener saw nothing.
- **What this means:** with no host firewall, a full container on a rootful
  daemon reaches a gateway bound to any host address. ufw was the only
  barrier on 2026-11-05, so this is the result that run could not show. It
  arrives with its own address, so the gateway's loopback-peer paths stay
  closed (404). A gateway bound only to loopback is out of reach, which
  rootless with host loopback (above) does not give. The restricted runtime
  is refused everywhere but the named port through its alias, as on the
  rootless daemon.
- **Nested, not bare metal.** The nested daemon has the bridge, NAT and
  `host-gateway` behaviour of a rootful host, but it runs in a user
  namespace, and its "host" is a container. A bare-metal host with its
  firewall off was not available (see the host above).

### Cleanup and not covered

- Each run removed its labelled containers, networks and volumes and the
  variant image tag, failed runs included (the suite asserts no leftovers).
  One diagnostic copy of the suite that skipped its cleanup left its
  containers and network; they were removed by their owner label, one at a
  time, and the copy was deleted. The nested daemon was removed with
  its volume, then `docker:disposable -- stop --name q5510` removed the
  instance, its data root and runtime directory.
  Both stops took 4–6 s. `docker:disposable -- status` then listed no
  daemon, and no runtime directory of either instance was left; the
  downloaded tools cache was then deleted by hand. A second
  daemon with host loopback off (`q5510off`) checked the refactored
  `container-live-rootless-loopback.test.ts`: 1 passed (7 assertions), and
  the loopback-enabled suite skipped there.
- **GitHub's API quota.** Restricted firewalls fail closed without GitHub's
  ranges. During the runs this host's address had spent GitHub's 60
  unauthenticated requests an hour. Four runs stopped with the gateway's
  firewall state `failed`; the one whose gateway log was captured shows
  `curl: (22) The requested URL returned error: 403`. One other run hit
  `port-conflict` when another process took an ephemeral host port first.
  Both suites now accept `ORKESTRATOR_LIVE_GITHUB_RANGES_SEED`: a seed
  fetched once from `api.github.com/meta`, in the backend's own format.
- **Not covered:** a bare-metal rootful host with no firewall, an image built
  before the gateway, arm64 (beelink2 is x86_64), and a real gateway on a
  Tailscale address (task 1). These stay open in
  [5510](../todo/previews-and-annotations/5510-linux-gateway-qualification-gaps.md).

## Exhausted Docker pools and historical probe-network trace (2026-11-06)

Evidence migrated from retired to-do 7041 on 2026-11-10. These are historical
observations on beelink at `c1724ab74`, not new qualification runs. Present-tense
statements below describe the state observed during that investigation.

### Manual container profiles on an exhausted pool

**Problem.** On beelink on 2026-11-05 a manual `dev:test` with a container fixture failed at startup with `ContainerLifecycleError:resource-exhausted: Docker has no free address range for another environment network`. The documented manual workflow for `mise run test:agent:docker` is therefore unusable on that host until networks are freed, which agents may not do.

**Context.** `test:agent:docker:isolated` puts `apps/desktop/scripts/dev/docker-qualification-bin` on PATH with `ORKESTRATOR_QUALIFICATION_DOCKER` (`apps/desktop/scripts/dev/isolated-browser.ts`). That shim retries only labelled `network create` calls on unrouted /29s in 172.16.240.0/22. The manual workflow in `docs/development/agent-testing.md` did not mention it.

**Investigation.** Starting the same profile with the shim on PATH (`ORKESTRATOR_QUALIFICATION_DOCKER="$(command -v docker)" PATH="$PWD/apps/desktop/scripts/dev/docker-qualification-bin:$PATH" mise run dev:test …`) succeeded, and the fixture network was created on a /29.

Done 2026-11-06: `agent-testing.md` now has a section, "Container profiles on an exhausted Docker address pool", after the manual container fixture commands, and the manual `test:agent:docker` example points at it. The documented command was then run on beelink:

- A labelled `docker network create` without a subnet failed with `all predefined address pools have been fully subnetted`, so the pools were exhausted at the time.
- `ORKESTRATOR_HOST_REACHABILITY_CHECK=off ORKESTRATOR_QUALIFICATION_DOCKER="$(command -v docker)" PATH="$PWD/apps/desktop/scripts/dev/docker-qualification-bin:$PATH" mise run dev:test --profile qa-7041-shim --fixture --fixture-environments local,container --no-agent-credentials --agent-platforms codex --headless` reached `ready`.
- The fixture container and its egress gateway were `Up`, and the environment network `ork-<owner>-<hash>-net` had subnet `172.16.240.0/29`, a range only the shim's fallback hands out.
- `dev:stop` and `dev:reset` then removed the profile's 2 containers, 2 volumes and 1 network.

The CLI container matrix failed the same way (2026-11-06, to-do [0014](../todo/cli-and-slash-commands/0014-cli-qualification.md) task 5): `mise run test:cli:scenarios -- --environment-type container` passed 3/8, with every scenario that starts an environment failing with `resource-exhausted`. With the same two variables it passed 8/8 and left nothing behind. The invocation is now documented beside that command in `docs/development/testing-guide.md`; the manual `dev:test` workflow is documented in `agent-testing.md` as recorded above.

**Decisions.**

- **How should a manual profile get the fallback?**
  - **Document the shim invocation next to the manual `test:agent:docker` workflow (recommended, done).**
    - Pros: no code change; the same scoped behaviour the isolated task already relies on.
    - Cons: a manual step people can miss.
  - **Have `dev:test` put the shim on PATH whenever `--fixture-environments` includes `container`.**
    - Pros: automatic.
    - Cons: widens a test-only shim to every container profile; needs its own tests.

### Historical probe-network trace

**Problem.** The host held 29 unattached reach-probe networks, created in clusters on 2026-10-31 (15:51–17:45 UTC), 2026-11-01 (03:40–04:33 UTC) and 2026-11-02 (04:57–05:50 UTC). 0241 task 4 recorded no new probe networks after a full run on 2026-10-31.

**Context.** To-do 0241 (retired 2026-11-10) found and fixed the earlier sources, and `mise run disk:report --fix probe-networks` removes unattached probe networks older than a day. Removing them is the user's call; this work did not. A backend removes its own probe network when the check ends and when it gets SIGTERM or SIGINT (`ContainerHostReachabilityService.dispose`). A backend that dies without its shutdown (SIGKILL, or a killed process group) while a check holds the network can leak it. Failed or timed-out network creation is another unruled-out path: Docker may create the network despite the client command failing, after which `createProbeNetwork` clears `probeNetwork` and returns null when the service is not closed. The caller then has no network to remove, and later normal shutdown may leave it behind. Neither path is proven to have caused the historical clusters. The check holds it for about 6 s on beelink, whose ufw drops Docker traffic, so each probe waits out its 5 s connect timeout. Each disposable data directory is a new owner that no reaper revisits.

**Investigation.** Not traced to one teardown. What the evidence shows:

- **The networks.** All 29 are still present, labelled `orkestrator-resource-role=host-reachability-probe`, one per owner, each on a /16 of the default pool, none attached. Within the clusters several come in runs of three, 3.9 s apart: 2026-10-31 16:18:00/04/08, 16:50:03/07/11 and 17:45:07/11/15; 2026-11-01 04:33:06/10/14; and a pair at 2026-11-02 04:57:12/16. That spacing points to one harness that starts backends one after another, each on a new data directory.
- **Owners against data directories.** No owner matches `dockerOwnerNamespace` of any of the 176 profile directories under `~/.config/orkestrator-v2-dev/profiles/` (as `<profile>` or `<profile>/data`), of the production data directory, or of the development root. Persistent `dev:test` profiles are therefore ruled out. The owners belong to temporary data directories that no longer exist, so they cannot be named.
- **Run history.** The production backend's service log has no timestamps between 2026-11-01 02:00 and 11:00 UTC, and the Kanban store keeps no comments from those windows. Pull requests opened in and just after the windows place them in concurrent pipeline builds:
  - 2026-10-31: about fifteen merges, among them #1501 (native menu qualification on Linux, its Electron spec) and #1500 (the 0241 sweep).
  - 2026-11-01: #1537 (service-preview Electron flakes, opened 04:35 UTC, right after the window), #1539 (Linux design-canvas Electron qualification) and #1542 (Electron focus checks). #1537's commit records, on beelink, that the spec's "probe network outlived each disposable profile". Until that commit (merged 11:12 UTC that day) agent-test backends dropped `ORKESTRATOR_HOST_REACHABILITY_CHECK` from their environment, so every agent-test Electron spec backend ran the boot probe even when the spec set the variable to `off`.
  - 2026-11-02: #1594 (the design journey against the packaged Linux app), #1601 (container stop drain) and #1603 (federated sidebar). The packaged and design-canvas Electron specs still do not set the variable.
- **Likeliest source.** Agent-test Electron spec backends: windows 1 and 2 fall in Electron spec qualification builds while the switch was being dropped, and window 3 in the packaged Electron journey's build, whose specs still run the probe.
- **Reruns.** Each was diffed against the probe-network list from before it, with `docker events --filter type=network` recording every create and destroy:
  - The automatic pools are exhausted, so a plain rerun cannot create a probe network at all. `design-canvas-electron.spec.ts` (headless, probe on) passed in 18.5 s and created none.
  - With the shim on PATH, a labelled probe network goes onto a /29, so the leak could happen again. Reruns with the shim and the probe on:
    - The same spec failed at a known flake ([4250](../tests/flaky-tests/design-canvas-and-artifacts/4250-design-electron-reachability-dialog-race.md) and [1131](../tests/flaky-tests/design-canvas-and-artifacts/1131-design-electron-graceful-quit-deadline.md)). Its probe network was created, connected, disconnected and destroyed within 6 s.
    - `apps/desktop/tests/backend-process.test.ts`, run from `apps/desktop`, passed. It created no probe network, because each backend was stopped before its check reached the network.
    - Run from the repository root it created one, which was destroyed.
    - `apps/backend/tests/standalone.test.ts` created three, 1–2 s apart, and all were destroyed. Its one failure was unrelated: `cursor-bridge` was not built in this worktree.
  - None of the reruns left a probe network behind.
- **Still unruled out.** A failed or timed-out Docker network-create command may leave a daemon-side network even when the backend later shuts down normally. The successful create/destroy pairs in these reruns do not exercise that failure path. Follow-up 7470 (retired 2026-11-10; see [disposable backends](testing-guide.md#cli-scenarios)) retains it as a candidate, without attributing the historical clusters to it.
- **Not rerun.** The Electron specs other than the design journey need a display, which this host may not use (headless only, no Xvfb), so the specs of the 2026-10-31 and 2026-11-01 builds could not be repeated here. Their timing at the time (backends stopped while host load stalled Docker commands) cannot be recreated either.

Additional inventory on 2026-11-06: On 2026-11-06 the host still held 29 unattached probe networks, created 2026-10-31 (13), 2026-11-01 (9) and 2026-11-02 (7), and none newer, so the leak has not recurred since 2026-11-02. They still fill both default pools (172.18–31/16 and 192.168.0.0/16 in /20s). The owner namespaces are one-off (one network each), which fits backends started on temporary data directories, as in 0241 task 1.

**Decisions.**

- **How to find the source?**
  - **Match the cluster times against build and test runs on beelink in those windows, then rerun the likeliest harness and diff the probe-network list (recommended, done).**
    - Pros: the method 0241 used; decisive when the leak reproduces.
    - Cons: the run history of those days is thin, the pools are full, and the likeliest harnesses need a display. It did not reproduce.
  - **Add an owner-to-data-directory log line when a probe network is created.**
    - Pros: makes the next leak traceable at once.
    - Cons: new logging surface; does not explain these. Carried into to-do 7470 (retired 2026-11-10) task 2.

### Trace closure and retirement (2026-11-10)

The historical trace (7041 task 2) is closed as untraceable. The owners'
temporary data directories are gone and the 29 networks predate the creator
label shipped by to-do 7470 (retired 2026-11-10; see [disk usage](disk-usage.md#what-you-clean-yourself))
(#2024, `60c065c36`, checked against `main` at `04639b12b`). The label applies
only to newly created networks; it cannot identify these historical owners.
The candidate causes above remain unproven. A new leak carries an
`orkestrator-creator` label and is new work for a new to-do.

To-do 3320 (retired 2026-11-10)
task 1 is closed as a duplicate of this trace. Its task 2, removing the 29
networks, remains the user's call; this work left them untouched.

The manual-profile workaround and its live proof were complete, so no work
remained in 7041. Its file and index row were removed under the to-do retirement
rule; the evidence lives here instead of in a finished task file. Keeping 7041
would preserve old links but conflict with that rule. Repointing the links
preserves navigation without introducing a repository-wide exception.

## Agent CLIs without telemetry hosts on rootful Linux Engine (2026-11-06)

To-do 6100 (security finding M12, task 3 of S-0100): do the agent CLIs need
the telemetry hosts the default allowlist carried (`sentry.io`,
`statsig.anthropic.com`, `statsig.com`)? They do not, so the three were
removed from `DEFAULT_ALLOWED_DOMAINS` and the image fallback, and the to-do
was deleted.

- **Host:** beelink (Arch Linux, kernel 7.1.8, x86_64), host Docker Engine
  29.9.2 rootful. The default address pools were full, so the run used the
  test-only network shim (`apps/desktop/scripts/dev/docker-qualification-bin`
  with `ORKESTRATOR_QUALIFICATION_DOCKER`, as in
  [7041](container-qualification.md#exhausted-docker-pools-and-historical-probe-network-trace-2026-11-06)).
  The daemon, the host firewall and other owners' resources were not
  touched; every container and network the run made carried its private
  owner label and was removed by it.
- **Image:** `orkestrator-v2:dev-2462db30da8c`, built with
  `mise run docker:build:dev` from `main` at `c1724ab74` (before the list
  changed; the runtime got its allowlist explicitly). Claude Code 2.1.314,
  codex-cli 0.166.0, OpenCode 1.19.5, Pi 1.4.0, Grok 1.0.70.
- **Setup:** `apps/backend/tests/container-live-telemetry-hosts.test.ts`. A
  restricted runtime behind its egress gateway with name checks on, allowlist
  `registry.npmjs.org` only, so all three hosts and the CLIs' Sentry ingest
  hosts (`o1158394.ingest.us.sentry.io` for Claude Code, `o33249…` for Codex,
  `o4508179396558848…` for Grok, read from the binaries) answer `REFUSED`. A
  fake provider on the runtime's loopback serves Anthropic Messages, OpenAI
  Chat Completions and Responses, and a failing `/broken` route. Claude's
  nonessential traffic and error reporting were left on, as the backend
  leaves them. `ORKESTRATOR_TELEMETRY_HOSTS_TRACE` put a packet reader in the
  gateway's namespace (a labelled sidecar) and marked each turn with a
  lookup of a reserved `.invalid` name.

| Turn | Result | Time | Names looked up during the turn |
| --- | --- | --- | --- |
| Claude Code print (`claude -p`) | `ok`, exit 0 | 0.47 s | `api.anthropic.com` (refused) |
| Claude Code Agent SDK stream-json | result `ok`, `is_error: false` | 0.33 s | `api.anthropic.com` |
| Claude Code, provider answers 500 | exit 1 | 0.39 s | `api.anthropic.com` |
| Codex `exec` on a Responses provider | `ok`, exit 0 | 5.9 s | `github.com`, `chatgpt.com`, `ab.chatgpt.com` |
| Codex, provider answers 500 | exit 1 | 0.38 s | `chatgpt.com`, `github.com` |
| OpenCode `run` on an OpenAI-compatible provider | `ok`, exit 0 | 3.2 s | `models.opencode.ai`, `registry.npmjs.org` |
| Pi `-p` on a `models.json` provider | `ok`, exit 0 | 0.61 s | none |

No turn looked up `sentry.io`, `statsig.anthropic.com`, `statsig.com` or any
Sentry ingest host; those names appear in the trace only for the test's own
`dig` checks. The suite passed on four traced runs while it was written
(16–25 s each; one attempt in between failed on the test's own trace setup,
since fixed), and the final file passed without the trace (21.4 s).

A search of the binaries for these hosts agrees. Claude Code's contains the
string `sentry.io` and its ingest host, and no Statsig host; Codex and Grok
each carry one ingest DSN; OpenCode and Pi name none. The Cursor SDK's Statsig client uses `featureassets.org`,
`prodregistryv2.org`, `statsigapi.net` and `api.statsigcdn.com`, none of the
three. Under name checks an entry allows exactly its own name, so `sentry.io`
never let a client reach an ingest host there anyway.

At the initial qualification, Grok and Cursor were not run as turns. They were tracked in [7420](../todo/containers-and-environments/7420-telemetry-hosts-grok-and-cursor-turns.md).
Native linux-arm64 execution of this suite also remains unverified (7420 task 4);
the workflow schedules it, but the recorded runs above are x86_64 only.

### Review follow-up: Grok fake-provider turn (2026-11-06)

The extended suite passed on the same x86_64 host and amd64 qualification
image in 21.3 s, with the test-only network shim described above. Grok 1.0.70
completed `grok -p` in 542 ms, returned `ok` and exited 0 without a login.
Its isolated home receives fake keys only; `GROK_XAI_API_BASE_URL`,
`GROK_CLI_CHAT_PROXY_BASE_URL`, `GROK_MODELS_BASE_URL` and
`GROK_MODELS_LIST_URL` all point at the loopback fake provider. The test
checks that response/chat request counts increase across Grok's turn.
The other seven turns also passed (235–5589 ms). Cleanup assertions passed.

The opt-in packet trace recorded no outside DNS or TCP activity during Grok's
turn, and no removed telemetry or ingest name during any turn. This is a
trace observation; the test asserts DNS refusal and bounded turn completion.
The local trace is `output/agent-testing/telemetry-review/trace-with-grok.json`.
Cursor still has no live turn in this suite, and native arm64 execution
remains unverified (7420 tasks 2 and 4).

## Rootless daemon restart on a disposable daemon (2026-11-06)

To-do 0018 (retired 2026-11-11)
task 2's last open check and
4730 (retired 2026-11-10)
tasks 1 to 3, run in worktree `orkestrator-v2-20261106-034211-c21c9a597669`
(branch at `c1724ab74` plus this change).

- **Host:** beelink (Arch Linux, kernel 7.1.8, x86_64); the host's rootful
  Engine 29.9.2 was only read, for the image.
- **Daemon:** `mise run docker:disposable -- start --name q4730`: host
  rootless Engine 29.9.2 (the host's `dockerd`), RootlessKit 3.3.0,
  slirp4netns 1.3.3, builtin port driver, host loopback refused,
  `live-restore` off, systemd cgroup driver on cgroup v2, pool
  `172.30.0.0/16` as /24s. Started in 4.8 s.
- **Image:** `orkestrator-v2:dev-f199d298c1eb`
  (`sha256:ede88bdf598404c055e5dddfbbad05a56d62b7075ce0365cff9b9c76bfa4e6b4`,
  `2.36.4-beta`, source `381efb5cb`, capabilities including
  `egress-gateway=1`, `egress-filter=1`, `network-policy=3`), copied in by
  `load-image` with the id checked (97 s). Its `docker/` sources differ from
  `c1724ab74` only in `orkestrator-state-signal.sh` and
  `workspace-setup.sh`; the firewall, gateway and entrypoint scripts are
  identical.

Each command ran with the three variables from `docker:disposable -- env`,
`RUN_LIVE_DOCKER_TESTS=1` and `ORKESTRATOR_QUALIFICATION_IMAGE` set to that
image:

```bash
mise run test:logged -- --name rootless-daemon-restart -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/container-live-egress-conditions.test.ts --parallel=1 --test-name-pattern 'Docker daemon restart'
ORKESTRATOR_LIVE_IPV6_NETWORK=1 mise run test:logged -- --name rootless-egress-conditions -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/container-live-egress-conditions.test.ts --parallel=1
mise run test:logged -- --name rootless-default-loopback -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/container-live-rootless-loopback.test.ts --parallel=1
```

- **Daemon restart: passed 1/1** (42.6 s), with the same assertions as the
  2026-10-31 rootful run, `live-restore` off and two restarts through the
  launcher. A runtime stopped through the backend and one running when the
  daemon stopped both came back with neither container started by Docker; a
  bare `docker start` of the runtime was refused while its gateway was
  stopped; the backend's start path brought both up in order with `CapEff`
  0, the report `applied`, `-P OUTPUT DROP` with the final REJECT, IPv6 off,
  `registry.npmjs.org` reachable and `example.com` rejected.
- **What a rootless restart rebuilds.** Observed across one `restart`: the
  RootlessKit parent's pid, its network namespace (inode 109970830 to
  109973543) and the slirp4netns process were all new. The policy is
  re-applied in the new namespace by the backend's start path, as above.
- **Whole egress-conditions suite: passed 3/3** (62.2 s), adding IPv6 with
  `ORKESTRATOR_LIVE_IPV6_NETWORK=1` (the IPv6 network exists only in
  RootlessKit's namespace) and DNS rotation through the controlled resolver.
- **Default loopback: passed 1/1** (8.9 s, 7 assertions): host discovery
  reported `blocked` with `dockerRootless: true`, no host address and the
  `DOCKERD_ROOTLESS_ROOTLESSKIT_DISABLE_HOST_LOOPBACK=false` remediation;
  both `host-gateway` probes were refused and both `10.0.2.2` probes
  unreachable; a restricted runtime behind its own gateway got `refused`
  for the agent tools URL. The same file skipped 1/1 against the rootful
  host daemon (read-only `docker info`).
- **Launcher repairs found by the run.** The systemd cgroup driver could not
  create container scopes until the daemon's environment kept the session
  bus address (containers failed with "interactive authentication
  required"); and the restart command first refused to run from the test
  runner's private `TMPDIR`, because it recomputed the runtime directory
  instead of reading the recorded one. Both are fixed and the runs above
  used the fixed launcher. The failed attempts' labelled containers and
  network on the disposable daemon were removed one at a time.
- **Cleanup.** `docker:disposable -- stop` took 7 s; no process carrying the
  instance marker remained, no `docker-*.scope` user unit was left, and the
  data root, runtime directory and tools cache were removed.
- **Not covered:** `live-restore` on (a RootlessKit restart replaces the
  namespace the containers live in, so the rootful result does not carry
  over), VPNKit, pasta and gvisor-tap-vsock, arm64, and the firewall,
  network and readiness suites on this daemon (they passed on the
  2026-11-04 hand-built rootless daemon). Tracked in
  [7390](../todo/containers-and-environments/7390-rootless-restart-remaining-settings.md).

## Claude preference lock with a reused pid, Docker Desktop (2026-11-06)

To-do 0726 task 5, the last item of that file (retired with this run): a
Claude session's preference lock left by a dead bridge whose pid is live
again must not stop the session's prompts. The rule is in
[agent-engines.md](../architecture/agent-engines.md#claude-code).

- **Host and stack:** Docker Desktop 4.98.0 (Engine 29.9.2, linux/arm64,
  kernel 7.0.14-linuxkit) on Apple Silicon. A `dev:test` profile started with
  `--fixture --fixture-environments local,container --no-agent-credentials
  --agent-platforms claude` and `ORKESTRATOR_HOST_REACHABILITY_CHECK=off`, on
  an image built from `main` at `c1724ab74` (`mise run docker:build:dev`).
  The image's `/opt/claude-bridge/dist/index.js` matched a local build of the
  bridge byte for byte (SHA-256).
- **Model:** the image's pinned Claude Code 2.1.314 against
  `container-fake-claude-api.ts` on the container's loopback, wired as the
  terminal-signal spec does (`ANTHROPIC_BASE_URL`, a fixture
  `ANTHROPIC_AUTH_TOKEN`, merged into `~/.claude/settings.json`). No login, no
  provider request. The native Claude tab reads the same user settings, so a
  bridge session needs nothing more.
- **Method:** one native session in `fixture-container`, driven with the
  worktree's `orkestrator` CLI (`session start`, then `session prompt --wait`
  with a new request key per case). Before each prompt a lock was written as
  `node` to `~/.claude/orkestrator/session-preferences/<session>.json.lock`
  (the provider-state volume) and back-dated two minutes. A prompt with no
  lock took 3.75 s end to end; a refused one about 5.8 s (the 5 s wait).

| Case | Lock | Result |
| --- | --- | --- |
| A | Older format, `{token, pid}` naming the running bridge's own pid | Admitted, 2.83 s; lock taken over |
| B | New format naming live pid 9 (`sleep infinity`) with `procStart: "1"` and the real boot id | Admitted, 3.00 s |
| C | New format naming the bridge's own pid and start time under another `instance` | Admitted, 2.65 s |
| D | New format naming live pid 9 with its real start time and another boot id | Admitted, 2.56 s |
| Restart | The bridge's real identity (copied from its change-evidence `owner.pid`), then the environment stopped and started; in the new pid namespace a `sleep` owned by `node` was walked onto the dead bridge's pid (982) before the first prompt | Admitted, 3.00 s; the new bridge (pid 1120) also took over the change-evidence spool claim |
| E (control) | New format naming live pid 9 with its real start time and boot id | Refused: 503 "The session's preferences are busy, so the prompt was not sent", lock untouched. With the lock removed, the next prompt ran at once and the session was not parked |
| F (control) | Older format naming live pid 9, an unrelated process | Refused the same way, as documented: an older bridge's lock held by an unrelated live pid waits until that pid exits |

The transcript held each admitted prompt and its answer exactly once, and
neither refused prompt reached the model.

- **Before the fix, same container.** The current bridge was rebuilt with only
  the pre-#1369 recovery rule restored (a live pid is never recoverable),
  copied over `/opt/claude-bridge/dist/index.js` as root with the original
  kept beside it, and the environment restarted. Case A's lock (naming that
  bridge's pid 496) refused two prompts in a row, and case B's refused too;
  the locks stayed in place. The original file was then restored (SHA-256
  checked) and the environment restarted, after which a prompt ran normally.
  The pre-fix 500 would have been 503 here, because only the recovery rule
  was reverted, not the typed refusal.
- **Found:** no defect in the lock rule. A refusal like case E reaches the
  CLI as `operation-failed`, exit 1, with no `retryable` flag, and the same
  request key replays that failure; a script cannot tell it from a permanent
  refusal (to-do 7260). Fixed on 2026-11-10: such a refusal now carries
  `retryable: true`, still `operation-failed` and exit 1, so a script may
  send it again under a new key
  ([public-cli.md](../architecture/public-cli.md#output-and-exit-codes)).
- **Not run:** the container restart was staged by stopping and starting the
  environment and placing a process on the dead bridge's pid. A bridge killed
  inside its real lock hold was not attempted (timing-dependent, and the
  staged lock is the same file). macOS host bridges (the `ps` path) and Linux
  Engine were not part of this run.

Created and removed: the profile `claude-pidlock` and its fixture runtimes,
gateway, network and volumes (`dev:stop`, then `dev:reset`), and the image
tag `orkestrator-v2:dev-57301bd868fa`. The fake API, its settings merge, the
pid walker and the comparison bundle lived only in that container.

## Egress refusal counts on rootful Linux Engine (2026-11-06)

To-do 6102 (retired 2026-11-11) task 4: the name-check daemon's counts of
refused connections and DNS queries since the gateway booted, shown in the
Network section. How they are counted and kept content-free is in
[container lifecycle](../architecture/container-lifecycle.md#name-checks-egress-filter1).

- **Host:** beelink (Arch Linux, kernel 7.1.8, x86_64), host Docker Engine
  29.9.2 rootful. Docker, its networks and the host firewall were not
  restarted, reconfigured or pruned. The host's address pools were full, so
  both runs used the test-only Docker shim
  ([exhausted pools](#exhausted-docker-pools-and-historical-probe-network-trace-2026-11-06):
  `ORKESTRATOR_QUALIFICATION_DOCKER` with
  `apps/desktop/scripts/dev/docker-qualification-bin` on PATH), with
  `ORKESTRATOR_HOST_REACHABILITY_CHECK=off`. No profile, provider turn or
  credential was used.
- **Image:** `orkestrator-v2:qual-6102-a891cd1a`, built from commit
  `a891cd1a2` with the capability arguments from
  `scripts/docker-image-build-args.ts` and the label
  `orkestrator-test-run=todo-6102-refusals`.
- **Result:** the case "the firewall report counts refused connections and
  queries since boot, and keeps no name" in
  `apps/backend/tests/container-live-egress-filter.test.ts` passed alone
  (1 pass, 21 expectations, 13 s) and in the whole file (5 pass, 1 skip — the
  older-image case, which needs `ORKESTRATOR_QUALIFICATION_OLDER_IMAGE` —
  0 fail, 109 expectations, 69 s). In a restricted runtime behind its gateway:
  - After boot `effective.refusals` was `{ connections: 0, queries: 0 }`:
    the firewall's own boot checks were not counted.
  - An allowed HTTPS request and an allowed lookup left it at zero.
  - Two foreign SNIs at an allowed address (TLS `access_denied`), one foreign
    Host in plain HTTP on 443 (the gateway's 403) and three refused queries
    (UDP, TCP, and one sent straight to `192.0.2.53`) gave
    `{ connections: 3, queries: 3 }`, and the file held exactly
    `{"refusedConnections":3,"refusedQueries":3}`.
  - The refused label was in none of the gateway's `/run`, `/etc`, `/tmp`,
    `/var/log` or `/root`, nor in its Docker log.
  - Killing the daemon's worker: the supervisor started a new one, the counts
    stayed at 3 and 3, and one more refused query made them 3 and 4.
  - Restarting the runtime and its gateway (a new boot) gave
    `{ connections: 0, queries: 0 }`.

Created and removed: each run's owner-labelled runtimes, gateways, fixtures
and networks (`afterAll` found none left), and the image tag.

## Egress name checks on rootful Linux Engine (2026-11-06)

To-do [6101](../todo/containers-and-environments/6101-egress-name-checks-platform-coverage.md)
task 1 and 0018 (retired 2026-11-11)
task 1: the gateway's name checks (`egress-filter=1`) and the gateway suites
on rootful Linux Engine, x64.

- **Host:** beelink (Arch Linux, kernel 7.1.8, x86_64, cgroup v2), host Docker
  Engine 29.9.2 rootful. Its `daemon.json` names the upstream resolver by
  address (`"dns": ["172.17.0.1"]`). The host daemon was not restarted,
  reconfigured or pruned, and the host firewall was not touched.
- **Image:** `orkestrator-q6101:e6c3da899`, built here from `main` at
  `e6c3da899` with the capability arguments (`egress-filter=1`,
  `egress-gateway=1`, `network-policy=3`) and the label `orkestrator-q6101=1`.
  BuildKit served every layer from cache. The manifest records
  `sourceRevision` `e6c3da89905f`, and the image's
  `orkestrator-egress-filter`, `init-firewall.sh` and
  `orkestrator-egress-gateway` match the checkout byte for byte (SHA-256).
  Older image, read only: `ghcr.io/orkestrator-ai/orkestrator-v2:2.34.4-beta`
  (`egress-gateway=1`, no `egress-filter`).
- **The host daemon had no address range left.** All 31 default pools are
  held: by 29 leaked `reach-probe` networks
  (to-do 0241, retired 2026-11-10),
  `docker0` and another environment's network. The first M12 run there failed
  5 of 5 in `ensureEnvironmentNetwork` with `resource-exhausted`. Those
  networks were left alone. Two workarounds were used instead:
  - **Disposable daemon for the suites.** `docker:29-dind` (Engine 29.9.3,
    same kernel, rootful) in a privileged container labelled
    `orkestrator-q6101=1`, with its own data volume, a private socket
    directory, `bip` `10.213.0.1/24`, pool `10.214.0.0/16` split into /24s,
    `live-restore` off, and a supervisor loop that starts `dockerd` again
    when it exits. Images were streamed in with `docker save | docker load`
    (same image id). Its containers' upstream is the host's `172.17.0.1`.
    This is the 2026-10-31 recipe; 4730 (retired 2026-11-10)
    task 1 would make it a repository command.
  - **Host daemon for the five ticket cases.** A scratch script created a
    restricted and a full runtime through `createDockerContainer` after
    pre-creating each environment network with its exact name and labels
    on an explicit subnet (`172.16.250.0/28`, `172.16.250.16/28`), which
    `ensureEnvironmentNetwork` adopts, as the 2026-11-05 omarchy-hp run did.
- **The five cases, by hand, on the host's own Engine 29.9.2** (outputs
  abbreviated):
  1. Allowed name: `curl https://registry.npmjs.org/` → `200`.
  2. Foreign SNI on that address (`--resolve tenant.<run>.invalid:443:104.16.5.34`)
     → `tlsv1 alert access denied`, curl 35.
  3. `c2VjcmV0.exfil.<run>.invalid`: `REFUSED`, `ANSWER: 0`, `EDE: 18
     (Prohibited)` over UDP, over TCP and sent to `192.0.2.53`; `getent`
     exit 2.
  4. Supervisor and worker killed with `SIGKILL` (no filter process left):
     the allowed address gave curl 7 and DNS `no servers could be reached`.
     After `update-firewall.sh --refresh`, `200` again.
  5. Full mode: the runtime owns its own namespace, has no filter process
     and no `/etc/orkestrator/egress-filter`, `registry.npmjs.org` answers
     `200`, a reserved name gets Docker's `NXDOMAIN` (no `REFUSED`, no EDE),
     and the foreign SNI reaches the origin, which answers `handshake
     failure` itself rather than the gateway's `access denied`.

  The gateway's protected `resolv.conf` read `nameserver 127.0.0.11` and
  `# ExtServers: [172.17.0.1]`, so on this host Docker names its upstream by
  address and the daemon queries it from inside the namespace: the
  addressed-upstream path of 6101 task 3, on a real daemon rather than a
  fixture. The same script on the disposable daemon passed identically with
  `# ExtServers: [host(172.17.0.1)]`.
- **Suites on the disposable daemon** (`DOCKER_HOST` set to it,
  `ORKESTRATOR_HOST_REACHABILITY_CHECK=off`, JUnit reports kept):
  - `container-live-egress-filter.test.ts` with the older image: **5 pass, 0
    fail**, twice (47 s, 52 s). All five cases ran: name checks with edits and
    the dead-daemon case (19 s), addressed upstreams with forged replies and
    failover (10 s), full mode (1 s), the rollback switch (9 s) and the older
    image (7 s).
  - `container-live-egress-conditions.test.ts` with
    `ORKESTRATOR_LIVE_IPV6_NETWORK=1` and a restart command for the
    disposable daemon only: **3 pass** (46 s) after the two test fixes below.
    The daemon-restart case restarted `dockerd` twice (the supervisor logged
    both).
  - `container-live-firewall.test.ts`, the policy 3 tuple case only: **1
    pass** (12 s) after the fix below; the unfixed copy from `e6c3da899`
    failed at `:555` as in CI. C23 was not run: it opens connections to
    `example.com`, which is not on the default allowlist, and traffic here
    was kept to fixtures and default-allowlist hosts.
  - `container-live-network.test.ts`: C24 (both) and C26 pass. C22 fails at
    `reachability.check("manual")` with `blocked`: the backend's service
    port is on the outer host, which a nested daemon's containers cannot
    reach as their host.
  - `container-live-readiness.test.ts`: 6 of 9 on the first run. C09
    "restart during launch" and C10 failed because their bind-mounted origin
    repository lives in the test's temporary directory, which the nested
    daemon resolves inside its own container. Rerun with `TMPDIR` on a
    directory mounted into the dind container at the same path: **8 of 9**.
    C22 fails as in the network suite.
- **Defects found and fixed (test-only, not Linux-only).** On every
  `egress-filter=1` image two live cases sent a bare word (`probe`, `first`)
  as their first TCP write. The name checks hold a printable first write
  with no newline, since it could still become an HTTP request line, and
  refuse it after 30 s, so those probes never reached their echo peer:
  - The policy 3 tuple case in `container-live-firewall.test.ts` (`:555`,
    expected 0, received 1).
  - The DNS-rotation case in `container-live-egress-conditions.test.ts`. It
    also called `node` on the gateway's fixed root PATH, which lacks
    `/usr/local/bin` ([6103](../todo/containers-and-environments/6103-live-suite-failures-seen-during-s0100.md)
    task 2). With only the PATH fixed it failed at its first probe (`:464`).

  Both now send whole lines, and the resolver runs as `/usr/local/bin/node`.
  CI run 42128741746 (S-0100's PR head `46998097`, Engine 28.0.4,
  `ubuntu-24.04` and `ubuntu-24.04-arm`) failed both cases in the same way on
  both runners. Its other relevant steps passed: M12 4 pass (the older-image
  case skipped, as the workflow supplies none), network 4/4 and readiness
  9/9. The product behaviour behind them is documented in
  [container lifecycle](../architecture/container-lifecycle.md#name-checks-egress-filter1)
  (to-do 7000, retired 2026-11-11, which kept the hold).
- **Not run:** arm64 on a self-managed host (only CI's hosted arm64 runner
  above), rootless Docker (6101 task 2), C23 (see above), and C22 behind a
  real host daemon on this machine (its pools are full). No provider turns,
  credentials or app profile were used.

Created and removed: the image tag `orkestrator-q6101:e6c3da899`, the pulled
`docker:29-dind` image, the container `q6101-dind` and volume
`q6101-dind-data` (label `orkestrator-q6101=1`) with every image, container,
network and volume inside them, the private socket directory, and the two
pre-created host networks with each run's owner-labelled runtimes, gateways
and fixtures, which `afterAll` removed and listed again as empty. Afterwards
nothing labelled `orkestrator-q6101=1` remained on the host daemon.

## Remaining validation blockers repaired (2026-11-05)

Follow-up source commit `4bf05e1e840e0258ee7e43e928b2a96d87bd760a`
was rebased onto `main` at `cbe0f9a5b9914cc6780b8008d9da95a7f2518d38`.
The five deterministic failures recorded below are now repaired:

- Legacy standalone releases explicitly use Bun's hoisted linker, matching
  the fetch and locked-install paths. A caller's isolated global store no
  longer leaves a published release depending on an external package cache.
  The regression publishes executable entry → mid → leaf fixtures, deletes
  the caller cache, and executes the installed release. Both locked and legacy
  releases retain the expected transitive dependency version. Before the fix,
  the cache-deletion regression failed because the entry was unresolvable;
  evidence is `orkestrator-test-run.w7rxDc/protocol-install-runtime-baseline.log.gz`
  under the host temporary directory.
- Schedule rendering canonicalizes zero-offset GMT labels, including `GMT+0`,
  to `GMT`. Civil time, nonzero offsets and daylight abbreviations are unchanged.
  Deterministic ICU-label tests include zero offset, BST, GMT+1 and a half-hour
  offset. The unchanged web schedule and coordinator timer assertions pass;
  browser coverage verifies rendering, inactive-view remount and reload.
- The corrected-reinstall CLI test uses its real host platform for both manager
  commands and process-identity validation. Spoofing Linux on macOS required
  unavailable `/proc` identity data and incorrectly refused the ready descriptor.
  Both native manager sequences and the original two-poll readiness/generation
  assertions remain checked; no process-identity check is bypassed.

The linker choice makes a release independent of caller cache preferences;
keeping caller-selected linking would preserve that preference but permits the
reproduced runtime failure. Canonicalizing only zero-offset aliases stabilizes
the existing display contract while preserving useful daylight and numeric
nonzero labels. These changes do not alter schedule firing instants.

### Final qualification

At `4bf05e1e8`, full typechecking, build, lint, formatting, installer owners,
CLI reinstall owner, schedule-time owner, web schedule owner, backend timer owner,
and the scheduler browser owner all passed through `mise run test:logged`.
The packaged CLI scenarios passed **10 of 10**, with no cleanup errors; manifest:
`output/cli-scenarios/2026-11-05T23-00-10-077Z-2d20a45b/manifest.json`.
Scheduler screenshot comparisons, using an emulated ICU zero-offset spelling,
are in `output/visual-previews/schedule-zone-*-card-*.png`.

The first follow-up aggregate passed every runtime package but found a registry
collision with newer main's independent case 6550. The branch's egress case was
renumbered to [9833](../tests/flaky-tests/environments-and-containers/9833-egress-worker-restart-dns-timeout.md)
and all references updated in metadata-only commit
`74c7faeeeecee1b17e173a36432ae21dec5f2e02`. The registry guard and formatting
passed, then a fresh complete default aggregate passed on that exact commit:

```sh
mise run test:logged -- --name remaining-final-default -- mise run test
```

The aggregate exited **0** in **196.0 s**: workspace, root/support, bridges and
protocol-lockfile groups all passed. Durable passing summary:
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.z71WBd/summary.json`.
The previously intermittent Claude case did not fail in these aggregates; its
existing open flake record is retained without claiming a root-cause fix.
All validation/scenario processes finished and the source worktree was clean.
No production backend, service manager or real application data was used.

The Docker qualification below remains the last Docker run; this follow-up
changes the standalone installer and schedule label formatting, not firewall,
container lifecycle or bridge behavior. Native Linux/rootless, enabled IPv6,
older-image and live-provider qualifications were not added by this follow-up.

## Egress review findings repaired (2026-11-05)

The five review findings were repaired in source commit
`9ffb0fe96c85388e942a3d0dff936053b024e0fa`, rebased onto `main` at
`251f772d6000dc0c64cbeadc705db719554d8c5d`. Follow-up
`e5705cfe1ffc5a1ddc12f72614dc2ddffadfb5ea` corrects a stale Docker
browser selector from button to tab; the saved accessibility tree showed
the coordinator conversation was already present as a selected tab.

### Behaviour and decisions

- **HTTP classification:** keep an incomplete textual method/request line
  subject to HTTP parsing when raw UTF-8 target bytes arrive. Treating it as
  another protocol could bypass Host checks on named non-443 ports; rejecting
  every non-ASCII target would unnecessarily reject requests origins accept.
  Existing classification size and time limits still apply.
- **DNS/TCP backpressure:** allow one outstanding answer per client and stop
  reading/starting queries until it drains. This bounds queued output to one
  65,537-byte framed response and preserves pipelining. A queue of multiple
  answers could offer more concurrency but needs separate byte admission and
  ordering logic; the single-answer approach matches the existing sequential
  upstream processing.
- **Allowlist edits:** stage proposed names for DNS-only lookups while retaining
  the old connection permissions; publish final permissions after the address
  rebuild succeeds. Publishing a union of TCP permissions would grant access
  before commit, while replacing permissions early could revoke streams even
  on failure. DNS staging temporarily permits lookups of explicitly proposed
  names; failure restores the prior names and periodic refresh clears staging
  left by an interrupted edit.
- The policy-2 status now explains that name checks require policy 3 and removal
  of the override. The firewall test now distinguishes positive port-53 rules
  from the proxy rule's negated destination port.

### Regression evidence

Socket-backed tests cover every UTF-8 request split, allowed and refused Hosts,
a blocked DNS reader, bounded response admission, pipeline continuation and an
independent client. The shell/daemon fixture reloads staged names while an old
stream is active, verifies its continued use and denies proposed TCP permissions,
then checks successful commit or failure restoration. Status tests cover the
policy-2 unavailable state. Browser coverage exercises each status, reloads,
normal/narrow viewports and horizontal bounds; screenshots are in
`output/visual-previews/egress-policy2-*-card-*.png`. The live owner also sends
raw UTF-8 HTTP requests one byte at a time and checks they never reach the origin.

All commands use `mise run test:logged`:

- At `9ffb0fe96`: focused daemon/firewall/slow-policy owners passed;
  status owner passed; `e2e/EnvironmentNetworkPolicy.spec.ts` passed.
  `mise run typecheck`, `mise run format:check`, `mise run lint` and
  `mise run build` passed. The exact-head image build and final-image smoke passed.
- The live egress file initially failed after worker restart, then the complete
  unchanged file passed alone in 33.7 s. Both observations remain in
  [flake 9833](../tests/flaky-tests/environments-and-containers/9833-egress-worker-restart-dns-timeout.md).
- The default suite at `9ffb0fe96` exited 1: protocol standalone-install ENOENT,
  CLI corrected-reinstall exit 4, two web schedule GMT/GMT+0 mismatches,
  backend coordinator-timer GMT/GMT+0 mismatch, and a Claude persisted-turn
  marker failure. The first five reproduced in complete owning-file runs;
  the Claude owner passed alone and is recorded in
  [1221](../tests/flaky-tests/agent-bridges/1221-claude-resumed-root-preferences-retention.md).
  These implementations are outside the egress repair diff. Root/support
  passed 3,676 tests; the aggregate is not reported as green.
- The first isolated Docker run reached 20 passed, four skipped and one failed
  because its coordinator locator expected a button instead of a tab.
  After correcting that selector, full typechecking, formatting, lint and build
  passed again at `e5705cfe1`.
- At `e5705cfe1`, the required
  `ORKESTRATOR_TEST_NO_PROGRESS_TIMEOUT_MS=600000 mise run test:logged -- --name agent-docker -- mise run test:agent:docker:isolated`
  passed: **21 passed, four skipped, zero unexpected failures, zero flakes**.
  The coordinator switch/hidden-document/reload/two-window scenario passed.
  Image smoke and M8 qualification passed. The runner stopped/reset its
  disposable profile and removed its owned resources; no live profile remains.
  No real provider turn was enabled.

The default suite was not repeated for the final E2E-selector-only commit;
its failing result above belongs to `9ffb0fe96`. Native Linux/rootless,
older-image comparison and enabled IPv6 qualification remain unproved.

Artifacts below the host temporary directory:

- `orkestrator-test-run.2EP93a/egress-fixed-default.log.gz` and
  `orkestrator-test-run.5SrDNz/*.log.gz`: default suite.
- `orkestrator-test-run.LWtglc/egress-fixed-live.log.gz`: initial live failure.
- `orkestrator-test-run.P7P33H/agent-docker.log.gz`: stale-role failure.
The final passing Docker workflow's raw log was deleted by the logged runner;
its durable browser results are
`output/agent-testing/qa-browser-b77dcea1-bdd/browser/results.json`.

## Egress name-check review repairs (2026-11-05)

Image `orkestrator-review-egress:6833fa71`, built from worktree
`egress-sni-dns` after validated commit `328e511c9`, passed the final-image
smoke and the expanded `container-live-egress-filter.test.ts` on Docker Desktop.
The final live run (`egress-live-source-guard`) completed with exit 0 in 82 seconds.
The older-image case remains optional and was skipped because no older image
was supplied; its original evidence below is retained.

The added cases exercise:

- First HTTP requests with leading CRLF, lowercase/custom methods and tabs,
  sent a byte at a time; forbidden Hosts get 403 and the fixture's request
  count does not increase. Client-first EHLO, USER and AUTH commands pass on
  the explicit non-443 port.
- TCP DNS to a fixture address whose TCP port 53 is allowlisted still goes
  through the resolver and returns REFUSED for a forbidden name.
- Both `node` and workload root fail to bind the daemon's UDP port on
  loopback or the namespace address, even with `SO_REUSEADDR`, and cannot set
  `SO_MARK`. The supervisor retains the listening sockets across worker
  restart; 200 bind attempts during that interval all fail.
- Direct UDP/TCP queries to Docker's actual embedded resolver ports, found
  through procfs, receive no answer. Normal allowed resolution still works.
- Two firewall initializations retain the same supervisor and worker, with
  exactly one worker and blocked DNS still enforced.
- Removing a name closes its live HTTP connection while another stays usable,
  without restarting the worker. Unit tests use socket pairs to advance past
  the 30/60-second classification deadlines without waiting in real time.
- A workload sends a forged reply with the exact pending transaction ID and
  socket port from `127.0.0.11` on an unrelated source port; it is ignored.
  Unmarked workload datagrams claiming source `127.0.0.11:53` are rejected
  before loopback acceptance; Docker's genuine replies acquire that source
  port later in POSTROUTING.
  A controlled addressed-upstream fixture also sends replies from the wrong
  port, queries masquerading as replies, wrong IDs and mismatched questions
  before its genuine response. Only the genuine response reaches the client.
- A failed primary UDP resolver falls through to the second; truncated UDP
  falls back to TCP; a primary TCP refusal or a primary that accepts without
  answering falls through to the second protected resolver. Forbidden names
  never reach the fixtures.

The daemon keeps non-reusable UDP listeners in its supervisor and uses one
connected, marked UDP socket per pending query (bounded by 1,024), with a
cryptographic transaction ID and response/question validation. TCP retries
are bounded by the protected resolver list and a per-attempt timeout.
Native rootful Linux and rootless Docker were not run on this Mac; the existing
Linux CI workflow and [6101](../todo/containers-and-environments/6101-egress-name-checks-platform-coverage.md)
retain those qualification requirements. These results do not claim prevention
of domain fronting, encrypted names or data sent to an allowed service.

## Egress name checks on Docker Desktop (2026-11-05)

S-0100 (security finding M12): the egress gateway's name checks
(`egress-filter=1`, `docker/orkestrator-egress-filter.pl`), on Docker Desktop
29.9.2, macOS, Apple Silicon (LinuxKit 7.0.14, cgroup v2, iptables 1.8.11 on
nf_tables), from worktree `egress-sni-dns` at base `704809a20`. Image
`orkestrator-s0100:filter`, built from the worktree with the capability label
(`egress-filter=1`); older image `orkestrator-v2:dev-01c4621f8529`
(`egress-gateway=1`, no `egress-filter`), read only.

- `container-live-egress-filter.test.ts`: 4 pass, 0 fail, 66 assertions,
  24 s. An allowed name over TLS answered 200; the same Cloudflare address
  asked for `tenant.<run>.invalid` failed with `tlsv1 alert access denied`
  (curl 35); a foreign Host on the fixture's port 8080 got the gateway's 403
  and never reached the fixture; a 4 MiB upload's digest matched; the
  fixture's banner arrived first on port 2525; GitHub answered `SSH-2.0` on
  22; `c2VjcmV0.exfil.<run>.invalid` got REFUSED with EDE 18 over UDP, over
  TCP and sent to `192.0.2.53`, and `getent` failed; `nodejs.org` added in
  place resolved and answered 200, and a name removed while its address
  stayed allowed got 403; with the daemon's supervisor and worker killed an
  allowed address was refused (curl 7) and DNS reached no server, the
  refresher started it again, and a killed worker was back within 2 s; a
  restart kept the checks. A full-mode runtime had no daemon and no record,
  and a reserved name was not refused. A gateway created with
  `ORKESTRATOR_EGRESS_FILTER=off` recorded `off`, let a foreign Host through
  and kept `off` across a restart without the variable. The older image's
  gateway reported no `egressFilter`, let a foreign Host through, answered
  the blocked name without EDE, and kept that across a restart.
- Before the suite, by hand with a manual gateway and a capability-free
  workload in its namespace: the same cases, plus `github.io` on GitHub's
  Pages address refused at TLS, 21 downloads of a 4 MB tarball with one
  digest, and 40 parallel 7 MB downloads in 34 s through the daemon against
  40 s with no gateway on the same network (the link varied between runs;
  single streams matched). The daemon's two processes held 8 MB of RSS
  each, and the gateway's cgroup peaked at 39 MB of its 128 MiB.
- Existing suites with the new image: `container-live-readiness` 9 pass;
  `container-live-network` 3 pass, 1 fail; `container-live-egress-conditions`
  1 pass, 1 skip (IPv6 not offered), 1 fail. Both failures fail identically
  with the older image and are recorded in
  [6103](../todo/containers-and-environments/6103-live-suite-failures-seen-during-s0100.md).
  C23 (`container-live-firewall.test.ts`) was not run here because it
  contacts `example.com`, which is not on the default allowlist; CI runs it.
- Not run: rootful Linux Engine and rootless Docker
  ([6101](../todo/containers-and-environments/6101-egress-name-checks-platform-coverage.md)).

Created and removed: the image tags `orkestrator-s0100:filter` and
`orkestrator-s0100:iter` (label `orkestrator-s0100=1`), the manual network
`s0100-net-manual` and containers `s0100-gw`, `s0100-wl` (same label), and
each suite run's owner-labelled runtimes, gateways, fixtures, volumes and
networks, which `afterAll` removed and listed again as empty.

## Stop attribution: the drain waited on interactive shells (2026-11-02)

Todo [2150](../todo/containers-and-environments/2150-container-environment-stop-takes-ten-seconds.md).
The roughly 10 s `stop_environment` was not Docker's stop grace. PID 1's
chain (`docker-init` → `sudo` → `sleep infinity`) exits on SIGTERM. The time
went to `orkestrator-drain.sh`, which waited its whole 10 s grace for the
interactive login shell of the setup terminal or a terminal tab. Interactive
zsh and bash ignore SIGTERM. The drain now hangs those shells up with SIGHUP
once everything that can act on SIGTERM has gone. It no longer waits for
SIGTERM-ignoring non-readers. EOF-driven pipe readers retain bounded time to
finish after the hangup pass, and stopped jobs receive SIGCONT after SIGTERM.
`docker/tests/drain-regression.py`, run by `container-drain.integration.test.ts` on Linux,
uses owned processes and real PTYs to cover delayed cleanup before hangup,
stopped jobs, delayed EOF flushing, ignored TERM/HUP survivors, and the shared
deadline without requiring an image.

- **Host:** beelink (Arch Linux, kernel 7.1.8, x86_64, 16 CPUs), Docker
  Engine 29.9.2 rootful, load average 7–20 from other builds.
- **Images:** before, the released `2.34.4-beta` (`ba91a0125f81`); after,
  a local image built `FROM` it with only the working tree's
  `orkestrator-drain.sh` copied in.
- **Bare steps** (`--init`, full mode, 3 runs per case, a container created
  per run): the drain took 63–220 ms with nothing open. With a login shell
  open it took 9.3–10.1 s before the change and 92–195 ms after it. `docker
  stop` took 0.12–0.47 s in every case and always exited 143 (SIGTERM, not
  SIGKILL). `docker stop -t 0` took 0.20–0.72 s, so a shorter timeout saves
  nothing.
- **`stop_environment` through the backend**
  (`container-benchmarks.test.ts -t stop_environment`, a restricted runtime
  with its egress gateway; medians, min–max):

  | Case | Image | Total | Drain exec | Runtime `docker stop` | Gateway `docker stop` | Outside the operation |
  | --- | --- | --- | --- | --- | --- | --- |
  | Idle (n=3) | before | 531 ms (516–1018) | 60 ms | 58 ms | 333 ms | 76 ms |
  | Idle (n=3) | after | 636 ms (630–688) | 97 ms | 71 ms | 376 ms | 75 ms |
  | Login shell open (n=5) | before | 10,422 ms (10,310–10,830) | 9,503 ms | 116 ms | 585 ms | 116 ms |
  | Login shell open (n=5) | after | 645 ms (578–926) | 119 ms | 72 ms | 364 ms | 79 ms |

  The other step is one goal-check `docker exec` of 60–120 ms. Before the
  change, each stop with a terminal open was also recorded as forced,
  because the shell was still there after the drain.
- **C11** (`container-live-qualification.test.ts -t C11`) now opens a login
  shell on a terminal and requires the drain to finish within 5 s of a 10 s
  grace. It passed in 3.3 s against the after image and failed against the
  before image (drain 9.46 s).

## UI response under multi-environment load, first run on a busy host (2026-11-01)

To-do 0022 (retired 2026-11-11) task 3, with the
[probe](#ui-response-under-multi-environment-load) at
`5616f272`. This is a first sample on a busy shared host, not a reference
figure.

- **Host:** beelink (Arch Linux, kernel 7.1.8, x86_64, 16 CPUs, 62 GiB),
  Docker Engine 29.9.2 rootful. Other builds were running on the host
  throughout. The load average was 58.7, 66.1 and 62.7 at the start of the
  three phases, and the host CPU was 97.6–99.9% busy in every phase. All 10
  running containers were this profile's, so the competing load was not in
  Docker.
- **Profile:** `dev:test --fixture-environments container
  --no-agent-credentials --agent-platforms claude --headless-electron`.
  Three busy environments, one target, and the profile's own
  `fixture-container`, all restricted, all under the built-in default (no
  CPU cap, 8 GiB, 4,096 PIDs). There were no provider turns. Default
  options: 2 spin loops per busy container, 20 switches, 3 stop and start
  cycles and a 20 s watch per phase. Headless Chromium at 1440 × 900.
- **Load:** each busy container used 189–193% CPU in the busy phase and
  2–3% in the idle phases.

Medians with p95 in brackets, in milliseconds unless stated:

| Measure | Idle 1 | Busy | Idle 2 |
| --- | --- | --- | --- |
| Row selected and painted | 5.3 (13.8) | 5.3 (13.3) | 7.4 (13.4) |
| `<main>` settled after a switch | 589 (1,067) | 594 (1,015) | 317 (706) |
| Frame interval; stalls over 50 ms | 16.7 (16.7), max 16.8; 0 | 16.7 (16.7), max 33.4; 0 | 16.7 (16.7), max 33.3; 0 |
| Long tasks; slow events | 0; 0 | 0; 0 | 0; 0 |
| Timer lag (250 ms timer) | 0.3 (3.1) | 1.3 (6.6) | 0.3 (3.8) |
| `get_environments` round trip | 13.0 (38.2) | 18.7 (64.8) | 12.1 (31.3) |
| `stop_environment` round trip | 10.9 s (11.2 s) | 11.1 s (11.6 s) | 10.7 s (11.5 s) |
| `start_environment` round trip | 4.3 s (4.4 s) | 5.4 s (5.9 s) | 4.2 s (4.5 s) |
| Sidebar after the stop reply | 63 (64) | 59 (82) | 62 (68) |
| Sidebar after the start reply | 54 (61) | 58 (58) | 43 (49) |

The first visit to each environment, before the phases: selected in
13.4 ms and settled in 115 ms (medians of 4). There were no failures, missed
signals or renderer reloads. The dialogs dismissed were "Docker containers
can't reach Orkestrator", which the host firewall triggers and which was left
unchanged.

On this host, about 5.7 CPUs of container load changed nothing the renderer
showed. Selection painted within a frame, with no long tasks and no stalls.
The sidebar trailed lifecycle replies by about 60 ms in every phase. The
backend slowed against either idle phase: the `get_environments` round trip
rose 1.4–1.5× (p95 1.7–2.1×) and `start_environment` 1.24–1.27×. `<main>` settle times varied
more between the two idle phases (589 against 317 ms) than between idle and
busy, so this sample cannot attribute them to the load. Every stop took
10.5–11.6 s with or without load, against 0.1–0.6 s for the benchmark's bare
`docker stop`; that is recorded in
[2150](../todo/containers-and-environments/2150-container-environment-stop-takes-ten-seconds.md),
which traced it to the drain waiting on the setup terminal's shell
([Stop attribution](#stop-attribution-the-drain-waited-on-interactive-shells-2026-11-02)).

## Egress gateway conditions on Linux Engine (2026-10-31)

Todo 0018 (retired 2026-11-11)
task 3: IPv6, a Docker daemon restart and DNS rotation behind the egress
gateway.

- **Host:** beelink (Arch Linux, kernel 7.1.8, x86_64), host Docker Engine
  29.9.2 rootful. The host daemon was neither restarted nor reconfigured.
- **Disposable daemon:** `docker:29-dind` (Engine 29.9.2) in a privileged
  container with its own volume, reached through a socket in a private
  directory. A supervisor loop restarts `dockerd` when it exits, so
  `kill -TERM` of the inner `dockerd` is a real daemon restart. Its
  `daemon.json` set `default-network-opts.bridge.com.docker.network.enable_ipv6`
  to `true`, address pools `172.30.0.0/16` and `2001:db8:100::/56`, and
  `live-restore` false or true per run.
- **Images:** `orkestrator-v2:latest` (`2.34.4-beta`, revision `f2d21713`,
  firewall and gateway scripts identical to `main` `931e5541`, capabilities
  including `egress-gateway=1`, `network-policy=3`), and
  `orkestrator-v2:q0018-revoke`: that image plus this change's
  `firewall-domains.sh`.
- **Suite:** `container-live-egress-conditions.test.ts`, with `DOCKER_HOST`
  set to the disposable daemon and
  `ORKESTRATOR_LIVE_DAEMON_RESTART_COMMAND` set to a script that restarts
  only that daemon.

Results:
- **IPv6** (12 assertions, passed on both images). The backend-created
  environment network got `2001:db8:100::/64`, and a control container
  without the sysctl reached a peer's IPv6 echo port. The gateway and the
  runtime had no IPv6 address (`/proc/net/if_inet6` empty), `disable_ipv6=1`
  on every interface, and no IPv6 path to the peer as `node` or root. The
  report said `ipv6: blocked`, with `ip6tables -P OUTPUT DROP`. Rerun on the
  daemon without the IPv6 default, with `ORKESTRATOR_LIVE_IPV6_NETWORK=1`
  attaching a ULA network to the gateway before its first start: the same.
  A manual check with `alpine` showed that a container with the sysctl also
  gets no IPv6 on a network connected after it started.
- **Daemon restart**, `live-restore` off (29 assertions, two restarts).
  Runtimes stopped through the backend, and runtimes running when the daemon
  stopped, came back with neither container running and nothing started by
  Docker. `docker start` of the runtime alone was refused while its gateway
  was stopped. The backend's start path restored both in order: `CapEff` 0,
  the report `applied`, `-P OUTPUT DROP` with the final REJECT, IPv6 off,
  `registry.npmjs.org` reachable and `example.com` rejected (exit 7).
- **Daemon restart**, `live-restore` on (37 assertions). Both containers kept
  running in the same namespace (gateway `StartedAt` unchanged). The same
  checks passed, a manual `update-firewall.sh --refresh` succeeded through
  Docker's re-created embedded DNS, and `prepareEgressGatewayForStart`
  returned `ready`.
- **DNS rotation.** A resolver inside the gateway answered `rotate.test` with
  local echo peers' addresses, and the trusted `resolv.conf` pointed at it.
  First answer: 21,600 s timeout, refresh delay 300 s for a 30 s TTL. After
  the rotation the new address got its own six hours, and the old one was
  carried with the rest of its own. Its open connection was not revoked.
  Over five swaps, a watcher probing every 50 ms never opened the unlisted
  peer and was never refused by the carried one. A 4000 s TTL capped the
  delay at 1800 s. With the old address's recorded expiry moved to four
  seconds ahead, one refresh carried it with a four-second kernel timeout,
  and the kernel dropped it on time with no refresh running. New connections
  were then refused. **On the release image, a connection opened before the
  expiry kept working through the next refresh**: revocation compared only
  live-set members, and the kernel had already removed the expired one.
  Fixed in `firewall-domains.sh` (the members are recorded at each
  application and included in the next diff). On `q0018-revoke` the
  connection is cut at that refresh, and all 25 assertions pass.
- **One full run** on `q0018-revoke` (IPv6 default, `live-restore` off): 3/3,
  66 assertions, 71 s, no leftovers.
- **Fix against the existing suites.** `container-live-firewall.test.ts` on
  `q0018-revoke` passed 2/2 on the host daemon, in its own labelled networks
  (C23 edits, revocation, refresh, restart, published ports and gateway
  restart; the policy 3 tuples). On the disposable daemon the tuple test
  passed. C23 stopped only at its published-port fetch, which goes to the
  test host's `127.0.0.1` rather than the nested daemon's.
- **Default developer run.** On the host daemon without the opt-ins: IPv6
  logged "not covered" and created no IPv6 network (host IPv6 forwarding
  stayed 0), DNS rotation passed, and the restart case skipped.
- **Not covered:** a rootless daemon restart (0018 (retired) task 2), external IPv6
  reachability (the disposable daemon had no IPv6 uplink; the control
  container proved the IPv6 path on the network itself), and a real CDN's
  rotation over six hours.

Linux Engine CI, recorded from `gh run view` on 2026-10-31. Run 40999226305
(head `79c35c0b`, 2026-10-30, Engine 28.0.4, image with `egress-gateway=1`)
passed every step on `ubuntu-24.04` and `ubuntu-24.04-arm`: replacement
12/12, network 4/4, firewall 2/2, readiness 9/9 on each runner. Run
40338400817 (`e8306626`, 2026-10-26) passed the same steps, and runs
40746551838 (2026-10-28) and 40799843615 (2026-10-29) passed too. The workflow
now also runs `container-live-egress-conditions.test.ts` with
`ORKESTRATOR_LIVE_IPV6_NETWORK=1`; the daemon-restart case stays manual.

## Bounded readiness probe on omarchy-hp, and a blocked reference-host run (2026-10-30)

Todos [0870](../todo/containers-and-environments/0870-container-start-poll-quantisation.md)
and [0729](../todo/containers-and-environments/0729-container-benchmark-target-misses.md)
task 5. Host: omarchy-hp, the reference host (Linux x86_64, 12 CPUs, Docker
Engine 29.9.1, rootful, host uid 1000). Image
`orkestrator-v2:qual-0870-cd7bbe3e` (`sha256:52af95deb105…`, `main`
`cd7bbe3e`), built with `docker/build.sh`. The change is backend-only, so
one image serves both sides.

**No benchmark or live-suite numbers.** The daemon's address pools were
full: 29 unattached probe networks leaked on 2026-10-28, before #1419's fix
(see to-do 0241, retired 2026-11-10),
hold all 31 default ranges. They belong to other runs and were left alone, so:

- the benchmark at `cd7bbe3e`, before the change, failed its first fresh
  start at the network create (`resource-exhausted`) after 6 s;
- the live readiness-fault suite, with the change, failed all 9 cases the
  same way (0 pass), two of them after their 300 s waits;
- each run's own cleanup removed its volumes, and nothing it created was
  left.

**What was measured instead.** Containers of the image on
`--network none`, started and removed by a run label, with the backend's
own probe functions:

| Check | Before (one exec per 250 ms poll) | After (bounded in-container wait) |
| --- | --- | --- |
| Full-mode `docker start` to current-boot ready, 8 alternating rounds | median 364 ms (354 to 744), 2 execs (one round 3) | median 329 ms (264 to 343), 1 exec each |
| Restricted boot without `NET_ADMIN` (firewall fails closed), 3 starts | not run | `failed firewall-failed` in 352 to 474 ms |
| Stale ready record (another `pid1Start`), 1 s window | — | `pending` after 1.10 s: no early stop |
| `docker restart -t 0` 300 ms into a 2 s window | — | exec ended 264 ms after the restart began (`unreachable`) |
| `docker stop -t 0` 300 ms into a 2 s window | — | exec ended 127 ms after the stop began; the next wait reported `container-exited` in 58 ms |
| Gateway firewall report written 700 ms into the wait (`applied`, `failed`, `applied`) | — | seen 16 to 47 ms after the write, 1 read each |

This shows the probe script runs in the image's `sh`, sees a final state
within one 50 ms check, and that a container stopping or restarting still
ends the wait at once. It is not the C09 qualification, and it is not the
benchmark: a full-mode boot with no network is far shorter than a
restricted one behind a gateway, where the old wait took 6 or 7 polls.

### Review follow-up on the same daemon (2026-10-30)

The address-pool limit can be bypassed for qualification without deleting
other runs' resources. A temporary `docker` pass-through on this run's PATH
adds `--subnet 172.16.N.0/24` only to labelled `network create` calls
(N increments under `flock`). Those ranges do not overlap
the host routes or existing Docker networks. Docker's configured upstream
DNS (`172.17.0.1`) did not answer unrestricted containers in an initial
attempt on `10.253.N.0/24`; UFW admits that DNS port only from the usual
Docker ranges. A control resolved GitHub through `1.1.1.1` and reached its
HTTPS endpoint. The pass-through also adds `--dns 1.1.1.1` to this run's
labelled container creates/runs, preserving explicit DNS and `container:`
namespace joins. All other arguments go unchanged to `/usr/bin/docker`;
the real daemon, entrypoints, firewall, backend lifecycle and assertions run
normally, including the internal-network DNS fault. No host configuration
changes. The suites remove their own labelled resources. This does not
qualify automatic address allocation or the host's DNS forwarder, or repair
the older leaked networks.

UFW also admits only specific agent-tools TCP ports. C22 now accepts
`ORKESTRATOR_QUALIFICATION_AGENT_TOOLS_PORT`, which seeds the real workflow
result service's existing port preference in the scenario's private data
directory. The test requires the server to bind that port and retains its
authenticated reply and denied-port checks. Port 35723 was free and already
admitted from `172.16.0.0/12`; the focused C22 rerun passed in 6.3 s. No host
firewall rule was changed.

The image is still `orkestrator-v2:qual-0870-cd7bbe3e`, full digest
`sha256:52af95deb105b608aa9a178837f4c918224efd01d1e36e373633714e420bab33`,
on Docker Engine 29.9.1, Linux amd64.

With that temporary pass-through first on PATH, the live fault command is:

```bash
RUN_LIVE_DOCKER_TESTS=1 \
ORKESTRATOR_QUALIFICATION_IMAGE=orkestrator-v2:qual-0870-cd7bbe3e \
ORKESTRATOR_QUALIFICATION_AGENT_TOOLS_PORT=35723 \
ORKESTRATOR_TEST_NO_PROGRESS_TIMEOUT_MS=2400000 \
mise run test:logged -- --name live-readiness -- \
  bun test --cwd apps/backend --preload ../../tests/setup-node.ts \
  ./tests/container-live-readiness.test.ts --parallel=1
```

The C09 command uses `./tests/container-live-qualification.test.ts
--test-name-pattern C09` instead, with the same image and opt-in variables.

- The full live readiness-fault suite passed all nine cases in one run
  (205.7 s), with no skips: missing firewall, fail-closed gateway startup,
  broken DNS, unwritable status directory, torn status timeout and recovery,
  restart during launch, fail-closed firewall re-run, interrupted setup,
  and the authenticated host-service reply. Cleanup reported no leftovers.
- C09 in `container-live-qualification.test.ts`: four passed (9.5 s),
  including two new cases synchronized with Docker's active `.ExecIDs`.
  A stop or restart interrupts the pending 2 s exec; the stopped container
  refuses readiness and the restarted one accepts only its new boot id.
  The existing stale-record and stop/start cases also pass.
- The live fault run exposed an outdated permission fixture: it had not
  pinned the firewall to the runtime, so the derived image's permission
  change failed its gateway instead. It now uses the same in-container
  override as the other runtime fault fixtures. The complete permission
  scenario passes alone (36.6 s), retaining every launch-refusal assertion.
- Real-shell regressions now execute a pending probe clipped to a 200 ms
  overall deadline and renew an expired 200 ms window into a second exec.
  A gateway regression requires two early unfinished responses to consume
  two `pollMs` intervals before the third, applied response.

Todo 0870 task 2 is qualified on this Linux amd64 daemon. Other platforms
and the repeated benchmark comparison remain outstanding; the Docker call
budget is unchanged. The exact previously failed deterministic aggregate
also passed all four groups (344.9 s); targeted format, lint, backend types
and qualification-document guards passed.

## Benchmarks on Linux Engine CI, and the call and start-time misses (2026-10-28)

Todo [0729](../todo/containers-and-environments/0729-container-benchmark-target-misses.md).
The CI reports below come from GitHub runners (4 CPUs, Docker Engine
28.0.4, built-in default budget), copied here before the artefacts expire.
Bold marks a miss against the targets in [Benchmarks](#benchmarks); the
calls column is judged against the re-baselined ≤ 27.

| Measure (target) | arm64, run 40409285999 | x64, run 40409285999 | arm64, run 40746551838 | x64, run 40746551838 |
| --- | --- | --- | --- | --- |
| Fresh to ready (≤ 3 s) | 2.96 s | **3.40 s** | **3.14 s** | **3.33 s** |
| Docker calls per fresh environment, median (max) | **28** (34) | **28** (34) | **28** (35) | **28** (34) |
| Three concurrent, slowdown (≤ 1.5×) | 1.11× | 1.44× | 1.24× | 1.29× |
| Warm stop (≤ 1 s) | 0.10 s | 0.13 s | 0.13 s | 0.13 s |
| Warm start (≤ 2 s) | 1.90 s | **2.14 s** | **2.28 s** | **2.08 s** |
| 5,000-file copy (≤ 20 s) | 13.0 s | 14.6 s | 17.6 s | 13.5 s |
| Calls per minute, view open (≤ 36) | 24 | 24 | 24 | 24 |
| Followers after grace (0) | 0 | 0 | 0 | 0 |

- Run 40409285999 is the 0109 PR, head `e53ea683`, with images
  `sha256:e12b0404d1888eefd5403c389617c8b809271499a56850ec312561d61bb4f993`
  (arm64) and `sha256:5cadbe5b01855614b93c7f2eb0062836067116dfdd426d918c38ab5f00f344e5`
  (x64).
- Run 40746551838 is the 0728 PR, head `8296d90e`, with images
  `sha256:8e2a89bb96b2ce6f7b8c2e5dbf4714181b944c40901559b19297c56a93c78527`
  and `sha256:c78355c7926ff803b1d8cf462619d37b33b51ccf50338559585ed316f5012258`.
- Nothing on either runtime's boot path changed between the two runs, so
  the arm64 warm-start move from 1.90 s to 2.28 s is runner variance. Earlier
  runs are in 0729.

**Where the calls go.** The attributed harness ran on Docker Desktop 29.9.2
(arm64, 18 CPUs, a host loaded by other work), with workspace images
`orkestrator-v2:qual-0729-79f3bc97` (`sha256:e972d1e6…`, `main` `79f3bc97`)
and `orkestrator-v2:qual-0729-pre0109` (`sha256:492ba204…`, `9791a425`,
0109's parent). Before this change a steady fresh start cost
17 + 2k + R calls:

- 5 for storage;
- 6 for the create: the network inspect and create, the `ps`, the
  gateway's create and GitHub seed copy, and the runtime's create;
- 5 + 2k to bring the gateway up: the runtime's network-mode and state
  inspects, the gateway's inspect and start, and an exec plus an inspect for
  each of the k unfinished firewall polls, plus the final exec;
- 1 for the runtime's `docker start`;
- R readiness execs, one per 250 ms poll.

The first run of a process adds six one-off capacity probes, which is the
34 in CI's maximum.

- 0022's 15 had neither the gateway nor the seed copy.
- The gateway (#1279) added 6 + 2k.
- 0109 added the seed copy, and on CI one more readiness poll.

**Cuts.** This change removes 1 + k calls from every fresh start:

- The runtime's network owner is cached at create.
- The firewall wait inspects the gateway only when its exec fails.

A warm start whose gateway already reported `applied` also skips the second
firewall read. The median for fresh restricted starts went from 31 in the
one run before the change (steady runs 28 to 31) to 24 or 25 in each of the
six runs after it. Warm starts went from 12 calls to 10 or 11. On CI the same
arithmetic gives 24 to 26 calls; the first CI run of this change confirms it.

**Start time.** The runtime's warm start path in the backend did not change
with 0109. The benchmark's warm stop leaves the gateway running, and on the
success path `startDockerContainer` issues one `docker start`. The rise is in
the boot's readiness step, and it is quantised:

- In five alternating runs of the same harness, fresh `startToReady.ready`
  clustered at about 1.50 s (6 polls) and about 1.82 s (7 polls). The
  parent's image mostly took 6 (medians 1.49, 1.51 and 1.52 s); HEAD's
  mostly took 7 (1.83 and 1.82 s).
- Warm-start medians swung from 1.64 s to 2.06 s within each image, so
  warm start showed no stable difference.
- The relay copy that runs when the host user is not uid 1000 costs 13 to
  19 ms per boot (2 to 4 ms with nothing to copy), timed in a throwaway
  container of the HEAD image.
- So 0109's small per-boot cost crosses a poll boundary and costs a whole
  poll period of about 300 ms. CI's 300 to 600 ms rise is one or two
  periods.
- The start-time misses keep their targets, and their reason is recorded
  here. Removing the quantisation is todo
  [0870](../todo/containers-and-environments/0870-container-start-poll-quantisation.md).
  The reference-host run (0729 task 5) is still to do: the 2026-10-30
  attempt was blocked by exhausted address pools (above).

## C14 staged inputs on any host uid, Linux Engine (2026-10-28)

Todo 0728 (retired 2026-11-11, once CI passed; `git show 498b68766:docs/todo/containers-and-environments/0728-container-ci-c14-assumes-uid-1000.md`),
on omarchy-hp (rootful Docker Engine 29.9.1, x86_64, cgroup v2), with the
workspace image `orkestrator-v2:qual-0728-2ddc39c4` (`sha256:d2a42ea4…`,
`docker build $(bun scripts/docker-image-build-args.ts)`). This host's user
is uid 1000. The CI runners' shape (a rootful daemon whose host user is not
uid 1000) was reproduced without changing the host: the test process ran in
an unprivileged user namespace as an inner uid mapped to the user's
subordinate uid 101001 (`unshare --user --mount --map-users=1001:101001:1`,
then `setpriv --reuid=1001 --keep-groups` to keep the `docker` group), so
the staged revision's files belonged to host uid 101001.

- **Before the fix, uid 101001.** The C14 staged-inputs case failed with
  `CommandFailedError: cat: /codex-home/config.toml: Permission denied`, the
  line CI logged in runs 40333566613 and 40409285999.
- **After the fix.** `container-live-replacement.test.ts` passed 12/12 at
  uid 101001 (the relay path) and 12/12 at uid 1000 (no relay). The live
  `staged-input-relay-docker.test.ts` passed 1/1 at uid 1000.
- **The new assertion can fail.** A scratch copy of the case that planted
  the source's `config.toml` in the stopped candidate (what a copying
  migration would leave) failed `Expected: "absent"`, `Received: "config"`.

## Legacy migration without provider databases, Linux Engine (2026-10-26)

Todo 0058, on Arch Linux (Docker Engine 29.9.1, linux/amd64), with images
built by `mise run docker:build:dev --profile todo0058` before and after the
`orkestrator-migrate.sh` fix (`sha256:3eb5e5e4…` and `sha256:dc006c63…`).

- **Cause.** The image ships `/home/node/.codex` and
  `/home/node/.local/share/opencode`, and a legacy runtime that never ran
  Codex or OpenCode has no databases in them. The SQLite relocation steps
  select `*.sqlite*` / `opencode.db*`; with no match the selected listing was
  empty, and the root check's `awk 'NR == 1 { … }'` exits 0 on empty input,
  so the helper reported `status=root-symlink`. Every copied root
  (`.codex/`, `.claude/`, `opencode/`, `workspace/`) was a real directory in
  the raw `docker cp` listing; staged Codex inputs were incidental.
- **Before the fix.** The new C14 case (staged Codex inputs, `POPULATE`
  without databases) failed with `needs-attention: … (root-symlink)` and the
  source kept.
- **After the fix.** Every case in `container-live-replacement.test.ts` passed
  (12/12, run in three batches because the host's address pools were
  exhausted by leaked probe networks, see
  to-do 0241, retired 2026-11-10),
  including the new case and C16's symlinked-root refusal. The live data
  contracts suite passed 2/2.

## Workload budgets and the built-in default (2026-10-25)

To-do 0022 (retired 2026-11-11) chose the
[built-in default](../architecture/container-lifecycle.md#built-in-default)
from these runs of the [workload harness](#workload-budgets) and the
[benchmarks](#benchmarks). Both machines were busy with other work during
every run, so the timings are noisy. The Mac's load average was about 50 on
18 cores (other worktrees' test suites). The Linux host was at about 8 on 12
threads (the user's own Bun processes). Memory and PID peaks, OOM kills and
failures are robust; wall times are not. Peaks are the kernel's
`memory.peak` (which includes reclaimable page cache) and the sampler's
anonymous and `shmem` maxima. "Budget" is the experiment budget of 2 CPUs,
4 GiB and 1,024 PIDs.

Provider turns ran the real Claude Code CLI with real Bash and Read tool
calls (four per turn) against a loopback mock of the Messages API answering
in 1 s, because no credentials were available. That measures the CLI's
process, tools and streaming, not model output, a bridge or another
provider. Authenticated turns through each bridge under the default are
item "0022 (retired) task 4" in the
[manual-test checklist](../todo/manual-test/7568-manual-test-checklist.md).

**Docker Desktop 29.9.2, arm64.** The VM has 18 CPUs and 7.75 GiB, so the
default there is 5,888 MiB and 4,096 PIDs. Image `orkestrator-v2:q0022-arm64`.
Reports: `output/benchmarks/workload-desktop-arm64*.json` on that machine.

| Workload | Condition | Wall | Peak MiB (anon / shmem) | PIDs | Outcome |
| --- | --- | --- | --- | --- | --- |
| Browser, 3 × 2 heavy pages | unrestricted | 14.5 s | 6,046 (4,141 / 1,762) | 379 | clean |
| | budget | 47.7 s | 4,096 (limit) | 373 | **2 OOM kills, 2 page crashes, 8 of 24 rounds failed** |
| | default | 11.9 s | 5,885 (4,033 / 1,741) | 377 | clean |
| Browser, 1 × 2 pages | unrestricted / budget / default | 9.8 / 14.9 / 10.3 s | 2,346 (1,706 / 616) | 136 | clean |
| Provider, 3 CLIs × 3 turns, 36 tool calls | all three | 17.0–17.2 s | 738 (366 / 0) | 57–110 | clean |
| Build: install, typecheck, Vite | unrestricted | 31 s | 4,777 (2,481 / 0) | 206 | clean |
| | budget | 24 s | 3,724 (1,778 / 0) | 67 | clean |
| | default | 54 s | 4,230 (2,238 / 0) | 214 | clean |
| Combined: build, 1 browser, 2 CLIs | unrestricted | 35.1 s | 4,846 (2,925 / 595) | 392 | clean |
| | budget | 41.4 s | 4,096 (limit, reclaiming) | 203 | clean |
| | default | 66.6 s | 5,144 (2,993 / 586) | 387 | clean |

CPU only (2 CPUs, no memory or PID limit), three interleaved repeats: the
one-browser round median rose from 2.55–2.64 s to 3.69–4.57 s, every time.
The build showed no consistent difference (typecheck 10.3–20.3 s against
10.0–11.4 s, Vite 4.4–7.6 s against 3.9–5.6 s): its tools finish in seconds
and contention dominates.

**Linux Engine 29.9.1 rootful, amd64.** omarchy-hp, kernel 7.2.8, 12
threads, 31 GiB, cgroup v2, systemd driver, driven from the Mac with
`DOCKER_HOST=ssh://`. The default there is 8,192 MiB and 4,096 PIDs. The
image was the host's own `orkestrator-v2:dev-f7622900ba3f` (2026-09-28): its
disk had 12 GB free, too little to load a 6 GB current image. That image
ships Bun 1.4.2, so the build workload installed the checkout's Bun 1.4.4
first, untimed (report field `bunReplaced`), and its Chromium and CLI
versions are older than the branch's.

| Workload | Condition | Wall | Peak MiB (anon / shmem) | PIDs | Outcome |
| --- | --- | --- | --- | --- | --- |
| Browser, 3 × 2 heavy pages | unrestricted | 113 s | 5,463 (3,683 / 0) | 292 | clean |
| | budget | 326 s | 4,096 (limit, 18,115 reclaim events) | 294 | clean, 2.9× slower |
| | 8 GiB / 4,096 | 183 s | 5,708 (3,872 / 0) | 282 | clean |
| Browser, 1 × 2 pages | all three | 67–97 s | 1,834–2,014 (≤ 1,394 / 0) | 104 | clean |
| Provider, 3 CLIs × 3 turns | all three | 19.6–20.6 s | 692 (303 / 0) | 57–94 | clean |
| Build: install, typecheck, Vite | unrestricted | 24 s | 4,476 (2,282 / 0) | 168 | clean |
| | budget | 35 s (typecheck 15.1 s against 6.5 s) | 4,096 (limit) | 69 | clean |
| | 8 GiB / 4,096 | 25 s | 4,496 (2,304 / 0) | 154 | clean |
| Combined: build, 1 browser, 2 CLIs | unrestricted | 45.0 s | 6,284 (3,476 / 0) | 271 | clean |
| | budget | 85.9 s | 4,096 (limit) | 173 | clean, 1.9× slower |
| | 8 GiB / 4,096 | 47.8 s | 5,997 (3,203 / 0) | 263 | clean |

On amd64 the same Chromium pages used no `shmem` at all; a direct write to
`/dev/shm` there is accounted (200 MB showed as 200 MB), so this is a real
platform difference, not a sampler gap. On arm64 Desktop the browser held up
to 1.8 GB of `shmem`. That is more than the 1 GiB `/dev/shm` mount, so it
includes memfd shared memory, which counts against the memory limit as well.

**Enforcement.** All three daemons report CPU, memory and PID support:
Desktop's VM, rootful Engine, and omarchy-hp's rootless Engine (systemd
driver, `cpu memory pids` delegated). On the rootless daemon, a container
started with the default's arguments read `memory.max` 8 GiB,
`memory.swap.max` 0, `pids.max` 4096 and `cpu.max` unlimited. Its throwaway
`busybox` image was removed afterwards, leaving the daemon empty, as it was
found. Rootless without delegation is covered by unit tests: the default
creates with no limits and reports the axes.

**Benchmarks, Docker Desktop 29.9.2 arm64**, 18 CPUs, image
`orkestrator-v2:q0022-arm64`, against the targets of the day (the calls
target was 21 before [0729](../todo/containers-and-environments/0729-container-benchmark-target-misses.md)
re-baselined it for the egress gateway):

| Measure | Target | Built-in default | Unrestricted |
| --- | --- | --- | --- |
| Fresh restricted environment to ready | ≤ 3 s | 2.75 s | 2.56 s |
| Incomplete fresh boots | none | none | none |
| Docker calls per fresh environment | ≤ 21 | 15 | 15 |
| Three concurrent, slowdown | ≤ 1.5× | 1.22× | **1.60×** |
| Warm stop | ≤ 1 s | 0.59 s | 0.61 s |
| Warm start | ≤ 2 s | 1.60 s | 1.62 s |
| 5,000-file copy and verify | ≤ 20 s | 17.5 s | 19.0 s |
| Docker calls per minute, view open | ≤ 36 | 24 | 24 |
| Followers after grace | 0 | 0 | 0 |

The unrestricted run missed the concurrency target once, on the Mac at load
average about 50. Unrestricted is the behaviour before the default, and the
run under the default on the same host met it. Both runs are recorded, not
re-run until they pass.

## Egress gateway on Docker Desktop (2026-10-25)

The backend's egress gateway (todo 0018 (retired) item 1), on Docker Desktop 4.96.3
(Engine 29.9.2, linux/arm64), with a qualification image built from the
branch (`orkestrator-v2:q0018-egress`, capabilities including
`egress-gateway=1`). Every resource used a private owner label and was
removed afterwards.

- Live firewall suite: passed with the gateway (C23 edits, revocation,
  refresh, restart durability; the policy 3 tuple test with a peer on the
  gateway's network) and again with `ORKESTRATOR_EGRESS=in-container`. On the
  gateway `node`'s `CapEff` in the runtime was `0000000000000000` and root had
  no `NET_ADMIN`; `iptables -P OUTPUT
  ACCEPT`, `iptables -F` and `ipset flush allowed-domains` as `orkroot` in the
  runtime all failed and an unlisted domain stayed blocked; `sudo -n
  init-firewall.sh` as `node` was refused; the runtime's boot recorded
  `gateway`; the network status reported `enforcement: gateway`; a port the
  runtime listened on answered the host through the gateway's published
  port. After `docker restart` of the gateway the running runtime lost the
  network (fail closed), `prepareEgressGatewayForStart` answered
  `restarted-gateway`, and after its restart the allowlist held again.
- Live network suite (C22): a restricted runtime behind its gateway reached
  only the backend service port, was rejected by its full-mode sibling, by
  the network gateway address and by a sibling's published port, kept IPv6
  disabled, accepted ingress through the gateway, followed a host-service
  port change across a restart, and freed its network once the runtime and
  gateway were removed. C24 and C26 (full mode) unchanged.
- Live readiness suite: eight scenarios passed in one run (the in-container
  fault injections pinned to `in-container`); the C22 host-service reply,
  whose test had started the runtime with a bare `docker start`, passed once
  it started it through its gateway. A gateway image without
  `init-firewall.sh` refused the start with `not-ready` ("egress gateway
  could not apply"), the runtime never started (`StartedAt` zero), and the
  gateway reported `failed` with `-P OUTPUT DROP`. A bare `docker start` of a
  runtime whose gateway was stopped was refused by Docker itself ("cannot
  join network namespace of a non running container").
- Live replacement: a restricted legacy runtime with a fixed host port
  migrated to volumes behind a new gateway; the source and its gateway were
  kept stopped as the recovery copy, the new runtime bound the same fixed
  host port through its own gateway (`node`'s `CapEff` 0) with identical files, and
  removing the copy removed its gateway. The whole replacement and
  rebuild-fault suites passed in the same run (571 s).
- Not covered: Linux Engine (the `container-live-qualification.yml` workflow
  runs these suites on `ubuntu-24.04` and `ubuntu-24.04-arm` for a pull
  request that changes them), rootless, IPv6-enabled daemons, a Docker daemon
  restart, and DNS rotation beyond the refresh the firewall suite runs.

## Project seed files and gateway reach on Docker Desktop (2026-11-04)

The security report's H3 check, and the reachability question behind accepting
a leaked gateway session (`docs/architecture/remote-gateway.md`, Security notes).

- **Host:** macOS on Apple Silicon, Docker Desktop, engine 29.9.2.
- **Image:** `orkestrator-v2:dev-cc80206a42eb`, network policy 3.
- **H3:** `apps/backend/tests/container-project-seed-docker.test.ts` passed with
  `ORKESTRATOR_SEED_TEST_IMAGE` set: seed files arrive by `docker cp` with private
  `node` ownership.
- **Gateway reach:** a throwaway HTTP listener bound to the host's `127.0.0.1`
  stood in for the gateway, called from inside a container through
  `host.docker.internal`. A second listener was named in
  `ORKESTRATOR_HOST_SERVICE_PORTS` as a positive control. The firewall ran inside
  the container (`firewall-boot` `applied`), not in an egress gateway.

  | Network mode | Gateway stand-in | Named service port | Peer the listener saw |
  | --- | --- | --- | --- |
  | `restricted` | Refused at once | Answered | `127.0.0.1` (named port) |
  | `full` | Answered | Answered | `127.0.0.1` |

  A container's `Host` was `host.docker.internal:<port>`. The peer is loopback on
  this platform, so binding a session to its peer address would not separate a
  container from the browser that signed in.
- **Not covered here:** a rootless daemon and Linux Engine, both run on
  2026-11-05 ([below](#gateway-reach-and-project-seed-files-on-linux-engine-2026-11-05)),
  and a real gateway on a Tailscale address.

## Gateway reach and project seed files on Linux Engine (2026-11-05)

The same two checks on Linux Engine, rootful and rootless: can a container reach
the gateway, which accepting a leaked session rests on, and does H3's delivery
hold when the host user maps to container root?

- **Host:** omarchy-hp, Omarchy (Arch), kernel 7.2.8, x86_64. Docker Engine
  29.9.1: the rootful daemon and the user's existing rootless daemon (systemd
  user service, cgroup v2). Neither was restarted or reconfigured. ufw is active
  and drops unsolicited input; its rules were not changed. Tailscale is up, with
  Tailscale Serve on the tailnet address's port 443.
- **Image:** `orkestrator-v2:dev-a235cdb33b72`, built from `main` at `69a3b4ca5`
  (`network-policy=3`, `egress-gateway=1`), loaded into the rootless daemon for
  the run and removed from both afterwards.
- **H3:** `apps/backend/tests/container-project-seed-docker.test.ts` passed with
  `ORKESTRATOR_SEED_TEST_IMAGE` on the rootless daemon
  (`DOCKER_HOST=unix:///run/user/1000/docker.sock`) and on the rootful daemon.
  The rootless daemon's events list the test's `create`, `extract-to-dir` and
  `start`, and a container there maps uid 0 to host uid 1000. Seed files arrive
  by `docker cp` with private `node` ownership on both.
- **Gateway reach, setup:**
  - The real gateway was a credential-free `dev:test` profile's, bound to
    loopback; it answered `401` from the host. Two throwaway listeners stood in
    for the other bind modes: one on `0.0.0.0` (`--allow-non-tailscale-bind`)
    and one on the Tailscale address (the default bind). Each returned a constant
    and logged its peer. No provider turn ran.
  - The rootful containers are the real product path: `environment create` and
    `environment start` through the CLI, with a restricted runtime behind its
    egress gateway (`node`'s `CapEff` 0, firewall report `applied`, policy 3).
    The daemon had no address range to give: 29 leaked probe networks
    (to-do 0241, retired 2026-11-10)
    fill its pools, so `docker network create` fails with `all predefined address
    pools have been fully subnetted`. Those networks were left alone. Each
    environment's network was created beforehand with the expected name and
    labels on an explicit `172.16.0.0/16` subnet, which `ensureEnvironmentNetwork`
    adopted. A first try on `10.226.61.0/24` failed closed with `not-ready`
    because ufw dropped the gateway's DNS from that range.
  - The rootless containers were started by hand with the backend's arguments: a
    gateway (`--user root`, `NET_ADMIN`, `/run` on tmpfs, `--init`, its own
    network, IPv6 off, `ALLOWED_DOMAINS=none`, report `applied`, policy 3) with
    the workload joining its namespace, and a plain container with the
    `host-gateway` alias for `full`, where the firewall does nothing.
  - Probes ran as `node` with `curl`. Port 443 was a TCP connect only, so no
    request reached Serve. `curl` exit 7 is refused or rejected, 28 is a timeout.
    Every `Rejected` cell below failed at once (exit 7, or a failed connect on
    the TCP row).
- **Rootful result:**

  | Target, from inside the container | `restricted` | `full` |
  | --- | --- | --- |
  | Real gateway (loopback), by `host.docker.internal`, network gateway, `docker0`, LAN or Tailscale address | Rejected | Timed out: ufw |
  | `0.0.0.0` stand-in, by `host.docker.internal`, network gateway, LAN or Tailscale address | Rejected | Timed out: ufw |
  | Tailscale stand-in, by its address | Rejected | Timed out: ufw |
  | Tailscale Serve, TCP connect to 443 | Rejected | Timed out: ufw |
  | The container's own `127.0.0.1` at the gateway's port | Refused | Refused |
  | Backend's named service port (positive control) | Timed out: passed the container firewall, then ufw | Timed out: ufw |
  | A port ufw admits (the host's agent-tools port), TCP connect | Not tried | Connected |

  The gateway container's `OUTPUT` `REJECT` counter rose from 4 to 17 over the
  restricted probes, so the refusals came from the firewall. The ufw log for the
  `full` probes reads `IN=br-… SRC=172.16.62.2 DST=172.16.62.1`: the host sees a
  container's own address, not loopback as on Docker Desktop. It logged three of
  the blocked probes, as ufw's logging is rate-limited.
- **Rootless result:** slirp4netns dials from a host process, so ufw does not
  stand in the way.

  | Target, from inside the container | `restricted` | `full` |
  | --- | --- | --- |
  | Real gateway (loopback), by `host.docker.internal`, network gateway, `10.0.2.2`, LAN or Tailscale address | Rejected | Refused |
  | `0.0.0.0` stand-in, by `host.docker.internal` or `10.0.2.2` | Rejected | Refused |
  | `0.0.0.0` stand-in, by LAN or Tailscale address | Rejected | **Answered**, peer is the address dialled |
  | Tailscale stand-in, by its address | Rejected | **Answered**, peer `100.71.88.77` |
  | Tailscale Serve, TCP connect to 443 | Rejected | **Connected** |
  | Backend's named service port, by `host.docker.internal` | Exit 7 | Exit 7 |

  Host loopback is off on this daemon, which is the documented rootless limit
  ([container lifecycle](../architecture/container-lifecycle.md#agent-tools-reachability-container-host-reachabilityts); todo 0109, retired on 2026-11-10);
  the named port there cannot serve as a positive control. The `full` column is
  the control: everything it reached, the restricted container could not. The
  gateway's `OUTPUT` `REJECT` counter rose from 2 to 14 over these probes.
- **What this means:**
  - A restricted container is refused at the gateway on both daemons, whichever
    host address it tries, so accepting a leaked session still holds. Nothing
    needed fixing.
  - A `full` container reaches a gateway bound to a host address when the host's
    firewall lets it. On rootless that needs no rule at all. On rootful, ufw was
    the only thing in the way here, and that is host configuration rather than
    something Orkestrator sets.
  - Peer binding could separate a rootful container's own address from a
    browser signed in from loopback or LAN on a direct gateway bind. Coverage
    would be partial: the peer is the host's own address on rootless, and
    loopback through Serve and on Docker Desktop. The acceptance rests on the
    observed restricted-firewall refusals within this run's limits, rather than
    on peer binding being ineffective everywhere.
  - Rootless observations apply with host loopback off. Enabling it is expected
    to expose loopback-bound host services too, potentially including the
    gateway. Neither that reach nor the restricted firewall's protection in
    that configuration was qualified; the named service port also lacked a
    positive control in this run.
- **Not covered:** a real gateway on a Tailscale address (the restricted result
  does not depend on it, since the firewall rejects before any listener); a
  rootless daemon with host loopback enabled, including a reachable named-port
  positive control; a rootful `full` container with no host firewall; a runtime
  with the firewall inside it (an older image's); arm64. These remaining checks
  are tracked in [todo 5510](../todo/previews-and-annotations/5510-linux-gateway-qualification-gaps.md);
  host loopback, a firewall-less rootful daemon and a workload firewall were
  run on 2026-11-09 (above).

## Rootless Linux host (2026-10-25)

The first run on a real rootless Linux daemon, not a nested
`docker:dind-rootless`:
- **Host:** Omarchy (Arch), kernel 7.2.8, x86_64.
- **Daemon:** Docker Engine 29.9.1 rootless, run as a systemd user service
  (`dockerd-rootless-setuptool.sh`, RootlessKit 3.3.0, slirp4netns 1.3.3,
  builtin port driver), with the systemd cgroup driver on cgroup v2. The user
  slice delegates only `cpu memory pids`; `docker info` warns that there is no
  cpuset or io support.
- **Image:** `orkestrator-v2:q0021-rootless-amd64`. This is the amd64 review
  build `orkestrator-v2:review-ede1e368-amd64` with two files from the todo
  0021 branch (`e6440483`) laid on top: `entrypoint.sh` and
  `orkestrator-migrate.sh`, the only container scripts that differed from it.
  Its manifest matches the branch's except `appVersion` (2.29.0-beta). It was
  streamed into the rootless daemon because the host had 13 GB free.
- **Command:** each suite as in [Suites](#suites), from a clone of the branch,
  with `DOCKER_HOST=unix:///run/user/1000/docker.sock`.

| Suite | Result |
| --- | --- |
| Live lifecycle (C09, C11, C12, C20) | 5/6. Both C12 volume tests pass. C20 fails: see staged inputs below |
| Live replacement (C14–C19) | 10/10 |
| Live data contracts (volume xattrs and capabilities, OpenCode accounts) | 2/2 |
| Live network (C22, C24, C26) | 3/4. C24 budgets pass with `cpu memory pids` delegated. C22 fails on host-service reachability, below |
| Live firewall (C23, policy 3 tuples) | 2/2: `ip_set`, `xt_set` and `nf_tables` were loaded on the stock kernel |
| Live readiness faults | 5/8. The two C09 boots fail on a fixture `/tmp` mount, below; C22 host-service reply below |
| Live rebuild faults (C15) | 4/5 in the sequence, then 5/5 on a rerun; the failure is a port collision, below |

Volume storage, migration, rebuild, restore, capacity and the fault paths all
pass on rootless. That qualified `volume-v1` there, and
`ORKESTRATOR_CONTAINER_STORAGE=legacy-layer` was removed. The rootless gaps
this run found were tracked in todo 0109, retired on 2026-11-10 once all four
were fixed and requalified (the 2026-11-09 re-run above); the rootless gaps
left were 7548 (fixed and retired on 2026-11-10; see
[its run](#gvisor-tap-vsock-host-loopback-7548)) and [7549](../todo/containers-and-environments/7549-rootless-docker-cp-refusals.md):

- **Staged inputs are unreadable (C20).** The staged revision is owned by the
  host user and is owner-only (`0700`/`0600`). Under rootless the host user
  is container root, so the container's `node` user cannot open
  `/codex-home`. A minimal reproduction got `Permission denied` even for a
  `0644` file inside a `0700` directory. A provider's login and
  configuration silently do not arrive. Nothing leaks.
- **The agent-tools port is unreachable (C22).** `host.docker.internal`
  resolves inside RootlessKit's network namespace, which has host loopback
  disabled by default. The probe was refused (curl exit 7), and
  `container-host-reachability` reported the path closed (`host=blocked`), so
  the product says so rather than hanging.
- **A read-only file bind from a `nosuid,nodev` mount fails.** Docker
  refuses it with `remount-ro … operation not permitted`. The fixtures staged
  the GitHub ranges seed under a tmpfs `/tmp` mounted that way; with `TMPDIR`
  on the home filesystem both C09 tests pass. A data directory on a
  `nodev`/`nosuid` filesystem, such as a separately mounted `/home`, would
  fail the same way in production.
- **An ephemeral published port can collide with a host process (C15).**
  Rootless dockerd chooses the port inside its namespace and RootlessKit then
  binds it on the host. The candidate got `127.0.0.1:33169`, which the
  host's own running Orkestrator Claude bridge held, and the rebuild failed
  `port-conflict` with the original kept. The rerun drew other ports and
  passed.

### Rootless follow-up (2026-10-26)

The fixes for those gaps were exercised on the same host and daemon build
(Docker 29.9.1, runc 1.5.2, RootlessKit 3.3.0, slirp4netns 1.3.3) without a
full environment image: the host had 16 GB free and runs a live Orkestrator,
so the image was not rebuilt there. Each check ran the branch's own code
against the user's rootless daemon (host loopback disabled, the default) or a
disposable second rootless daemon started with
`DOCKERD_ROOTLESS_ROOTLESSKIT_DISABLE_HOST_LOOPBACK=false` under a temporary
`XDG_RUNTIME_DIR` and data root, removed afterwards.

- **Staged inputs.** A real revision from `stagePortableInputs` (Codex,
  Claude, Git), bound read-only into a `debian:bookworm-slim` container with
  a UID 1000 `node`: the mounts showed `root:root 0700/0600` and `node` got
  `Permission denied`. The branch's `relay_staged_inputs`, run as root with the
  real `setpriv`, produced `node`-owned `0700`/`0600` copies under
  `/run/orkestrator-inputs`, and the entrypoint's `staged_input_path` and
  `copy_agent_file` imported `~/.codex/auth.json` and `config.toml` (`node
  600`) and the Git identity from them. On the rootful daemon the same
  mounts showed `node 600`, `node` read them directly and no relay was made;
  the host revision stayed `0600`.
- **Agent tools.** The real `ContainerHostReachabilityService` against a
  loopback listener: with host loopback enabled, `host-gateway` was refused on
  both networks and `10.0.2.2` answered on both, so the verdict was
  `reachable` with `hostAddress` `10.0.2.2`; on the user's daemon `10.0.2.2`
  gave busybox's `Network unreachable` (now classified `unreachable`; it was
  `error` before) and the verdict was `blocked` with the rootless remediation.
- **Read-only binds from `nosuid`/`nodev`.** Not reproduced: file and
  directory binds, `--mount …,readonly` and `-v …:ro`, from the tmpfs `/tmp`,
  `/dev/shm` and `/run/user/1000` (all `nosuid,nodev`), alone and with the
  runtime's and gateway's other options (`--init`, `--tmpfs /run`, own
  network, sysctl, `NET_ADMIN`, `--read-only`, volumes), all mounted. The
  GitHub seed is now copied in rather than bound, and a refusal elsewhere is a
  typed error naming the mount.
- **Port collisions.** Rootless dockerd hands out automatic ports
  sequentially, so the next one was held by a host listener. The first start
  failed with `RootlessKit PortManager.AddPort(): listen tcp4
  127.0.0.1:<port>: bind: address already in use`, and that failed start
  detached the container from its network: a bare second start ran it with
  no network and `Ports={}`. `startDockerContainer` reconnects the network
  and retries; live, on the default bridge and on a user network, the retry
  ran with an address and fresh ports for both mappings. A collision on a
  fixed port was returned without a retry.

### Rootless review qualification (2026-10-26)

The review follow-up ran on a disposable **host** rootless Docker 29.9.1
daemon (RootlessKit 3.3.0, slirp4netns, builtin port driver), launched by a
delegated user service with host loopback enabled. Its socket and execution
state were private under `/run/user/1000`, its data root was on tmpfs, and
the user's daemon and configuration were left alone.

The full environment image was `orkestrator-review-rootless:d03790`
(`sha256:407894b5befe…`), carrying `staged-inputs=3`. Its installed
`entrypoint.sh` and `network-policy-entrypoint.sh` matched this checkout
byte-for-byte (SHA-256 `a5da5071…ba461` and `eb385fec…ffe24`). This was an
existing complete image with older pinned agent versions, not a fresh
toolchain build; the claims below concern the installed bootstrap scripts
and current backend lifecycle code, with synthetic credentials only.

- **C20:** passed, including actual rootless UID mapping, relayed Claude
  plugin settings, shipped bridge readiness, credential revocation and a
  restart that did not restore the revoked credential.
- **C22 network:** passed behind the real egress gateway after the fixture
  adopted production host discovery. The selected host-service port answered
  through `10.0.2.2`; unrelated host ports and sibling access were refused.
- **C09/readiness and C22 authenticated service:** three passed with
  `TMPDIR=/tmp` on `nosuid,nodev` tmpfs: interrupted status write, restart
  during launch, and the real agent-tools HTTP/MCP reply.
- **Every staged mount:** all 13 declared mounts passed through the full
  image bootstrap and workspace setup. Node could read none of the raw input
  files and could read every relayed copy. Imported provider configuration,
  Claude credentials/JSON/plugin settings, Git identity and project inputs
  matched, while every host file stayed `0600`.
- **Start recovery:** four passed, including a genuine fixed-port bind
  collision and two injected collision failures that disconnected real
  Docker endpoints, followed by successful HTTP publication. Both initial
  start and restart paths ran. Network IDs as well as names are recognized.
  A two-file parallel run with the all-mount suite also passed (five tests).
- **Read-only remount:** the daemon accepted the file bind from tmpfs and
  the test proved even root could not write it. The user's rootless daemon
  with on-disk storage also accepted it in a tiny disposable fixture. The
  historical refusal was not reproduced; its typed classification remains
  covered with the captured error, and the live test checks it when returned.

The start and all-mount suites now run in the Linux amd64/arm64 qualification
workflow as well. Use the command table above through `mise run test:logged`,
with `--parallel` and `DOCKER_HOST` selecting the disposable daemon.

The rootless Docker browser fixture initially finished with 11 passed, four
skipped (live provider credentials required) and three failed. Two failures
were the settings test's ambiguous `Applied by Docker` text locator: the
rootless explanation also contains that text. The selector now matches the
label exactly, and the complete settings owner passed (three tests, 59.9 s).
The remaining failure is the existing annotation-filename expectation in
`web-annotations-gateway.spec.ts:904` (request ID versus its sanitized hash),
outside these runtime changes. The disposable application profile and daemon
were stopped and their resources removed afterwards.

Format, lint, typechecking and the focused runtime regressions passed. The
non-iOS aggregate also ran; the existing OpenCode research-server test timed
out after 40 seconds, and its complete unchanged owner timed out alone
(40.8 s). The same host/main failure is recorded in
[0785](../tests/flaky-tests/coordinator-and-multi-review/0785-opencode-research-server-registration-timeout.md).
No timeout or assertion in that unrelated test was changed.

### Validation follow-up (2026-10-26)

The two remaining validation failures were subsequently addressed. Both
local and Docker annotation evidence tests now expect the full request hash
in materialized filenames, matching the existing collision-resistant
ownership format. The local case passed (3.5 s), and the full rootless
`test:agent:docker` suite passed (14 passed, four live-provider skips,
160.1 s) against the same complete environment image in a new disposable
host daemon and application profile. Those resources were removed afterwards.

The OpenCode test's initial HTTP readiness request could remain pending
past its own 20-second deadline. It now uses the backend's bounded health
probe before bootstrapping MCP and gives the MCP response and body the
remaining readiness budget. The unchanged permission/registration
assertions passed once and in ten stress repetitions; see the resolution
in [0785](../tests/flaky-tests/coordinator-and-multi-review/0785-opencode-research-server-registration-timeout.md).

The final non-iOS `mise run test` passed all four groups (380.2 s).
Formatting, lint, typechecking and the flake-registry integrity check also
passed. The earlier aggregate and Docker limitations above are historical;
the completed follow-up has no failing validation checks.

## Docker Desktop on Apple Silicon (2026-10-23)

The full live set, now six suites, ran on Docker Desktop 4.95.0 (Engine
29.8.2) on the same Apple M5 Pro host, native arm64, with the development
image built from `06297124` (`sha256:18aae789…72d6`). Every suite passed;
the two new fault suites passed twice each. The pass found and fixed nine
product problems, two of them in the rebuild copy (an outage could commit an
empty candidate; a lost daemon could hang a rebuild forever) and one in
read-only mode (delete and allowlist edits ignored a newer writer's marker).
C13 now passes for Codex, OpenCode, Cursor and Pi; the full-network fixture
and root terminal passed `test:agent:docker`; and every benchmark target was
met at load 18. Rootless was exercised in a nested `docker:dind-rootless`
only. Evidence and decisions are in to-do 0019's "Results, 2026-10-23" (retired;
`git show 498b68766:docs/todo/containers-and-environments/0019-container-platform-qualification.md`).

## Docker Desktop on Apple Silicon (2026-10-17)

The full live set ran on `main` at `31d0fb06` on Docker Desktop 4.93.0 (Engine
29.8.1, API 1.56, linuxkit 7.0.14) on macOS 27.0, Apple M5 Pro, 18 CPUs, with
the Desktop VM reporting 8.3 GB. Everything was native arm64; nothing came from
emulation. The image was the isolated development image
`orkestrator-v2:dev-b4d6266ccb00`
(`sha256:3f4603f57e80d06b9799aa91bdf9ae421cb51a3e0c72e01cd180cddc4269457c`,
manifest source revision `31d0fb06`). Results:

- Final-image smoke (C27, arm64 half): passed.
- Live lifecycle 6/6, replacement 10/10, network 4/4 and firewall 2/2, with
  nothing skipped. Two clean runs each, the first through `test:logged`.
- Benchmarks: every target in the table below was met (the per-run figures
  are in the todo file). The host was under heavy load from other runs.
- `test:agent:docker`: 5/5 (C29, container settings at both widths, foreign
  profile refusal, Playwright launched as both container users). In the live
  approval spec (C11 approval half, a real Claude turn) the approval was
  never granted. Two of its first five end-to-end runs then hit
  "Connection Failed" when the restored Claude tab reconnected. The cause
  was a teardown intent that the stop's pane reset left pending, which closed
  the session after the restart. With that fixed, 4 of 4 runs passed.
- `test:agent:browser:isolated` (C30): every local-worktree scenario passed.
  The only failure was the narrow host picker, known flake 0224, which passed
  alone.

On Desktop the `host.docker.internal` path works without the host-gateway
alias, IPv6 is blocked, and siblings are refused through their IP, the
environment gateway and a published port (C22). `docker info` reports the
VM's capacity, not the Mac's. Volume sub-path mounts work (Engine 29.8.1), and
cgroup v2 CPU, memory and PID limits are enforced (C24). The host has Homebrew
GNU `tar` and `date`.

This run caught two problems. Three of the opt-in Docker suites (lifecycle,
network and the benchmark harness) had not kept up with account switching
(#889). And a stopped container lost its agent tabs
from view when it was started again. Both are fixed. Detail and decisions are
in to-do 0019 (retired; `git show 498b68766:docs/todo/containers-and-environments/0019-container-platform-qualification.md`).

## Build-pipeline rewind review evidence (2026-11-01)

The review fixes passed all three live build-pipeline rewind cases on Linux
amd64, Docker Engine 29.9.2, using `orkestrator-v2:dev-3e57790310c6`
(image ID `sha256:d0cc33252a29f76e08cf502d36bde24520346d485355ce0ccc1737c4d56074b7`).
The run completed in 14.5 seconds:

```bash
RUN_LIVE_DOCKER_TESTS=1 ORKESTRATOR_QUALIFICATION_IMAGE=orkestrator-v2:dev-3e57790310c6 \
  mise run test:logged -- --name review-repair-live-rewind -- \
  bun test --cwd apps/backend --preload ../../tests/setup-node.ts \
  ./tests/build-pipeline-code-rewind-docker.test.ts --parallel=1
```

This exercised real container Git backup and reset, restart and lease-push
instructions, refusal while paused, and completion of a journaled reset after
unpause. The providers were harness fakes; no provider turns were taken.
The logged runner reported exit 0 and removed its passing output under the
normal retention policy. Docker Desktop, rootless Docker, and egress-gateway
configurations were outside this focused run.

## Provider-state review evidence (2026-10-16)

The provider-state review fixes were exercised on native arm64 Docker Desktop
(Engine 29.8.1), using the isolated image `orkestrator-v2:dev-e742c2db66c0`
(`sha256:edba185cdc51ffa415e4057bdead0316f4d3900d8cece80a6481c7b2b8ed2f5e`).
The live replacement suite passed all ten C14–C19 tests:

```bash
RUN_LIVE_DOCKER_TESTS=1 ORKESTRATOR_QUALIFICATION_IMAGE=orkestrator-v2:dev-e742c2db66c0 \
  mise run test:logged -- --name live-replacement -- bun test --cwd apps/backend \
  --preload ../../tests/setup-node.ts ./tests/container-live-replacement.test.ts \
  --parallel=1 --only-failures
```

C14 now checks both migration and a subsequent volume rebuild. Real SQLite
files for Codex's runtime and thread-history databases and OpenCode's session
database, including committed rows still in WAL files, reopen at their
relocated paths with identical rows and successful `PRAGMA integrity_check`.
The preserved bridge title index and Grok session
directory survive; Grok's process registry, worktree registry and opt-in memory
directory are excluded as the preview states. The live fixture now supplies an
empty account store, which current container creation requires.

The credential-free `review-state-qa` profile also ran all five Docker browser
scenarios, including switching environments during rebuild and reloading. The
rebuild scenario asserts the displayed Codex, OpenCode and Grok limitations.
Its report is `output/agent-testing/review-state-qa/browser/results.json`.

These checks exercise actual Docker copying and SQLite reopening, with
synthetic provider records. They do not establish compatibility with a
provider's own database schema or qualify authenticated conversation resume
(C13); the existing provider qualification gates and Codex caveat remain.
The profile is stopped and reset after validation.

The full non-iOS suite had one reproducible baseline failure:
`agent-provider-boundaries.test.ts` reports that the unchanged
`http-bridge-provider.ts` has 1,505 lines against its 1,500-line limit (the
same count at `HEAD`). The focused rerun fails identically. The other three
aggregate groups passed, as did formatting, lint, typecheck and the focused
title/preview tests. Full-suite failure evidence is in
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.AQ6yxQ`.

## Scenario matrix

Live test names carry the scenario id.

| ID | Scenario | Proof required |
| --- | --- | --- |
| C01 | Port edit on a legacy environment | No implicit discard; an old client's request fails safely |
| C02 | Routine cleanup with an assigned stopped container | Workspace and runtime remain |
| C03 | Failed removal retaining the original Docker name | Reference retained; no fictitious successful replacement |
| C04 | Foreign-owner id through a raw or gateway command | Refused in production and strict profiles |
| C05 | Two writers and a repeated operation id | One admitted mutation and one durable outcome |
| C06 | Create succeeds, then the backend crashes | Exact resource adopted; no duplicate runtime |
| C07 | Mutable image tag changes mid-operation | Candidate uses the resolved immutable image id |
| C08 | Unsupported remote daemon or old image | Actionable preflight failure before destructive work |
| C09 | Stale marker and delayed current boot | No setup or agent launch before current-boot readiness |
| C10 | Setup interrupted after a possible side effect | No automatic duplicate setup or false ready state |
| C11 | Stop with running descendants, an interactive shell and a pending approval | Bounded drain that hangs up the shell instead of waiting for it; approval never granted; children reaped |
| C12 | Persistent workspace stop/start | Full fixture state retained; real mounts verified |
| C13 | Provider session restore after a rebuild | Correct history and lineage; an ambiguous dispatch stays unresolved |
| C14 | Legacy migration and volume rebuild, including a legacy runtime with staged provider inputs and no provider databases | Verified bytes and Git state; correct workspace generation; inputs staged afresh |
| C15 | Failure at every transaction boundary | One authoritative set; original retained before commit |
| C16 | Disk or inode exhaustion, archive or link corruption | Fails safely without modifying the original |
| C17 | Candidate writes after commit, then a health failure | New work preserved; no automatic restore of the old copy |
| C18 | Cleanup preview races with attachment or commit | Stale selection conflicts; the new assignment survives |
| C19 | Delete interrupted between runtime and volume removal | Tombstone resumes; accurate per-resource counts |
| C20 | Disabled-provider and excluded-history sentinels | Unreadable from every workload-visible input mount |
| C21 | Credential refresh or revoke interrupted | Atomic revision, honest pending state, no secret in diagnostics |
| C22 | Sibling, host, DNS and IPv6 network access | Tested allow/deny matrix; no guessed subnet exception |
| C23 | DNS refresh or removal and firewall failure | Effective revision accurate; no allow-all interval |
| C24 | CPU, memory and PID budget pressure | Limits enforced, cause and scope truthful, sibling usable |
| C25 | Usage unavailable or stale | Shown as unknown or stale, never a fabricated zero |
| C26 | Log churn, large lines and a slow client | Bounded memory, files and processes; explicit replay gap |
| C27 | Final image on both architectures | Every runtime artifact, authenticated bridge and Chromium works |
| C28 | Cold and warm multi-environment runs | Reproducible report within the benchmark targets below |
| C29 | Switch away and reconnect during a long operation | Snapshot restores status, prompts, controls and progress |
| C30 | Local-worktree environment | Non-Docker behaviour unchanged |

## Platform dimensions

A full qualification varies, per platform:

- Linux Engine on amd64 and Docker Desktop on Apple Silicon (the primary
  targets), plus any other Engine or Desktop version the release supports.
  Evidence that came only from emulation is marked as such.
- Restricted and full network mode; ordinary and root terminals.
- Fresh and legacy environments; stopped and active migration.
- Missing image, missing daemon and Desktop VM capacity limits.
- Each of the six providers, for its advertised session preservation and
  startup behaviour.
- Backend upgrade over old images and records, and an older writer's refusal
  of a newer storage format. Rootless behaviour the daemon cannot enforce is
  reported and refused, never silently weakened.

For each scenario, record the fixture revision, image id, platform, command,
result and the private artifact location.

## Benchmarks

`container-benchmarks.test.ts` measures fresh restricted environments (five
sequential, then three at once), ten warm stop/start cycles, preserving
rebuilds of 200 files (0.8 MB) and 5,000 files (about 100 MB), the usage
sampler, Docker calls during one minute with the Docker view open, and 200
log-subscription open/close cycles. Rebuild durations come from the
operation's own `durationMs` and per-phase timings. Fixtures are synthetic;
the report records no commands, paths or contents. It prints a table and
writes JSON to `output/benchmarks/` (git-ignored), removing its own reports
older than 30 days.

Runtimes get the built-in default budget, as on a new install; set
`ORKESTRATOR_BENCHMARK_UNRESTRICTED=1` to run them without limits. The report
records which (`budget`) and the limits Docker applied (`appliedLimits`).

Each report explains its own Docker calls and start time, as counts and
durations only:

- `freshRestricted.dockerCallsByPhase`, `dockerCallsByTarget` and
  `dockerCallBreakdown` give, per completed fresh run, the calls by phase,
  by container (the runtime, its egress gateway, or neither), and by
  `<step> <container> <verb>`.
- `freshRestricted.startToReady.gateway`, `.runtimeStart` and `.ready` split
  the boot into three steps: the gateway brought up to an applied firewall,
  the runtime's `docker start`, and the entrypoint to current-boot readiness.
- `warmStopStart.startSteps`, `startDockerCalls` and
  `startDockerCallBreakdown` do the same for warm starts.

The benchmark's warm stop is the drain and a bare `docker stop` of the
runtime, so its gateway keeps running and a warm start never restarts it.
With no terminal open, the drain has nothing to wait for. The
`stop_environment` case (`-t stop_environment`, its own runtime) times
`stopEnvironmentOnce`, the user's stop: idle, then with a login shell open
the way the setup terminal opens one. It reports the operation's phases,
each Docker call (`dockerCallMs`, a repeated call numbered in order) and the
time outside the operation.

The harness asserts only that rebuilds succeed and no log follower survives.
Compare the report with these targets by hand. They were set on Linux
x86_64, 12 CPUs, Docker Engine 29.7.2, no resource budget, restricted mode
allowing `registry.npmjs.org` and GitHub's ranges. A change that misses one
is fixed, or the reason is recorded, before it merges. The calls target was
re-baselined on 2026-10-28
([0729](../todo/containers-and-environments/0729-container-benchmark-target-misses.md)):
the runtime's own path keeps its budget of 21. The egress gateway, a second
container since 2026-10-25, adds 6 fixed calls: its create, the GitHub seed
copy, the runtime's state inspect, the gateway's inspect, its start, and the
first firewall read. Its firewall polls, one call each, must fit in the old
headroom.

| Measure (median unless stated) | Report field | Target |
| --- | --- | --- |
| Fresh restricted environment to ready | `freshRestricted.total` | ≤ 3 s |
| Incomplete fresh boots | `freshRestricted.incomplete` | none |
| Docker CLI calls per fresh environment | `freshRestricted.dockerCalls` | ≤ 27 (21 for the runtime, 6 for its gateway) |
| Three concurrent fresh environments, each against the sequential median | `freshConcurrent3.slowdownVsSequentialMedian` | ≤ 1.5× |
| Warm stop (drain and `docker stop`) | `warmStopStart.stop` | ≤ 1 s |
| `stop_environment` with a login shell open | `stopEnvironment.terminalOpen.total` | ≤ 1.5 s |
| Warm start to current-boot ready | `warmStopStart.start` | ≤ 2 s |
| Rebuild copy and verify, 5,000 files | `rebuild.medium.copying` | ≤ 20 s |
| Docker calls per minute with the Docker view open | `dockerCallsPerMinuteViewOpen` | ≤ 36 |
| Log followers after the idle grace | `observerChurn.followersAfterGrace` | 0 |

Never clear a user's global Docker or cache state to manufacture a cold run;
"cold" means a new network, volumes and staged inputs per environment.

The reference host for these targets is Linux Engine amd64. Docker Desktop
and arm64 figures are recorded for comparison and are not separate gates:
Desktop met every target under the built-in default, so per-platform
targets would add a table without changing a decision. Revisit that if CI
arm64 or Desktop misses repeatedly on a quiet host.

### Optimisations measured and not taken

Each of these was measured against a stated condition (to-do 0022, retired
2026-11-11) and not built. Revisit one only when its condition is met; a
benchmark miss under the merge-gate rule above is fixed or explained before
merging, and the matching entry here is the first candidate.

- **An in-process tar hasher on the copy's source side.** `copy_stream`
  (`docker/orkestrator-migrate.sh`) hashes each tar member with its own
  `sha256sum`; the destination already batches 256 files per call. Revisit
  when `rebuild.medium.copying` misses 20 s on the reference host or the CI
  runners. Measured: 17.5 s under the default and 19.0 s unrestricted on
  Docker Desktop arm64 at load average about 50 (3.5–3.8 ms per file, both
  sides); 13.0–15.0 s on the 4-CPU CI runners (2026-10-26); 30.7 s on
  beelink saturated by other builds, where every other timed step also
  missed (2026-11-11,
  [Benchmarks on a saturated host](#benchmarks-on-a-saturated-host-2026-11-11)).
  The last is not the reference host and does not meet the condition, but
  the per-member processes are what a busy host slows most. A replacement
  needs its own safety review: the corruption, symlink-root and Git checks
  must still pass.
- **Bun download-cache BuildKit mounts in `docker/Dockerfile`.** The bridge
  `bun install` layer re-ran cold in a local rebuild in 5.5 s (2026-10-25,
  Desktop arm64). It re-runs only when the lockfile, `patches/` or a
  workspace `package.json` changes, because the source is copied after it,
  and CI release builds start without the mount cache anyway. About 5 s per
  dependency change does not pay for the build-cache disk growth and the
  extra Dockerfile syntax.
- **Environment-private dependency cache volumes.** A cold `bun install` of
  this repository (941 packages) in a fresh container took 8.0–19.6 s on
  Desktop and 10.3–11.0 s on Linux; a warm reinstall from the container's
  cache took 1.2–2.2 s and 2.6–3.1 s. Downloads cost about 7–17 s once per
  new environment (`node_modules` lives in the workspace volume, which
  preserving rebuilds copy), so they do not dominate an environment's life.
  Sharing a cache across environments would also need cache-poisoning and
  concurrency analysis.
- **Faster usage samples.** A sample took 2.0 s (median; Desktop arm64, 8
  running containers), nearly all of it `docker stats --no-stream`'s own CPU
  interval. Samples are shared, the visible refresh is 5 s, and the Docker
  view costs 24 calls a minute against a target of 36.
- **Reusing verified input revisions.** Staging sits inside the create step
  and is not a dominant phase. If revisited, revocation must bypass the
  cache, and size or time alone is not proof that secret or configuration
  contents are unchanged.
- **A Docker events watcher for status sampling.** The sampler costs three
  calls per sample whatever the environment count, and the 3 s status cache
  already batches `docker ps`. Events would only ever be hints: a full owned
  snapshot after every gap, with periodic reconciliation kept as the repair
  path.
- **A snapshot or reflink copy fast path.** It is not portable across Engine
  and Desktop storage drivers, and the verified streaming copy is the
  contract.

Never weaken the separate-candidate-copy guarantee for speed: running setup
against the only source volume is not an acceptable shortcut. Rolling back
an optimisation must leave the storage and lifecycle contract intact.

### Workload budgets

`container-workload-budget.ts` measures realistic workloads in fresh
containers under each budget condition, on whatever Docker the machine
talks to. That includes a remote Linux Engine through
`DOCKER_HOST=ssh://user@host`, because all timing happens inside the
container.

```bash
mise exec -- bun apps/backend/scripts/container-workload-budget.ts \
  --image orkestrator-v2:dev-<hash> \
  --workloads browser,browser-single,provider,build,combined \
  --budget budget=2,4096,1024 --budget default=null,8192,4096 [--repeat 3]
```

Each run creates a container with the condition's `--cpus`, `--memory`
(equal `--memory-swap`), `--pids-limit` and the `--shm-size` the backend
would pass, and bypasses the entrypoint. The workloads live in
`apps/backend/scripts/container-workload/`:

- browser: Playwright Chromium, 3 browsers × 2 heavy pages with tall
  screenshots.
- browser-single: one browser, the same 2 pages.
- provider: 3 Claude Code CLIs × 3 turns, each turn making real Bash and
  Read tool calls against a loopback mock of the Messages API. No
  credentials are needed.
- build: this checkout's HEAD. A cold `bun install` from the container's
  own empty cache, then a warm reinstall, a Turbo typecheck and a Vite
  build. An image with a different Bun gets the pinned one first, untimed.
- combined: the build, one browser and two CLIs at once.

A fork-free sampler records peak anonymous memory, `shmem` and PIDs every
250 ms. The kernel's `memory.peak`, `pids.peak`, `memory.events` and
`cpu.stat` are read at the end. The JSON report under `output/benchmarks/`
has sizes, counts and durations only. Containers are labelled
`app=orkestrator-workload-budget` and removed.

The built-in default ([container-lifecycle.md](../architecture/container-lifecycle.md#built-in-default))
was chosen from the 2026-10-25 runs on Docker Desktop arm64 and Linux
Engine amd64. Their results are in
[Workload budgets and the built-in default](#workload-budgets-and-the-built-in-default-2026-10-25).
Rerun them when a workload grows (a new browser default, a heavier build),
before you change the default.

### UI response under multi-environment load

`e2e/perf/multi-environment-ui-perf.ts` times the browser UI while several
container environments are busy. It is a probe, not a test: it has no
targets and fails only when it cannot run. It attaches to a running
disposable profile with container fixtures and never starts an agent
session.

```bash
# In its own long-lived terminal; --headless keeps the profile's
# window out of the desktop session on Linux.
mise run dev:test --profile ui-load --fixture-environments container \
  --no-agent-credentials --agent-platforms claude --headless
# Once `mise run dev:status --profile ui-load --json` reports ready:
mise exec -- bun e2e/perf/multi-environment-ui-perf.ts --profile ui-load \
  [--environments 3] [--workers 2] [--memory-mib 0] [--phases idle,busy,idle] \
  [--switches 20] [--status-cycles 3] [--watch-seconds 20] [--settle-seconds 10]
# Afterwards:
mise run dev:stop --profile ui-load && mise run dev:reset --profile ui-load
```

It adds `--environments` container environments (`ui-load-busy-N`) and a
`ui-load-target` to the fixture project, and signs a headless Chromium in
through `dev:login`. Dialogs such as "Claude Code Is Not Logged In" are
dismissed for that page only, while the shell loads, again before the first
click (some open only once the environments exist) and at each phase start;
the report lists their titles. In each `busy` phase, every
`ui-load-busy-N` container runs a load through `docker exec`, and only after
its `environment-id` label has been checked. The load is `--workers` shell
spin loops (one CPU each), a workspace file rewritten every second, and an
optional `--memory-mib` held by Node. The containers keep the budget the
backend gave them. `idle` phases measure with the same environments running
and no load. Each phase records:

- **watch:** animation-frame intervals, long tasks, slow events (16 ms or
  more), the lag of a 250 ms timer, and the `get_environments` round trip
  from the page, one every 100 ms.
- **switch:** time from `pointerdown` on a sidebar row to the first frame in
  which the row is selected (`selectMs`). The frame time is when the frame
  starts, so this is accurate to one frame and can be slightly negative.
  `settledMs` runs to the last change under `<main>` before 300 ms of quiet.
- **status:** `stop_environment` and `start_environment` on `ui-load-target`,
  sent from the page. Each records its round trip and when the sidebar marker
  showed the result. `stopLagMs` and `startLagMs` are that time minus the
  round trip, so they measure how far the UI trails the reply.
- **host:** load average, host CPU busy from `/proc/stat`, the probe
  containers' `docker stats` CPU and the number of running containers.

Every environment is visited once before the first phase, so phases compare
warm switches; the cold visits are reported separately. The report under
`output/benchmarks/multi-environment-ui/` holds numbers and dialog titles
only, no tokens, paths or contents. The probe deletes its environments, also
on failure. A run is a sample of one host at one time; record the host load
with it.

### Exec cost and container change signals

Two scripts measure what container observation costs, on whatever Docker the
machine talks to. Run each on Docker Desktop and on Linux Engine and record
the platform with the numbers.

```bash
# One docker exec, end to end: wall latency, the docker CLI's CPU and RSS,
# dockerd/containerd/shim CPU (through a --privileged --pid=host helper: the
# host on Linux Engine, the VM on Desktop), whole-machine busy CPU and, on
# macOS, com.docker.backend and the VM process. With --repo also the status
# scan and tree walk; with --watcher (an image with container-worktree-signal)
# the watcher's watches, set-up time, RSS and idle CPU.
mise exec -- bun apps/backend/scripts/container-exec-cost.ts \
  --image orkestrator-v2:dev-<hash> --execs 200 --repo . --watcher

# Against a running isolated profile started with
# --fixture-environments local,container: execs per minute idle and with a
# Files panel reading every 5 s, change-to-announcement and change-to-visible
# latency, and signal health. --demote first stops the container's watcher,
# which is how an image without the signal behaves.
mise exec -- bun apps/backend/scripts/container-signal-profile-sample.ts --profile <p>
mise exec -- bun apps/backend/scripts/container-signal-profile-sample.ts --profile <p> --demote
```

The live signal tests need a development image of the checkout
(`mise run docker:build:dev`) or the CI workflow's qualification image, and
are skipped without one:

```bash
ORKESTRATOR_TEST_STATE_SIGNAL_IMAGE=orkestrator-v2:dev-<hash> \
  bun test apps/backend/tests/claude-state-signal-docker.test.ts \
  apps/backend/tests/claude-terminal-failed-turn-docker.test.ts \
  apps/backend/tests/container-worktree-signal-docker.test.ts \
  apps/backend/tests/tmux-hook-signal-docker.test.ts
```

`tmux-hook-signal-docker.test.ts` proves the claude-tmux hook doorbell
(to-do 1202, task 8) with a fake doorbell on the container's loopback: the
manifest declares `tmux-hook-signal=1`, the install's probe and the hook
script's ring arrive with the right token, and a real tab loop against a real
tmux session in the container, with its transcript bound, stays within four
execs in 10 s idle and never searches for its transcript. Like the
failed-turn test it needs no route from the container to the host.

`claude-terminal-failed-turn-docker.test.ts` runs the image's own Claude CLI,
with the hooks its entrypoint installs, against a fake API on the container's
loopback: a refused turn must leave `working` and ring `agent_failed`, and a
normal turn must still ring `agent_waiting` (to-do 1200). It reads through
`docker exec` only, so unlike the other two it also passes on a host whose
containers cannot reach the backend.

The Linux Engine workflow runs all four tests and the exec-cost script on every
run (`exec-cost-<platform>.json` in the benchmark artifact). The worktree
test's `change-to-scan` line is not a clean latency: it follows a writer
whose close rang just before, so it likely waits out part of the 2 s hint
gap (1.3 to 1.4 s on Desktop and Linux Engine alike). Use the profile sample's
`latencyMs` for change-to-visible.

## Rollout-cap retirement review qualification (2026-11-04)

Worktree `orkestrator-v2-20261104-003145-f5f8c9e82488`, code at `718294df1`
plus the live-start helper repair described below.
The shared rootful daemon still had no free default address ranges; no shared
networks were removed and its configuration was not changed. Instead, a
private host rootless Engine 29.9.2 ran on Arch Linux kernel 7.1.8, using
RootlessKit 2.3.5 (Docker's 29.0.1 rootless extras), VPNKit and builtin port
forwarding. Its socket was `/tmp/ork-retire-f5f8-runtime/docker.sock`, its data
root was private under `output/qualification-retirement/`, and its new bridge
pool was `172.30.0.0/16`, split into /24s. Host loopback was disabled (the
launcher default). This was a host daemon, not nested Docker-in-Docker.

Image: `orkestrator-v2:dev-1e785cae5ca6`, transferred from the shared daemon
without retagging it; id
`sha256:811f06a968ba95efde1302a9b98def04143776e1ad926bf665f4186840107653`.
This is the same complete review image used for the earlier manifest-selection
check, with `egress-gateway=1`, `network-policy=3`, `staged-inputs=4`.
The readiness suite derives its legacy fixtures by removing the manifest's
`egress-gateway` capability; the base image still exercises gateway refusal.
No agents or real credentials were involved.

Commands below used
`DOCKER_HOST=unix:///tmp/ork-retire-f5f8-runtime/docker.sock`, and the first two
also used `RUN_LIVE_DOCKER_TESTS=1` and
`ORKESTRATOR_QUALIFICATION_IMAGE=orkestrator-v2:dev-1e785cae5ca6`:

```bash
mise run test:logged -- --name live-readiness-in-container -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/container-live-readiness.test.ts --parallel=1 --test-name-pattern 'C09|C23'
mise run test:logged -- --name rootless-gateway-firewall -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/container-live-firewall.test.ts --parallel=1
mise run test:logged -- --name rootless-default-loopback -- bun test --preload ./tests/setup-node.ts ./output/qualification-retirement/default-loopback.test.ts --parallel=1
```

- Readiness: **passed 7/7**, 2 unrelated cases filtered out, 192.4 s.
  The missing firewall, gateway refusal, DNS failure, unwritable status,
  torn status, restart-during-launch and firewall re-run assertions all ran
  live against their derived images. This replaces the earlier address-pool
  failure with passing evidence; summary:
  `/tmp/orkestrator-test-run.u21N5t/summary.json`.
- Firewall: **passed 2/2**, 33.9 s. The gateway branch asserts zero workload
  capabilities, refused `orkroot` iptables/ipset tampering, published-port
  access, fail-closed gateway restart and recovery through the backend start
  path, allowlist updates, revocation and policy-3 tuples.
- Default loopback: **passed 1/1**, 14.1 s. The local qualification fixture
  binds an ephemeral host HTTP listener, calls the real
  `ContainerHostReachabilityService`, asserts `dockerRootless: true`,
  `status: blocked` and the `DISABLE_HOST_LOOPBACK=false` remediation, then
  creates/boots a runtime through `createDockerContainer` and
  `prepareEgressGatewayForStart` and asserts the runtime probe is refused,
  unreachable or timed out. Its source is retained in the ignored output
  directory, not added to the deterministic suite. The first attempted
  invocation used the test preload outside `bun test` and failed before any
  probe; the corrected test-runner invocation above passed.

Successful logged summaries: `/tmp/orkestrator-test-run.AEX7FL/summary.json`
(firewall), `/tmp/orkestrator-test-run.ULADKO/summary.json` (loopback). Passing
raw logs are deleted by the logged runner.

The same private daemon was then run with slirp4netns 1.3.3 (libslirp 4.9.1),
first with default host loopback disabled. The firewall suite passed **2/2**
again (32.8 s), and the default-loopback fixture passed **1/1** (5.4 s).
This proves the tamper/restart checks and the blocked host-service diagnosis
on the driver used by the previous rootless qualification too.

With VPNKit and host loopback enabled, firewall still passed **2/2** (32.6 s),
but the network suite failed **1/4** at host discovery (`blocked` rather than
`reachable`), and C22's authenticated-reply test was incomplete for the same
reason. Evidence: `/tmp/orkestrator-test-run.WU9abD` and
`/tmp/orkestrator-test-run.y979v1`. The backend's RootlessKit fallback address
`10.0.2.2` did not answer on that VPNKit setup. These are infrastructure/path
limitations, not flakes, and no assertions were weakened. After changing the
private daemon to slirp4netns with host loopback enabled, the exact failing
commands were rerun (same environment and image, same socket):

```bash
mise run test:logged -- --name rootless-gateway-network-enabled -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/container-live-network.test.ts --parallel=1
mise run test:logged -- --name rootless-host-service-enabled -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/container-live-readiness.test.ts --parallel=1 --test-name-pattern C22
mise run test:logged -- --name rootless-gateway-firewall-enabled -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/container-live-firewall.test.ts --parallel=1
```

On slirp4netns with loopback enabled, C22's authenticated HTTP/MCP reply
passed **1/1** (5.4 s) and the firewall suite passed **2/2** (32.0 s).
The network suite's C22 passed too, but C26 hit a real RootlessKit automatic
host-port collision (3 passed, 1 failed, 27.2 s;
`/tmp/orkestrator-test-run.RACYKX`). Rerunning the unchanged owning file alone
reproduced collisions in C24/C26 (1 passed, 3 failed, 12.6 s;
`/tmp/orkestrator-test-run.ASpYSH`), so this was not classified as a flake.
The live `container-live-start.ts` helper used bare `docker start` for the
workload even though the gateway and production start path already use
`startDockerContainer`. It now uses that same bounded automatic-port retry
and network-repair helper. No retry budget or assertions were changed.
The exact network-suite command above then **passed 4/4** (35.9 s), including
host/sibling isolation, resource budgets, CPU-pressure isolation and bounded
logs. The helper's `container-start.test.ts` owner, backend test typecheck,
focused lint and formatting checks also passed.

Decision: reuse production start recovery in the shared live fixture. An
alternative is to select ports from a private range or retry entire tests;
those could avoid host collisions but would stop exercising the production
start behavior. Reuse keeps the fixture faithful and retains fixed-port
failures as failures.

All suite-created containers, volumes, networks and derived tags were removed
by their existing owner-label cleanup. Content-free logged summaries are also
copied under `output/qualification-retirement/` for local review; failing logs
remain in the unique private runner directories named above. The private
daemon was stopped, and its data root removed. The shared daemon and its
networks were left unchanged.

Limits: this does not qualify every rootless kernel, a rootless daemon restart
with owned runtimes, or the entire replacement matrix. Those remained under todo
0018 (retired) task 2; the prior rootless evidence is retained above. The existing readiness fault suite was rerun rather than replacing its
assertions with a manifest-only check.
