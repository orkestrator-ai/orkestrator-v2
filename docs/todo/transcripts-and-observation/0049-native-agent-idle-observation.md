# Native agent idle observation

Checked against `main` at `06297124` (2026-10-23). The 2026-10-21 live record
below was taken at `9b3f53a2`, before the 2026-10-23 code changes.

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`. Task 4 rechecked 2026-11-03 against `main` at `7b48c23f`: nothing between those commits changed the idle observation path, so its problem still held. Tasks 1, 2, 9 and 10 worked 2026-11-06 against `main` at `c1724ab74`, live with loopback fake models (see "Live check (2026-11-06, loopback models)"). Tasks 3, 4, 5, 7 (Pi) and 8 worked 2026-11-06 against `main` at `ee2cc8423`, also live with loopback fake models only (see "Second live check (2026-11-06, loopback models)"). Task 6 worked 2026-11-10 against `main` at `c98b20e6f`, live with OpenCode on a loopback model through a custom provider (see "OpenCode live check (2026-11-10, loopback model)").

### Tasks

1. **Bridge restart while backed off**: Claude and Codex; the next turn must be seen within the 3 s completion budget. Status: done (2026-11-06, both providers, loopback models).
2. **Claude background-task output**: the background case still fails its fresh tool-result assertion. Status: done (2026-11-06: a spec expectation; the output is in the finished task's output file, which the case now reads).
3. **Codex live async question and background shell**: neither has been exercised live. Status: done (2026-11-06, loopback model: the async question reached a backed-off view in 13 ms and its answer settled; the backgrounded command's card stayed "running..." for good, moved to 7522 and fixed on 2026-11-10: it now reads "left running").
4. **Codex short idle gaps**: 27 reads a minute against Claude's 12; find what still invalidates an idle Codex view. Status: done (2026-11-06, loopback models: the live per-cause counts are Claude none and Codex `discovery-renewal` 6 in 300 s; naming the section and stopping it moved to 7530, closed 2026-11-10: the MCP section's tool order moved; a rerun read 0 invalidations and 8.4 reads a minute, see [native-transcripts.md](../../architecture/native-transcripts.md#one-request-per-round)).
5. **Remaining Claude and Codex cases at the new cadence**: approval, sub-agents, reconnect, hidden and no-renderer. Status: done (2026-11-06, both providers, loopback models; all passed).
6. **OpenCode hint rerun (code item 5)**: confirm idle OpenCode falls to 12 reads a minute, or attribute the remaining hints. Status: done (2026-11-10, loopback model through a custom OpenCode provider: an idle OpenCode view read 8 times a minute over 300 s with no invalidation of any cause, so nothing is left to attribute).
7. **Pi rerun**: Pi was skipped as signed out on 2026-10-21. Status: done (Pi ran 2026-11-06 on a loopback model: every case settled, and the full detach wait found an open idle tab keeps Pi attached, moved to 7540, closed 2026-11-10: the full 630 s wait now passes, see `bridges/pi-bridge/AGENTS.md`). The Grok rerun needs a Grok login (no loopback model reaches it) and moved to 7568 on 2026-11-10.
8. **Unexercised cases**: Codex sub-agents, and background shells on Codex and OpenCode. Status: partly done (2026-11-06, loopback model: Codex sub-agents passed and Codex's background shell ran, see task 3); OpenCode open (2026-11-10, loopback model: the case ran, but the scripted model reuses Pi's script, which has no background call, so the command ran in the foreground; it needs a scripted background call, if OpenCode 1.19.5's `bash` offers one). The Cursor background shell needs a Cursor login (no loopback model reaches it) and moved to 7568 on 2026-11-10.
9. **Container environment**: no-renderer completion in a container, and an older bridge image staying at the baseline cadence on both sides. Status: partly done (2026-11-06: a current-image container's stream is live and its idle group backs off; turns after the first are blocked on this host by [7080](../containers-and-environments/7080-linux-host-firewall-blocks-profile-signals.md); no older image exists here).
10. **Full detach wait**: observe `detached` before and `attached` after through no-touch runtime discovery. Status: done for Claude (2026-11-06); Codex open in [7380](7380-codex-idle-detach-observation.md).

All five code items match HEAD. The only later changes in this area are refactors (#1180, #1284) and #1298's stopped-runtime fencing in `native-agent-launch-activity-reconciler.ts`; no behaviour described here moved. 0048 hands its live-provider task to this file. Live cases run between the 2026-10-24 marker change and the 2026-10-28 probe fix (to-do 0199, retired 2026-11-10; see [agent-testing.md](../../development/agent-testing.md#manual-browser-qa)) are blind on the sidebar, because the probe read `unknown`. The 2026-10-23 sidebar timings predate that change and are valid. The fixed probe reads the marker's `data-state`; the 2026-10-28 review qualification below confirms real working/idle transitions and missed-final recovery on Claude and Codex. Other outstanding live cases remain open.

### Sidebar-probe qualification, 2026-10-28

Run IDs `idleqa-0199-review-claude` and `idleqa-0199-review-codex` used
disposable profile `idleqa-0199-review`, local worktrees, one provider at a
time and `ORKESTRATOR_AGENT_TEST_IDLE_CASES=missed-final`. Both specs passed.
Each warm-up ran a harmless five-second shell sleep so the sidebar activity
sweep could observe working. Both `warmup.sidebarStates` arrays were exactly
`["working", "idle"]`, with no unknown readings. The suite now asserts this
positive evidence before fault injection. Profile cleanup completed after
the runs.

| Measurement | Claude (default model) | Codex (`gpt-6.1-sol`) |
| --- | --- | --- |
| Warm-up UI / sidebar lag | 3,819 / 3,880 ms | 670 / 1,311 ms |
| Idle reads during 35 s pre-turn wait / largest gap | 24 / 9,969 ms | 36 / 10,000 ms |
| Missed-final UI / sidebar lag | 1,952 / 1,529 ms | 9,711 / 102 ms |
| Frames naming the environment dropped | 9 | 16 |
| Follow-up UI / sidebar lag | 2,491 / 3,450 ms | 470 / 491 ms |

Codex's missed-final UI lag was above the normal 3 s p95 target and within
the 17.5 s lost-announcement bound. Claude's warm-up UI lag was also above
the normal target. These are individual samples, not p95 estimates. The runs
qualify sidebar transitions and missed-final recovery; they do not qualify
the other outstanding scenarios listed above. Evidence lives in
`output/agent-testing/<run-id>/idle-observation-live/<provider>.json`.

### 1. Bridge restart while backed off

**Problem.** Claude and Codex groups back off behind their bridges' observation streams, which are on by default. If a bridge restart left the stream down without un-backing the group, a turn started afterwards could look stale past the budget.

**Context.** Code item 1's "still owed". The design says every disconnect and every connect hints the whole group, and that a stream which does not confirm `observe: true` is closed for good.

**Investigation.** The wakeup is `HttpBridgeObservationWakeup` (`apps/backend/src/core/http-bridge/observation-stream.ts:253`); the stream opens `/event/subscribe?observe=1` (`:144`), confirms `"observe":true` (`:177`), and has a 75 s silence watchdog (`:54`). The backoff gate reads `idleBackoffWakeup === "provider-event-stream"` (`native-agent-launch-activity-reconciler.ts:986`), with one 4 s safety step (`STABLE_IDLE_BACKOFF_MS`, `native-agent-observation.ts:83`). The deterministic test covers reconnecting from the cursor after a restart. The live spec has no restart case (cases at `e2e/agent-testing/idle-observation-live.spec.ts:906`-`:1378`). The backend already exposes `stop_local_claude_server_cmd`, `stop_local_codex_server_cmd` and their `start_` pairs, and `design-resume-clients-live.spec.ts:219` uses the Codex pair.

**Decisions.**

- **How to restart the bridge in the live run?**
  - **Add a `bridge-restart` case to `idle-observation-live.spec.ts` using the `stop_local_*_server_cmd`/`start_local_*_server_cmd` pairs, after the group has reached backoff (recommended).**
    - Pros: a real process restart; reuses commands already proved by the design spec; records `backendGroupReads` and `backendGroupSkips` around it.
    - Cons: a new case to maintain; local environments only.
  - **Kill the bridge process by its recorded PID.**
    - Pros: closer to a crash than a clean stop.
    - Cons: needs PID identity checks (AGENTS.md's production-host rules); more fragile.
- **What counts as a pass?**
  - **A turn started from outside the view after the restart is seen within 3 s p95, and the group shows a read on the reconnect (recommended).**
    - Pros: matches the completion budget and the "connect hints the group" design.
    - Cons: one sample per provider per run; repeat it to get a p95.
  - **The group stops skipping sweeps until the stream is confirmed again.**
    - Pros: directly checks the mechanism.
    - Cons: says nothing about what the user sees.

**Outcome (2026-11-06).** Done as recommended: the `bridge-restart` case in
`idle-observation-live.spec.ts` waits until the backend skips the idle
group's sweeps, stops and starts the local bridge
(`stop_local_*_server_cmd`/`start_local_*_server_cmd`), waits 30 s, counts the
group's sweeps, then dispatches a turn from outside the view. It passed for
both providers against loopback models: the group was read again after the
restart (9 of 15 sweeps), skipped again (Claude 6, Codex 5, so the stream came
back), the page showed the turn 67 ms (Claude) and 114 ms (Codex) after
backend truth, and the group backed off again about 12 s after the turn. One
sample per provider, not a p95. No defect found.

### 2. Claude background-task output

**Problem.** The background case fails for Claude on 2026-10-21 and 2026-10-23: a running task card appears within 300 ms, but no fresh tool result contains the marker. Until it is explained, background activity on Claude is unqualified.

**Context.** The assertion was tightened in review on 2026-10-21 so that the user's prompt cannot count as output.

**Investigation.** The assertion accepts only `tool-invocation` parts' `toolOutput`, or a fetched `detailRef` (`freshToolResults`, `e2e/agent-testing/idle-observation-live-support.ts:123`, used at `idle-observation-live.spec.ts:588` and asserted at `:1206`-`:1211`). Claude does not put a background shell's stdout into a tool result. Its task notification carries `summary` and `output_file` (`bridges/claude-bridge/src/services/session-manager-prompt-handlers/system-tasks.ts:42`, `:241`, `:242`), and the renderer shows the output as a file link on the task card (`BackgroundTaskOutputFile`, `apps/web/src/components/chat/NativeMessage.agent-parts.tsx:902`). So the marker reaches a tool result only if the model chooses to read the output file. The failure is most likely the spec asking for something Claude never produces, not a stale view. The `contentRevision` for Claude does include a background-task snapshot count (`bridges/claude-bridge/src/routes/session-activity.ts:46`-`:55`), so a task status change is announced.

**Decisions.**

- **How to fix the case?**
  - **Accept, per provider, the evidence the provider really emits: for Claude, the task reaching `completed` with an `outputFile`, then fetch that file through the existing output-file read and require the marker (recommended).**
    - Pros: proves the output exists and reached the view without depending on the model's choice; keeps the prompt excluded.
    - Cons: provider-specific branches in the spec; the file read must stay content-free in artifacts (check the marker, never record the text).
  - **Prompt the model to read the output when the task finishes.**
    - Pros: no spec branching.
    - Cons: depends on model behaviour, the same weakness that leaves other cases unexercised.
  - **Downgrade the Claude assertion to the task card and status only.**
    - Pros: passes today.
    - Cons: no longer proves the output arrived, which is the point of the check.

**Outcome (2026-11-06).** Done as recommended. The investigation's reading is
confirmed by the bridge itself (`recordShellResult` in
`session-manager-background-tasks.ts`: a backgrounded call's result only says
the command moved to the background; its output is in the task's output
file). The case now accepts a fresh tool result or, failing that, a completed
task started by the case whose output file has the marker on a line of its own
(`completedTaskOutputFiles`, `backgroundOutputEvidence` in
`idle-observation-live-support.ts`). No backend command reads the file, so
the spec reads it on the host (or with `docker exec` in a container) and
records only which evidence matched. Live with the Claude loopback model it
passed twice: the running-task indicator 17 and 57 ms after the task started,
the page 275 and 34 ms behind backend truth, the sidebar idle with the last
busy read, and the evidence `output-file` both times; no tool result carried
the marker. Codex, whose scripted turn runs the command in the foreground,
recorded `not-exercised`.

### 3. Codex live async question and background shell

**Problem.** The Codex `contentRevision` includes the async-question count, but no live run has shown that a question asked on an idle thread wakes a backed-off view.

**Context.** Code item 2's "still owed". On 2026-10-23 Codex ran the background command in the foreground. Background terminal output on an idle Codex thread is not rendered by the bridge at all, so only a settled command's late lines matter.

**Investigation.** The revision string is built at `bridges/codex-bridge/src/app-server-runtime-sessions.ts:1433` (`contentEpoch`, `messageRevision`, `asyncQuestionItemIds.length`). The spec has no async-question case. The background case uses a generic "start as a background task" prompt (`idle-observation-live.spec.ts:1150`), which Codex need not honour.

**Decisions.**

- **How to get an async question live?**
  - **Add a case that asks Codex to use its question tool with a fixed choice, answered from the page (recommended).**
    - Pros: a direct test of the async-question revision bump; the paused-interactions specs show the pattern.
    - Cons: depends on the model calling the tool; may need a retry budget.
  - **Prove it only with the deterministic lifecycle test (`app-server-runtime-lifecycle.test.ts`).**
    - Pros: no live dependency.
    - Cons: leaves the end-to-end wakeup unproved.
- **Keep the Codex background-shell case?**
  - **Keep it as "not exercised" when Codex runs in the foreground, and do not count it against the file (recommended).**
    - Pros: honest; Codex renders no idle background output to announce.
    - Cons: the case may never produce evidence for Codex.
  - **Retire it for Codex.**
    - Pros: less noise in records.
    - Cons: misses a future Codex release that does background commands.

**Outcome (2026-11-06, loopback model).** Done as recommended, with Codex's
real async question rather than its blocking one. Pinned Codex 0.166.0
offers `request_user_input_async` (namespace `functions`) to an Orkestrator
session; it returns `{"accepted":true}` at once, and the question becomes an
`agentMessage` with `delivery: "async"`, which the bridge renders as an
`async-question` part and counts in `contentRevision`. The new
`async-question` case (Codex only) waits 35 s until the view and its group
have backed off (the group skipped 6 sweeps; the largest read gap 10.0 s),
dispatches the question from outside the view, then answers it from the
card ("Codex has a question", option `IDLEQA_BETA`, Send answer). The
backend first read the question with the session already idle; the card
showed 13 ms after that read, the reply 16 ms and the sidebar 19 ms behind
backend truth. The answer came back as a new turn settled 10 ms (sidebar
13 ms) behind, and the card said "Your answer was sent to Codex."; a
`native-agent-async-question` frame named the environment. While asked, the
backend's invalidations were `projection-read` 3, `discovery-renewal` 2 and
`record-dispatch` 1. The background shell ran for real: the scripted model
started `sleep 20; echo <marker>` through `exec_command` with a 1 s yield, so
it was still running when the turn ended. Codex has no background-task
surface, so the case is recorded `not-exercised` as recommended, but it
found a defect: the command's card stayed `pending` ("running...") after the
command had exited, because Codex sends no event for it once the turn is
over (7522; fixed on 2026-11-10, when the card settles as "left running" once
the turn ends, see `bridges/codex-bridge/AGENTS.md`).

### 4. Codex short idle gaps

**Problem.** An idle Codex view made 27 reads a minute on 2026-10-23 against Claude's 12, with gaps under 12 s. Something still invalidates it, which costs reads on every idle Codex tab.

**Context.** The same symptom as OpenCode in code item 5.

**Investigation.** No attribution exists yet. The likely candidates are the same as item 6: progressive hydration and discovery renewals that announce, or a `messageRevision` bump on idle. Neither has a per-caller tag.

**Decisions.**

- **How to attribute it?**
  - **Add a content-free reason tag to every invalidation the backend emits for a session (hydration, discovery deadline, discovery success, catalogue refresh, content revision) and count tags in the idle case (recommended).**
    - Pros: answers this task and item 6 with one change; stays content-free.
    - Cons: a protocol or metrics addition, though diagnostic only.
  - **Bisect by disabling one source at a time in a profile.**
    - Pros: no permanent code.
    - Cons: several live runs; slow.

**Done (2026-11-03): tagging and counting.** Every session invalidation the
backend emits carries a `cause` from `NATIVE_SESSION_INVALIDATION_CAUSES`
(`packages/protocol/src/native-agent-observation.ts`). There are 25 causes in
three groups. Projection-layer causes: `projection-read`,
`projection-unreachable`, `projection-title`, `projection-withdrawn`,
`hydration`, `discovery-deadline`, `discovery-renewal`,
`model-catalog-refresh`, `model-catalog-load`, `command-catalog`,
`permission-rule` and `transcript-artifact`. Persisted-record causes:
`record-created`, `record-policy`, `record-goal`, `record-controls`,
`record-title`, `record-notice`, `record-invalidated`, `record-removed` and
`record-dispatch`. Activity-channel causes: `transition`, `content-revision`,
`session-content` and `runtime-stopped`.
`announceNativeAgentSessionProjection`, `announceNativeAgentRecord` and
`NativeAgentObservationInvalidation` require the cause, so an untagged site
fails the typecheck. A `native-agent-session` change that still reaches
`StorageChanges.announce` without one is counted as a dropped label.
`NativeSessionInvalidationMetrics` (`apps/backend/src/core/native-session-invalidation-metrics.ts`)
counts emitted invalidations by cause and by platform (`environment` for one
that named no session). Its snapshot is `sessionInvalidations` in
`get_recurring_work_diagnostics` and the `recurringWork` block of the gateway's `/__orkestrator/metrics`. The live spec's idle
(`detach`) case now records `idleInvalidations` and an `idle invalidations by
cause` note for its window.

**Fake idle Codex count (2026-11-03).**
`native-agent-service-idle-invalidations.test.ts` drives a fake Codex session
through the real `NativeAgentService`. The fake has a stable content
revision, transcript token, command catalogue, runtime health and model
catalogue. The test runs a simulated minute: a sweep every 2 s, a quiet read
round (transcript, session state, all four discovery sections) every 15 s,
and one more round after any invalidation.

| Window | Invalidations by cause | View reads |
| --- | --- | --- |
| Opening the tab (warm-up) | `record-created` 1, `record-title` 1, `model-catalog-load` 1, `command-catalog` 1, `discovery-renewal` 4, `transition` 1 | 2 rounds |
| Idle minute, nothing moves | none | 4 scheduled, 0 caused by an invalidation |
| Idle minute, two revision bumps and one runtime value change | `content-revision` 2, `discovery-renewal` 1 | 3 caused by an invalidation |

So the backend's own paths add no reads to a stable idle Codex view, and
discovery expiry with unchanged values announces nothing. The live surplus
(27 a minute, with gaps of 0.25 to 12 s) must come from something that moves
on a real bridge: its content revision (`process`, `contentEpoch`,
`messageRevision`, async-question count), a discovery value, or a renderer-side
read that no backend invalidation causes. The fake cannot tell these apart.
The next live idle run will: the per-cause counts name the source, and a
total far below the read count points at the renderer instead.

**Live per-cause count (2026-11-06, loopback models).** The idle (`detach`)
case ran for 300 s on each provider, after the approval, sub-agent,
background, reconnect, hidden and no-renderer cases on the same session
(cadence only: the shortened wait is `not-exercised` for detachment).

| Idle 300 s | Claude | Codex |
| --- | --- | --- |
| Reads a minute (coordinated reads) | 8.0 | 13.3 |
| Largest gap | 15.0 s | 15.0 s |
| Gaps `<250ms` / `250ms-2s` / `2-6s` / `6-12s` / `>=12s` | 15 / 1 / 1 / 1 / 17 | 26 / 6 / 11 / 6 / 10 |
| Requests (`live_update` / `discovery_update`) | 24 / 17 | 45 / 19 |
| Backend group reads / skipped sweeps | 69 / 81 | 62 / 88 |
| Invalidations by cause | none | `discovery-renewal` 6 |

So the backend's content and transition paths add nothing to either idle
view (no `content-revision`, no `transition`), and both groups back off
behind their streams. The whole Codex surplus is six discovery renewals whose
value changed, each resetting the view's backoff to its 3 s step. A probe of
the four discovery sections on a fresh idle Codex session (plain, background,
sub-agent and async-question histories, seven 31 s renewals each) saw no
change, so which section moves is still unknown; that and the fix are
7530 (closed 2026-11-10: the MCP section, its tools listed in a new order on each read). The 2026-10-23 figure (27 a
minute) was taken on a real model and a busier session; this run's lower
figure is one loopback sample.

### 5. Remaining Claude and Codex cases at the new cadence

**Problem.** Approval, sub-agents, reconnect, hidden and no-renderer passed on 2026-10-21 at the old 1,500 ms cadence. Claude and Codex now back off to 15 s, so each case's budget must be shown again.

**Context.** Budgets (p95): approval visible within 2 s, background indicator within 4 s, completion within 3 s (`recurring-work.md`).

**Investigation.** All cases still exist in the spec. The 2026-10-23 run covered only `missed-final`, `background` and `detach`.

**Decisions.**

- **Run order?**
  - **Land 0199 (code landed 2026-10-28), then run every case for Claude and Codex one provider at a time, with tasks 1 to 4 in the same session (recommended).**
    - Pros: one credentialed session; sidebar results are real; one provider at a time avoids stamp-gap recovery masking a lost announcement (the file's own note).
    - Cons: a long run (about 20 minutes per provider).
  - **Run now, without 0199.**
    - Pros: sooner.
    - Cons: every sidebar check is blind; the run has to be repeated.

**Outcome (2026-11-06, loopback models).** Done: every case ran for Claude and
Codex, one provider at a time, at the new cadence. The fakes now script the
two cases that needed a real model: approval (one exact command, which each
CLI parks under its `ask` mode, Claude `default` and Codex `untrusted`) and
sub-agents (Claude's `Agent` tool; Codex's `spawn_agent` then `wait_agent`).
All passed; single samples, not p95 estimates.

| Case (budget) | Claude | Codex |
| --- | --- | --- |
| Approval (card 2 s) | card 6 ms, page 5 ms, sidebar 813 ms after approving | card 48 ms, page 5 ms, sidebar 1,543 ms |
| Sub-agents (completion 3 s) | `Agent` tool, 2 background tasks, none left running; page 282 ms | one `subagent` card, `success`; page 19 ms |
| Reconnect (offline through completion) | 53 ms after online, sidebar 54 ms | 138 ms, sidebar 170 ms |
| Hidden | 0 reads while hidden, 105 ms after visible | 0 reads, 189 ms |
| No renderer | aggregate idle 4 ms after the projection, second client 6.1 s, one exact prompt | 6 ms, 9.3 s, one exact prompt |

The second client's rehydration took 6.1 s and 9.3 s, against 3.1 to 3.9 s
on 2026-10-21. The case has no budget for it (a fresh sign-in and page load
on a headless profile), so it is recorded, not judged.

### 6. OpenCode hint rerun (code item 5)

**Problem.** Idle OpenCode views read 27.9 times a minute on 2026-10-21. Two hint sources were fixed in code, but the rerun that would confirm 12 a minute has not happened.

**Context.** Not changed by design: the environment-wide catalogue announce and progressive hydration announcements. D10 records the choice.

**Investigation.** The fixes are in `storeProgressiveDiscovery` and the `unknownEvents` exclusion. The suggested attribution point is `native-agent-transcript-projection.ts`. Task 4's tag would serve both.

**Decisions.**

- **What if the rerun still exceeds 12 a minute?**
  - **Attribute with task 4's reason tags before changing anything (recommended).**
    - Pros: changes only the source that is measured as noisy.
    - Cons: one more run.
  - **Also suppress hydration announcements for an idle view.**
    - Pros: likely removes most of the remainder.
    - Cons: risks hiding an incomplete transcript's completion, which hydration exists to announce.

**Still open (2026-11-06).** Not run. The rerun needs a model behind
OpenCode, and this change uses loopback models only: the scripted fakes
stand in for Anthropic's Messages API (Claude), OpenAI's Responses WebSocket
(Codex) and an OpenAI chat-completions provider in Pi's `models.json` (Pi).
Pointing OpenCode at one would mean a custom provider in the profile's
OpenCode configuration, served through an AI SDK provider package that
OpenCode loads at run time; no harness for that exists, and building one
was out of this change's scope. The task-4 cause tags are in place, so the
rerun will attribute whatever it finds.

**Outcome (2026-11-10, loopback model).** Done. The harness now reaches
OpenCode: the Pi fake's chat-completions endpoint is added as a custom
provider (`@ai-sdk/openai-compatible`, bundled with OpenCode, so nothing is
downloaded) to the profile's own global `opencode.json`, made the default
and small model and the only enabled provider, and Orkestrator's provider
allowlist admits it for the run (decision D23). The `detach` case's 300 s
idle wait on an idle OpenCode view read **8 times a minute** (41 reads:
24 live updates, 17 discovery updates; gaps 15 under 250 ms, 1 of
0.25 to 2 s, 1 of 2 to 6 s, 1 of 6 to 12 s, 17 of 12 s or more; largest
15.0 s), with **0 invalidations of any cause** and no discovery
announcement; the backend read the group 71 times and skipped 79 sweeps.
That is below the 12 a minute the task asked for and well below the 27.9 of
2026-10-21, so the two code fixes held and the hints this task was to
attribute did not occur. One sample on a loopback model; real-provider
latency is not part of it. Every other case also ran (see "OpenCode live
check (2026-11-10, loopback model)"); no defect found.

### 7. Pi rerun

**Problem.** Pi had no idle-observation evidence at all, yet both have client quiet backoff on by default (`NATIVE_QUIET_BACKOFF_QUALIFIED_PLATFORMS`).

**Context.** Both were `needs-auth` on 2026-10-21. Their bridges have no event stream (`idleBackoffWakeup: null`, `native-agent-observation.ts:204` for Pi and `:219` for Grok), so the backend keeps every sweep (D6).

**Investigation.** Nothing has changed in their observation path since. The pinned Grok and Pi are in `packages/toolchain/src/manifest.ts`.

**Decisions.**

- **How to supply logins?**
  - **Use `dev:test --credential-source grok` for Grok, and copy the Pi login into the disposable profile, as the approved credential practice allows (recommended).**
    - Pros: an established procedure; no real login is written.
    - Cons: needs the host logins current first.
  - **Remove Grok and Pi from the qualified list until they are run.**
    - Pros: no unqualified backoff on by default.
    - Cons: gives up a saving the other four providers show is safe; the backend still sweeps every 2 s, so the 15 s staleness bound already holds.

**Outcome (2026-11-06, loopback model).** Pi ran; Grok did not. Pi got a
scripted loopback model as a provider of its own in the profile's Pi
`models.json` (`idle-observation-fake-pi.ts`, model `idleqa-fake/idleqa-1`;
D21), so no login and no host `~/.pi` was involved, and the session reported
`signed-in`. Every case ran (run `idleqa-0049-r2-pi`); single samples.

- `missed-final` passed: page 13.6 s behind backend truth with every frame
  naming the environment dropped, inside the 17.5 s lost-announcement bound
  and over the 3 s budget, as D7 accepts; sidebar 8 ms. The backend read the
  group on all 17 sweeps (no skips: Pi has no observation stream, D6).
- `approval` passed under an environment policy of approvals `ask` (Pi has
  no ask composer mode): card 9 ms, page 6 ms, sidebar 1,598 ms.
- `reconnect` 127 ms after online; `hidden` 0 reads while hidden and 111 ms
  after visible; `no-renderer` aggregate idle 6 ms after the projection,
  second client 6.2 s, one exact prompt.
- `subagents` and `background` `not-exercised`: Pi has no sub-agent or
  background tool, so it replied, and ran the command in the foreground (its
  output in the tool result).
- `detach` failed. Over the full 630 s wait the view read 7.4 times a minute
  (largest gap 15.0 s, no invalidation), but Pi's no-touch runtime read said
  `attached` before and after: an open, idle Pi tab keeps its session
  attached, because the MCP discovery renewal (`GET /session/:id/mcp`) is
  among the routes that refresh the Pi bridge's idle clock
  (7540, closed 2026-11-10: reads no longer refresh the idle clock, and the
  same 630 s wait passed on 2026-11-10).

The Grok rerun needs a Grok login and no loopback model reaches it; it moved
to [7568](../manual-test/7568-manual-test-checklist.md) on 2026-11-10.

### 8. Unexercised cases

**Problem.** Codex sub-agents and background shells on Codex and OpenCode had never produced evidence, because the models chose not to use the tool.

**Context.** The separate live sub-agent card run is in 0031. Cursor reports `ask` as auto-approval, so its approval case cannot park.

**Investigation.** The prompts are generic (`idle-observation-live.spec.ts:1095`, `:1150`).

**Decisions.**

- **Keep chasing them?**
  - **Record them as "not exercised" and accept that, unless a provider is known to support the tool (recommended).**
    - Pros: stops spending live runs on model choice; honest records.
    - Cons: those paths stay unproved live.
  - **Pin a model per provider known to use the tool (`ORKESTRATOR_AGENT_TEST_IDLE_MODELS`) and retry.**
    - Pros: may produce evidence.
    - Cons: more runs, and the result still depends on the model.

**Outcome (2026-11-06, loopback models).** With scripted models the tool
choice is no longer the model's, so the Codex half is done: sub-agents passed
(task 5) and the background shell really backgrounded its command (task 3,
which found 7522, fixed on 2026-11-10). The
scripted Codex call had to name the tool's namespace: `spawn_agent` and
`wait_agent` live in `collaboration`, and Codex answers a bare name with
"unsupported call". OpenCode stayed open (no fake provider was wired in yet,
task 6). The Cursor half moved to
[7568](../manual-test/7568-manual-test-checklist.md) on 2026-11-10: Cursor's
SDK talks to Cursor's own service, which has no loopback stand-in.

**OpenCode (2026-11-10, loopback model).** OpenCode now runs on the
loopback model (task 6), and its `background` case ran, but it recorded
`not-exercised`: the OpenCode fake reuses Pi's script, which has no
background call, so `sleep …; echo <marker>` ran in the foreground and its
output came back in the tool result. Exercising it needs the fake to send
OpenCode's background form, if its `bash` has one at 1.19.5 (not checked
here). Its `subagents` case was `not-exercised` for the same reason (the
script answers in text; OpenCode's `task` tool was not scripted).

### 9. Container environment

**Problem.** Container environments run the bridge from their image. An image built before 2026-10-23 answers without `contentRevision` and ignores `?observe=1`; that must leave the session at the baseline cadence on both sides. No container run exists.

**Context.** Code item 1 and the Qualification list; 0020 covers container state observation.

**Investigation.** The spec hard-codes `containerId: null` (`idle-observation-live.spec.ts:469`), so it cannot run in a container today. The client gate needs `turn.quietObservation` (`quietObservationFlag`), which an older bridge never sets, so the client side is safe by design.

**Decisions.**

- **How to cover it?**
  - **Add a container variant to the spec, run against the current image and once against an image older than #1182 (recommended).**
    - Pros: proves both the new path and the older-image fallback.
    - Cons: needs Docker, plus an old image kept or rebuilt.
  - **Prove the older-image path with a backend test that uses a fake bridge without observation mode, and run live only on the current image.**
    - Pros: no old image needed.
    - Cons: the older-image case is deterministic only (partly covered already by the "older bridge closed for good" test).

**Outcome (2026-11-06).** The container variant exists
(`ORKESTRATOR_AGENT_TEST_IDLE_ENVIRONMENT=container`, Claude only): it creates
a container environment from the profile's development image, copies the
scripted Claude model into the container and serves it on the container's
loopback (`installContainerFakeClaude`), because a host firewall may refuse the
container's route to the host. One run on beelink, image built from this
checkout:

- The warm-up turn completed: page 3.2 s and sidebar 3.2 s behind backend
  truth (the container model holds each reply 3 s), sidebar `working` then
  `idle`.
- Over `missed-final`'s 35 s idle wait the backend read the group on 10 sweeps
  and skipped 7, so the container bridge's observation stream was confirmed
  live and the group backed off.
- Every turn after the first was refused by the bridge with 409 "Claude
  required MCP server is not connected; retry the prompt", so `missed-final`,
  `background` and `no-renderer` failed before any observation. The required
  server is the injected Orkestrator agent MCP, reached from the container
  through the host's agent-tools port, which beelink's firewall drops for an
  isolated profile ([7080](../containers-and-environments/7080-linux-host-firewall-blocks-profile-signals.md)).
  A first turn launches the CLI without checking it; a later turn joins the
  running CLI and `syncClaudeRuntimeMcp` refuses it. The firewall was not
  changed, as the ticket required.

No image older than #1182 exists on this host (the oldest is 2026-10-29), so
the older-image half ran only as the deterministic tests already listed under
code item 1. Not rerun on 2026-11-06 (second run): the host firewall still
drops the isolated profile's agent-tools port (7080), which the ticket
forbids changing, and there is still no pre-#1182 image. Left: no-renderer completion in a container on a host whose
firewall admits the profile's agent-tools port, and one run against a pre-#1182
image if one can be kept.

### 10. Full detach wait

**Problem.** The observation stream must not keep a Claude or Codex session attached. Only a full detach wait proves it, and the 2026-10-23 run used a shortened, cadence-only wait.

**Context.** Detach happens after 10 minutes idle. The spec's detach case (`:1378`) requires `detached` then `attached` through no-touch runtime discovery.

**Investigation.** No full-wait record exists after the stream was added.

**Decisions.**

- **When to run it?**
  - **In task 5's session, for Claude and Codex, with the default wait (recommended).**
    - Pros: the stream is the new risk, and only these two providers have it.
    - Cons: adds over 10 minutes per provider.
  - **For every provider.**
    - Pros: complete.
    - Cons: Cursor, Pi and Grok have no stream to keep sessions attached, and some lack detach telemetry (`not-exercised`).

**Outcome (2026-11-06).** Neither Claude nor Codex reported attachment on the
no-touch runtime read, so the case could only ever be `not-exercised` for
them. Claude's `/session/:id/runtime-health` now reports `summary.state`
`attached` while the session's CLI is open and `detached` once the idle
window released it (`sessionRuntimeHealthBody`, read from memory only, as
Cursor and Pi do; `runtime-health-body.test.ts`). The case now also requires
`attached` through the same read before the wait starts. Claude, loopback
model, default 630 s wait: `attached` before, `detached` after, `attached`
after the follow-up turn on the same session; 8.1 idle reads a minute, the
largest gap 15.0 s, the backend skipped 174 sweeps and read 142, one
`discovery-renewal` invalidation, and the follow-up showed 18 ms after backend
truth. So the observation stream does not keep an idle Claude CLI attached.
Codex reports its engine's health in that field and detaches a thread only
after 30 minutes without a touch; that half moved to
[7380](7380-codex-idle-detach-observation.md).

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
- Bridge observation stream (`apps/backend/src/core/http-bridge/observation-stream.ts`).
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
- Claude's no-touch runtime read (`/session/:id/runtime-health`) reports
  `summary.state` `attached` while the session's CLI is open and `detached`
  once the idle window released it (2026-11-06, task 10), as Cursor and Pi
  report their SDK sessions. Codex's field is its engine's health (7380).
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
   A bridge restart while the group is backed off passed live for both on
   2026-11-06 (task 1). Still owed: the container case's older image (an
   older bridge image must keep every sweep; task 9). The wakeup lives in
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
   Codex views 27 a minute (against 126.8). The Claude background case's
   failure (2026-10-21 and 2026-10-23) was the spec's expectation; with the
   task output file accepted it passed on 2026-11-06 (task 2). Still owed:
   Codex ran the background command in the foreground; no live async question
   was exercised.
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
   **Done (2026-11-10, loopback model):** an idle OpenCode view read 8 times
   a minute with no invalidation of any cause over 300 s (task 6), so no
   caller needed tagging beyond task 4's causes.

### Qualification

The live run of 2026-10-21 is recorded below. What it left open, plus what the
2026-10-23 code changes need:

- Claude and Codex: every case has now run at the new cadence with loopback
  models (2026-11-06, tasks 3 to 5). Both follow-ups are fixed: the backgrounded
  command card (7522) on 2026-11-10, and the discovery renewals that wake an idle
  Codex view (7530, closed 2026-11-10). These are loopback-model runs; a real model's own choices
  (and a real provider's latency) are not part of them.
- Pi ran on a loopback
  model on 2026-11-06 (task 7), and OpenCode on 2026-11-10 (task 6): every
  OpenCode case passed except `subagents`, `background` (both
  not exercised: the scripted model has no call for them) and `detach`
  (cadence only: OpenCode reports no session attachment on the no-touch
  runtime read).
- Cases the models did not exercise: Codex sub-agents and the Codex
  background shell ran with scripted tool calls on 2026-11-06 (task 8; the
  separate live sub-agent card run is in
  [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md)).
  The OpenCode background shell is still unexercised (it ran the command in
  the foreground on 2026-10-21, and OpenCode's loopback fake from 2026-11-10
  has no background call yet). Cursor's approval case ran under an `approvals: "ask"`
  policy and still ran the command without asking, which is the documented
  Cursor mapping (it reports `ask` as the auto-approval it runs).
- Completion with no renderer was observed for a local environment only; the
  2026-11-06 container run (task 9) could not reach it on beelink, where only
  the first turn of a container runs (7080). Re-run with the corrected
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
  are also `not-exercised`, pending an observable lifecycle. The full wait
  passed for Claude on 2026-11-06 (task 10); Codex is in 7380. The background
  case passed for Claude the same day (task 2).

## Live check (2026-11-06, loopback models)

Tasks 1, 2, 9 and 10 on beelink (Arch Linux, kernel 7.1.8, Docker Engine
29.9.2, no display), at `c1724ab74` plus this change. No login and no billed
turn: the pinned Claude CLI 2.1.314 and Codex 0.166.0 talked to scripted
loopback models (`idle-observation-fake-claude.ts`,
`idle-observation-fake-codex.ts`) that answer the spec's own prompts and run
its shell commands for real. Disposable profile `idleqa-0049-fake`, started
headless with the Docker address-pool shim and a made-up Codex API key from a
throwaway `CODEX_HOME`, and `ORKESTRATOR_HOST_REACHABILITY_CHECK=off`:

```bash
env -u DISPLAY -u WAYLAND_DISPLAY ORKESTRATOR_HOST_REACHABILITY_CHECK=off \
  CODEX_HOME=<throwaway dir with an API-key auth.json> \
  ORKESTRATOR_QUALIFICATION_DOCKER="$(command -v docker)" \
  PATH="$PWD/apps/desktop/scripts/dev/docker-qualification-bin:$PATH" \
  mise run dev:test --profile idleqa-0049-fake --fixture --credential-source codex \
  --agent-platforms claude,codex --headless
ORKESTRATOR_AGENT_TEST_PROFILE=idleqa-0049-fake ORKESTRATOR_AGENT_TEST_RUN_ID=<run> \
  ORKESTRATOR_AGENT_TEST_LIVE_IDLE_OBSERVATION=1 ORKESTRATOR_AGENT_TEST_IDLE_FAKE_MODELS=1 \
  ORKESTRATOR_AGENT_TEST_IDLE_PLATFORMS=<claude|codex> \
  ORKESTRATOR_AGENT_TEST_IDLE_CASES=<cases> [ORKESTRATOR_AGENT_TEST_IDLE_ENVIRONMENT=container] \
  bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts \
  e2e/agent-testing/idle-observation-live.spec.ts --workers=1 --reporter=line
```

One provider at a time, on a profile with no other environment (the sweep
counters are profile-wide). Single samples, not p95 estimates.

| Case | Claude | Codex |
| --- | --- | --- |
| Warm-up (UI / sidebar lag) | 385 / 1,903 ms | 417 / 2,182 ms |
| `missed-final` (every frame naming the environment dropped) | passed: page 813 ms, sidebar 60 ms | passed: page 13.9 s (inside the 17.5 s lost-announcement bound, over the 3 s budget; D7), sidebar 28 ms; group read 9 and skipped 8 sweeps while idle |
| `bridge-restart` (task 1) | passed: backed off in 12.1 s; after the restart 9 sweeps read, 6 skipped; page 67 ms, sidebar 79 ms; backed off again in 12.2 s | passed: backed off in 12.1 s; 9 read, 5 skipped; page 114 ms, sidebar 162 ms; backed off again in 12.1 s |
| `background` (task 2) | passed: indicator 57 ms, page 34 ms, evidence `output-file` | not exercised: the scripted Codex turn runs the command in the foreground |
| `detach`, full 630 s wait (task 10) | passed: runtime `attached`, then `detached` after the wait, `attached` after the follow-up; 8.1 reads a minute; follow-up page 18 ms | not run: no session attachment on Codex's runtime read (7380) |
| Container (task 9, Claude) | warm-up settled (page 3.2 s); idle group read 10, skipped 7 sweeps; every later turn refused (required agent MCP unreachable, 7080) | not run |

Harness defects found and fixed in the spec on the way (no product defect in
these paths):

- `openEnvironment` clicked a "Continue Without …" startup notice with no
  action timeout. With fake keys both Claude and Codex report no login, the
  notices stack, and a click on a covered one waited for ever (two runs hung
  for 15 minutes). Clicks are now bounded and repeated until no notice has
  shown for 2 s.
- A run of several minutes records a trace over the 64 MiB artifact
  sanitizer bound, which then fails the global teardown, as on 2026-10-21 and
  2026-10-23. The trace is now opt-in (`ORKESTRATOR_AGENT_TEST_IDLE_TRACE=1`).
- The spec printed nothing until a case finished, so the logged runner's
  300 s no-output watchdog killed a run before its first case; it now prints
  content-free progress lines.

Evidence: `output/agent-testing/idleqa-0049-*/idle-observation-live/<platform>.json`
in the worktree that ran it. The profile was stopped and reset, every
environment the runs created was deleted, and the development image built for
the container run was removed.

## Second live check (2026-11-06, loopback models)

Tasks 3, 4, 5, 7 (Pi) and 8 on beelink (Arch Linux, kernel 7.1.8, no
display), at `ee2cc8423` plus this change. **Every run here is a
loopback-model run:** no login and no billed turn. The pinned Claude CLI,
Codex 0.166.0 and Pi 1.4.0 talked to scripted local models that answer the
spec's own prompts and run its commands for real
(`idle-observation-fake-claude.ts`, `-codex.ts`, `-pi.ts`). The fakes now
also script the approval command, sub-agents (Claude `Agent`; Codex
`spawn_agent` and `wait_agent` in the `collaboration` namespace, with
multi-agent v2 mail) and Codex's async question. Disposable profile
`idleqa-0049-r2`, headless, with the Docker address-pool shim on `PATH`, a
made-up Codex API key from a throwaway `CODEX_HOME`, and
`ORKESTRATOR_HOST_REACHABILITY_CHECK=off`; no Docker container was created:

```bash
env -u DISPLAY -u WAYLAND_DISPLAY ORKESTRATOR_HOST_REACHABILITY_CHECK=off \
  CODEX_HOME=<throwaway dir with an API-key auth.json> \
  ORKESTRATOR_QUALIFICATION_DOCKER="$(command -v docker)" \
  PATH="$PWD/apps/desktop/scripts/dev/docker-qualification-bin:$PATH" \
  mise run dev:test --profile idleqa-0049-r2 --fixture --credential-source codex \
  --agent-platforms claude,codex,pi --headless
# Claude and Codex (runs idleqa-0049-r2-claude, idleqa-0049-r2-codex):
ORKESTRATOR_AGENT_TEST_PROFILE=idleqa-0049-r2 ORKESTRATOR_AGENT_TEST_RUN_ID=<run> \
  ORKESTRATOR_AGENT_TEST_LIVE_IDLE_OBSERVATION=1 ORKESTRATOR_AGENT_TEST_IDLE_FAKE_MODELS=1 \
  ORKESTRATOR_AGENT_TEST_IDLE_PLATFORMS=<claude|codex> \
  ORKESTRATOR_AGENT_TEST_IDLE_CASES=approval,subagents,async-question,background,reconnect,hidden,no-renderer,detach \
  ORKESTRATOR_AGENT_TEST_IDLE_DETACH_WAIT_MS=300000 \
  bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts \
  e2e/agent-testing/idle-observation-live.spec.ts --workers=1 --reporter=line
# Pi (run idleqa-0049-r2-pi): the same with ORKESTRATOR_AGENT_TEST_IDLE_PLATFORMS=pi,
# every case and the default 630 s detach wait.
```

One provider at a time, on a profile with no other environment. Claude 6.6
min, exit 0; Codex 7.4 min, exit 0; Pi 13.9 min, exit 1 (its `detach` case).
Single samples, not p95 estimates.

| Case | Claude | Codex | Pi |
| --- | --- | --- | --- |
| Warm-up (UI / sidebar lag) | 5 / 1,882 ms | 15 / 977 ms | 272 / 1,127 ms |
| `missed-final` | not run (passed 2026-11-06, first run) | not run (passed 2026-11-06, first run) | passed: page 13.6 s (inside the 17.5 s bound, D7), sidebar 8 ms |
| `async-question` (task 3) | skipped (no async question) | passed: card 13 ms, reply 16 ms, answer settled 10 ms | skipped |
| `approval` | passed: card 6 ms | passed: card 48 ms | passed (policy `ask`): card 9 ms |
| `subagents` | passed: `Agent`, none left running | passed: one `subagent` card, `success` | not exercised (no tool) |
| `background` | passed: indicator 4 ms, evidence `output-file` | not exercised: card stays `bash:pending` after the command ended (7522; on 2026-11-10 the same case reads `bash:left-running` and now fails on a `pending` card) | not exercised (foreground) |
| `reconnect` | passed: 53 ms after online | passed: 138 ms | passed: 127 ms |
| `hidden` | passed: 0 reads hidden, 105 ms | passed: 0 reads, 189 ms | passed: 0 reads, 111 ms |
| `no-renderer` | passed: aggregate 4 ms, second client 6.1 s | passed: 6 ms, 9.3 s | passed: 6 ms, 6.2 s |
| `detach` | cadence only (300 s): 8.0 reads a minute, 0 invalidations | cadence only (300 s): 13.3 reads a minute, `discovery-renewal` 6 (7530) | failed: still `attached` after 630 s (7540); 7.4 reads a minute, 0 invalidations |

Harness changes on the way: the Codex fake first called `spawn_agent` without
its namespace (Codex answered "unsupported call"), and then, not reading
multi-agent mail, re-spawned children in a loop until the turn timed out; it
now names the namespace, reads `NEW_TASK` and `FINAL_ANSWER` agent messages,
and caps spawns at two per connection. The spec's sub-agent case now also
counts Codex's `subagent` cards, which carry no tool name.

**Rerun after 7530 and 7540 (2026-11-10, loopback models).** beelink2, the
same commands with profile `idle7530` (headless, no Docker container, no
login; `ORKESTRATOR_TEST_NO_PROGRESS_TIMEOUT_MS=1500000` so the logged
runner's 300 s silence watchdog does not stop the idle wait). Codex before
the fix (run `idle7530-codex-2`) reproduced the table: 13.3 reads a minute,
`discovery-renewal` 6, and the new per-section counter named the field,
`mcp` with `value[].tools[order]` 6. After the fix (`idle7530-codex-fixed`):
0 invalidations, 8.4 reads a minute, gaps 17 / 1 / 2 / 0 / 17, every other
case as before. Pi (`idle7530-pi`, default 630 s wait): `detach` passed,
`attached` before the wait, `detached` after it and `attached` again after the
next prompt; 7.6 reads a minute, and the two discovery announcements were the
detach itself (runtime `summary.state` and `summary.mcpServers`, MCP list
`value[count]`). Single samples. The profile was stopped and reset.

Evidence: `output/agent-testing/idleqa-0049-r2-*/idle-observation-live/<platform>.json`
in the worktree that ran it. Every environment the runs and probes created
was deleted, and the profile was stopped and reset afterwards.

## OpenCode live check (2026-11-10, loopback model)

Task 6 on beelink (Arch Linux, kernel 7.1.8, no display), at `c98b20e6f`
plus this change. **A loopback-model run:** no login and no billed turn. The
pinned OpenCode 1.19.5 server talked to the scripted chat-completions model
(`idle-observation-fake-pi.ts`, the one Pi uses), reached through a custom
OpenCode provider merged into the profile's own global `opencode.json`
(`opencode-fake-provider.ts`): `@ai-sdk/openai-compatible`, the default and
small model, and the only enabled provider, so neither a turn nor a title
request could reach a hosted model. The spec adds the fake's provider to
Orkestrator's `openCodeModelProviders` allowlist for the run and restores
it. The fake adds the description OpenCode's `bash` requires. Disposable
profile `oc-loop-0049`, headless, no host credentials, only OpenCode
enabled, `ORKESTRATOR_HOST_REACHABILITY_CHECK=off`; no Docker container was
created:

```bash
env -u DISPLAY -u WAYLAND_DISPLAY ORKESTRATOR_HOST_REACHABILITY_CHECK=off \
  ORKESTRATOR_QUALIFICATION_DOCKER="$(command -v docker)" \
  PATH="$PWD/apps/desktop/scripts/dev/docker-qualification-bin:$PATH" \
  mise run dev:test --profile oc-loop-0049 --fixture --no-agent-credentials \
  --agent-platforms opencode --headless
ORKESTRATOR_AGENT_TEST_PROFILE=oc-loop-0049 ORKESTRATOR_AGENT_TEST_RUN_ID=oc-loop-0049-idle-all \
  ORKESTRATOR_AGENT_TEST_LIVE_IDLE_OBSERVATION=1 ORKESTRATOR_AGENT_TEST_IDLE_FAKE_MODELS=1 \
  ORKESTRATOR_AGENT_TEST_IDLE_PLATFORMS=opencode \
  ORKESTRATOR_AGENT_TEST_IDLE_CASES=missed-final,approval,subagents,background,reconnect,hidden,no-renderer,detach \
  ORKESTRATOR_AGENT_TEST_IDLE_DETACH_WAIT_MS=300000 ORKESTRATOR_AGENT_TEST_IDLE_TURN_TIMEOUT_MS=120000 \
  bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts \
  e2e/agent-testing/idle-observation-live.spec.ts --workers=1 --reporter=line
```

A first `missed-final`-only run (`oc-loop-0049-idle-smoke`) skipped: the
composer asked for a sign-in because the fake's provider was outside the
allowlist (D23). After the fix, `oc-loop-0049-idle-smoke2` passed, then the
full run passed (8.0 min, exit 0), on a profile with no other environment.
Single samples, not p95 estimates.

| Case | OpenCode |
| --- | --- |
| Warm-up (UI / sidebar lag) | 318 / 1,208 ms; sidebar idle, working, idle |
| `missed-final` (every frame naming the environment dropped) | passed: page 13.1 s (inside the 17.5 s lost-announcement bound, over the 3 s budget; D7), sidebar 15 ms; group read 10 and skipped 7 sweeps while idle (the smoke run: 13.8 s, 9 and 8) |
| `approval` (environment policy `ask`; no "ask" composer mode) | passed: permission card 21 ms, page 282 ms, sidebar 1.6 s after approval |
| `subagents` | not exercised: the scripted model answers in text (OpenCode's `task` tool is not scripted) |
| `background` | not exercised: the scripted model has no background call, so the command ran in the foreground and its output came back in the tool result |
| `reconnect` | passed: 151 ms after online |
| `hidden` | passed: 0 reads hidden, 140 ms after visible |
| `no-renderer` | passed: backend aggregate 10 ms, second client 10.0 s |
| `detach` (300 s, cadence only) | 8 reads a minute, largest gap 15.0 s, **0 invalidations**, no discovery announcement; group read 71, skipped 79; follow-up page 13 ms. OpenCode reports no session attachment on the no-touch runtime read (`unknown` before and after) |

Evidence: `output/agent-testing/oc-loop-0049-*/idle-observation-live/opencode.json`
in the worktree that ran it. The spec deleted its environments and restored
the profile's `opencode.json` and allowlist; the profile was stopped and
reset afterwards.

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

**D12. Task 4: how the cause travels.** Options: (a) a `reason` field on
the resource change; (b) a `cause` field on both the resource change and the
activity announcement; (c) count in the backend only and send nothing to
clients. Chosen: (b). Why: the activity announcement already uses `reason`
for `"content"`, so one new name, `cause`, covers both channels without
changing what `reason` means. Pros: a client, relay or log can attribute an
invalidation without the backend's counters; one vocabulary for both
channels. Cons: a few bytes per frame, and clients must tolerate causes they
do not know (they do: an unknown cause is dropped, not the frame). (c) was
rejected because the ticket asks for every emitted invalidation to carry the
tag, and a counter alone leaves clients, relays and browser traces unable to
see it.

**D13. Task 4: the granularity of record causes.** Options: one
`session-record` cause for every persisted session write, or one per write
family. Chosen: one per family (`record-created`, `record-dispatch` and so
on). Why: a write that repeats on an idle session is exactly the kind of
source the attribution has to name. Pros: the count says which write.
Cons: nine causes where one would do for most readers.

**D14. Task 4: where the idle count comes from.** Options: a live run
(needs billed turns), a fake session through the real service, or a replay
of a recorded Codex stream through the bridge. Chosen: a fake session through
the real service. Why: the stage forbids billed turns, and the backend's own
announcement paths are what the tags attribute. Pros: deterministic, and it
pins that a stable idle Codex view gets no backend invalidations. Cons: it
cannot reproduce a real bridge's revision movement, so the live surplus is
still unattributed (see task 4, "Still owed").

**D15. Tasks 1, 2, 9 and 10: which model behind the live runs.** Options: a
real login (billed turns, the 2026-10-23 method), or scripted loopback models.
Chosen: loopback models. Why: the ticket forbids real logins and billed
turns, and every behaviour these tasks measure (the bridge, its stream, the
backend sweep, the page and sidebar) is real; only the model's choices are
scripted. Pros: repeatable, free, and the model always does what the case
asks, so no case is `not-exercised` for model choice. Cons: a CLI release that
changes how it talks to the API can break the fake without breaking real use;
the scripted Codex turn never backgrounds a command.

**D16. Task 2: what counts as Claude background output.** Options: accept the
finished task's output file, prompt the model to read the file, or drop the
output check. Chosen: accept the output file, after a fresh tool result. Why:
it is the output Claude really emits, and it keeps the prompt excluded. Pros:
no dependence on the model; content-free (only the evidence kind is
recorded). Cons: the spec reads the file directly (host path or `docker exec`)
because no backend command serves it.

**D17. Task 10: how a Claude detach is observed.** Options: report the CLI's
state on the existing no-touch runtime read, or watch the CLI process from
outside. Chosen: the runtime read, `attached`/`detached` as Cursor and Pi
already report. Why: the spec already reads that field and treats only those
two values as detach telemetry, and the bridge knows the answer in memory
(`openClaudeRuntime`). Pros: no new route, no touch, a bridge test pins it.
Cons: the agent info panel's runtime line now shows `attached` or `detached`
for Claude; an older bridge still reports nothing there, so the case stays
`not-exercised` against it.

**D18. Task 9: what to do when the container's later turns are refused.**
Options: change the host firewall, disable the agent MCP for the test, or
record the block. Chosen: record it (7080). Why: the ticket forbids firewall
changes, and turning the agent MCP off would test a configuration users do not
run. Pros: no host change. Cons: no-renderer completion in a container is still
unobserved.

**D19. Task 3: which Codex question to exercise.** Options: the blocking
`request_user_input` (a question card that parks the turn, already covered by
`paused-interactions-live.spec.ts`), or the async `request_user_input_async`.
Chosen: the async one. Why: it is the only question whose count is in
`contentRevision` (the item this task asks about), and pinned Codex offers it
to Orkestrator sessions. Pros: tests the real async path end to end, answer
included. Cons: the question arrives during a turn, so the turn's own
transitions also wake the view; the revision component alone stays covered
by `app-server-runtime-lifecycle.test.ts`.

**D20. Tasks 5 and 8: scripting approvals and sub-agents.** Options: keep
them for a real model (the header's earlier advice), or script them in the
fakes. Chosen: script them. Why: the cases measure the bridge, backend and
page, which are real; only the decision to call the tool is scripted. Pros:
no case is `not-exercised` for model choice; free and repeatable. Cons: the
fakes now encode Codex's multi-agent mail format (`NEW_TASK`/`FINAL_ANSWER`
agent messages) and tool namespaces, which a Codex release can change; the
fake caps sub-agent spawns at two per connection so a script mistake cannot
fork children without end (one did before the cap, during development).

**D21. Task 7: how Pi gets a model.** Options: copy a host Pi login (blocked:
the ticket forbids touching `~/.pi`), or add a loopback provider to the
profile's own Pi `models.json`, as to-do 0048's soak does. Chosen: the
loopback provider (`idle-observation-fake-pi.ts`, provider `idleqa-fake`),
scripted like the other two fakes. Pros: no login; the real Pi bridge and SDK
run every case. Cons: Pi has no sub-agent, background or question tool, so
those cases stay `not-exercised` or `skipped` whatever the model does.

**D22. Defects found by this run: fix or record.** Options: fix the stuck
Codex command card and the idle Codex renewals here, or record them.
Chosen: record both (7522, 7530). Why: neither is a regression in the
observation paths this file qualifies, the first needs a rendering decision
for a state Codex never reports, and the second's source is not yet named.
Pros: this change stays a qualification run; each follow-up has its evidence
and options. Cons: both costs remain until then.

**D23. Task 6: how OpenCode gets a loopback model.** Options: (a) a custom
provider in the profile's own global `opencode.json` (its isolated
`XDG_CONFIG_HOME`), served by the bundled `@ai-sdk/openai-compatible`
package and pointed at the Pi fake's chat-completions endpoint; (b) the
same provider through `OPENCODE_CONFIG_CONTENT`, as the backend's OpenCode
live tests do; (c) a project `opencode.json` in the worktree. Chosen: (a).
Pros: the backend starts each environment's OpenCode server with that
directory, so no launch code changes; one fake serves Pi and OpenCode; no
download. Cons: the file is shared with the MCP editor's OpenCode user
scope, so the merge keeps every other key and refuses a JSONC file rather
than drop a comment. (b) needs a backend environment change for a test;
(c) depends on project resources and would mix into the project scope.
The first run also showed that Orkestrator's `openCodeModelProviders`
allowlist treats a connected provider outside it as signed out. That is a
user setting working as designed, not a defect, so the spec adds the fake's
provider to the profile's setting for the run and restores it, as a user
with a custom provider would; admitting configured providers automatically
would widen a deliberate allowlist without a product decision.

**Assumptions.**

- Task 9: the only server a Claude join requires is the injected Orkestrator
  agent MCP (`AGENT_MCP_SERVER_NAME`, `session-manager-prompt-launch.ts`).
  That its route was blocked is assumed from 7080, which observed the same
  route dropped on the same host the same day; the container was not probed
  with `curl` in this run.
- Task 4 assumes the renderer re-reads once per backend invalidation it
  receives. The fake count models that one-to-one; a round joined into an
  in-flight read would make the live read count lower than the
  invalidation count, never higher.
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
- [7380-codex-idle-detach-observation.md](7380-codex-idle-detach-observation.md):
  the Codex half of task 10.
- [7080](../containers-and-environments/7080-linux-host-firewall-blocks-profile-signals.md):
  the host firewall that blocks task 9's later container turns on beelink.
- 7522 (fixed and deleted 2026-11-10): found by task 3; a Codex command left
  running at the end of its turn now reads "left running".
- 7530 (closed and deleted 2026-11-10): found by task 4; the discovery
  renewals that woke an idle Codex view, an MCP tool list read in a new
  order each time.
- 7540 (closed and deleted 2026-11-10): found by task 7; an open idle Pi tab
  kept its session attached.
- [5040-revision-token-spec-background-output.md](5040-revision-token-spec-background-output.md):
  another spec that expects a background command's output on its launching
  row; task 2 found that Claude puts it only in the task's output file.
- `0051-client-reconnect-and-freshness.md` (deleted 2026-11-06):
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

- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the
  human-only parts of this to-do (the Grok half of task 7, the Cursor half of
  task 8) moved there on 2026-11-10.

## Replaces

- `docs/improvements/recurring-processes/plan/07-agent-observation-and-activity.md`
  (deferrals: HTTP-bridge wakeup, Claude and Codex qualification,
  cross-instance sharing, live providers, B08)
- `docs/improvements/recurring-processes/plan/06-client-read-coordination.md`
  (task 8, Claude and Codex gating)
- `docs/imrovements/recurring-processes.md` (findings F05 and F06; inventory
  rows C01 and B06 to B10 moved to `../architecture/recurring-work.md`)
