# 05 — Make PR monitoring lifecycle-aware and bounded

Status: Implemented (unit/harness evidence; live-profile qualification
deferred to step 12 — see Completion notes). Dependencies: 01, 02. Findings:
F03, F04.

## Outcome

Keep fast confirmation after create/merge and ordinary open-PR freshness while
making retained terminal environments inexpensive. Spread startup work and limit
aggregate requests without losing task reconciliation or replacement discovery.

## Sources

`apps/backend/src/core/pr-monitor.ts`, `commands-pr-monitor.ts`,
`commands-registry-pr.ts`, `commands-servers.ts`,
`packages/protocol/src/pr-monitor.ts`, renderer monitor store/subscriber, and
`tests/unit/backend/pr-monitor-service.test.ts`. Existing terminal/replacement
and persistence-failure tests are essential behavior, not obsolete polling tests.

## Policy to implement

Keep user intent mode distinct from lifecycle observation policy. Model at least
open tracking, create pending, merge pending, terminal repair, terminal discovery,
paused and provisional one-shot discovery. This need not become a new public
enum for every internal state; expose only fields useful for freshness/UI.

Preserve open 20 s / create 5 s / merge 1 s initially. After terminal persistence
and required side effects settle, trial branch discovery every five minutes.
Immediate explicit refresh, a new pending intent, and agent-completion edges
reset the due time. A closed PR may reopen and a branch may acquire a new PR;
retained terminal entries still need a discovery mechanism.

## Implementation tasks

1. Enumerate every terminal obligation: environment persistence, linked task
   status/link/comment/metadata, merge-cleanup recovery and transition display.
   Identify which are already durable/idempotent and which are runtime-only.
   Before stopping fast repair, make remaining obligations reconstructible from
   storage; do not persist a boolean that claims all effects completed prematurely.
2. Separate failed detection from failed local side-effect repair. Where safe,
   retry a previously confirmed observation's idempotent local effects without
   another gh call. Revalidate identity/generation and reread durable state first
   so a newer PR or reopened state cannot receive an old terminal side effect.
3. Add a terminal discovery interval to internal scheduling policy, preserving
   public pending timeout behavior. Initial restoration should stagger ordinary
   and terminal checks. Explicit merge/create feedback must not inherit several
   minutes of background jitter.
4. Use bounded admission for detections, starting with two concurrent operations.
   Queue by environment with one pending check, fair ordering, and priority for
   user intent over quiet discovery. Cap starvation: a continuous stream of fast
   checks must not permanently hide another environment's PR state.
5. Define timeout/backoff and rate-limit handling at the existing gh boundary.
   Keep the current per-entry exponential backoff, add bounded jitter, and honor
   reliable retry timing when available. Share cooldown only across a proven
   compatible host/auth scope; absence of an observable credential identity is a
   reason to avoid unsafe deduplication, not to hash/log tokens.
6. Preserve separate check-rollup requests and their independent 60-second
   budget. A check permission failure must not suppress merge/close detection.
   Trial settled-check backoff later only if running/new checks can be detected
   promptly after a new head or explicit refresh.
7. Avoid switching to repository-wide API batching or webhooks in this step.
   Existing known-PR lookup and branch discovery already have distinct semantics.
   If baseline traffic warrants batching, design authentication, pagination,
   partial failure and replacement selection separately using current docs.
8. Fence late results after branch rename, environment stop/delete, target change,
   or concurrent explicit terminal reconciliation. Keep `lastSuccessfulCheckAt`
   distinct from an attempted/failed check if freshness is added to the wire.
9. Bound runtime reconciliation/notified-transition maps and preserve deduplication
   across retries. Coordinate subscriber recovery changes with step 11; state
   changes and optional toast delivery must not be conflated.

## Required tests

Retain tests for known-PR identity, branch discovery, replacement PRs, reopen,
not-found after terminal state, paused target, persistence failure, partial
comments/metadata failure, pending timeout, and old-target response fencing.

Add deterministic tests for terminal cadence; unfinished repair staying due;
repair after restart; new open PR discovered on a terminal branch; explicit wake
bypassing quiet delay; aggregate concurrency bound; fairness under merge bursts;
startup jitter; rate-limit cooldown; failed check rollup with successful state;
and simultaneous merge cleanup/environment deletion. Verify task comments are
not duplicated when timers, explicit commands and recovery converge.

## Acceptance and rollback

Quiet terminal environments perform about one discovery attempt per configured
period, not three per minute, after repair. Open/pending latency remains within
the baseline budget under the supported environment count. Adding clients does
not add monitoring loops. Rollback changes policy back to normal cadence while
retaining durable repair semantics and aggregate bounds; never restore two
monitor owners.

## Completion notes

Recorded 2026-09-25.

### What landed

| Commit | Change |
| --- | --- |
| `ceebd7a2` | `feat(backend): make PR monitoring lifecycle-aware and bounded` — `pr-monitor-policy.ts` (policy, delays, priority, failure classification, bounded cooldown scopes), `PrMonitorService` changes, composition root in `commands-pr-monitor.ts`, command handlers, additive `lastSuccessfulCheckAt`, tests. |
| `fad57961` | `test(backend): seed PR monitor jitter in the recurring baseline harness` — deterministic `seededRandom(scenario.id)` so the artifact stays comparable. |
| docs commit | `baseline/step-05-pr-monitoring.json`, baseline README "Step 05 re-run", these notes. |

The existing per-entry completion scheduling in `PrMonitorService` was kept
(one timer per entry, no second owner); `RecurringScheduler` was not adopted
because the per-entry state machine (generation fences, recheck coalescing,
pending-mode expiry) already owns due times and moving it would have been the
larger change. The shared `external-pr` `WorkAdmissionPool` (2 concurrent, 1
per environment, starvation cap 8) now bounds the physical `gh`/`docker exec`
call; the slot is released as soon as that call settles, before local
persistence and task effects.

### Policy (task 3)

User intent (`mode`) is unchanged on the wire; the lifecycle observation policy
is internal (`PrMonitorService.observationPolicy()` for diagnostics/tests):

| Policy | Next action | Cadence | Admission priority |
| --- | --- | --- | --- |
| `merge-pending` / `create-pending` | detection | 1 s / 5 s (unchanged, timeouts unchanged) | interactive |
| `provisional` (completion probe) | detection | immediate, retired if nothing found | progress |
| `open` (incl. persistence pending) | detection | 20 s (unchanged) | discovery (recovery while persistence is pending) |
| `terminal-repair` | local repair, no `gh` | 20 s, own backoff to 5 min | — (no admission) |
| `terminal-discovery` | branch discovery | 5 min + [0, 30 s) jitter | maintenance |
| `paused` | none | none | — |

Constants (`DEFAULT_PR_MONITOR_POLICY`, overridable through the internal
`policy` option): terminal discovery 300 s, terminal jitter 30 s, startup
jitter 20 s, error jitter 10 % capped at 30 s, rate-limit cooldown 120 s,
retry-after cap 60 min, 8 reconciliation keys per entry, 64 cooldown scopes;
`PR_DETECTION_TIMEOUT_MS` 30 s for local and (new) container lookups.
Explicit refresh (`requestCheck`, interactive), a new pending intent
(`requestMode`) and completion edges (`wakeForCompletion`,
`requestCheck(id, "completion")`) schedule at 0 ms whatever the policy. Restored
entries (reconciliation `sync`, resume after a container becomes ready) get
[0, 20 s) extra on their first ordinary schedule; a restored terminal entry
repairs locally first and spreads its first discovery over [20 s, 5 min).
Explicit create/merge feedback is never jittered.

### Terminal obligations (task 1)

| Obligation | Durable before step 05? | Idempotent? | Runtime-only part | How it is reconstructed now |
| --- | --- | --- | --- | --- |
| Environment `prUrl`/`prState` | yes (`persistPr`) | yes | `persistencePending` | re-detection until persisted (unchanged) |
| Task → review (merged) | yes (task status) | yes (`in-progress`/unknown only) | `status` progress step | reread task status |
| Task PR link | yes (task metadata) | yes (compared first) | `link` step | reread task metadata |
| Task terminal comment | yes (URL-specific text) | yes (exact text check) | `comment` step | reread comments |
| Task completion flag | yes (`prMergeCommented` for URL/state) | yes | `metadata` step | reread flag |
| Merge-cleanup recovery | yes (`cleanupAfterMergeRequestedAt`/`…Error`) | yes (owner dedupes, reads intent) | was only triggered on a *changed* persist | `resumeTerminalEffects` after task reconciliation, from both detection and repair |
| Transition display | no (best-effort, step 11) | client dedupe | `observedPr` | never replayed; state converges by snapshot |

The only runtime marker added is `settledTerminal` (per URL/state, per
process). Nothing durable claims "all effects done"; after a restart each
terminal entry re-verifies every obligation from storage before going quiet.
Merge cleanup is now requested *after* the linked task is reconciled (it
previously fired inside `persistPr`, racing the reconciliation it could
orphan by deleting the environment).

### Other tasks

- (2) Failed detection (`consecutiveErrors`, wire) is separate from failed
  local repair (`repairFailures`, internal). A repair reruns only an
  observation this process already announced, rereads the durable environment
  (`readTarget`) and the task first, and switches to detection if storage
  moved on. A failing repair cannot starve discovery: a detection is forced
  once the last one is a discovery period old.
- (4) One pending check per environment: a wake that arrives while the check
  is queued is served by it and only raises its priority (withdraw and
  re-queue); a rename/target change while queued is captured at grant time.
- (5) `classifyPrDetectionFailure`: rate limit (`rate limit`, `secondary rate
  limit`, `HTTP 429`, abuse), timeout (`CommandFailedError.timedOut`), other.
  `gh pr view/list` expose no retry timing, so the 120 s default applies; a
  numeric `retryAfterMs` on the error is honoured (capped). Shared cooldown
  scope: local environments with a stored PR URL share `local-gh:<host>`
  (same process env and `gh` config, credential chosen per host); containers
  and URL-less discovery never share. No token is read, hashed or logged.
  Pending intents and interactive refresh bypass the cooldown; completion and
  background checks wait for it.
- (6) Rollup budget and separation unchanged; a boundary test with a fake `gh`
  proves a 403 on `statusCheckRollup` keeps the PR state and that terminal PRs
  never request a rollup. Settled-check backoff was not trialled.
- (7) No repository batching or webhooks.
- (8) Existing generation fences cover rename, stop, delete and target change;
  added: a merged PR is never overwritten by a non-merged reading of the same
  URL (stale read racing an explicit merge confirmation), and pause/delete
  withdraw a queued admission request. `lastSuccessfulCheckAt` (optional,
  additive) is distinct from `lastCheckAt`; both ride on announced events
  (see `docs/architecture/event-snapshot-recovery.md`).
- (9) Per-entry reconciliation progress is LRU-bounded to 8 keys;
  `reconciliationOperations` stays keyed by environment and is deleted on
  settle; cooldown scopes bounded to 64 and pruned. No subscriber/toast change
  (step 11's best-effort dedupe unchanged).

### Wake API for callers (step 07 coordination)

- `wakePrMonitorForCompletion(environmentId, context): Promise<void>`
  (`commands-pr-monitor.ts`) → `PrMonitorService.wakeForCompletion(target)`
  (`probe` remains an alias). Reached today through
  `pr_monitor_probe_environment`, i.e. `context.probeAgentCreatedPullRequest`
  from `index.ts`'s native activity edge and the tmux poll edge.
- `requestPrMonitorRefresh(environmentId, context, reason = "interactive")` →
  `PrMonitorService.requestCheck(id, reason)`. Used by `pr_monitor_refresh`
  (interactive) and `pr_monitor_agent_turn_completed` (`"completion"`, armed
  Resolve-conflicts rechecks via `context.notifyAgentTurnCompleted`).
- Callers must stay edge-triggered; no caller outside `commands-registry-pr.ts`
  changed.

### Before/after (deterministic harness)

`baseline/step-05-pr-monitoring.json` vs `step-01-baseline.json` (10 min warm
idle): 10 environments with 3 open + 3 terminal PRs, 180 → 96 detections;
50 environments with 17 open + 16 terminal, 990 → 542 (541 all-container).
Open entries unchanged at 30 per 10 min each; terminal entries 30 → 2 each
(≈ one discovery per 5 min). Rollups unchanged (30 / 170). Local gh spawns at
50 environments 56 → 33.6 per minute. No other owner's counters changed.
Details in the baseline README ("Step 05 re-run").

### Tests

New: `tests/unit/backend/pr-monitor-lifecycle.test.ts` (terminal cadence for
merged and closed/reopen; unfinished repair stays due with its own backoff and
no `gh`; failing repair does not starve replacement discovery; repair
revalidation against durable state; repair after restart; new open PR on a
terminal branch; explicit/completion/intent wakes bypass the quiet delay;
simultaneous merge-cleanup deletion; deletion during in-flight reconciliation;
stale open reading after explicit merge; no duplicated comments when timers,
explicit commands, sync and restart converge; bounded reconciliation maps;
terminal-effects failure keeps repair due),
`tests/unit/backend/pr-monitor-admission.test.ts` (aggregate bound of 2 with
one pending check per environment; priority upgrade in the queue; fairness
under a continuous merge-pending burst via the starvation cap — verified to
fail with the cap disabled; startup jitter; bounded error jitter; shared and
unshared rate-limit cooldown; retry timing honoured; failed rollup with
successful state; `lastSuccessfulCheckAt`; rename while queued; pause/delete
withdraw queued admission), `apps/backend/src/core/pr-monitor-policy.test.ts`,
`apps/backend/src/core/pr-monitor-boundary.test.ts` (fake `gh`), and a protocol
validation case. The existing `pr-monitor-service.test.ts` suite passes
unchanged except that its harness now injects `random: () => 0`.

### Checks

- Focused suites pass: root `pr-monitor-service` (unchanged assertions),
  `pr-monitor-lifecycle` (15), `pr-monitor-admission` (11), `view-revisions`;
  protocol `pr-monitor`; backend `pr-monitor-policy`, `pr-monitor-boundary`,
  `pr-monitor-agent-completion.integration`, `tests/recurring-baseline`; web
  `usePrMonitorService` and stores. Mutation checks: disabling the terminal
  cadence or the merged-is-final fence fails 5 lifecycle tests; raising the
  `external-pr` starvation cap to 800 fails the fairness test.
- `mise run test:logged -- --name check -- mise run check`: PASS.
- `mise run test:changed` (under `test:logged`): root, bridges, codex protocol
  lockfile, web, desktop, web-public, cli and protocol groups pass; backend
  ran 4,062 tests with one failure, `agent-provider-boundaries.test.ts` "keeps
  every provider implementation module within 1,500 lines" —
  `opencode-provider.ts` exceeds the limit after `3419f9d2` (step 10, already
  on the integration branch); step 05 does not touch that file. It fails
  identically when run alone.
- Baseline: `--compare step-01-baseline.json` reports 152 PR-only differences;
  `--compare step-05-pr-monitoring.json --fail-on-change` exits 0.

### Deferred / untested constraints

- No live `dev:test` profile run: real `gh` latency, p50/p95 freshness and
  admission queue delay under real load are unmeasured (the harness resolves
  detections instantly). Step 12 must run the live profile.
- The five-minute terminal period is a trial value; its acceptance against the
  "terminal replacement/reopen discovery" budget relies on completion-edge
  wakes, which step 07 owns.
- Shared cooldown covers local environments only; container credential scope
  is not provable from the backend and stays per entry.
- Settled check-rollup backoff (task 6's optional trial) was not attempted.
- Merge cleanup now waits for task reconciliation; a permanently failing task
  store therefore delays cleanup recovery until repair succeeds (the startup
  `list_environments` recovery path is unchanged).
- Rollback: set `terminalDiscoveryIntervalMs` to 20 s (the policy floor) and
  `terminalDiscoveryJitterMs` to 0 in `DEFAULT_PR_MONITOR_POLICY` to restore
  the old terminal cadence while keeping admission, repair semantics and
  fences; there is still exactly one monitor owner.
