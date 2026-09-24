# 05 — Add backend-owned save/apply operations and reconciliation

Status: planned. Depends on: 02–04. [Plan index](00-index.md).

## Integration points

Create `McpManagementService` using `CommandContext` and `StorageService` patterns.
Register commands through `createCommandRegistry()` and a focused registry module.
Suggested commands are `list_mcp_management_targets`, `get_mcp_management_snapshot`,
`get_mcp_definition`, `validate_mcp_mutation`, `mutate_mcp_definition`,
`apply_mcp_configuration`, and `get_mcp_operation`. Names are proposals.

Add typed web wrappers under the existing `apps/web/src/lib/backend/` convention.
Use the authenticated backend command/gateway transport; do not give the renderer
direct write access to bridges or provider files. New management commands are
administrative UI operations, not automatically new tools on Control MCP.

## Operation lifecycle

1. Validate a mutation and construct an impact preview: backing source, saved
   scope, affected providers/environments, active sessions, trust exclusions,
   inherited fallback and expected apply strategy. A preview starts no process.
2. On submission, bind the request id to a canonical mutation fingerprint and
   target. Repeated identical requests return the same result; the same id with a
   different mutation is a conflict. Store fingerprints privately without
   exposing hashes of low-entropy secret values.
3. Persist a prepared operation record, invoke the source transaction, and record
   its resulting revision. Store redacted metadata only in the public operation
   record; any private recovery payload must have its own bounded, restricted
   storage and short retention.
4. If save-only, complete with application `not-requested`. Future provider loads
   still naturally read the updated native file; state that consequence in UI.
5. If apply requested, enumerate the affected **currently known** runtimes from
   backend registries. Record revision, session/directory identity and generation.
   Do not create a conversation to manufacture a runtime to apply to.
6. Schedule provider-specific apply work at a safe boundary. A shared-process
   operation waits for every affected busy session. Running, cancelling,
   recovering, pending dispatch and outstanding interaction states can all block
   destructive reload; idle-looking UI text is not sufficient.
7. Mark applied only on adapter evidence. Acknowledged scheduling becomes pending
   next-turn/reload, not success. Preserve per-session outcomes when one succeeds
   and another fails. Failed connection health is distinct from failed apply.
8. Publish only revision/operation invalidations. UI subscribers reload snapshots;
   authoritative state remains available after a missed event or navigation.

## Durable model and bounds

Persist operation id, request id, provider/target/source, expected/saved revision,
phase, timestamps, bounded error code, impact scope and per-runtime progress.
Applied revision belongs to a specific runtime generation; a restarted generation
must reload configuration or prove its revision again.

Initial budgets: one active apply per target, two concurrent provider apply jobs
per backend, 32 queued targets, 128 retained operation records per backend and a
seven-day expiry for terminal records. Bound per-operation runtime entries; when
fan-out exceeds the page limit, persist/paginate batches rather than truncate.
Bound total stored operation bytes (proposed 4 MiB) and response bytes separately.
Reject excess work with a retryable busy response; never drop authoritative jobs.

Use a provider-specific bounded call timeout, starting with the existing attach
budget for cold runtime work. Timeout yields failure/reconciling, never inferred
success. Backoff/retry only known-idempotent config reconciliation, with finite
attempts. Do not reuse prompt dispatch retries, and never issue a user turn as a
configuration test.

## Crash, disconnect and supersession

On backend restart, inspect prepared/saved/in-flight records against source
revision and current runtime generation. A source write that completed before
the crash must be recognized without applying the mutation twice. An uncertain
runtime change is reconciled by snapshot/next-attach evidence, not a blind retry
of a destructive restart.

If a newer revision supersedes a queued one, coalesce **apply** work to the latest
saved effective revision while retaining the outcome of both saves. A mutation
is never silently discarded. Reject/mark conflicts where a source changed
externally after scheduling; do not re-materialize an obsolete revision.

Canceling a queued apply leaves saved config intact. Once provider application is
in flight, cancellation is best effort and must not report a rollback. Closing
the settings dialog is not cancellation. Deleting an environment explicitly
retires its jobs and exact owned overlay data using normal lifecycle cleanup.

## Policy and protected connections

Maintain an internal ownership registry for injected servers and provider-managed
origins. Validate it in both management persistence and runtime assembly.
Always recompute protected per-tab/per-attempt connections from trusted backend
state immediately before applying; never use a stale bearer from a saved draft.

Honor execution policy on every create, attach, resume and apply. Editing a user
file must not inject those servers into a coordinator whose provider home excludes
them. Saving an untrusted project definition is distinct from granting project
execution. All approvals/elicitation remain in the existing fail-closed flow.

Do not await reconciliation in stdout readers, SDK event callbacks or SSE writers.
Consume provider notifications promptly and schedule bounded work off-loop.
Every detached promise owns a rejection handler. No polling of tab-facing
`/session/:id` or `/status` routes for management progress.

## Acceptance scenarios

- [ ] Duplicate requests and lost mutation responses cannot double-add or
  accidentally repeat a rename.
- [ ] A successful save followed by failed apply is visible and retryable without
  another write or prompt dispatch.
- [ ] Busy sessions finish uninterrupted; queued application runs while their UI
  is unmounted and rehydrates correctly on return.
- [ ] Backend/bridge crash at every phase recovers a truthful state.
- [ ] Shared user edits invalidate every affected catalog, including compatibility
  consumers, without spawning every dormant provider.
- [ ] Protected connections and pending approval/interaction ownership survive.
- [ ] Bounded queues reject overload explicitly, and all asynchronous failures
  remain local to the configuration operation.

Exit: implement adapter steps 06–11 using this shared lifecycle.
