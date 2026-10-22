# Native agent idle observation

Checked against `main` at `9b3f53a2` (2026-10-21).

An idle native session still costs a no-touch activity read on every 2 s
backend sweep for each HTTP-bridge provider, and a 1,500 ms client read for
Claude and Codex views. Either can slow down only once the provider's idle
state cannot change without an announced event. The remaining work is to add
that event coverage per provider, enable the backoff that already exists, and
let several views of one session share their reads.

## Current state

- `NativeAgentObservationBroker` (`apps/backend/src/core/native-agent-observation.ts`)
  is the single observer. It joins compatible reads (`OBSERVATION_FRESHNESS_MS`,
  1 s), fences each dispatch (`beginDispatch`) and each provider generation,
  and bounds its records (`MAX_OBSERVATION_RECORDS`, `MAX_OBSERVATION_GROUPS`,
  `MAX_OBSERVATION_DISPATCH_FENCES`). The sweep runs every 2 s
  (`ACTIVITY_JOB_MS` in `apps/backend/src/core/index.ts`).
- Backend idle backoff. A group whose sessions read idle
  `STABLE_IDLE_READS_BEFORE_BACKOFF` (3) times may skip sweeps until a 4 s
  safety read (`STABLE_IDLE_BACKOFF_MS`), but only when its row in
  `NATIVE_AGENT_OBSERVATION_CAPABILITIES` names an `idleBackoffWakeup` and the
  provider reports that wakeup live. Only OpenCode has one
  (`"provider-event-stream"`, `OpenCodeProvider.observationStreamLive`). Every
  HTTP-bridge group (Claude, Codex, Cursor, Pi, Grok) is read on every sweep:
  the backend does not subscribe to bridge event streams, which serve legacy
  renderer clients only.
- Client quiet backoff. `apps/web/src/lib/native-session-read-policy.ts` slows
  an idle, unchanged view through `NATIVE_QUIET_BACKOFF_TRIAL_MS` (3, 5, 10,
  15 s) for `NATIVE_QUIET_BACKOFF_QUALIFIED_PLATFORMS` (Cursor, Pi, Grok,
  OpenCode, in `packages/protocol/src/native-agent-observation.ts`) when the
  backend advertises `observationEventVersions`. The backend announces every
  activity transition with a generation and revision stamp, and
  `apps/web/src/lib/native-observation-events.ts` turns announcements into
  invalidations and a gap into a re-read of every view.
- A discovery section (models, commands, MCP, runtime) expires after 30 s and
  an idle view's own read renews it. The backend announces a renewal, and an
  expired environment model-catalogue refresh, only when its content changed
  (`storeProgressiveDiscovery` reports the change). Before this, every renewal
  announced a `native-agent-session` change, which re-read the view, reset its
  quiet backoff and woke the backend observation group (`session-mutation`):
  an idle Cursor view read 37.5 times a minute instead of 12.
- Claude and Codex are not qualified and keep 1,500 ms when idle. Claude
  background-task output, and Codex async questions and background terminals,
  change an idle view without an announced transition.
- `useNativeAgentSession` keys its coordinated read by hook instance
  (`view: readInstanceId`). Each instance applies reads into its own fenced
  state (sequence and epoch, conditional tokens), so two mounted views of one
  session do not share reads.
- Mail presence keeps its 2 s refresh and 4 s TTL (`OBSERVED_PRESENCE_TTL_MS`
  in `agent-mail-service.ts`). The injection gate trusts a retained idle only
  if it is post-dispatch and at most `MAIL_INJECT_OBSERVATION_MAX_AGE_MS`
  (4 s) old; otherwise it reads provider status. Presence stays authoritative
  only because HTTP groups never back off.
- Queue passes skip the provider read when a fresh, provider-confirmed busy
  observation exists (`QUEUE_BUSY_OBSERVATION_MAX_AGE_MS`); idle for dispatch
  always comes from a current status read.
- The interaction observer (inventory B08) runs only when
  `ORKESTRATOR_AGENT_INTERACTION_OBSERVE_ONLY=1` sets `interactionMonitorMode`
  to `"observe-only"` (`native-agent-service-prompt.ts`). It was left unchanged.
- Rollback: `ORKESTRATOR_NATIVE_OBSERVATION_SHARING=0` restores the previous
  per-provider cadence; emptying `NATIVE_QUIET_BACKOFF_QUALIFIED_PLATFORMS`
  removes client backoff. See
  [recurring-work-qualification.md](recurring-work-qualification.md) for when
  the switch goes.

## Outstanding work

### Code

1. Give HTTP-bridge groups an idle wakeup. Subscribe the backend to each
   bridge's event stream with replay cursors and gap marking, then set
   `idleBackoffWakeup` for that provider's row. Done when a stably idle group
   skips sweeps and an externally started turn, a lost event or a bridge
   restart is still discovered within the activity budget.
2. Announce what Claude and Codex currently change silently. Emit a stamped
   activity announcement (or a new invalidation) for Claude background-task
   output and for Codex async-question and background-terminal changes on an
   idle thread. Then qualify each provider and add it to
   `NATIVE_QUIET_BACKOFF_QUALIFIED_PLATFORMS`.
3. Share native reads across hook instances. Move the instance-local fenced
   state (sequence, epoch, conditional tokens) into a shared store keyed by
   connection, session and view window, then key the coordinated read by
   session instead of `readInstanceId`.
4. If HTTP groups ever back off, represent mail presence explicitly as stale
   or unknown. A slower observation must never read as permission to inject
   into an active session.
5. Find the `native-agent-session` hints that still reach an idle OpenCode
   view after the discovery fix. Live, an idle OpenCode view read 16.5 times a
   minute (four gaps of 2 to 6 s in two minutes) against Cursor's 12 with every
   gap at the 15 s step; 13 hints named the environment in 160 s.

### Qualification

The live run of 2026-10-21 is recorded below. What it left open:

- Grok and Pi: re-run `e2e/agent-testing/idle-observation-live.spec.ts` once
  their host logins are current. Both were signed out (expired host logins) and
  were skipped.
- Cases the models did not exercise: Codex sub-agents (no sub-agent tool call;
  the separate live sub-agent card run is in
  [live-provider-and-platform-qualification.md](live-provider-and-platform-qualification.md)),
  and background shells on Codex, Cursor and OpenCode (each ran the command in
  the foreground). Cursor's approval case ran under an `approvals: "ask"`
  policy and still ran the command without asking, which is the documented
  Cursor mapping (it reports `ask` as the auto-approval it runs).
- Completion with no renderer was observed for a local environment only; a
  container environment was not part of this run. Re-run with the corrected
  exact-prompt assertion to qualify missing/duplicate prompt protection.
- Re-run the background-shell indicator/output and detach cases with the
  corrected assertions. The original background checks could match the user
  prompt, and the detach case recorded cadence and session continuity without
  requiring detachment. Neither is qualification evidence for those behaviors.
  Shortened detach waits are cadence-only (`not-exercised`); a full wait must
  observe `detached` before dispatch and `attached` afterwards through no-touch
  runtime discovery. Providers without session detach telemetry on that route
  are also `not-exercised`, pending an observable lifecycle.

## Live qualification record (2026-10-21)

Run on macOS 27.0 (Apple Silicon), Bun 1.4.2, at `9b3f53a2` plus this change,
in the disposable profile `idleqa-faa8` with the pins in
[live-provider-and-platform-qualification.md](live-provider-and-platform-qualification.md)
(Claude CLI 2.1.296, Codex 0.162.1, OpenCode 1.19.0, Cursor SDK 1.0.37).

### Method

- **Spec.** `e2e/agent-testing/idle-observation-live.spec.ts`, opt-in
  `ORKESTRATOR_AGENT_TEST_LIVE_IDLE_OBSERVATION=1`. One fresh local fixture
  environment and one native tab per provider; a warm-up turn, then the cases
  below in order. Each case records backend truth (the projection read idle
  with the reply and no running task) beside what the page shows (the reply,
  no Stop button) and the sidebar icon, and writes
  `output/agent-testing/<run>/idle-observation-live/<platform>.json`.
- **Fault seams, page side only.** An init script wraps `EventSource` to drop
  every frame that names the environment (dropped after delivery, so neither
  the gateway cursor nor a replay can restore it: stronger than any real loss)
  or to cut the stream, and wraps `document.visibilityState`. Offline is
  Playwright's `context.setOffline`.
- **Credentials, least privilege.** `dev:test --fixture --credential-source
  claude --credential-source cursor --credential-source grok --agent-platforms
  claude,codex,opencode,cursor,grok,pi`, so the Codex and OpenCode homes stay
  inside the profile. Codex got the host's access and id tokens with a dummy
  refresh token and a fresh `last_refresh` (the access token was valid for
  nine more days, so nothing could rotate the host's login); OpenCode got its
  one `opencode-go` API-key entry. Both were written owner-only, never
  printed. Pi was not authorized: its host login had expired and refreshing it
  would have written the host's `auth.json`. The host Codex `auth.json` hash
  was the same before and after.
- **Commands.** Bridges rebuilt first (`mise run build:<platform>-bridge`).

  ```bash
  ORKESTRATOR_AGENT_TEST_PROFILE=idleqa-faa8 ORKESTRATOR_AGENT_TEST_RUN_ID=<run> \
    ORKESTRATOR_AGENT_TEST_LIVE_IDLE_OBSERVATION=1 \
    ORKESTRATOR_AGENT_TEST_IDLE_MODELS=opencode=opencode-go/deepseek-v4.1-flash \
    bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts \
    e2e/agent-testing/idle-observation-live.spec.ts --workers=4 --fully-parallel
  ```

  Sequential diagnostic runs used `ORKESTRATOR_AGENT_TEST_IDLE_PLATFORMS`,
  `ORKESTRATOR_AGENT_TEST_IDLE_CASES` and
  `ORKESTRATOR_AGENT_TEST_IDLE_DETACH_WAIT_MS=150000`.

### Results

Final run `idleqa-final-1` (four workers, 19.2 min, exit 1: 1 failed, 3
passed, 2 skipped), then OpenCode alone (`idleqa-oc-final`, 4.9
min, passed) after the dispatch-mode fix below. Times are the page's lag
behind backend truth unless stated.

| Case | Claude | Codex | Cursor | OpenCode | Grok | Pi |
| --- | --- | --- | --- | --- | --- | --- |
| Missed final event (every frame naming the environment dropped) | passed, 365 ms | passed, 12 ms | passed, 344 ms | passed alone, 8.8 s (see below); failed once in the final run (flake 0670) | skipped | skipped |
| Parked approval | passed: card 126 ms after parking, sidebar `waiting`, survived 10 s hidden, settled 314 ms after approving | passed: card 20 ms | not exercised: under `approvals: "ask"` Cursor ran the command without asking (documented mapping) | passed under `approvals: "ask"`: `permission` card 139 ms | skipped | skipped |
| Sub-agents | passed: `Agent` tool, one background task, none left running | not exercised: no sub-agent call | passed: `task` tool | passed: `task` tool | skipped | skipped |
| Background shell | unverified: original indicator/output checks could match the prompt; re-run required | not exercised: ran in the foreground | not exercised | not exercised | skipped | skipped |
| Stream cut and offline through completion | passed, 122 ms after online | passed, 127 ms | passed, 142 ms | passed, 182 ms | skipped | skipped |
| Hidden for the whole turn | passed: no reads while hidden, 318 ms after visible | passed, 191 ms | passed, 163 ms | passed, 219 ms | skipped | skipped |
| No renderer, then a second client | passed: backend aggregate idle 4 ms after the projection, rehydrated in 3.6 s | passed, 3.1 s | passed, 3.8 s | passed, 3.9 s | skipped | skipped |
| Idle 10.5 min, then follow-up | cadence/continuity only: 120.5 reads/min (1.5 s), settled 303 ms, same session; detach unverified | cadence only: 126.8 reads/min; detach unverified | cadence only: 13.8 reads/min, gaps at the 15 s step; detach unverified | cadence only: 27.9 reads/min (code item 5); detach unverified | skipped | skipped |

Grok and Pi: both sessions reported `needs-auth` ("Grok is not signed in",
"Pi is not signed in"); the profile also printed that the host Grok login had
expired. Recorded as skipped, not passed.

### Review follow-up validation (2026-10-21)

The assertions were tightened after review: no-renderer rehydration requires
exactly one exact submitted user prompt; hidden-page reads must be zero after
the drain window; a background case needs its running task card and fresh tool
result output (including lazily fetched result details). Detach uses no-touch
runtime discovery and requires detached then attached state where the provider
exposes it. Approval preparation and headless polling now restore their
environment/page even on failure. The overall qualification remains open.

- `qa-browser-0b1487c9-eb4`, Codex, disposable local fixture: hidden passed
  (zero reads while hidden, visible lag 142 ms); no-renderer passed (one exact
  prompt row, aggregate idle lag 4 ms, rehydration 3.17 s). A deliberately
  shortened detach wait was `not-exercised`, with follow-up continuity checked.
- `qa-browser-88278b44-d08`, Claude, background only: **failed** with the new
  output assertion. A running task card was observed in 280 ms and the view
  settled, but fresh tool-result output did not contain the emitted marker.
  The submitted prompt no longer counts as output evidence. This is pending
  qualification, not a passing background-output observation. The failure's
  trace also exceeded the artifact sanitizer's 16 MiB bound; no trace was kept.
- Both live profiles were stopped and reset by the isolated runner.

### Findings

- **Fixed: unchanged discovery renewals reset quiet backoff.** In the first
  sequential run an idle Cursor view received 26 `native-agent-session` hints
  in 150 s and read 37.5 times a minute, with most gaps under 6 s. Every 30 s
  discovery renewal announced a change even when nothing changed. After the
  fix (announce only a changed section, and only a changed expired model
  catalogue): 12 reads a minute, all gaps at the 15 s step, 6 hints in the
  same window. Tests: `native-agent-service-progressive.test.ts` ("announces an
  expired discovery renewal only when its value changed", "announces an
  expired model catalogue renewal only when the catalogue changed"). Each
  fails with its guard removed.
- **Lost-announcement bound, measured.** Alone, with every frame dropped and
  the turn dispatched from outside the view while it sat at the 15 s step:
  Cursor 10.9 s, OpenCode 9.7 s and 8.8 s. That is inside the backoff design
  but over the 3 s budget; see Open questions. In parallel runs another
  environment's announcement produced a stamp gap that re-read every view, so
  the same case settled in under 0.6 s. Claude and Codex (1.5 s baseline,
  unqualified) settled within 0.4 s.
- **No stuck working and no missed completion** in any exercised case: the
  Stop button and the sidebar always cleared, and the second client never
  replayed a prompt.
- **Not a defect: Claude reports a finished background task in a turn of its
  own.** One parallel run measured the sidebar 6.5 s behind the projection;
  the spec now follows the session until it is quiet, and the sidebar reached
  idle with the last busy read in every later run.
- **Flake 0670 (environmental).** One OpenCode turn stayed `running` for 240 s:
  OpenCode's own log shows its model stream open with no output until the spec
  cancelled it, so `running` was the truth.
- **Harness fixes during the run.** OpenCode dispatches went out in plan mode
  (a dispatch without a mode defaults Claude, Codex and OpenCode to plan) and
  the tab's `initialAgentModel` did not pin the model, so the final OpenCode
  rows were rerun with build mode and the model pinned through
  `ensure_native_agent_session`.

### Cleanup

Every case deleted its environments; the profile was stopped and reset
(`mise run dev:stop --profile idleqa-faa8`, `mise run dev:reset --profile
idleqa-faa8`). Nothing outside the profile was written.

## Constraints and rationale

- Observation stays on the no-touch `/activity` route, never `/status`. It
  never starts a bridge, attaches, hydrates or refreshes liveness.
- Idle is never served from cache for dispatch, and a pre-dispatch idle can
  never advance a pipeline or drain another prompt. Dispatch and generation
  fences stay.
- A failed observation evicts a provider without disposing it; the replaced
  provider is retired only after its dispatches settle plus a grace period.
- Budgets (p95): pending approval visible within 2 s on an active view,
  background activity indicator within 4 s, turn completion or queued
  dispatch within 3 s. The backend's 4 s safety read keeps a lost event inside
  the activity budget. Source:
  [recurring-work.md](../architecture/recurring-work.md#latency-budgets).
- Responsive phases (running, blocked, cancelling, recovering) never back off
  on the client.
- A provider whose events stay incomplete keeps its fallback reads. Do not
  claim universal event-driven support.
- An older backend without stamped announcements keeps the baseline cadence.

## Open questions

- A silently lost activity announcement can hold a backed-off idle view (Cursor,
  Pi, Grok, OpenCode) up to the 15 s backoff step before it shows the completed
  turn: 9.7 to 10.9 s live, against the 3 s budget. The real transport cannot
  lose a frame silently (gateway replay cursors, a stamp gap re-reads every
  view), so the live seam is stronger than any real loss. Decide whether that
  bound is accepted or whether a view that saw a recent dispatch should skip
  the backoff.

- Is subscribing to bridge event streams worth it for Cursor, Pi and Grok,
  which already have client quiet backoff, or only for Claude and Codex?
- Should the B08 interaction observer be retired or folded into the broker?

## Related

- [remote-client-bandwidth.md](remote-client-bandwidth.md): client-side
  bandwidth and the data-saving preference.
- [client-reconnect-and-freshness.md](client-reconnect-and-freshness.md):
  disconnect signals for the read coordinator.
- [recurring-work-qualification.md](recurring-work-qualification.md): live
  evidence against the budgets and rollback-switch removal.
- [agent-interactions-and-permissions.md](agent-interactions-and-permissions.md):
  interaction contract gaps per provider.
- `../architecture/event-snapshot-recovery.md` ("Native observation
  invalidations") and `../architecture/recurring-work.md` (inventory rows
  C01 and B06 to B10, the observation broker and the read coordinator).
- Living-doc drift to fix:
  - `event-snapshot-recovery.md` titles the section "Native observation
    invalidations (step 07)"; drop the step label.
  - No living doc carries the provider observation capability matrix; it
    exists only as `NATIVE_AGENT_OBSERVATION_CAPABILITIES`. A short table in
    `../architecture/agent-engines.md` would help.

## Replaces

- `docs/improvements/recurring-processes/plan/07-agent-observation-and-activity.md`
  (deferrals: HTTP-bridge wakeup, Claude and Codex qualification,
  cross-instance sharing, live providers, B08)
- `docs/improvements/recurring-processes/plan/06-client-read-coordination.md`
  (task 8, Claude and Codex gating)
- `docs/imrovements/recurring-processes.md` (findings F05 and F06; inventory
  rows C01 and B06 to B10 moved to `../architecture/recurring-work.md`)
