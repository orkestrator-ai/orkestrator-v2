# 14 — Integrated qualification and rollout

Status: Implemented on branch; awaiting review. Dependencies: steps 01–13, including explicit deferrals
permitted by their exit criteria. Return to [index](00-index.md).

## Goal

Prove the combined container lifecycle on real supported platforms and ship it
without forcing unsafe migration or losing the ability to recover existing
environments. This is a release gate in addition to each step's focused checks.

## Existing validation entry points

- [Testing guide](../../../development/testing-guide.md) and
  [agent profile guide](../../../development/agent-testing.md).
- [Docker/browser fixture tests](../../../../e2e/agent-testing/browser-gateway.spec.ts),
  [artifact sanitizer](../../../../e2e/agent-testing/artifact-sanitizer.ts).
- [Environment lifecycle tests](../../../../tests/unit/electron/commands-registry-environments.test.ts),
  [status/ownership tests](../../../../tests/unit/electron/commands-registry-environments-status.test.ts),
  [Docker registry tests](../../../../tests/unit/electron/commands-registry-docker.test.ts),
  [firewall tests](../../../../tests/unit/firewall-policy.test.ts).

Extend the existing isolated harness rather than creating a second uncontrolled
Docker test launcher. Add fixture-only fault injection at the lifecycle service
boundary; never ship a production setting that lets an untrusted client bypass
ownership or write arbitrary operation phases.

## Required scenario matrix

| ID | Scenario | Proof required | Steps |
| --- | --- | --- | --- |
| C01 | Port edit on a legacy environment | No implicit discard; old-client request fails safely | 01 |
| C02 | Routine cleanup with assigned stopped container | Workspace and runtime remain | 01, 07 |
| C03 | Failed removal retaining original Docker name | Reference retained; no fictitious successful replacement | 01, 02 |
| C04 | Foreign-owner ID through raw/gateway command | Refused in production and strict profiles | 02 |
| C05 | Two writers and repeated operation ID | One admitted mutation and one durable outcome | 02 |
| C06 | Create success followed by backend crash | Exact resource adopted; no duplicate runtime | 02 |
| C07 | Mutable image tag changes mid-operation | Candidate uses resolved immutable image ID | 03 |
| C08 | Unsupported remote daemon/old image | Actionable preflight failure before destructive work | 03 |
| C09 | Stale marker and delayed current boot | No setup/agent launch before current readiness | 04 |
| C10 | Setup interrupted after possible side effect | No automatic duplicate setup or false ready state | 04 |
| C11 | Stop with running descendants and approval | Bounded drain; no accidental approval; children reaped | 04 |
| C12 | New persistent workspace stop/start | Full fixture state retained and real mounts verified | 05 |
| C13 | Provider state/session restore | Correct history/lineage; ambiguous dispatch remains unresolved | 05, 06 |
| C14 | Legacy migration and runtime-only rebuild | Verified bytes/Git state; correct workspace generation | 06 |
| C15 | Failure at every transaction boundary | One authoritative set; original retained before commit | 06 |
| C16 | Disk/inode exhaustion, archive/link corruption | Fail safely without modifying the original | 06 |
| C17 | Candidate writes after commit then health failure | New work preserved; no automatic old-copy restore | 06, 07 |
| C18 | Cleanup preview races with attachment/commit | Stale selection conflicts; new assignment survives | 07 |
| C19 | Delete interrupted between runtime/volume removal | Tombstone resumes; accurate per-resource counts | 07 |
| C20 | Disabled-provider and excluded-history sentinels | Unreadable from all workload-visible input mounts | 08 |
| C21 | Credential refresh/revoke interrupted | Atomic revision, honest pending state, no secret diagnostics | 08 |
| C22 | Sibling/host/DNS/IPv6 network access | Tested allow/deny matrix; no guessed subnet exception | 09 |
| C23 | DNS refresh/removal and firewall failure | Effective revision accurate; no allow-all interval | 09 |
| C24 | CPU/memory/PID budget pressure | Enforced limits, truthful cause/scope and usable sibling | 10 |
| C25 | Usage unavailable or stale | Unknown/stale display, no fabricated zero measurement | 10 |
| C26 | Log churn, large lines and slow client | Bounded memory/files/processes; explicit replay gap | 11 |
| C27 | Final image on both architectures | All runtime artifacts, authenticated bridges and Chromium work | 12 |
| C28 | Cold/warm multi-environment runs | Reproducible performance report and bounded overhead | 13 |
| C29 | Switch away/reconnect during each long operation | Snapshot restores status, prompts, controls and progress | All lifecycle steps |
| C30 | Local-worktree environment regression | Existing non-Docker behavior still works | Cross-cutting |

Each case should record its fixture revision, image ID, platform, test command,
result and private artifact location. No real provider credentials are needed
for synthetic file/network/lifecycle tests. Provider-specific resume/login
qualification uses only authorized profile credential sources.

## Platform and compatibility dimensions

- Linux Engine on amd64 and Docker Desktop on Apple Silicon are primary
  qualification targets; add supported Desktop/Engine variants to match the
  actual product release matrix. Test arm64 images on native hardware where
  available and identify any emulated-only evidence.
- Run both restricted and full mode, ordinary and root terminal paths, fresh
  and legacy environments, stopped and active migration, missing image/daemon
  and Desktop VM capacity limits.
- Exercise all six providers for their advertised session preservation and
  startup behavior. Mark an untested provider capability unavailable or pending
  qualification; do not claim it from another provider's success.
- Verify backend upgrade with old images/records and rollback refusal for new
  unsupported storage formats. Unsupported rootless behavior is documented and
  refused precisely; never silently weaken isolation to make a test pass.

## Commands and evidence workflow

Use the guide's current commands when implementation begins. The following are
the intended entry points, run separately so each result belongs to one check:

```bash
mise run test:logged -- --name container-lifecycle -- \
  bun test ./tests/unit/electron/commands-registry-environments.test.ts \
  --parallel=1 --only-failures

mise run test:changed
mise run test:logged -- --name container-check -- mise run check
mise run test

mise run dev:test --profile container-qa --fixture --fixture-environments local,container
mise run docker:build:dev --profile container-qa

ORKESTRATOR_AGENT_TEST_PROFILE=container-qa \
mise run test:logged -- --name container-agent-docker -- mise run test:agent:docker

ORKESTRATOR_AGENT_TEST_PROFILE=container-qa \
mise run test:logged -- --name container-agent-browser -- mise run test:agent:browser
```

Rebuild the profile-specific image before qualification if it already existed;
restart/recreate fixture runtimes deliberately so they use that image. Follow
the guide for profile status, restart and cleanup; do not operate on the live
checkout or packaged user's Docker resources. Run Electron tests when IPC or
desktop shutdown changed. iOS validation is required only for affected/release
scope per the testing guide and must be reported explicitly when unavailable.

Tests that time out while awaiting infrastructure are incomplete, not passed.
Record flakes using the existing registry and preserve assertions rather than
weakening them to hide races. Keep all test subprocesses/output within the
repository runner's budgets.

## Rollout stages

1. **Safety patch:** ship 01 independently. Accurate warnings, protected cleanup
   and guarded legacy recreation do not wait for the full new architecture.
2. **Additive readers and image:** ship operation/schema readers and capable
   image while legacy behavior stays guarded. Unknown-format mutation is denied.
3. **New environments:** enable versioned persistent layouts, staged inputs and
   tested policy for newly created environments. Capture bounded operational
   failure rates without content telemetry.
4. **Explicit migration:** expose preserve/migrate for a selected environment.
   Display retained-copy cost, downtime and unsupported preservation categories.
   No migration occurs merely on startup or when opening a tab.
5. **Default safe rebuild:** after the matrix passes, route normal port/image
   changes through preservation. Keep explicit reset/delete distinct.
6. **Legacy retirement:** remove broad-mount/old-layout support only after
   users have an export/migration path and retained resources are accounted for.
   Do not tie retirement to an arbitrary app launch count.

Use persisted capability/layout versions as the long-term compatibility boundary.
If temporary rollout switches are needed, define owner, removal criteria and
safe disabled behavior; do not accumulate permanent duplicate lifecycle engines.

## Rollback and release gates

- [ ] Before enabling a new writer/schema, test that binaries at the supported
  rollback floor honor the minimum-writer marker and refuse unsupported
  destructive work. Block downgrade below that floor through supported install
  paths. Historical binaries that predate the marker cannot be made safe by
  writing new metadata; document manual-bypass limits. A metadata backup alone
  cannot roll back files an old binary might delete.
- [ ] Keep prior compatible image digests available. An incompatible provider
  database downgrade requires restoring a separate retained copy, never mounting
  newer state read-write into the old runtime.
- [ ] On elevated failure rates, disable new migrations/rebuild admissions,
  continue existing operations/recovery readers and keep data mounted/stopped
  safely. Do not restore the old prune or implicit discard behavior.
- [ ] Review retained helper/volume/network inventory after qualification;
  cleanup only task-owned reviewed resources. Preserve private evidence required
  for unresolved failures within retention bounds.
- [ ] Publish measured limitations, minimum tested versions and user-visible
  preservation semantics in living docs. Update AGENTS.md network/storage
  guidance, README image instructions and the documentation catalog.
- [ ] Obtain human PR/release review. No agent merges to `main` or changes the
  user's production environment as part of qualification.

Exit when C01–C30 have passing evidence or a narrowly documented unsupported
capability that the product actually gates, rollback behavior is demonstrated,
and every implementation step's record and index status are consistent.

## Implementation record

- **Evidence.** [`../qualification.md`](../qualification.md) records C01–C30:
  24 pass, 6 partial with the missing proof named (C13 provider resume — gated
  in the UI; C16 disk exhaustion; C21 live credential refresh; C23 DNS
  refresh; C27 arm64; C29 live switch-away during a rebuild). Suites: `mise
  run test`, the three live Docker suites (18 scenarios), the benchmark
  harness, `test:agent:browser:isolated`, and `test:agent:docker` against a
  container fixture profile — including a new
  `e2e/agent-testing/container-settings.spec.ts` (desktop and narrow, reload)
  and a public-CLI preserving rebuild of the real fixture container.
- **Fixes found by qualification.** `dev:reset` now removes the profile's
  exact-owner volumes and networks; the settings dialog gained a Container
  section instead of hiding container actions under Ports; the rebuild preview
  no longer implies provider resume that has not been verified.
- **Docs.** README image instructions (`mise run docker:build`, digest
  records, capability-gated behaviour, rebuild to adopt a new image), the
  documentation catalog, AGENTS.md network/storage guidance.
- **Found, not fixed.** A pre-existing mobile defect: Settings opened from the
  narrow sidebar's actions menu is blocked by the still-open projects drawer.

## Audit follow-up (2026-09-27)

An item-by-item audit of this step's checklist against the code found gaps
the record above did not state. They were closed and are tracked with their
evidence in [remaining-work.md](../remaining-work.md) (items 15, 31);
what could not be done on this host is listed there as environment-limited.

