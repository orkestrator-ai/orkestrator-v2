# 12 — Qualify improvements and roll out in stages

Status: Not started. Dependencies: all adopted implementation steps.

## Outcome

Demonstrate lower recurring cost under representative workloads and unchanged
background correctness, with explicit freshness tradeoffs and rollback evidence.
No step is complete solely because the number of timers decreased.

## Verification sequence

1. Re-run the exact step 01 fixture matrix on the same platform/runtime with
   baseline and candidate builds. Keep startup, warm idle, active work and outage
   recovery separate. Record sample duration, variability and enabled policies.
2. Compare actual physical work: Git/gh/Docker spawns, tree walks, provider reads,
   transcript serialization, bytes and storage writes. Also compare CPU/RSS,
   queue delay, cache hit/unchanged ratio and retained keys/buffers. Count schedules
   and commands separately so caching does not obscure the cause of improvement.
3. For each migrated domain, prove deadline/freshness against the agreed budget.
   Report p50/p95 and worst observed recovery for edits, PR state, approvals,
   completion, queued prompts, mail and workflow progression. Document slower
   terminal discovery as an intentional policy, not an invisible regression.
4. Run focused owning tests while iterating, then `mise run test:changed`, static
   checks and repository suite according to the testing guide. Use logged runner
   wrappers. Add real isolated browser, Electron or Docker suites for the actual
   changed boundaries; a unit call-count test is not proof of real transport
   behavior. Include iOS qualification on a supported Mac if wrapper/resume
   behavior changed; record any platform unavailable during implementation.
5. Run the background/transport matrix below with fixture projects. Verify state
   through authoritative APIs as well as the screen, so an optimistic renderer
   cannot hide a backend regression.
6. Soak a large synthetic workload through repeated add/remove/stop/restart cycles.
   Confirm timer/subscriber/cache counts return to baseline, no pending queues
   grow without bound and no recurrent fatal-rejection-guard log is accepted as
   normal. Avoid live agent/GitHub load at artificial scale.

## Required scenarios

| Scenario | Expected result |
| --- | --- |
| Start turn in A, switch to B, complete A, return and reload | Correct transcript, final activity, usage, prompts and controls |
| Pending approval while initiating view unmounted | Approval recovered from snapshot; timeout/disconnect never approves |
| No renderers connected | Workflow, PR effects, prompt queue and mail continue |
| Two clients, one hidden or data-saving | Independent presentation demand; one shared backend computation |
| File edit with unchanged aggregate counts | Correct file paths/status and independent revision |
| External Git ref change in linked worktree | Baseline invalidated or safety reconciliation catches it |
| Container recreation / offline remote | No cross-generation cache; local data and remote freshness truthful |
| Merged/closed PR later replaced or reopened | Quiet discovery or explicit wake finds it; effects are idempotent |
| Missed final event / expired cursor / buffer overflow | Explicit authoritative reconciliation, bounded memory |
| Provider unavailable / slow Git / many simultaneous due jobs | Bounded work and fair recovery; critical controls remain responsive |
| Restart between durable commit and event | Pending intent/index rebuilt; no duplicate prompt or lost result |
| Review lease renewal under load | Lease retained or work fenced safely; never two active owners |
| Sleep/wake and clock discontinuity | One reconciliation of overdue work; no catch-up storm |
| Stop/delete target during slow read | Late result cannot restore stale state or rearm work |
| Server/credential/connection switch | No old result/token/subscription reaches new context |
| Exact terminal recovery under backpressure | Desync signaled and snapshot correct; background process survives |
| Explicit bridge shutdown without process exit | Timers/listeners/jobs released; no orphan detach/watch callbacks |

## Acceptance gates

- Deterministic tests establish one physical operation for equivalent concurrent
  reads and explicit aggregate bounds for migrated services.
- Quiet watched worktrees avoid foreground repeated scans; container fetches
  follow independent freshness policy; terminal PR discovery follows its new
  cadence after durable repair.
- Hidden optional client reads stop and resume safely; inactive backend work
  never depends on a mounted view.
- Historical workflow records no longer drive frequent deep validation after
  index migration; active transitions preserve original fences and deadlines.
- At least the measured dominant cost categories improve beyond run-to-run
  noise. If a migration adds complexity without measurable benefit, revert or
  defer it. No fixed savings percentage is claimed in advance.
- No approval, dispatch, replay, retention or cleanup invariant regresses.
  Recurrent guard-caught unhandled rejections count as a failure.

## Rollout design

Use existing internal configuration/capability conventions where available.
Avoid a permanent flag for every timer. Temporary policy switches should be
scoped by service/client and have an owner and removal condition. Install
additive protocols and diagnostics first, then shared reads with old cadence,
then per-domain cadence experiments, then broad default adoption.

Shadow comparison may compare pure scheduling decisions or cached read results;
never run duplicate gh/Git/provider reads at production scale solely for shadow
traffic, and never shadow a workflow mutation or prompt dispatch. Measurements
must not worsen the recurring load they are intended to reduce.

Roll back one policy at a time. Preserve authoritative state, request IDs,
generation fencing and new durable obligations. Disable the new driver before
restoring the old driver; reconcile once after switching. An index or cache may
be discarded and rebuilt, but a dispatch journal or workflow result must survive.

## Final handoff

Update the findings/plan status and living documentation catalog with adopted
architecture and policy. Publish before/after tables, tested commit/runtime,
exact logged validation commands, aggregate pass/fail evidence, platform coverage,
remaining fallbacks and deliberately deferred work. Link existing compression
and data-saving plans rather than claiming their separate work complete.

Record the actual isolated profile and cleanup result. Stop/reset owned fixtures
using the repository lifecycle commands. Do not include credentials, prompts,
terminal output, file contents or user repository identifiers in performance
artifacts. Leave final merge through a human-reviewed PR as required by AGENTS.md.
