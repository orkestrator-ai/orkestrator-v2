# Container usage and improvements

Investigated: 2026-09-21, against commit `88c2f9cc`.

Status: investigation and proposed work; no runtime changes implemented.

Implementation plan: [index and numbered steps](containers/plan/00-index.md).

## Assessment

Keep the existing one-container-per-environment model. It fits interactive
development: agents, terminals, development servers and their files need to
remain available while the user works elsewhere. The largest opportunities are
safer state retention, consistent lifecycle handling and a narrower isolation
boundary. Replacing Docker or introducing an orchestrator is not needed to
address the findings below.

The most urgent issue is a data-loss mismatch: changing port mappings offers to
recreate the container while promising to preserve filesystem changes, but the
implementation removes the container without persistent workspace storage.
Recreation also retains completion state belonging to the old container.

This is a source investigation of backend commands, shell scripts, the image,
release workflow, relevant UI and existing tests. Docker behavior was checked
against official documentation through Context7 and Docker Docs. No user
containers were started, stopped, inspected for contents or removed. Image size,
startup latency, network reachability and failure scenarios were not measured
on a live daemon. Findings distinguish direct code evidence from risks requiring
runtime validation.

## How containers are used today

| Area | Current implementation |
| --- | --- |
| Unit of isolation | One persistent development container per containerized environment, alongside the alternative local-worktree mode. Multiple agent sessions and terminals share it. |
| Control plane | The standalone backend invokes the Docker CLI for create/start/stop/inspect/exec/copy/remove. The renderer requests commands and consumes backend state. |
| Identity | Container names derive from the backend data-directory owner hash and environment ID. Labels record app, owner, project and environment identity. |
| Image | Default `orkestrator-v2:latest`, overridable through backend options. The Debian image includes Bun, Node, agent tooling, five prebuilt bridges, Chromium, mise and interactive shell tools. |
| Filesystem | Git is cloned into `/workspace` inside the container. Production creation mounts selected host inputs read-only, but supplies no volume or bind mount for `/workspace` or the writable agent homes. |
| Startup | Backend creates and persists the container ID, starts it, synchronizes credentials, prepares the checkout and runs setup through a backend-owned terminal. Entrypoint configures networking and agent homes, writes ready files, then executes `sleep infinity`. |
| Agent execution | Bridges and OpenCode start on demand using detached `docker exec`; terminals use interactive exec. HTTP health checks verify agent-server startup. |
| Connectivity | Six agent-server ports, configured project mappings and an optional preview port publish on host `127.0.0.1`. Container creation does not select a dedicated Docker network. |
| Network policy | Restricted mode applies an IPv4 iptables/ipset allowlist; full mode skips it. Every container receives `NET_ADMIN`, used by narrowly allowed sudo scripts. |
| Persistence | Environment metadata lives in backend storage. Container checkout, installed project dependencies and writable agent state survive stop/start, but are tied to the container's lifetime. |
| Release | CI builds native amd64 and arm64 images, publishes a multi-architecture GHCR manifest and attests provenance. README describes pulling and tagging the image locally. |

Primary sources: [container creation](../../apps/backend/src/core/commands-containers.ts),
[environment lifecycle](../../apps/backend/src/core/commands-environment.ts),
[Docker commands](../../apps/backend/src/core/commands-registry-docker.ts),
[ownership](../../apps/backend/src/core/docker-ownership.ts),
[Dockerfile](../../docker/Dockerfile),
[entrypoint](../../docker/entrypoint.sh),
[workspace setup](../../docker/workspace-setup.sh),
[release workflow](../../.github/workflows/publish-container.yml).

### Existing work to preserve

- Lifecycle operations are serialized per environment and duplicate starts are
  coalesced. Backend task tracking and persistent deletion intent support
  shutdown and restart recovery.
- Setup and long-running agent work are backend-owned. Container changes must
  preserve inactive-environment operation and snapshot-based rehydration.
- Container discovery batches `docker ps` and shares a short-lived status cache;
  it is already more efficient than inspecting every environment on every read.
- Published ports use loopback. Agent-server authentication and authenticated
  health/replacement paths already exist; they should remain mandatory.
- Credential copying has explicit allowlists, size/count bounds and symlink
  checks. GitHub credentials have a dedicated synchronization path.
- Restricted firewall initialization installs DROP policies before flushing
  rules and aborts startup on failure. Ordinary agents cannot run the operator
  allowlist editor through sudo. Repository root setup is allowed only in full
  mode.
- CLI versions and many artifacts are pinned and verified. Bridges build into
  the image, and build-time smoke checks exercise CLIs, shells and Chromium.
- Cleanup is already scoped by installation ownership rather than using a
  daemon-wide system prune. Images, networks and volumes are deliberately left
  alone.

## Findings and recommended changes

Priority meanings: **P1** should be addressed first because it affects retained
work, correctness or isolation; **P2** improves reliability and operability;
**P3** should follow measurement.

| Priority | Finding | First concrete change |
| --- | --- | --- |
| P1 | Recreation discards data despite a preservation promise | Correct the UI and protect work before any destructive replacement |
| P1 | Replacement inherits stale setup state and can collide with the old name | Introduce explicit replacement-generation state and recovery |
| P1 | Whole agent homes remain readable through input mounts | Stage only authorized portable inputs outside the workload |
| P1 | Low-level Docker mutations bypass lifecycle and ownership checks | Route them through one backend lifecycle/ownership boundary |
| P2 | Restricted networking is broader and less dynamic than a domain policy | Narrow host access, isolate environments and test effective policy |
| P2 | Readiness markers survive restarts; PID 1 is only a sleeper | Track startup generations and implement deliberate process shutdown |
| P2 | No application resource budgets; usage UI reports placeholders | Add configurable limits and truthful bounded telemetry |
| P2 | Single-stage image retains build layers; compatibility uses ad hoc checks | Separate bridge build stages and record an image capability manifest |
| P3 | Startup and Docker transport optimizations lack measurements | Measure phases and define supported daemon topology before redesign |

### 1. Preserve work across replacement and make cleanup semantics explicit

**Evidence.** `createDockerContainer()` mounts host configuration and project
inputs, but never mounts `/workspace` or writable agent homes.
`recreateEnvironmentOnce()` calls `docker rm -f` and creates a replacement.
The port-change confirmation in
[EnvironmentSettingsDialog](../../apps/web/src/components/environments/EnvironmentSettingsDialog.tsx)
nevertheless says: “Your filesystem state (installed packages, file changes)
will be preserved.” Its caller connects directly to `backend.recreateEnvironment`.

That promise does not match the implementation. Files in a container's writable
layer disappear when it is removed; Docker-managed volumes survive removal.
See [Docker storage](https://docs.docker.com/engine/storage/).

`docker_system_prune` also removes **all stopped owned containers**, including
ones still assigned to environments. The
[cleanup dialog](../../apps/web/src/components/docker/DockerStatsDialog.tsx)
does explicitly warn that these rebuild from scratch, so this is not an
unannounced prune. It still treats stopping an environment as making its only
working copy eligible for disposal. Recreating from Git cannot recover untracked
files, ignored local data, uncommitted edits or commits never pushed.

**Recommendation.**

1. Immediately replace the incorrect preservation promise with accurate
   consequences. Have the backend refuse destructive replacement unless the
   requested preservation/export or explicit discard operation has completed.
   A clean Git status alone is insufficient: include unpushed commits and
   non-Git files in the policy.
2. Give each environment an owner-labeled workspace volume. Persist selected
   agent session/state directories separately where recovery requires them;
   keep imported credentials and disposable caches out of that durable data
   contract. Avoid mounting all of `/home/node`, which would mask image tooling
   and shell configuration.
3. Separate **rebuild runtime**, **reset workspace** and **delete environment
   data**. Default maintenance should exclude assigned environments. Keep
   explicit discard as a separate action with a concrete inventory of affected
   environments.
4. Migrate existing writable-layer workspaces by stopping writers, copying and
   verifying their contents, then switching the persistent reference. Retain
   the original container until verification succeeds. Preserve ownership and
   permissions, and handle rollback and disk-space failure.

Persisting `/workspace` preserves project-installed dependencies there, not
arbitrary system packages or changes elsewhere in the old container. The UI
must state that distinction even after volumes are introduced. System tooling
should be reproducible through image/setup configuration.

**Acceptance.** A real Docker test changes a port mapping after creating a
tracked edit, an untracked file, an ignored file and an unpushed commit. Verify
preservation or refusal. Stopped assigned environments must survive ordinary
cleanup. Test migration failure without losing the original copy.

### 2. Treat replacement as a new runtime generation

**Evidence.** `recreateEnvironmentOnce()` clears `containerId`, `status` and
`lifecycleError`, but retains `setupScriptsComplete`, `setupPhase`,
`setupOverride` and `createdFromCommit`.
`startEnvironmentSetupOnce()` immediately returns when setup is complete,
ready or overridden. The
[storage updater](../../apps/backend/src/core/storage-projects.ts)
does not invalidate those fields when `containerId` changes. A previously ready
environment can therefore acquire a fresh container without rerunning the
backend's checkout/setup path. Entrypoint itself does not clone the repository.

There is a second recovery mismatch: recreation catches every removal error,
clears the old reference and proceeds. Container names are deterministic for
owner plus environment ID. If failed removal leaves that name reserved, the
replacement create conflicts. The existing test “recreates a container even
when the old one cannot be removed” in
[lifecycle tests](../../tests/unit/electron/commands-registry-environments.test.ts)
uses a fake Docker executable that always accepts `create`; it does not model
Docker's name uniqueness.

**Recommendation.** Persist replacement intent and the old/new runtime IDs.
Distinguish confirmed absence from a failed removal. Keep the original
reference on an unresolved failure, or use generation-specific runtime names
with explicit rollback and retirement. Never orphan the only data copy merely
to advance metadata.

Bind preparation/readiness state to the runtime and workspace generation.
Rebuilding an empty workspace must invalidate its old setup completion and
baseline; reusing a preserved workspace must verify it and retain the actual
branch baseline rather than blindly replacing it with current HEAD. Reconcile
terminal IDs, bridge connections and active setup tasks at the same boundary.

**Acceptance.** Recreate an already-ready environment and prove that checkout
and setup actually exist. Simulate removal failure while the original name is
still occupied. Restart the backend between replacement phases and verify that
it recovers the correct container without duplicating setup or losing data.

### 3. Narrow host mounts, not just startup copies

**Evidence.** Production creation binds entire directories including
`~/.claude`, `~/.codex`, `~/.grok`, `~/.pi` and OpenCode configuration/data.
Entrypoint copies a bounded subset, but the original mounts remain available
at `/claude-config`, `/codex-home`, `/grok-home`, `/pi-config` and related paths.
Excluded histories, databases and other files are still readable wherever host
permissions permit. Read-only prevents writes; it does not restrict reads to
the copy allowlist. Production mount decisions also do not follow
`enabledAgentPlatforms`; credential-source selection is primarily an agent-test
restriction in this function.

**Recommendation.** Move portable-input selection to a backend-owned staging
step and expose only the resulting bounded files to the workload. Stage inputs
for enabled/authorized providers, with deliberate refresh and revocation.
Preserve the current symlink, permission, size and count safeguards at that
boundary. Use explicit bind mounts that fail on missing sources instead of
silently creating source directories, or copy staged inputs into the container.
See [Docker bind mounts](https://docs.docker.com/engine/storage/bind-mounts/).

API keys passed with `-e NAME` avoid embedding their values in CLI arguments,
which is good, but remain container environment configuration. Prefer the
existing credential-file pattern where providers support it, with owner-only
permissions and rotation. This reduces accidental exposure; it does not hide
credentials from authorized code running as the same container user or from
the Docker administrator.

**Acceptance.** Put a sentinel history file and a disabled-provider credential
in a fixture host home. Container workloads must be unable to read either,
while selected credentials and portable extensions continue working. Cover
restart, credential rotation/revocation and symlinked source/destination paths.

### 4. Apply one lifecycle and ownership boundary to every mutation

**Evidence.** High-level start/stop/recreate use the environment operation
queue. In contrast, `provision_environment`, `docker_start_container`,
`docker_stop_container`, `docker_remove_container` and `reattach_container` in
the Docker registry directly mutate Docker or storage. The raw container
handlers accept an ID without calling `assertDockerContainerOwned()` themselves.
The [registry wrapper](../../apps/backend/src/core/commands-registry.ts) does
apply that check to supplied container IDs in strict profiles; the helper only
enforces ownership when `strictDockerOwner` is enabled. Ordinary production
paths therefore need the same ownership policy, while all paths need consistent
lifecycle serialization.
This is a consistency gap within an authorized backend API, not evidence that
an unauthenticated remote caller can access it.

Orphan cleanup takes a storage snapshot, force-removes containers with no
matching persisted container ID, swallows removal errors and increments the
success count anyway. It does not reconcile the environment label before
removal, even though the listing uses that label to recover a display name.
Creation, reattachment or replacement can change assignment after the snapshot.

**Recommendation.** Resolve each mutating operation to an owned environment or
an explicitly selected orphan. Reuse lifecycle serialization and re-check
ownership/assignment immediately before removal. Make legacy unlabeled
container adoption explicit. Reconcile labeled resources left by interrupted
creation before classifying them as garbage. Count confirmed removals and
report failures separately. Make duplicate provision requests idempotent.

**Acceptance.** Direct command tests must reject foreign-owner IDs, including
under ordinary production configuration. Race provisioning, reattachment and
cleanup; preserve a container that becomes assigned. A refused removal must
not appear in the successful-deletion count.

### 5. Define and enforce the actual restricted-network contract

**Evidence.** [init-firewall.sh](../../docker/init-firewall.sh) resolves domain
A records into an IP set at startup, includes GitHub's published web/API/git
ranges, and allows traffic to/from a `/24` derived from the default gateway.
The allowed-address rules are not restricted to HTTPS ports. Creation does not
request a dedicated network. Docker's default bridge groups containers on that
network; a separate user-defined bridge provides a useful environment boundary.
See [Docker bridge networking](https://docs.docker.com/engine/network/drivers/bridge/).

Consequences requiring an explicit policy:

- The gateway-subnet exception can admit sibling containers and host services;
  its exact reach depends on daemon topology, and the hard-coded `/24` is not
  the actual discovered subnet mask.
- IP allowlisting cannot distinguish approved domains from other services on
  shared addresses. Allowed GitHub/API endpoints and recursive DNS also remain
  possible data-transfer channels. “Restricted” is not a promise of preventing
  all exfiltration.
- Startup DNS answers can become stale. The scripts implement IPv4 rules;
  IPv6 behavior needs validation on enabled daemons before claiming equivalent
  restrictions.
- The startup script, backend defaults and frontend fallback lists differ.
  AGENTS.md also says outbound SSH is always allowed, while the current script
  and [firewall test](../../tests/unit/firewall-policy.test.ts) explicitly have
  no blanket SSH exception.

**Recommendation.** Use an owner-labeled network per environment, with required
sidecars sharing only that environment's network. Replace the subnet exception
with explicit host-service destinations and ports, preserving the agent-tool
callback path. Discover topology rather than deriving a `/24`. Explicitly
disable or enforce IPv6. Refresh address sets atomically with bounded retries
and expose the effective policy and failed resolutions.

Longer term, evaluate an external egress proxy/firewall so the workload does not
need `NET_ADMIN`. Preserve non-HTTP Git/SSH and configured provider endpoints
deliberately. Do not simply remove capabilities or add `no-new-privileges`:
the current sudo-based firewall initialization depends on privilege elevation.

**Acceptance.** On Linux Engine and Docker Desktop, test allowed provider access,
blocked destinations, host callbacks, sibling isolation, changed DNS answers,
IPv6, unavailable GitHub metadata and firewall initialization failure. Use
throwaway fixtures; current source assertions alone cannot prove packet policy.

### 6. Make readiness and shutdown explicit

**Evidence.** Entrypoint writes `/tmp/.entrypoint-complete` and
`/tmp/.environment-ready`, but does not remove old markers at startup. These
paths are not tmpfs mounts in the create specification. Workspace setup waits
for the entrypoint marker, then logs “proceeding anyway” if initialization times
out. A marker from an earlier start can satisfy the check while current
initialization is still running.

The container's final PID 1 is `sleep infinity`; creation does not specify
`--init`. Agent bridges and terminals enter separately through `docker exec`.
There is no explicit container-side process supervisor or bridge-drain phase in
`stopEnvironmentOnce()` before `docker stop`.

**Recommendation.** Use an authoritative startup-generation record and clear
stale readiness before starting any workload. Readiness must distinguish
container running, firewall/config initialized, workspace prepared and agent
server healthy. Fail the initialization wait with a retryable explanation;
do not continue after a timeout. Preserve this status across UI inactivity and
rehydrate it from the backend.

Add a small init for orphan reaping, then implement a bounded graceful shutdown
of bridges, terminals and child jobs before stopping the container. Docker's
`--init` provides signal forwarding and process reaping, but is not by itself a
drain protocol for independently exec-launched services. Verify the scripts'
`/proc/1/environ` policy lookup under the new process layout.
See [Docker multi-process containers](https://docs.docker.com/engine/containers/multi-service_container/).

**Acceptance.** Stop/start an existing container with delayed initialization;
old ready markers must not release setup. Verify transcript persistence,
bounded stop time and child reaping. Switch away during startup and agent work,
then return and confirm status, pending prompts and controls recover correctly.

### 7. Bound resources and report real usage

**Evidence.** Creation sets `--shm-size=1g`, but no CPU, memory, swap or PID
budget and no explicit logging policy. Docker allows unrestricted CPU/memory
use by default, subject to host/daemon constraints; a Desktop VM limit is not
a per-environment budget. See
[Docker resource constraints](https://docs.docker.com/engine/containers/resource_constraints/).

`get_docker_system_stats` returns literal zero for CPU usage, used memory and
disk usage; capacity comes from the backend host's `os` APIs. The UI renders
these as measurements. Container rows also contain placeholder creation and
CPU values. This obscures resource pressure, particularly when the daemon runs
inside a VM or elsewhere.

`stream_container_logs` spawns a new `docker logs -f` process for each request
without a corresponding subscription/disposal handle. Bridge startup failure
diagnostics read an entire log file through `cat`. Docker stdout rotation also
would not rotate bridge logs written separately under `/tmp`.

**Recommendation.** Add configurable memory/CPU/PID profiles with measured
defaults and explicit overrides; budget shared memory together with container
memory. Report OOM and exit reasons. Show unknown/stale values as such until
bounded backend sampling supplies real daemon/container measurements. Label
daemon-wide totals separately from installation-owned resources.

Choose explicit bounded Docker logging options and separately rotate bridge
files. Manage log followers as reference-counted backend subscriptions with
disconnect cleanup, byte/count limits and bounded diagnostic tails. Do not
persist raw log contents in telemetry. Docker's
[local logging driver](https://docs.docker.com/engine/logging/drivers/local/)
supports rotation, but application files still need their own limits.

**Acceptance.** A memory/process-heavy fixture must stay within its configured
budget and expose the reason for termination. Repeat log subscribe/disconnect
cycles without increasing follower count. Failed telemetry reads must display
unknown, and startup diagnostics must remain bounded for very large log files.

### 8. Reduce image baggage and make upgrades reviewable

**Evidence.** The Dockerfile has one `FROM`. It copies all bridge sources,
installs filtered dependencies in one layer, then removes build dependencies
and moves bridge directories in later layers. Removing files later does not
remove their bytes from earlier image layers. Bridge source is copied before
the install, so source changes also invalidate that install layer. Actual
compressed-size and build-time savings remain unmeasured.

The release workflow already publishes version tags, architecture digests,
cached builds and provenance. The runtime still defaults to a mutable local
tag. `check_base_image` checks existence, while
[workspace preparation](../../apps/backend/src/core/commands-local-server-lifecycle.ts)
uses a shell capability marker to detect one old-image incompatibility.

**Recommendation.** Build bridges in a dedicated stage and copy only runtime
artifacts and required vendored resources into the final development image.
Keep Chromium and developer tools that workloads actually need. Copy dependency
manifests before sources, use bounded BuildKit caches, and verify the filtered
install can run frozen against the committed lockfile. Docker's
[multi-stage build documentation](https://docs.docker.com/build/building/multi-stage/)
describes separating build artifacts from the final image.

Record the resolved image ID/digest and a generated capability/version manifest
when provisioning. Compare required capabilities before startup and offer an
explicit upgrade/rebuild using the safe persistence path above. Keep the local
development tag override. Pin the base image digest through the normal upgrade
workflow while retaining regular security refreshes.

**Acceptance.** Compare compressed pull bytes, installed size and cold/warm
build time for both architectures. Run every bridge plus CLI, shell and browser
smoke checks from the final image. A stale image must produce an actionable
compatibility error before destructive replacement. Do not ship per-agent
image variants until measurements justify their additional support matrix.

### 9. Measure startup and define daemon locality before optimizing further

Entrypoint reconfigures the firewall and copies portable input on every start;
workspace cloning already attempts a partial clone and setup has completion
markers. Avoid proposing recursive host-home copies, unconditional full clones
or runtime bridge builds as problems: those have already been addressed.

Instrument bounded phase durations for create, firewall, input staging, clone,
setup and bridge readiness. Measure cold/warm startup, writable-layer growth,
idle resource use and Docker CLI invocation counts across several environments.
Record counts and durations, never credentials, prompts or file contents.
Use the results to decide whether input fingerprints, dependency caches or a
backend Docker-events watcher are worthwhile. An events watcher still needs
reconnect reconciliation and authoritative snapshots.

Also make the supported daemon topology explicit. Host paths are checked with
local filesystem APIs before mounting, and mapped server ports are contacted
at backend loopback. An arbitrary remote `DOCKER_HOST` cannot be assumed to
share either. Prefer running the existing standalone backend beside its Docker
daemon and using the application's remote gateway. Detect unsupported remote
daemon configurations early; full remote-daemon support would require separate
file staging and port transport. Bind sources belong to the daemon host, as
documented in [Docker bind mounts](https://docs.docker.com/engine/storage/bind-mounts/).

## Suggested delivery sequence

1. **Protect existing work:** fix the false preservation text; protect assigned
   environments during cleanup; invalidate stale replacement state; handle
   retained-name removal failures. Add real filesystem/name-conflict regression
   scenarios alongside the existing fake-CLI coverage.
2. **Unify the lifecycle:** enforce ownership at every mutation, persist
   replacement intent, reconcile interrupted resources, then add labeled
   workspace/state storage with a verified migration and rollback path.
3. **Tighten isolation and readiness:** staged portable inputs, generation-based
   readiness, explicit shutdown, per-environment networking and tested egress
   rules. Preserve authenticated bridges and host callbacks.
4. **Improve capacity and delivery:** resource profiles, truthful telemetry,
   bounded logs, multi-stage bridge builds and an image capability manifest.
   Use measurements to prioritize additional caching or Docker API changes.

Implementation validation should follow the
[testing guide](../development/testing-guide.md): focused lifecycle/ownership
and shell-policy tests first, then the isolated Docker agent workflow. Extend
fixtures to cover retained data, real name conflicts and effective packet rules;
the existing suites do not make those assertions just by mocking successful
Docker commands. Include the required inactive-environment path for every
lifecycle change. This documentation-only investigation did not run the
application test suites or claim live Docker verification.
