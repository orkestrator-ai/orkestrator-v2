# Container qualification

Status: Living — C01–C30 scenario matrix, live Docker suites and benchmark
targets.

Unit and integration tests run the container lifecycle against a fake
`docker`. That cannot prove filesystem retention, packet rules, mount
permissions, name conflicts or signal delivery, so lifecycle, storage, network
and image changes are also qualified against a real daemon. How the lifecycle
works is in [container-lifecycle.md](../architecture/container-lifecycle.md);
the platforms and providers still waiting for evidence are in
[0019-container-platform-qualification.md](../todo/containers-and-environments/0019-container-platform-qualification.md).

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
| Live start recovery | same command, `./tests/container-start-docker.test.ts` | Fixed-port collision and two detached automatic-port failures, then network and HTTP publication recovery. Add `RUN_ROOTLESS_MOUNT_TESTS=1` on rootless to exercise read-only file mounts; use `TMPDIR` on `nosuid,nodev` for that topology. |
| All staged mount consumers | same command, `./tests/staged-input-relay-docker.test.ts` | Every declared mount through the full root bootstrap, node entrypoint and workspace setup; rootless raw-mount denial, relayed imports and unchanged owner-only host files. |
| Live replacement | same command, `./tests/container-live-replacement.test.ts` | C14–C19 |
| Live network | same command, `./tests/container-live-network.test.ts` | C22, C24, C26; on a gateway image C22 runs behind the egress gateway |
| Live firewall | same command, `./tests/container-live-firewall.test.ts` | C23 and the policy 3 tuples; on a gateway image also root tampering from the runtime, published ports through the gateway and a gateway restart. Set `ORKESTRATOR_EGRESS=in-container` for the in-container firewall |
| Live egress conditions | same command, `./tests/container-live-egress-conditions.test.ts` | Gateway IPv6 (the daemon's IPv6 default, or with `ORKESTRATOR_LIVE_IPV6_NETWORK=1` an IPv6 network the test attaches), DNS rotation through a controlled resolver, and with `ORKESTRATOR_LIVE_DAEMON_RESTART_COMMAND` a Docker daemon restart. Point that command only at a disposable daemon. |
| Live readiness faults | same command, `./tests/container-live-readiness.test.ts` | C09 faults (missing firewall, DNS, permissions, torn status write, restart during launch; pinned to the in-container firewall), a gateway that cannot apply its firewall, C10, C22 host-service reply, C23 re-run |
| Live rebuild faults | same command, `./tests/container-live-rebuild-faults.test.ts` | C15: daemon disconnect mid-copy (a `DOCKER_HOST` proxy in the test process), kill just before and after the commit write |
| Live build pipeline code rewind | same command, `./tests/build-pipeline-code-rewind-docker.test.ts` | "Rewind code to here" on fake providers through `createPipelineEnvironmentGit` and `docker exec`: preview, backup ref, reset, restart and lease push; a paused container refused with a readable reason; a reset journaled before the container stopped finishing once it answers (to-do 0405, task 7) |
| Live MCP delivery | same command, `./tests/mcp-overlay-live.test.ts` | Cursor `mcp.json` copy, container writer, environment overlay across stop/start and replacement, real rebuild re-staging (todo 0040) |
| Benchmarks | `RUN_CONTAINER_BENCHMARKS=1 ORKESTRATOR_QUALIFICATION_IMAGE=<image> bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/container-benchmarks.test.ts` | C28 |
| Final image | `bash docker/tests/final-image-smoke.sh <image>` (CI runs it on the native amd64 and arm64 builds in `validate-bun-runtime.yml`) | C27 |
| Real stack, Docker | `mise run dev:test --profile <p> --fixture --fixture-environments local,container`, then `ORKESTRATOR_AGENT_TEST_PROFILE=<p> mise run test:agent:docker` | C29 (`container-rebuild-cycle.spec.ts`), container settings (`container-settings.spec.ts`), deletion through the ledger (`browser-gateway.spec.ts`), design export into an Orkestrator container (`design-container-export.spec.ts`) |
| Real stack, live approval | The Docker profile above started with `--credential-source claude`, then `ORKESTRATOR_AGENT_TEST_PROFILE=<p> ORKESTRATOR_AGENT_TEST_LIVE_CONTAINER_APPROVAL=1 mise run test:agent:docker` | C11 approval half (`container-approval-stop.spec.ts`, a real Claude turn) |
| Real stack, root terminal | Included in `test:agent:docker`; start the profile with `--fixture-network full` for the full-network half | **New root terminal**: uid 0, outbound access by network mode (`container-root-terminal.spec.ts`) |
| Real stack, local | `mise run test:agent:browser:isolated` | C30 |
| Provider resume | `scripts/qualify-session-resume.sh <profile> <agent> [environment-name]` | C13 |
| OpenCode seeded data | `container-live-data-contracts.test.ts` (also `scripts/qualify-opencode-seeded-data.sh <image>`) | Real OpenCode turns, diff, revert and unrevert with and without host seeds on both database paths. Active console accounts in SQLite must retrieve provider configuration using their bearer token and selected organization from a local console fixture. Inotify checks the omitted host paths; no external credentials or billing. |
| Volume copy metadata | `container-live-data-contracts.test.ts` | Production `copy-volume` between real Docker volumes with a read-only source; compare raw `user.*` file/directory attributes and `security.capability` bytes before and after. Missing xattr or setcap support fails qualification. |
| Registry | `scripts/measure-registry-image.sh [--transfer <platform>] [--dind <platform>] [--json <file>] <image-ref>` | Compressed manifest and layer bytes, blob transfer time, cold pull |
| Upgrade and rollback | `bun scripts/qualify-backend-upgrade-rollback.ts [--old-ref <ref>] [--floor-ref <ref>] [--main-ref <ref>] [--report <file>]` | Backend upgrade over an older release's data and containers; the floor's refusal of a newer directory |
| Real stack, terminal Claude | The Docker profile above started with `--credential-source claude`, then `ORKESTRATOR_AGENT_TEST_PROFILE=<p> ORKESTRATOR_AGENT_TEST_LIVE_CLAUDE_TERMINAL=1 mise run test:agent:docker` | A real `claude` turn in a **Claude CLI** tab, foreground and background: the Claude state signal's working and waiting latency against the activity and completion budgets, no missed ring (`container-claude-terminal-signal.spec.ts`) |
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

## UI response under multi-environment load, first run on a busy host (2026-11-01)

Todo [0022](../todo/containers-and-environments/0022-container-resource-budgets-and-performance.md)
task 3, with the [probe](#ui-response-under-multi-environment-load) at
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
[2150](../todo/containers-and-environments/2150-container-environment-stop-takes-ten-seconds.md).

## Egress gateway conditions on Linux Engine (2026-10-31)

Todo [0018](../todo/containers-and-environments/0018-container-network-and-credential-isolation.md)
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
- **Not covered:** a rootless daemon restart (0018 task 2), external IPv6
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
(see [0241](../todo/containers-and-environments/0241-leaked-reach-probe-networks.md)),
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

Todo [0728](../todo/containers-and-environments/0728-container-ci-c14-assumes-uid-1000.md),
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
  [0241](../todo/containers-and-environments/0241-leaked-reach-probe-networks.md)),
  including the new case and C16's symlinked-root refusal. The live data
  contracts suite passed 2/2.

## Egress gateway on Docker Desktop (2026-10-25)

The backend's egress gateway (todo 0018 item 1), on Docker Desktop 4.96.3
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
this run found are tracked in
[0109-rootless-linux-runtime-gaps.md](../todo/containers-and-environments/0109-rootless-linux-runtime-gaps.md):

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
only. Evidence, decisions and what remains are in
[0019-container-platform-qualification.md](../todo/containers-and-environments/0019-container-platform-qualification.md#results-2026-10-23).

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
in [0019-container-platform-qualification.md](../todo/containers-and-environments/0019-container-platform-qualification.md).

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
| C11 | Stop with running descendants and a pending approval | Bounded drain; approval never granted; children reaped |
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

The benchmark's warm stop is a bare `docker stop` of the runtime, so its
gateway keeps running and a warm start never restarts it.

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
| Warm start to current-boot ready | `warmStopStart.start` | ≤ 2 s |
| Rebuild copy and verify, 5,000 files | `rebuild.medium.copying` | ≤ 20 s |
| Docker calls per minute with the Docker view open | `dockerCallsPerMinuteViewOpen` | ≤ 36 |
| Log followers after the idle grace | `observerChurn.followersAfterGrace` | 0 |

Never clear a user's global Docker or cache state to manufacture a cold run;
"cold" means a new network, volumes and staged inputs per environment.

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
[0022](../todo/containers-and-environments/0022-container-resource-budgets-and-performance.md#evidence-2026-10-25).
Rerun them when a workload grows (a new browser default, a heavier build),
before you change the default.

### UI response under multi-environment load

`e2e/perf/multi-environment-ui-perf.ts` times the browser UI while several
container environments are busy. It is a probe, not a test: it has no
targets and fails only when it cannot run. It attaches to a running
disposable profile with container fixtures and never starts an agent
session.

```bash
# In its own long-lived terminal; --headless-electron keeps the profile's
# window out of the desktop session on Linux.
mise run dev:test --profile ui-load --fixture-environments container \
  --no-agent-credentials --agent-platforms claude --headless-electron
# Once `mise run dev:status --profile ui-load --json` reports ready:
mise exec -- bun e2e/perf/multi-environment-ui-perf.ts --profile ui-load \
  [--environments 3] [--workers 2] [--memory-mib 0] [--phases idle,busy,idle] \
  [--switches 20] [--status-cycles 3] [--watch-seconds 20] [--settle-seconds 10]
# Afterwards:
mise run dev:stop --profile ui-load && mise run dev:reset --profile ui-load
```

It adds `--environments` container environments (`ui-load-busy-N`) and a
`ui-load-target` to the fixture project, and signs a headless Chromium in
through `dev:login`. Startup dialogs such as "Claude Code Is Not Logged In"
are dismissed for that page only. In each `busy` phase, every
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
  apps/backend/tests/container-worktree-signal-docker.test.ts
```

The Linux Engine workflow runs both tests and the exec-cost script on every
run (`exec-cost-<platform>.json` in the benchmark artifact). The worktree
test's `change-to-scan` line is not a clean latency: it follows a writer
whose close rang just before, so it likely waits out part of the 2 s hint
gap (1.3 to 1.4 s on Desktop and Linux Engine alike). Use the profile sample's
`latencyMs` for change-to-visible.
