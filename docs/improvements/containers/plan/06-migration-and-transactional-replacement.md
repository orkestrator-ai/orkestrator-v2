# 06 — Migration and transactional replacement

Status: Not started. Dependencies:
[04](04-runtime-readiness-and-graceful-shutdown.md),
[05](05-persistent-workspace-and-agent-state.md).
Return to [index](00-index.md).

## Goal

Make legacy migration, image rebuild and port/network/resource replacement
preserve declared data, with a durable commit point and a defined result for
every interruption. Re-enable the default preservation request blocked in 01
only when this operation is available and qualified.

## Integration points

- [Recreation lifecycle](../../../../apps/backend/src/core/commands-environment.ts),
  [container creation](../../../../apps/backend/src/core/commands-containers.ts),
  [storage mutations](../../../../apps/backend/src/core/storage-projects.ts).
- [Backend client](../../../../apps/web/src/lib/backend/projects-environments.ts),
  [settings dialog](../../../../apps/web/src/components/environments/EnvironmentSettingsDialog.tsx),
  [environment store](../../../../apps/web/src/stores/environmentStore.ts).
- Proposed step 02 lifecycle service, step 03 manifest reader and step 05
  storage-layout adapters.

## Transaction model

Docker and backend JSON storage cannot participate in one atomic transaction.
Implement a durable sequence with idempotent phases and compensating actions.
Persist each phase transition before the next external effect; only the final
backend pointer promotion is the logical commit.

| Phase | Required effect/evidence | Recovery after interruption |
| --- | --- | --- |
| Requested | Expected source/config revision and preserve intent stored | Revalidate source and request |
| Preflight | Image compatibility, layout and capacity checked | Repeat read-only checks |
| Quiescing | New writers fenced; turns/setup/jobs drained | Reconcile live processes; never assume drain completed |
| Source stopped | Exact original runtime stopped, identity retained | Keep it stopped; allow explicit cancellation/restart |
| Copying | New labeled storage set allocated; bounded transfer journal | Resume proven chunks or discard incomplete candidate and recopy |
| Verified | Complete source/candidate comparison recorded | Revalidate source stability and candidate identity |
| Candidate prepared | Generation-specific container created from pinned image | Inspect/adopt exact candidate; no duplicate create |
| Candidate healthy | Current-boot readiness and setup checked without user dispatch | Reconcile candidate or return to original before commit |
| Committed | Active runtime/storage pointers updated together with revision | Candidate is authoritative; never revert pointers automatically |
| Retirement pending | Original kept stopped as recovery copy | Cleanup only under retention/deletion policy |
| Complete | Outcome persisted and fences released | Return same outcome to repeated request ID |

## Implementation tasks

### Preparation and stable source

- [ ] Calculate required copy roles and an estimate of bytes/inodes. Check
  actual daemon storage capacity where observable, reserve headroom and handle
  unknown capacity explicitly. Do not use backend-host free space as VM space.
- [ ] Refuse preservation if required provider state/layout is unsupported.
  Offer cancellation/export/discard separately; never silently downgrade.
- [ ] Fence prompts, terminals, background validation, review/build pipelines,
  file writes and timers that can mutate the source. A visible tab is not the
  list of writers. Persist the fence before draining.
- [ ] Resolve pending approval and ambiguous dispatch states through existing
  provider rules. Rebuild must not approve prompts or auto-retry uncertain turns.
- [ ] Stop the source before copying. Use Docker APIs/CLI that can read stopped
  container files; never restart the user's workload to export it.

### Copy and verification

- [ ] For legacy layers, stream selected directories into fresh candidate
  volumes using an owned helper. For volume-backed rebuilds, copy the source
  storage set into a candidate set. This deliberately pays copy cost so candidate
  setup cannot corrupt the only pre-rebuild copy.
- [ ] Use minimal helper containers with exact labels, no network, no host home
  mounts and no Docker socket. Mount source volumes read-only where applicable.
- [ ] Bound archive buffers, concurrent transfers, entry counts, metadata sizes
  and durations; stream large content instead of loading the archive into RAM.
  Store any resume manifest privately with its own size/count limits.
- [ ] Validate archive entries before extraction: reject path traversal and
  unsafe hardlinks, preserve symlinks as links without following them, and
  prevent writes through existing destination symlinks. Verify the chosen
  Docker copy behavior for source-root symlinks against the pinned daemon.
- [ ] Preserve file bytes, modes, supported ownership and link targets. Define
  policy for sockets/devices, sparse files, hardlinks and xattrs. Unsupported
  required metadata must fail with the source retained, not disappear silently.
- [ ] Compare source and destination with a streamed file/content manifest and
  counts; verify `.git` integrity, branch/HEAD and dirty/untracked/ignored state.
  Source quiescence is mandatory: hashes of a moving source are not proof.
- [ ] Check provider databases after a clean writer stop/checkpoint. Credentials
  imported from the host are refreshed separately, not copied as durable state.
- [ ] Keep hashes/path manifests out of telemetry. They may disclose private
  filenames or permit guessing sensitive small files.

### Candidate and commit

- [ ] Name the candidate using the new runtime generation; retain original
  names/IDs until retirement. Do not depend on successful old-container removal.
- [ ] Validate and apply requested ports/network/limits to the candidate. Source
  must be stopped before binding fixed host ports. A bind conflict preserves
  both the source and candidate data and returns a recoverable result.
- [ ] Prepare using the copied workspace, preserving its generation and
  original `createdFromCommit`. Re-run only the runtime/setup work required by
  step 04, and treat ambiguous repository side effects as needing explicit retry.
- [ ] Disable automatic user-agent dispatch and post-setup launch until commit.
  Health checks and state validation must not start a new paid/side-effecting turn.
- [ ] Promote runtime and storage pointers in one revision-checked storage
  mutation. Record original resources as retained recovery data in that same
  mutation; invalidate old connection/terminal generations and publish snapshot.
- [ ] Release fences and reconcile agent sessions only after promotion. Cancel
  queued work targeting the old generation or explicitly rebind safe intents;
  do not silently send a request prepared for a different workspace generation.

## Cancellation and rollback

Before commit, cancellation removes only the incomplete candidate and may
restart the original after identity/readiness validation. If candidate setup
may have caused external side effects, tell the user; restoring files does not
undo those effects. Failed candidate cleanup becomes a retained operation
resource, not an orphan eligible for unrelated maintenance.

After commit, the candidate can contain new work. Prefer forward repair; an
explicit restore must stop writers, preserve current data and disclose which
snapshot it restores. Never automatically flip back to the original after a
health failure and lose new changes. Retirement of the old copy is separately
visible and never runs merely because the UI unmounted.

## Verification and exit criteria

- [ ] Real Docker matrix includes tracked/untracked/ignored/binary files,
  executable bits, symlinks, large files, Git LFS/submodules if configured,
  unpushed commits and provider state with active WAL files before drainage.
- [ ] Kill backend/helper at every phase in the table, including immediately
  before/after pointer promotion. Each restart has exactly one authoritative
  workspace and no automatically repeated agent turn.
- [ ] Inject ENOSPC, inode exhaustion, corrupt archive, malformed link, daemon
  disconnect, occupied name, port conflict, incompatible image and failed setup.
- [ ] Cancel during copy and during candidate validation; original remains
  restartable and accurate progress rehydrates after switching environments.
- [ ] Modify the candidate after commit, then fail health. Recovery must retain
  those writes and never silently restore the older snapshot.

Ship migration as an explicit operation first, then enable it as the preserve
implementation for rebuild. Exit when failure injection demonstrates retained
data and the UI describes precisely which paths and session formats survive.
