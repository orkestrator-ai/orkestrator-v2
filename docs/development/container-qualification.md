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
  those resources. Never prune, globally or by owner.
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
| Live replacement | same command, `./tests/container-live-replacement.test.ts` | C14–C19 |
| Live network | same command, `./tests/container-live-network.test.ts` | C22, C24, C26 |
| Live firewall | same command, `./tests/container-live-firewall.test.ts` | C23 |
| Live readiness faults | same command, `./tests/container-live-readiness.test.ts` | C09 faults (missing firewall, DNS, permissions, torn status write, restart during launch), C10, C22 host-service reply, C23 re-run |
| Live rebuild faults | same command, `./tests/container-live-rebuild-faults.test.ts` | C15: daemon disconnect mid-copy (a `DOCKER_HOST` proxy in the test process), kill just before and after the commit write |
| Live MCP delivery | same command, `./tests/mcp-overlay-live.test.ts` | Cursor `mcp.json` copy, container writer, environment overlay across stop/start and replacement, real rebuild re-staging (todo 0040) |
| Benchmarks | `RUN_CONTAINER_BENCHMARKS=1 ORKESTRATOR_QUALIFICATION_IMAGE=<image> bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/container-benchmarks.test.ts` | C28 |
| Final image | `bash docker/tests/final-image-smoke.sh <image>` (CI runs it on the native amd64 and arm64 builds in `validate-bun-runtime.yml`) | C27 |
| Real stack, Docker | `mise run dev:test --profile <p> --fixture --fixture-environments local,container`, then `ORKESTRATOR_AGENT_TEST_PROFILE=<p> mise run test:agent:docker` | C29 (`container-rebuild-cycle.spec.ts`), container settings (`container-settings.spec.ts`), deletion through the ledger (`browser-gateway.spec.ts`) |
| Real stack, live approval | The Docker profile above started with `--credential-source claude`, then `ORKESTRATOR_AGENT_TEST_PROFILE=<p> ORKESTRATOR_AGENT_TEST_LIVE_CONTAINER_APPROVAL=1 mise run test:agent:docker` | C11 approval half (`container-approval-stop.spec.ts`, a real Claude turn) |
| Real stack, root terminal | Included in `test:agent:docker`; start the profile with `--fixture-network full` for the full-network half | **New root terminal**: uid 0, outbound access by network mode (`container-root-terminal.spec.ts`) |
| Real stack, local | `mise run test:agent:browser:isolated` | C30 |
| Provider resume | `scripts/qualify-session-resume.sh <profile> <agent> [environment-name]` | C13 |
| Registry | `scripts/measure-registry-image.sh [--transfer <platform>] [--dind <platform>] [--json <file>] <image-ref>` | Compressed manifest and layer bytes, blob transfer time, cold pull |
| Upgrade and rollback | `bun scripts/qualify-backend-upgrade-rollback.ts [--old-ref <ref>] [--floor-ref <ref>] [--main-ref <ref>] [--report <file>]` | Backend upgrade over an older release's data and containers; the floor's refusal of a newer directory |
| Linux Engine, CI | `.github/workflows/container-live-qualification.yml` (weekly, on demand, and on pull requests that change the suites) | Every live suite on `ubuntu-24.04` and `ubuntu-24.04-arm` |
| Egress gateway prototype | `scripts/qualify-egress-gateway.sh [image]` | None yet: the external egress design in [0018](../todo/containers-and-environments/0018-container-network-and-credential-isolation.md), item 3 |

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
restarts of either side: exit 0 pass, 1 fail, 2 setup error. The backend does
not create this topology yet.

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
| C14 | Legacy migration and volume rebuild | Verified bytes and Git state; correct workspace generation |
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

The harness asserts only that rebuilds succeed and no log follower survives.
Compare the report with these targets by hand. They were set on Linux
x86_64, 12 CPUs, Docker Engine 29.7.2, no resource budget, restricted mode
allowing `registry.npmjs.org` and GitHub's ranges. A change that misses one
is fixed, or the reason is recorded, before it merges.

| Measure (median unless stated) | Report field | Target |
| --- | --- | --- |
| Fresh restricted environment to ready | `freshRestricted.total` | ≤ 3 s |
| Incomplete fresh boots | `freshRestricted.incomplete` | none |
| Docker CLI calls per fresh environment | `freshRestricted.dockerCalls` | ≤ 21 |
| Three concurrent fresh environments, each against the sequential median | `freshConcurrent3.slowdownVsSequentialMedian` | ≤ 1.5× |
| Warm stop (drain and `docker stop`) | `warmStopStart.stop` | ≤ 1 s |
| Warm start to current-boot ready | `warmStopStart.start` | ≤ 2 s |
| Rebuild copy and verify, 5,000 files | `rebuild.medium.copying` | ≤ 20 s |
| Docker calls per minute with the Docker view open | `dockerCallsPerMinuteViewOpen` | ≤ 36 |
| Log followers after the idle grace | `observerChurn.followersAfterGrace` | 0 |

Never clear a user's global Docker or cache state to manufacture a cold run;
"cold" means a new network, volumes and staged inputs per environment.
