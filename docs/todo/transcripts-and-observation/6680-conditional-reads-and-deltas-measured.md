# Conditional reads and deltas: measured and not built (E10)

## Task analysis

Analysed 2026-11-05 against `main` at `cbe0f9a5b`. The E10 batch file (efficiency report parts 0160, 0180 and 0190) is deleted; its last version, with every task's status, is the parent of the commit that deleted it, and `git show cbe0f9a5b:docs/reports/efficiency-logging-database/0160-e10-conditional-reads-and-deltas.md` shows it as built from. Its outcome is the [closing check of E10](../../reports/efficiency-logging-database/0000-index.md#closing-check-of-e10-conditional-reads-and-deltas) in the efficiency index.

### Tasks

1. **Take the E10 baseline on a real stack**: the same figures on an isolated `dev:test` profile with a real streaming turn. From the baseline task of parts 0160, 0180 and 0190. Status: open.
2. **Bridge state revision sent as `knownToken`**: from part 0180 task 2. Status: open (not built on the baseline; depends on 1 or a maintainer decision).
3. **Composer catalogue keyed by a revision**: from part 0180 task 3. Status: open (not built on the baseline; depends on 1 or a maintainer decision).
4. **A v2 `delta` answer from bridges**: from part 0190 task 2. Status: open (not built on the baseline; depends on 1 or a maintainer decision).
5. **The steer qualification probe runs on every state poll**: found while measuring. Status: open.

### 1. Take the E10 baseline on a real stack

**Problem.** The E10 baseline was taken with a fake bridge, not on a `dev:test` profile. The batch asked for a profile run, but every number E10 needs is taken while a turn streams, and a profile has no way to stream a turn without a provider: `session start` takes a prompt, and a local bridge cannot be pointed at a fake from the profile.

**Context.** The baseline ran `apps/backend/scripts/conditional-reads-baseline.ts` on `cbe0f9a5b`: the real `NativeAgentService` and the real `HttpBridgeProvider` against a fake bridge answered in process through `fetchImpl`, whose transcript routes are the shared code every bridge uses (`bridgeTranscriptRouteBody`, `RecentlyRevisedRows`). A temporary data directory, no port, no provider and no billed turn. The fake streams a turn: the tail row grows by 120 characters every 100 ms, gains a tool part every 2 s and becomes a new model response every 5 s. Viewers poll transcript and state together with the tokens they hold every 500 ms (`live`, and `second`, another tab offset by 250 ms); `lagging` polls every 1.5 s. Windows are `typical` (62 rows, about 161 KB as sent) and `full` (102 rows, about 517 KB, at the 512 KiB bound). Two runs of 10 s per case on a 16-core host with a load average of 5 to 17; the runs agreed to within a few percent on every count and byte figure. The state bodies are modelled on each bridge's own route (Claude's whole session resource with `lastActivity`, `thinkingTokens` and `activity`; Codex and Pi `/status` with `messageRevision`; Pi's `composer`).

The figures, for tasks 2 to 4 below to cite:

| Part | Measure | Result |
| --- | --- | --- |
| 0160 | Transcript answers over 10 s, three viewers, ring as built | 47 of 47 deltas; 99–108 KB to each 500 ms viewer, 41–43 KB to the lagging one, on both windows |
| 0160 | The same with the ring disabled (before TX-1) | 46 of 47 snapshots; 1.86–1.96 MB to each viewer on `typical` and 6.30–6.63 MB on `full`; 0.68 MB and 2.32 MB to the lagging one |
| 0160 | Where the multi-viewer answers came from | Corrected collection: 47 samples for 47 polls, with 46 `memory:delta` and 1 `provider:delta` on each window; one viewer alone got `provider:delta` 20 of 20. With the ring disabled: 46 `memory:cached` and 1 `provider:delta` |
| 0180 | Bridge requests per state poll | 5.0 on Claude, Codex and Pi: the state route, Codex `/config` or Pi `/queue` (Claude has none), two or three interaction routes and `/steer/dispatch` |
| 0180 | State bodies identical to the previous one | Streaming: 0 of 47 and 0 of 20 (one of 47 in one run). Idle: 4 of 5 |
| 0180 | State read time, p50 | Corrected run: 2–15 ms in total, 2–13 ms of it the source reads; normalising 0–1 ms |
| 0180 | State token hash per poll | 3–14 µs with no catalogue or 10 models (4.4 KB); 141–266 µs with 300 models (130 KB), against 27–35 µs with the models removed |
| 0180 | Pi `/status` body | 4.5 KB with 10 models, 130 KB with 300, on every poll |
| 0190 | Bridge transcript reads while streaming | One viewer: 20 in 10 s, every one a whole snapshot (161 KB `typical`, 517 KB `full`), 3.2 MB and 10.3 MB. Three viewers: 46–47, 7.6 MB and 23.8–24.3 MB |
| 0190 | What a delta from the backend's `knownToken` would carry | 7.2–7.8 KB per read (changed rows, the id order, `revisedMessages` and the envelope): 22 times smaller on `typical`, 68 times on `full` |
| 0190 | Base still in an 8-entry bridge ring | 100% of reads |
| 0190 | Loopback cost per read, one viewer, p50 | Corrected run: provider source time 2 ms on `typical`, 10 ms on `full`, normalising 1 ms. Original runs: 1 ms and 3–4 ms. The fake includes summary building and extra encoding/parsing; timing varies with host load and is not a bound on real-stack cost |

**Investigation.** Not run on a real stack. A real bridge's state body, its streaming cadence and its row sizes are what the fake approximates; the counts of requests per poll come from the real backend code and do not depend on the fake.

**Decisions.**

- **How to get real-stack numbers?**
  - **Run the same viewers against a real streaming turn on an isolated `dev:test` profile, counting bridge requests and bytes with a proxy in front of the bridge, in the same pass as 5340 and 6260 (recommended).**
    - Pros: real bodies, cadence and row sizes; one billed run answers three to-dos.
    - Cons: needs a real provider turn, which is billed, so it waits for someone allowed to run one.
  - **Treat the fake figures as enough.**
    - Pros: no billed turn.
    - Cons: a fake cannot show a real bridge's body sizes or how often a real turn writes.

### 2. Bridge state revision sent as `knownToken`

**Problem.** Every state poll reads the whole session state from the bridge, even when nothing changed.

**Context.** Part 0180 recommended a bridge state revision the backend sends as `knownToken`, with an older bridge answering whole. The report's constraint was that a bridge answering "unchanged" must still reach the backend's interaction and queue reads.

**Investigation.** Re-checked on `cbe0f9a5b`: `readHttpBridgeSessionState` (`apps/backend/src/core/http-bridge-progressive.ts`) still reads the state route with no condition, plus Codex `/config` and Pi `/queue`; `readProgressiveSessionState` (`native-agent-transcript-projection.ts`) still adds the interaction reads and the steer probe. Measured (task 1): while a turn streams, no state body repeated, because each bridge's state carries a field that moves with every streamed event (Claude's `lastActivity` and `thinkingTokens`, Codex and Pi `messageRevision`). A revision that covered those fields would move on every poll and save nothing. On an idle poll the body repeats, but the revision would save one of the five bridge requests, since the interaction reads and the steer probe stay, and an idle tab polls once every 15 s at the end of its quiet backoff.

**Decisions.**

- **Build it?**
  - **Not now: the saving is one small read per idle poll (recommended).**
    - Pros: no new wire form, no per-bridge revision to keep exact; nothing is lost while the idle read is 350 bytes (Claude) to 4.5 KB (Pi, 10 models) every 15 s.
    - Cons: Pi with a large catalogue still re-sends its composer on every poll (task 3).
  - **Build the recommended revision.**
    - Pros: idle polls of a large Pi catalogue stop re-sending it.
    - Cons: every bridge must move the revision on every state change, and a missed bump shows stale state; it saves nothing while streaming.

### 3. Composer catalogue keyed by a revision

**Problem.** The state token hashes `JSON.stringify` of the whole state view, `composer.models` included, on every poll.

**Context.** Part 0180 recommended keying the catalogue by a revision and hashing the revision.

**Investigation.** Re-checked on `cbe0f9a5b`: the hash is in `getSessionStateUpdate` (`native-agent-transcript-projection.ts`), over the view `readProgressiveSessionState` builds with `projectionComposer`. Measured (task 1): 3–14 µs per poll with no catalogue or 10 models, and 141–266 µs with 300 models against 27–35 µs without them. That is under 0.3 ms a poll in the worst case, beside a corrected 2–15 ms state read, and at 2 polls a second under 0.06% of a core. The larger cost of a big catalogue is elsewhere: Pi's `/status` sends its whole composer, 130 KB with 300 models, on every poll, and the backend parses it each time. A catalogue revision in the backend's hash does not remove that read.

**Decisions.**

- **Build it?**
  - **Not now: the hash is too small to matter (recommended).**
    - Pros: no revision to keep exact for a saving of at most 0.3 ms a poll.
    - Cons: a 300-model catalogue is still hashed on every poll.
  - **Build the recommended revision.**
    - Pros: removes the hash.
    - Cons: a catalogue change must always move the revision; it leaves the 130 KB read, which is the larger cost.
- **What would address the 130 KB?** Not decided here. A composer revision on Pi's `/status` (the composer sent only when it moved) is a bridge wire change with the same cost as task 2, and should be decided with it on real catalogue sizes from task 1.

### 4. A v2 `delta` answer from bridges

**Problem.** Any change to a transcript re-sends and re-parses the whole window between bridge and backend, though usually only the tail row moved.

**Context.** Part 0190 recommended a delta from the `knownToken` the backend already sends, falling back to a snapshot on an unknown base, with a bridge ring and a capability check. Its alternative was to keep whole windows, "a fair choice if the baseline shows it is small", because this is loopback CPU rather than remote bandwidth.

**Investigation.** Re-checked on `cbe0f9a5b`: `readHttpBridgeSummaryTranscript` (`apps/backend/src/core/http-bridge-transcript-v2.ts`) handles `unchanged` and otherwise a whole snapshot; all five bridges answer through `bridgeTranscriptRouteBody` (`packages/protocol/src/node/bridge-transcript-routes.ts`), so a fix would land there and in the backend. Measured (task 1): a delta would be 22 to 68 times smaller (7.2–7.8 KB against 161–517 KB), and an 8-entry ring would always have held the base. The original run measured 1 ms a read on a typical window and 3–4 ms on a full one, including the fake's own work. The corrected run measured 2 ms and 10 ms (0.4% and 2% of a core at two reads a second, before normalisation). These load-sensitive fake timings do not establish an upper bound. Viewers each drive reads (20 in 10 s with one viewer, 47 with three). The bytes never leave the machine: the bridge is a local process or a local container.

**Decisions.**

- **Build it?**
  - **Not now: keep whole windows on loopback (recommended).**
    - Pros: no new wire form across five bridges; no backend cache of raw provider windows to rebuild a snapshot from; the original timings were small; real-stack cost remains unmeasured.
    - Cons: corrected fake timings reached 10 ms per full-window read for one viewer; no reliable CPU bound is established.
  - **Build the recommended delta.**
    - Pros: 22 to 68 times fewer bytes and less parsing per read.
    - Cons: a bridge ring per session, a backend copy of each session's last raw window, a capability check and a version-compatibility entry, for a saving whose real-stack size remains unmeasured.
- **What would change the answer?** A real-stack run (task 1) showing larger windows, a faster write cadence or reads well above 4 ms, or a backend serving many streaming sessions at once. The corrected fake run already exceeded 4 ms, so the earlier fake CPU bound must not be used to dismiss this task.

### 5. The steer qualification probe runs on every state poll

**Problem.** One of the five bridge requests on each state poll is `GET /session/:id/steer/dispatch?requestId=orkestrator-steer-qualification` (`HttpBridgeSteerQualification.supported`, `apps/backend/src/core/http-bridge-steer-qualification.ts`), whose answer only changes when the bridge does.

**Context.** `readProgressiveSessionState` calls `steerSupported` on every read for platforms that advertise steer, so the steer control can be cleared when the bridge cannot steer. #1870 (`dc9e818f9`) recently added diagnostics to this path.

**Investigation.** Counted in task 1: 47 probes for 47 state polls (three viewers), 20 for 20 (one). Each answer is about 22 bytes, so the cost is a request, not bytes. Not changed in E10, which did not cover it.

**Decisions.**

- **Cache the answer?**
  - **Cache a positive answer per session for the provider's generation, and re-probe after a refusal on a short timer (recommended).**
    - Pros: removes one bridge request in five per state poll; a bridge restart is a new provider generation, so a changed answer is still found.
    - Cons: a bridge that loses steer support without restarting is seen late.
  - **Leave it.**
    - Pros: always current.
    - Cons: a bridge request per poll for an answer that does not change.

## Assumptions and decisions

### Task 1: correct the streaming measurement boundary

The review repair clears diagnostic metrics after warm-up and drains them after each completed poll into the benchmark's results. This excludes warm-up samples from every domain and retains long runs beyond the diagnostic buffer's 256-sample limit without changing production metrics. A final drain precedes idle polling. A numeric offset was rejected because the list groups domains and its buffers roll over.

A fresh 10-second matrix on 2026-11-05, after validated commit `27161bad6`, captured 47 transcript and 47 non-joined state samples in each three-viewer case, and 20 of each in every one-viewer case. Two deterministic tests cover mixed-domain warm-up, duplicate drains and 600 polls. The refresh ran while backend validation was active; timings are observations under that load, not a causal comparison with the original runs. Counts and bytes above remain the original baseline; the sample-count/outcome and phase-time rows are replaced by the corrected run. Raw aggregates: `output/efficiency/e10-review-fixed.json` (git-ignored).

| Case | State p50 total/source/normalise (ms) | Transcript provider p50 source/normalise (ms) |
| --- | --- | --- |
| Claude typical, three viewers, ring | 2 / 2 / 0 | 1 / 1 |
| Claude typical, three viewers, no ring | 2 / 2 / 0 | 1 / 0 |
| Claude full, three viewers, ring | 9 / 8 / 0 | 14 / 6 |
| Claude full, three viewers, no ring | 15 / 12 / 0 | 5 / 1 |
| Claude typical, one viewer | 5 / 4 / 0 | 2 / 1 |
| Claude full, one viewer | 14 / 13 / 0 | 10 / 1 |
| Codex typical, one viewer | 6 / 5 / 0 | 3 / 1 |
| Pi typical, 10 models, one viewer | 6 / 5 / 0 | 2 / 1 |
| Pi typical, 300 models, one viewer | 9 / 8 / 1 | 3 / 1 |

Multi-viewer provider percentiles contain only the first read (one sample); the other 46 reads use memory. One-viewer provider percentiles contain all 20 samples. The deferred tasks remain open; the earlier CPU upper-bound claim is withdrawn pending task 1's real-stack measurements.

## Current state

E10's baseline is taken with a fake bridge and its figures are above. 0160's ring (TX-1) was already built and the baseline confirms it: every lagging or second viewer now gets deltas. None of 0180 task 2, 0180 task 3 or 0190 task 2 was built, because the measured cost was small; each waits on task 1 or a maintainer decision.

## Constraints and rationale

- [Report invariants](../../reports/2026-10-27-efficiency.md#invariants-every-fix-must-keep): anything built later needs byte and count bounds on its cache or ring, keeps missed events detectable, and records a new wire form in [version-compatibility.md](../../architecture/version-compatibility.md).
- A bridge answering "unchanged" for state must still reach the backend's interaction and queue reads (part 0180).
- A delta must carry `revisedMessages` for rows outside the live tail (invariant 14), and a base from another history epoch or provider session must never produce one.

## Related

- [Efficiency index, closing check of E10](../../reports/efficiency-logging-database/0000-index.md#closing-check-of-e10-conditional-reads-and-deltas)
- [1202 efficiency follow-ups](../cross-cutting/1202-efficiency-review-follow-ups.md), tasks 1, 4 and 5
- [5340](5340-transcript-reads-live-evidence.md) and [6260](6260-projection-hashing-measurements.md): the other transcript measurements a real-stack run can take in the same pass
- [Efficiency report, B](../../reports/2026-10-27-efficiency.md#b-native-agent-transcript-pipeline) (TX-1, TX-5, TX-6)
