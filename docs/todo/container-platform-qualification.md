# Container platform qualification

Checked against `main` at `2459b05c` (2026-10-15).

The container lifecycle (durable operations, persistent storage, staged
inputs, per-environment networks, resource budgets, bounded logs) shipped in
#877 with live evidence from one platform only: Linux Docker Engine 29.7.2 on
amd64, recorded before the merge. This file lists the real-platform and
real-provider evidence that is still missing, and how to reproduce the suites
that produce it. Until it exists, Docker Desktop, rootless Engine, arm64 and
five of the six providers' session resume are claims the product gates rather
than behaviour it has shown.

## Current state

- Four opt-in live suites run against a real daemon when
  `RUN_LIVE_DOCKER_TESTS=1` and `ORKESTRATOR_QUALIFICATION_IMAGE=<image>` are
  set: `apps/backend/tests/container-live-qualification.test.ts`,
  `container-live-replacement.test.ts`, `container-live-network.test.ts` and
  `container-live-firewall.test.ts`. Between them they cover C09, C11, C12,
  C14–C20, C22–C24 and C26. Every resource carries a per-run label and an
  owner label derived from a private temporary data directory, and `afterAll`
  removes exactly those resources.
- The benchmark harness is `apps/backend/tests/container-benchmarks.test.ts`
  (`RUN_CONTAINER_BENCHMARKS=1`). It writes JSON under `output/benchmarks/`
  and covers C28.
- `docker/tests/final-image-smoke.sh <image>` runs in
  `.github/workflows/validate-bun-runtime.yml` on the native amd64 and arm64
  builds (manifest versions against the installed CLIs, every bridge's
  `/global/health`, Codex's code-mode host, Chromium). That is the smoke half
  of C27; the live C-scenarios have never run on arm64.
- Real-stack specs: `e2e/agent-testing/container-rebuild-cycle.spec.ts` (C29)
  and `e2e/agent-testing/container-settings.spec.ts` both match the
  "Docker fixture" grep of `test:agent:docker`. `test:agent:browser:isolated`
  covers the local-worktree regression (C30).
- Provider session resume after a rebuild is gated by
  `RESUME_QUALIFIED_PROVIDERS` in `apps/backend/src/core/container-replacement.ts`,
  which holds only `claude`. `rebuildPreview` marks every other provider's
  resume as unverified. `scripts/qualify-session-resume.sh <profile> <agent>
  [environment-name]` is the C13 driver: it plants a codeword, rebuilds onto a
  new runtime generation and checks the resumed session repeats it (exit 0
  pass, 1 fail, 2 setup error).
- `detectDockerTopology` (`apps/backend/src/core/docker-image.ts`) reports
  `desktop` and `rootless`, but neither is qualified. The living doc says
  "Qualified locally: Docker Engine 29.7.2 on Linux amd64".
- Unit-only today: readiness failure typing (`apps/backend/tests/container-readiness.test.ts`),
  C10 (setup interrupted after a side effect), the fixture half of C21
  (interrupted revoke, staging interrupted by a restart), and kill-at-every-phase
  reconciliation of a rebuild.

The commands that reproduce the evidence, the C01–C30 scenario matrix, the
platform dimensions and the benchmark targets are in
[container-qualification.md](../development/container-qualification.md).

## Outstanding work

### Qualification

- Re-run the full live set on current `main`: the four live suites, the
  benchmarks against the regression targets, `test:agent:docker` and
  `test:agent:browser:isolated`. The only recorded evidence predates the
  Bun 1.4.3 base image, five agent upgrades (#880, #888, #891, #935, #964),
  account switching (#889), host reachability (#885), SQLite storage (#969)
  and the module and runtime refactors (#967, #978). Record fixture revision,
  image id, platform, command and result per scenario.
- Docker Desktop on Apple Silicon, a primary target. Run the whole live set
  and the real-stack Docker run, in restricted and full mode, with ordinary
  and root terminals, fresh and legacy environments. Cover in particular:
  - the `host.docker.internal` path without the host-gateway alias
    (`createDockerContainer` adds the alias only for a Linux Engine);
  - IPv6 drop and sibling isolation (container IP, environment gateway, a
    sibling's published port);
  - VM capacity reporting through `docker info`, and the capacity preflight
    measured inside a helper on the VM's filesystem;
  - volume sub-path mounts (`volume-v1` needs Engine 26+,
    `MIN_ENGINE_FOR_VOLUME_SUBPATH`);
  - the shell fixtures' dependence on GNU tools (#988 made them prefer
    Homebrew GNU `tar`/`date`).

  Done when the live set passes or each failure is a narrowly gated
  unsupported capability, and the "Qualified locally" line in
  `container-lifecycle.md` names the Desktop version.
- Rootless Engine. Show that cgroup or firewall enforcement the daemon cannot
  provide is reported as unsupported (the resource policy's unsupported axes,
  the `rootless` topology flag) and refused precisely, never silently
  weakened.
- arm64 live suites. Run the C-scenarios on native arm64 hardware (Desktop on
  Apple Silicon covers this) and mark any evidence that came only from
  emulation.
- Registry measurements: compressed manifest and layer bytes, and cold pull
  time, against a pushed GHCR image. `publish-container.yml` records the
  digest in `image-release.json`.
- Provider session resume after a rebuild (C13) for Codex, OpenCode, Pi,
  Cursor and Grok. Add each provider that passes to
  `RESUME_QUALIFIED_PROVIDERS`, and update its `PROVIDER_PRESERVATION` text in
  `container-state-layout.ts`. This includes the relocated Codex runtime
  databases (`CODEX_SQLITE_HOME`) and the Grok session index, both "pending
  qualification" today. The earlier attempt failed before any rebuild:
  Codex app-server turns finished with no assistant message, the OpenCode
  model was not connected, Pi's first turn did not finish, and Cursor and
  Grok sessions did not start. The proof also requires that an ambiguous
  dispatch stays unresolved rather than being resent.
- Live credential rotation (C21 live half) while a provider process is
  running: the documented stop/restart behaviour holds and no partial
  revision is published. `syncContainerClaudeCredential` and the Cursor file
  sync still refresh a running container; account switching
  (`apps/backend/src/core/agent-accounts-containers.ts`) is a natural
  rotation path to exercise.
- Stop with a pending approval (C11 approval half), with a real provider:
  switch away, stop explicitly, return. The approval is denied or withdrawn,
  never approved.
- Readiness failure injection on a real daemon: missing firewall script,
  DNS/bootstrap failure, permission failure, an interrupted status write and
  a Docker restart during launch, plus C10. Inject faults through fixtures at
  the lifecycle-service boundary only.
- Daemon disconnect mid-copy and a live process kill just before and after the
  rebuild commit write. Both are covered by unit reconciliation and the
  capacity preflight, not by a live run.
- Backend upgrade and rollback with real releases. Start current `main` over
  a data directory and containers left by an older release (legacy images and
  records) and show nothing is migrated or mutated implicitly. Then open a
  directory current `main` has written with a release at the rollback floor
  (the first to ship `container-lifecycle.schema.json`) and show it stays
  read-only and refuses every container mutation. Only
  `apps/backend/tests/container-lifecycle-service.test.ts` covers the schema
  floor today, with in-process writers.
- Live host-service reply (C22). The original host's ufw dropped
  container-to-host traffic, so the agent-tools port was only shown to leave
  the container. On a host where `container-host-reachability.ts` reports the
  path open, check the port is actually answered.

## Constraints and rationale

- Never test against a production installation or the packaged user's Docker
  resources, and never use or retag `orkestrator-v2:latest` as the
  qualification image.
- Label every resource with a private owner namespace and remove exactly
  those. Never prune, globally or by owner.
- A skipped or timed-out run is incomplete, not a pass. Record flakes in the
  registry; do not weaken assertions to hide races.
- Provider runs use only authorized agent-test credential sources. Synthetic
  file, network and lifecycle scenarios need no real credentials.
- Never claim one provider's capability from another's success. An untested
  capability stays "pending qualification" in the product.
- A fake `docker` executable cannot prove filesystem retention, packet rules,
  mount permissions, name conflicts or signal delivery; those need the live
  suites.
- Benchmark artifacts carry no commands, paths, contents or private
  endpoints.

## Open questions

- Which Engine and Desktop versions become the published minimum once Desktop
  is qualified, and is rootless supported with gated features or refused?
- Should the live suites get a scheduled CI job on a Docker-capable runner
  (Linux amd64 and arm64)?

## Needs verification

- Whether anyone has run the live suites since #877. No later evidence is
  recorded in the repository.

## Related

- [live-provider-and-platform-qualification.md](live-provider-and-platform-qualification.md):
  shared prerequisites and batching. The Docker Desktop rows of
  [service-preview-rollout.md](service-preview-rollout.md) and
  [cli-qualification.md](cli-qualification.md) belong in the same platform
  run.
- [mobile-layout-gaps.md](mobile-layout-gaps.md): the environment settings
  dialog blocked by the projects drawer, found during the container settings
  real-stack run.
- [container-rebuild-state-preservation.md](container-rebuild-state-preservation.md),
  [container-network-and-credential-isolation.md](container-network-and-credential-isolation.md),
  [container-resource-budgets-and-performance.md](container-resource-budgets-and-performance.md),
  [environment-and-disk-cleanup.md](environment-and-disk-cleanup.md)
  (container deletion through the ledger on Desktop).
- [Container qualification](../development/container-qualification.md):
  C01–C30 scenario definitions, platform dimensions, suite commands and
  benchmark targets.
- [Container lifecycle](../architecture/container-lifecycle.md),
  [agent testing](../development/agent-testing.md),
  [testing guide](../development/testing-guide.md).

## Replaces

- `docs/improvements/containers/qualification.md` (reproduce commands, open
  limitations; the per-scenario evidence is historical)
- `docs/improvements/containers/remaining-work.md` (environment-limited list;
  items 1–39 shipped in #877)
- `docs/improvements/containers/plan/14-integrated-qualification-and-rollout.md`
  (release gates and the upgrade/rollback check; the scenario matrix, platform
  dimensions and evidence workflow moved to
  `docs/development/container-qualification.md`)
- `docs/improvements/containers/plan/00-index.md` (the minimum Engine/Desktop
  and rootless decision gate)
- `docs/improvements/containers/plan/01-immediate-data-loss-safeguards.md`,
  `docs/improvements/containers/plan/02-lifecycle-authority-and-durable-operations.md`,
  `docs/improvements/containers/plan/03-image-contracts-and-daemon-preflight.md`,
  `docs/improvements/containers/plan/04-runtime-readiness-and-graceful-shutdown.md`
  (limitation lines; the steps shipped in #877)
- `docs/improvements/containers/plan/05-persistent-workspace-and-agent-state.md`
  (per-provider resume limitation)
- `docs/improvements/containers/plan/06-migration-and-transactional-replacement.md`
  (live disconnect and kill limitation)
- `docs/improvements/containers/plan/08-portable-inputs-and-credential-lifecycle.md`
  (live rotation)
- `docs/improvements/containers/plan/09-environment-networks-and-egress-policy.md`
  (Desktop and arm64 packet tests, the ufw limitation)
- `docs/improvements/containers/plan/10-resource-budgets-and-usage-telemetry.md`
  (Desktop and rootless enforcement)
- `docs/improvements/containers/plan/12-image-build-and-release-delivery.md`
  (arm64, registry size and pull time)
- `docs/improvements/containers.md` (acceptance criteria for findings 5 and 9
  on Docker Desktop)
