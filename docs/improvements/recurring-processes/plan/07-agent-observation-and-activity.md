# 07 — Share agent observations and schedule due activity groups

Status: Implemented with unit/integration qualification (see
[completion notes](#completion-notes)): shared observation broker, dispatch and
generation fences, next-due provider groups (OpenCode only), queue/mail reuse,
provider retirement, stamped client invalidations and quiet backoff for
Cursor/Pi/Grok/OpenCode. Live-provider qualification and cross-instance client
read sharing remain open. Dependencies: 01, 02, 06; step 11 before reduced
safety polling. Findings: F05, F06.

## Outcome

Backend activity, prompt queue readiness, mail presence, workflow observation
and visible session reads reuse compatible observations without repeatedly
hydrating transcripts or touching idle sessions. Background turns and approvals
remain observable without a mounted renderer.

## Existing sources

`native-agent-service-reconciliation.ts`, `native-agent-service-provider.ts`,
`native-agent-service-projection.ts`, `http-bridge-provider.ts`,
`opencode-provider.ts`, `opencode-session-lifecycle.ts`, `agent-mail-service.ts`,
`tmux-poll.ts`, bridge activity routes, and `useNativeAgentSession.ts`.

The current native sweep already joins scans, groups by environment/provider,
uses eight workers and backs off failed groups. Extend these protections rather
than adding a competing observer alongside them.

## Implementation tasks

1. Build a provider capability matrix from current adapters: activity snapshot,
   transcript revision, pending interactions, turn transition notifications,
   background children, generation identity and no-touch behavior. Record
   unsupported surfaces explicitly. Do not assume an event from one provider
   has the same completeness on every provider.
2. Define a bounded observation record by backend/environment/provider/session
   generation: observation timestamp, activity, ready-for-input, pending
   interaction indicator, relevant revision and freshness. Do not retain a full
   transcript merely to share an activity answer.
3. Add compatible in-flight joining for cheap reads and a short freshness window
   justified by the baseline. A workflow needing a newer post-dispatch observation
   must be able to request it. Cached pre-dispatch idle can never advance a
   pipeline or drain another prompt.
4. Preserve `observeProvider` semantics: no start command, no attach/hydration,
   no liveness touch. A missing bridge differs from a failed probe; maintain
   existing conservative handling and absent-bridge cooldown. Do not replace
   `/activity` with a tab-facing `/status` route for convenience.
5. Track next-due provider groups. Running, cancelling, recovering, blocked and
   uncertain groups retain responsive observation; stable idle groups may back
   off only with a qualified wakeup path for externally started work. Provider
   generations and durable session mutations wake the appropriate group.
6. Feed one confirmed observation into environment activity, queue/mail readiness
   and completion handling. Preserve session-level completion while another
   session in the same environment remains active. Keep PR probes edge-triggered,
   not one probe per idle observation.
7. Coordinate mail presence's current four-second TTL with the new policy. Either
   preserve enough refresh for an authoritative presence lease, or represent
   stable/unknown/stale presence explicitly. Never let slower observation be
   interpreted as permission to inject into an active session.
8. Separate interaction-state freshness from optional transcript/discovery
   freshness. New questions, approvals, errors and ambiguous-dispatch controls
   must invalidate the critical view promptly. If a provider cannot supply these
   events, retain its bounded fallback reads.
9. Audit provider eviction/reconnect ownership. A failed observation must not
   abort a controller shared with prompt dispatch. Subscription replacement must
   dispose obsolete observers safely without leaving duplicates or killing a
   live turn. Retain the OpenCode rejected-cancel regression and fatal guard.
10. Expose generation-aware backend invalidations to the client coordinator.
    Before slowing native idle reads, qualify every supported provider and
    retain conservative fallback for older bridges. Do not change dispatch
    request IDs, retry journals or approval decisions as part of observation.

## Tests

Extend `native-agent-service-reconciliation.test.ts` and owning provider tests.
Prove observation never starts a bridge or hydrates/touches idle sessions; many
consumers join only compatible reads; stale idle cannot follow a new dispatch;
failed reads remain unknown/recovering; one completed session drains its queue
while another stays busy; PR discovery runs once per completion edge; externally
started work is eventually discovered; mail injection waits for trustworthy
readiness; and generation replacement fences all late results.

Include live provider coverage in isolated fixtures for missed final events,
parked approvals, background subagents, reconnect, idle detach/reattach and
hidden-client completion. For a provider whose events remain incomplete,
document and keep the fallback instead of claiming universal event-driven support.

## Acceptance and rollback

Duplicate provider reads drop measurably while activity/approval/completion
latency meets baseline budgets. Idle detach still occurs with backend monitoring
running. Zero-renderer workflows and queues continue. Rollback re-enables the
current observation cadence per provider, retaining generation fences and
authoritative snapshots; it must not create an extra concurrent subscription.

## Completion notes

Recorded 2026-09-25 on branch `worktree-agent-ac0e0295e72e11ecf` (merged from
`implement-recurring-processes-aaceef7ccc03-r1` at `7b93c83e`).

| Commit | Scope |
| --- | --- |
| `f1c4a937` | Observation broker, sweep/dispatch/queue/mail integration, provider retirement, OpenCode wakeups, Pi `blocked` fix, stamped announcements, tests |
| `47db9cef` | Client: stamped-announcement invalidations, qualified quiet backoff |
| `2883162a` | Driven native sweep in the baseline harness; `ORKESTRATOR_NATIVE_OBSERVATION_SHARING=0` rollback; 4 s idle ladder |
| `2bbb2fcb` | Test typing fix found by `mise run check` |
| docs commit | This note, baseline README and `step-07-baseline.json`, architecture note |

### Provider capability matrix (task 1)

Derived from the adapters and bridges at this commit; the code copy that drives
policy is `NATIVE_AGENT_OBSERVATION_CAPABILITIES` in
`apps/backend/src/core/native-agent-observation.ts`. Only two columns drive
policy: *idle backoff wakeup* (backend observer) and *quiet client backoff*
(renderer, from the protocol's `NATIVE_QUIET_BACKOFF_QUALIFIED_PLATFORMS`).

| Provider | Activity snapshot (no-touch) | Parked input | Readiness / attention | Transcript revision | Pending interactions read | Turn events to backend | Background children | Generation identity | Idle backoff wakeup | Quiet client backoff |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Claude | `GET /session/:id/activity`; idle/working/waiting/missing; in-band `missing` | `waiting` | `readyForInput` | per-process `generation` + `contentEpoch`, no revision | `/questions`, `/plan-approvals` — **touch liveness** | none (bridge SSE unused by backend) | `working` while tasks live, readiness split | bridge connection (port + token) | none | **no** (background output behind a released composer) |
| Codex | `/activity`; idle/working/waiting/missing | `waiting` | `asyncQuestionItemIds` | `revision` + `engineGeneration` (restarts at 1 per bridge process) | `/approvals`, `/interactions` — no touch | none | async attention only | bridge connection | none | **no** (async questions/background terminals on an idle thread) |
| Cursor | `/activity`; working/idle/missing | reads `working` (SDK approves its own tools; approvals always empty) | none | `revision`, per-process generation | always `[]` | none | `working` while subagents live; settled at parent end | bridge connection | none | yes |
| Pi | `/activity`; working/idle/missing, parked approval was `blocked` (**rejected by the backend** — fixed: bridge answers `waiting`, backend maps legacy `blocked`) | `waiting` (after fix) | none | `revision`, per-process generation | `/approvals` — touches liveness | none | not modelled | bridge connection | none | yes |
| Grok (ACP) | `/activity`; working/idle/missing | reads `working` | none | `revision`, per-process generation | `/approvals`, `/interactions` with revision | none | `working` while subagents live | bridge connection | none | yes |
| OpenCode | `activityBatch` from the event-fed lifecycle map (30 s status reconcile), `question.list`/`permission.list` only when running | `waiting` | none | backend stream revision (`sourceToken`), no generation | SDK lists | **yes**: backend SSE (`session.status/idle/error`, `permission.*`, `question.*`), gap marking on reconnect | not modelled | SDK connection | **provider event stream while live** | yes |

Unsupported surfaces are explicit above: no HTTP bridge pushes turn or
interaction events to the backend (their SSE routes serve legacy renderer
clients only), so no HTTP-bridge group ever backs off; Cursor and Grok cannot
report parked input as `waiting`; only Codex exposes an in-process engine
generation and it is not unique across bridge restarts, so generation identity
for every HTTP bridge is the backend's bridge-connection hash. `onInteractionObservation`
is emitted only by OpenCode and only when it auto-answers (never for
interactive providers).

### Observation contract (tasks 2–4)

- **Record** (`NativeAgentObservationRecord`): `sessionKey`, `groupKey`
  (environment + agent), `providerSessionId`, group `generation`, `observedAt`
  (start of the read), `activity`, `readyForInput?`, `pendingInteraction`
  (waiting or async question), `dispatchSequence`, `source`
  (`provider`/`dispatch`/`absent-bridge`). Bounded: 4,096 records, 2,048
  groups, 4,096 dispatch fences; pruned with their sessions every sweep. No
  transcript or provider payload is retained.
- **Freshness**: `fresh` (≤ 1 s, or the caller's `maxAgeMs`), `stale`,
  `recovering` (the group's last read failed; never served as fresh), `unknown`.
  The 1 s default only joins bursts inside one 2 s sweep; nothing is served
  older than the caller allows.
- **Dispatch fence**: `beginDispatch` bumps a per-session sequence right
  before `provider.send` and again when it settles; any sweep read that started
  before or during that window is refused for that session (its retained state
  feeds the aggregate instead). This fixes a real race: a sweep that read idle
  just before a dispatch used to overwrite the dispatch's `working` and emit a
  false turn-end edge — draining the next queued prompt, waking mail and
  probing for a PR. A dispatch-recorded `working` is never "post-dispatch".
- **Generation fence**: installing, replacing, evicting or forgetting a group's
  provider bumps the group generation; reads are re-anchored to the provider
  actually read from, and results from a replaced one are discarded.
- **Joining**: `reconcileAgentActivity()` still joins an in-flight sweep; a
  consumer demand (`observeSessionActivity(input, { maxAgeMs,
  requirePostDispatch })`) first uses the retained record, else wakes the group
  and joins only a sweep that started after the demand — all such demands share
  one follow-up sweep.
- **`observeProvider` semantics unchanged**: no start command, attach, hydrate
  or liveness touch; absent-bridge cooldown and "absent is idle" unchanged; the
  sweep still reads `/activity`, never `/status`. Proven against a real HTTP
  server: only `GET /session/:id/activity` and `peek_local_agent_bridge` occur
  across sweeps, demands and busy queue passes.

### Due-group policy (task 5)

The eight-worker sweep, its failure backoff (2 s → 60 s) and absent-bridge
cooldown are unchanged and remain the only observer. Groups that are working,
waiting (blocked), cancelling/recovering (bridges report these as working),
failing, unknown or holding an OpenCode incomplete-turn candidate are read on
every sweep. A group whose sessions all read idle for 3 consecutive accepted
reads may skip sweeps until a 4 s safety read **only** when its provider's
matrix row names a wakeup (`provider-event-stream`) *and* the provider reports
it live (`OpenCodeProvider.observationStreamLive()`: connected, not
reconnecting). The ceiling is the step 01 activity-indicator budget (≤ 4 s), so
even a lost event stays within it. Wakes: dispatch, durable
`native-agent-session` resource changes, provider generation changes, provider
events (`onObservationHint`: status changes, question/permission asked/replied/
rejected, session errors, and every stream connect/gap), and explicit demands.
Skipped groups contribute their retained idle to the environment aggregate
without re-announcing anything.

### One observation, many consumers (tasks 6–7)

- Environment activity, session-completion bookkeeping, OpenCode recovery and
  the transition callback all run from the same accepted observation, as
  before; session-level completion while a sibling is busy is unchanged and
  tested (a completed tab drains its own queue while the sibling's queue is
  held without any provider read).
- **Queues**: a queue pass whose session has a fresh (≤ 4 s),
  provider-confirmed busy observation returns without `ensureSession` and the
  status read — both tab-facing routes (a Codex liveness touch, a Claude
  transcript hydrate) that used to run twice per busy queue every 2 s. Idle is
  never taken from the cache: dispatch still requires the provider's current
  status. Codex async-question answers and a released composer
  (`readyForInput`) always read.
- **PR probes**: `probeForAgentCreatedPullRequest` in `apps/backend/src/core/index.ts`
  is the single call site, run once per `isAgentTurnEndTransition` edge;
  re-point it when step 05 adds a completion wakeup. The dispatch fence is what
  makes "once per completion edge" hold under a dispatch race (tested).
  `pr_monitor_agent_turn_completed` for armed rechecks is unchanged.
- **Mail**: presence refresh keeps its 2 s cadence and 4 s TTL (no HTTP group
  ever backs off, so presence stays authoritative). The injection gate now
  trusts a retained idle only if it is ≤ 4 s old and post-dispatch; anything
  older or pre-dispatch is `unknown` and costs one authoritative provider
  status read, so a slower observation can never read as permission to inject
  into an active session (tested with a stale idle and a running provider).

### Interaction freshness (task 8)

Interaction state rides on the no-touch activity read (`waiting`,
`pendingInteraction`), separate from transcript/discovery; every transition to
or from `waiting` is announced immediately with a stamp, and OpenCode question/
permission events wake the group. Pi approvals previously broke observation
entirely (`blocked` rejected → group failure/backoff/eviction); fixed in both
directions. Providers that cannot report parked input (Cursor, Grok) keep every
sweep and the renderer's 500 ms responsive cadence while running. Parked
dispatches are durable session mutations and already invalidate the view and
now also wake the group.

### Eviction and reconnect audit (task 9)

- A failed observation still evicts without disposing (a shared OpenCode
  controller would abort a live prompt). New: the evicted or replaced provider
  is **retired** — disposed only after every dispatch it sent has settled plus
  a 30 s grace, never while cached under any key, and re-caching cancels it.
  Previously each evicted OpenCode provider kept its own event subscription for
  the life of the process (a duplicate observer per eviction).
- Tested: an in-flight prompt survives an observation failure and eviction and
  completes; the obsolete provider is disposed afterwards; a re-cached provider
  is never disposed; a replaced provider's late result is fenced.
  `opencode-provider-dispose.test.ts` (real SDK client, rejected
  `reader.cancel()`) passes unchanged; the fatal-rejection guard is untouched.

### Client invalidations and quiet backoff (task 10)

`native-agent-session-activity` now carries `agent`, `logical_session_key` and
the observer's `generation`/`revision` (additive; older clients ignore them),
and `get_native_agent_sync_capabilities` advertises
`observationEventVersions: [1]` with the current stamp. The client
(`apps/web/src/lib/native-observation-events.ts`) invalidates matching views,
re-reads every view on a gap or new generation, and ignores duplicates.

| Provider | Quiet idle backoff | Evidence |
| --- | --- | --- |
| Cursor, Pi, Grok, OpenCode | **qualified** (3/5/10/15 s while idle, only against a backend that advertises announcements) | backend announces every transition of these providers within one sweep (OpenCode: event wake); an idle view changes only through a transition; gap/reset re-read and reconnect reconcile; `useNativeAgentSession.observation.test.tsx` |
| Claude | not qualified | background task output changes an idle view with no transition |
| Codex | not qualified | async questions / background terminals on an idle thread |
| Any, older backend | not qualified | no stamped announcements; baseline 1,500 ms kept |

Dispatch request ids, retry journals and approval decisions are untouched.
Native reads are **not** shared across hook instances: each instance applies
reads into its own fenced state (sequence/epoch, conditional tokens), so
sharing needs that state moved into a shared store first — deferred.

### Before / after

Step 01 comparison: `--compare step-01-baseline.json` reports **no counter
difference** for any existing scenario. The harness now drives the real native
sweep and queue scan (`recurring-baseline-native.ts`, artifact
`baseline/step-07-baseline.json`, 10 environments, 10 min, 2 s ticks):

| Mode | Activity reads | Tab-facing status reads | Provider reads / min | Retained group passes | External start seen (event lost / delivered) | Turn-end edges |
| --- | --- | --- | --- | --- | --- | --- |
| rollback (pre-step-07 cadence) | 3,000 | 1,200 | 420 | 0 | 1.5 s / 1.5 s | 2 |
| shared | 2,722 | 0 | 272.2 | 558 | 1.5 s / 1.5 s | 2 |

−35 % provider reads and no liveness-touching reads from busy queues, with the
same edges and discovery within the ≤ 4 s budget (bounded by the safety read
if an event is lost). Client-side, a qualified idle view drops from 40 to 4
state reads per minute once fully quiet (1,500 ms → 15 s), and reads
immediately on any announcement for it.

### Checks

- Focused (`mise run test:logged`): `native-agent-observation.test.ts` (broker:
  fences, generations, due groups, freshness, bounds, matrix), the new
  "NativeAgentService shared observations" block in
  `native-agent-service-reconciliation.test.ts` (no start/hydrate/touch against
  a real HTTP server; joining and one follow-up read; stale pre-dispatch idle
  fenced and exactly one completion edge; failed reads recovering/unknown;
  completed tab drains its queue while the sibling is held; qualified idle
  backoff with discovery via safety read, provider event and session mutation;
  unqualified provider read every sweep; mail gate on stale idle; generation
  replacement fenced and obsolete provider retired; in-flight prompt survives
  eviction; re-cached provider never retired), `opencode-provider-reconnect.test.ts`
  (stream liveness and hints), `http-bridge-provider.test.ts` (Pi `blocked`),
  `index.test.ts` (stamped payload), Pi `http.test.ts`, protocol
  `native-agent-observation.test.ts`, web `native-observation-events.test.ts`,
  `native-session-read-policy.test.ts`, `useNativeAgentSession.observation.test.tsx`,
  `useNativeAgentSession.visibility.test.tsx`, `tests/recurring-baseline.test.ts`.
  Mutation check: disabling the dispatch/generation fence fails the stale-idle
  and generation tests; disabling the client gating fails the quiet-backoff test.
- Whole backend package: 4,060 pass, 1 fail (the pre-existing
  `index.test.ts` PR-state test below); whole web package: 7,307 pass.
- `mise run test:logged -- --name check -- mise run check`: pass (format,
  lint with no new warnings in touched files, typecheck of all packages).
- `mise run test:changed`: root, bridges and codex-protocol groups pass;
  workspace group fails only on the pre-existing `index.test.ts` test.
- Baseline: `recurring-baseline.ts --compare step-01-baseline.json` → no
  counter differs.

### Deferrals and untested constraints

- **Live provider coverage** (missed final events, parked approvals,
  background subagents, reconnect, idle detach/reattach, hidden-client
  completion against real Claude/Codex/Cursor/Pi/Grok/OpenCode) needs real
  credentials in an isolated `dev:test` profile and was not run. Coverage here
  is fake providers, a real HTTP server for the no-touch proof, and the real
  OpenCode SDK client for the event stream only.
- HTTP bridges get no idle backoff: they push no events to the backend.
  Subscribing the backend to bridge SSE (with replay cursors) is the path to
  qualifying them; not attempted.
- The `index.ts` 2 s activity bundle (Claude state reconcile, tmux drains,
  mail presence/injection, renames) and the 2 s launch/queue timer are not
  split into due jobs — step 08 owns that and should consume
  `observeSessionActivity` / `wakeObservation`.
- The interaction observer (B08, off by default) is unchanged.
- Cross-hook-instance read sharing on the client (above).
- `shutdown clears backend-owned PR watch state before a new backend starts`
  (`index.test.ts`) fails on the integration branch before this step: step 11
  stamped `get_pr_monitor_state` and the test still expects the unstamped
  shape. Left for the PR-monitor owner (step 05).
- `agent-provider-boundaries.test.ts` was failing on the integration branch
  (step 10 pushed `opencode-provider.ts` to 1,525 lines); this step moved the
  observation helpers and `activityBatch` into `opencode-observation-stream.ts`
  (now 1,453 lines).

### Rollback

`ORKESTRATOR_NATIVE_OBSERVATION_SHARING=0` restores the previous cadence per
provider (every group every sweep; queue passes read the provider) without a
second subscription, keeping the dispatch/generation fences, the mail freshness
gate and provider retirement. The client's quiet backoff is removed by emptying
`NATIVE_QUIET_BACKOFF_QUALIFIED_PLATFORMS`.
