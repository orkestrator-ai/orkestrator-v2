# Conditional reads and deltas: measured and not built (E10)

## Task analysis

Analysed 2026-11-06 against `main` at `cbe0f9a5b`. The E10 batch file (efficiency report parts 0160, 0180 and 0190) is deleted. Its last version, with every task's status, is the parent of the commit that deleted it, and `git show cbe0f9a5b:docs/reports/efficiency-logging-database/0160-e10-conditional-reads-and-deltas.md` shows it as built from. Its outcome is the closing check of E10 (`git show 413bd6219:docs/reports/2026-11-06-efficiency-logging-database-outcome.md`) in the efficiency outcome report.

### Tasks

1. **Take the E10 baseline on a real stack**: from the baseline tasks of parts 0160, 0180 and 0190. Status: done for Claude on an isolated `dev:test` profile (2026-11-06). Codex, Pi, a lagging viewer and windows near the 512 KiB bound remain open; see the task.
3. **Composer catalogue keyed by a revision**: from part 0180 task 3. Status: open (not built on the baseline; depends on 1 for a real Pi catalogue).
4. **A v2 `delta` answer from bridges**: from part 0190 task 2. Status: open (not built on the baseline; depends on 1 for large windows).
5. **The steer qualification probe runs on every state poll**: found while measuring. Status: open.
6. **Two bridge health probes on every poll**: found on the profile. Status: open.

### 1. Take the E10 baseline on a real stack

**Problem.** E10's parts were gated on a baseline taken on an isolated `dev:test` profile with no billed provider turn. Every figure E10 needs is taken while a turn streams, and a profile with no host login has no provider to stream one.

**Context.** Two baselines were taken, and neither ran a billed turn.

- **The profile baseline (2026-11-06).** `e2e/agent-testing/conditional-reads-live.spec.ts` is opt-in (`ORKESTRATOR_AGENT_TEST_E10_BASELINE=1`) and runs against a profile started with `mise run dev:test --profile e10-baseline --fixture --headless-electron --no-agent-credentials --agent-platforms claude,pi`. The spec writes an `env` block into the profile's own Claude settings (`<dataDir>/agent-credentials/claude/settings.json`, the profile's isolated `CLAUDE_CONFIG_DIR`). The block points the profile's real Claude CLI at `conditional-reads-fake-model.ts`, a loopback Anthropic Messages endpoint, with a fixture API key. A conversation turn (a request with tools whose user text holds the marker) streams 120 characters every 100 ms for 5 s and then calls `Glob`, 18 times, so each response becomes a new transcript row. The spec also writes a `bun` wrapper into the profile backend's own `--toolchain-bin-dir`, which `resolveBunBinary` prefers for every bridge it starts. The wrapper adds `--preload conditional-reads-bridge-counter.ts`. That counter patches `http.Server.prototype.emit` inside the bridge to record, per route with ids and query values removed: requests, wire and decoded bytes, and handler time. It also records whether a state body was byte-identical to that session's previous one, and, for each v2 transcript snapshot, the bytes of the rows that changed plus the id order, which is what a delta would carry. Both files are removed at the end. Viewers are real browser pages on the profile's gateway, recording each native-session answer's outcome, size and round-trip time. The spec measures 20 s with one viewer and 20 s with a second page on the same tab, both while the turn streams, then 30 s idle. It writes counts, bytes and milliseconds to `output/agent-testing/<run id>/conditional-reads.json`.
- **The fake-bridge baseline (2026-11-05).** `apps/backend/scripts/conditional-reads-baseline.ts` runs the real `NativeAgentService` and `HttpBridgeProvider` against an in-process fake bridge reached through `fetchImpl`, whose transcript routes are the shared bridge code. It covers Claude, Codex and Pi (Pi with 10 and 300 composer models), a lagging viewer polling every 1.5 s, the TX-1 ring on and off, and windows of 161 KB and 517 KB. It uses a temporary data directory, binds no port and runs no provider.

Historical profile figures from two runs on commit `39192c189` with the spec added, Claude only. With one viewer the runs' counts matched exactly; with two they differed by one or two requests. The ranges cover both runs. These original bridge aggregates used periodic flush boundaries and included traffic outside the renderer windows; they are retained as historical evidence only and must not be used as exact 20 s rates or compared directly with renderer counts. The aligned rerun below supersedes them:

| Part | Measure | One viewer, streaming, 20 s | Two viewers, streaming, 20 s | Idle, 30 s |
| --- | --- | --- | --- | --- |
| 0160 | Renderer answers (`get_native_agent_live_update`) | 40; transcript `delta` 40 of 40; state `unchanged` 36–37 of 40 | 40 per viewer; `delta` 40 of 40 each; state `unchanged` 36–37 of 40 | 3 (one per 10 s); all `unchanged` |
| 0160 | Bytes and round trip per viewer | 135–143 KB; p50 15 ms, p90 23 ms | 136–144 KB each; p50 11 ms, p90 15–16 ms | 27–52 KB |
| 0180 | Bridge requests per state poll | 5: `GET /session/:id`, `/questions`, `/plan-approvals`, `/interactions`, `/steer/dispatch`; 42 polls | 5; 84 polls | 5; 3 polls |
| 0180 | Claude state body, repeats of the previous one | 1.04 KB; 37 of 42 repeated; bridge time 0.22 ms mean | 1.05 KB; 79 of 84; 0.15 ms | 2.1 KB; 3 of 3; 0.13 ms |
| 0190 | Bridge transcript reads (v2 with `knownToken`) | 42, all snapshots; 1.60–1.64 MB decoded (38–39 KB each), 52–53 KB gzipped on the wire | 83–84; 43–74 snapshots (113–114 KB decoded each), the rest `unchanged`; 108–181 KB on the wire | 3, all `unchanged` |
| 0190 | Bridge handler time per transcript read, mean | 1.0 ms, gzip included | 1.07 ms | 0.29 ms |
| 0190 | What a delta would carry | 7.8–8.2 KB per snapshot (about 1.05 changed rows of 4.5), 4.7–5 times less | 7.5–8.1 KB per snapshot, 14–15 times less | — |
| Other | `GET /global/health` | 84 (two per poll) | 167–168 | 7–8 |
| Other | Activity sweep (`POST /sessions/activity`, `/change-evidence`, its ack) | 11 each | 10–11 each | 6–8 each |

Aligned rerun on 2026-11-06, profile `e10-window-repair`, after the round 2 repair (136.5 s, passed; stopped and reset). Response-completion timestamps in both sources use the same [from, to) windows; only the delayed file read waits for flush. Results: `output/agent-testing/e10-window-repair/conditional-reads.json` (git-ignored).

| Measure | One viewer, 20.001 s | Two viewers, 20.001 s | Idle, 30.002 s |
| --- | --- | --- | --- |
| Renderer transcript outcomes | 39 deltas (38 live updates and one separate transcript read) | 40 deltas per viewer | 3 unchanged |
| Renderer bytes; round trip p50 | 148,741 B; 11 ms | 143,057 / 143,603 B; 8 ms each | 51,963 B total; 9 ms |
| Bridge state polls; repeated bodies | 39; 35 repeated | 80; 76 repeated | 3; 3 repeated |
| Bridge mean state time | 0.29 ms | 0.13 ms | 0.15 ms |
| Bridge transcript reads; snapshots | 39; 39 | 80; 75 (5 unchanged) | 3; 0 |
| Transcript decoded / wire bytes | 1,502,959 / 49,166 B | 8,424,507 / 183,552 B | 294 / 321 B |
| Mean bridge transcript time | 0.84 ms | 0.78 ms | 0.47 ms |
| Estimated delta / snapshot decoded bytes | 308,411 / 1,502,959 B (4.9× smaller) | 565,503 / 8,424,022 B (14.9× smaller) | — |
| Health probes | 78 | 160 | 8 |
| Activity / change-evidence / ack | 10 each | 10 each | 7 each |

These replace the historical bridge totals for rate comparisons. They preserve the small-cost deferral decision: five state-related requests and two health probes per streaming poll; state bodies repeat frequently, and bridge transcript handling remains below 1 ms per read in this run. Timing varies with host load.

The fake filler text gzips far better than real text, so the wire bytes understate a real turn; the decoded bytes are what the backend parses. The window was small: the turn had just started, and the measured windows held 4 to 10 rows.

Fake-bridge figures from 2026-11-05, for what the profile did not cover:

| Part | Measure | Result |
| --- | --- | --- |
| 0160 | Three viewers, one of them lagging at 1.5 s, ring as built | 47 of 47 deltas; 99–108 KB to each 500 ms viewer, 41–43 KB to the lagging one, in 10 s |
| 0160 | The same with the ring disabled (before TX-1) | 46 of 47 snapshots; 1.86–1.96 MB per viewer on 161 KB windows and 6.30–6.63 MB on 517 KB ones |
| 0180 | Requests per state poll, Codex and Pi | 5.0, with Codex `/config` or Pi `/queue` in place of one interaction route |
| 0180 | State token hash per poll | 3–14 µs with no catalogue or 10 models; 141–266 µs with 300 models (130 KB), 27–35 µs with the models removed |
| 0180 | Pi `/status` body | 4.5 KB with 10 models, 130 KB with 300, on every poll |
| 0190 | 517 KB windows | A delta would carry 7.2–7.8 KB, 68 times less; an 8-entry bridge ring held the base on 100% of reads |
| 0190 | Provider source time per read, one viewer, p50 | 2 ms on 161 KB windows and 10 ms on 517 KB ones in the corrected run; load-sensitive, not a bound |

**Investigation.** The profile run contradicted the fake in one place. The fake modelled Claude's state body as moving with every event, so no state body repeated while streaming. On the real bridge, Claude's `GET /session/:id` body repeated on 88–94% of streaming polls. Everything else agreed with the fake: 5 bridge requests per state poll, every viewer read getting a delta from the backend, and a delta of about 8 KB against a whole snapshot. The profile also showed two things the fake could not. Each viewer's poll reads the bridge transcript once, so bridge reads grow with the number of viewers: 39 in 20.001 s for one viewer and 80 for two in the aligned rerun. And each poll also makes two `GET /global/health` requests (task 6).

Not measured on the profile, each for a stated reason:

- **Codex.** The profile's Codex reaches ChatGPT's Responses API over a websocket and needs a ChatGPT-shaped login in the profile's own `CODEX_HOME`. A loopback endpoint for that exists in `apps/backend/tests/account-switch-stack.ts`, but this round did not wire it into the profile. The fake run counted Codex's requests per poll, which come from backend code.
- **Pi.** A real Pi catalogue comes from the user's provider logins, and the 300-model case in particular. A credential-free profile has none, so it cannot reproduce the composer size that task 3 depends on.
- **A lagging viewer.** The renderer sets its own polling cadence, so a slow reader cannot be produced without changing the renderer. The fake measured it.
- **Large windows.** The scripted turn's window stayed under 115 KB decoded while it was measured. A turn near the 512 KiB bound needs a much longer scripted transcript.

**Decisions.**

- **How to finish the real-stack baseline?**
  - **Extend the spec with a Codex loopback endpoint and a long scripted turn, and keep Pi on the fake (recommended).**
    - Pros: no billed turn; covers the window sizes task 4 depends on and the second bridge family.
    - Cons: the Responses websocket endpoint and a fixture login in the profile's `CODEX_HOME` are more scaffolding to keep working across Codex bumps.
  - **Run a real provider turn on a profile with host credentials.**
    - Pros: real row sizes, cadence and compression.
    - Cons: billed, and it needs someone allowed to run one.
  - **Treat the current figures as enough.**
    - Pros: nothing more to build.
    - Cons: task 4's answer for large windows rests on the fake alone.

### 3. Composer catalogue keyed by a revision

**Problem.** The state token hashes `JSON.stringify` of the whole state view, `composer.models` included, on every poll.

**Context.** Part 0180 recommended keying the catalogue by a revision and hashing the revision.

**Investigation.** Re-checked on `cbe0f9a5b`: the hash is in `getSessionStateUpdate` (`native-agent-transcript-projection.ts`), over the view that `readProgressiveSessionState` builds with `projectionComposer`. Measured with the fake bridge: 3–14 µs per poll with no catalogue or 10 models, and 141–266 µs with 300 models, against 27–35 µs without them. At worst that is under 0.3 ms a poll. On the profile the whole live update, transcript and state together, had a round-trip p50 of 11–15 ms. The larger cost of a big catalogue is elsewhere: Pi's `/status` sends its whole composer on every poll, 130 KB with 300 models, and the backend parses it each time. A catalogue revision in the backend's hash would not remove that read. The profile could not reproduce a real Pi catalogue (task 1).

**Decisions.**

- **Build it?**
  - **Not now: the hash is too small to matter (recommended).**
    - Pros: no revision to keep exact for a saving of at most 0.3 ms a poll.
    - Cons: a 300-model catalogue is still hashed on every poll.
  - **Build the recommended revision.**
    - Pros: removes the hash.
    - Cons: a catalogue change must always move the revision, and it leaves the 130 KB read, which is the larger cost.
- **What would address the 130 KB?** Not decided here. A composer revision on Pi's `/status`, sending the composer only when it changed, would be a bridge wire change with the same cost as a bridge state revision (part 0180 task 2, whose build-or-not decision is on the manual-test checklist, 7568: 6680 task 2). Decide it together with that decision, once there are real catalogue sizes.

### 4. A v2 `delta` answer from bridges

**Problem.** Any change to a transcript re-sends and re-parses the whole window between bridge and backend, though usually only the tail row moved.

**Context.** Part 0190 recommended a delta from the `knownToken` the backend already sends, falling back to a snapshot on an unknown base, with a bridge ring and a capability check. Its alternative was to keep whole windows, "a fair choice if the baseline shows it is small", because this is loopback CPU rather than remote bandwidth.

**Investigation.** Re-checked on `cbe0f9a5b`: `readHttpBridgeSummaryTranscript` (`apps/backend/src/core/http-bridge/transcript-v2.ts`) handles `unchanged` and otherwise takes a whole snapshot. All five bridges answer through `bridgeTranscriptRouteBody` (`packages/protocol/src/node/bridge-transcript-routes.ts`), so a fix would land there and in the backend.

On the profile, each viewer poll made one bridge transcript read. A snapshot was 38–114 KB decoded and cost the bridge 1.0–1.07 ms on average, building the summary and gzip included. A delta would have carried 7.5–8.2 KB, 5–15 times less. The bytes never leave the machine. The backend's parse of each snapshot was not isolated on the profile; the whole renderer round trip, which includes it, had a p50 of 11–15 ms. With the fake bridge, a 517 KB window would have shrunk 68 times, and the corrected one-viewer source time was 10 ms. Those fake timings depend on host load and are not a bound.

**Decisions.**

- **Build it?**
  - **Not now: keep whole windows on loopback (recommended).**
    - Pros: no new wire form across five bridges, and no backend cache of raw provider windows to rebuild a snapshot from. On the real stack the bridge's whole cost is about 1 ms a read at the measured sizes.
    - Cons: bridge reads grow with viewers, and with windows. Near the 512 KiB bound the fake suggests several milliseconds a read, which the profile did not measure.
  - **Build the recommended delta.**
    - Pros: 5 to 68 times fewer bytes, and less parsing, per read.
    - Cons: a bridge ring per session, a backend copy of each session's last raw window, a capability check and a version-compatibility entry. The saving on the real stack is about 1 ms per read at the measured sizes.
- **What would change the answer?** Any one of: a real-stack run with windows near the bound showing reads well above 4 ms (task 1), many streaming sessions on one backend, or many viewers on one session.

### 5. The steer qualification probe runs on every state poll

**Problem.** One of the five bridge requests on each state poll is `GET /session/:id/steer/dispatch?requestId=orkestrator-steer-qualification` (`HttpBridgeSteerQualification.supported`, `apps/backend/src/core/http-bridge/steer-qualification.ts`), and its answer only changes when the bridge does.

**Context.** `readProgressiveSessionState` calls `steerSupported` on every read for platforms that advertise steer, so that the steer control can be cleared when the bridge cannot steer. #1870 (`dc9e818f9`) recently added diagnostics to this path.

**Investigation.** The fake run counted 47 probes for 47 state polls with three viewers, and 20 for 20 with one. In the aligned profile rerun there were 39 for 39 with one viewer and 80 for 80 with two. Each answer is about 22 bytes and took the bridge 0.05–0.06 ms, so the cost is a request, not bytes. E10 did not cover this, and it was not changed.

**Decisions.**

- **Cache the answer?**
  - **Cache a positive answer per session for the provider's generation, and re-probe after a refusal on a short timer (recommended).**
    - Pros: removes one bridge request in five per state poll. A bridge restart is a new provider generation, so a changed answer is still found.
    - Cons: a bridge that loses steer support without restarting is seen late.
  - **Leave it.**
    - Pros: always current.
    - Cons: a bridge request per poll for an answer that does not change.

### 6. Two bridge health probes on every poll

**Problem.** On the profile, the Claude bridge answered `GET /global/health` twice for every live-update poll: 78 times for 39 polls with one viewer, and 160 times for 80 polls with two in the aligned rerun (20.001 s each). Idle, it answered 8 times in 30.002 s for 3 polls.

**Context.** The local bridge health check is `checkHttpHealth` (`apps/backend/src/core/commands-server-health.ts`). It is used where the backend decides whether a local bridge is running and can be reused (`commands-servers.ts`, `commands-registry-servers.ts`). Each probe took the bridge under 0.15 ms and returned 33 bytes.

**Investigation.** Counted only. The caller that probes on every read was not traced, so whether both probes are needed is not known.

**Decisions.**

- **What to do?**
  - **Trace which read path probes health, and reuse a recent healthy answer within the provider's generation (recommended).**
    - Pros: two loopback requests per poll per viewer; a bridge that dies still fails the next real request, which reports it.
    - Cons: a hung but listening bridge is noticed one request later.
  - **Leave it.**
    - Pros: nothing to change; each probe is cheap.
    - Cons: two requests per poll for every viewer, which is 40% more bridge requests than the five a state poll needs.

## Assumptions and decisions

### Task 1: correct the streaming measurement boundary

The review repair clears diagnostic metrics after warm-up, and drains them after each completed poll into the benchmark's results. This keeps warm-up samples out of every domain, and keeps long runs past the diagnostic buffer's 256-sample limit, without changing production metrics. A final drain runs before idle polling. A numeric offset was rejected because the list groups domains and its buffers roll over. A fresh 10-second matrix after `27161bad6` captured every streaming poll; its raw aggregates are in `output/efficiency/e10-review-fixed.json` (git-ignored). Two deterministic tests cover mixed-domain warm-up, duplicate drains and 600 polls. That run's timings were taken while backend validation was running, so they are not compared causally with the original runs; the fake-bridge table above uses them.

### Task 1: take the baseline on a profile without a provider

Chose to point the profile's real Claude CLI at a loopback endpoint through the profile's own settings file, rather than run a billed turn or measure a fake bridge again. The ticket requires both a `dev:test` profile and no billed turn, and this meets both: the renderer, gateway, backend, bridge and CLI are all the profile's own. The profile's backend environment drops `ANTHROPIC_BASE_URL` (`retainSafeAgentTestEnvironment`), so the settings file is the only route that changes no product code. The bridge counter is loaded through a `bun` wrapper in the profile's own toolchain directory for the same reason. It runs only on that profile, and the spec removes it.

### Task 1: what was not measured

Codex, Pi, a lagging viewer and windows near the bound were left to the fake run, for the reasons in task 1. The decisions in tasks 2 to 4 do not change for them: tasks 2 and 3 are bounded by per-poll costs already measured, and task 4 names large windows as what would reopen it.

### Task 1: align bridge and renderer windows and make setup recoverable

The round 2 repair timestamps each bridge response completion and filters those samples and renderer answers to the same half-open wall-clock interval. The one-second file flush is only transport latency, not a measurement boundary. A history bounded to 20,000 samples and 8 MiB records a dropped-through timestamp; a stale flush, lost window or missing instrumentation fails instead of returning a misleading zero. Streaming windows require bridge state reads, transcript reads and measured snapshots, plus state and transcript answers for every expected viewer. The counter's route normalization, state repeats and changed-row estimates now have deterministic coverage.

The second viewer uses an explicitly created and routed browser context, which satisfies the browser-suite guard without weakening it. Bun resolution precedes profile mutation; cleanup starts immediately after model acquisition, tracks owned files, and runs file removal and model shutdown even if setup or artifact writing fails.

## Current state

E10's baseline is taken on an isolated `dev:test` profile for Claude, and with a fake bridge for Codex, Pi, a lagging viewer and large windows. 0160's ring (TX-1) was already built, and both baselines confirm that every viewer gets deltas. None of 0180 task 2, 0180 task 3 or 0190 task 2 was built, because the measured cost was small. The profile run also found two health probes per poll (task 6).

## Constraints and rationale

- Report invariants (`git show 413bd6219:docs/reports/2026-10-27-efficiency.md`): anything built later needs byte and count bounds on its cache or ring, keeps missed events detectable, and records a new wire form in [version-compatibility.md](../../architecture/version-compatibility.md).
- A bridge answering "unchanged" for state must still reach the backend's interaction and queue reads (part 0180).
- A delta must carry `revisedMessages` for rows outside the live tail (invariant 14), and a base from another history epoch or provider session must never produce one.
- The profile baseline must never run a billed turn. Run it only on a profile started with `--no-agent-credentials`, so that a fault in the spec cannot fall back to a host login.

## Related

- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (task 2, the maintainer's decision on a bridge state revision sent as `knownToken`) moved there on 2026-11-10.
- Efficiency outcome, closing check of E10 (`git show 413bd6219:docs/reports/2026-11-06-efficiency-logging-database-outcome.md`)
- to-do 1202 efficiency follow-ups, tasks 1, 4 and 5 (retired 2026-11-10)
- [5340](5340-transcript-reads-live-evidence.md) and [6260](6260-projection-hashing-measurements.md): the other transcript measurements; the loopback-model spec here can take theirs without a billed turn
- Efficiency report, B (`git show 413bd6219:docs/reports/2026-10-27-efficiency.md`) (TX-1, TX-5, TX-6)
