# Recurring-process improvements: implementation plan

Status: Proposed. No implementation steps have been executed.

Prepared 2026-09-21 against `88c2f9ccfaa68045573b658dd4f172bc5ff7c51b`.
Evidence and inventory: [investigation](../../../imrovements/recurring-processes.md).

## Intended outcome

Reduce redundant Git/Docker/network/storage work and hidden-client requests while
preserving background progress, prompt delivery, approvals, and exact recovery.
Implement incrementally in reviewable changes; keep each domain's existing state
machine and durable ownership. This plan authorizes no implementation by itself.

## Steps and dependencies

| Step | Deliverable | Dependencies | Findings |
| --- | --- | --- | --- |
| [01](01-baseline-and-measurement.md) | Reproducible workload and content-free cost/freshness baseline | None | F10, all inventory |
| [02](02-scheduling-and-admission.md) | Small bounded scheduling/admission primitive | 01 | F04, F06 |
| [03](03-shared-worktree-snapshots.md) | Shared file/diff/tree reads with independent revisions | 01, 02; 11 before reducing fallback | F01, F07 |
| [04](04-container-git-fetch-policy.md) | Separate container fetch policy from status scans | 01, 03 | F02 |
| [05](05-pr-monitoring-policy.md) | Lifecycle-aware PR polling and aggregate budgets | 01, 02 | F03, F04 |
| [06](06-client-read-coordination.md) | Shared renderer reads and visibility policy | 01; 11 before slowing recovery | F05 |
| [07](07-agent-observation-and-activity.md) | Shared activity observations and due groups | 01, 02, 06; 11 before event reliance | F05, F06 |
| [08](08-workflows-queues-and-maintenance.md) | Keyed workflow/queue wakeups and indexed pending work | 02, 07; 11 before slower safety scans | F06 |
| [09](09-secondary-client-processes.md) | Consolidated metrics, coordinator, logs and auxiliary reads | 03, 06; 11 for new events | F05, F08 |
| [10](10-bridge-and-transport-lifecycle.md) | Timer disposal, reconnect policy and targeted lifecycle fixes | 01, 02 | F09, L01–L14 |
| [11](11-recovery-and-resource-bounds.md) | Bounded snapshot/event convergence contracts | 01; coordinate schemas with 03/06/07 | F07 |
| [12](12-qualification-and-rollout.md) | Cross-client/background/performance evidence and rollout | All adopted steps | All findings |

Step numbers provide a reading and tracking order, not permission to defer
recovery correctness until the end. Implement step 11's relevant contract before
enabling any polling reduction that depends on it. Step 11 can start immediately
after the baseline; no dependency cycle requires all migrations to finish first.

Suggested review units: instrument baseline; add primitive without migration;
shared file reads; file event/recovery contract; container fetch; PR limits and
policy; client coordinator preserving cadence; each client migration; activity
broker; each workflow migration; maintenance; lifecycle; qualification. Avoid
one PR changing every timer.

## Architecture decisions

1. Backend/bridge/external process remains authoritative. Browser demand affects
   presentation reads and optional sampling, never execution or durable delivery.
2. Separate a scheduler's mechanics from domain decisions. The scheduler knows
   keys, deadlines, priority and capacity. PR lifecycle, workflow phases,
   approvals and dispatch journals stay in domain services.
3. Rebuild active indexes and due jobs from durable state at startup. Start with
   in-memory scheduling; do not add a second durable job database.
4. Use events for prompt reaction and authoritative snapshots for reconciliation.
   Reducing a safety interval requires explicit missed-event recovery evidence.
5. Keep read observation separate from attach, hydrate, dispatch, and touch.
   Background observers must not keep idle threads resident or start bridges.
6. Prefer joining equivalent reads over caching arbitrary results longer. Keys
   must include connection/generation, target, identity, options and revision as
   appropriate. Credential-sensitive scopes cannot share results accidentally.
7. Retain compatibility with a supported older backend/bridge through capability
   negotiation and conservative fallback. Do not infer unsupported from arbitrary
   network/auth errors.

## Trial policy, subject to baseline approval

These are initial experiment values, not current shipped behavior. The baseline
step records whether each is appropriate; reject a value if it worsens required
latency or correctness.

| Work | Initial trial |
| --- | --- |
| PR ordinary open / pending | Preserve 20 s / 5 s / 1 s cadence initially; bounded admission |
| Terminal PR discovery after successful repair | 5 min plus immediate explicit and completion-edge wakeups |
| Git/Docker status scans | Start with 4 total scans and 1 per target; tune by measured host cost |
| GitHub detection | Start with 2 concurrent detections; add bounded fair waiting and shared cooldown by safe auth/host scope |
| Container fetch freshness | 5 min between attempts; immutable locally present base does not fetch |
| Client foreground polling | Preserve existing cadence during coordinator migration |
| Client quiet native views | Later trial 3/5/10/15 s backoff, only after interaction/completion event coverage passes |
| Active workflow progress | Preserve current 1–1.5 s fallback until scoped notifications are qualified |
| Idle discovery/maintenance | Trial 30–60 s for pending-work discovery, longer for retention where acceptable |
| Leases, approval deadlines, authentication expiry | Preserve existing semantics and timing |

Use monotonic elapsed time for in-process deadlines; durable expiry timestamps
retain wall-clock semantics. After sleep/resume, reconcile overdue jobs once;
never replay every missed tick. Critical deadlines may bypass normal admission
but must remain bounded and observable.

## Common implementation and verification rules

Each step must finish with its owning unit/integration coverage, recorded call
counts/freshness, compatibility behavior, cleanup proof, and a scoped rollback.
Use injected clock/timer/random dependencies for scheduling tests and deferred
promises for race tests. Avoid long real sleeps and source-text tests that merely
assert an interval constant. Follow the repository's Bun isolation instructions
when implementing tests.

Follow [testing guide](../../../development/testing-guide.md) and
[isolated agent testing](../../../development/agent-testing.md). Use focused
explicit test paths through `mise run test:logged`, then changed-code checks,
relevant browser/Docker/Electron suites, static checks and the full repository
suite as required there. Never use bare root-level `bun test` or production
application data for qualification. Read relevant skills and current Context7
documentation at implementation time when introducing library-specific code.

For every background feature, start work in environment A, switch to B, let A
progress, return, verify transcript/status/pending prompts/controls, reload, and
verify again. Repeat with two clients and one disconnected. Include backend and
bridge restart at durable transition boundaries. These tests are prerequisites
for claiming an efficiency improvement safe.

## Completion tracking

All steps begin **not started**. On implementation, update each step with commit
or PR, measured before/after, checks and untested constraints. Do not mark a step
done because a primitive exists if its migration or qualification remains open.
Steps 09/10 contain optional optimizations: record a measured deferral instead of
expanding scope without benefit. Update the living documentation catalog when
this proposal becomes an accepted active project.

## Relationship to existing plans

Build on [client data-saving mode](../../../todo/remote-client-data-saving-mode.md)
and [stream efficiency](../../../../plans/stream-efficience.md). Coordinate
measurement with [compression evaluation](../../../todo/remote-stream-compression.md),
but keep codec/default changes out of this project. This work changes how often
facts are collected and read; existing payload bounds and incremental transports
remain the baseline.
