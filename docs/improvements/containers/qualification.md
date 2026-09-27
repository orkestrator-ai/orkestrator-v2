# Container qualification (step 14)

Evidence for the [scenario matrix](plan/14-integrated-qualification-and-rollout.md#required-scenario-matrix)
on branch `implement-containers-50431d61c9b0-r1`. Platform: Linux x86_64,
Docker Engine 29.7.2 (containerd store), Bun 1.4.2. Image: the branch's
`docker/Dockerfile`, tagged `orkestrator-v2:containers-plan-check` for live
suites and built as the profile's workspace-specific development image for
the real-stack runs; `orkestrator-v2:latest` was never used or retagged.

How to reproduce:

| Suite | Command |
| --- | --- |
| Unit and integration (complete) | `mise run test` |
| Final image | `bash docker/tests/final-image-smoke.sh <image>` |
| Live Docker scenarios | `RUN_LIVE_DOCKER_TESTS=1 ORKESTRATOR_QUALIFICATION_IMAGE=<image> bun test tests/unit/electron/container-live-qualification.test.ts tests/unit/electron/container-live-replacement.test.ts tests/unit/electron/container-live-network.test.ts tests/unit/electron/container-live-firewall.test.ts` |
| Benchmarks | `RUN_CONTAINER_BENCHMARKS=1 ORKESTRATOR_QUALIFICATION_IMAGE=<image> bun test tests/unit/electron/container-benchmarks.test.ts` |
| Real stack, local | `mise run test:agent:browser:isolated` |
| Real stack, Docker | `mise run dev:test --profile <p> --fixture --fixture-environments local,container`, then `ORKESTRATOR_AGENT_TEST_PROFILE=<p> mise run test:agent:docker` (includes the rebuild cycle) |

Live suites label every resource with a private owner namespace and remove
exactly those; the real-stack profile was stopped and reset afterwards
(`dev:reset` now also removes the profile's volumes and networks).

## Matrix

"Unit" means fake-daemon tests in `mise run test`; "Live" means the real
Engine; "Real stack" means the Vite renderer, real backend and Electron main
process of an isolated `dev:test` profile.

| ID | Result | Evidence |
| --- | --- | --- |
| C01 | Pass | Unit: `commands-registry-environments.test.ts` (implicit and preserve recreates without a reviewed id refused, discard requires the id), `EnvironmentSettingsDialog.test.tsx` (saving ports never recreates) |
| C02 | Pass | Unit: `commands-registry-docker.test.ts` (keeps assigned, linked and racing containers; raw removal refuses an environment's container), `recovery-copies.test.ts` (volumes by reference). Live: C18 |
| C03 | Pass | Unit: `commands-registry-environments.test.ts` (failed removal keeps the reference, `removal-failed`) |
| C04 | Pass | Unit: `container-lifecycle-service.test.ts` (labels decide ownership in every profile), `docker-ownership.test.ts`. Real stack: "Docker fixture rejects containers owned by another profile" |
| C05 | Pass | Unit: `container-lifecycle-service.test.ts` (one writer per data directory, lease reclaim, dedupe of a repeated operation id, stale revision conflict) |
| C06 | Pass | Unit: `container-lifecycle-service.test.ts` (a create that succeeded before the crash is adopted, not repeated; a crash after the pointer write keeps one runtime) |
| C07 | Pass | Unit: `docker-image.test.ts` (a create uses the id resolved at admission after the tag moves) |
| C08 | Pass | Unit: `docker-image.test.ts` (remote daemon refused before anything is created; legacy image classified), `container-replacement.test.ts` (image without the storage contract refused before the source stops) |
| C09 | Pass | Live: `container-live-qualification.test.ts` C09 (a restarted container never reports a previous boot's readiness) |
| C10 | Pass (unit) | Unit: `container-readiness.test.ts` (a legacy-layer completion does not survive a runtime replacement; failed boot and timeout are typed), setup completion bound to runtime generation |
| C11 | Pass | Live: C11 (bounded drain under `--init`, forced stop recorded) |
| C12 | Pass | Live: C12 (tracked/untracked/ignored/binary files, modes, symlinks, branches, unpushed commit survive stop/start and runtime replacement; all state paths node-owned) |
| C13 | Partial — gated | Live C14 copies Claude and Codex transcripts, relocated Codex SQLite with WAL and the OpenCode DB. Resuming a preserved session in the real provider CLI/SDK was **not** run; the rebuild preview says session files are copied but resume is not yet verified (`resumeQualified: false`), and Codex/OpenCode/Grok are declared partial |
| C14 | Pass | Live: legacy migration and volume rebuild (Git refs/status, bytes, modes, symlinks, relocations; config and snapshots not copied). Real stack: `orkestrator environment recreate` on the fixture container kept an untracked file on a new `-g2` runtime |
| C15 | Pass | Live: cancellation during copy, changed-runtime refusal. Unit: restart reconciliation of `migrate`/`rebuild`/`restore` at every phase removes only the candidate; the commit is one write |
| C16 | Pass | Live: candidate volumes that run out of inodes and out of bytes mid-copy (tmpfs-backed), a symlinked session root, and a candidate name held by another container all roll back with the original intact and startable. Unit: capacity verdicts on bytes and inodes, unknown capacity refused unless accepted, truncated archives, escaping hard links and device nodes refused, reconciliation at every pre-commit phase and just after the commit write |
| C17 | Pass | Live: restore the legacy copy after newer work, restore the newer copy back (new work retained), discard. Post-commit reconciliation never reverts pointers (no unresolved operation) |
| C18 | Pass | Unit: execution refuses a resource that became assigned and one outside the preview; tokens are consumed. Live: only the reviewed leftover volume removed |
| C19 | Pass | Live: deletion stopped after the container step, the reconciler later removed volumes, the recovery copy and the network, and cleared the ledger |
| C20 | Pass | Live: only enabled providers' allowlisted files mounted read-only; unique sentinels in histories, transcripts and a disabled provider's credentials unreachable anywhere in the container |
| C21 | Pass (fixture) / live-provider partial | Unit: revocation recorded before anything else, so an interrupted revoke still gates staging and syncs; staged inputs emptied in place (bound files keep their inode); bridge stopped; "Allow again"; a staging interrupted by a restart is never read and is pruned after its grace; atomic revision publication and private modes. Rotation against a live provider process needs real provider credentials |
| C22 | Pass | Live: own network, IPv6 disabled, service port leaves the container while other host ports and a sibling are rejected, example.com blocked, ingress via published port, durable atomic host-port update across restart |
| C23 | Pass | Live: `container-live-firewall.test.ts` — a saved list is reported pending, then applied in place; an open keep-alive connection survives an edit that keeps its domain and is cut when the domain is removed (conntrack revocation); one root refresher that node can neither signal nor duplicate; malformed lists refused unchanged; the applied list survives a restart; a list saved while stopped stays pending until applied. Unit: atomic swap order, expiry-bounded carry-over, rotation keeps earlier addresses, fail-closed firewall, GitHub seed → live → cache order |
| C24 | Pass | Live: limits applied and read back; PID exhaustion contained and recovered; OOM killed the allocating process, not PID 1; live update read back; a CPU-saturated environment held to its one-core budget while a sibling answers `docker exec` promptly; shared memory 256 MiB under a 512 MiB budget |
| C25 | Pass | Unit: unreachable daemon → unknown, not zero; stale marking; UI shows unknown disk/memory and stale samples |
| C26 | Pass | Live: `local` driver 10 MiB × 3; 40 MB through the bridge launch path stays within 15 MiB; real followers shared and stopped. Unit: huge lines, split UTF-8, ring gaps, leases, caps |
| C27 | Pass (amd64) / arm64 in CI | Live, amd64: `docker/tests/final-image-smoke.sh` — manifest versions equal the installed CLIs, all five bridges answer `/global/health`, Codex code-mode host present, Chromium launches; the full live set passes on the final image. CI runs the same smoke test on its native arm64 build; arm64 was not built on this host |
| C28 | Pass | [benchmarks.md](benchmarks.md): 5 fresh, 3 concurrent, 10 warm, 5 + 3 rebuilds, sampler, Docker calls per minute, churn; regression targets recorded |
| C29 | Pass | Real stack: `container-rebuild-cycle.spec.ts` starts a rebuild, switches to another environment while it runs, returns to backend-owned progress and exactly one new recovery copy, reloads, and opens reviewed cleanup; Container and Network sections rehydrate at desktop and narrow widths. The run exposed and fixed a recovery-copy list that did not refresh on commit |
| C30 | Pass | Real stack: `mise run test:agent:browser:isolated` (local worktree create, terminal, reload rehydration, diff state) |

## Rollout stage status

1. Safety patch — implemented (step 01): guarded recreate, protected cleanup.
2. Additive readers and image — implemented: lifecycle record, schema floor,
   writer lease, capability manifest.
3. New environments — implemented: new runtimes of a capable image get
   persistent storage, staged inputs, their own network and bounded logs.
4. Explicit migration — implemented: "Rebuild (keeps files)" and `recreate`
   without `--discard`; nothing migrates on startup or tab open.
5. Default safe rebuild — implemented for recreate; port edits are saved and
   applied by an explicit rebuild.
6. Legacy retirement — not started (by design: needs an export path and a
   decision outside this change).

## Rollback and release gates

- Minimum-writer marker: a backend older than the marker's writer version
  opens read-only and refuses destructive work (`registry-writer-lease.ts`,
  unit-tested). Binaries that predate the marker cannot honour it; downgrading
  below this branch is not safe for environments migrated to `volume-v1`.
- Prior image digests remain available; a runtime keeps its pinned image id,
  and an incompatible provider database is recovered from a retained copy, not
  by mounting newer state into an old runtime.
- Rebuild/migration admission can be paused with
  `ORKESTRATOR_CONTAINER_REPLACEMENT=paused`: new rebuilds and migrations are
  refused before anything runs (the rebuild preview says `admission-paused`),
  while listing, restoring and discarding recovery copies and resolving an
  interrupted operation keep working. The old prune and implicit discard are
  gone.
- Resource inventory after qualification: all live-suite and profile
  resources removed by exact owner label; nothing else touched.
- Human review of the pull request is required; nothing here merges or changes
  a production installation.

## Known limitations and follow-ups

An item-by-item audit of steps 06–14 after this record was written found
further gaps; they are tracked to closure in
[remaining-work.md](remaining-work.md).

- Mobile: opening an environment's Settings from the narrow sidebar's
  "Environment actions" menu leaves the projects drawer (a modal dialog) open
  underneath, which blocks all interaction with the settings view. This is
  pre-existing and unrelated to the container sections; Tools → Environment
  settings works. Fixing it means moving the dialog's state out of the sidebar
  row.
- Provider session resume after a rebuild (C13) and credential refresh against
  live providers (C21) need authorized real-provider runs.
- Docker Desktop, rootless Engine and arm64 were not available on this host.
