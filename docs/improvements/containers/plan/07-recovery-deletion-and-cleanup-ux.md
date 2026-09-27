# 07 — Recovery, deletion and cleanup UX

Status: Not started. Dependencies:
[02](02-lifecycle-authority-and-durable-operations.md),
[05](05-persistent-workspace-and-agent-state.md),
[06](06-migration-and-transactional-replacement.md).
Return to [index](00-index.md).

## Goal

Give every runtime, volume, network and retained recovery copy a visible owner
and an intentional deletion path. Separate operational repair from discarding
data. Cleanup must be resumable, accurately counted and safe under concurrent
environment activity.

## Integration points

- [Docker registry](../../../../apps/backend/src/core/commands-registry-docker.ts),
  [deletion lifecycle](../../../../apps/backend/src/core/commands-servers.ts),
  [storage projects](../../../../apps/backend/src/core/storage-projects.ts),
  [lifecycle recovery](../../../../apps/backend/src/core/environment-lifecycle-tasks.ts).
- [DockerStatsDialog](../../../../apps/web/src/components/docker/DockerStatsDialog.tsx),
  [EnvironmentSettingsDialog](../../../../apps/web/src/components/environments/EnvironmentSettingsDialog.tsx),
  [environment backend client](../../../../apps/web/src/lib/backend/projects-environments.ts),
  [Docker backend client](../../../../apps/web/src/lib/backend/docker-skills.ts).
- [PR cleanup integration](../../../../apps/backend/src/core/commands-registry-pr.ts)
  and existing environment deletion tests.

## Resource inventory and command semantics

| User action | Backend meaning |
| --- | --- |
| Stop | Drain runtime; retain all workspace/session storage |
| Rebuild runtime | Step 06 preservation transaction with new image/settings |
| Reset workspace | Explicit new workspace generation; retain prior set as a recoverable copy until separately discarded |
| Restore recovery copy | Preserve current state, then explicitly select a prior storage set; never an automatic response to health failure |
| Delete environment | Reviewed permanent deletion of the environment and its selected data resources |
| Clean up | Remove explicitly eligible abandoned helpers/runtimes; never infer that assigned data is disposable |

The backend returns inventory rows with resource identity, role, assignment,
operation reference, retention reason and known/unknown size. Display names are
descriptive only. Include retained legacy containers because their writable
layers may be the recovery copy.

## Implementation tasks

- [ ] Add a preview endpoint/command that calculates exact candidates and
  exclusions from persisted references plus Docker labels. Its response includes
  a revision and a bounded selection token or explicit resource set.
- [ ] Execute only that reviewed selection, then revalidate every identity and
  reference under step 02 locks. New candidates appearing afterward require a
  new preview; they are not silently added to the deletion request.
- [ ] Classify current, retained-recovery, operation-owned, orphaned, foreign,
  legacy-unadopted and unknown resources. Unknown is not synonymous with orphan.
- [ ] Reconcile label-associated resources from interrupted creation before
  offering cleanup. A missing `containerId` in one old environment snapshot is
  insufficient evidence that the labeled container is unassigned.
- [ ] Return per-resource removed/already-absent/skipped/conflict/failed outcomes.
  Show partial success honestly and retain failed work for retry.
- [ ] Extend deletion tombstones with resource references before deleting the
  environment's ordinary metadata. Do not remove the last reference to a volume
  while its deletion is still pending.
- [ ] Order permanent deletion: fence/drain, revoke environment tool access,
  stop/remove owned runtimes/helpers, remove explicitly selected data volumes,
  remove unused owned networks, then finalize durable record cleanup. Follow
  existing session/queue deletion guards throughout.
- [ ] Recheck volume references and actual mounts immediately before removal.
  Never force-detach a volume from another active operation just to complete
  cleanup. A missing volume counts as already absent, not a fresh successful
  reclamation measurement.
- [ ] Keep retained recovery copies indefinitely by default during initial
  rollout, with visible disk use. Introduce automatic expiry only as a separate
  explicit policy after restore behavior is qualified; age alone never deletes
  the only known copy.
- [ ] Bound retained-resource metadata and candidate enumeration. Start with a
  proposed 16 retained storage sets per environment and a paginated inventory;
  reaching the cap blocks another rebuild until the user reviews retention.
  Never silently evict the oldest copy or lose its durable reference to fit a
  metadata limit. Enforce a separate disk-capacity admission check in step 06.
- [ ] Define reattachment as an adoption operation that verifies owner, project,
  storage format and existing assignment. Refuse double attachment to two live
  environments. Preserve session linkage instead of inventing a blank mapping.
- [ ] Integrate merge-triggered cleanup with the same deletion contract and
  already configured user intent. A merged branch does not prove ignored files
  or session state have been backed up.

## UI requirements

- [ ] Replace generic restart/recreate labels with the operations above.
  Summaries say what files/state survive and which processes will stop.
- [ ] Show backend progress/recovery actions after tab switch, window reload and
  reconnect. Keep destructive confirmations bound to the reviewed revision.
- [ ] Expose actionable failures: free disk, retry daemon connection, resolve
  active references, resume migration, retain original or explicitly discard.
- [ ] Preserve keyboard focus, accessible dialog descriptions and disabled
  states. Do not let closing a dialog cancel admitted backend work.
- [ ] Remove success toasts that run after a partial/unknown operation result.
  A completion event and a successful final snapshot must agree.

## Verification, rollback and exit criteria

- [ ] Race preview with start, reattachment, migration commit, credential refresh
  and deletion. No newly assigned resource may be removed.
- [ ] Restart backend after every deletion substep; tombstones retain enough
  information to finish without recreating state or losing failed resource IDs.
- [ ] Seed two profile owners and unlabeled legacy resources. Only reviewed,
  owned resources may be changed, including direct command calls.
- [ ] Restore an older copy after the current candidate has new files; current
  files must remain in a retained copy and the UI must explain the selection.
- [ ] Real browser cycle covers switching away during copy/deletion, disconnect,
  partial removal failure and returning to correct controls/progress.

Rollback can hide new cleanup actions but must continue reading recovery and
deletion records. Never fall back to owner-wide prune. Exit when every deletion
has a reviewable inventory, a durable owner and an accurate terminal outcome.
