# Native agent idle observation

Checked against `main` at `06297124` (2026-10-23). The 2026-10-21 live record
below was taken at `9b3f53a2`, before the 2026-10-23 code changes.

An idle native session used to cost a no-touch activity read on every 2 s
backend sweep for each HTTP-bridge provider, and a 1,500 ms client read for
Claude and Codex views. The code for all five items is now in place: Claude and
Codex groups back off on the backend behind their bridges' event streams, their
idle views back off on the client behind content announcements, views of one
session share their reads, mail presence reports a stale idle as `unknown`, and
two sources of idle OpenCode hints are gone. What is left needs the real stack:
live evidence that the new backoffs stay inside the latency budgets, and the
open qualification cases from the 2026-10-21 run.

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
  provider reports that wakeup live. OpenCode (`OpenCodeProvider.observationStreamLive`),
  Claude and Codex (`HttpBridgeProvider.observationStreamLive`) have one.
  Cursor, Pi and Grok bridges publish no event stream, so their groups are
  read on every sweep.
- Bridge observation stream (`apps/backend/src/core/http-bridge-observation-stream.ts`).
  The first `observationStreamLive()` call from the sweep opens
  `GET /event/subscribe?observe=1` on the Claude or Codex bridge. In that mode
  the bridge sends each event's type, cursor and session id, never its
  payload, and the subscriber does not keep the bridge's replay ring alive
  (`bridges/claude-bridge/src/routes/events.ts`, `bridges/codex-bridge/src/index.ts`).
  The stream is live only after a `connected` frame that confirms
  `observe: true`, and only while a frame arrived within
  `BRIDGE_OBSERVATION_STREAM_SILENCE_MS` (75 s; both bridges send a keepalive
  at least every 30 s). Reconnects resume from the last frame id (`?since=`)
  with jittered backoff (1 to 30 s). Every connect, every `replay.required`
  (Claude), every session-less `session.reconcile-required` (Codex) and every
  disconnect hints the whole group; a frame naming a session hints the group
  too. Hints only make the group due; the no-touch `/activity` read stays the
  source of truth. A bridge that does not confirm observation mode is closed
  for good and its group keeps every sweep. `HttpBridgeProvider.dispose()`
  closes the stream.
- Content revisions. The Claude and Codex `/session/:id/activity` and
  `POST /sessions/activity` answers carry an opaque `contentRevision`
  (`SessionActivityObservation.contentRevision`, at most 256 characters).
  Claude: bridge process generation, transcript epoch and revision
  (`readTranscriptVersion`) and a per-session background-task snapshot count
  (`noteBackgroundTasksChanged`). Codex: a process id, the session's
  `contentEpoch` and `messageRevision`, and the async-question count. Both are
  O(1) and touch nothing; a failure to compute one omits the field rather
  than failing the read.
- Content announcements. `recordActivity`
  (`native-agent-launch-activity-reconciler.ts`) compares the revision across
  sweeps. When it moves while the state is unchanged and the session is idle
  (or working with a released composer), it calls `onObservationInvalidation`,
  stamped from the same contiguous sequence as transitions. `index.ts` emits it
  on `native-agent-session-activity` with `previous_state` equal to `state` and
  `reason: "content"`. Nothing that hangs off turn edges (workflows, PR probes,
  mail, coordinator) consumes it. Running sessions are not announced.
- Client quiet backoff. `apps/web/src/lib/native-session-read-policy.ts` slows
  an idle, unchanged view through `NATIVE_QUIET_BACKOFF_TRIAL_MS` (3, 5, 10,
  15 s) for `NATIVE_QUIET_BACKOFF_QUALIFIED_PLATFORMS` (now all six, in
  `packages/protocol/src/native-agent-observation.ts`) when the backend
  advertises `observationEventVersions`. Claude and Codex are also in
  `NATIVE_QUIET_BACKOFF_CONTENT_REVISION_PLATFORMS`: they back off only while
  the session's `turn.quietObservation` is set. The backend sets it
  (`quietObservationFlag` in `native-agent-transcript-projection.ts`, both
  projection paths) only while its last observation of that provider session
  carried a content revision, so a view of an older bridge, or before the
  first sweep, keeps 1,500 ms.
- Shared reads (`apps/web/src/lib/native-session-shared-reads.ts`).
  `useNativeAgentSession` keys its coordinated read by session
  (`view: "session"`), so every mounted view of one session shares one timer,
  one dirty flag and one in-flight read. That read runs a
  `NativeSessionReadRound` over every registered view that wants background
  reads; within a round, identical requests (same command, identity, window
  and conditional token) are sent once and each view applies the answer into
  its own fenced state. Explicit, post-mutation and connect reads are never
  joined, and a join never outlives its round.
- Discovery hints. A discovery section (models, commands, MCP, runtime)
  expires after 30 s and an idle view's own read renews it. The backend
  announces a renewal only when what a view would show changed
  (`storeProgressiveDiscovery` returns `announce`): a retained value that only
  flips between `ready` and `stale` (a renewal that missed its 2 s deadline,
  then succeeded with the same value) and the runtime drift counter
  (`unknownEvents`) are stored but not announced. An expired environment
  model-catalogue refresh is compared order-insensitively (`modelCatalogKey`).
- Mail presence keeps its 2 s refresh and 4 s TTL (`OBSERVED_PRESENCE_TTL_MS`
  in `agent-mail-service.ts`). `mailInjectPresence`
  (`native-agent-service.ts`) answers `unknown` instead of `idle` when
  the retained idle would not pass the injection gate: older than
  `MAIL_INJECT_OBSERVATION_MAX_AGE_MS` (4 s) or read before the session's
  latest dispatch. A flip between `idle` and `unknown` does not reset the
  inject backoff (`idleFreshnessFlip`); the drain still resets it on `idle`.
  The injection gate itself is unchanged: a retained idle counts only if it is
  post-dispatch and at most 4 s old; otherwise it reads provider status.
- Queue passes skip the provider read when a fresh, provider-confirmed busy
  observation exists (`QUEUE_BUSY_OBSERVATION_MAX_AGE_MS`); idle for dispatch
  always comes from a current status read.
- The interaction observer (inventory B08) runs only when
  `ORKESTRATOR_AGENT_INTERACTION_OBSERVE_ONLY=1` sets `interactionMonitorMode`
  to `"observe-only"` (`native-agent-interaction-tracker.ts`). It was left
  unchanged; see Assumptions and decisions.
- Rollback: `ORKESTRATOR_NATIVE_OBSERVATION_SHARING=0` restores the previous
  per-provider cadence, the bridge streams included (no group then qualifies
  for backoff, so no stream is opened); emptying
  `NATIVE_QUIET_BACKOFF_QUALIFIED_PLATFORMS` removes client backoff, and
  emptying `NATIVE_QUIET_BACKOFF_CONTENT_REVISION_PLATFORMS` does not (it only
  adds a condition). See
  [0048-recurring-work-qualification.md](0048-recurring-work-qualification.md) for when
  the switch goes.

## Outstanding work

### Code

1. ~~Give HTTP-bridge groups an idle wakeup.~~ **Done in code (2026-10-23);
   live budget evidence open.** Claude and Codex subscribe through the
   observation stream above and their rows name
   `idleBackoffWakeup: "provider-event-stream"`. Cursor, Pi and Grok bridges
   have no event stream; their groups keep every sweep (see decisions).
   Tests: `http-bridge-observation-stream.test.ts` (observation mode and
   auth headers, live only after a confirmed `connected`, session and gap
   hints, reconnect from the cursor after a bridge restart, Codex expired
   cursor and rewind, an older bridge closed for good, silence watchdog,
   close; only Claude and Codex providers with a hint sink subscribe, and
   dispose aborts it), `native-agent-service-reconciliation.test.ts` ("a
   Claude group backs off only while its bridge observation stream is live";
   the no-touch test now allows only the observe-mode stream besides the
   activity routes; the unqualified case uses Cursor;
   `native-agent-service-activity-batch.test.ts` counts the stream apart from
   the activity requests it asserts),
   `bridges/claude-bridge/src/routes/events.test.ts` and
   `bridges/codex-bridge/src/sse-replay.test.ts` (content-free frames,
   replayed ones included; Codex observers are notified while replay
   retention has lapsed). Live, 2026-10-23 (see "Live check (2026-10-23)"):
   a stably idle Claude group skipped 38 of 75 sweeps and a Codex group 33 of
   75, and a turn started from outside the view with every frame naming the
   environment dropped was still seen within 53 ms (Claude) and 6 ms (Codex).
   Still owed: a bridge restart while the group is backed off, and the
   container case (an older bridge image must keep every sweep). The wakeup lives in
   `HttpBridgeObservationWakeup`; `listResumableSessions` moved to
   `http-bridge-resumable-sessions.ts` to keep `http-bridge-provider.ts` under
   the 1,500-line provider module limit. The live spec now records
   `backendGroupReads` and `backendGroupSkips` (deltas of the
   `native-activity-sweep` cache misses and hits) in its idle case for that.
2. ~~Announce what Claude and Codex currently change silently.~~ **Done in
   code (2026-10-23); live evidence open.** Content revisions and content
   announcements as above; Claude and Codex are in
   `NATIVE_QUIET_BACKOFF_QUALIFIED_PLATFORMS`, gated per session on
   `turn.quietObservation`. Tests: `native-agent-service-reconciliation.test.ts`
   ("announces a content change of an idle session in the transition stamp
   sequence": not on a first observation, not when unchanged, not while
   running, yes while idle or released, the flag follows the revision),
   `session-activity.test.ts` (Claude revision moves for a background-task
   snapshot and a transcript change only, and reading touches nothing),
   `app-server-runtime-lifecycle.test.ts` (Codex revision moves for an async
   question, `messageRevision` and `contentEpoch`),
   `packages/protocol/src/session-activity-batch.test.ts`,
   `packages/protocol/src/native-agent-observation.test.ts`,
   `native-session-read-policy.test.ts` and
   `useNativeAgentSession.observation.test.tsx` (Claude keeps 1.5 s without
   the flag; with it, it backs off and a `reason: "content"` announcement
   reads at once). Background terminal output on an idle Codex thread is not
   rendered by the bridge at all (its handlers return without an active turn),
   so there is nothing to announce for it; a settled command's late measured
   lines bump `messageRevision` and are covered. Multi Review (2026-10-23)
   found that a Claude turn resuming from a released composer stayed
   `working` throughout, so neither a transition nor a content announcement
   woke a backed-off view; it now announces that readiness edge once
   ("announces a released working turn resuming once", and "a released Claude
   view at maximum backoff reads a resumed working turn immediately"; the
   backend test fails without the fix). Live, 2026-10-23: idle Claude views
   reached the 15 s step (12 reads a minute, against 120.5 on 2026-10-21) and
   Codex views 27 a minute (against 126.8). Still owed: the Claude background
   case still fails its fresh-output assertion, exactly as it did before this
   change on 2026-10-21 (the task card appeared in 298 ms, but the marker
   never reached a fresh tool result); Codex ran the background command in the
   foreground; no live async question was exercised.
3. ~~Share native reads across hook instances.~~ **Done (2026-10-23), by a
   different route than written.** The coordinated read is keyed by session
   and identical requests are joined per round; each view keeps its own fenced
   state instead of moving it into a shared store (see decisions). Tests:
   `native-session-shared-reads.test.ts` (joins regardless of key order, never
   across rounds, only active views of the session, failure only when every
   view failed) and `useNativeAgentSession.observation.test.tsx` ("two mounted
   views of one session share one read per coordinated round"; it fails with
   joining disabled, 4 reads instead of 3). The existing hook, tab and
   progressive suites pass unchanged.
4. ~~If HTTP groups ever back off, represent mail presence explicitly as
   stale or unknown.~~ **Done (2026-10-23).** Presence says `unknown` for a
   retained idle the injection gate would not trust, which also covers the
   OpenCode groups that already backed off. Tests:
   `native-agent-service-reconciliation.test.ts` ("mail injection trusts only
   a fresh, post-dispatch idle" now checks presence `idle` then `unknown` past
   the lease; the refusal and busy-refusal cases show presence `unknown` after
   a refused dispatch until the next sweep) and `agent-mail-service.test.ts`
   ("an idle presence going stale and fresh again keeps a held injection
   deferred"). Behaviour change: a deferred mail retry now waits for a
   post-dispatch sweep (at most 2 s) instead of trusting the pre-dispatch idle.
5. **Partly done (2026-10-23); live attribution open.** Traced every
   `native-agent-session` emitter. Fixed the two that repeat for an idle
   session in code: a renewal that misses its 2 s deadline announced the
   `stale` flip and then the `ready` flip of the same value (two hints per
   slow section per 30 s; the `models` section runs a full catalogue fan-out
   and is the likeliest to be slow), and the runtime section's `unknownEvents`
   counter, which grows whenever the OpenCode stream sends an event kind the
   backend has no branch for. Also made the expired model-catalogue comparison
   order-insensitive. Tests: `native-agent-service-progressive.test.ts` ("does
   not announce a renewal whose only change is the runtime drift counter"; the
   timeout test now expects no announcement for a cached value that only went
   stale). Not changed: the expired environment catalogue refresh still
   announces environment-wide when any platform's models change, and
   progressive hydration announces without comparing (once per new OpenCode
   source token, only for an incomplete transcript). Still owed: rerun the
   idle OpenCode case and confirm reads per minute fall to Cursor's 12; if not,
   attribute the remaining hints by tagging the callers at
   `native-agent-transcript-projection.ts` (hydration, the discovery deadline and
   success, the catalogue refresh).

### Qualification

The live run of 2026-10-21 is recorded below. What it left open, plus what the
2026-10-23 code changes need:

- Claude and Codex, after the 2026-10-23 live check below: the background
  case (Claude's fresh tool-result output assertion fails, as before this
  change; Codex never backgrounded), a live async question on Codex, a bridge
  restart while the group is backed off (the next turn must be seen within the
  3 s completion budget), the remaining cases (approval, sub-agents,
  reconnect, hidden, no-renderer) at the new cadence, and Codex's idle gaps
  under 12 s (27 reads a minute against Claude's 12: something still
  invalidates an idle Codex view, the same symptom as OpenCode in code item
  5).
- Grok and Pi: re-run `e2e/agent-testing/idle-observation-live.spec.ts`
  once their host logins are current. Both were signed out (expired host
  logins) and were skipped.
- Cases the models did not exercise: Codex sub-agents (no sub-agent tool call;
  the separate live sub-agent card run is in
  [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md)),
  and background shells on Codex, Cursor and OpenCode (each ran the command in
  the foreground). Cursor's approval case ran under an `approvals: "ask"`
  policy and still ran the command without asking, which is the documented
  Cursor mapping (it reports `ask` as the auto-approval it runs).
- Completion with no renderer was observed for a local environment only; a
  container environment was not part of this run. Re-run with the corrected
  exact-prompt assertion to qualify missing/duplicate prompt protection. A
  container environment also runs the bridge from its image: an image built
  before this change answers without `contentRevision` and ignores
  `?observe=1`, which must leave that session at the baseline cadence on both
  sides.
- Re-run the background-shell indicator/output and detach cases with the
  corrected assertions. The original background checks could match the user
  prompt, and the detach case recorded cadence and session continuity without
  requiring detachment. Neither is qualification evidence for those behaviors.
  Shortened detach waits are cadence-only (`not-exercised`); a full wait must
  observe `detached` before dispatch and `attached` afterwards through no-touch
  runtime discovery. Providers without session detach telemetry on that route
  are also `not-exercised`, pending an observable lifecycle. The observation
  stream must not keep a Claude or Codex session attached: it touches no
  session, but the full detach wait is the evidence.

## Live check (2026-10-23)

A bounded run after the code changes and the Multi Review fix, at
`92dc36b6` plus the flake renumbering, on macOS 27.0 (Apple Silicon), Bun
1.4.3. Bridges rebuilt first (`mise run build:claude-bridge`,
`mise run build:codex-bridge`). Disposable profile `idleqa-0049`:
`mise run dev:test --profile idleqa-0049 --fixture --credential-source claude
--credential-source codex --agent-platforms claude,codex` (Codex gets an
`auth.json` snapshot without a refresh token, so the host login cannot
rotate). Run `idleqa-0049-live`, one provider at a time:

```bash
ORKESTRATOR_AGENT_TEST_PROFILE=idleqa-0049 ORKESTRATOR_AGENT_TEST_RUN_ID=idleqa-0049-live \
  ORKESTRATOR_AGENT_TEST_LIVE_IDLE_OBSERVATION=1 ORKESTRATOR_AGENT_TEST_IDLE_PLATFORMS=claude,codex \
  ORKESTRATOR_AGENT_TEST_IDLE_CASES=missed-final,background,detach \
  ORKESTRATOR_AGENT_TEST_IDLE_DETACH_WAIT_MS=150000 \
  bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts \
  e2e/agent-testing/idle-observation-live.spec.ts --workers=1
```

8.8 min; exit 1 (Claude's background case failed; the global teardown also
refused a trace over the 16 MiB sanitizer bound, as on 2026-10-21, so no trace
was kept).

| Case | Claude | Codex |
| --- | --- | --- |
| Missed final event (every frame naming the environment dropped) | passed: idle max gap 15.0 s before the turn, page 53 ms behind backend truth, sidebar 60 ms | passed: idle max gap 15.0 s, page 6 ms, sidebar 8 ms |
| Background shell | failed: task card 298 ms after the reply, but fresh tool-result output never contained the marker (same failure as `qa-browser-88278b44-d08` before this change); sidebar 5.1 s behind on the follow-up | not exercised: no running background task appeared |
| Idle 150 s (cadence only) | 12 reads a minute, gaps 16 under 250 ms (joined request bursts) and 7 at 12 s or more; backend group 37 reads, 38 skipped sweeps | 27 reads a minute, gaps 36 under 250 ms, 5 of 0.25 to 2 s, 6 of 2 to 6 s, 2 of 6 to 12 s, 4 at 12 s or more; backend group 42 reads, 33 skipped |

Reads per minute count each coordinated read once (its transcript, state and
discovery requests arrive together, hence the sub-250 ms gaps). Backend
counters are profile-wide deltas of `native-activity-sweep` cache hits and
misses; only one environment existed at a time. The profile was stopped and
reset (`mise run dev:stop --profile idleqa-0049`,
`mise run dev:reset --profile idleqa-0049`).

## Live qualification record (2026-10-21)

Run on macOS 27.0 (Apple Silicon), Bun 1.4.2, at `9b3f53a2` plus this change,
in the disposable profile `idleqa-faa8` with the pins in
[0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md)
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
  never starts a bridge, attaches, hydrates or refreshes liveness. The
  observation stream (`/event/subscribe?observe=1`) is the one other bridge
  route the observer uses; it touches no session and is opened only for a
  provider the sweep already reads.
- Idle is never served from cache for dispatch, and a pre-dispatch idle can
  never advance a pipeline or drain another prompt. Dispatch and generation
  fences stay.
- A failed observation evicts a provider without disposing it; the replaced
  provider is retired only after its dispatches settle plus a grace period.
  Retiring it also closes its observation stream.
- Budgets (p95): pending approval visible within 2 s on an active view,
  background activity indicator within 4 s, turn completion or queued
  dispatch within 3 s. The backend's 4 s safety read keeps a lost event inside
  the activity budget. Source:
  [recurring-work.md](../../architecture/recurring-work.md#latency-budgets).
- Responsive phases (running, blocked, cancelling, recovering) never back off
  on the client.
- A provider whose events stay incomplete keeps its fallback reads. Do not
  claim universal event-driven support.
- An older backend without stamped announcements keeps the baseline cadence,
  and so does an older bridge without content revisions or observation mode.

## Open questions

All three questions from 2026-10-21 were decided on 2026-10-23; see
Assumptions and decisions (D6, D7, D8). Nothing is open beyond the
qualification above.

## Assumptions and decisions

**D1. How HTTP-bridge groups get an idle wakeup (code item 1).**
Options: (a) subscribe to the existing full `/event/subscribe` stream;
(b) add a content-free observation mode to the Claude and Codex streams and
subscribe to that; (c) add event streams to Cursor, Pi and Grok bridges too;
(d) keep polling and only lengthen the safety read. Chosen: (b). Why: the full
stream sends every `message.updated` payload (multi-megabyte rows during long
turns) and keeps the bridge's replay ring serializing for a subscriber that
only needs session ids; a frame over the 8 MiB decoder bound would also loop
reconnects. Pros: one tiny frame per event, no ring retention, no payload in
the backend, and the same cursor and gap semantics. Cons: needs bridge
changes, so a container image built before this change cannot qualify (it is
detected through the missing `observe: true` and keeps every sweep); one more
long-lived connection per Claude or Codex bridge. (c) was rejected for now: see
D6. (d) was rejected: without a wakeup a longer safety read is a longer
discovery delay.

**D2. What a stream frame does.** Options: apply events as activity, or treat
every frame as a hint that makes the group due. Chosen: hints only, and every
connect, gap and disconnect hints the whole group. Why: invariant 3 (events
over authoritative snapshots), and the Codex cursor has no generation, so a
restarted bridge can accept a stale cursor; waking the group on every connect
makes that safe. Pros: correctness never depends on the stream. Cons: a woken
group costs one read even when nothing changed.

**D3. How Claude and Codex announce silent changes (code item 2).**
Options: (a) derive announcements from stream frames; (b) report a content
revision on the no-touch activity read and compare it across sweeps; (c) a new
resource-change hint per bridge event. Chosen: (b), announced as a stamped
`reason: "content"` announcement on the existing activity channel. Why: the
sweep stays the authority, a lost frame is caught by the next safety read,
the stamp sequence keeps gap detection, and the only client consumer
(`native-observation-events.ts`) already treats an announcement as a
session-scoped invalidation. Pros: works with or without the stream; one
announcement per sweep at most per session; no new channel. Cons: content
changes on a backed-off group are seen at the safety read (about 4 to 6 s)
unless the stream wakes it first; a running turn's changes are deliberately
not announced. (a) was rejected because hints from a stream are not
authoritative; (c) because `native-agent-session` hints are environment-wide
for older clients and already the main source of backoff resets.

**D4. Gating Claude and Codex client backoff.** Options: (a) add them to the
static qualified list only; (b) also require a backend-set per-session flag
(`turn.quietObservation`). Chosen: (b). Why: a container may run a bridge
older than the backend, which reports no content revision; with (a) its idle
view would back off and miss background output. Pros: an older bridge, an
older backend and the first seconds after a backend restart all keep the
baseline. Cons: one more field in the turn state; the state token changes once
when the flag first appears.

**D5. Sharing reads across hook instances (code item 3).** Options: (a) as
written, move the sequence, epoch and conditional tokens into a shared store
keyed by connection, session and view window; (b) key the coordinated read by
session and join identical requests within one coordinated read. Chosen: (b).
Why: (a) rewrites the fencing of a 3,500-line hook whose recovery paths
(epoch rotation, store eviction, history paging) are each guarded by tests,
for a case (two views of one session) that is uncommon. (b) gets one schedule
per session and one backend request per round whenever the views' tokens
agree, which they do after the first shared answer. Pros: no change to any
view's fenced state; every existing hook test passes unchanged; joins can
never serve an answer older than the round. Cons: two views with different
tokens (one just mounted) still send two requests for one round; per-view
reads are not deduplicated outside coordinated reads.

**D6. Cursor, Pi and Grok backend wakeups (open question).** Options: add an
event stream to each bridge, or keep every sweep. Chosen: keep every sweep.
Why: none of the three bridges has an event stream, their idle views already
back off on the client, and the backend's batched `POST /sessions/activity`
read is one request per group per sweep. Pros: no new bridge surface on three
bridges. Cons: those groups still cost one batched read every 2 s while idle.
Revisit if the 0048 busy-profile measurement shows those reads matter.

**D7. The lost-announcement bound (open question).** Options: accept that a
backed-off idle view can take up to the 15 s step when an announcement is
silently lost, or skip backoff for a view that saw a recent dispatch. Chosen:
accept. Why: the real transport cannot lose a frame silently (gateway replay
cursors, a stamp gap re-reads every view); the 9.7 to 10.9 s measurements came
from a page-side seam that drops frames after delivery. A view that dispatched
is running, which never backs off; the case only arises for a turn started
elsewhere. Pros: no extra reads. Cons: a real silent loss, if one were found,
would show as up to 15 s of staleness.

**D8. The B08 interaction observer (open question).** Options: retire it, fold
it into the broker, or leave it. Chosen: leave it unchanged. Why: it is off by
default (`observe-only` only behind an environment variable) and is a
diagnostic for the interaction contract work in
[0001-agent-interactions-and-permissions.md](../agent-engines/0001-agent-interactions-and-permissions.md);
folding it into the broker would put a pending-interaction read on the sweep,
and for Claude and Pi that read touches liveness. Pros: no risk to the sweep's
no-touch contract. Cons: one more opt-in job stays in the inventory. Retiring
it belongs to that interaction work, not here.

**D9. Mail presence for a stale idle (code item 4).** Options: a new
`stale` presence value, or `unknown`. Chosen: `unknown`. Why: `unknown`
already means "read the provider before injecting" at the gate and in the
drain, and a new value would change the mail protocol for every consumer.
Pros: no protocol change; the gate is unchanged. Cons: presence can flip
between `idle` and `unknown` for a backed-off group, so those flips are
excluded from resetting the inject backoff; a deferred retry waits for a
post-dispatch sweep.

**D10. Which OpenCode hint sources to fix (code item 5).** Options: fix every
emitter that does not compare, or fix the ones that can repeat for an idle
session and leave the rest. Chosen: the latter. The discovery deadline flip
and the drift counter repeat every 30 s; the order-insensitive catalogue
comparison is cheap insurance. Left as they are: the environment-wide
catalogue announcement (it fires only when some platform's models really
changed) and the hydration announcement (once per new source token, and only
for incomplete transcripts). Assumption: no live run was possible here, so
which source dominated the 2026-10-21 OpenCode measurement is inferred from
the code, not observed.

**D11. The released-turn wakeup (Multi Review P1).** Options: announce the
readiness edge when a released composer is taken back, or let a released
Claude session never back off. Chosen: announce the edge once, as a content
invalidation. Why: background work keeps aggregate activity `working` while
the composer is free, so the root turn resuming is neither a transition nor
(without a revision change) a content change, and a view at the 15 s step
would miss a running turn. Pros: the view returns to 500 ms immediately; one
announcement per resume. Cons: one more announcement kind riding the content
channel. Applied by the Fix session (`690377e2`) and verified here.

**Assumptions.**

- Both bridges serialize `sessionId` first in every frame
  (`serializeEventData`, `serializeSseEventData`); the observer reads only a
  bounded prefix and hints the whole group for anything else.
- Claude's transcript markers cover every change to `session.messages`
  (the existing `transcriptVersionRepairsForTesting` guard), and
  `session.backgroundTasks` changes are published only through the two emit
  helpers that now count them.
- Two views of one session in one renderer always talk to the same backend
  (the read key is per environment, and an environment belongs to one
  backend).
- No live provider, container or second machine was used for this change.
  Everything marked "live evidence open" above is unmeasured.

## Related

- [0052-remote-client-bandwidth.md](0052-remote-client-bandwidth.md): client-side
  bandwidth and the data-saving preference.
- [0051-client-reconnect-and-freshness.md](0051-client-reconnect-and-freshness.md):
  disconnect signals for the read coordinator.
- [0048-recurring-work-qualification.md](0048-recurring-work-qualification.md): live
  evidence against the budgets and rollback-switch removal.
- [0001-agent-interactions-and-permissions.md](../agent-engines/0001-agent-interactions-and-permissions.md):
  interaction contract gaps per provider.
- `../architecture/event-snapshot-recovery.md` ("Native observation
  invalidations") and `../architecture/recurring-work.md` (inventory rows
  C01, B06 to B10 and B23, the observation broker and the read coordinator).
  The step label on the event-snapshot section was dropped and the capability
  matrix now has a table in `../architecture/agent-engines.md` ("Activity
  observation"), as the 2026-10-21 drift notes asked.

## Replaces

- `docs/improvements/recurring-processes/plan/07-agent-observation-and-activity.md`
  (deferrals: HTTP-bridge wakeup, Claude and Codex qualification,
  cross-instance sharing, live providers, B08)
- `docs/improvements/recurring-processes/plan/06-client-read-coordination.md`
  (task 8, Claude and Codex gating)
- `docs/imrovements/recurring-processes.md` (findings F05 and F06; inventory
  rows C01 and B06 to B10 moved to `../architecture/recurring-work.md`)
