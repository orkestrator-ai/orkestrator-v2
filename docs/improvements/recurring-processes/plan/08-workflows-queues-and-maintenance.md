# 08 — Schedule workflow and queue work by key and deadline

Status: Not started. Dependencies: 02, 07; step 11 before slower reconciliation.
Finding: F06.

## Outcome

Completed/inactive records stop dominating frequent supervisor scans. New work,
provider transitions and result commits wake only relevant owners. Durable
records still recover every pending obligation after a crash or missed wakeup.

## Existing sources

- `build-pipeline-service-base.ts`, `build-pipeline-service-supervisor.ts` and
  related recovery/fan-out modules.
- `looped-review-service.ts`, `multi-review-service.ts`, `feature-planning.ts`.
- `native-agent-service-reconciliation.ts`, `native-agent-service-prompt.ts`,
  `prompt-queue-drainer.ts`, `storage-native.ts` and workflow storage modules.
- `agent-mail-service.ts`, `coordinator-service.ts`, `index.ts` and lifecycle
  command handlers.

## Implementation tasks

1. Define the set of runnable or recoverable obligations for each domain. Do not
   equate runnable with a phase named `running`: include cancelling, recovering,
   terminal usage/result settlement, pending result consumptions, interactive
   Fix completion, durable address handoff, parked dispatch reconciliation,
   launch retry, interrupted teardown and pending rename.
2. Introduce a rebuildable index of active/pending keys and due times, maintained
   only after successful durable mutations. Prefer existing storage revision
   metadata and active-list APIs. Keep indexes bounded; page large startup
   discovery rather than materializing every historical transcript/package.
3. On startup, load authoritative records, validate them and rebuild scheduling.
   Retain existing migration/adoption and terminal-reconciliation behavior.
   A failed record must not block unrelated recovery, but a failed enumeration
   must not be mistaken for proof that all work completed.
4. Add scoped wakeups for start/resume/retry/cancel, queue enqueue, provider
   transition, accepted workflow result, environment readiness and changed
   execution identity. Subscribe before capturing the initial scan and reconcile
   changes that race startup. Prevent write/observe feedback loops through
   revision checks and idempotent domain operations.
5. Migrate feature planning first because it already lists active records; then
   build pipeline, looped review and multi review in separate review units.
   Each retains its locking, lease fencing, result validation, dispatch journal
   and structured-output deadlines. Keep existing fallback cadence initially.
6. Apply bounded workflow admission across different keys. A single slow provider
   must not hold a service-wide tick open and delay unrelated due work. Preserve
   per-workflow serial progression and ensure nested reviewer fan-out has its
   own budget without recursively exhausting the same admission pool.
7. Convert poll-count deadlines into explicit elapsed deadlines where cadence
   changes would alter semantics. Examples include missing-result grace and
   bounded final-usage probes. Preserve intentional attempt limits separately
   from time limits; changing a one-second tick must not silently turn a
   five-poll grace into minutes or shorten it to a burst of immediate wakeups.
8. Keep 5-second renewal of 15-second review leases on a separate critical path.
   Renew only held leases and release after terminal work settles. A scheduler
   delay or lost lease fences further mutations; it never permits a second owner
   to act on stale authority. Avoid unnecessary snapshot rewrites during renewal
   where the storage contract already separates ownership metadata.
9. Migrate native/tmux queues and launch/rename intent to due keys. Enqueue and
   turn-end wakeups already exist in places; fill missing coverage and preserve
   one queued dispatch per idempotency key. An ambiguous dispatch remains parked
   until explicit positive reconciliation, retry under the same key, or discard.
10. Separate the `index.ts` activity bundle into named due jobs: activity,
     tmux queue fallback, presence, mail injection, coordinator notification
     repair, mail retention and renames. Reuse observation snapshots from step
     07. Preserve each current overlap guard during migration.
11. Replace `% 30` tick-count maintenance with elapsed deadlines. Trial coarser
     retention only after measuring cost and defining acceptable retention lag.
     Keep tab teardown/orphan cleanup at its already-coarse minute cadence unless
     evidence calls for change; preserve its one-hour orphan grace.
12. Once wakeup/recovery tests pass, slow broad discovery to a measured 30–60 s
     safety interval while active jobs keep responsive due deadlines. Use
     content-free counters to prove historical record counts no longer multiply
     fast-tick deep validation. Retain a full diagnostic reconciliation route.

## Required tests

For each migrated service, compare transitions from the same persisted fixture
under old and new scheduling. Include many completed records and a few active
ones; pending terminal obligations; missed events; restart between durable commit
and wakeup; failed storage enumeration; corrupt record; cancellation during a
slow provider read; lease renewal under saturation; stolen/expired lease;
interactive Fix handoff; simultaneous queue enqueues; ambiguous prompt response;
and invalidation arriving while a job is running.

Prove a periodic tick alone cannot sustain an endless immediate-rerun chain,
while a real dirty event causes a fresh pass. Verify startup returns without
waiting for an indefinitely active scheduler. Test all work with no renderer,
then rehydrate on another client after completion.

## Acceptance and rollback

Fast work selection scales with due/active obligations, not retained historical
workflow bodies. Durable side effects happen once under existing fences and
leases. A missed wakeup converges within the documented safety interval. Rollback
returns one domain at a time to its old driver using the same records; disable
the new driver before enabling the old one. Rebuildable indexes can be discarded
without losing authoritative state.
