# 01 — Immediate data-loss safeguards

Status: Implemented on branch; awaiting review. Dependencies: none.
Return to [index](00-index.md).

## Goal and scope

Stop the current UI from promising preservation that recreation cannot provide,
and prevent routine cleanup from discarding assigned environments. Ship this
before persistent volumes are ready. Do not implement a partial migration or
claim that Git cleanliness proves the absence of valuable local data.

## Existing integration points

- [EnvironmentSettingsDialog](../../../../apps/web/src/components/environments/EnvironmentSettingsDialog.tsx):
  port-change confirmation and `handleRestartWithChanges`.
- [DockerStatsDialog](../../../../apps/web/src/components/docker/DockerStatsDialog.tsx):
  prune, orphan cleanup and direct container deletion.
- [Environment lifecycle](../../../../apps/backend/src/core/commands-environment.ts):
  `recreateEnvironmentOnce`, setup short-circuit and status reconciliation.
- [Docker registry](../../../../apps/backend/src/core/commands-registry-docker.ts):
  prune, raw remove and orphan cleanup handlers.
- [Environment storage](../../../../apps/backend/src/core/storage-projects.ts):
  explicit setup-field updates when a runtime is discarded.
- [Backend client](../../../../apps/web/src/lib/backend/projects-environments.ts):
  recreation request/result contract.

## Implementation tasks

### Safe legacy behavior

- [x] Replace the filesystem-preservation sentence with a precise warning:
  this legacy operation deletes the container's local files, installed tools
  and container-local session state; remote Git does not back up everything.
- [x] Change the port-edit default to save settings for a later safe rebuild.
  Expose an explicitly named destructive reset only when the user selects it.
  Do not silently apply the saved settings by destroying the runtime later.
- [x] Add an additive backend request field distinguishing `preserve` from
  `discard`, with omission resolving to `preserve`. For a legacy writable-layer
  container, return a typed `preservation-required` result until step 06 exists.
  An old client calling recreation with no field must fail safely.
- [x] Bind explicit discard to the environment and expected container ID.
  Re-read both under the existing lifecycle queue before removal. A stale
  request must conflict and require a new review of the affected runtime.
- [x] Audit every recreation caller, including the sidebar, action bar, settings,
  automation and raw remove commands. No alternate route should retain the
  unsafe default. Keep authorization in the backend, not just the dialog.

### Cleanup protection

- [x] Replace owner-wide stopped-container prune with an explicit candidate
  inventory. Exclude assigned container IDs, environment labels naming a live
  record, deletion/replacement resources and any identity that is uncertain.
- [x] Recheck assignment immediately before removal. Until step 02 provides
  common resource locking, conservatively refuse a candidate associated with
  an in-flight environment operation.
- [x] Do not infer eligibility from age, stopped status or missing UI tabs.
  A stopped environment remains valuable user state.
- [x] Return separate removed, skipped and failed results; increment removed
  only after successful removal or a confirmed already-absent result.
- [x] Preserve the existing no-image/no-network/no-volume-prune behavior.
  Update UI wording and result rendering to match the actual scope.

### Replacement correctness before the new model

- [x] Treat a confirmed missing container as already removed. For every other
  removal error, retain its ID and lifecycle error; do not advance to a create
  that will collide with the deterministic name.
- [x] Only after successful explicit discard, clear old setup completion,
  override, setup session/timestamps and checkout baseline. Preserve immutable
  delegation intent so its requested commit is checked out again correctly.
- [x] Invalidate old bridge/terminal connection state and stale pending launch
  references. Reuse existing cleanup helpers; do not cancel unrelated work.
- [x] Distinguish a missing runtime from an unreachable daemon in reconciliation.
  Never clear references because a probe timed out or lacked permission.

## Verification

- [x] Extend lifecycle fixtures in
  [commands-registry-environments.test.ts](../../../../tests/unit/electron/commands-registry-environments.test.ts)
  and [status tests](../../../../tests/unit/electron/commands-registry-environments-status.test.ts):
  omitted discard intent refuses destruction; removal failure retains identity;
  successful discard invalidates setup and re-prepares the checkout.
- [x] Change the fake Docker test that accepts recreation after every removal
  failure. Model the actual occupied-name case instead of expecting success.
- [x] Extend
  [Docker registry tests](../../../../tests/unit/electron/commands-registry-docker.test.ts)
  for assigned stopped containers, missing-ID/live-label containers, failed
  removal counts and assignment changes between preview and execution.
- [x] Component/browser tests prove port edits cannot show a preservation
  promise or send implicit discard, and old dialogs handle a conflict result.
- [ ] In an isolated real container, create untracked/ignored content and an
  unpushed commit. A normal port change and ordinary cleanup must preserve the
  container. Explicit discard must be clearly identified as destructive.

## Delivery, rollback and exit criteria

Split into a backend safety PR and its compatible UI wiring if useful; the
backend safe default must land first. A temporary refusal to recreate is an
acceptable transitional result. Restoring the old destructive default is not
an acceptable rollback. Existing start/stop remains available.

Exit when no default port-change/recreate request can discard a legacy
workspace, assigned stopped environments are excluded from routine cleanup,
and real name-conflict evidence agrees with the fixture tests. This step does
not claim to preserve data during an explicitly destructive reset.

## Implementation record

- **Contract.** `packages/protocol/src/container-lifecycle.ts` defines
  `RecreateEnvironmentRequest` (`intent: "preserve" | "discard"`, omitted →
  `preserve`; discard requires `expectedContainerId`) and typed failures
  encoded as `ContainerLifecycleError:<code>: <message>`.
- **Backend.** `recreateEnvironmentOnce` refuses `preserve` with
  `preservation-required` (every container is legacy writable-layer until step
  06), rechecks the reviewed container under the lifecycle queue
  (`runtime-changed`), treats only confirmed absence as removal and otherwise
  keeps the reference with `containerRemovalFailed` (`removal-failed`, no
  create). A confirmed discard clears setup completion/override/session,
  `createdFromCommit` and `hostEntryPort`, keeps `delegationBaseCommit`, clears
  pane terminal ids, setup buffers, pending launch intent, Claude polling,
  OpenCode tool configuration and the Git-fetch record of the old container.
- **Callers.** Settings dialog, sidebar/action bar/preview (all through the
  dialog), public API (`discard` input, refused without it), CLI
  (`environment recreate --discard`) and raw `docker_remove_container` (refuses
  any claimed container) were audited.
- **Cleanup.** `docker-cleanup-inventory.ts` replaces `docker container prune`
  with an exact inventory. Exclusions: assigned, live environment label,
  pending deletion ledger entry, in-flight start/lifecycle operation, foreign
  or unlabelled-app owner, uncertain state. Each candidate is rechecked
  immediately before a non-forced `docker rm`; results report removed,
  already-absent, skipped and failed separately. No image/network/volume prune.
- **Reconciliation.** `sync_all_environments_with_docker` now clears a
  reference only on a definite "no such object" (or strict foreign owner),
  never on an unreachable daemon, timeout or permission failure.
- **Tests.** `packages/protocol/src/container-lifecycle.test.ts`;
  `tests/unit/electron/commands-registry-environments.test.ts` (implicit
  intent refused, stale review conflicts, removal failure retains identity with
  an occupied-name fake, discard re-prepares and keeps the delegation base);
  `commands-registry-environments-status.test.ts` (daemon-down full sync);
  `commands-registry-docker.test.ts` (assigned/linked/racing/failed cleanup,
  raw removal refusal); `tests/unit/components/EnvironmentSettingsDialog.test.tsx`.
- **Limitations.** The real-container scenario (untracked/ignored files and an
  unpushed commit surviving a port edit and cleanup) is covered by the step 14
  live qualification suite rather than here.
