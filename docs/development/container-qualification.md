# Container qualification

Status: Living — C01–C30 scenario matrix, live Docker suites and benchmark
targets.

Unit and integration tests run the container lifecycle against a fake
`docker`. That cannot prove filesystem retention, packet rules, mount
permissions, name conflicts or signal delivery, so lifecycle, storage, network
and image changes are also qualified against a real daemon. How the lifecycle
works is in [container-lifecycle.md](../architecture/container-lifecycle.md);
the platforms and providers still waiting for evidence are in
[container-platform-qualification.md](../todo/container-platform-qualification.md).

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
run.

| Suite | Command | Scenarios |
| --- | --- | --- |
| Unit and integration | `mise run test` | Every scenario without a live suite below, against a fake `docker` |
| Live lifecycle | `RUN_LIVE_DOCKER_TESTS=1 ORKESTRATOR_QUALIFICATION_IMAGE=<image> bun test apps/backend/tests/container-live-qualification.test.ts` | C09, C11, C12, C20 |
| Live replacement | same variables, `apps/backend/tests/container-live-replacement.test.ts` | C14–C19 |
| Live network | same variables, `apps/backend/tests/container-live-network.test.ts` | C22, C24, C26 |
| Live firewall | same variables, `apps/backend/tests/container-live-firewall.test.ts` | C23 |
| Benchmarks | `RUN_CONTAINER_BENCHMARKS=1 ORKESTRATOR_QUALIFICATION_IMAGE=<image> bun test apps/backend/tests/container-benchmarks.test.ts` | C28 |
| Final image | `bash docker/tests/final-image-smoke.sh <image>` (CI runs it on the native amd64 and arm64 builds in `validate-bun-runtime.yml`) | C27 |
| Real stack, Docker | `mise run dev:test --profile <p> --fixture --fixture-environments local,container`, then `ORKESTRATOR_AGENT_TEST_PROFILE=<p> mise run test:agent:docker` | C29 (`container-rebuild-cycle.spec.ts`), container settings (`container-settings.spec.ts`) |
| Real stack, local | `mise run test:agent:browser:isolated` | C30 |
| Provider resume | `scripts/qualify-session-resume.sh <profile> <agent> [environment-name]` | C13 |

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
the rebuild preview marks its resume unverified.

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
