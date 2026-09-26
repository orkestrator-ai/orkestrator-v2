# 12 — Qualify improvements and roll out in stages

Status: Qualified on Linux (2026-09-26), with the gaps listed below. The
deterministic matrix, the full repository suite, the component, Electron and
isolated real-stack browser and Docker suites, and a live isolated-profile
idle A/B all ran. Merge is left to a human-reviewed PR. Dependencies: all
adopted implementation steps.

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

## Completion notes

Qualified on branch `implement-recurring-processes-aaceef7ccc03-r1`, Linux x64,
Bun 1.4.2, Docker 29.7.2, on a host shared with other sessions' test runs. All
eleven implementation steps are merged; each step's own notes list its
commits, tests and deferrals.

### 1. Deterministic matrix (step 01 harness, re-run)

`mise exec -- bun apps/backend/scripts/recurring-baseline.ts --out
docs/improvements/recurring-processes/baseline/step-12-final.json --compare
docs/improvements/recurring-processes/baseline/step-01-baseline.json`: same
fixtures, platform and runtime as the step 01 baseline; 532 counters differ.
The per-scenario before/after table is in the baseline README ("Step 12 —
final comparison"). The runs are deterministic (a re-run reproduces every
counter), so there is no run-to-run noise to separate. Headlines, per minute
of warm idle:

- One open Files panel on a quiet watched local worktree: git spawns
  60.2 → 2.6, directory reads 480 → 0, tree walks 12 → 0. That is the same cost
  as no client at all, and a second client adds nothing (F01).
- 50 mixed environments with two clients: git spawns 201.7 → 64.2, gh spawns
  56 → 33.6, directory reads 960 → 0.
- Container fetch attempts: −95 % (background polling) to −98 % (Files panel
  open); see step 04 (F02).
- Terminal PR entries: 30 → 2 detections per 10 minutes each; open-PR cadence
  unchanged (F03).
- Driven native observation: provider reads 420 → 272.2 per minute;
  tab-facing status reads 1,200 → 0 per 10 minutes (F05/F06).
- Driven workflow supervision at 200 completed records per store: records
  scanned −95 % (build) and −96.5 % (looped review), with provider reads
  unchanged (F06).

Counts, not durations: the harness resolves physical operations instantly.

### 2. Live isolated profile (idle A/B)

`/tmp/rp-live/run-live.sh` (a thin wrapper, not committed) started
`mise run dev:test --profile <p> --fixture --fixture-environments
local,container --no-agent-credentials`. It waited for `dev:status` `ready`,
settled 60 s, then read `recurringWork` from `/__orkestrator/metrics` at the
start and end of a 5-minute window with no client. It then stopped and reset
the profile (`dev:stop`, `dev:reset --stop-first`). The candidate ran with
defaults. The rollback run set `ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK=all
ORKESTRATOR_NATIVE_OBSERVATION_SHARING=0`, after `3b80c507` let those switches
through the agent-test environment allowlist; without it the switches never
reached the backend. Starts per minute:

| Job | Rollback (previous drivers) | Candidate |
| --- | --- | --- |
| Feature planning tick | 60 | 2 |
| Looped review tick | 60 | 2 |
| Build pipeline tick | 40 | 2 |
| Multi review tick | 4 | 2 |
| Native launch scan | 30 | 2 |
| Native queue scan | 30 | 2 |
| Pending rename reconcile | 30 | 2 |
| Native activity sweep, mail presence/injection, Claude state, tmux drain | 30 each | 30 each |
| Claude terminal-state poll (1 container) | 60 (60 `docker exec`) | 60 (60 `docker exec`) |
| Diff scans (1 local watched + 1 container) | 4.6 | 4.6 |
| Container git fetch | 0 | 0 |

The live fixture has no workflow records, so the saved ticks are wakeups and
enumerations rather than storage reads here; section 1 covers the storage side
with retained history. Storage stats from launch and rename scans fell from
30 to 2 per minute each. The fixture's single container never reached the
5-minute fetch cooldown inside the window in either run. Before step 04 each
container status scan attempted a fetch, which cannot be switched back at run
time, so the deterministic step 04 artifact is the before/after for fetches.
A second candidate run reproduced every per-minute count exactly. All
profiles were removed: no profile directory or owned container remained.

During the real-stack suites (below), the candidate's counters moved with the
work, not with the clock. Environment creation, deletion and edits woke the
launch, rename and diff jobs (event-driven), and the idle-only jobs stayed on
their 30 s safety cadence.

### 3. Suites

| Command | Result |
| --- | --- |
| `mise run test:logged -- --name all-merged-check3 -- mise run check` | Pass |
| `mise run test` | Root, bridges and protocol lockfile groups pass. The workspace group failed only on open flaky case 0156 (`DesignCanvasTab` shortcut; passes alone 3/3; recurrence recorded). Turbo stopped the backend package early after that failure, so it ran separately below. |
| `mise run test:logged -- --name backend-package -- bun run --cwd apps/backend test:workspace` | 4,214 pass, 1 fail. The failure was the new step 08 harness test hitting Bun's 5 s default under load; fixed with an explicit budget in `15b7ba16` and passing. |
| `mise run test:logged -- --name browser-components -- mise run test:browser` | 94 passed, 47 skipped, 1 failed: `GlobalStyles.spec.ts:56` crashed the page under host load and passes alone 2/2 (new flaky case 0164). |
| `mise run test:logged -- --name agent-electron -- mise run test:agent:electron` | Pass |
| `test:agent:browser` against the candidate profile | 4 passed: real gateway local environment; agent mail rehydration after an inactive recipient and reload; review validation running while its environment is inactive; design rehydration from another client. 3 skipped: two Docker tests (run next) and the opt-in live Multi Review test. |
| `test:agent:docker` against the candidate profile | 2 passed |

Earlier focused and `test:changed` runs by each step are in its own notes.
Failures during the full-suite runs led to fixes: a stale rename-command
expectation and three DOM-absence assertions (`29589a23`), the harness lint
and type errors (`debbeed4`), and the harness budget (`15b7ba16`).

### 4. Required scenarios

| Scenario | Evidence | Gap |
| --- | --- | --- |
| Turn in A, switch to B, complete, return, reload | Unit/component: native session visibility and observation tests (06/07); real stack: agent mail and validation inactive-environment specs | No live agent turn (credential-free profile) |
| Pending approval while initiating view unmounted | 07 stale-idle and interaction freshness tests; 11 bounded hydration; approvals unchanged by design | No live provider |
| No renderers connected | 08 zero-renderer supervisor/queue tests; live idle windows ran with no client | — |
| Two clients, one hidden or data-saving | 06 coordinator two-subscriber and hidden tests; 03 harness `c2` scenarios; real-stack design two-client spec | Data-saving preference deferred (step 06) |
| Edit with unchanged aggregate counts | 03 same-count/different-path test | — |
| External ref change in linked worktree | 03 real-Git linked-worktree/shared-ref tests | — |
| Container recreation / offline remote | 04 real-Git re-clone identity and offline tests; script-level Docker run | — |
| Merged/closed PR later replaced or reopened | 05 lifecycle tests | No live GitHub |
| Missed final event / expired cursor / overflow | 11 fault matrix; 09 coordinator safety-check test | — |
| Provider unavailable / slow Git / many due jobs | 02 saturation tests; 03 admission; 05 fairness; 08 slow-key isolation | — |
| Restart between durable commit and event | 08 restart tests; 05 repair after restart | — |
| Review lease renewal under load | 08 critical-pool renewal and stolen-lease tests | — |
| Sleep/wake and clock discontinuity | 02 scheduler + `HostSuspendDetector` tests (`649a7816`) | Not exercised with a real suspend |
| Stop/delete target during slow read | 03, 05 and 08 fencing tests | — |
| Server/credential/connection switch | 06 server-switch test; 09 connection switcher fencing | — |
| Exact terminal recovery under backpressure | Unchanged transport; existing suites pass | Not re-qualified specifically |
| Explicit bridge shutdown without process exit | 10 Cursor/Pi lifecycle tests | — |

### 5. Acceptance gates

- One physical operation for equivalent concurrent reads and explicit
  aggregate bounds: met (steps 02, 03, 05, 08 tests).
- Quiet watched worktrees, container fetch policy, terminal PR cadence: met in
  the deterministic matrix. Terminal PR cadence and container fetches were not
  observed live (no GitHub credentials; fetch cooldown longer than the window).
- Hidden client reads stop and resume; backend work does not depend on a view:
  met in unit, component and real-stack inactive-environment specs.
- Historical workflow records no longer drive fast-tick enumeration: met
  (driven harness and live A/B).
- Dominant measured categories improve: git spawns, directory walks, workflow
  enumeration, native scans and container fetches all fell. Claude
  terminal-state polling (B18) dominates remaining container idle cost and was
  deliberately left unchanged. It is the obvious next measured candidate.
- No invariant regression was observed in the suites. A second candidate
  profile run (idle window plus both agent suites) was scanned before reset:
  zero `Unhandled promise rejection (continuing)` guard lines across its six
  log files. Those files include `electron.log`, which carries the backend's
  `[Backend]` stderr (55 such lines in a separate short check run).

### 6. Rollout, rollback and platform coverage

Policy switches, each read once at startup and each removable once its domain
has soaked:

- `ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK` (per domain, step 08).
- `ORKESTRATOR_NATIVE_OBSERVATION_SHARING=0` (step 07).
- `ORKESTRATOR_RECURRING_METRICS=0` (step 01).
- Constants for PR terminal cadence (step 05) and container read freshness
  (step 04).

Protocol changes are additive, and older peers keep conservative polling.
Coverage and gaps:

- Linux only. macOS and iOS qualification were not run on this host, and no
  live providers or GitHub were used.
- No soak of repeated add/remove/stop/restart cycles beyond the suites and two
  profile lifecycles.
- Latency budgets were checked by deterministic tests; live p50/p95 freshness
  was not measured.

Compression and data-saving plans remain separate work
([data-saving](../../../todo/remote-client-data-saving-mode.md),
[compression](../../../todo/remote-stream-compression.md)).
