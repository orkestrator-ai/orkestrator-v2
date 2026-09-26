# 07 — Control environment creation and lifecycle

Status: Planned.
Depends on: [04](04-shared-actions-and-discovery.md),
[05](05-operation-receipts-and-idempotency.md), [06](06-project-commands.md).
Index: [CLI commands plan](00-cli-commands-index.md).

## Target behavior

Scripts can create, start, inspect, rename, fork, stop, recreate, and delete an
explicit environment. A start receipt distinguishes admission from setup
readiness. Work survives client disconnection, and cleanup has a queryable
result rather than disappearing with the resource record.

## Owners and starting points

- [Environment registry](../../../../apps/backend/src/core/commands-registry-environments.ts).
- [Lifecycle implementation](../../../../apps/backend/src/core/commands-environment.ts)
  and [task tracker](../../../../apps/backend/src/core/environment-lifecycle-tasks.ts).
- [Fork implementation](../../../../apps/backend/src/core/commands-environment-fork.ts).
- [Client environment projection](../../../../apps/backend/src/core/commands-terminal.ts).
- [Local-worktree tests](../../../../apps/backend/src/core/commands-local-worktree.test.ts)
  and [cleanup tests](../../../../apps/backend/src/core/commands-environment-cleanup.test.ts).

## Work

1. Implement the lifecycle verbs over existing backend actions. Use explicit
   project/type/name/base inputs for creation, canonical public IDs everywhere,
   and step-05 admission before mutation. Creation alone records an environment;
   combined start/prompt belongs to step 09.
2. Preserve the existing `controlRequestId` convergence while adding payload
   conflict checking and retention through the operation receipt. Do not create
   one deduplication rule for MCP and a different one for the CLI.
3. For reproducible base selection, accept branch plus immutable full commit,
   resolve/validate in the backend, and persist what was actually used. Reject
   unavailable or incompatible revisions instead of silently using current HEAD.
   Preserve coordinator-specific stricter base validation; do not widen it.
4. Wrap background start with a receipt that records its admitted task, setup
   progression, result, and error. Reuse lifecycle admission/serialization and
   shutdown handling. Never hold ownership only in an HTTP handler's promise.
5. Implement bounded `--wait running|ready|stopped|deleted` where meaningful.
   Reuse the actual setup-ready predicate used by job launch, report overrides,
   and never invoke setup override to satisfy a wait. Persist errors before
   reporting terminal failure. Observe via cheap snapshots with one reusable
   wait helper for step 10.
6. Define same-target concurrency: repeated starts converge; conflicting
   start/stop/recreate/delete actions follow the existing lifecycle queue and
   report their own stage/result. A wait must not be satisfied by an unrelated
   earlier lifecycle transition. Deleting closes admission for new jobs/edits.
7. Publish rename results including resulting branch identity; never implement
   branch rename as a metadata-only storage patch. Fork returns the new
   environment ID and records actual copied/base state. Show destructive
   recreate/delete effects explicitly; preserve root-checkout protections.
8. Track deletion through process/bridge/session shutdown, owned container or
   worktree removal, metadata cleanup, and terminal receipt. A failed cleanup
   remains inspectable and retryable. Retrying deletion cannot delete a new
   resource that happens to reuse a name.
9. Reconcile backend restart using actual lifecycle/storage/external state.
   If startup was interrupted and requires a new start, report that truthfully;
   do not turn an abandoned promise into a successful operation.

## Verification

Run a credential-free local fixture through create → start → ready → rename →
fork → stop → delete with real Git. Add setup failure, absent local path,
invalid base, duplicate request payload, shutdown admission, start/delete races,
client disconnect, interrupted startup, and failed cleanup cases. Confirm child
process/worktree state as well as public summaries.

Run container cases with strict profile ownership and a foreign-owner decoy.
Retain real ownership checks even when a mock Docker boundary exercises a race.
Begin step 14's packaged local lifecycle scenario now.

## Acceptance and handoff

- [ ] Each lifecycle action returns/queryably retains its own receipt and resource IDs.
- [ ] Ready means setup-ready and setup failure never looks successful.
- [ ] Disconnect does not cancel accepted work or cleanup.
- [ ] Request conflicts, deletion races, and restart interruption are explicit.
- [ ] Local/container paths use existing ownership and lifecycle implementations.

Do not advertise untested container support for a new lifecycle behavior.
Withdrawing CLI verbs must leave backend recovery/cleanup of accepted actions
enabled and preserve operation history.
