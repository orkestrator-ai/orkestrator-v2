# Efficiency review follow-ups

## Task analysis

Analysed 2026-11-01 against `main` at `0bd214ee`.

Every outstanding item from
the 2026-10-27 efficiency report (`git show 413bd6219:docs/reports/2026-10-27-efficiency.md`).
Finding IDs (ST-7, WEB-2, ...) are the report's; its "Detailed findings"
section gives the file and line for each, and its "Invariants every fix must
keep" section applies to every task here. The report measured nothing, so its
impact ratings are reasoned from the code.

Items already owned elsewhere stay there and are not repeated: compression and
WebSocket deflate (GW-2, GW-7) in
[0052](../transcripts-and-observation/0052-remote-client-bandwidth.md), joined
history pages (TX-10) in 0232, recurring-work live evidence in
[0048](../transcripts-and-observation/0048-recurring-work-qualification.md)
and container resource budgets in
[0022](../containers-and-environments/0022-container-resource-budgets-and-performance.md).
Multi Review drift checks (BG-10), once listed here as owned by
[0027](../coordinator-and-multi-review/0027-multi-review-scale-and-cost.md),
which had no task for them, were done on 2026-11-05: snapshot mode checks
the worktree once per admission pass, as package mode already did.

The maintainer's decisions of 2026-11-01 are recorded in the task each one
governs, marked "Decided".

### Tasks

1. **Baseline and before-and-after numbers**: capture the report's measurements for the work already done and before each structural task. Status: open (macOS done 2026-11-06: ST-13 and BG-15's baselines, ST-13 live on `dev:test` profiles, BG-15 live on a real claude-tmux tab with a loopback fake model, the idle recurring work of `0bd214ee` against `main`, the change-tracking and diff-scan benchmarks, DK-7 to DK-9's image sizes on linux/arm64 under Docker Desktop, and WEB-3's per-transition RPC counts on a native loopback turn; Linux done 2026-11-10: a claude-tmux tab in a container on a container-local fake model, counted by Docker (idle tab 297–471 → 124.5–128.5 execs a minute for the container; BG-1, BG-2, BG-7), and tasks 2 and 10's per-pass counts on the 0048 busy profile, populated and with its environments stopped (activity sweep 13.7 → 5.9 KB fetched a pass, BG-3's presence reads 7 → 7 on base against 9 → 3 on after). Still open: the BG-2 doorbell rate live, which needs a host whose containers reach the backend (beelink's cannot; agent-doable on macOS); BG-9 live, which needs a working Claude or Codex session on a loopback model (agent-doable); BG-11 live, which needs a build pipeline; and the user's: `gh-spawn` per hour needs a real PR and a `gh` login, a cold-cache launch needs root, BG-12 needs a real Claude login handed to a container; see the table in task 1).
2. **Storage keyed reads and writes**: the lease-held native session mutations, one shared decoded snapshot, the agent mail remainder, keyed-array row writes and the position index (TX-4 rest, BG-5, ST-9 rest, ST-10, ST-11). Status: done 2026-11-05, with what is left in to-dos (ST-7, ST-8, BG-5, ST-11 and ST-10 done, TX-4's rest done 2026-11-04; ST-9's rest measured 2026-11-05 and not built, thresholds in [6760](6760-agent-mail-store-split-thresholds.md); the prompt-queue reads a steer made were 5100, done 2026-11-05; live store sizes and write rates are [5101](5101-store-size-and-write-rate-live.md); live per-pass counts on the 0048 busy profile 2026-11-10 in task 1: the activity sweep fetched 13.7 → 5.9 KB a pass and the queue scan 1.1 → 0.6 KB).
3. **Renderer re-renders and refetches**: WEB-6, WEB-7, WEB-9 to WEB-14 and WEB-16 to WEB-19, plus WEB-2's narrower subscriptions. Status: done (2026-11-04; WEB-2, WEB-3, WEB-4, WEB-5, WEB-8, WEB-15 and GW-13 earlier; WEB-7 and WEB-17 on 2026-11-03; WEB-2's third fix, WEB-6, WEB-9, WEB-10 and WEB-11, then WEB-12 to WEB-14, WEB-16, WEB-18 and WEB-19 on 2026-11-04; a React Profiler run stays with task 1). E12 (WEB-2's third fix, WEB-6 and WEB-14) was checked back on 2026-11-05 and its batch file deleted: all three were built, and its two-tab Profiler run found no difference in commits; see the closing check of E12 (`git show 413bd6219:docs/reports/2026-11-06-efficiency-logging-database-outcome.md`).
4. **Live agent view requests**: discovery out of the 500 ms round, a combined read, then bridge state ETags and transcript deltas (WEB-1, GW-1, GW-3, TX-5, TX-6). Status: open, waiting on the maintainer's choice of push or long-poll (decided 2026-11-01 to choose only if the numbers still justify it; the numbers are in task 4 and nothing else is left to build) (WEB-1 and GW-1 done 2026-11-04, a visible running tab from 3 requests per round to 1.04; GW-3 done 2026-11-05; TX-5 and TX-6 measured in E10 on a `dev:test` profile (2026-11-06, a real Claude bridge streaming against a loopback model, no billed turn) and with a fake bridge, and not built: on the real stack the bridge spends under 0.25 ms on a state read and about 1 ms on a transcript read; the figures and decisions are [6680](../transcripts-and-observation/6680-conditional-reads-and-deltas-measured.md), and the outcome is the closing check of E10 (`git show 413bd6219:docs/reports/2026-11-06-efficiency-logging-database-outcome.md`)).
5. **Transcript pipeline**: delta-base ring, unlimited post-dispatch reads, memoised fingerprints and the smaller items (TX-1 to TX-3, TX-7 to TX-9, TX-11 to TX-18). Status: done 2026-11-06, every item done or measured, live evidence left in 5340 and 6680 (TX-1 and TX-2 done 2026-11-04, focused tests only; TX-1 measured in E10: on a `dev:test` profile every streaming answer was a delta for one viewer and for each of two, and with a fake bridge the ring disabled gave 46 of 47 snapshots, 1.86–6.63 MB per viewer in 10 s; see [6680](../transcripts-and-observation/6680-conditional-reads-and-deltas-measured.md) task 1; TX-8, TX-15 and TX-18 done 2026-11-05 in E9, with fixture figures and live evidence in [5340](../transcripts-and-observation/5340-transcript-reads-live-evidence.md); TX-3, TX-7, TX-9, TX-11 to TX-14 and TX-16 done 2026-11-05 in E11, focused tests only, see the closing check of E11 (`git show 413bd6219:docs/reports/2026-11-06-efficiency-logging-database-outcome.md`); TX-17 profiled and closed without a change, and E11's savings measured with a provider fake, 2026-11-05 in [6260](../transcripts-and-observation/6260-projection-hashing-measurements.md), figures in the measurement of E11 (`git show 413bd6219:docs/reports/2026-11-06-efficiency-logging-database-outcome.md`)).
6. **Bridge hot paths**: Codex config reads, cached transcript measurement, tool-card fast paths, Claude part identity, stream framing and shared helpers (BR-2, BR-4 to BR-16). Status: done (BR-1 and BR-3 done, tests for BR-1 added 2026-11-05 by E20; BR-4 to BR-6 and the transcript half of BR-15 done 2026-11-02; BR-2, BR-8, BR-9 and BR-11 done 2026-11-03; BR-7, BR-10, BR-12 to BR-14 and BR-16 done 2026-11-04; BR-15's SSE replay rings done 2026-11-05).
7. **Change tracking and git scans**: stamp short-circuit, count memo, manifest cache, off-loop zlib and the git scan costs (ST-1 to ST-6, ST-13 to ST-21). Status: done (ST-1, ST-2 and ST-4 done on 2026-11-02; ST-3, ST-14, ST-15, ST-16 and ST-18 done 2026-11-04, warm capture over 10,000 files with one changed from 681–797 ms to 211–319 ms p50, and a warm local diff scan from 7 git processes and every untracked file read to 4 and none; ST-2's directory-handle cache deliberately not done; ST-17 done 2026-11-04 on Linux, a proved ignored `node_modules` taking no watches (4,672 to 170 on `watch-nm-4k`) and on macOS its events dropped on arrival; what is left of ST-16 and ST-17 is [5060](5060-worktree-watch-leftovers.md), which also has the outcome of every task in batch E7; ST-5 and ST-6 done 2026-11-04, longest event-loop stall during a capture storing a 16 MiB blob from 107–143 ms to 12–13 ms p50 and a cold durable capture of 1,000 files from 3.3–4.1 s to 0.6–1.1 s; ST-20 done 2026-11-05, a second hourly retention pass over 400 snapshots of 2,000 files from 565 ms to 87 ms and a put during a sweep from about 400 ms to 1–2 ms, live sizing in [5361](5361-retention-pass-on-a-large-real-store.md); ST-19 done 2026-11-05, `activeTurns()` seeks the lifecycle index, and the ledger retention that decides what becomes of the rows is built, live sizing in [5821](5821-ledger-retention-live-evidence.md); ST-21 done 2026-11-05 by batch E-0580, its leftovers in [5800](5800-file-read-streaming-leftovers.md); ST-13 done 2026-11-06, the snapshot check's free-page release moved to a child process, its stall from 140 ms p50 (up to 2.4 s) to 6–7 ms on a 512 MiB database, and the deletion scrub and pre-migration copy left in-process in [7210](7210-storage-work-left-on-the-event-loop.md)).
8. **tmux and container polling**: the rest of BG-1, BG-2 and BG-8, plus BG-7, BG-14 and BG-15. Status: done (BG-1, BG-2, BG-7 and BG-8 done 2026-11-03, image proven locally; BG-14 done 2026-11-04, its remaining live evidence in [5120](../transcripts-and-observation/5120-tmux-transcript-reopen-live-evidence.md); BG-15 done 2026-11-06, a mail delivery to an idle tmux tab from 9 keyed reads to 7 with the fresh liveness probe kept, and seen live the same day on a real claude-tmux tab with a loopback fake model, 27 storage reads per delivery to 25, task 1; BG-1, BG-2 and BG-7 seen live 2026-11-10 with a claude-tmux tab in a container, counted by Docker: the idle tab's loop 3.8–6.7 → 0.94–0.99 execs a second on the one-exec poll, the doorbell rate itself not yet live, task 1).
9. **PR monitor cost**: batched queries, then activity backoff (BG-6, BG-13). Status: done (2026-11-03; live numbers not measurable on an isolated profile, which has no PR and no `gh` login; see task 1).
10. **Other background jobs**: the rest of BG-3, plus BG-9, BG-11 and BG-12. Status: done (2026-11-02; an idle `dev:test` profile shows no difference on 2026-11-06, because it has none of the items these skip; BG-3 seen live 2026-11-10 on 0048's busy profile, presence reads per pass 7 → 7 on base and 9 → 3 on after with both mailboxes' environments stopped; BG-9, BG-11 and BG-12 live stay with task 1).
11. **Gateway and preview proxy**: GW-5, GW-6, GW-8 to GW-12 and GW-14 to GW-16. Status: done (GW-8 and GW-9 done; GW-4 done; GW-2 done in 0052; GW-5, GW-6, GW-12 and GW-14 done 2026-11-04, a flooding terminal channel no longer desyncs a quiet one; GW-16 done 2026-11-04, live checks beyond loopback Chromium are in [5080](5080-terminal-websocket-live-evidence.md); GW-11 done 2026-11-05, its live checks are in [5840](5840-relayed-events-live-evidence.md); GW-15 done 2026-11-05, a revalidation by date alone is [6160](6160-static-if-modified-since-compression.md); GW-10 declined 2026-11-05 on first-load numbers, with the rewriter unchanged).
12. **Local desktop transport**: local windows on the filtered gateway transport, and the IPC payload costs (DK-1, DK-2, DK-5, DK-6). Status: done (DK-1, DK-2 and DK-5 on 2026-11-04 behind a setting that is off by default; DK-6 fixed on 2026-11-04 by tunnel v2, [4500](4500-preview-tunnel-one-socket-per-connection.md); the default flip is [4501](4501-local-window-transport-default.md)).
13. **Toolchain startup and downloads**: stamp-based verification and resumable downloads (DK-3, DK-4). Status: done (2026-11-03; Electron launch-to-ready 10.2–13.8 s before, 1.6–1.9 s after; a cold-cache run still needs live evidence).
14. **Docker image size**: layer order, the second Bun, npm caches, the leftover apt layer and the second Claude binary (DK-7 to DK-11). Status: open, waiting on the maintainer's decision on DK-10 in [6780](../containers-and-environments/6780-second-claude-binary-in-the-image.md) (DK-7, DK-8, DK-9 and DK-11 done 2026-11-02; amd64 image smoke and Docker qualification passed; DK-10 left for a maintainer decision, now [6780](../containers-and-environments/6780-second-claude-binary-in-the-image.md)).
15. **Container data transfer**: in-volume clone move, a per-project mirror, agent-home input stamps and same-device moves (DK-12 to DK-15). Status: done (2026-11-04; its follow-ups done 2026-11-05).
16. **CLI and logging**: conditional `--follow` reads, transport buffering and the log sink (DK-16 to DK-18). Status: done (DK-16 and DK-17 done 2026-11-03; DK-18, the log sink, done 2026-11-04).

### 1. Baseline and before-and-after numbers

**Problem.** Nine report items landed on 2026-11-01 with no measurement either side, and the larger tasks below are gated on numbers.

**Context.** Decided 2026-11-01: hybrid. Small fixes whose mechanism is plain ship without waiting; structural tasks (4, 5's TX-1 and TX-2, 12, 13, 15 and the co-process half of 8) need a baseline first, except that the maintainer chose to do the container work in tasks 8 and 15 now.

**Investigation.** The instruments exist (the report's "Measuring before changing"): `get_recurring_work_diagnostics` and the `recurringWork` metrics block (storage-read bytes, docker-exec, gh-spawn per job kind), the gateway metrics, the change-tracking capture benchmark, a React Profiler run and launch-to-ready timing. None was run in this round. Only the old code is available for "before" now by checking out `0bd214ee`. Run on macOS on 2026-11-06, below; what could not be run there, and why, is the last table of "Before and after on macOS".

**Decisions.**

- **How to get "before" numbers for work already done?**
  - **Run each measurement on `0bd214ee` and on the branch that landed the work, in an isolated `dev:test` profile (recommended).**
    - Pros: a real comparison; both commits are known.
    - Cons: two profile runs per measurement.
  - **Measure only from now on.**
    - Pros: half the work.
    - Cons: the first batch is never shown to have helped.

#### Baselines for ST-13 and BG-15 (2026-11-06)

Taken with the changes of tasks 7 (ST-13) and 8 (BG-15), as decided above: the same measurement on `main` at `c1724ab74` and on branch `storage-mail-maintenance-3b173b35c92e-r1`. The bench figures are in those tasks. Live, on isolated `dev:test` profiles (`--fixture --no-agent-credentials --agent-platforms codex`, macOS, the shared build host), one profile per side and run:

1. Start the profile, stop it, and leave 256 MiB of free pages in its own `orkestrator.sqlite` (`output/benchmarks/st13/seed-free-pages.ts`, not committed): either one table dropped, or a kept table with every other row deleted ("interleaved"), so a release has to move pages rather than truncate.
2. Start it again. The first snapshot check, with its upkeep, runs 600 s after the backend starts.
3. Take a diagnostics bundle (`orkestrator --profile <name> diagnostics export`) before and after the check, for the backend's own event-loop sampler (500 ms ticks) and the database figures, and fetch the gateway's login page (unauthenticated, served by the backend's event loop) every 20 ms for 45 s before the check and 180 s from 5 s before it.
4. `dev:stop` and `dev:reset` the profile. Base and branch ran one after the other, except the interleaved pair, which ran concurrently with checks six minutes apart.

| Run | Gateway latency during the check: p50 / p99 / max | Requests over 50 / 100 ms | Free pages before → after | File after the check |
| --- | --- | --- | --- | --- |
| Base, interleaved | 0.6 / 17.5 / 686.2 ms | 9 / 5 | 32,767 → 0 | 136 MB |
| Branch, interleaved | 0.7 / 14.9 / 37.9 ms | 0 / 0 | 32,767 → 0 | 136 MB |
| Base, dropped table | 0.3 / 10.7 / 41.7 ms | 0 / 0 | 65,696 → 0 | 270 MB |
| Branch, dropped table | 0.7 / 14.3 / 33.1 ms | 0 / 0 | 65,696 → 0 | 0.8 MB |

Before the checks the same probe saw at most 12–30 ms on every profile. With the free pages at the end of the file (a dropped table) the old in-process release cost the loop little, since it had nothing to move, but left the file at 270 MB until a later checkpoint; the child's per-step checkpoint returned the space at once. With interleaved free pages the old release held the backend for up to 686 ms; the child kept every request under 38 ms. The backend's own sampler, too coarse for these stalls, counted at most one more tick 100 ms or more late across each check window on either side. An earlier pair without the gateway probe (dropped table) agreed: free pages to 0, file 270 MB → 0.8 MB on the branch, unchanged on base. BG-15 had no live baseline then: a claude-tmux tab needs a signed-in Claude CLI and a delivered message starts a turn, which that round could not do. It was taken later the same day with a loopback fake model; see the next section.

#### Before and after on macOS (2026-11-06)

Measured 2026-11-06 on the macOS build host (Mac17,16, 18 cores, 64 GiB,
macOS 27.2, Docker Desktop 29.9.2). The host is shared with other agents'
builds: its load average was 9–45 during these runs, so timings are noisy and
counts are the firmer evidence. **Base** is `0bd214ee`, the commit this to-do
was analysed against, before the first batch; **after** is `main` at
`ee2cc8423`, with every task here landed up to that day. Each side ran from
its own detached worktree under `output/benchmarks/` (installed with
`bun install --frozen-lockfile`, removed afterwards). Every profile was an
isolated, credential-free `dev:test` profile with
`ORKESTRATOR_HOST_REACHABILITY_CHECK=off`, stopped and reset after its run. No
provider was called: the only model was a loopback fake, and only BG-15 used
one. How to repeat each measurement is in
[the testing guide](../../development/testing-guide.md#before-and-after-across-commits).

**Idle recurring work, local fixture.** `scripts/recurring-live-ab.ts
--checkout <worktree> --label base|after --fixture-environments local
--agent-platforms codex`, merged with `scripts/recurring-live-ab-compare.ts`.
Per run: start the profile, settle 60 s, sample `recurringWork` and the
backend and Electron processes every 30 s for 6 minutes. Two runs per side,
alternating base and after. The Electron window was visible on both sides,
because base's launcher has no `--headless` (`--window launcher-default` on
base, `--window visible` on after). Base's backend was given one line, the
`ORKESTRATOR_HOST_REACHABILITY_CHECK` entry in its agent-test environment
allowlist, so that its boot probe made no Docker networks. The edit-to-detection
probes did not run on either side (the scratch worktrees had no built CLI).
The rates that differ by more than run-to-run noise, plus the busiest kinds:

| Per minute, idle (2 runs a side) | Base `0bd214ee` | After `ee2cc8423` |
| --- | --- | --- |
| `diff-scan`: starts / git processes | 0.5 / 4 | 0.5 / 3 |
| `mail-presence`: starts / store revision checks (`storage-stat`) | 30 / 30 | 30 / 60 |
| `mail-injection`: starts / store revision checks | 30 / 62 | 30 / 62 |
| `native-activity-sweep`: starts / storage reads | 30 / 30 | 30 / 30 |
| `claude-state-reconcile`: starts / storage reads | 30 / 30 | 30 / 30 |
| `tab-cleanup`: tmux / other processes / output bytes | 0 / 0 / 0 | 1 / 0.5–1 / 50–93 KB |
| `system-usage-sample`: processes | 9.2 | 8.8–9.3 |
| Backend CPU, ms | 183–248 | 168–253 |
| Backend RSS, median MiB | 175–184 | 252–263 |
| Electron (whole tree) CPU, ms | 515–605 | 478–708 |

All 20 kinds started at the same rate on both sides, and no kind that reads
storage fetched any bytes from the database (their `bytes` stayed 0). The
other kinds' `bytes` are command output: `diff-scan` 158 bytes a minute on
base and 61 on after, and after's tab cleanup read 50–93 KB a minute of
command output that base's did not. So an idle profile
with one local environment and no tabs, mail, queues or PRs costs the same
on both commits apart from the rows above. That is expected: what tasks 2,
3, 8, 9 and 10 removed is per-item work (keyed reads of large stores, per
mailbox, per tab, per PR, per working session), and a fresh fixture has
almost none of those items. A keyed read of a store that does not exist yet
is not even counted (see BG-15 below). The `diff-scan` drop is ST-14 and
ST-15's warm scan (below). The extra presence check, the tab-cleanup spawns
and the higher backend RSS on after were not traced here.

**Idle recurring work, container fixture.** The same with `--fixture-environments local,container`
(each profile also builds its own image tag, from Docker's cache), one run
per side, with no other profile of this work running:

| Per minute, idle, one local and one container environment | Base `0bd214ee` | After `ee2cc8423` |
| --- | --- | --- |
| `diff-scan`: starts / git processes / `docker exec` | 1.5 / 4 / 1 | 1.5 / 3 / 1 |
| `tmux-poll`: starts / `docker exec` / storage reads | 2 / 2 / 2 | 2 / 2 / 2 |
| `tab-cleanup`: `docker exec` / tmux / other processes / storage reads | 0 / 0 / 0 / 5 | 5 / 1 / 1 / 7 |
| `mail-presence`: store revision checks | 30 | 60 |
| Backend CPU, ms / RSS median, MiB | 203 / 274 | 205 / 281 |

The container polls the report named (BG-1, BG-2, BG-8) cost the same here,
2 `docker exec` a minute for `tmux-poll` and 1 for the container diff scan;
task 8 measured their saving per open tmux tab, and this idle profile had no
tab open. (Corrected 2026-11-10: `tmux-poll` is the per-container Claude
state poll, BG-7's subject, not a tab loop, and the claude-tmux tab loop has
no recurring kind on either commit; the Linux section below counts the
container's execs from Docker instead.) After's
`tab-cleanup` makes 5 `docker exec` a minute that base's did not; that is
new work on an idle container environment and is
[7531](../containers-and-environments/7531-idle-tab-cleanup-execs.md).

**BG-15, a real claude-tmux tab on a loopback fake model.** Base here is
`c1724ab74` (the commit BG-15 was measured against) and after is this branch
(`main` at `ee2cc8423` plus the fix); both carry the isolation fix in Assumptions and decisions, cherry-picked on
base. `scripts/tmux-mail-inject-live.ts` on a fresh profile per pass
(`--fixture --fixture-environments local --no-agent-credentials
--agent-platforms claude --headless`): the real Claude CLI in tmux, pointed
by the profile's own isolated Claude directory at
`e2e/agent-testing/fake-anthropic-model.ts`. Mail injection on, one queued
prompt and one draft to create the queue and draft stores, 30 s idle, then 5
messages one at a time. Two alternating pairs:

| Per delivery, **fake model** | Base `c1724ab74` | After |
| --- | --- | --- |
| `mail-injection` storage reads in the delivery window | 27–28 | 25–26 |
| Beyond the idle pass's 1.07 reads, per pass in the window | 23.8 (23.7–24.8) | 21.8 (21.8–22.8) |
| Sent to typed | 508–522 ms | 507–522 ms |
| Model calls per message | 1 | 1 |
| Mail sent while a draft was saved | held, then typed once the draft was cleared | the same |

Two fewer reads per delivery, as the fake-tab bench found (9 → 7), with the
fresh liveness probe and the draft hold unchanged; mail was typed once into a
live idle session every time. Base's window held 27 reads in 7 of 10
deliveries and after's 25 in 8 of 10, with 3–4 drain passes per window on
base and 3 on after. A third after pass, whose base partner lost its priming
prompt, read 25 in every window. Draft-held mail was typed 16.0–16.8 s
(base) and 15.8–17.0 s (after) after it was sent, once the draft was
cleared, with one model call.

Two earlier passes per side without the priming step read 19–20 per window on
both sides: a keyed read of a store that was never written returns before it
is counted (`readStoreRow` in `storage-database.ts`), and a fresh profile has
no prompt-queue or compose-draft store, so the reads BG-15 removed could not
show. A tab's user creates both stores the first time they queue a prompt or
type a draft. Not exercised live: the `queue` hold, which needs the tab busy
while a prompt waits; the drainer's focused tests cover it. One base pass lost
the priming prompt it queued the moment the tab first reported idle; the
script now waits 10 s first, and every later pass primed. The cause was not
established. To-do 7211, which asked for this check, is folded in here.

**Change tracking on macOS (ST-1 to ST-4).** Task 7's capture figures were
Linux only. The base commit's own `scripts/benchmark-change-tracking.ts`, run
on both trees (the current script needs exports base lacks), with one
addition on both sides: the current script's 2.5 s fixture settle before the
first capture, without which a tree with ST-3's stat-stamp settle window
cannot reuse a stamp. `--sizes=1000,10000 --runs=7`, three interleaved rounds
per side:

| Capture, one file changed, p50 | Base `0bd214ee` | After `ee2cc8423` |
| --- | --- | --- |
| Warm, 10,000 files | 1,842 / 2,141 / 2,822 ms | 1,130 / 1,315 / 1,539 ms |
| Warm, 1,000 files | 171 / 211 / 256 ms | 142 / 167 / 191 ms |
| Cold, 10,000 files | 3,989 / 5,263 / 5,774 ms | 4,021 / 4,675 / 5,849 ms |

The warm capture over 10,000 files takes about 40% less time on macOS (means
2,268 and 1,328 ms; on Linux 681–797 to 211–319 ms, measured 2026-11-04 with
that change's own script). The 1,000-file and cold
captures overlap between sides on this loaded host. Two earlier rounds
without the settle disagreed with each other (10,000 files warm: base 1,960
and 1,572 ms, after 1,164 and 1,801 ms), which is why the settle was added.

**Local diff scan on macOS (ST-14, ST-15).** `scripts/benchmark-local-diff-scan.ts
--runs=20 --core=<each worktree's apps/backend/src/core>`, workload `scan-1k`,
two interleaved rounds per side:

| Warm scan, `scan-1k` | Base `0bd214ee` | After `ee2cc8423` |
| --- | --- | --- |
| git processes per scan | 6 (2 `diff`, 3 `rev-parse`, 1 `status`) | 4 (1 each of `config`, `diff`, `rev-parse`, `status`) |
| Untracked files read per scan | 200 of 200 | 0 of 200 |
| p50, commit base / tracking base | 60–62 / 56–57 ms | 70 / 54 ms |

The counts match Linux (there the base, `a8bdce444`, spawned 7). The time did
not improve on macOS: against a commit base after was about 9 ms slower at
p50 on this host.

**Image size on macOS (DK-7 to DK-9).** Task 14's own pair, rebuilt natively
on this host: Docker Desktop 29.9.2, its linux/arm64 VM (18 CPUs, 7.7 GiB),
containerd image store, load average about 40 from other builds. **Before**
is `d6040915c`, `main` just before the change merged; **after** is
`fd679c0e2`, the merge of the change (#1623). Each side was a detached
worktree under `output/benchmarks/`, built with `docker build $(bun
scripts/docker-image-build-args.ts) -f docker/Dockerfile .` under a tag of
its own; both builds passed the Chromium launch check as uid 0 and uid 1000.
Sizes are uncompressed bytes from `scripts/docker-image-layers.ts report`
(`docker image inspect`, `docker history --human=false` and `du -sxk` in a
`--network none` container). The re-pull row is the same probe as on Linux:
a line appended to all five `bridges/*/src/index.ts`, each side rebuilt with
the same builder and build arguments, and `scripts/docker-image-layers.ts
changed` summing the probe image's layers the unprobed image does not hold.
The four tags and both worktrees were removed afterwards; Docker's build
cache was left alone. How to repeat it is in
[the testing guide](../../development/testing-guide.md#image-and-layer-sizes).

| linux/arm64, Docker Desktop on macOS | Before `d6040915c` | After `fd679c0e2` |
| --- | --- | --- |
| Image size | 6,299,627,181 bytes (69 layers) | 5,356,714,300 bytes (72 layers): −942,912,881, −15.0% |
| `/home/node/.npm` | 365.0 MB | 41 KB |
| Second Bun (`/usr/local/share/mise/installs/bun`) | 107.4 MB, plus 51.7 MB in `/root/.cache/mise` | 4 KB, plus 8 KB of symlinks in `/opt/bun`; 20 KB in `/root/.cache/mise` |
| mise layer | 302.0 MB | 142.9 MB |
| Claude Code npm layer | 442.0 MB | 300.1 MB |
| Codex npm layer | 592.1 MB | 408.9 MB |
| Playwright npm layer | 59.2 MB | 19.4 MB |
| Re-pulled when all five bridges change | 883.2 MB (40 of 69 layers) | 24.2 MB (38 of 72 layers: the five bundles, 3.0 to 9.1 MB, and small script layers) |

The same savings as linux/amd64 (6,411 → 5,452 MB, re-pull 895 → 22.8 MB),
within a few per cent per row; the arm64 base and CLI builds are a little
smaller. The vendored SDK layers (claude 302 MB, pi 193 MB, cursor 51 MB)
kept their digests across the probe rebuild here too. Not run on these
images: `docker/tests/final-image-smoke.sh` and the Docker agent suite, so
this is a size measurement, not an arm64 qualification (task 14).

**Environment activity RPCs on macOS (WEB-3).** Measured 2026-11-06 on
Mac17,16, 18 cores, darwin/arm64, using the composite pair without source
patches: before `0bd214ee435f7d4fa90bcd46b93c0ce93e8cd32e`, after
`ee2cc84234aa2d1d0fe064811e0a7975da629520`. Fresh profiles
`web3-before-602438` and `web3-after-602438`, each with exactly one seeded
local environment, `--fixture --fixture-environments local
--no-agent-credentials --agent-platforms claude` and
`ORKESTRATOR_HOST_REACHABILITY_CHECK=off`. Electron visible on both sides
(base predates the window flag; after used `--no-headless`); the measured
client was a headless Chromium gateway browser at 1440 × 1000.

`scripts/web3-activity-rpc-live.ts` points only the profile's Claude directory
at a loopback Anthropic endpoint, opens a real native Claude tab and sends
two held turns. Each boundary waits for the browser's `agentActivityState`
to become working or idle, then allows 3 seconds for boundary requests to
settle before taking the gateway `/metrics` per-command counter delta. The
quiet control window made no list RPCs. Each side recorded exactly two model
calls; no real provider, credential grant or login was used.

| RPCs in each boundary window, cycles 1 / 2 | Before `0bd214ee` | After `ee2cc8423` |
| --- | --- | --- |
| Idle → working, `list_prompt_queues` | 2 / 2 | 0 / 0 |
| Idle → working, `list_multi_review_workflows` | 2 / 2 | 0 / 0 |
| Working → idle, `list_prompt_queues` | 7 / 7 | 0 / 0 |
| Working → idle, `list_multi_review_workflows` | 7 / 7 | 0 / 0 |

These are observed window counts, not a claim that one transition always
causes 14 RPCs: base also received 2 environment snapshot requests entering
working and 6 returning idle. Its two App hydrators rerun on each replaced
array, including repeated snapshots. After received 2 entering and 3–4
returning, with no list refetches. The original report's third list no longer
exists on either pinned commit. Total gateway command RPCs, including
transcript polling and other unrelated work, were 53 / 41 entering and
41 / 43 returning on base, versus 29 / 23 and 14 / 14 after; those totals
are timing-dependent and cannot be attributed to WEB-3 alone.

Artifacts: `output/benchmarks/web3-before.json` and `web3-after.json` (counts
only). The first after attempt stopped before measurement because a delayed
startup notice intercepted the sidebar click. The driver was fixed to wait
for notices to clear, and the same logged command passed on a fresh profile.
Both profiles were stopped/reset and the scratch worktrees removed. Reuse
and cleanup commands are in [the testing guide](../../development/testing-guide.md#environment-activity-rpc-counts-web-3).

#### A container tab and a busy profile on Linux (2026-11-10)

Measured 2026-11-10 on beelink (Linux 7.1.8 x86_64, 16 cores, Bun 1.4.4,
Docker Engine 29.9.2 rootful, load average 1–4 at the start and higher while
other pipelines ran). **Base** is `0bd214ee` again; **after** is `main` at
`c98b20e6f`. Base ran from a detached worktree under `output/benchmarks/`
with the same one-line allowlist addition as on macOS, its launcher kept
headless by an `ELECTRON_OVERRIDE_DIST_PATH` wrapper (decision below); after
used `dev:test --headless`. Every profile was isolated and credential-free
(`--no-agent-credentials`) with `ORKESTRATOR_HOST_REACHABILITY_CHECK=off`,
and Docker went through the test-only `docker-qualification-bin` shim. No
provider was called: the models were loopback fakes, Claude's inside the
container and Pi's in the driver. All four profiles were stopped and reset,
the two image tags this run built were removed and the base worktree deleted.
Two Electron core dumps from after's headless Electron (to-do
[7554](7554-headless-dev-electron-core-dumps-in-checkout.md)) were kept out
of the commit. How to repeat both drivers is in
[the testing guide](../../development/testing-guide.md#a-claude-tmux-tab-in-a-container-and-per-item-counts-on-a-busy-profile).

**A claude-tmux tab in a container (BG-1, BG-2, BG-7, BG-8).**
`scripts/container-tmux-tab-live.ts` on a profile with
`--fixture-environments local,container --agent-platforms claude`, each side
on the image its own launcher built (after: `orkestrator-v2:dev-f8b64553848e`,
`docker:build:dev` of this worktree, declaring `tmux-hook-signal=1` and
`claude-state-signal=3`; base: its `dev:test`'s plain build, capabilities
label `unverified`). The image's real `claude` in tmux, its model the
container-local fake. Windows of 120 s (the stopped one 60 s), counting every
`docker exec` Docker reported for the container. The backend's own counters
could not be compared: the claude-tmux tab loop has no recurring kind on
either commit (`tmux-poll` is the per-container Claude state poll), so after
charged 64–65 execs a minute to its counters while Docker saw 124.5–128.5. Two
counted passes per side; three earlier passes without the Docker count (two
after, one base) gave the same counter rates.

| Container `docker exec` per minute | Base `0bd214ee` | After `c98b20e6f` |
| --- | --- | --- |
| No tab open | 69.5 / 69.5 | 11 / 14 |
| Idle tab before its first prompt (no transcript yet, checked) | 471.0 / 469.5 | 124.5 / 125.0 |
| Idle tab, transcript bound (checked) | 297.0 / 354.0 | 128.5 / 128.5 |
| Three queued turns (after's took ~4.7 s each; see Turns) | 477.7 / 511.9 | 351.9 / 352.1 |
| From an outside `docker stop`, 60 s | 0 / 1 | 0 / 0 |
| `docker stop` to stored status `stopped` | 386 / 507 ms | 300 / 318 ms (391 and 456 ms uncounted) |

What makes up the idle rows, per minute, from Docker's labels:

| Idle, per minute | Base | After |
| --- | --- | --- |
| Claude state poll (`tmux-poll`, `sh -c if …`) | 60, tab or not | 2 without a tab, 60 with one (BG-7) |
| Tab loop, before the first prompt | 402–404: snapshot, `test`, `stat` and the transcript `find` each ~86, `has-session` 41, `capture-pane` 17.5 | 59–59.5: snapshot 53.5, `find` 5.5–6 (every ~10 s, BG-1) |
| Tab loop, transcript bound | 230–289: snapshot ~160, `has-session` 50, `capture-pane` 18.5–79.5 | 56.5–57: the snapshot alone (BG-2) |
| Diff scan, tab cleanup and the rest | ~9 | ~9 |

- **BG-1 and BG-2.** An idle tab's own loop went from 3.8–6.7 execs a
  second to 0.94–0.99, with the transcript search down to one every ten
  seconds and gone once the transcript binds. That is task 8's one-exec poll
  (1.01/s bound, 1.12/s unbound in `tmux-exec-count.ts`), not its doorbell
  rate (0.42/s): the tab never went quieter than one snapshot a second,
  which is what an unconfirmed doorbell does. Task 8 records that this host's
  containers cannot reach the backend; the doorbell's state was not read
  here. The doorbell rate live still needs a host whose containers reach the
  backend (open in task 1).
- **BG-7.** With no tab, base polled the container's Claude state every
  second (60 a minute) and after twice a minute. On macOS the same base made
  2 a minute, presumably because its state signal could ring there; on this
  host the signal falls back to the poll on both commits, so after's saving
  is the BG-7 cadence rule. With a tab open both poll every second.
- **BG-8.** Not separable here. An outside `docker stop` moved the stored
  status to `stopped` in 0.3–0.5 s and every loop stopped execing on both
  commits; base's polls key on that status, so BG-8's reactor shows no
  difference in this scenario.
- **Turns.** After's tab went busy 0.9 s after a queued prompt and idle again
  4.6–4.8 s after it, in every turn. In two of three base passes the tab
  still reported busy when the wait for idle ran out (120 s, which ended the
  first pass, and 90 s for every turn of the third); the other base pass
  went idle like after's. Not investigated on base.
- **Tab cleanup on base.** Base's idle container made the same 5 cleanup execs
  a minute as after's (`rm` 2, `tmux list-sessions` 1, `ps` 1, `test` 1)
  without charging them to `tab-cleanup`; that answers part of
  [7531](../containers-and-environments/7531-idle-tab-cleanup-execs.md).
- **Not counted anywhere.** The tab loop's missing recurring kind, and
  after's extra presence reads below, are
  [7562](../transcripts-and-observation/7562-tmux-tab-loop-recurring-kind.md).

**Busy profile: per-pass costs (tasks 2 and 10).** The 0048 busy driver
(`recurring-live-ab.ts --arms candidate --busy-rounds 3 --busy-clients 0
--busy-environments 10 --fixture-environments local --agent-platforms pi
--keep-profiles`), one run per side, each on a fresh profile. Base used its
own CLI (decision below). Both sides kept every obligation the driver checks
except base's Multi Review, which base's CLI did not launch in any round
(`the review did not launch`); after ran three reviews to `ready`. 3 held
turns, 3 queued prompts, 3 approvals and 3 mails a side, no duplicate
dispatch, no guard line. Counter deltas between the first and last round
boundary (12.9 s of busy work on base, 30.3 s on after, which also ran the
reviews):

| Busy phase, per pass | Base | After |
| --- | --- | --- |
| `native-activity-sweep`: storage reads / bytes fetched | 45 / 13,727 (6 passes) | 40 / 5,855 (15 passes) |
| `native-queue-scan`: storage reads / bytes fetched | 11.8 / 1,129 (18) | 7.6 / 571 (22) |
| `mail-presence`: storage reads | 7.8 (6) | 9.9 (15) |
| `mail-injection`: storage reads | 1.0 (17) | 1.04 (27) |

So with the reviews' sessions also in its stores, after's activity
sweep fetched 57% fewer bytes from the database per pass and its queue scan
49% fewer, with fewer row reads: the shared decoded snapshot and keyed
session reads of task 2 (BG-5, TX-4) seen live.

**Populated and stopped (BG-3, ST-7).** `scripts/busy-item-counts-live.ts` on
each side's kept busy profile, restarted: 180 s with everything running,
then 180 s with the nine `busy-*` environments stopped through
`environment.stop`. Each profile had two mailboxes (the Pi tabs in `busy-1`
and `busy-ask`), both in stopped environments; base had 11 environments,
after 10.

| Per pass (30 a minute) | Base, running | Base, 9 stopped | After, running | After, 9 stopped |
| --- | --- | --- | --- | --- |
| `mail-presence` storage reads | 7.0 | 7.0 | 9.0 | 3.0 |
| `mail-presence` store revision checks | 1 | 1 | 2 | 2 |
| `native-activity-sweep` storage reads | 2.24 | 2.0 | 2.24 | 2.0 |
| `diff-scan` starts / git processes, per minute | 20.3 / 42.6 | 20.3 / 42.7 | 6.7 / 40 | 3.3 / 20 |
| Bytes fetched by any storage kind | 0 | 0 | 0 | 0 |

- **BG-3 live.** Stopping both mailboxes' environments took after's
  presence pass from 9 reads to 3; base's stayed at 7. That is the skip task
  10 counted in unit tests (a stopped environment's mailbox, 1 read a pass
  to 0), on a real profile.
- **ST-7.** Every storage read in these idle windows was answered without
  fetching bytes, on both sides, so the populated stores cost reads, not
  bytes. After's presence pass reads two more rows and checks the store
  revision twice where base does once (the doubled check was already seen
  idle on macOS); neither was traced (7562 task 2).
- **Diff scans.** Base rescanned every environment, stopped or not; after
  scanned a third as often and halved again once they stopped.
- **Not exercised:** BG-9 needs a working Claude or Codex session (Pi
  reports no content revision, so the monitor reads it every pass on both
  commits); BG-11 needs a build pipeline; BG-12 needs a container Claude
  login. See the table below.

**What else the report asked for, and where it stands.**

| Measurement | Items | Status |
| --- | --- | --- |
| `storage-read` bytes for `mail-presence` and `activity` | ST-7 | Measured idle (macOS) and on a populated busy profile (Linux, 2026-11-10, above): idle windows fetch no bytes on either side even with stores full; during the busy phase the activity sweep fetched 13.7 → 5.9 KB a pass and the queue scan 1.1 → 0.6 KB. After's presence pass reads 2 more cached rows than base's (7562 task 2). Done. |
| `docker-exec` with an idle tmux tab | BG-1, BG-2, BG-8 | Measured on Linux 2026-11-10 (above) with a claude-tmux tab in the container on a container-local fake model, counted by Docker: idle tab 297–471 → 124.5–128.5 execs a minute for the whole container, the tab's own loop 3.8–6.7 → 0.94–0.99 a second. Open: the doorbell rate (BG-2's 0.42/s in task 8) on a host whose containers reach the backend, which beelink's do not. BG-8 showed no difference on an outside `docker stop` (both commits stop within 0.5 s). |
| `gh-spawn` per hour | BG-6, BG-13 (task 9) | Not measurable on an isolated profile: the fixture has no GitHub remote or PR, and the profile's `gh` configuration is isolated by design. It needs a real PR and a `gh` login, whose requests go to GitHub on the user's account. |
| Live counts for BG-3, BG-9, BG-11, BG-12 (task 10) | | BG-3 measured on Linux 2026-11-10 (above): with both mailboxes' environments stopped, presence reads per pass 9 → 3 on after, 7 → 7 on base. Open: BG-9 needs a working Claude or Codex session on a loopback model (the busy driver's Pi reports no revision; agent-doable); BG-11 a build pipeline (it needs Codex or a ticket-driven pipeline); BG-12 a real Claude login handed to a container (the user's). Their unit counts in task 10 stand. |
| React Profiler, two tabs idle and streaming | WEB-2, WEB-5, WEB-7 | Answered 2026-11-05 by E12 (see Needs verification); production React not measured. |
| Backend RPCs per environment activity transition | WEB-3 | Measured on macOS 2026-11-06 (above): one environment, two native loopback turns per side. `list_prompt_queues` plus `list_multi_review_workflows`: idle → working 4 → 0 RPCs; working → idle 14 → 0, identical in both cycles. Gateway browser client, pinned `0bd214ee` against `ee2cc8423`; counts include repeated snapshots within each transition window. |
| Launch to ready, warm and cold page cache | DK-3 (task 13) | Warm measured 2026-11-03 (task 13). Cold not possible here: dropping the page cache on macOS needs `sudo purge`, and this session has no root. |
| `docker history` and `du` in the image | DK-7 to DK-9 (task 14) | Measured 2026-11-02 on linux/amd64 (task 14) and 2026-11-06 on macOS, linux/arm64 under Docker Desktop (above): −15% on both, re-pull 883 → 24.2 MB on arm64. |
| Gateway SSE and WebSocket bytes | GW-2, GW-6, GW-7 | Owned by [0052](../transcripts-and-observation/0052-remote-client-bandwidth.md). |
| Snapshot rate and bytes per send | TX-1, TX-2 (task 5) | TX-1 measured live in E10 ([6680](../transcripts-and-observation/6680-conditional-reads-and-deltas-measured.md)); TX-2 with a provider fake in E9, live bytes per send in [5340](../transcripts-and-observation/5340-transcript-reads-live-evidence.md) task 1. |

### 2. Storage keyed reads and writes

**Problem.** Some keyed paths still decode or rewrite a whole store for one row.

**Context.** Done: `getEnvironment`, `getNativeAgentSession`, `getPromptQueue`, `getComposeDraft`, `getPaneLayout` and `getSession` read one row (`loadStoreRow`), and `updateStoreRow` carries a cached store forward (`storage-database.ts`). SQLite pragmas (ST-12) were decided 2026-11-01: unchanged, revisited only if fsync cost still shows after this task. Done 2026-11-02 (branch `keyed-storage-row-e11a908a8276-r1`, re-checked against `main` at `38d55ee14`):

- BG-5: `FrozenStoreSnapshot` (`storage-frozen-snapshot.ts`) keeps one deeply frozen decoded copy per committed revision, re-decoding only rows whose serialized value changed, one copy per store and none above 64 MiB of serialized rows. `readEnvironmentsSnapshot` and `readNativeAgentSessionsSnapshot` serve it to the activity sweep and its read-only helpers (`runtimeStopRequested`, `hasObservedLiveWork`, `hasActiveCheckoutWork`), the interaction tracker sweep, the tmux reconcile, the human-prompt monitor's `workingSessions`, `workerProjection`, `workerSessionActivity` and the pending-rename reconcile (`commands-registry.ts`, every 2 s while an environment has a rename intent, else 30 s).
- ST-10, compose drafts: a save or single delete reads and writes only its row (`updateSensitiveStoreRow`, which keeps `saveSensitiveJson`'s archive pruning by journaling a keyed `prune-row` cleanup in the row's transaction); owner sweeps are one `updateStore` that writes nothing when the owner has no draft. The store lease stays.
- ST-11: `store_rows_position` on `(store, collection, position)`, created on open.

Done 2026-11-04 (branch `array-layout-writers-dd246b495d6d-r1`, re-checked against `main` at `96ee1eb3e`), ST-10's environment writers:

- `updateStoreRow` takes keyed array layouts (`storage-database.ts`): an update keeps the item's position, an insert goes last, a delete leaves the others in order, and a value must carry the row's key. A store held as a document falls back to the whole value, and an atomic scope applies the update to its buffered array (`applyArrayRowUpdate`).
- Every environment writer moved together. Each still holds the environment lease, reads its row (`getEnvironment`) and commits one row (`saveEnvironment`); writers of several environments commit only the rows they changed, in one transaction. `addEnvironment`, `fenceEmptyProjectForRemoval` and `reorderEnvironments` read one project's rows through the owner column. `saveEnvironments` as a whole-store write is gone, and so is `saveSensitiveJson`'s environment special case.
- Archive scrubs are now journaled with the row, closing a real gap: before this, a crash after the commit and before the scrub left the removed content in the archive until a caller happened to retry. The two new cleanup kinds, `delete-item` and `drop-item-field`, hold no row content.
- `storage-writer-guards.test.ts` reports the store as transactional and requires the environment lease on every row write (`LEASED_ROW_STORES`). A row write refuses a row that has gone since its read.
- Tests: `storage-database.test.ts` (array rows: insert, update, delete, order, owner, no-ops, key refusal, document fallback, rollback, mixing with whole-value writes); `storage-environment-row-writes.test.ts` (one field writes one row, counted by temporary SQLite triggers, with no whole-store read or write; each single-environment writer; concurrent connections; deletion fences; a SIGKILL between commit and scrub followed by a reopen; an older reader and writer on the same database).
- Older build, checked by hand on 2026-11-04 with `HEAD` code from `96ee1eb3e` in a temporary worktree against a temporary data directory: it opened a database this branch had written (schema version 6, unchanged), listed the environments in order, updated and added one, and this branch reopened the result. No before-and-after timing was taken (task 1).

Done 2026-11-04 (branch `store-writes-25e6fc826b9d-r1`, E6 of the efficiency batches), TX-4's rest, ST-10's session and project writers, and R20's blob length, read-only leases and usage prune. Each finding was re-checked against `main` at `e198fd4a7` first:

- TX-4: `loadNativeAgentSessions` had 32 call sites (20 in `storage-native.ts`, 12 in `storage-native-deliveries.ts`). 28 held a key's lease, 27 of them mutations and `readNativeAgentPublicationState` a read; all 28 now read one row, through `readNativeAgentSessionUnderLease` or, for the two sweeps that must pass over a bad record, `peekNativeAgentSession`. The other 4 walk the store and stay. Damaged JSON in a key's own row now refuses that key, before any provider create; before, it read as "no session". Damaged JSON in another key's row no longer makes every key read as absent. `readNativeAgentPublicationState` reads one queue row.
- ST-10, sessions: every writer commits only the rows it names in one transaction, reading the environment's rows by owner where it needs them. This also closes a loss: one damaged row used to make `updateStore` replace the whole store with the fallback, so the next session write lost every session.
- ST-10, projects: every writer keeps the lease and commits rows (`saveProject`); `getProject` reads one row. An add, a new remote and a new checkout path still read the whole store, since they compare against the others, and write one row. The store joined `LEASED_ROW_STORES`.
- Nothing about stored data changed: no schema version, no migration, no new stored value. An older build reads and writes these rows as before, and a store held as a document falls back to a whole-value write (`storage-session-project-row-writes.test.ts`).
- R20, sizes: see "Blob length" under Decisions. `length(CAST(value AS BLOB))` remains only as the fallback.
- R20, leases: `getAgentInteractionResolutionJournal` takes no lease. `pruneAgentInteractionResolutionJournal` is pure, and `build-pipeline-service-interactions.ts` copes with a stale read: a claim commits before the pending record that names it, and everything past the read goes through the processing lease. `resetAgentMailInjectBackoff` checks `store.snapshot()` first; a backoff committed just after the check is the same as one committed just after the reset.
- R20, prune: `prune` is asynchronous and commits 250 rows per transaction with `setImmediate` between batches. Each row is read and decided inside its transaction, which also fixes a lost update: the old sweep wrote back the record it had read earlier, and another backend's turn in between was lost. A closed connection ends the sweep without reopening it, and the next due sweep finishes.
- Tests: `storage-native-session-row-reads.test.ts`, `storage-session-project-row-writes.test.ts`, `storage-read-only-leases.test.ts`, the "retention sweep's batches" group of `usage-history-store.test.ts`, the size tests in `storage-database.test.ts`, and the journal test in `storage-native-agent-sessions.test.ts`, which replaces "orders a journal read against an in-flight update": that ordering is the behaviour the report's option removes. They cover concurrent writers across connections and across two real processes, a SIGKILL inside a multi-row transaction followed by an integrity check and a reopen, and a failure inside a transaction. Run against `e198fd4a7`, 16 of the 32 row-read, row-write and lease tests fail, among them every one-row assertion; the interrupted-write tests fail there only because they hook methods the base lacks.

Measured with `bun scripts/benchmark-store-writes.ts`, workload `store-writes-v1` (2,000 native sessions of 200 request ids, 5,000 terminal sessions in 500 environments, 500 projects, 64 display tails of 1 MiB, 500 mailboxes of 50 messages, 20,000 usage rows). Three interleaved runs of `e198fd4a7` and this branch, 50 operations per run, on macOS 27 arm64 with Bun 1.4.4 and generated data in the temporary directory. Times are the lowest and highest p50 of the three runs.

| Write path | Before (ms) | After (ms) | Rows written | Lease writes |
| --- | --- | --- | --- | --- |
| Native: activity checkpoint | 45.7–76.1 | 0.21–0.37 | 1 | 2 |
| Native: activity checkpoint, no change | 45.1–61.9 | 0.10–0.16 | 0 | 2 |
| Native: dispatch journal | 49.1–63.5 | 1.5–2.5 | 1 | 2 |
| Session: one field | 3.3–5.3 | 0.07–0.12 | 1 | 0 |
| Session: create, read the environment's rows, remove | 6.6–10.6 | 0.64–0.93 | 2 | 0 |
| Session: disconnect an environment | 4.0–6.4 | 0.31–0.43 | 10 | 0 |
| Session: reorder an environment | 4.0–6.0 | 0.55–0.71 | 10 | 0 |
| Project: one field | 0.60–0.85 | 0.19–0.35 | 1 | 2 |
| Project: new remote URL | 0.63–0.78 | 0.27–0.46 | 1 | 2 |
| Project: read one | 0.07–0.09 | 0.00–0.01 | 0 | 0 |
| Project: add and remove | 3.0–4.3 | 1.8–3.7 | 2 | 6 |
| Project: move one to the end of 500 | 3.4–4.8 | **5.8–8.7 (slower)** | 500 | 2 |
| Listing: 64 rows of 1 MiB, sizes only | 46–60 | 9.4–11.7 | 0 | 0 |
| Journal: read | 0.17–0.30 | 0.01 | 0 | 2 before, 0 after |
| Mail: backoff reset, nothing to reset | 9.8–13.5 | 0.00–0.01 | 0 | 2 before, 0 after |

| Usage prune, 20,000 rows, 10,000 changed | Before | After |
| --- | --- | --- |
| Total | 2,353–3,142 ms | 1,687–2,422 ms |
| Commits | 10,000 | 80 |
| Longest event-loop stall | 2,353–3,142 ms | 42–64 ms |
| Longest single commit | 10–87 ms | 38–64 ms |

The rows-written column does not move because the whole-value writers already diffed against the stored rows: what they paid per write was decoding and re-serializing the store. The real write rate and store sizes behind these numbers were not measured ([5101](5101-store-size-and-write-rate-live.md)), and the cold-cache listing cost and the fallback on an older macOS were not either ([5102](5102-sqlite-size-fallback-live.md)).

The E6 report was checked item by item and deleted; it stays in git history at base commit `48d2ed40c`, under `docs/reports/efficiency-logging-database/`. Every task and "Needs verification" item in that file, with its outcome (tests are under `apps/backend/src/core/`):

| Part | Item | Outcome | Code and test, evidence, or to-do |
| --- | --- | --- | --- |
| 0230 | Task 1: load one row inside the key's lease | Done, with one site moved to a to-do | Code: `readNativeAgentSessionUnderLease` and `peekNativeAgentSession` (`storage-native.ts`). Test: `storage-native-session-row-reads.test.ts`, "a mutation reads and writes only its own key" and "two backends writing one key and other keys lose nothing". A steer's prompt queue step could not move alone and was 5100, done 2026-11-05. |
| 0230 | Needs verification: which of the 32 call sites are mutations | Done | Classified above under TX-4: 28 held a key's lease (27 mutations, 1 read), 4 walk the store. Test: "whole-store loads remain only where the whole store is the question" in the same file. |
| 0470 | Task 1: row writes for array stores | Done, by #1736 | Code: keyed array layouts in `updateStoreRow` (`storage-database.ts`). Test: `storage-database.test.ts`, "StorageDatabase.updateStoreRow on a keyed array store". |
| 0470 | Task 2: move a store's writers together | Done | Environments, by #1736: `saveEnvironment` (`storage-projects.ts`), `storage-environment-row-writes.test.ts`. Sessions: `storage-drafts.ts`, `storage-sessions.ts`. Projects: `saveProject` (`storage-projects.ts`). Tests: `storage-session-project-row-writes.test.ts`, "one field writes one row and reads and writes nothing else" and "two connections writing sessions and projects lose no update"; `storage-session-project-row-writes.integration.test.ts`, "two processes writing the same rows lose no update" and the two "an interrupted write" kills; `storage-writer-guards.test.ts`. |
| 0470 | Needs verification: how large the environment store gets and how often it is written | Moved to a to-do | [5101](5101-store-size-and-write-rate-live.md): needs a real install, which this work could not touch. |
| 0870 | Task 1: stop reading whole values to size them | Done | Code: `rowBytesExpression` and the primary-key scan in `rows()` (`storage-database.ts`). Test: `storage-database.test.ts`, "a library without octet_length falls back to the cast, with the same answer", "production sizing falls back when the connection rejects octet_length" and "a sizes-only listing keeps the listing's order without an ordered scan". |
| 0870 | Task 2: remove leases taken only to read, journal read | Done | Code: `getAgentInteractionResolutionJournal` (`storage-native.ts`). Test: `storage-native-agent-sessions.test.ts`, "a journal read takes no lease and writes nothing". |
| 0870 | Task 2: remove leases taken only to read, no-op backoff reset | Done | Code: `resetAgentMailInjectBackoff` (`storage-agent-mail-injects.ts`). Test: `storage-read-only-leases.test.ts`, "nothing to reset takes no lease and writes nothing". |
| 0870 | Task 3: one transaction for the usage-history prune | Done, in batches as the report recommended | Code: `prune` and `USAGE_HISTORY_PRUNE_BATCH_ROWS` (`usage-history-store.ts`). Test: `usage-history-store.test.ts`, "commits a bounded batch at a time and frees the event loop between them" and "a turn recorded during the sweep is not lost". |
| 0870 | Needs verification: the overflow read cost was not timed | Done, cold cache moved to a to-do | Timed warm in the table above (46–60 ms to 9.4–11.7 ms). A cold-cache listing is [5102](5102-sqlite-size-fallback-live.md), task 2. |
| 0870 | Needs verification: SQLite version in Bun 1.4.4 on each platform | Partly checked, rest moved to a to-do | SQLite 3.54.0 on macOS 27 arm64 and 3.53.4 on Linux arm64 both have `octet_length`. The other platforms, and a real older macOS, are [5102](5102-sqlite-size-fallback-live.md), task 1. |

No item needed the outcome "no longer holds": each was still present in the code when re-checked, or had already been done by #1736, as the table says.

**Investigation.** Re-checked 2026-11-02 and, for environments, 2026-11-04. Background callers not moved to the snapshot either mutate what they read or pass it on to code not checked yet: `reconcilePendingLaunches` (launches environments), environment cleanup, the local-server reaper, diff stats, the PR monitor and the coordinator, goal and sign-in services. Mail presence was checked: it already reads one row per mailbox (`mailInjectPresence`). ST-9's remainder (pending injects as their own collection, a body-free mailbox list) was re-checked and measured on 2026-11-05: still true, and not justified at known store sizes ([6760](6760-agent-mail-store-split-thresholds.md)).

**Decisions.**

- **How to share decoded stores between background readers (BG-5)?** Done as recommended.
  - **One frozen decoded snapshot per store revision, the pattern #1423 used for mail (recommended).**
    - Pros: proven here; callers cannot mutate shared state.
    - Cons: callers that mutate their result must copy first, so each caller has to be checked.
  - **Pass one snapshot per sweep through each job's arguments.**
    - Pros: no cache.
    - Cons: touches every job signature; does not help unrelated jobs in the same second.
- **BG-5: replace `listNativeAgentSessions` itself, or add snapshot reads beside it?** Decided 2026-11-02: beside it.
  - **New `read*Snapshot` methods, moving callers one at a time once each is checked (recommended).**
    - Pros: a caller is moved only when it is known not to write; the test harnesses of the moved callers return frozen data, so a write fails there.
    - Cons: two read paths per store; unmoved callers still decode the store.
  - **Make `listNativeAgentSessions` (and later `loadEnvironments`) return the frozen copy.**
    - Pros: every caller benefits at once.
    - Cons: 30 callers, several of which pass records to code that may write them; a missed one throws in production.
- **ST-10, compose drafts: drop the store lease?** Decided 2026-11-02: keep it.
  - **Keep the lease; one row read and write inside it (recommended).**
    - Pros: saves stay ordered against the owner checks they await and against the owner deletion sweeps, exactly as before.
    - Cons: still one lease claim and release per save.
  - **A per-key lease, with the owner fences re-checked inside the row transaction.**
    - Pros: drafts of different tabs save concurrently, and a save costs no store-wide lease.
    - Cons: needs synchronous fences for project removal and coordinator conversation close that do not exist today.
- **ST-10, compose drafts: how to keep the retired JSON archive pruning?** Decided 2026-11-02: journaled with the row.
  - **`updateSensitiveStoreRow`: journal a keyed pruning intent (`prune-row`) in the same transaction as the row update, through the existing durable cleanup journal (`commitWithLegacyJsonCleanup`, `storage-stores.ts`), or one whole-value `prune` intent when the store was unreadable; inside `atomically()` the intent joins the scope's cleanups and commits with it (recommended).**
    - Pros: the same pruning a whole-value save did, for one record, with the same recovery guarantee: an interrupted or failed pruning is replayed on reopen or before the next journaled write, before another mutation (a later re-add included) can obscure the removal; nothing is read when no archive is left (it expires 14 days after migration).
    - Cons: one more cleanup variant in the journal, and each journaled save stores a copy of the row's new value in the private cleanup store until the pruning finishes.
  - **Prune after the row commits, with no durable intent.**
    - Pros: smaller; no journal entry per save.
    - Cons: a crash or an archive write failure between the two leaves removed sensitive content in that archived copy until it expires.
  - **Fall back to the whole-store save while an archive exists.**
    - Pros: byte-for-byte the old behaviour.
    - Cons: two kinds of writer for one store, which the writer guard refuses.
- **ST-11: index or a stored next position?** Decided 2026-11-02.
  - **An index on `(store, collection, position)`, created on open (recommended).**
    - Pros: no stored value or schema version changes, so an older build still opens the database; ordered row fetches use it too.
    - Cons: one more index to maintain on inserts and deletes; it is built once on the first open after the upgrade.
  - **A numbered migration, or the next position kept in `stores`.**
    - Pros: a migration follows the documented pattern.
    - Cons: a new version locks every older build out of the database, and a stored counter is new stored data to keep consistent.
- **ST-10's remaining writers: next step?** Environments done 2026-11-04 with the first option.
  - **Add array-layout `updateStoreRow` with tests, then move every environment writer at once (recommended).**
    - Pros: environments are the largest store written whole for one field.
    - Cons: one large change touching every environment mutation, its archive scrubs and the deletion fences.
  - **Move the record stores (sessions, projects) first.**
    - Pros: `updateStoreRow` already supports them.
    - Cons: smaller stores, so less gained.
- **ST-10, sessions and projects: next step?** Done 2026-11-04 with the first option.
  - **Move sessions next, then projects, each with its writer guard change (recommended).**
    - Pros: array row writes now exist for both; sessions change more often than projects.
    - Cons: sessions need a check of what `updateStore` callers rely on; a project reorder still writes many rows, and on the generated workload moving one project across 500 went from 3.4–4.8 ms to 5.8–8.7 ms.
  - **Leave them whole.**
    - Pros: no risk to two stores that are small on most installs.
    - Cons: the report's remaining ST-10 writers stay O(store) per field.
- **Blob length: how to size a value without reading it (R20, D7)?** Done 2026-11-04. The report's recommended `octet_length` no longer fitted alone, so this extends it.
  - **`octet_length(value)` with a fallback to the cast, plus a primary-key scan sorted in JavaScript for sizes-only listings (recommended, done).**
    - Pros: 46–60 ms to 9.4–11.7 ms at 64 rows of 1 MiB; no schema change; works on any SQLite, because the expression is chosen per connection.
    - Cons: an older SQLite keeps the cast's cost on the size expression; a JavaScript sort per listing; the SQL no longer states the order, so a test pins it.
  - **`octet_length(value)` alone, as the report recommended.**
    - Pros: one expression; the SQL keeps its `ORDER BY`.
    - Cons: measured to change little: 52.5 ms against 60.6 ms on macOS and 40.0 ms against 52.2 ms on Linux. A query with no size at all still took 52.9 ms and 35.9 ms, because `ORDER BY` walks `store_rows_position` and seeks each row, and a seek in this `WITHOUT ROWID` table reads whole cells, overflow pages included, to compare keys. It also fails at query time on a library older than 3.43.
  - **A stored `bytes` column.**
    - Pros: independent of the SQLite version.
    - Cons: a migration that locks out older builds, every writer path must keep it right, and the ordered seek would still read the cells.
  - **A separate listing without sizes for key-only callers.**
    - Pros: no version risk.
    - Cons: display tails and pipeline manifests read `bytes`, so they would still pay; the seek cost is the same either way.

### 3. Renderer re-renders and refetches

**Problem.** Several renderer paths serialise or re-render far more than changed.

**Context.** Done 2026-11-01: unchanged polls keep the identity object and the projection store's recency condition is gone (WEB-2); per-environment lists hydrate once per id and the status and PR setters skip no-ops (WEB-3, `useHydrateOncePerEnvironment.ts`). Done 2026-11-02, each re-checked against `main` at `38d55ee1` first (all five were still true; #1585's transcript rework did not touch `AgentInfoButton`), each with a test that fails on the previous code:

- WEB-4: `pane-layout-persistence.ts` skips an environment whose object and hydration are both unchanged before sanitising and serialising it (`pane-layout-persistence.unchanged.test.ts`: a write to one environment serialised the other's layout once per write before).
- WEB-5: a background read over an authoritative session state (`stateAvailability` current and a projection held) no longer raises and clears `isRefreshing` and `sessionStateRefreshing`, and both setters skip writes that would not change the value (`useNativeAgentSession.background-flags.test.tsx`: steady polls went from one hook render per tick to none; manual reads and reads before any authoritative state still raise the flags). The transcript skeleton flag had already been gated on `background`.
- WEB-8: `AgentInfoButton` normalises the transcript only inside the rewind and undo handlers (`AgentInfoButton.transcript-reads.test.tsx`: six projection updates normalised six times before, now none until the click, then once).
- WEB-15: the native tab's tail reads (latest assistant row, latest prompt, auth failure since it) are one memoised pass, `readTranscriptTail` in `components/native-agent/transcript-tail.ts` (`transcript-tail.test.ts` pins equality with the old expressions, goal turns included).
- GW-13: `EnvironmentRebuildSection` follows `container-lifecycle-updated` through `listenAuthoritative` (subscribe, then read; re-read on resync), keeps the higher-revision snapshot when reads and events cross, and polls every 15 s while a rebuild runs instead of every 2 s (2 s again if the subscription fails). The event name and `ContainerLifecycleEvent` payload now live in `@orkestrator/protocol/container-lifecycle` (`EnvironmentRebuildSection.events.test.tsx`).

**Investigation.** GW-13's other two sites were already event-driven when re-checked: `ProjectCopyDialog` listens to `project-copy-changed` over the portal transport and keeps a 3 s backstop only while a copy is tracked, and `useUserCommands` re-reads on `user-command` changes, resyncs and safety checks, with a 3 s backstop only while a command runs (the resource is ephemeral, absent from the revision manifest, so a missed hint is otherwise invisible). Both were left as they are. Two `container-lifecycle` writes in `commands-environment.ts` (retained storage on deletion, setup completion) bump the revision without emitting; neither changes the operation the rebuild section shows, and the next emitted or read snapshot carries the higher revision. WEB-7 and WEB-17 are in "WEB-7 and WEB-17" below; WEB-2's third fix, WEB-6, WEB-9, WEB-10 and WEB-11 are in "WEB-9, WEB-6, WEB-10, WEB-11 and WEB-2's third fix" below; the rest are in "WEB-12, WEB-13, WEB-14, WEB-16, WEB-18 and WEB-19" below. No React Profiler run was made for the 2026-11-02 batch; the numbers above are hook render counts and call counts from tests. Browser check of the batch: the 18 component-browser owners that failed in a loaded nine-worker `test:browser` run (53 failures, almost all 30 s timeouts) were rerun with three workers: 278 passed and 5 failed. The five are the four desktop Cursor `CloseRetention` cases, which fail identically on `main` at `38d55ee1` (flake case 0963), and the known mobile `ClaudeInteractions` route-disposal flake (0252), whose owner then passed alone.

**Decisions.**

- **Order of work?** Decided 2026-11-02 (first batch done).
  - **WEB-4, WEB-5, WEB-8, WEB-15 and GW-13 first, each a local change; then WEB-7 and WEB-9 (recommended).**
    - Pros: the report's Phase 1 items first; each is testable on its own.
    - Cons: WEB-9's bundle gain waits.
  - **WEB-9 first.**
    - Pros: every launch benefits.
    - Cons: needs a build-size check per step and touches many imports.
- **What should still poll once the rebuild section follows lifecycle events (GW-13)?**
  - **A 15 s backstop read while a rebuild runs, 2 s when the subscription failed (recommended, done).**
    - Pros: progress arrives as it is written; a lost event costs at most 15 s even on a transport that cannot report a gap.
    - Cons: still one read every 15 s per open dialog during a rebuild.
  - **No polling at all; rely on events and resync.**
    - Pros: no reads while nothing changes.
    - Cons: a dropped event on a transport without a resync signal leaves the dialog stale until it is reopened.
  - **Keep the 2 s poll and add the listener.**
    - Pros: no behaviour risk.
    - Cons: keeps the cost GW-13 is about.
- **Should `ProjectCopyDialog` and `useUserCommands` lose their 3 s backstops too (GW-13)?**
  - **Leave them (recommended, done).**
    - Pros: both already update from events; each backstop runs only while work is in flight and covers a transport (portal) or resource (ephemeral `user-command`) whose missed hints nothing else detects.
    - Cons: a few extra reads per in-flight copy or command.
  - **Lengthen or remove them.**
    - Pros: fewer reads.
    - Cons: needs a gap signal for the portal stream and the ephemeral resource first.

#### WEB-7 and WEB-17 (done 2026-11-03)

Re-checked against `main` at `b8862313` first; both were still true, and `BuildChatTab` no longer has a timer, so it was left alone. Each change has a render-count test that fails on the previous code:

- WEB-7, `AppShell`: it subscribed to the whole pane-layout `environments` Map and used only the selected environment's entry. It now selects that environment's active pane tab (`selectActivePaneTab`), which keeps its identity when another environment's layout changes. `AppShell.test.tsx` ("does not re-render for a pane-layout change in another environment"): two layout writes to another environment re-rendered the shell twice before, now not at all; the selected environment's own change still does.
- WEB-7, `usePullRequest`: it called `useEnvironmentStore()` with no selector, so every store write re-rendered the action bar and the pipeline views using it. It now selects `prUrl`, `prState`, `hasMergeConflicts` and `setEnvironmentPR` one by one. `usePullRequest.render-count.test.tsx`: three writes to another environment in one batch (status, PR, deleting flag) re-rendered the consumer once before, now not at all; a change to its own PR fields still does.
- WEB-17, `ClaudeTmuxChatTab`: the 1 s `elapsedSeconds` interval at the tab root is gone; the thinking indicator renders `LiveElapsed` from the same `busyStartedAt`, with the same text and class. `tests/unit/components/ClaudeTmuxChatTab.test.tsx` ("ticks the elapsed text without re-rendering the tab root while busy"): the tab root rendered twice in two real seconds before, now 0 times, while the text goes `1m 5s`, `1m 6s`, `1m 7s`.
- WEB-17, `MultiReviewTab`: `reviewPanelNow` state is replaced by a per-tab `RuntimeClock` (`lib/review/runtime-clock.ts`) that the root starts and stops (active and something running, as before) but never subscribes to. It is shared through `RuntimeClockContext`; the five places that print a time subscribe: the header elapsed (`MultiReviewElapsed`), each flow-graph node's runtime and accessible name (`useLiveRuntimeParts` in `FlowGraph.tsx`), `StepFacts`, the reviewer's inspector line and `ReviewValidationStatus` (when no `now` prop is passed). Live `RuntimeParts` now carry `liveStartedAt`, from which a leaf re-derives `elapsed` (`runtimePartsAt`); settled parts never subscribe. The pipeline and graph-run views provide no clock, so their nodes behave as before. `MultiReviewTab.clock.test.tsx`: three ticks rendered the root three times before, now 0, while the header, node and inspector clocks advance each second and a settled step's runtime stays put. `runtime-clock.test.ts` covers the clock's start, stop and reference count.

No React Profiler run was made; the numbers are render counts from tests.

**Decisions.**

- **How should the Multi Review clock reach its leaves (WEB-17)?**
  - **A per-tab clock object in context, read with `useSyncExternalStore` by the components that print a time (recommended, done).**
    - Pros: the root renders only on real changes; one tick still advances every clock on the tab together; the shared flow graph needs no new props, and views without a clock are unchanged.
    - Cons: a new optional field (`liveStartedAt`) on the shared `RuntimeParts`; each live node re-renders itself once a second.
  - **Pass `now` down as a prop to each leaf.**
    - Pros: no context.
    - Cons: the root would still have to re-render to pass a new `now`, which is the cost being removed.
  - **One `LiveElapsed`-style timer per leaf.**
    - Pros: simplest per leaf.
    - Cons: the clocks on one tab tick apart, and the "freeze while inactive, read the time at once on return" rule would have to be repeated in every leaf.
- **What should `AppShell` select (WEB-7)?**
  - **The selected environment's active tab (recommended, done).**
    - Pros: narrowest; a change to another pane in the same environment no longer re-renders the shell either.
    - Cons: the pane walk runs in the selector on every pane-layout write (a few leaves, cheap).
  - **The selected environment's entry.**
    - Pros: what the report suggested; the selector is a single `get`.
    - Cons: still re-renders on every change inside that environment.

#### WEB-9, WEB-6, WEB-10, WEB-11 and WEB-2's third fix (done 2026-11-04)

Re-checked against `main` at `96ee1eb3e` first. All five still applied, in places differently from the report. Each landed as its own commit. Every change has a test that fails on the previous code, except the WEB-9 sizes and the timings, which are measurements.

**WEB-9, startup bundle.** Measured from a production build's manifest: `index.html`'s static imports plus `renderer-entry` (which `main.tsx` always imports) and its static imports. To reproduce: `bunx vite build --manifest && bun scripts/startup-closure.ts` in `apps/web`.

| Startup closure | Chunks | JavaScript | Gzip | CSS |
| --- | --- | --- | --- | --- |
| Before (`96ee1eb3e`) | 94 | 4,231,413 bytes (4.23 MB) | 1,281,858 bytes (1.28 MB) | 291,857 bytes |
| After `AgentNativeTab` alone went lazy | 95 | about 3.90 MB (sum of chunk code) | not measured | not measured |
| After | 89 | 2,547,787 bytes (2.55 MB) | 796,120 bytes (0.80 MB) | 287,918 bytes |

The report's 3.76 MB came from an older build, so the 4.23 MB baseline replaces it. A module graph dump of the real build showed the causes differ from the report's:

- `native-message-search` was held by `AppShell -> BugReportSheet -> native-agent/index.ts -> AgentNativeTab`, and by `ProjectWorkspace -> CoordinatorPanel`. Vite's `INEFFECTIVE_DYNAMIC_IMPORT` warning names this. Both now use `LazyAgentNativeTab`; no find-specific lazy loading was needed, and the warning is gone.
- Removing the `terminalPortalStore` re-export alone would not have moved xterm: `paneLayoutStore` and `App -> terminal/index.ts -> PersistentTerminal` also reached it. xterm's runtime moved to `lib/terminal-xterm.ts`, the store takes that factory as an argument, and `LazyTerminalPortalHost` loads the host the first time an environment has a terminal tab.
- The Markdown stack had three more paths, each now behind a boundary: the mail conversation view (`AgentMailMarkdown`, with the plain body as its fallback), the files panel's pull request views, and `TerminalContainerOverlays -> SetupPendingOverlay -> NativeMessage`. `App` also lazy-loads `ProjectWorkspace` (Kanban, GitHub, Linear, pull requests, coordinator).

`startup-closure.test.ts` walks the static graph from the entries in under a second and fails, naming the import chain, when xterm, `dompurify`, `marked`, `react-markdown`, `react-virtuoso`, `NativeMessage`, `MessageMarkdown` and six other named modules are reachable. On the old source tree it fails with those chains. In headless Chromium the production build requested exactly the 89 closure chunks at launch with no page error, and importing the terminal host, native agent, project workspace, mail Markdown, setup overlay, pull request view and pull request list entries raised none. `manualChunks` was not needed. What remains in the closure is not chat code: `react-dom` (530 KB), `@dnd-kit/core`, `CreateEnvironmentDialog` (70 KB), the action bar and `AgentInfoButton`, and `packages/protocol` (about 820 KB across its modules, not examined here).

**WEB-6, live-head merge.** `preferCompleteLiveHead` moved to `hooks/native-agent-live-head.ts` so it can be tested. It returns the incoming rows early when the held and incoming rows share their parts, and compares the rest with `sameTranscriptJson` (`lib/chat/same-transcript-json.ts`), which matches comparing `JSON.stringify` output, key order included, without building it. `native-agent-live-head.test.ts`: `JSON.stringify` runs in a verbatim copy of the old merge and never in the new one, and the two agree over 4,000 random heads, including which row object survives. The 0510 note that the early return should match the `:301` path was wrong: identical parts reach the incoming-only path (`restoredPrefix: false`), and the test pins that. Median per merge on a 200-part row (about 700 KB), one local run:

| Case | Before | After |
| --- | --- | --- |
| Same row object | 0.195 ms | 0.000 ms |
| Reparsed trimmed head, ids unchanged | 0.299 ms | 0.058 ms |
| Reparsed trimmed head, ids reissued | 0.288 ms | 0.034 ms |

These are small absolute costs, which matches the report's reasoning-only impact rating: the fix removes garbage per update rather than a visible stall. Found on the way and fixed separately on 2026-11-05: a held trimmed head as long as the omitted count showed a part twice; the merge now checks for overlap before reading the held row as the cut prefix.

**WEB-10, find indexing.** `AgentChatSearchIndex` (`components/chat/agent-chat-search-index.ts`) keeps each row's text while find is open, reused until the row changes, and is cleared on close and with protected rich content. `matches` also ignored `isOpen`, so a closed bar with a query left in it kept indexing on every update; it is now gated (every consumer already checked `isOpen`). `AgentChatFind.indexing.test.tsx`: an update over 1,000 reparsed rows called `getSearchText` 1,000 times before and 0 now, one changed row calls it once, and typing another query reads nothing again. Five of its six tests fail on the old hook. Local measurement of the real `getNativeMessageSearchText` over Markdown rows:

| Rows | Re-index per update before | Comparison per update after |
| --- | --- | --- |
| 300 (under the 512-entry cache) | 0.4–0.5 ms | 0.8 ms |
| 1,000 | 320–366 ms | 2.5 ms |
| 3,000 | 1,012–1,192 ms | 2.4 ms |

The first pass after opening find still reads every row once (179–1,197 ms at those sizes); only later passes and further typing improve. The comparison timings ran once each on one reparsed copy.

**WEB-11, terminal socket.** A first attempt (keep the socket unless a mobile host was hidden for 5 s) was reverted in review: an OPEN socket that answered earlier can stall on its own while the main event stream keeps heartbeating, and only this socket can prove it is live. The terminal protocol now has that proof. A server lists `features: ["ping"]` in its `ready` frame and answers `{ type: "ping", nonce }` with `{ type: "pong", nonce }` through its bounded control queue (`terminal-websocket-server.ts`; parsers in `packages/protocol/src/terminal-websocket.ts`, which drop feature names they do not know). On a return to the page with channels open, `TerminalWebSocketClient` sends one ping to a ready OPEN socket whose server advertised the feature, and keeps it when the matching pong arrives: no channel is unsubscribed, reconciled or re-snapshotted. With no matching pong within 2.5 s (`DEFAULT_FOREGROUND_PROBE_TIMEOUT_MS`), the socket is replaced and every channel reconciles, as before. A socket not yet answered, not OPEN, or from a server without the feature is replaced at once, so a new renderer against an older backend behaves exactly as before and never sends it a frame type it would reject as fatal. If the page is hidden again before the answer, nothing is replaced and the next return probes afresh; hiding alone never touches the socket. Tests (`terminal-websocket-client.visibility.test.ts`): a socket that answers is kept after a 10 min hide and still delivers ordered output, which fails on the previous code (it opened a second socket); a socket that stays OPEN but never answers is replaced and recovers; a pong for an earlier nonce does not count; a second return during a probe sends no second ping; disposing during a probe leaves nothing to fire; and a server without the feature still has its OPEN socket replaced after 0 ms to 10 min hides, with resubscription and resumed output. `gateway-terminal-liveness.test.ts` checks the real gateway advertises the feature, answers two pings in order and refuses a ping before authentication; protocol parser tests cover the frames and the feature list's bounds. Cost on return: one ~30-byte frame each way instead of closing the socket, re-subscribing each channel and fetching an HTTP snapshot per channel. A stalled socket is now replaced up to 2.5 s later than before.

**WEB-2's third fix.** The target was the hook rather than the controller, as 0590 found: the controller's only projection store subscription is its own turn-stop marker. `useNativeAgentSession` subscribed to its whole sync and progressive cache entries, whose every use is a `useState` or `useRef` initial value. It now reads them with `getState()`; the shared projection stays subscribed because an effect follows it. `useNativeAgentSession.store-subscriptions.test.tsx`: one cache write cost one hook render before and none now; a new projection still arrives and a remount still restores the cached transcript token. `useNativeAgentSession.background-flags.test.tsx` ("a manual read still raises and clears the flags") only saw the flag because the removed subscription forced a render mid-read, so it now holds the read open.

**Real stack.** On a credential-free `dev:test` profile (`web9-lazy-bundles`, since stopped and reset), which serves the Vite dev renderer rather than the production bundle: launch and opening the mail panel requested no xterm, `PersistentTerminal`, `AgentNativeTab`, `ProjectWorkspace` or `MessageMarkdown` module. The project board then loaded its own code and showed the coordinator. A terminal tab took input, showed its output again after a reload and re-selecting the environment, and closing a second terminal disposed it. The bug report sheet opened with no failure surface. No page error throughout. Not exercised live: rendering a mail body, the failed-setup overlay and the files panel's pull request tabs, which unit tests cover; a real agent turn, as the profile had no credentials; and a real mobile WebView (see "Needs verification").

**Terminal links after the factory change.** Both callers outside the app that create a terminal through the store now pass `createXtermTerminal`. `e2e/TerminalLinks.spec.ts` passed 14 of 14 in mobile and desktop Chromium, and the Electron test "a remote terminal link opens the native localhost forward in a separate browser" (`service-preview-electron.spec.ts`, its own disposable profile) passed, 1 expected, 0 skipped. The 48 design tests that fail in this branch's default suite all come from `design-frame-source.ts` on `main` throwing `Invalid URL` under Happy DOM's `about:blank`, a file this work does not touch; `main` has since fixed it (#1752).

**Decisions.**

- **How to take xterm out of the store (WEB-9)?**
  - **The caller passes an xterm factory to `createTerminal` and `recreateTerminal` (recommended, done).**
    - Pros: the store has type-only xterm imports; no hidden module state; the only callers already sit in the lazily loaded host.
    - Cons: a new required argument on two store methods.
  - **Make `createTerminal` asynchronous and import xterm inside it.**
    - Pros: callers need no factory.
    - Cons: the host creates terminals in a layout effect and reads them back in the same pass; it would have to handle terminals that do not exist yet.
- **What should the terminal host do when an environment's last terminal tab closes (WEB-9)?**
  - **Stay mounted once loaded (recommended, done).**
    - Pros: it is what disposes the terminals of removed tabs, so nothing leaks.
    - Cons: one idle host per environment that has ever had a terminal tab.
  - **Unmount with the last tab.**
    - Pros: nothing left mounted.
    - Cons: the closing tab's terminal would never be disposed.
- **Lazy-load the whole `AgentMailPanel`, or only the Markdown in a mail body (WEB-9)?**
  - **Only the Markdown, with the plain body as the fallback (recommended, done).**
    - Pros: the panel still opens at once; it was the analysis file's recommendation.
    - Cons: a body can show raw Markdown briefly the first time a thread is read.
  - **The whole panel.**
    - Pros: removes more from the closure.
    - Cons: it is mounted in two places in `AppShell`, and a boundary has to work around its open state.
- **How to compare parts in the merge (WEB-6)?** This replaces the analysis file's recommendation.
  - **A comparison with the same answer as comparing the JSON, without serializing (recommended, done).**
    - Pros: no second copy of the text to bound; stops at the first difference; also covers the incoming part, which is always newly parsed.
    - Cons: assumes JSON-shaped values; a non-JSON value such as `NaN` compares differently from its serialization, and transcript parts have none.
  - **A WeakMap from part object to its serialized string.**
    - Pros: small change; the analysis file's recommendation.
    - Cons: every incoming part misses, so each merge still serializes them, and the cached strings add to what the projection store's byte ceiling does not count.
- **Where to reuse search text (WEB-10)?** This replaces the report's WeakMap and debounce.
  - **A per-hook index by row id, reused when the row is the same object or has the same content (recommended, done).**
    - Pros: covers reparsed rows, which are new objects; independent of the window-wide text cache that thrashes; bounded by the current rows and dropped on close.
    - Cons: compares every row per update (2.5 ms at 1,000 to 3,000 rows here), and a second holder of derived text, so it registers with the protected rich cache reset.
  - **A WeakMap from message object to projection.**
    - Pros: one lookup per row.
    - Cons: `normalizeNativeMessages` kept row identity only when re-normalising the same raw copy; a reparsed copy misses every row.
  - **Debounce the recomputation.**
    - Pros: trivial.
    - Cons: every pass still re-parses everything above 512 rows, and matches lag behind the text.
- **What decides a socket rebuild on return (WEB-11)?**
  - **An application-level ping on the terminal socket, rebuilding only if unanswered (recommended, done).**
    - Pros: tests the terminal socket itself, so an independently stalled one is still caught on every host; a healthy one keeps every channel without reconciling.
    - Cons: a protocol addition, gated on a `ready` feature so older servers keep the old behaviour; a stalled socket is replaced up to 2.5 s later.
  - **Rebuild on every foreground return while channels exist.**
    - Pros: recovers stalled sockets at once with the existing protocol.
    - Cons: every return closes the socket and reconciles every channel from a snapshot, which is the cost WEB-11 names.
  - **Keep the socket unless a mobile host was hidden for 5 s.**
    - Pros: no protocol change.
    - Cons: OPEN and an earlier `ready` do not prove liveness; a desktop socket that stalled on its own was never recovered. Reverted in review.
- **How to read the two caches without subscribing (WEB-2)?**
  - **`getState()` on each render (recommended, done).**
    - Pros: removes the subscriptions; holds no reference to an entry, so an evicted cache can be freed.
    - Cons: a later render relying on the value would silently see whatever is current, so the test pins the render count.
  - **Capture them once in `useState`.**
    - Pros: makes "only at mount" explicit.
    - Cons: keeps a cache entry, including its retained history messages, alive for the hook's whole life.
  - **Select individual fields with `useShallow`.**
    - Pros: no change to how the values are read.
    - Cons: subscribes to values only used as initial state, and a token that moves still re-renders.

#### WEB-12, WEB-13, WEB-14, WEB-16, WEB-18 and WEB-19 (done 2026-11-04)

Re-checked against `main` at `a8bdce444`, which includes #1747. All six still held, so none was left as "does not hold". Each landed as its own commit, with a test that fails on the previous code, except the WEB-19 timings, which are measurements.

| Item | Measure | Before | After | Source |
| --- | --- | --- | --- | --- |
| WEB-12 | Reads for one rename | 1 whole-project list | 1 record, 0 lists | Chromium on a `dev:test` profile |
| WEB-12 | Reads for one deletion | 1 or more lists | 2 records, 0 lists | Chromium |
| WEB-13 | 12 s with one expanded truncated folder | 2 reads, each with the contents, each replacing `fileSubtrees` | 2 reads, 2 `unchanged`, 0 with contents, `fileSubtrees` keeps its identity | Chromium; before read from code |
| WEB-14 | Maps copied by a poll's `setProjection` | 4 | 1 (2 when the messages changed) | `nativeAgentProjectionStore.test.ts` |
| WEB-14 | Rewriting the newest projection | Copies 4 Maps and notifies every subscriber | Publishes nothing | same |
| WEB-16 | Container renders for unrelated fields, or another environment, in one batch | 1 | 0 | `TerminalContainer.render-count.test.tsx` |
| WEB-16 | Profiler commits per unrelated write, four plain tabs, whole-object subscription against the selector | 1, mean 3.5 to 3.7 ms, p95 7.4 to 8.0 ms | 0 | Chromium, development React, fake backend, two runs of 200 writes on 2026-11-05 |
| WEB-18 | All renderer commands in 12 s, Files panel open | Not comparable: only the polls moved here changed | 8 visible, 0 hidden; 5 in the 3 s after return, including the overdue `check_docker` | Chromium |
| WEB-18 | Reads by a 3 s poll in 10 min hidden | 200 | 0 | `coordinated-poll.test.ts` |
| WEB-19 | Median per streamed update, 5 KB message | 3.3 ms | 2.2 ms | Production React under Happy DOM, one local run |
| WEB-19 | Same, 10 KB | 4.5 ms | 2.1 ms | same |
| WEB-19 | Same, 20 KB | 6.7 ms | 2.4 ms | same |
| WEB-19 | Same, 30 KB (the parser cap is 32,000 characters) | 10.2 ms | 3.7 ms | same |

The "before" WEB-12 and WEB-13 browser rows come from the code rather than a browser run on the old commit; the counts follow directly from it.

**WEB-14.** `setProjection` and `setProgressiveCache` copy each Map the first time they have to change it (`copyOnWrite`, `nativeAgentProjectionStore.ts`). A byte Map is left alone when the size is unchanged. No reader depends on its order: eviction walks the entry Maps. Rewriting the projection already at the most-recent end, clearing an absent progressive entry and an eviction with nothing to release now publish nothing.

**WEB-16.** The container selected its whole environment object but reads only a few of its fields, which are now selected one by one with `useShallow`. That alone was not enough: `mergeEnvironmentsForProject` gave every environment in the project a new object whenever one changed, nested `agentSettings` included. `reuseUnchangedFields` (`environmentStore.ts`) keeps the identity of every environment and field a snapshot left unchanged, in `setEnvironments`, `mergeEnvironmentsForProject`, `applyEnvironmentSnapshot` and `updateEnvironment`, so this helps every subscriber of the store. Removing the effect's `exhaustive-deps` suppression exposed the React Compiler rules to the whole component for the first time: three refs written during render now publish in a layout effect, and one state write that has to stay in its effect keeps a directive with its reason. On 2026-11-05 `TerminalContainer.render-count.test.tsx` gained tests that the launch handoff fires once around unrelated writes, the provider session binds once and the setup check still sees `setupOverride`. Native tabs in the same subtree re-rendered on every write until 5580 narrowed their selectors the same way (2026-11-05).

**WEB-12.** The announcement already names the environment and its project. `get_environment_snapshot` returns that one record as the list would (one keyed row, `toClientEnvironment`), and `refreshEnvironmentSnapshot` (`useEnvironments.ts`) applies it, removing the environment on `null`. It keeps the list path's lifecycle-attempt and subscription handling. A record not held yet is ignored while a creation in this client is running or just finished, because the creation's own response adds it and `addEnvironment` does not deduplicate. `useEnvironmentListSync` uses it only for one pending change: several waiting at once (a reorder announces per moved environment), an announcement without a project and every explicit resync read the list, and manifest recovery still reads every list, so a missed event stays detectable. Backends without the command fall back to the list until the next explicit resync (row in the [version compatibility register](../../architecture/version-compatibility.md#register)).

**WEB-13.** `get_file_subtree` and `get_local_file_subtree` take `knownDigest` and answer `{ unchanged, digest, value? }` through the existing `conditionalSnapshot`. The store holds each folder's digest beside its contents and drops it with them on collapse, retry or target change, so a folder not held is always read whole. An unchanged answer clears the loading and failure marks and leaves `fileSubtrees` alone, so nothing merges the tree again. The backend still walks the folder: nothing else can say an ignored folder has not changed, and that walk is what makes a change appear. In Chromium a new file appeared 1.35 s after it was written. Without `knownDigest` the commands answer as before; a backend that ignores it sends the directory, which reads as changed with no digest (register row added).

**WEB-18.** `startCoordinatedPoll` (`lib/coordinated-poll.ts`) replaces `setInterval` where it stands and hands the schedule to the read coordinator: nothing while the window is hidden or the transport has declared itself disconnected, and one read after it returns if the interval has passed, `critical` polls first. A failed read logs (`poll.read-failed`) and keeps its interval. Moved: the Docker probe (60 s), user commands (3 s), annotation selection (400 ms, `critical`), Docker settings' probe and stats (5 s each), the Docker image task (2 s), recovery copies (3 s), the rebuild section (2 s or 15 s), project copy (3 s), machine maintenance (2.5 s or 20 s), the bug report draft (3 s), GitHub CLI login (1.5 s) and the Multi Review pull request phase (2 s). `coordinated-poll.test.ts` covers the behaviour and checks each of these files uses it; `useUserCommands`, `useAnnotationCapture` and the rebuild section also have a hidden-window test of their own.

Left on their own timers, and why: `CAPTURE_RESUME_INTERVAL_MS` in `useAnnotationCapture` retries uploads, which is a mutation the coordinator must not own. The sign-in reads in `AgentInfoButton` are bounded to 60 reads or the device-code deadline and already read on focus. `ContainerLogViewer` (1 s) holds a backend log subscription, and whether that survives a long pause was not checked. `WorkflowLiveInspector` schedules itself adaptively. `TicketSyncStrip` (30 s) and `useMaintenanceSummaries` (5 min) were not in the finding. `ServerConnectionSwitcher`, `pullRequestsStore` and the web annotation sync already skip while hidden. `lib/portal/workspaces.ts` renews a lease.

**WEB-19.** The finding holds, and fixing it was worth it: 10.2 ms per update at the parser cap is about 20% of a core at the 20 updates per second limit, and it grew with the message. Each completed segment now runs through `react-markdown` once (`IncrementalMarkdownCache.render`, `incremental-parse.ts`) and its React elements are reused, so React skips them. The cost is now close to flat with length. Equivalence: `incremental-parse.test.tsx` compares HTML and top-level keys with a full render at every prefix of 16 fixtures, rich and plain, including open and closed fences, partial tables, definitions, footnotes, HTML and CRLF. `MessageMarkdown.incremental.test.tsx` compares the DOM with one pass over the whole text every 3 characters through the real rich components, and shows finished blocks do not render again and the final render remounts nothing. A block is treated as finished only once a later line has ended, so the last two blocks render per update. The thin rich adapters that read `RichMarkdownRenderContext` still re-render, because the context carries the source; the heavy blocks under them are memoized on their own props.

**Browser and real-stack checks.** On a credential-free `dev:test` profile (`web-refetch-qa`, stopped and reset) in Chromium: a rename and a deletion reached the sidebar and the name survived a reload; the WEB-13 and WEB-18 numbers above; no page error. `e2e/StreamingTranscript.spec.ts` and `e2e/TranscriptArrival.spec.ts` with one worker: 46 passed and 4 failed on this branch, 46 passed and 4 failed on `a8bdce444`, with different tests each time, mostly the page not appearing in time. Of the branch's failures, only `scrollbar departure after find` (flake [0767](../../tests/flaky-tests/native-agents-and-transcripts/0767-streaming-find-convergence-aggregate-timeout.md)) failed again alone, in 2 of 4 runs, against 1 of 4 on the base commit.

**Decisions.**

- **How should one environment change reach the store (WEB-12)?**
  - **A new one-record read used only when exactly one change is waiting (recommended, done).**
    - Pros: announcements stay body-free, as the change feed requires; one keyed row on the backend; a burst still costs one list read; unknown-command fallback is detectable.
    - Cons: a new command and one compatibility path; two different changes in sequence read two records.
  - **An `environmentId` argument on `get_environment_snapshots`.**
    - Pros: an older backend answers with the list, so no failed request.
    - Cons: one command with two answer shapes, and the argument's meaning is invisible to the conditional manifest path it shares.
  - **Carry the environment in the announcement.**
    - Pros: no read at all.
    - Cons: `resource-events.ts` rules it out: a client must never trust a body delivered out of band, and a mutation would have to serialize the record for every client.
- **Where should WEB-16's fix live?**
  - **Narrow the container's selector and keep unchanged identities in the store (recommended, done).**
    - Pros: the selector alone would still re-render on `agentSettings`, a new object in every snapshot; the store change helps every other subscriber.
    - Cons: one deep comparison per field of each environment in a merge, about what the whole-record comparison it replaces already cost.
  - **Narrow the selector only, comparing `agentSettings` deeply there.**
    - Pros: touches one file.
    - Cons: every other selector of a nested environment field keeps the problem.
- **How should polls pause (WEB-18)?**
  - **`startCoordinatedPoll`, a one-for-one replacement built on the coordinator (recommended, done).**
    - Pros: each effect keeps its closures and cleanup; one implementation of return, reconnect and server switch; no state for a poll that does not need it.
    - Cons: every owning test that captured `setInterval` had to change; a tick is skipped while a read runs, rather than overlapping.
  - **`useCoordinatedRead` at each site.**
    - Pros: the documented hook.
    - Cons: most sites define their read inside an effect, against that effect's own closures, so each would have to be restructured.
  - **A `document.hidden` check inside each interval.**
    - Pros: smallest diff.
    - Cons: no read on return unless every site also adds a listener, and timers keep firing while hidden.
- **How should finished markdown blocks be kept (WEB-19)?**
  - **Reuse React elements from `react-markdown`, called as a function (recommended, done).**
    - Pros: no copy of its pipeline; the plugins still see the whole document, so offsets and block ids are unchanged; the same keys as a full render, so the final render updates in place.
    - Cons: depends on `react-markdown` staying a plain function and on `hast-util-to-jsx-runtime`'s `name-count` keys, both of which the tests pin; the top-level `<Markdown>` element is gone.
  - **Render each completed block in its own memoized `<Markdown>`.**
    - Pros: plain React.
    - Cons: a different tree shape from the final render, so finishing a message would remount every block, and code highlighting and diagrams would start over.
  - **Leave it, as the finding's medium confidence allowed.**
    - Pros: no change.
    - Cons: about 20% of a core per long streaming answer, growing with its length.

### 4. Live agent view requests

**Problem.** Each visible agent tab sends three POSTs every 500 ms while running, and bearer-token web clients open one event stream per terminal.

**Context.** Decided 2026-11-01: take discovery out of the 500 ms round, then add a combined read; choose push or long-poll only if measurements still justify it, and keep a recovery poll either way. Quiet backoff already covers all six providers (0052 task 2).

Done 2026-11-04 (WEB-1, GW-1): discovery left the timed round and a round is one request. Baseline taken first on an isolated `dev:test` profile at `e198fd4a7`, before any polling code changed, with `e2e/agent-testing/agent-tab-requests-live.spec.ts` (setup in [agent-testing.md](../../development/agent-testing.md#live-requests-of-a-running-agent-tab)). The named workload is `running-quiet`: one visible Claude tab whose turn is in a foreground wait, watched for 40 s. Two runs each, on the same machine:

| Measure over 40 s | Before (`e198fd4a7`) | After |
| --- | --- | --- |
| Session requests | 246, 249 | 85, 85 |
| Requests per round | 3.00, 3.00 | 1.04, 1.04 |
| Requests per second | 6.15, 6.22 | 2.13, 2.12 |
| Rounds (the cadence stayed 500 ms) | 82, 83 | 82, 82 |
| Discovery reads | 82, 83 | 3, 3 |
| Bytes on the wire, headers included | 463,918, 471,279 | 224,032, 225,611 |
| Gateway request bodies | 78,392, 79,348 | 34,191, 34,191 |
| Gateway response bodies | 223,533, 237,818 | 187,920, 201,261 |
| Reconnect (offline 6 s, stream dropped): first read after online | 56 ms, 53 ms | 60 ms, 55 ms |

Three of the discovery reads fall in a 40 s window because one section expiry sits inside it: the read that finds the sections expired, then follow-ups until they settle. Those are also about half of the remaining response bytes (93,620 of 187,920), since each is a whole discovery snapshot; the code says its availability flipped, which was not checked read by read.

- Discovery (`NativeDiscoveryReadSchedule`, `native-session-read-policy.ts`): read on mount, a session or identity change, any read that is not a background round, a resync, a resume or reconnect, a phase change and an invalidation that names discovery (`nativeSessionInvalidationNamesDiscovery`, `native-agent-observation.ts`), and otherwise every 30 s with its token. `resource-sync.ts` now keeps a cause that names discovery when it coalesces a burst, which it previously overwrote with the newest. Tests: `useNativeAgentSession.read-round.test.tsx`, `native-session-read-policy.test.ts`, `resource-sync.test.ts`, `native-agent-observation.test.ts`.
- Combined read (`get_native_agent_live_update`, `native-agent-live-update.ts`, `liveUpdateVersions` in `get_native_agent_sync_capabilities`): one request for transcript and state, used by a background round over tokens the view holds. Tests: `native-agent-live-update.test.ts`, `useNativeAgentSession.read-round.test.tsx`. Two rows added to the [version compatibility register](../../architecture/version-compatibility.md#register).
- Real stack, profile `e8-agent-tab-polling` with real Claude turns: the requests spec above; its case that lets a turn end while the environment is off screen (no session request in 31 s inactive, the answer shown 251 ms after return, and again after a reload); its case that hides `liveUpdateVersions` from the page (2 reads a round, 60 in 15 s, no combined read sent, no failed session command); and `slash-command-picker.spec.ts` and `slash-command-inactive.spec.ts`. Claude only: the other platforms share this code path through unit tests, not a live run. `claude-revision-tokens-live.spec.ts` fails at its first case with and without this change, so it is no evidence either way; see [5040](../transcripts-and-observation/5040-revision-token-spec-background-output.md). Its page reader now counts a combined read as the two reads it answers.

Done 2026-11-05 (GW-3, efficiency report 0120): bearer and cross-origin web clients carry every terminal on one filtered fetch stream instead of one request each, so several terminals no longer queue `/invoke` behind them on HTTP/1.1 or hold one streaming-gzip slot apiece. One owner in `web-gateway.ts` (`refreshSharedTerminalConnection`, `openSharedTerminalConnection`) drives either an `EventSource` or a fetch reader, so the filter, the no-op on an unchanged filter and the desync on reopen are not duplicated. Tests: `web-gateway-shared-terminal-stream.test.ts`, with the direct cases in `web-gateway.test.ts`, `web-gateway-reconnect.test.ts` and `web-gateway-silent-recovery.test.ts` moved to the shared stream. A real-browser check and which real routes still use HTTP/1.1 are in [5380](../transcripts-and-observation/5380-bearer-terminal-stream-live-evidence.md).

**Investigation.** The three reads are in `useNativeAgentSession.ts`; only `/invoke` exists (`gateway-auth.ts`). Bridge state reads have no conditional path and hash a state that includes the model catalogue (TX-5); transcript windows are always sent whole (TX-6). GW-3 is in `web-gateway.ts`. Push or long-poll: a running tab still sends two requests a second, each an `unchanged` answer of about 1.6 KB on the wire when nothing moved. Whether that justifies either is the maintainer's choice from these numbers; nothing here started it.

**Decisions.**

- **Where does the combined read live?** Done as recommended.
  - **One new progressive-update command that answers transcript and state with their `knownToken`s (recommended).**
    - Pros: one request; reuses the existing token contract; older backends are detected by the missing command.
    - Cons: a new protocol command that needs a version-compatibility entry.
  - **A generic bounded `/invoke-batch`.**
    - Pros: helps every caller.
    - Cons: new gateway surface with its own bounds, auth and error semantics.
- **What triggers a discovery read?** Done 2026-11-04 with the first option, plus follow-ups for a section that has not settled (see Assumptions and decisions).
  - **Mount, a session or identity change, a manual refresh, resync, a phase change and an invalidation that names discovery, with a 30 s backstop that reuses its `knownToken` (recommended).**
    - Pros: covers both reports' lists; a new command or model still arrives; the backstop covers a missed hint and drives the refresh that produces announcements.
    - Cons: a catalogue change not announced waits up to 30 s.
  - **Only events, with no backstop.**
    - Pros: fewest reads.
    - Cons: the maintainer asked for a recovery poll to stay, and with no read the backend would not refresh discovery, so a change would never be announced.

### 5. Transcript pipeline

**Problem.** Lagging or second viewers get full snapshots, prompt sends read up to 16 MiB, and several fingerprints re-serialise whole structures.

**Context.** The report's TX items in `native-agent-transcript-projection.ts`, `native-agent-service.ts` and `http-bridge-provider.ts`. #1506 (history paging) changed the projection after the report.

Closed 2026-11-06: every item is done (TX-17 closed without a change after profiling), and the two that task 1 gated are measured: TX-1 live on a `dev:test` profile in E10, TX-2 with a provider fake in E9. The live evidence still wanted is tracked where it was found: bytes per prompt send and per turn check in [5340](../transcripts-and-observation/5340-transcript-reads-live-evidence.md), and Codex, Pi, a lagging viewer and windows near the 512 KiB bound in [6680](../transcripts-and-observation/6680-conditional-reads-and-deltas-measured.md) task 1.

**Investigation.** Confirmed 2026-11-01: the transcript view cache holds one entry per key, so a delta is built only from the newest view (TX-1). The projection-sync path already keeps bounded revisions (`state.revisions`), which is the model for the fix. Re-checked 2026-11-04 against `96ee1eb3e`: TX-2 still applied after #1506, because `interactiveSnapshot` read `legacy()` with no limit and `refreshProjectionOnce` passed none, so it was fixed rather than recorded as no longer applying. Not re-checked since #1506: TX-3, TX-7, TX-8, TX-9 and TX-11 to TX-18. Re-checked 2026-11-05 against `39c26627f` in E11: TX-3, TX-7, TX-9, TX-11 to TX-14, TX-16 and TX-17 all still held; all but TX-17 are now done (see the closing check of E11 (`git show 413bd6219:docs/reports/2026-11-06-efficiency-logging-database-outcome.md`)).

**Decisions.**

- **TX-1: how many bases to keep?**
  - **A ring of 4 to 8 views per key, bounded by count and bytes like `state.revisions` (recommended).**
    - Pros: views share row objects, so the ring costs arrays; one pattern in the file.
    - Cons: more memory per hot session; needs explicit bounds (invariant 11).
  - **Keep one base and send a snapshot to anyone behind.**
    - Pros: no change.
    - Cons: the problem stays.
  - Done with the recommended option; see "Task 5" under Assumptions and decisions.

### 6. Bridge hot paths

**Problem.** Bridges re-measure and re-serialise whole transcripts and tool cards per update, and Codex reads every session record per config read.

**Context.** Done: ACP streaming output persists at most once a second (`scheduleStreamingPersist` in `acp-persist-writer.ts`) and measures the transcript every 1 MB (BR-1, BR-3), as decided on 2026-11-01. Neither has a new test; the existing bridge suite passes. One ACP test (`latches a fatal error when active children exceed the bounded registry`) fails on `0bd214ee` too when the file is run directly; it passed in the 2026-11-02 bridge run.

Done 2026-11-02 (against `main` at `38d55ee1`), in the order decided below: the Pi, Cursor and ACP transcript helpers moved into `packages/protocol/src/node` first (BR-15's transcript half), then BR-4 to BR-6 were fixed there once.

- `bridge-transcript-text.ts`: `sliceUtf8`, `boundUtf8Text` and `BoundedTextAppender`, which replaces Pi's and Cursor's identical `appendBounded`/`boundText`/`sliceToBytes` and ACP's `appendBounded`/`appendSaturating`/`truncateUtf8`/`truncateDisplayText`. The two truncation behaviours are kept as policies (`append-notice` for Pi and Cursor, `reserve-notice` for ACP), so each bridge's text is unchanged. BR-6: the appender remembers each owner's buffer byte length, used only while `current` is the very string it was taken from, so a delta costs its own bytes.
- `bridge-transcript-bounds.ts`: one `createBridgeTranscriptBounds` for the bound wrapper, read bound, streaming check and revised-row bookkeeping Pi and Cursor each carried. The bridges' `transcript.ts` keep their exported names as thin bindings, so no call site changed.
- BR-4, `TranscriptRowSizes` in `transcript-budget.ts`: a dirty bound re-serialises only the newest row and the rows noted since the last pass. The hook is the existing revised-row note (`noteRowRevised` for Pi and Cursor, ACP's `noteRevisedRow`), which every in-place change to an older row must already reach for `revisedMessageIds`. A remembered size is also tied to the row object and to the row after it, so a replaced history or a row that became newest again (Pi's refused-prompt rollback, ACP's withdrawn prompt) is measured again. One entry per retained row, rebuilt on every pass. Under `bun test` (`NODE_ENV=test`) every remembered size is re-checked and a stale one throws `StaleTranscriptSizeError`, so the three bridge suites prove their write paths note what they change. Two paths that change an older row without a reader note now invalidate it directly: Pi's history-replay result fold (`forgetRowSize`) and ACP's nested-part shedding.
- BR-5, `EncodedObjectSizes` in `transcript-budget.ts`: Pi's `chargeToolPart`, Cursor's `chargeToolPart` and ACP's `commitToolPartMutation` measure a card with exactly `JSON.stringify`'s byte count, but re-measure only string fields that changed, and a field that extends its previous value costs one prefix comparison plus its new suffix. Object and array fields are still measured every time, because the bridges mutate some in place. Cursor's shell-delta `continues` fast path is unchanged.
- Tests: `bridge-transcript-text.test.ts` replays random streams (multibyte, split surrogate pairs, notices, caps below the marker) through verbatim copies of the old bridge helpers and requires the same text; `transcript-budget.test.ts` checks the row cache (only the newest and noted rows are measured, follower and identity checks, count bound, verification) and that `boundTranscriptInPlace` with the cache leaves exactly the state it leaves without it, and checks `EncodedObjectSizes` against `encodedJsonBytes` through random edits; `bridge-transcript-bounds.test.ts` covers the shared wrapper. The Pi, Cursor and ACP bridge suites pass unchanged with verification on.

Done 2026-11-03 (against `main` at `b8862313`), the Claude half of BR-8 and BR-9:

- BR-8: `buildMessageParts` spread a fresh `{ ...tool, createdAt }` on every build whenever the tool-ref entry had a timestamp (every real record has one, `receivedAt`), so `isSamePublishedPart` saw every tool part as changed and each 100 ms patch relisted every tool card on the row, subagent cards included. `ToolTracker.getToolWithCreatedAt` now stamps `createdAt` onto the tracker entry the first time one is known, so later builds return the same object; `refreshSettledToolRows` uses it too. A result, denial or command change still replaces the entry, so those still publish.
- BR-9: `emitRow` returns whether it published, and `materializeRow` marks the transcript changed (and notes the row in `revisedRows`) only then, or when the row's `sdkUuid` changed, which is serialized but in no frame. `emitRow` already marked the transcript on both publishing paths.
- Tests: `session-manager-prompt-stream.test.ts` ("a finished tool keeps its part object across flushes…": the tool part is the same object (`toBe`) across two flushes and the patch lists only the text part); `routes/session-activity.test.ts` ("a stream flush that changes nothing…": an empty delta's flush and a no-op `refreshToolRows` move neither `message.revision` nor `contentRevision`; a real delta moves both). Both fail on the old code.

Done 2026-11-03 (against `main` at `b68b6e71`), Codex half: BR-2 and BR-11.

- BR-2: `getConfig`'s `durable` check (`isSessionConfigPersisted` in `app-server-runtime-sessions.ts`) now calls `BridgeSessionStore.loadRecord(id)` (`sessions/persistence.ts`) instead of `load()`. It reads only `recordPath(id)`, with `load()`'s validation (`isPersistedBridgeSession`, cwd hash, retention cutoff, a tombstone is not persisted, and the record must name the session asked about). It does no legacy migration, login-record adoption, directory listing, chmod or sweep. Only when no record file exists does it look, read-only, where `load()` would first have published one: the former aggregate file, then the login's own records directory. Tests: `sessions/persistence-load-record.test.ts` (one `readFile` out of 50 records, no `readdir`/`chmod`/`mkdir`/write/`load()`; agreement with `load()` for valid, tombstoned, expired, wrong-cwd, invalid, corrupt, foreign-id, legacy-only and absent records; a login record found without being moved) and `app-server-runtime-config-durable.test.ts` (`getConfig` on one of 50 persisted sessions reads one record file and never calls `load()`, which fails on the old code; `durable` false for a changed config, a tombstone, a missing and an expired record).
- BR-11: `history/session-index-cache.ts` keeps `session_index.jsonl` parsed per path, keyed by size, mtime, ctime and `dev:ino` from the descriptor's `fstat`, as `transcript-cache.ts` does. Unchanged means no read. Growth on the same inode whose 64 bytes before the old boundary are unchanged parses only the appended bytes. A shrink, a replacement, a same-size rewrite or a changed anchor re-reads from scratch. An unterminated last line is parsed on each read but never committed. Both `findSessionIndexEntry` (hydrate) and the cwd listing read through it; the listing still visits every line in file order, so its result is unchanged. Bounds (invariant 11): 50,000 entries, 16 MiB estimated and 4 paths across the cache, least recently used evicted first; an index too large on its own is parsed uncached on every read, as before. `readTranscriptLines` and `PersistedSessionIndexEntry`, used only for this, were removed. Tests: `history/session-index-cache.test.ts` (parsing parity, unchanged read once, append read as tail only, shorter rewrite, inode replacement, in-place rewrite with growth, same-size rewrite, pending tail, snapshot stability, concurrent readers, path/entry/byte bounds) and `history/rollout-session-index.test.ts` (two hydrates read the index once, an appended rename is found after one tail read, a shorter rewrite is fully re-read, the listing shares the cache).

Done 2026-11-04 (against `main` at `96ee1eb3`), the remainder apart from the SSE replay rings. Each item was re-checked against that commit first, and all six still applied. Every test named below was also run against the old sources and failed there.

- BR-7, Codex. `TurnRenderState.runningItemParts` keeps a running item's parts while its accumulator `version` stands still, so an unchanged card keeps its object and `isSamePublishedPart` no longer lists it. The version is sampled with the item in `collectTurnItems`, because a delta can land while a render awaits an earlier item. Patches carry `content` only when it changed (`publishedContent`, named by message, so a path that swaps the row sends the body again). Tests: `messages/render-turn.test.ts` ("running items across publish ticks": identity across ticks, only the moved item rebuilt, progress lines, measurements, a raw patch shown at turn end, a delta during a render, and 300 random steps rendering what a fresh state renders); `app-server-runtime-rows.test.ts` ("publishing running tool cards": a patch lists only the moved card, a client applying the frames holds exactly the transcript's row).
- BR-10, Pi. `session-list-cache.ts` keeps the list against a sha256 of each `.jsonl` file's name, size, mtime, ctime and inode; unchanged costs one `readdir` and a `stat` per file. A timeout aborts the read through the SDK's `signal` and answers 504 with a fixed message, which `assertOkWithErrorDetail` already passes on and the resume dialog already shows. Any other failure still reads as no sessions, as before, now with a log line. Tests: `session-list-cache.test.ts`, `http.test.ts` ("a session list that timed out"), and `http-bridge-provider-archive.test.ts` in the backend.
- BR-12, ACP. `acp-jsonl-framer.ts` searches only the new chunk and joins held bytes once per frame. A 2.1 MB frame written in 32 pieces copied 36.7 MB before and copies under 2.3 MB now. Tests: `acp-jsonl-framer.test.ts` (500 random chunkings against a verbatim copy of the old loop, both limits, and a real `AcpProcess` whose copies are counted).
- BR-13, Codex. `SerialQueue` holds an array per key and drains it in one microtask, so a synchronous task allocates no promise. It has count (100,000) and byte (256 MiB, by line length) bounds. Past either it drops what has not started and calls `AppServerSupervisor.restartNow`, without awaiting it on the read loop. Tests: `jsonl-rpc-client.test.ts` (no promise chain over 1,000 tasks, both bounds, order, drain and clear), `process-supervisor.test.ts` (replaced child, new generation, nothing started during shutdown) and `app-server-runtime-lifecycle.test.ts` (a running turn past the bound fails as a restart, the status a workflow can continue from, and the dropped deltas never reach the transcript).
- BR-14, Pi. `encodeStateWithinBudget` encodes each record once and splices them into the envelope with exact byte accounting; shedding re-encodes only the records it trims. Tests: `persistence.test.ts` (300 random states and budgets against a verbatim copy of the old code, byte for byte; forty 1 MB sessions encode under 80 MiB in all, where the old code encoded about 810 MB).
- BR-16, ACP. The replay is removed: `reconcileCursorToolMetadata`, its scheduler, collector and join, the session fields, constants and `ACP_MAX_LIVE_CURSOR_TOOL_REPLAYS`, and the provider labels in `acp-errors.ts` and `session-config.ts`. No launch reaches it: `commands-servers.ts` handles `cursor` in its own branch and only Grok falls through to `ACP_PROVIDER = kind`, `host-model-catalog-refresh.ts` does the same, and the container entrypoint (`commands-registry-servers.ts:585`) exports `ACP_PROVIDER=grok`. The harness moved to a neutral `acp-fixture` id; the expectations that changed for it changed only in that name. Test: `acp-context.test.ts` ("a turn's generic tool calls spawn no replay child"), with the provider id set to `cursor` by hand. On the old code it sees a second child. The `cursor/*` method handlers are not provider-gated and stayed: [4540](../agent-engines/4540-acp-bridge-cursor-extension-leftovers.md).

Done 2026-11-05 (E-0360, against `main` at `69a3b4ca5`, where the finding still held): BR-15's SSE replay rings. Codex's `EventRing` moved to `packages/protocol/src/node/event-ring.ts`, and Claude's replay buffer (`bridges/claude-bridge/src/routes/events.ts`) is built on it. A full `message.updated` now collapses the message's earlier snapshots and patches on Claude, replayed as `bridge.cursor`; observation replays are unchanged. Claude frames carry their data byte count, so no subscriber measures a frame again. Tests: `packages/protocol/src/node/event-ring.test.ts` and `bridges/claude-bridge/src/routes/events.test.ts`; the closing check of E-0360 (`git show 413bd6219:docs/reports/2026-11-06-efficiency-logging-database-outcome.md`) records it.

**Investigation.** BR-15's SSE replay rings were re-checked against `69a3b4ca5` before the 2026-11-05 fix; the finding still held.

Checked 2026-11-05 by batch E20 against `main` at `3baeaacf6`. BR-16 was not quite finished: the fake agent still fell back to the provider id `cursor` (`testing/fake-agent-context.ts`), and the replay's constants, discovery counter, settled-claim set and descriptor fields were left with no reader. They are gone, and old state files still load (`acp-persist-writer.test.ts`). BR-12 was done, and now has a test at the real 4 MiB limit through a real `AcpProcess` (`acp-jsonl-framer.test.ts`, `testing/stdout-frame-limit-probe.ts`). BR-1's fragment cache was not built: the measurement was not conclusive, and the figures are in [5900](../agent-engines/5900-acp-state-write-cost-at-the-cap.md).

What the 2026-11-04 fixes do not remove. A Pi history too large to parse within 30 s now reports a timeout on every attempt instead of showing an empty list; it never fills the cache, because Pi does not export its per-file step. An ordinary Pi state write still encodes every session once: only the repeated encoding while shedding went away. Nothing was measured on real workloads (task 1); the BR-12 and BR-14 figures come from the tests' own fixtures.

What BR-5 does not remove: Pi resends a running tool's whole accumulated output on every frame, and `renderToolCall` re-bounds it (`boundText`) before the charge, so a Pi frame still costs O(output) — now one prefix comparison instead of a whole-card serialisation. Getting below that needs Pi's tool rendering to take deltas. ACP's text charge (`Buffer.byteLength(text) * 2`) is not JSON-escaped, so it is not a strict upper bound on encoded growth; it only schedules the bound, which is exact, so it was left alone. Cursor's per-sub-agent byte check (`boundNestedParts` with `measureBytes`) still serialises each live row's nested parts on an exact pass. No before-and-after numbers were taken (task 1).

**Decisions.**

- **Fix each bridge or move the helpers first (BR-15)?** Decided 2026-11-01; done 2026-11-02 for the transcript helpers.
  - **Move the Codex and Cursor versions into `packages/protocol/src/node` first, then fix BR-4 to BR-6 there once (recommended).**
    - Pros: each fix lands once; the good versions already exist.
    - Cons: a protocol change, so `mise run test` across all bridges.
  - **Fix each bridge in place.**
    - Pros: smaller diffs.
    - Cons: three copies of every fix.
- **What invalidates a remembered row size (BR-4)?** Done 2026-11-02 with the first option.
  - **The existing revised-row note, plus row identity and follower checks, verified against a fresh measurement under `bun test` (recommended, taken).**
    - Pros: reuses a hook every older-row change must already call; the newest row, where streaming writes without a note, is always measured; a missed note fails the bridge suites instead of shipping.
    - Cons: a new write path that changes an older row without a note and without a test would make the bound measure that row stale (over or under by that change) until the row is noted or evicted.
  - **A per-row version counter bumped by `rowChanged`, as the report suggested.**
    - Pros: explicit.
    - Cons: the same audit, plus a second hook every path must call.
  - **Skip measuring while the last exact size plus the charged growth is under the budget.**
    - Pros: no per-row state.
    - Cons: relies on every charge being a strict upper bound, which ACP's text charge is not; a transcript at the budget still measures everything on every dirty read, which is the case that costs most.
- **How to keep each bridge's truncated text identical (BR-15)?** Done 2026-11-02 with the first option.
  - **One appender with two named policies (recommended, taken).**
    - Pros: one implementation and memo; output unchanged, proven against copies of the old helpers.
    - Cons: two behaviours remain; unifying them would change what users see at the cap.
  - **Converge on one policy.**
    - Pros: simpler.
    - Cons: changes transcript text in one or two bridges, which this task must not do.
- **Should the SSE replay rings move as part of BR-15?** Done 2026-11-05 with the first option.
  - **Separately, after BR-7 (recommended, taken).**
    - Pros: Claude's ring adopting Codex's superseded-frame collapse changes what a reconnecting client is replayed, which needs its own replay tests; the transcript helpers did not depend on it.
    - Cons: BR-15 stays half open.
  - **Move Codex's `event-ring.ts` into protocol now and point Claude at it.**
    - Pros: closes BR-15.
    - Cons: a behaviour change to Claude's SSE replay in a task meant to leave output unchanged.
- **Change the wire shape of Codex's `message.patched` (BR-7)?** Done 2026-11-04 with the first option.
  - **Make `content` optional, and omit it when unchanged (recommended, taken).**
    - Pros: smaller frames; a patch applies only at `revision - 1`, where the recipient already holds the body, so absent means unchanged and a missed frame is still a revision gap.
    - Cons: a client reading `content` unconditionally would blank the body. None exists: nothing in `apps`, `packages` or `e2e` reads these frames, and the backend uses the content-free `?observe=1` stream.
  - **Leave it.**
    - Pros: no contract change.
    - Cons: frames keep the duplicate.
- **What happens at the notification queue's bound (BR-13)?** Done 2026-11-04 with the first option.
  - **Drop the backlog and replace the child through the existing restart path (recommended, taken).**
    - Pros: a stream with a dropped notification cannot be trusted, and generation recovery re-reads authoritative state; the running turn fails as a restart, which a workflow can continue.
    - Cons: running turns are interrupted, so the limit sits far above what one stdout chunk can hold.
  - **Only measure.**
    - Pros: no new failure mode.
    - Cons: keeps the breach of invariant 11.
- **What should a timed-out Pi session list answer (BR-10)?** Done 2026-11-04 with the first option.
  - **504 with a short fixed message, and abort the read (recommended, taken).**
    - Pros: the existing path shows the reason; no orphaned read.
    - Cons: a list that looked empty now shows an error.
  - **Keep `[]` and log.**
    - Pros: no behaviour change.
    - Cons: the silent failure stays.
- **Where does the ACP harness's default provider go (BR-16)?** Done 2026-11-04 with the first option.
  - **A neutral `acp-fixture` id (recommended, taken).**
    - Pros: nothing implies a Cursor provider on this bridge; the fixture has none of Grok's launch quirks, so existing cases keep testing generic ACP.
    - Cons: a wider diff, though only in that name.
  - **Grok.**
    - Pros: the one real provider.
    - Cons: fixtures would pick up Grok's auth check, read-only profile and model handling, which changes what those cases test.

### 7. Change tracking and git scans

**Problem.** Captures read and hash unchanged files, recount unchanged diffs every pass, and local scans spawn many git processes with no minimum gap.

**Context.** The report's ST-1 to ST-6 and ST-13 to ST-21. fsmonitor is no longer enabled (`docs/architecture/git-scan-caches.md`), so ST-17's second option is gone. Done on 2026-11-02: ST-1 (a host capture reuses a settled stat-cache entry's oid after `fstat`, without reading or hashing), ST-2's first half (libc is `dlopen`ed once per process, and the `readlinkat` probe uses one scratch buffer) and ST-4 (a bounded LRU of line counts by blob pair in `snapshot-diff.ts`). The capture benchmark (`scripts/benchmark-change-tracking.ts`) gained the report's large-asset and 200-changed-file fixtures (`--only=assets,long-turn`). Tests: `capture-stat-reuse.test.ts` and `snapshot-diff-count-cache.test.ts`.

Done on 2026-11-04: ST-3 (`ObjectStore.reuse` leaves a fence younger than half the orphan grace alone, and the closure check skips objects proven present in the pass; `capture-orphan-fence.test.ts`, [change-tracking.md](../../architecture/change-tracking.md) "Retention and backup") and ST-16's minimum gap (`LOCAL_SCAN_MIN_GAP_MS`; `worktree-snapshots.test.ts` "minimum scan gap", [git-scan-caches.md](../../architecture/git-scan-caches.md)). Container helper captures stay out of scope.

Done on 2026-11-05 (ST-21, batch E-0580), re-checked first against `main` at `5467f6ccb`: whole files no longer have to cross the command channel as base64 (`transcript_media_open_stream` also serves an environment-less host path under the `read_file_base64` roots, `readable-host-roots.ts`; the file viewer's images load from a stream capability, `environment-image-source.ts`), a branch read is one `git cat-file --batch` process locally and in containers (`git-blob-read.ts`), and a repeat usage report answers from the finished report kept per query and store revision (`usage-history-store.ts`). Tests: `readable-host-roots.test.ts`, `media-stream.test.ts`, `environment-image-source.test.ts`, `git-blob-read.test.ts`, `usage-history-store.test.ts`. Live evidence and a usage measurement are [5800](5800-file-read-streaming-leftovers.md).

Done on 2026-11-04 (ST-5, ST-6), re-checked first against `main` at `a8bdce444`, on which #1734's `capture.ts` and `object-store.ts` had moved the report's lines. Both findings still applied.

- ST-5: `readManifest` reads through a per-store LRU of deep-frozen parsed manifests (`manifest-cache.ts`; 32 entries, 128 MiB estimated), `findManifestEntry` binary-searches on path bytes for diff pages and restore, and `renderSnapshotBodies` takes `ignoreWhitespace`, so that view renders once. Tests: `manifest-cache.test.ts`, `diff-bodies-lookup.test.ts`.
- ST-6: `ObjectStore.batch()` stages each object as a temporary file, deflating inputs from 16 KiB through the thread pool, and a flush fsyncs the temporaries off the loop, renames them, then fsyncs the directories with unsynced names. Tests: `object-store-write-path.test.ts`. The evidence body store's per-body `fsyncSync` followed on 2026-11-05 (to-do 4761, deleted): `EvidenceBodyStore.put` awaits a file sync before the rename and a directory sync before it resolves (`evidence-body-store.test.ts`). [change-tracking.md](../../architecture/change-tracking.md) "Object writes and durability" and "Manifest cache".

Done on 2026-11-05 (ST-20), re-checked first against `main` at `69a3b4ca5`; all three tasks of report part 0550 still applied. `ObjectStore.sweep` walks without the store lock and re-`lstat`s and removes candidates under it, 64 per hold; the store keeps its byte count across sweeps and retention reads it through `currentBytes()`; retention reads each manifest once per pass and keeps the object ids each manifest names between passes in `ReachabilityCache` (4,096 manifests, 32 MiB). The parsed-manifest cache had served 8 of 400 manifests per pass on the new `--only=retention` fixture. Tests: `retention-store-walks.test.ts`. [change-tracking.md](../../architecture/change-tracking.md) "Retention and backup" and "Benchmarks". Live sizing: [5361](5361-retention-pass-on-a-large-real-store.md).

`TMPDIR=<a directory on the btrfs disk> bun scripts/benchmark-change-tracking.ts --only=large-blob,durable-cold,manifest --runs=7` and `--only=capture,assets,long-turn --sizes=1000,10000 --runs=10`, three interleaved runs each of `a8bdce444` and this code, on the shared build host, btrfs, load average 3 to 18, Bun 1.4.4:

| Workload | Before | After |
| --- | --- | --- |
| 16 MiB changed file captured durably: longest event-loop stall, p50 of runs | 107–143 ms | 12–13 ms |
| Same: longest stall in any run | 109–188 ms | 13–21 ms |
| Same: capture duration, p50 | 148–234 ms | 276–321 ms |
| 1,000 files, cold durable capture: duration, p50 | 3,338–4,108 ms | 632–1,130 ms |
| Same: longest event-loop stall, p50 of runs | 560–661 ms | 2.8–5.2 ms |
| Manifest of 100,000 entries: repeat read, p50 | 26.9–34.9 ms | 0.02–0.10 ms |
| Same: first read | 39–46 ms | 93–140 ms |
| Same: lookups for one 20-row diff page, p50 | 6.4–11.1 ms | 0.04–0.09 ms |
| 10,000 files, one changed, not durable: warm capture, p50 | 113–200 ms | 129–177 ms |
| Long turn, 200 changed files, not durable: compare, p50 | 8.3–11.1 ms | 5.7–13 ms |

The large file's capture takes longer in total, because compression now runs in chunks through the thread pool, while the rest of the backend keeps running. The first read of a manifest costs more because it freezes every entry; a repeat read repays that after about three reads. The non-durable rows show warm captures did not regress; the differences are within the load's noise. The remaining stall on the large file is its read and two SHA-1 passes, about 5 to 7 ms each. `object-store-write-path.test.ts` also compares the stall during a real 16 MiB put and capture against `deflateSync`'s in the same process.

Also done on 2026-11-04: ST-14 (one `git diff --raw --numstat -z -M` per scan on local, container and Git-scope paths, the base's commit reused, the exclude file ensured once per worktree or container), ST-15 (a per-worktree count cache keyed by stat stamp with the settle-window rule, and bounded concurrency in `git-scopes.ts`) and ST-18 (scope demand lasts `gitScopeDemandTtlMs` from the last read; expiry sends a `reset` event so an open view reads again). Tests: `git-diff-summary.test.ts`, `local-git-scan-caches.test.ts`, `commands-files-local-scan.test.ts`, `git-scopes.test.ts` "Git scope demand". [git-scan-caches.md](../../architecture/git-scan-caches.md) has the design and [change-tracking.md](../../architecture/change-tracking.md) the demand rule.

Done on 2026-11-04 (ST-17 and the rest of ST-16), re-checked first against `main` at `e198fd4a7`; the batch's report file was deleted with this work, and [5060](5060-worktree-watch-leftovers.md) holds its last outcomes and what is left. `startWorktreeWatcher` leaves out a `node_modules` Git proves ignored and free of tracked files. On Linux the subtree takes no watches. On macOS one recursive root stays and events under the subtree are dropped on arrival. Either way an install there starts no scan. Tests: `worktree-watch-plan.test.ts`, `worktree-watcher-split.test.ts` and, on both platforms, `worktree-watcher-real.test.ts`. `worktree-snapshots-git.test.ts` passes on Linux and on arktech-mini after repeating mutations to tolerate lost or delayed macOS events (resolved flake [5061](../../tests/flaky-tests/environments-and-containers/5061-real-git-owner-saturated-fseventsd.md)). [git-scan-caches.md](../../architecture/git-scan-caches.md#what-the-worktree-watch-leaves-out) has the design and the numbers.

**Grace-window reasoning (ST-3).** An object's mtime is the orphan fence: `sweep` deletes an unreachable object only when its mtime is more than `orphanGraceMs` old (1 h), and that fence is the only thing protecting an object a capture has adopted but no ledger row names yet. A sweep's reachable set can also be stale, because it is built before the sweep takes the store lock. So a reused object needs to stay undeletable until the capture has committed and a later sweep can see the commit. Skipping the renewal below half the grace leaves at least the other half (30 min) for that, against capture deadlines of 10 to 30 s plus the sweep's walk of the ledger. Without the skip the same assumption held with a full hour; the margin shrinks, the assumption does not change. Past half the grace the object is renewed as before, under the store lock, so the renewal can never land between a sweep's `lstat` and its `rm`.

**Investigation.** ST-14, ST-15 and ST-18, re-checked on 2026-11-04 against `main` at `a8bdce444`: a warm local scan spawned 7 git processes, or 8 with no `origin/<ref>` (the exclude path, the base check, the filter config, two diffs, status, the base oid). A scope view reads a resource once on mount and on a resync, then follows `change-projection-changed` events with no timers (`apps/web/src/lib/changes/subscriptions.ts`); the `reset` event was already in the protocol and handled by both the local and the federated client, but the backend never sent it. `bun scripts/benchmark-local-diff-scan.ts`, workload `scan-1k` (1,000 tracked files, 20 modified, 5 renamed with an edit, 5 deleted, 200 untracked, settled), three interleaved rounds of old and new code, 30 warm scans each, p50 range, load average 10 to 18 on the shared build host (the last row: 2,000 untracked, two rounds of 15):

| Workload | Git processes per scan | Untracked files read | Scan time |
| --- | --- | --- | --- |
| Commit base, before | 7 | 200 | 17.0–25.4 ms |
| Commit base, after | 4 | 0 | 14.8–16.5 ms |
| Tracking base, before | 7 | 200 | 19.6–26.5 ms |
| Tracking base, after | 4 | 0 | 15.0–16.2 ms |
| Commit base, 2,000 untracked, before | 7 | 2,000 | 42.5–48.6 ms |
| Commit base, 2,000 untracked, after | 4 | 0 | 17.9–30.4 ms |

Earlier, re-checked on 2026-11-04 against `main` at `96ee1eb3`: `reuse` still called `utimes` under the store lock for every unchanged file, the closure still called `has` for every entry, and `DiffStatsService.request` started a scan for every hint with none running. Micro-benchmark over 10,000 objects (median of 7, same host):

| Per-object call | 10,000 objects |
| --- | --- |
| `utimes` awaited under a lock (the old `reuse`) | 100 ms |
| `stat` awaited (the old closure `has`) | 80 ms |
| `lstatSync` (the new `reuse`) | 7 ms |
| `Map` lookup | 0.1 ms |

`bun scripts/benchmark-change-tracking.ts --only=capture --sizes=10000,1000 --runs=10`, warm capture p50 range over three runs of the old (`96ee1eb3`) and new store and capture code, on the shared build host:

| Workload | Before | After |
| --- | --- | --- |
| 10,000 files, one changed, runs interleaved, load average 40–56 | 681–797 ms | 211–319 ms |
| 1,000 files, one changed, runs interleaved, load average 40–56 | 62–100 ms | 29–51 ms |
| 10,000 files, one changed, runs one after the other, load average 23–32 before and 16–21 after | 349–482 ms | 107–114 ms |
| 1,000 files, one changed, runs one after the other, same loads | 37–58 ms | 16–17 ms |

Cold captures write objects rather than reuse them and did not improve (one cold capture per round: 2.5–2.7 s old and 2.8–3.4 s new at the higher load, 1.1–1.6 s old and 1.4–1.5 s new at the lower one). The interleaved rows are the fair comparison, because the load moved between the other two batches. Twenty settled bursts over ten seconds now start four or five scans instead of twenty (`worktree-snapshots.test.ts`, fake watcher and clock; not measured under a real install).

Earlier, re-checked on 2026-11-02 against `main` at `38d55ee1`: ST-1, ST-2 and ST-4 were still as the report describes; the rest of this task was not re-checked. Measured on the shared build host under heavy load (load average 25 to 34), three interleaved runs each of the old and new code, 10 warm runs per workload, p50 range:

| Workload | Before | After |
| --- | --- | --- |
| 1,000 files, one changed: warm capture | 114–261 ms | 47–141 ms |
| 10,000 files, one changed: warm capture | 2,330–2,494 ms | 615–1,201 ms |
| 200 files + 20 × 8 MiB assets: warm capture | 281–505 ms | 13–44 ms |
| Long turn, 200 changed files vs the turn start: compare | 149–435 ms | 6–18 ms |

A micro-benchmark over 10,000 small files two directories deep (5 rounds, median): the old `confinedRead` 621 ms, the new one 275 ms (so `dlopen` cost about 35 µs per file), and the stamp-matched skip 44 ms, which includes the whole ancestor walk. Caching directory handles could therefore save at most about 2 µs per file. What remains of a warm capture over many small files is ST-3: `ObjectStore.reuse` (`utimes` under the store lock) and the closure `has`, about 230 ms each per 10,000 files in one profiling run.

Done 2026-11-06, ST-13 (branch `storage-mail-maintenance-3b173b35c92e-r1`, against `main` at `c1724ab74`). The report's two calls had already left the loop: the hourly `VACUUM INTO` and its `quick_check` run in a child process since #1363 (`copyDatabaseInChildProcess`), and a forced hourly or ledger check held the loop 4–25 ms. What still blocked it was the snapshot check's upkeep, every five minutes: `incremental_vacuum` in 4 MiB steps on the backend's connection, each step paying a WAL commit and, every step past 1,000 pages, the automatic checkpoint's copy and fsync. `runDatabaseUpkeep` now runs `PRAGMA optimize` on the backend's connection (its queries are what it reads) and, only when the free list is not empty (`releasableFreePages`), starts `releaseFreePagesInChildProcess` under the copy's supervisor (`runSqliteHelperInChildProcess`, shared with the copy): its own connection with the backend's `synchronous = FULL`, `secure_delete` and `journal_size_limit`, 256 pages (1 MiB) per transaction, a passive checkpoint of its own frames after each, 5 ms between steps, at most 1 GiB a check, and it stops on a busy database. The pre-migration copy and the deletion scrub's release stay in-process; they are [7210](7210-storage-work-left-on-the-event-loop.md).

`mise exec -- bun apps/backend/scripts/storage-maintenance-stall.ts --main-mb 512 --ledger-mb 256 --runs 4`, two interleaved rounds of `c1724ab74` and this code (eight runs each), macOS, Bun 1.4.4, load average 12 to 17 on the shared build host. Stall is the longest lateness of a 2 ms timer chain during the step:

| Step | Before: stall p50 / max | After: stall p50 / max | Wall p50 before / after |
| --- | --- | --- | --- |
| Upkeep (after 1/8 of the rows were deleted) | 140 / 2,356 ms | 6 / 7 ms | 1.5 / 3.0 s |
| `PRAGMA optimize` alone | 13 / 39 ms | 11 / 44 ms | 12 / 10 ms |
| Hourly check, forced due (copy in its child) | 4 / 10 ms | 4 / 25 ms | 1.7 / 2.0 s |
| Ledger check, forced due | 7 / 13 ms | 7 / 13 ms | 1.8 / 1.7 s |
| Pre-migration copy (in-process, unchanged) | 1,522 / 2,868 ms | 1,891 / 2,018 ms | 1.5 / 1.9 s |
| Deletion scrub (in-process, unchanged) | 173 / 189 ms | 169 / 319 ms | 172 / 171 ms |

The release takes longer in total, off the loop, because of the pause and the per-step checkpoint. With a writer committing a small row every 20 ms on the backend's connection during the release (a throwaway script, 256 MiB database with 64 MiB free, two runs each), the longest stall was 165–187 ms with 4 MiB steps in-process, 23–35 ms with 256 KiB steps in-process, and 2–7 ms with the child at 4 MiB steps; one child run at 1 MiB steps showed one 314 ms stall and the other 5 ms, the backend's writer waiting behind a step. A first attempt kept the release in-process with time-fitted steps and a passive checkpoint after each; it measured worse (upkeep stall p50 67 to 178 ms, up to 2,014 ms), because each checkpoint pays an fsync, and was dropped. Tests: `storage-backups-ledger.test.ts` (no child when nothing is free, never `releaseFreePages` on the backend's connection, the budget in steps, giving way to a writer without touching the backend's timeout, a failed child logged without its message) and the supervisor test in `storage-backups.test.ts`.

**Decisions.**

- **First step?** Decided 2026-11-01, done 2026-11-02.
  - **ST-1, ST-2 and ST-4 together, measured with the capture benchmark plus the large-asset and 200-changed-file fixtures the report names (recommended).**
    - Pros: the highest-impact items; one benchmark run proves all three.
    - Cons: the fixtures have to be written first.
  - **ST-16's minimum scan gap first.**
    - Pros: one small change with a clear effect during installs.
    - Cons: leaves the per-capture cost untouched.
- **When may a matching stat stamp stand in for the content?** Done as recommended.
  - **Only when the file's mtime and ctime were at least `STAT_SETTLE_WINDOW_MS` (2 s) old when it was read; a path hint drops its entry (recommended).**
    - Pros: closes Git's "racily clean" case, where a same-size rewrite inside one timestamp tick keeps the stamp; a file stops being re-read 2 s after its last write; restore and watcher hints still force a read.
    - Cons: files the agent is actively writing are read on every capture until they age; one more field (`settled`) in the stat cache.
  - **Trust any matching stamp.**
    - Pros: simplest; skips the most reads.
    - Cons: a racy same-size rewrite would publish the old oid, a wrong capture result.
  - **Trust it and also compare mtime with the capture's own start time, like Git's index.**
    - Pros: the same protection as the window.
    - Cons: needs the previous capture's start time carried with the cache, for no measurable gain over the window.
- **ST-2's second half: cache directory handles within a capture?** Not done.
  - **Leave the per-file ancestor walk (recommended).**
    - Pros: the walk, open and `fstat` together cost about 4 µs per file; no open descriptors outlive a read, so there is no descriptor budget or reuse race to manage.
    - Cons: a few redundant `openat` calls per file remain.
  - **A capture-scoped, reference-counted handle cache.**
    - Pros: fewer syscalls per file.
    - Cons: at most about 20 ms per 10,000 files; needs begin/end hooks on the executor interface (host reads are issued one at a time per capture), a descriptor bound, and keeps a moved or replaced directory open for the rest of the pass.
- **Which line counts are cached?** Done as recommended.
  - **Exact counts and deterministic limits, keyed by kind, both oids and the two deterministic budget fields; a hit is used only while the store still holds both blobs (recommended).**
    - Pros: content addressing means entries never go stale; a deleted or expired body still reads as `body-unavailable`, exactly as before; bounded at 8,192 entries and 4 MiB estimated.
    - Cons: a hit still costs two `stat` calls; a corrupted (rather than missing) object is not noticed on a hit until its body is rendered.
  - **Cache everything, including `cpu-budget` limits.**
    - Pros: simplest.
    - Cons: a wall-clock limit under load would stick for the rest of the process.
- **Container captures?** Not done.
  - **Leave the container helper as it is for now (recommended).**
    - Pros: its hashing runs inside the container, off the backend's event loop, and only hashes cross the boundary.
    - Cons: a container capture still reads every candidate file.
  - **Send cached stamps to the helper so it can skip settled files too.**
    - Pros: the same saving inside the container.
    - Cons: a protocol change to the helper and a larger stdin per batch; needs container qualification.
- **Next step for this task?** Decided 2026-11-04: both, as separate commits.
  - **ST-3: skip the closure `has` for objects proven present in this pass and the `utimes` inside the grace window (recommended).**
    - Pros: it is now the largest part of a warm capture over many small files.
    - Cons: touches the orphan fence that retention relies on, so the grace-window reasoning needs care.
  - **ST-16's minimum scan gap.**
    - Pros: small and independent.
    - Cons: does not touch capture cost.
- **How does a reuse learn how old the fence is?** Done as recommended.
  - **One `lstatSync` per reused object (recommended).**
    - Pros: reads the same mtime `sweep` decides on, so the two cannot disagree; proves the object present in this pass, so a missing object is still read and rewritten; no state to bound and nothing lost on a restart; 7 ms per 10,000 objects.
    - Cons: a synchronous call per unchanged file on the event loop, about 1 µs on this host, beside the synchronous `confinedRead` that already runs per file.
  - **An in-memory map of when each object was last fenced.**
    - Pros: 0.1 ms per 10,000 objects; no system call.
    - Cons: needs its own count and byte bounds; proves nothing in this pass, so a missing object would go unnoticed until the entry aged out; empty after a restart.
  - **An awaited `lstat`.**
    - Pros: never blocks the event loop.
    - Cons: 80 ms per 10,000 objects, so it would keep most of the cost it replaces.
- **How long may a fence go unrenewed?** Done as recommended.
  - **Half the orphan grace (recommended).**
    - Pros: leaves 30 min of the 1 h grace for the capture deadline and the sweep's ledger walk; renews each object at most every 30 min under constant captures.
    - Cons: every object past the window is renewed in one pass, so one warm capture in each half hour pays the old renewal cost.
  - **Up to the whole grace.**
    - Pros: fewer renewals.
    - Cons: an object just inside the grace has no margin left, and a sweep during the capture deletes it. `capture-orphan-fence.test.ts` fails this way.
- **Does the renewal leave the store lock, as the report suggests?** Not done.
  - **Keep it under the lock; only the skip runs without one (recommended).**
    - Pros: a renewal cannot land between a sweep's `lstat` and its `rm`, which would report success for an object about to be deleted.
    - Cons: a pass that does renew still queues behind other store work.
  - **Run every renewal outside the lock.**
    - Pros: no queueing.
    - Cons: opens exactly that race; the renewal is what retention relies on.
- **What does the closure check skip?** Done as recommended.
  - **Objects written or proven present in this pass, unless `removedObjects` shows a sweep removed something since the pass began (recommended).**
    - Pros: no second system call per entry on a normal pass; a pass that overlapped a removal gets the full check it always had.
    - Cons: one more counter on the store, and an object deleted by something other than `sweep` during the pass goes unnoticed until it is read.
  - **Skip it for proven objects unconditionally.**
    - Pros: simplest.
    - Cons: a removal during the pass could publish a manifest with a missing blob.
- **Where does ST-16's gap run from, and what does it hold back?** Done as recommended.
  - **From the end of the last scan, holding back only hints and the reruns they queue, on local targets (recommended).**
    - Pros: a slow scan cannot make the gap vanish; a reader, refresh, known mutation or new target still gets a scan straight away; containers are not spaced twice.
    - Cons: under constant writes the badge can lag by up to 2 s plus a scan.
  - **From the start of the last scan.**
    - Pros: a steadier cadence for quick scans.
    - Cons: a scan longer than the gap would be followed by another at once, which is the cost being removed.
- **How does a large write leave the event loop (ST-6)?** Done as recommended.
  - **Bun's asynchronous `zlib.deflate` and `FileHandle.sync` (recommended).**
    - Pros: measured off the loop under Bun 1.4.4 (a 16 MiB deflate stalled the loop 100–228 ms synchronously and about 7 ms asynchronously); no worker file to bundle and package.
    - Cons: a large object takes about twice as long end to end, because the compression runs in stream chunks through the thread pool.
  - **A worker thread.**
    - Pros: could also take hashing and the manifest's JSON work off the loop.
    - Cons: a new entry point for the bundled backend, for tens of milliseconds at most once zlib has left the loop.
- **Below what size does a zlib call stay on the loop (ST-6)?** Done as recommended.
  - **16 KiB (recommended).**
    - Pros: source files keep the synchronous call, which measured 8 µs against 25 µs asynchronously for an 800-byte file; the longest such call is a few hundred microseconds.
    - Cons: a second code path in `put` and `get`.
  - **Everything off the loop.**
    - Pros: one code path.
    - Cons: three times the per-call cost on the commonest object size.
- **What may a batched fsync defer (ST-6)?** Done as recommended.
  - **Stage temporaries, then fsync, rename and sync directories at the flush, so a final name always means synced content (recommended).**
    - Pros: a crash can lose a name but never leave one over a partial file, which `has` and `reuse` would adopt for good; concurrent fsyncs commit together.
    - Cons: objects are invisible to other writers until the flush, so two captures can compress the same new content twice; a sweep needs to know live temporaries.
  - **Rename first, fsync everything at the end.**
    - Pros: objects are visible at once, no staging state.
    - Cons: a crash can leave a final name over a partial file, and nothing would detect it before a ledger row named it.
  - **Fsync each file before its rename as before, batching only directories.**
    - Pros: smallest change.
    - Cons: directories were already synced per capture, so the per-file cost stays: the sequential fsyncs were most of a cold capture's time.
- **Which directories does a flush sync (ST-6)?** Done as recommended.
  - **Every directory with an unsynced name, store-wide, after any sync already running (recommended).**
    - Pros: a capture that adopts an object another writer has just renamed waits for that name. The previous code synced only `newObjectIds`, so it did not, and `resolveLiveDetail` synced no directory at all; both gaps are closed.
    - Cons: a capture can wait on another writer's sync.
  - **Only the directories of the capture's own new objects.**
    - Pros: no shared state.
    - Cons: keeps that gap, which a test now pins as closed.
- **What happens to staged objects when a capture is abandoned (ST-6)?** Done as recommended.
  - **Publish them on `close`, and flush every 512 objects or 64 MiB (recommended).**
    - Pros: a capture over its deadline leaves progress for its retry, as it did when every object was written at once; otherwise a large repository that never fits one deadline would never finish.
    - Cons: an abandoned capture can overrun by one batch's fsyncs.
  - **Delete them.**
    - Pros: an abandoned capture returns at once.
    - Cons: the retry starts over.
- **How is a failed fsync treated (ST-6)?** Done as recommended.
  - **Fail the capture, except where the platform does not support the sync (recommended).**
    - Pros: nothing is named without being durable; a failed directory is retried by the next flush.
    - Cons: a failing disk now shows as `capture-failed` rather than passing silently.
  - **Ignore every error, as `fsyncPath` did.**
    - Pros: no new failure mode.
    - Cons: an EIO would silently break the durability rule.
- **Where does the manifest cache live, and what does a hit prove (ST-5)?** Done as recommended.
  - **On the store, keyed by oid, with one `stat` per hit (recommended).**
    - Pros: an expired or swept object still reads as absent, so `body-expired` cannot be masked; stores never share entries.
    - Cons: one system call per hit; a file corrupted on disk after caching is not noticed on a hit, though the cached copy was verified when read.
  - **Trust the cache until evicted, invalidating on sweep.**
    - Pros: no system call.
    - Cons: an object removed by anything other than `sweep` would keep answering.
- **Does retention fill the manifest cache (ST-5)?** Done as recommended.
  - **No: a `scan` read uses a hit and keeps nothing (recommended).**
    - Pros: one pass over every snapshot cannot evict what live views use, and it does not pay to freeze each manifest; ST-20 stays free to change this.
    - Cons: retention still parses every uncached manifest.
  - **Read through the cache like every other caller.**
    - Pros: no option.
    - Cons: each hourly pass replaces the whole cache.
- **How is the shared manifest protected (ST-5)?** Done as recommended.
  - **Deep-freeze it and make the `Manifest` type `readonly` throughout (recommended).**
    - Pros: a write fails at compile time and at run time; `tsc` found no caller that wrote.
    - Cons: freezing costs 30 to 50 ms at 100,000 entries, on the loop, once per manifest; that is more than the parse.
  - **Copy on every read.**
    - Pros: no freezing.
    - Cons: costs about what the cache saves.
- **Should the whitespace view share the page's batch budget once it renders once (ST-5)?** Kept per file here; shared on 2026-11-05 by to-do 4760 (deleted): the view renders the page in one `renderSnapshotBodies` call, so later files on a large page show `changes.body.batch-limit` (`diff-bodies-lookup.test.ts`).
  - **Keep one budget per file for now (recommended).**
    - Pros: a client sees the same bodies as before, apart from a limit now being named by the diff shown.
    - Cons: the view stays unbounded across a page.
  - **Share the budget.**
    - Pros: the same bound as the normal view.
    - Cons: a visible change the ticket did not ask for.
- **Should ST-16 also drop hints whose paths are all under ignored directories, as the report suggests?** Done 2026-11-04 for `node_modules` only; the rest is [5060](5060-worktree-watch-leftovers.md), task 2.
  - **Leave out a `node_modules` Git proves ignored and free of tracked files, per plan rather than per burst; leave other ignored directories to the gap (recommended).**
    - Pros: an install starts no scan; dropped events do not count towards an overflow; Git's answer is read once per settled change to the index or a `.gitignore`, not per burst, which answers the report's objection to `check-ignore`; the tree view skips `node_modules`, so nothing visible goes stale.
    - Cons: a build in `dist` still costs a scan every 2 s or so; two more git processes per plan.
  - **Leave them all counting; the gap bounds their cost (the report's recommendation, and this task's earlier decision).**
    - Pros: no new state. `classifyWorktreeChange` records why a location alone is not proof: a build directory can hold tracked or visible untracked files.
    - Cons: an install still costs a scan every 2 s or so while it runs, though once ST-17 stops watching the subtree on Linux no hint exists to count.
  - **Filter hints against the worktree's ignore rules for every ignored directory.**
    - Pros: no scans at all for writes that truly are ignored.
    - Cons: needs an ignore matcher kept current per worktree, and a wrong answer freezes the counts until the two-minute safety scan.
- **Which subtrees may a watch leave out (ST-17)?** Done as recommended.
  - **Only `node_modules`, when `ls-files --directory` and `check-ignore` prove it (recommended).**
    - Pros: it is over 97% of this worktree's directories; the tree view hides it at every depth, so no view depends on its events; a tracked file inside keeps it watched.
    - Cons: `dist`, `.turbo` and `target` stay watched.
  - **Every directory Git proves ignored, as the report says.**
    - Pros: the fewest watches.
    - Cons: the tree view shows those directories and a watched tree is trusted until a hint, so the Files panel would go stale for up to the two-minute safety scan.
  - **The name alone, with no Git process.**
    - Pros: no process.
    - Cons: a tracked file under `node_modules` would be seen only by the safety scan, which the ticket's constraint rules out.
- **What does the watch look like (ST-17)?** The report's recommendation on Linux; re-check showed it does not fit macOS.
  - **Linux: non-recursive on the root and each ancestor of a left-out subtree, recursive on every other child. macOS: one recursive root, dropping events on arrival (chosen).**
    - Pros: each platform pays only what it charges: 4,672 to 170 inotify watches on Linux, no extra stall on macOS; nested `node_modules` are covered, which a top-level-only split would not be.
    - Cons: two behaviours to test; on macOS events still reach JavaScript.
  - **One recursive watch per top-level entry plus a non-recursive root, on every platform (the report's recommendation).**
    - Pros: one behaviour.
    - Cons: on arktech-mini 20 recursive watches blocked the JS thread for 19,836 ms to start, against 2 ms for one; in a monorepo it still watches every nested `node_modules`.
  - **Keep the recursive root on every platform.**
    - Pros: complete and simple.
    - Cons: Bun on Linux takes one inotify watch per directory and walks all of `node_modules`; measured 4,672 on `watch-nm-4k`.
- **What ends a Git scope's demand (ST-18)?** Done as recommended.
  - **A TTL since the last read, and at expiry a `reset` event that makes any open view read again (recommended).**
    - Pros: no new protocol, client change or bookkeeping across reconnects, since the event and its handling already exist; with nothing open a scope costs nothing after one event; an open view stays correct for one extra read per TTL under activity; a lost event is recovered by the resync read.
    - Cons: a closed view still costs recomputes for up to the TTL; an idle environment with an open view re-reads on each two-minute safety scan, as it recomputed before.
  - **A TTL alone, as the report suggests.**
    - Pros: the smallest change.
    - Cons: views read once and then follow events, so a view left open would silently stop updating when the TTL passed. Rejected for that reason.
  - **Tie demand to live subscriptions.**
    - Pros: exact; a closed view stops costing anything at once.
    - Cons: needs a release or lease call in the protocol from every client, including federated ones, and has to survive a client dying without releasing and a reconnect, so it needs a lease and a renewal timer in a renderer that has no timers here today.
- **How long does demand last?** Done as recommended.
  - **Two minutes (recommended).**
    - Pros: a reset costs an open view only one read, so a short window loses little; a closed view stops within two minutes; matches the safety scan, so an idle environment's cost is unchanged.
    - Cons: under constant activity an open view does one extra read every two minutes.
  - **Longer, such as ten minutes.**
    - Pros: fewer resets.
    - Cons: a closed view in a container keeps costing several `docker exec`s per scan for ten minutes.
- **Stat cache: what does a scan keep (ST-15)?** Done as recommended.
  - **Only counts whose stamp was already settled when read, process-wide by worktree path (recommended).**
    - Pros: the rule captures already use, so a racy same-size rewrite cannot publish a stale count; no extra `lstat` for files being written; diff stats and Git scopes share it; every entry is checked against the file.
    - Cons: a file being written is read on every scan until it is 2 s old.
  - **One cache per `DiffStatsTracking`.**
    - Pros: its lifetime follows the backend's.
    - Cons: `GitScopeService` and ad hoc readers would need it passed in, and the entries describe files on the host rather than anything per backend.
- **Exclude file: how long does "ensured" last (ST-14)?** Done as recommended.
  - **Remember the file and its stamp, and compare one `stat` per scan (recommended).**
    - Pros: no process and no read after the first scan; a file rewritten or removed by something else is repaired on the next scan.
    - Cons: one `stat` per scan; an extra `stat` and read beside each ensure.
  - **A bounded set of ensured worktrees, as batch E7's report recommended.**
    - Pros: no system call at all.
    - Cons: an exclude file edited away is not restored until a restart. `commands-integration.test.ts` already requires that repair.
- **Container wire format (ST-14)?** Done as recommended.
  - **One new `ORKESTRATOR_DIFF` frame replacing the two old ones (recommended).**
    - Pros: one parser for every path; the host builds the script on every call, so no response from an older script can arrive.
    - Cons: every fixture of the framing changed.
  - **Keep both frames, split from the one run in the script.**
    - Pros: no fixture changes.
    - Cons: splitting NUL-delimited output in shell is exactly what the framing exists to avoid.

- **ST-13: what still holds the loop, and where does it go?** Done 2026-11-06.
  - **The upkeep's free-page release in a child under the copy's supervisor, `optimize` kept in-process (recommended).**
    - Pros: upkeep's stall from 140 ms p50 (up to 2.4 s) to 6–7 ms; reuses a supervisor that already handles a dead backend, a lost exit and a timeout; the checkpoint's fsync moves with it.
    - Cons: a process every five minutes while free pages remain; a backend writer can wait behind one 1 MiB step; the release takes longer in total.
  - **Keep the release in-process with smaller, time-fitted steps and a checkpoint per step.**
    - Pros: no process.
    - Cons: measured worse; each checkpoint pays an fsync on the loop.
  - **A Bun `Worker` with its own connection, as the report suggested.**
    - Pros: no process start.
    - Cons: a second supervision model beside the copy's; a worker shares the backend's process, so it is not isolated the way the copy's child is.

### 8. tmux and container polling

**Problem.** Each tmux tab still runs up to four separate execs per tick, and container lifecycle changes do not stop the loops that depend on them.

**Context.** Decided 2026-11-01: do the structural container work now. Done that day: an unbound tab searches for its transcript at 2 s backing off to 10 s, and at once on any hook (BG-1); a quiet tab polls at 1 s after eight quiet ticks (BG-2, `TMUX_IDLE_*` in `tmux-shared.ts`); the `docker events` follower also reports `start`, `die`, `stop` and `destroy` and invalidates the shared `docker ps` snapshot (BG-8, `container-oom-events.ts`). Checked against `main` at `7b48c23f` on 2026-11-03: #1612 changed the Claude state signal to version 3 (`StopFailure`) and left the tmux loop as described.

Done 2026-11-03 (see [container-lifecycle.md](../../architecture/container-lifecycle.md), "claude-tmux hook doorbell" and "Container lifecycle events"):

- BG-2: one `docker exec` per tick. `pollSnapshotScript` also carries `tmux has-session`, the pane (framed by a per-call nonce) and the expected transcript. The doorbell decided below: `orkestrator-state-signal hook` (`tmux-hook-signal=1`) rings `/tmux-hook-signal` after the container hook script writes a hook file; `TmuxHookSignalManager` (`tmux-hook-signal.ts`) arms it per container like the Claude state signal and wakes that container's tab loops. A confirmed idle tab sleeps until a ring or a 2.5 s safety read; a hook file no ring announced demotes it. Older images keep the per-tick poll.
- BG-1: the snapshot binds `<session id>.jsonl` the moment it exists, so the fallback search runs only for a tab it cannot bind, after the tick's snapshot. That search reads a 64 KiB head per candidate (`transcriptHeadClaimsSession`) and remembers rejected candidates by mtime, or for good once the head is full (`TRANSCRIPT_REJECTED_MEMO_LIMIT`, 256).
- BG-8: `ContainerLifecycleReactor` (`container-lifecycle-events.ts`). `die`, `stop` and `destroy` retire the container's Claude state poll, hook doorbell and tmux tabs at once. Unless a lifecycle operation owns the environment, the reactor then reconciles stored status with one inspect and re-syncs the diff, PR and state loops; a start outside the app re-adopts them.
- BG-7: a Claude state poll keeps the 1 s cadence only while the container has a terminal shell or a claude-tmux tab (`terminalClaudeDemand`); otherwise one read on adoption, then the 30 s safety read.

Exec counts per tab (`apps/backend/scripts/tmux-exec-count.ts`: the real loop against a fake container, 600 simulated seconds; before is `7b48c23f`):

| Tab | Before | Older image | Doorbell |
| --- | --- | --- | --- |
| Idle, transcript bound | 1.85/s (snapshot 1.01, has-session 0.50, capture-pane 0.34) | 1.01/s | 0.42/s |
| Idle, unbound | 2.57/s (discovery 0.72) | 1.12/s (discovery 0.11) | 0.52/s |
| Busy | 6.50/s (capture-pane 2.00) | 4.00/s | 4.00/s |

Live on beelink with the locally built image `orkestrator-v2:dev-task8-7d4bb95362a6` (`tmux-hook-signal-docker.test.ts`): a real idle tab on a real tmux session cost 4 execs in 10 s, and a rung hook was drained in under 2 s.

Rechecked 2026-11-03 at `70c0228d1` (after the review fixes), image rebuilt from that commit as `orkestrator-v2:dev-f9ed233a0aa0` (`mise run docker:build:dev --profile task8r2-7d4bb95362a6`, exit 0); its manifest declares `tmux-hook-signal: 1` and `claude-state-signal: 3`. `tmux-hook-signal-docker.test.ts` against it: four runs at 4 execs in 10 s idle, plus one through `test:logged` (`task8-image-doorbell`), all passed. Its first run at that commit counted 7 and failed the old bound of 6, because the tab had no transcript and so also ran the fallback search, and pre-idle ticks could fall inside the window. The test now seeds the transcript, starts counting inside the idle wait, and asserts at most 4 execs and no search. Older image: `orkestrator-v2:latest`'s manifest has no `tmux-hook-signal` and its `orkestrator-state-signal hook` exits 0, so it stays on the one-exec poll. `tmux-exec-count.ts --seconds 600` reproduced the table above exactly, before and after.

Done 2026-11-04, BG-14: a tab reopen reads one page from the transcript's tail (`readPage` in `tmux-transcript-reader.ts`, at most 512 KiB and 500 records, one `docker exec`) and the renderer pages earlier history in (`ClaudeTmuxChatTab.tsx`, `prependTranscriptPage` in `claudeTmuxStore.ts`). Task snapshots no longer need a replay: the poll tail's one pass records each call's snapshot (`TaskSnapshotHistory`). Through a fake `docker` on PATH (`apps/backend/scripts/tmux-reopen-read-size.ts`, workload "longest session"): 36,853,890 bytes in 2 execs before, 524,306 bytes in 1 exec after. Remaining live evidence: [5120](../transcripts-and-observation/5120-tmux-transcript-reopen-live-evidence.md).

Done 2026-11-06, BG-15 (branch `storage-mail-maintenance-3b173b35c92e-r1`, against `main` at `c1724ab74`). The mail injector hands the dispatch the presence its gate just read (`tmuxPresenceRead` in `agent-mail-service.ts`). When that is `idle`, `dispatchMailInject` skips the environment, queue and draft reads it made before the probe, because the gate made the same three reads moments earlier; without a presence (or with any other) it still makes them first. Everything task 10 relies on stays: the liveness probe is still fresh (`claude_tmux_status` with no reuse age), and the environment, queue and draft are read again after it (`mailInjectHold`, which now also re-checks the environment there, so a deletion requested between the gate and the dispatch holds the mail rather than reaching the boundary's refusal), then the queue boundary as before. `mise exec -- bun apps/backend/scripts/tmux-mail-inject-reads.ts --deliveries 2000`, the real drainer over a real `StorageService` with a fake tab, two rounds each of `c1724ab74` and this code:

| Per delivery to an idle tab | Before | After |
| --- | --- | --- |
| Keyed reads (environment / queue / draft) | 9 (2 / 3 / 4) | 7 (2 / 2 / 3) |
| `claude_tmux_status`: fresh / recent allowed | 1 / 1 | 1 / 1 |
| Wall time, p50 / p95 | 0.15–0.16 / 0.35–0.55 ms | 0.14–0.16 / 0.34–0.45 ms |

So the saving is two keyed reads per delivered message, as the analysis expected; the time is within noise. Tests: `prompt-queue-drainer.test.ts` (read counts with and without the presence, one fresh probe either way; a deletion or a queued prompt arriving after the gate still holds the mail) and `agent-mail-service-presence.test.ts` (the presence reaches the dispatch, and none is passed when the drainer has no gate). A delivery to a real claude-tmux tab, with a loopback fake model, is in task 1 (2026-11-06).

**Investigation.** BG-15 is done (above). The doorbell's network hop to a real backend is proven only where containers reach the host (the Linux Engine workflow); beelink's cannot, so its test rings a fake doorbell on the container's loopback.

**Decisions.**

- **Co-process or doorbell for BG-2?** Decided and done 2026-11-03: the doorbell.
  - **A doorbell on the hook directories, reusing `claude-state-signal` (recommended).**
    - Pros: a pattern already in the image; idle tabs cost nothing until a hook fires.
    - Cons: needs an image change, so older containers keep polling and need a fallback.
  - **One long-lived `docker exec -i` co-process per container.**
    - Pros: no image change.
    - Cons: a new long-lived process to supervise, bound and restart; its death must be detected.
- **BG-14: how to stop a reopen replaying the whole transcript?** Decided and done 2026-11-04: page from the tail.
  - **Page from the tail, as native transcripts page their history (recommended).**
    - Pros: one bounded read per reopen; the renderer already has a paged history view for native tabs.
    - Cons: the tmux chat tab has to move onto paged history; renderer and backend change together.
  - **Resume from the client's last byte offset.**
    - Pros: small backend change.
    - Cons: the offset is lost with the tab's state, and the task list must still be rebuilt from the start of the file.
- **BG-15: pass the presence snapshot into the mail inject?** Done 2026-11-06: the third option, which the analysis did not list.
  - **Leave it.**
    - Pros: the repeat is three keyed reads per delivered message, not per tick; no change.
    - Cons: those reads remain.
  - **Pass the presence answer through and act on it.**
    - Pros: saves the reads and the probe.
    - Cons: dispatch would act on a liveness answer up to 3 s old, which task 10 ruled out.
  - **Pass it through only to skip the pre-probe reads, keeping the fresh probe and the reads after it (recommended).**
    - Pros: two keyed reads fewer per delivery; the decision to type still rests on reads made after a fresh probe, so task 10's guarantee is unchanged; an unchecked caller keeps the old order.
    - Cons: a small saving (7 instead of 9 keyed reads); the dispatch has one more optional argument.

### 9. PR monitor cost

**Problem.** Every open PR costs one `gh` process and one GraphQL query every 20 s for as long as it stays open; ten PRs use about 2,400 queries an hour of the 5,000-point budget.

**Context.** Decided 2026-11-01: batch PRs into one GraphQL query per host first; then back off only PRs with no pending checks and auto-merge off, because a finishing check may not change `updatedAt`. Auto-merge (#1494) shipped after the report and relies on this monitor. BG-13 (`get_environments` triggering a whole-installation sync) belongs here too. Done 2026-11-03:

- BG-6 batching (`commands-pr-monitor-batch.ts`): a local known-PR lookup reads every open PR of its (GitHub host, Settings credential source) group in one aliased `gh api graphql` query, rollup included, at most 25 per query. Other members' background polls in the next 10 s use that reading without a process; concurrent polls share the query in flight. A user refresh, pending mode or agent completion asks fresh. Anything the batch cannot answer (another host, a PR GitHub left out, a renamed repository, a failed or unparseable batch, a rollup over one page) takes today's per-PR `gh pr view`; a failed batch suspends its group for 5 min, and rate limits and timeouts reach the monitor's cooldown instead of a per-PR retry. Credential rotation (`rotateScope("local-gh")`) drops the group's readings. Containers stay on the per-PR path.
- BG-6 backoff (`pr-monitor.ts`, `pr-monitor-policy.ts`): an open PR whose reading (state, mergeability, head, `updatedAt`, rollup counts, GitHub auto-merge) has not moved for 15 min, whose last rollup succeeded with nothing pending, whose mergeability is known and with neither Orkestrator's `autoMerge` nor GitHub's auto-merge on, is polled every 2 min (+ up to 15 s jitter). Any wake, a changed reading, turning auto-merge on, or a change a batch saw for that PR returns it to 20 s at once. The per-PR lookup now also asks for `updatedAt,autoMergeRequest`.
- BG-13 (`pr-monitor-runtime.ts`): a sync queued behind the running one that has not read storage yet answers every later caller, so a burst of `get_environments` costs at most one running and one queued reconciliation. The project-scoped sync was not done.

Tests: `commands-pr-monitor-batch.test.ts` (reader rules, and the `gh` boundary through a fake `gh` on PATH), `tests/pr-monitor-quiet.test.ts`, `pr-monitor-policy.test.ts`, `pr-monitor-runtime.test.ts`.

**Investigation.** Containers: each sources its own runtime credential inside the container, which the backend cannot prove equal to another's, so the recommended option below was taken and containers keep one lookup per PR (they gain only the backoff). Not checked live: GitHub's real response to a batch where one alias is inaccessible (`gh api` is expected to exit non-zero and still print the answered aliases, which the reader parses), and the before-and-after query counts (task 1).

**Decisions.**

- **How to batch across containers?**
  - **Batch per (host, credential) group, and keep containers whose `gh` cannot be shared on today's per-PR path (recommended).**
    - Pros: no credential crosses an environment boundary.
    - Cons: containers gain less.
  - **Run every query from the host's `gh`.**
    - Pros: the biggest saving.
    - Cons: the host credential may not see a container's repository, and it changes whose identity polls.

### 10. Other background jobs

**Problem.** Some 2 s and 5 s jobs still did per-item work that could be skipped.

**Context.** Done on 2026-11-01: mail presence returns early while messaging is disabled; it still refreshes while paused (see Assumptions and decisions). Done on 2026-11-02, re-checked against `main` at `38d55ee14` first (all four were still true there):

- BG-3. `refreshPresenceOnce` (`agent-mail-service.ts`) reads each environment once per pass and records a stopped one's presence without any per-mailbox read: native `environment_stopped` when the environment is missing, being deleted or not running; tmux `environment_unready` when it is not ready for agents. Those are the answers the per-mailbox reads give, so the inject-backoff reset on a change is unchanged. Coordinator runtimes and unreadable rows still take the per-mailbox read. Tmux presence passes `livenessMaxAgeMs: 3000` to `claude_tmux_status`, which takes the session's last `has-session` answer (`TmuxSession.recentLiveness`, recorded by every `tmuxAlive`) when it is that recent and probes otherwise. A dispatch still probes.
- BG-9. `AgentHumanPromptMonitor` reuses a working session's last observation while `NativeAgentService.humanPromptContentRevision` (provider session id plus the activity sweep's `contentRevision`) is unchanged, for at most 30 s (`HUMAN_PROMPT_PROJECTION_REUSE_MS`). Background task files are still read every pass. Providers that report no revision (OpenCode, Cursor, Pi, Grok) are read every pass as before. OpenCode's `humanPromptOutput` normalises only the newest 64 rows (`normalizeOpenCodeTranscriptTail`, `HUMAN_PROMPT_OBSERVATION_ROWS`) instead of the whole retained history.
- BG-11. `BuildPipelineReviewFanout.reviewHost` builds the shared package prompt (review instruction plus project notes) once per pass for the package it describes; a failed build is dropped.
- BG-12. `syncContainerClaudeLoginUnlocked` compares the pushed digest of a matching keeper handover before the marker `docker exec`; the keeper passes its one read of configuration and environments (`ClaudeLoginPassSnapshot`) for the first gate, and delivery still re-reads its fences after host I/O.

**Investigation.** Counted with the new tests run against the old code: a stopped environment's native mailbox did 1 presence read per pass (now 0), a stopped tmux mailbox 1 (now 0); a four-reviewer dispatch pass read the project notes 5 times (now 2, one of which is the pass's own); four human-prompt passes over a session whose revision changed once made 4 bridge reads (now 2); an unchanged Claude login cost one marker `docker exec` per container per keeper pass (now none). These are unit counts, not the live `recurringWork` diagnostics task 1 asks for.

**Decisions.**

- **BG-3: where does a stopped environment get skipped?**
  - **In `refreshPresenceOnce`, from the environment's status before any per-mailbox read (recommended, done).**
    - Pros: one place; no reads for stopped environments.
    - Cons: one environment read per environment per pass; defers the native read's backstop that clears a refused mail dispatch (see Assumptions and decisions).
  - **Compute presence lazily on `list_mailboxes`.**
    - Pros: no periodic work at all.
    - Cons: delivery decisions in the inject drain also read presence, so it changes their timing.
- **BG-9: what may the monitor skip on an unchanged revision?**
  - **The bridge observation only, reusing the last one for at most 30 s; task files are read every pass (recommended, done).**
    - Pros: an unchanged session costs no request; a file that grows outside the revision is still seen.
    - Cons: only Claude and Codex report a revision; the cache holds up to 256 bounded observations.
  - **Skip the whole session, files included.**
    - Pros: no work at all.
    - Cons: misses a background task's sign-in prompt, which only appears in its output file.
- **BG-12: what does the digest check skip?**
  - **The marker read, and only when the keeper's handover is for the pinned account and generation (recommended, done).**
    - Pros: no extra host credential read; every path past it would have written nothing.
    - Cons: the handover's MCP digests are remembered before the marker check.
  - **Read the login afresh to compare even without a matching handover.**
    - Pros: covers every caller.
    - Cons: adds a host credential read (a `security` call on macOS) where the marker would have stopped the sync.

### 11. Gateway and preview proxy

**Problem.** Per-frame and per-request costs in the gateway. The preview proxy's missing upstream connection reuse (GW-8) and stripped ETags (GW-9), the terminal socket back-pressure (GW-6), the event frame costs (GW-5, GW-12, GW-14), the small per-chunk and per-frame costs (GW-16), the shared name and window of relayed events (GW-11) and the compression before a static 304 (GW-15) are fixed. The preview rewrite's regex passes (GW-10) were measured and declined.

**Context.** Done: the shared SSE decoder is linear (GW-4). GW-2 is done in 0052 (D14). Done on 2026-11-02:

- GW-8: the private-origin proxy keeps idle upstream connections (`apps/backend/src/preview-upstream-pool.ts`). A connection is reused only by the access (attachment), endpoint generation and target it was opened for, after the access and target are re-checked. The pool is registered with the access service, so revocation, expiry and a new endpoint generation close it at once; a registry revocation also drops it. Bounds: 8 idle per access, 64 per backend, 2 s idle. A safe bodyless request whose reused connection was already closed is resent once on a fresh connection (`preview-forward.ts`); nothing else is retried. Counters `upstream.opened`, `upstream.reused`, `upstream.stale_retry` and the gauge `publication.upstream_idle` are in preview diagnostics.
- GW-9: when the gateway proxy compresses a body, or the legacy browser-preview route rewrites one, it sends a weak ETag derived from the upstream tag, `W/"<upstream>|ork:<w|s>:<coding>[:<rewrite key>]"`, instead of none, and turns it back into the upstream's exact tag on `If-None-Match` (`apps/backend/src/gateway-proxy-etag.ts`). The application's 304 is answered with the client's tag. Reloads now revalidate, so GW-10's rewrite runs only on first loads and changed modules.
- GW-6, done 2026-11-04: `flush` in `apps/backend/src/terminal-websocket-server.ts` stops moving channel frames to a socket holding 256 KiB (`TERMINAL_WEBSOCKET_FLUSH_LOW_WATERMARK_BYTES`) and resumes from the `ws.send` callback. The backlog stays in the per-channel queues, so the 512 KiB channel limit desyncs only the channel that built it. Control frames ignore the watermark. A paused socket does no work: it is not rescheduled, and new output waits for the callback.
- GW-5, done 2026-11-04: a frame is UTF-8 encoded once (`encodeGatewayFrame` in `gateway-event-replay.ts`), the replay ring holds that `Buffer` instead of the string, every client is written the same `Buffer`, and writers take the byte count as an argument (`EventClientWriter.write(chunk, byteLength?)`). Only short fixed strings such as keepalives are still measured by the writer.
- GW-12, done 2026-11-04: `GatewayEvents.writeReplayFrames` writes one cursor frame per run of skipped events, just before the next matching frame or at the end of the window. The cursor it carries is the newest skipped revision. `gateway.connected`'s `replayed` count and the replay metrics still count the whole window.
- GW-14, done 2026-11-04: `since()` finds the range with `slice(revision + 1 - oldest)`, and `replay.ring.oversizedAppends` in `/__orkestrator/metrics` counts frames larger than the ring's byte bound. Such a frame still empties the window, which keeps the gap detectable.
- GW-11, done 2026-11-05 (batch E18): relayed events are named `relayed-node-event:<nodeId>` and kept in their own ring (`relayedEventReplay`, 512 frames, 512 KiB). A renderer reads them on one stream filtered to its watched nodes, with its own cursor (`RelayedEventStream`, `packages/protocol/src/relayed-event-stream.ts`), and its main stream asks for none. A stream that does not ask keeps getting the old name, with a `resync` per node on reconnect; both directions are in the [register](../../architecture/version-compatibility.md#register). Tests: `apps/backend/tests/gateway-relayed-events.test.ts`, `apps/web/src/lib/native/web-gateway-relayed-stream.test.ts`, the per-node cases in `node-events.test.ts`. Live checks: [5840](5840-relayed-events-live-evidence.md). The desktop's main process takes them the same way, on one filtered stream for what its windows listen to (`apps/backend/tests/gateway-desktop-relayed-stream.test.ts`).
- Scoped replay budget, done 2026-11-05 (batch E18): `replayFitsClientBudget` charges a scoped client for matching frames plus one cursor per run of skips. Tests: "the replay budget of a scoped client" in `apps/backend/tests/gateway-frame-costs.test.ts`.
- GW-16, done 2026-11-04. Idle deadlines: `gateway-proxy.ts` (`rewriteIdle`, `armIdleTimer`) and `preview-forward.ts` (`resetIdle`) refresh one timer per body. Decoders: two module-level decoders in `terminal-websocket-server.ts`. Operation results: on the `orkestrator-terminal.v1.input-results` subprotocol, input that succeeded is answered by one cumulative `input-results` frame per channel per flush; failures and resizes stay alone, and results collected so far go out ahead of any other control frame, so control frames keep their order. A client offering only v1 keeps one `operation-result` per input, and such a socket counts `terminal-websocket.per-input-results`. Acks: `DEFAULT_TERMINAL_ACKNOWLEDGEMENT_DELAY_MS` is 1 s. Tests: `apps/backend/tests/terminal-websocket-input-results.test.ts`, `terminal-websocket-client-gateway.test.ts` (the renderer's client against the real gateway), `gateway-proxy-idle-timers.test.ts`, the idle-deadline case in `preview-forward.test.ts`, and the cumulative-results and default-delay cases in `terminal-websocket-client.test.ts`.
- GW-15, done 2026-11-05 (batch E24): `heldStaticFallbackEncoding` in `gateway-proxy.ts` compares a static revalidation with the tag of every variant the request could have been given before anything is compressed, and answers with the variant the client holds. That 304 omits a coded `Content-Length`, which only compressing would tell us. `*` takes the normal path, since it names no variant. No result cache. Tests: `apps/backend/tests/gateway-static-revalidation.test.ts`. A revalidation by date alone still compresses: [6160](6160-static-if-modified-since-compression.md).
- GW-10, declined 2026-11-05 (batch E24): see the numbers under **Investigation** and the decision below. `rewriteBrowserPreviewBody` is unchanged.
- Tests for these four: `apps/backend/tests/terminal-websocket-backpressure.test.ts`, `apps/backend/tests/gateway-frame-costs.test.ts`, and the window and oversized cases in `apps/backend/src/gateway-event-replay.test.ts`.
- Tests for GW-8 and GW-9: `preview-upstream-pool.test.ts`, the reuse cases in `preview-forward.test.ts` and `preview-publication.test.ts`, `gateway-proxy-etag.test.ts`, and in `test:preview:browser` `e2e/preview/upstream-pool.spec.ts` (reuse, revocation and generation change close idle connections, legacy-route 304) plus the opt-in measurement `e2e/preview/vite-page-load.spec.ts`. The whole `test:preview:browser` suite with the Vite fixture passed twice in Chromium, Firefox and WebKit (58 passed, 2 skipped: the Chromium-only measurement). On beelink WebKit ran only with Ubuntu 24.04's `libicu74`, `libxml2` and `libflite1` libraries added to a private copy of the WebKit bundle (see 2680).

**Investigation.** Re-checked on 2026-11-02 against `main` at `38d55ee14`. GW-8 held for the private origin only: `preview-http-proxy.ts` supplied no `reuse` hook although the forwarder and HTTP client supported one, while Electron's local ingress already pooled its tunnel connections and the legacy route already reused connections through Bun's HTTP client. GW-9 held for the legacy browser-preview route and the compressing loopback proxy; the private origin already passed ETags through, so its reloads already got 304s.

Measured with `vite-page-load.spec.ts` (Chromium, the pinned Vite 7.3.6 fixture in an isolated copy plus a generated 150-module page, `/wide.html`; medians of 5 loads per run, 3 runs each). "Again" is a second load in the same tab, "cold" a load after clearing the HTTP cache.

| Wide page (156 requests) | Before | After |
| --- | --- | --- |
| Private origin, upstream connections: first / again / cold | 155 / 155 / 155 | 7 / 1 / 1 |
| Legacy route, bytes on a repeat load | 121 KB (no revalidation) | 0 (154 of 154 answered 304) |
| Legacy route, 304s at the gateway on a repeat load | 0 | 154 |

The fixture's own page (7 requests): private-origin connections 6 / 6 / 6 before, 3 / 1 / 1 after; legacy repeat-load bytes 43.5 KB before, 0 after. Page-load times were taken on beelink with about ten builds running (load average 30 to 55) and moved more with host load than with the change: wide-page private-origin first load 418 ms median before and 622 ms after, but in different load windows. An interleaved A/B on the same build (four alternating runs with reuse on and off, `ORKESTRATOR_TEST_PREVIEW_POOL_OFF=1`, load average about 50) gave wide-page private-origin medians of 753 ms on / 744 ms off for a first load, 540 / 577 ms for a repeat load and 611 / 645 ms after clearing the cache, with 7 / 1 / 1 against 155 / 155 / 155 upstream connections: within noise. On loopback a TCP connect costs well under a millisecond, so the gain is in connections, sockets and, for TLS and relay targets, handshakes, not visible milliseconds. Raw lines are in `output/efficiency/preview-page-load/` of the build worktree (git-ignored).

Re-checked on 2026-11-04 against `main` at `a8bdce444`, and reproduced on the unchanged code before any change (table below). All four held as the report describes, at moved lines:

- GW-6: `flush` (`terminal-websocket-server.ts:885-932`) never read `bufferedAmount`; the quiet channel's check was in `enqueueOutput` (`:795-813`).
- GW-5: `emit` serialised once (`gateway-events.ts:38-62`), then both writers (`gateway-support-extra.ts:674`, `:721`) and `instrumentGatewayResponse` (`gateway-support-core.ts:1321`) measured the string again.
- GW-12: one cursor per skipped frame (`gateway-events.ts:214`, loop at `:316-320`).
- GW-14: `frames.filter` at `gateway-event-replay.ts:162`; eviction loop at `:131-136` with only `droppedFrames` counted.

Bun's `ws` was checked directly, since 0100 had only read it from code. With a raw TCP peer that stopped reading (Bun 1.4.4, 16 KiB frames over loopback), `send` callbacks were never synchronous, and they fired for the frames the kernel took (about 4.4 MB). They then stopped while `bufferedAmount` climbed to 8.6 MB, and all arrived once the peer resumed. So a stalled socket produces no callbacks, which makes the callback a sound resume signal.

**Before and after.** `apps/backend/scripts/gateway-frame-costs.ts`, the same script against `a8bdce444` and against this change, 5 runs each on one host with load average about 3, Bun 1.4.4. Ranges are the 5 runs. Each workload runs the real gateway over real sockets, except `replay-lookup`, which calls `GatewayEventReplay` directly. Raw JSON is in `output/efficiency/gateway-frame-costs/` of the build worktree (git-ignored).

| Workload | Measure | Before | After |
| --- | --- | --- | --- |
| `terminal-flood` (GW-6): two channels on one socket, peer stops reading, 1,024 × 16 KiB noisy and 32 × 1 KiB quiet frames | Quiet channel desyncs per run | 1 | 0 |
| | Noisy channel desyncs per run | 1 | 1 |
| | Quiet frames delivered of 32 | 25 | 32 |
| | Noisy frames delivered before its desync | 383–385 | 273–275 |
| | Peak queued bytes | 2,096,561–2,097,093 | 783,640–784,172 |
| `terminal-burst` (GW-6 regression check): the same emission, peer keeps reading | Desyncs, either channel | 0 | 0 |
| | Time to deliver the burst (corrected 2026-11-04; no fixed sleep) | 14–35 ms | 19–33 ms |
| `fan-out` (GW-5): 200 × 64 KiB authoritative events, 4 event streams | Frame measures (`Buffer.byteLength`) per emit | 13 | 0 |
| | Time inside `emit` per event | 433–565 µs | 258–426 µs |
| `scoped-replay` (GW-12): `?events=menu-` reconnects across 1,500 skipped, 1 matching, 500 skipped | Cursor frames | 2,000 | 2 |
| | Stream bytes | 181,180 | 469 |
| | Ends on the latest cursor | yes | yes |
| `replay-lookup` (GW-14): full 2,048-frame window | `since()`, newest 64 frames | 2,454–2,593 ns | 68–260 ns |
| | `since()`, whole window | 7,963–8,762 ns | 2,060–7,099 ns |

Review correction (2026-11-04): the original burst timings included a fixed 100 ms sleep and are superseded. The corrected script sleeps only for the stalled-peer workload. Five runs each with the current terminal server and the terminal server from a8bdce444 (all other gateway sources held current), delivered 1,024 noisy and 32 quiet frames in order with no desync in every run. Raw aggregates: `output/efficiency/gateway-frame-costs/burst-corrected-before.json` and `burst-corrected-after.json`. These synthetic ranges overlap; they do not establish zero latency cost.

The noisy channel now desyncs sooner: about 110 frames (1.8 MB) earlier in this workload, because it no longer has the socket's 2 MiB to fill. The timings move with the host: an earlier `fan-out` pair on the same builds gave 447–481 µs before and 192–403 µs after, and the whole-window `since()` range after the change is wide. The desync, frame-measure and cursor counts did not vary between runs.

Not re-checked: GW-10, GW-11, GW-15.

Re-checked GW-16 on 2026-11-04 against `main` at `e198fd4a7`: all four items held, at moved lines (`gateway-proxy.ts:313-329` and `:563-571`, `preview-forward.ts:316-326`, `terminal-websocket-server.ts:426` and `:586`, `operationResult` at `:1101`, `terminal-websocket-client.ts:99`). An ack was found to be redundant on the server: `channel()` already resets `invalidChannelFrames` for any valid channel, before the ack's own reset runs.

`timer.refresh()` under Bun 1.4.4, which 0375 had not exercised: it moves the deadline from now, keeps an unreferenced timer unreferenced, and does nothing after `clearTimeout`, but re-arms a timer that has already fired. So `armIdleTimer` still creates a new timer after one fires, and the other two sites can only re-arm through data on a stream the firing already destroyed, which is a no-op. A refresh took about 36 ns against 91 ns for a clear and a new timer, so the saving is allocation churn rather than noticeable time.

**GW-16 before and after.** `apps/backend/scripts/terminal-input-costs.ts`: the real gateway and the renderer's real client over a real socket, against a fake backend. The same script ran with the five changed sources at `e198fd4a7` and with this change, 5 runs before and 10 after (two sets, one either side of the before set), on one host with load average 3.5 to 5.9, Bun 1.4.4. Ranges are those runs. Raw JSON is in `output/efficiency/e19/` of the build worktree (git-ignored).

| Workload | Measure | Before | After |
| --- | --- | --- | --- |
| `proxy-chunks`: one 64-chunk body through each idle deadline (buffered proxy, preview rewrite, preview forwarder) | Idle timers created per body, each site | 65 | 1 |
| `typing`: 200 keystrokes 15 ms apart, each echoed | Decoders constructed | 253–256 | 0 |
| | Result frames | 200 | 200 |
| | Result bytes | 17,692 | 12,492 |
| | Ack frames | 53–56 | 4 |
| | Keystroke to result, median | 0.22–0.34 ms | 0.21–0.30 ms |
| | Keystroke to result, 95th percentile | 0.35–0.54 ms | 0.34–0.51 ms |
| | Writes and results in order, none lost | yes | yes |
| `burst`: 200 keystrokes in one turn, writes complete at once | Decoders constructed | 200 | 0 |
| | Result frames | 200 | 1 |
| | Result bytes | 17,692 | 63 |
| | All settled | 2.65–3.41 ms | 1.17–2.13 ms |
| | Writes and results in order, none lost | yes | yes |
| `burst-slow-write`: the same burst, each write takes 1 ms | Result frames | 200 | 200 |
| | Result bytes | 17,692 | 12,492 |
| | All settled | 250.8–253.4 ms | 250.2–262.0 ms |
| `output`: one channel, 100 frames a second for 5 s | Ack frames | 100 | 5 |
| | Acks per second | 17.6–17.7 | 0.87–0.88 |
| | Ack payload bytes | 5,780 | 289 |

The counts did not vary between runs, except the before `typing` acks and decoders shown as ranges. The latency ranges overlap, and these synthetic figures show no measurable added delay rather than none at all.

**Real Chromium, real shell.** An isolated `dev:test` profile at this change, with the transport turned on and frames counted in the page (loopback, counts only). Chromium offered both subprotocols and the server selected input results.

| 25 ms typing, then keys with no delay, then a reload | Negotiated | Offering only v1, as an older client |
| --- | --- | --- |
| Typing: input frames / result frames | 52 / 52 | 52 / 52 |
| No-delay keys: input frames / result frames | 316 / 314 | 316 / 316 |
| Failed results, socket closes | 0, 0 | 0, 0 |
| Typed text intact in the terminal's output | yes | yes |
| Input works after a reload | yes | yes |

So on a real shell the frame count barely falls: each write finishes in its own event-loop turn, and Playwright's no-delay keys still arrive one at a time. A person typing, or keys over any path where results finish apart, gets one frame per key, about 29% smaller (88 to 62 bytes on average). The frame count only falls when results finish together, as in `burst`. No batching that adds no delay can do better than this, and a wait long enough to merge keystrokes would be the delay the ticket forbids. `e2e/agent-testing/terminal-input-resume.spec.ts -g websocket` also passed on that profile.

**GW-10 first-load numbers.** Measured on 2026-11-05 against `main` at `0194a0675` with `apps/backend/scripts/preview-rewrite-costs.ts`: bodies captured from a real Vite dev server, medians of 15 interleaved rounds for the rewriter and 7 for the replay through the real gateway, three sets at load average 41 to 49, ranges across the sets. The client shares the gateway's process, and raw JSON is in `output/efficiency/e24/` of the build worktree (git-ignored). `web` is this repository's `apps/web` with every lazy route, so an upper bound.

| Corpus | Bodies (bytes) | Nothing to rewrite | Rewrite today | Combined regex saves | No-match skip saves | Gateway first load | Repeat load (all 304) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `fixture` | 5 (43,637) | 2 bodies, 1.5% of bytes | 0.25–0.27 ms | 0.01–0.05 ms | Within noise | 8.7–12.4 ms | 5.5–8.1 ms |
| `wide`, the fixture plus 150 one-line modules | 154 (60,123) | 151 bodies, 6.9% of bytes | 0.36–0.47 ms | 0.09–0.12 ms | About 0.1 ms | 43–48 ms | 34–44 ms |
| `web` | 1,754 (27,957,113) | 319 bodies, 10.9% of bytes | 152–190 ms | 46–93 ms | −6 to 13 ms, within noise | 1,531–3,094 ms | 749–1,081 ms |

Walking `web` through Vite itself took 8,166 ms (one capture). A rewriter edit makes every module a full response once after an update: on `web` 782–2,013 ms more gateway time and 7.09 MB on the wire, so 17 to 29 complete first loads per update to break even on time, while the bytes never pay back. The nine passes run only on HTML, one body per page; JavaScript runs five. The outcome of each report item is the closing check of E24 (`git show 413bd6219:docs/reports/2026-11-06-efficiency-logging-database-outcome.md`).

**Decisions.**

- **First step?** Decided 2026-11-01 and done 2026-11-02.
  - **GW-8 and GW-9 together, measured with a Vite fixture page load (recommended).**
    - Pros: the largest wins for preview users; GW-9 also removes most of GW-10's rewrite work.
    - Cons: the pool needs revocation on endpoint generation change and access revocation, which `test:preview:browser` must cover.
  - **GW-6 first.**
    - Pros: fixes a correctness-adjacent desync of quiet channels.
    - Cons: only users of the opt-in terminal WebSocket benefit.
- **What keys the pool?** Done.
  - **Access (attachment), endpoint generation and target (recommended).**
    - Pros: a connection serves only the browser session that opened it; the access service's existing resource tracking closes it on revocation, expiry and generation change with no new revocation path.
    - Cons: two browser sessions of one service do not share connections.
  - **Service and endpoint generation.**
    - Pros: more reuse across sessions.
    - Cons: a revoked session's connection could serve another one, and revocation needs a separate per-service path.
- **Idle bounds?** Done.
  - **8 per access, 64 per backend, 2 s idle (recommended).**
    - Pros: below the 5 s keep-alive timeout of Node's HTTP server (Vite's), so the application rarely closes a connection about to be reused; matches Electron's ingress pool and a browser's six connections per host.
    - Cons: a pause of more than 2 s between navigations pays a new connect.
  - **Longer idle (30 s or more).**
    - Pros: reuse across slower navigation.
    - Cons: more races with application keep-alive timeouts and more sockets held per idle tab.
- **A reused connection the application had closed?** Done.
  - **Resend once on a fresh connection, only for `GET`, `HEAD` and `OPTIONS` without a body, only when nothing was answered (recommended).**
    - Pros: what browsers do (RFC 9112 §9.3.1); hides the keep-alive race from users; nothing to replay.
    - Cons: a safe request reaches the application twice if it closed after reading the request; requests with a body never take an idle connection.
  - **Never retry.**
    - Pros: the forwarder keeps its "never retries" rule.
    - Cons: an occasional 502 on a page load whenever the application's keep-alive timer fires.
- **Derived tag format?** Done.
  - **`W/"<upstream>|ork:<w|s>:<coding>[:<rewrite key>]"`, the key hashing route prefix, port and the rewriter's source (recommended).**
    - Pros: rebuilds the upstream tag exactly, weak prefix included (Vite compares `If-None-Match` as a plain string); a tag never revalidates bytes rewritten for another route or by another build.
    - Cons: an Orkestrator update that changes the rewriter costs one full reload per module.
  - **The report's `W/"<upstream>|<encoding>|rw<prefix-hash>"`.**
    - Pros: shorter.
    - Cons: loses whether the upstream tag was weak, so Vite would never answer 304; a rewriter change would revalidate stale rewrites.
- **How to batch operation results (GW-16)?** Done.
  - **A cumulative result per channel per flush, with failures alone (recommended).**
    - Pros: no added wait, since the frame goes out in the flush a lone result would have used; 200 results become one when they finish together; each frame is smaller even when they do not; a failure keeps its message.
    - Cons: a new frame and a negotiation, for one frame per key at typing speed, where only the bytes fall.
  - **Leave it.**
    - Pros: no protocol change, and the frames are small.
    - Cons: one larger frame per key always.
- **How to negotiate input results (GW-16)?** Done.
  - **A second subprotocol, offered ahead of v1 (recommended).**
    - Pros: settled in the upgrade, so it costs no frame or round trip; an older server selects v1 and an older client offers only v1, with no version check on either side; the backend can count older clients.
    - Cons: a name to keep alongside v1 until the window passes.
  - **A client frame after `ready.features`, as `ping` does.**
    - Pros: follows the nearest precedent.
    - Cons: results sent before it arrives need a second code path, and it adds a frame to every connection.
- **Send fewer acks, or use them (GW-16)?** Done.
  - **Send them once a second (recommended).**
    - Pros: a client-only constant with no protocol change; 100 acks become 5 in the `output` workload.
    - Cons: revisit if flow control ever wants them.
  - **Use them as flow-control credit.**
    - Pros: gives the server a true view of client progress.
    - Cons: a much larger change, and GW-6's `bufferedAmount` watermark covers the same socket problem.
- **How does a paused flush resume (GW-6)?** Done.
  - **From the `ws.send` callback, pausing only while a send is in flight (recommended).**
    - Pros: no work while a socket is stalled; a pause can never be left with nothing to wake it, whatever else `bufferedAmount` holds; corrected `terminal-burst` runs delivered all frames without desync (14–35 ms before, 19–33 ms after; insufficient to claim zero latency cost).
    - Cons: a single flooding channel desyncs at about 768 KiB of backlog rather than about 2 MiB.
  - **Keep rescheduling with `setImmediate` and skip while above the watermark.**
    - Pros: the smallest change.
    - Cons: spins the event loop for as long as a client stays behind.
- **Where do skipped replay events cost a cursor (GW-12)?** Done.
  - **Before the next matching frame and at the end of the window, as the report and the ticket say (recommended).**
    - Pros: a client's cursor reaches each revision in the order it does today, and the existing `advances scoped replay cursors` test stands unchanged.
    - Cons: one extra frame per run of skips, since the matching frame's own `id` would also advance the client.
  - **Only at the end of the window, as 0290 recommended.**
    - Pros: fewest frames.
    - Cons: changes what a client sees mid-window, against this ticket's constraint that semantics do not change.
- **Should a scoped client's replay budget count only the small cursors it now receives?** Done 2026-11-05 (batch E18), as recommended.
  - **Yes, as a separate change, keeping the figure an upper bound (recommended).**
    - Pros: `replayFitsClientBudget` summed every frame's bytes, so a scoped client could be told `replay-too-large` for a window it would barely receive.
    - Cons: a client that reconciled before replays instead, which the 2026-11-04 ticket had ruled out by requiring the same result for every client.
  - **Leave it.**
    - Pros: no behaviour change; the figure stays a safe overestimate.
    - Cons: the needless reconcile stays.
- **How to answer a static revalidation before compressing (GW-15)?** Done 2026-11-05 (batch E24).
  - **Compare the tag of every variant the request could have been given, then answer with the one the client holds (recommended).**
    - Pros: no compression for any matching tag, including a file where compressing does not help; needs no cache; the 304 describes the bytes the client has.
    - Cons: a client holding a variant keeps it until the file changes, even where compressing would now choose another. It pays no transfer for that.
  - **Compare only the coding the fallback would choose, as the report put it.**
    - Pros: the narrowest change.
    - Cons: a file where compressing does not help, or a client holding its second choice, still compresses on every revalidation.
  - **Add a small bounded result cache as well.**
    - Pros: also saves work on full 200s.
    - Cons: a new cache with byte and count bounds for a low-impact path, with no measurement asking for it.
- **Is GW-10 worth doing?** Decided 2026-11-05 (batch E24), on the numbers above.
  - **Neither, and record it as declined (recommended).**
    - Pros: no reload after an update; no second copy of the patterns; the route is due to retire with [0042](../previews-and-annotations/0042-service-preview-rollout.md).
    - Cons: the largest case keeps 46–93 ms it could save. Reopen only if the route stays and a real page shows the rewrite in a profile.
  - **One combined regex per kind plus a no-match skip.**
    - Pros: 46–93 ms on a 1,754-module first load.
    - Cons: costs one full reload per module after the update; 17 to 29 complete first loads to break even; and the HTML form cannot be byte-identical, since one pass matches non-overlapping text and today `<a href="/a url(/b) c">` has both of its paths rewritten.
  - **Only a no-match skip.**
    - Pros: small; can sit in the caller, where it changes no tag.
    - Cons: within noise on `web`, about 0.1 ms on `wide`; in the caller it keeps a second copy of the patterns, where a missed shape silently leaves a body unrewritten.
- **Next step?** Closed 2026-11-05: nothing is left in this task beyond the to-dos named above.
  - **GW-10, one combined rewrite regex with a no-match fast path.** Declined 2026-11-05, as above.
  - **GW-11, per-node federation event names.** Done 2026-11-05 (batch E18).

### 12. Local desktop transport

**Problem.** Electron main relays every backend event, terminal output included, to every window, and every local `invoke` is serialised four times.

**Context.** Decided 2026-11-01: local windows use the direct gateway transport with a per-window rollback switch, starting with filtered SSE and not tied to the terminal WebSocket. Local desktop traffic is unaffected by the `on` compression default: `backend-process.ts` calls control-only routes, and the control listener never compresses (inferred from code, not tested).

**Investigation.** `backend-process.ts` opens `/__orkestrator/events` with only a cursor (confirmed 2026-11-01). The browser path filters terminal output (`web-gateway.ts`). `installRemoteGatewayRequestAuth` already exists for remote windows. DK-5 and DK-6 are smaller IPC costs.

Re-checked and built 2026-11-04 on branch `desktop-window-transport-e6e965c2f004-r1` (based on `main` at `96ee1eb3e`). All four items still held as the report describes. How it works now is in [remote-gateway.md](../../architecture/remote-gateway.md).

**Before and after.** `e2e/agent-testing/local-gateway-transport-electron.spec.ts` drives a real Electron window in a disposable agent-test profile and writes these counts to `output/agent-testing/local-transport-counts/`. The load is one window and one local terminal printing 300 lines, one every 10 ms or more (`seq` with `sleep 0.01`). The table is one run, and counts are for that load only. Across repeated runs the relay stayed within 302–304 events and 13–15 commands, and the gateway within 303–304 frames and 13–14 commands.

| Measured during the load | Relay (setting off) | Gateway (setting on) |
| --- | --- | --- |
| Backend events main relayed to the window (`orkestrator:event`) | 304 | 0 |
| Of those, terminal output | 304 | 0 |
| Bytes main read from its own event stream | 53,080 | 0 |
| Main's event stream query | none | `excludeEvents=terminal-output-` |
| Terminal frames the page received | 304 | 303 |
| Commands through main | 14 | 0 |
| Commands the page sent itself | 0 | 14 |

| Per `invoke`, from the code path | Relay | Gateway |
| --- | --- | --- |
| Renderer to main, structured clone | 1 | 0 |
| `JSON.stringify` | 1, in main | 1, in the renderer |
| `response.json()` | 1, in main | 1, in the renderer |
| Main to renderer, structured clone | 1 | 0 |
| **Serialisations per invoke** | **4** | **2** |
| Crossings of the context bridge (copied, on top of the above) | 2 | 0 |

These count events and serialisations. Electron main's CPU, the baseline report part `0400` asked for, was measured on 2026-11-05 by the same spec: the direct transport appeared not to lower it, and with two windows on a 1.29 MB burst raised it from 39–67 ms to 113–131 ms. To-do 5760 (closed 2026-11-06) traced that to the harness. Playwright's DevTools session, and the DevTools window a development build opens, turn every network chunk the page receives into a DevTools event that main forwards. Measured with no DevTools client attached, the direct transport costs main 4–7 ms for the same burst against 46–54 ms on the relay. The figures are in [4501](4501-local-window-transport-default.md) task 2, and the method is in [agent-testing.md](../../development/agent-testing.md#measuring-electron-mains-cpu). The outcome of the part is the closing check of E26 (`git show 413bd6219:docs/reports/2026-11-06-efficiency-logging-database-outcome.md`).

**DK-5 (fixed for full images, 2026-11-04).** A spooled capture image now crosses IPC as bytes in both directions (`BrowserPreviewPendingCaptureWire`, `imageBytes`), at its PNG size rather than a third larger, and main no longer base64-encodes it to read it. The preload makes and parses the data URLs, so `BrowserPreviewCaptureApi` and its consumers did not change. "Up to 12 PNG encodes" is the loop's safety cap: a screenshot whose size follows its area settled in two encodes at 2.2, 4 and 8 bytes a pixel, so the loop was left alone. Tests: `preload-api.test.ts` ("capture images across IPC"), `browser-preview-capture-store.test.ts`, `browser-preview-capture-image.test.ts`; `web-annotations-electron.spec.ts` still passes through a real window.

**DK-5 (region crops, stall measured, 2026-11-05).** Based on `main` at `69a3b4ca5`. Region crops now cross as bytes too (`BrowserPreviewRegionCropWire`), and `boundedScreenshotPng` and `cropPng` encode with `toPNG`, so main no longer base64-encodes a capture on any production path. Measuring showed the 2026-11-04 bytes had moved the cost to the renderer and made it larger: the preload's binary string and `btoa` blocked the renderer for 197 ms on a 7.64 MiB capture, and `atob` plus `Uint8Array.from` for 367 ms on the way back. The preload now uses `Uint8Array.toBase64` and `fromBase64`. No custom scheme was added: with native base64 the renderer stays near its idle floor up to 7.64 MiB of the 8 MiB limit, so the condition for one, a capture shown to stall the UI, is not met.

One run of a throwaway harness in real Electron 45 (Chromium 156, macOS arm64) in a hidden sandboxed window, using the real `boundedScreenshotPng`, `cropPng` and `createBrowserPreviewCaptureApi`, with a 640x400 crop in each read. Pages were synthetic: a table-and-sidebar UI and a noisy gradient, taken with `capturePage`; the noise cases are bitmaps, as the hardest PNGs near the limit. Medians of 7 to 15 reads, in ms. A gap is the longest time between heartbeats on that thread, so it is the stall; a timer's floor there is about 5 ms in the renderer and 9 ms in main. Read time is elapsed, not blocking, and varies between runs.

| Capture (stored size, PNG) | Encodes | Renderer gap on read: data URL / JS base64 / native | Read time: data URL / JS base64 / native | Renderer gap sending a redaction: JS / native | Main gap on read, with crop | Main PNG encode at capture |
| --- | --- | --- | --- | --- | --- | --- |
| UI 1280x800 @1x (1280x800, 0.15 MiB) | 1 | 5.2 / 8 / 5.2 | 10.8 / 16.5 / 10.6 | 9 / 5.3 | 8.6 | 23 |
| UI 1280x800 @2x (2000x1250, 0.51 MiB) | 1 | 5.2 / 16 / 5.2 | 25.3 / 36.7 / 23.5 | 23.8 / 5.2 | 22.3 | 68 |
| Noisy gradient @2x (2000x1250, 3.88 MiB) | 1 | 6.8 / 99.8 / 6.2 | 88.5 / 187.2 / 76.6 | 181.6 / 5.1 | 63.8 | 342 |
| Noise near the limit (2000x1330, 7.64 MiB) | 1 | 7.9 / 197.4 / 9 | 71.2 / 276.8 / 157 | 367.4 / 5.5 | 31.8 | 171 |
| Noise over the limit (2000x2000 to 1535x1535, 6.64 MiB) | 2 | 6.2 / 174 / 10 | 120.3 / 294.8 / 101.3 | 317.9 / 5.1 | 46.4 | 156 |

`toPNG` returned the same bytes as `toDataURL` for all five sources. Dropping base64 saves main 30 to 60 ms per encode on the larger captures. What remains on main is the PNG work itself, which no IPC transport changes: [5540](../previews-and-annotations/5540-capture-png-work-on-main.md). Tests: `preload-api.test.ts`, `browser-preview-capture-image.test.ts`, `browser-preview-capture-flow.test.ts` ("a region crop across IPC"), `main-ipc.test.ts`; `web-annotations-electron.spec.ts` ("text, region, and page modes", "capture pixels stay on the target") passes through a real window.

**DK-6 (fixed, 2026-11-04).** Re-checked first: `openPreviewTunnel` opened one WebSocket, with HELLO and OPEN, per upstream connection. The pool (`preview-transport-manager.ts`, in since 2026-09-23, so before the report) reused an idle connection for 2 s and kept up to six, which spared sequential requests but not parallel ones, upgrades, or requests after an idle gap. It is not an IPC cost: these sockets run from Electron main to the backend. Fixed as the report proposes, by multiplexing: tunnel v2 (`orkestrator.preview-tunnel.v2`, contract in `packages/protocol/src/preview-tunnel-mux.ts`) carries every upstream connection of an attachment as a stream on one authenticated WebSocket, with per-stream credit so a stopped reader stalls only its own stream. The desktop's `PreviewTunnelConnector` (`preview-tunnel-session.ts`) keeps that session; the backend's `preview-tunnel-mux-server.ts` serves it beside v1. Attachments advertise v2 (`multiplexSubprotocol`), so a desktop on an older backend keeps v1, and an older desktop on this backend still gets v1 (counted as `preview.tunnel-v1` in the [version-compatibility register](../../architecture/version-compatibility.md#register)). Details and decisions are in [4500](4500-preview-tunnel-one-socket-per-connection.md).

| One page's burst of N parallel upstream connections | v1 (before) | v2 (after) |
| --- | --- | --- |
| WebSocket handshakes (TCP, TLS on HTTPS, upgrade) | N | 1 per attachment (a second session past 32 streams) |
| HELLO and credential checks | N | 1 |
| OPEN round trips | N, pipelined with HELLO | N, on the open socket |

Counted by tests, not timed: `preview-transport-manager.test.ts` ("parallel connections share one authenticated tunnel socket": five parallel requests, one upgrade, five admitted upstreams; "against a backend without tunnel v2, each connection opens its own socket": three requests, three upgrades), `preview-tunnel-session.test.ts` and `preview-tunnel-mux-server.test.ts` (sharing, a stopped stream stalling at its window while another completes, uploads past the window, revocation, capacity, protocol violations, v1 fallback). `service-preview-electron.spec.ts` drove real Electron windows over v2 in disposable profiles. Page-load time over a remote route was not measured.

**Decisions.**

- **Rollback switch scope?**
  - **A per-window setting read at window creation, defaulting to the new transport after one release behind it (recommended).**
    - Pros: a user with a broken window can fall back without a new build.
    - Cons: two transports to keep working for a release.
  - **A build-time flag.**
    - Pros: one transport at runtime.
    - Cons: no way back without a release.

### 13. Toolchain startup and downloads

**Problem.** Every desktop launch SHA-256'd the whole installed toolchain (about 1.2 GB) twice per `ensurePinnedToolchains` call before the backend started, and slow links could never finish a download.

**Context.** Done 2026-11-03 on branch `desktop-launch-hash-2ed459efe5f8-r1` (based on `main` at `7b48c23f`). Re-checked first: the final verification was still unconditional, and desktop startup (`apps/desktop/electron/toolchain-startup.ts`) calls the manager twice when a support tool such as `gh` is pinned (required agents, then the combined set), so a launch hashed every agent binary four times, not two. Downloads still had the five-minute total deadline and restarted from zero.

- **DK-3 (done).** `packages/toolchain/src/file-stamps.ts` keeps `toolchains/.verified-stamps.json`: per file `dev, ino, size, mtimeNs, ctimeNs, digest` plus when the stamp was taken. A file whose metadata matches is not read; any mismatch re-hashes it. A stamp taken within 2 s of the file's own mtime or ctime is never trusted on metadata alone (git's racy-index rule). A full check ignores every persisted stamp once a week, when the stamp file is missing or unreadable, when the clock is behind the last check, and on the in-app toolchain repair (`fullVerification`). Stamps taken earlier in the same run are reused, so the final verification no longer re-reads untouched files. Re-signed macOS copies (OpenCode, Pi) are kept, without `codesign` or `--version`, while their stamp matches and they were made from the current pinned upstream.
- **DK-4 (done).** `packages/toolchain/src/download.ts`: a 60 s idle timeout replaces the total deadline; bytes go to `toolchains/.downloads/<sha256>.partial`, which survives the staging directory; a retry or the next launch re-hashes the partial and asks for the rest with `Range:` (a `200` restarts, a wrong `Content-Range` or a damaged partial is discarded). Up to five attempts per call while each makes progress.
- `apps/desktop/electron/main.ts` logs `toolchain` `prepare.ready` with `durationMs`, the toolchain's share of launch-to-ready.

**Investigation.** Measured 2026-11-03 on arktech-mini (macOS, Apple silicon, about ten other builds running, warm page cache) with `output/efficiency/toolchain-13/bench.ts` (git-ignored): the two calls desktop startup makes, against an APFS clone of the installed toolchain in a throwaway data directory, with real `codesign` and `--version` probes and `HOME` pointed at a temporary directory. Times are for the whole toolchain step, which startup awaits before anything else.

| Run | Before (`7b48c23f`) | After |
| --- | --- | --- |
| Unchanged toolchain, stamps current | 7.4 to 10.5 s (first window); 19.3 to 20.7 s (later, busier window) | 0.29 to 0.91 s (nine runs across both windows) |
| First launch after a full check (re-signed copies' stamps still racy) | n/a | 1.0 to 1.5 s |
| First launch after the old code re-created the re-signed copies (an upgrade) | n/a | 3.0 to 3.8 s |
| Full check: first launch with no stamp file, weekly, or repair | as above | 7.7 s (first window); 9.6 to 10.2 s (busier window) |

Whole Electron launch to ready, measured the same day on an isolated `dev:test` profile (`tc13-launch`, no fixture, the six seeded toolchains, 1.3 GB; load average 20 to 29) with `output/efficiency/toolchain-13/launch-runs.sh` (git-ignored). The time runs from the launcher's first status write naming an Electron PID to its `ready` write, which follows Electron's readiness line (window created, backend started); polled every 25 ms. "Before" is the same tree with `packages/toolchain/src` and `apps/desktop/electron/main.ts` checked out from `7b48c23f`; the Electron bundle is rebuilt from source on every start. The profile was reset afterwards.

| Launch | Before (`7b48c23f`) | After | After: `prepare.ready` `durationMs` |
| --- | --- | --- | --- |
| Unchanged toolchain (repeat launches) | 10.2, 13.8, 12.6 s | 1.6, 1.9, 1.8, 1.7 s | 449, 390, 492, 214 ms |
| First launch on the new code (no stamp file, so a full check) | n/a | 4.7 s | 3,339 ms |

Not measured: a cold page cache (`purge` needs root).

**Decisions.**

- **What does a stamp hold?** The ticket chose the recommended option; implemented as such.
  - **`dev, ino, size, mtimeNs, ctimeNs, digest` per file, re-hashing on any mismatch and on a periodic full check (recommended, done).**
    - Pros: catches replacement and in-place edits; a periodic check covers a forged mtime.
    - Cons: a stamp file to keep consistent with the install.
  - **Skip only the final verification when nothing changed this run.**
    - Pros: smallest change; halves the cost.
    - Cons: still one full hash per launch.
- **How often is the full check?** See "Task 13: full-check interval" below.

### 14. Docker image size

**Problem.** A bridge release re-pulled every layer from the first bridge `COPY` to the end of the image, Bun was installed twice, npm's download cache stayed in the image, and a leftover `apt-get update` ran after the script `COPY`s.

**Context.** DK-7, DK-8, DK-9 and DK-11 done 2026-11-02 in one image change, together with Node 24.22.2 ([0032](0032-dependency-upgrades.md) task 7), measured on `main` at `38d55ee14` (before) and the same tree with the change (after), linux/amd64, beelink. What changed in `docker/Dockerfile`:

- DK-7: starship and mise now sit above the bridges. The builder copies each bridge's sources just before its own build, least-changed first (pi, cursor, acp, claude, codex, by commits since 2026-08-01). The vendored SDKs (`dist/node_modules` of pi, cursor and claude) move to `/opt/bridge-deps/<bridge>` in the builder and ship in their own layers ahead of the bundles. The shell config `COPY`s moved below the bridges because they are small.
- DK-8: the base image's `/usr/local/bin/bun` is registered in mise's system directory with `MISE_DATA_DIR=/usr/local/share/mise mise link bun@1.4.4 /opt/bun`, where `/opt/bun/bin/{bun,bunx}` are symlinks to it. Nothing is downloaded. A `node` user with a project that pins `bun = "1.4.4"` gets "already installed" offline.
- DK-9: each `npm install -g` (Claude Code, Codex, Playwright) ends with `&& npm cache clean --force` in the same `RUN`.
- DK-11: the late `apt-get update && apt-get install util-linux` is gone. `util-linux` is Essential in the Debian base and already present; it is now listed in the first apt layer, and the `setpriv` checks stay.

Tests changed: `tests/unit/monorepo-scripts.test.ts` (layer order, npm cache), `version-drift.test.ts` (`mise link` instead of `mise install --system`), `runtime-env-wiring.test.ts` (mise above the bridges, below the browser; the old assertion compared against a comment that no longer existed) and `firewall-policy.test.ts` (one apt layer).

**Investigation.** Measured with `docker image inspect`, `docker history` and `du -sxh` inside the image:

| | Before | After |
| --- | --- | --- |
| Image size (uncompressed) | 6,411 MB | 5,452 MB (−959 MB, −15%) |
| `/home/node/.npm` | 356 MB (`_cacache`) | 32 KB (logs only) |
| Second Bun (`/usr/local/share/mise/installs/bun`) | 103 MB, plus 50 MB mise download cache in `/root/.cache/mise` | 16 KB of symlinks; no cache |
| mise layer | 321 MB | 162 MB (the mise binary is 155 MB) |
| Claude Code npm layer | 443 MB | 301 MB |
| Codex npm layer | 647 MB | 456 MB |
| Playwright npm layer | 58.8 MB | 19.1 MB |
| Re-pulled bytes when all five bridges change | 895 MB (40 layers) | 22.8 MB (38 layers: bundles of 2.8 to 8.9 MB each, the rest small scripts) |

The re-pull row comes from a probe: a runtime line appended to all five `bridges/*/src/index.ts`, both Dockerfiles rebuilt on the same builder, and changed layer digests (`RootFS.Layers`) compared against each unprobed image. The vendored SDK layers kept their digests across the rebuild. CI builds with `cache-from`/`cache-to: type=gha,mode=max` (`publish-container.yml`), so they reuse layers the same way. `bash docker/tests/final-image-smoke.sh` passed on the after image.

The same pair rebuilt on macOS (linux/arm64 under Docker Desktop, 2026-11-06)
measured 6,299,627,181 → 5,356,714,300 bytes (−15.0%) and a re-pull of
883.2 MB → 24.2 MB, with the cache and mise savings reproduced; the figures
and method are in task 1, "Image size on macOS".

`mise run test:agent:docker` ran on the after image, in a disposable profile (`--fixture-environments local,container --no-agent-credentials --agent-platforms codex,grok,opencode --headless-electron`). Load average was about 46 because about ten builds were sharing the host. Result: 17 passed, 4 skipped, 3 failed, and the same three failed again when rerun alone. The causes were not all established; these failures remain qualification blockers:

- `web-annotations-gateway.spec.ts:958`: the "Docker containers can't reach Orkestrator" dialog covered the page. The host's ufw drops traffic from Docker networks to the agent tools port.
- `native-draft-attachments.spec.ts:378`: the test's restricted container started from the new image. After that, the page showed "Orkestrator couldn't connect" before the sidebar loaded.
- `container-app-wiring.spec.ts:447`: the profile's coordinator conversation was already assigned to Codex ("Coordinator, Codex"). The test expects "Coordinator, no agent chosen yet".

The passing tests include container boot and restart with imported logins, rebuild, deletion, the root terminal, settings, Files, merge, Build-tab validation output, the Playwright launch for both container users and design export. The four skipped tests are live-provider opt-ins: Grok login renewal, a live agent note, and two live Claude cases.

Rechecked after rebasing onto current `main` at `643ce87c4` on 2026-11-02: all four findings still applied before this change. Fresh linux/amd64 builds measured **6,411,820,583 → 5,452,072,222 bytes** (−959,748,361 bytes, −15%). `docker history --no-trunc` and container `du -sxh` reproduce the cache and mise savings above. Both builds and the final-image smoke passed; four focused unit test files passed. The Node drift check now enforces ≥24.22.1.

The final amd64 qualification rebuilt the reviewed Dockerfile using
`mise run docker:build:dev --profile dk1202-round2`. The resulting image was
5,452,373,507 bytes with Node `v24.22.2`; `bash
docker/tests/final-image-smoke.sh orkestrator-v2:dev-243dd588f5d7` passed,
including health checks for all five bridges and offline Bun registration
as `node` with a project pin of 1.4.4.

Docker's default address pools were exhausted. Qualification used explicit
`/29` subnets from otherwise unrouted `172.16.240.0/22` for the disposable
profile's own networks, retrying only Docker overlap refusals. No foreign
resources, daemon settings or firewall rules were changed. Reproduction needs
available Docker address space or equivalent explicit subnet allocation;
no untracked helper is required as durable evidence.

The profile used `--fixture-environments local,container
--no-agent-credentials --agent-platforms codex,grok,opencode
--headless-electron`. Against that ready profile, the final qualifying command
was `ORKESTRATOR_AGENT_TEST_PROFILE=dk1202-round2 mise run test:logged --
--name round2-agent-docker-fixed -- mise run test:agent:docker`.
**Result: 20 passed, 4 skipped, 0 failed, 0 flaky (510.5 s).** The skips
are existing live-provider opt-ins; no billed turns or credentials were used.
The suite covers inactive environments, hidden documents, reloads and second
windows. The approval and annotation specs reuse `loadAppWithDevRetry` for
the known dev import failure and host-connectivity warning. The coordinator
check preserves the main conversation and compares its displayed agent with
persisted state. Focused E2E types, lint, format and `git diff --check` passed.
The disposable profile was stopped/reset and its image tag removed.

Earlier attempts did not qualify the image: address exhaustion prevented
fixture readiness, and a later UI attempt exposed stale startup and coordinator
assertions. The successful run above supersedes those attempts. Original
preparation artifacts were preserved.

Review preparation must qualify the committed snapshot with `mise run
test:agent:docker:isolated` (through `test:logged`). This one-shot task builds
and smokes the image, provisions its own credential-free local/container
profile, runs the same Docker fixture selection as `test:agent:docker`, then
stops/resets the profile and removes its image tag. The scheduler declares
coverage of `test:agent:docker`. Running that bare task after the earlier
profile was reset produced a failed validation entry despite a separate later
manual pass; that entry does not establish qualification. The one-shot path
keeps setup, smoke, suite and cleanup in the preparation command's own result.
Its tracked PATH shim handles exhausted pools for owned fixture networks only,
checking host routes before explicit /29 allocation and preserving overlap
refusals. No external helper or running profile is needed. Fresh qualification
on 2026-11-02 passed through this one-shot path: image build and final-image
smoke passed, followed by **20 passed, 4 live-provider skips, 0 failed, 0 flaky**
(578.2 s suite; 608.3 s including build, smoke, setup and cleanup). The profile
reported `missing` with no live processes after cleanup, and its image tag was
absent. This focused pass does not replace the next preparation package's run
against the committed snapshot.

Native arm64 qualification remains open: an emulated build failed at the
existing Chromium verifier after 273.2 seconds (GPU launch error 1002,
QEMU target signal 5). On 2026-11-06 the change's own pair (`d6040915c` and
`fd679c0e2`) built natively on linux/arm64 under Docker Desktop on macOS,
Chromium verifier included, for task 1's size measurement; neither image was
smoked or run through the Docker suite, so no arm64 qualification result
exists yet. The Chromium check was preserved. DK-10 remains outside
this completed subset.

DK-10 is still open. The SDK's `claude-agent-sdk-linux-x64/claude` (0.3.314) and the CLI's `claude-code/bin/claude.exe` (2.1.314) are the same file today: SHA-256 `4487042b…5f84594`, 298 MB each. [`upgrade-agents.md`](../../development/upgrade-agents.md) says the SDK deliberately does not track the CLI, so they can diverge. Moved on 2026-11-05 to [6780](../containers-and-environments/6780-second-claude-binary-in-the-image.md), which re-verified both architectures at the same pins, found that the container bridge never runs the SDK's copy, and now recommends dropping it; the decision below is kept as it was recorded.

Not addressed, for a later pass: the Playwright layer (1.07 GB: Chromium, the headless shell and `--with-deps` apt packages), and the bridge `src/` trees that ship next to `dist` (about 16 MB, unused at runtime).

**Decisions.**

- **One change or several?** Decided and done: one change.
  - **DK-7, DK-8, DK-9 and DK-11 in one image change, with `docker history` and `du` before and after (recommended).**
    - Pros: one rebuild and one smoke run.
    - Cons: a regression is harder to attribute.
  - **One change per finding.**
    - Pros: each saving is measured alone.
    - Cons: four rebuilds and four pulls for users.
- **How far should DK-7 go?** Done: split out the SDKs.
  - **Reorder and split the vendored SDKs into their own layers (recommended).**
    - Pros: a code-only release re-pulls 22.8 MB instead of 895 MB.
    - Cons: three more `COPY` lines; the builder moves `dist/node_modules` out and the final stage merges it back.
  - **Reorder only, as the report proposed.**
    - Pros: smallest diff.
    - Cons: the claude, pi and cursor layers (549 MB) still re-pull on every release that touches bridge code or `packages/protocol`.
- **How to register Bun with mise (DK-8)?** Done: `mise link`.
  - **`mise link` into the system directory, pointing at the base binary (recommended).**
    - Pros: no download or second copy; mise writes its own runtime symlinks (`1`, `1.4`, `latest`), so `mise install` as `node` reports "already installed".
    - Cons: `mise ls` shows `(symlink)`; mise creates `/usr/local/share/mise/shims`, which the build removes because nothing uses it.
  - **Hand-made `installs/bun/1.4.4/bin` symlinks.**
    - Pros: no mise invocation.
    - Cons: tried; without the runtime symlinks, `mise install` as `node` failed trying to rebuild them through sudo.
  - **Move the base binary into the mise directory.**
    - Pros: one real file.
    - Cons: a move in a later layer copies the 107 MB again, so nothing is saved.
- **DK-10: the second Claude binary.** Open; needs the maintainer. Superseded by [6780](../containers-and-environments/6780-second-claude-binary-in-the-image.md) task 1, which adds a third option and changes the recommendation.
  - **At build time, symlink the SDK binary to the CLI's when the two are byte-identical, otherwise copy it (recommended).** This needs a `RUN --mount=type=bind,from=bridge-build`. That is a bind mount, not the cache mount 0022 rejected.
    - Pros: saves 298 MB while the pins agree, as they do today; no change when they diverge.
    - Cons: the bridge's SDK would run whatever is at the CLI path, so a user's `npm i -g @anthropic-ai/claude-code@<other>` inside a container would change the bridge's engine too; adds BuildKit-only syntax.
  - **Leave both copies.**
    - Pros: the SDK stays self-contained and follows its own release train.
    - Cons: 298 MB of identical bytes in every image.

### 15. Container data transfer

**Problem.** Until 2026-11-04 each environment cloned from the remote again (DK-13) and copied agent-home inputs in full on every start (DK-14). Until 2026-11-02 it also copied its clone byte for byte inside one volume (DK-12), and a same-disk move of a worktree with submodules copied the whole worktree (DK-15).

**Context.** Decided 2026-11-01: do this now, ahead of the measurement gate. Files: `docker/workspace-setup.sh` (DK-12, DK-13), `portable-inputs.ts` and the entrypoints (DK-14), `environment-move.ts` (DK-15). Container storage rules in `docs/architecture/container-lifecycle.md` apply: no removal outside lifecycle operations.

Done 2026-11-02 against `main` at `38d55ee1`:

- DK-12: `move_clone_into_workspace` in `docker/workspace-setup.sh` renames each top-level entry of the staged clone (`/workspace/.orkestrator/.clone-in-progress`) into `/workspace` instead of `cp -a -n` then `rm -rf`. Tests: `tests/unit/workspace-setup-preserve.test.ts` ("workspace setup clone move").
- DK-15: when git refuses to move a worktree because it has submodules, `renameWorktree` in `environment-move.ts` renames the folder, runs `git worktree repair` and re-links the submodules. It copies only when the rename answers `EXDEV`. Tests: `environment-move.test.ts` ("same-disk move of a worktree git will not move"). `docs/development/disk-usage.md` describes the new behaviour.
- DK-14 was left open then on purpose: another build edited `portable-inputs.ts` at the same time. DK-13 (the mirror) is still open.

Done 2026-11-04 against `main` at `96ee1eb3`:

- DK-14: `import_agent_input` in `docker/entrypoint.sh` leaves an input alone when copying it would change nothing, and removes what an earlier boot imported once it leaves the mounts (`staged-inputs=5`). Logins are imported on every start (`forget_unchanged_agent_login`, `remember_agent_login`). Tests: `apps/backend/tests/portable-inputs-stamps.test.ts`, `portable-inputs-stamps-docker.test.ts`. `docs/architecture/container-lifecycle.md` ("Input stamps") describes the behaviour. Follow-ups: [4580](../containers-and-environments/4580-input-stamp-follow-ups.md).

Done 2026-11-04 against `main` at `a8bdce44`:

- DK-13: a new container environment clones from a per-project bare mirror (`git clone --no-tags --reference <mirror> --dissociate <url>`), bound read-only, and falls back to the old clone on any problem with it (`git-mirror=1`). `apps/backend/src/core/project-git-mirror.ts` builds, refreshes, bounds and removes the mirror; `clone_from_git_mirror` in `docker/workspace-setup.sh` uses it. Tests: `tests/unit/workspace-setup-git-mirror.test.ts`, `apps/backend/tests/project-git-mirror.integration.test.ts`, `project-git-mirror-create.test.ts`, `project-git-mirror-docker.test.ts`. `docs/architecture/container-lifecycle.md` ("Project Git mirror") and `docs/development/disk-usage.md` ("Project Git mirrors") describe it.

**Investigation.** Re-checked on 2026-11-02: DK-12 and DK-15 were still as the report describes. A same-disk worktree without submodules already moved by rename (`git worktree move`); the copy happened only for worktrees with submodules, which git refuses to move.

**Do blobless clones pay many lazy round trips for history-heavy diffs? Yes** (measured 2026-11-04, table below). Each batch of missing blobs is one more fetch from the remote, and `git log -p`, `git log --stat` and `git blame` ask in small batches, so an ordinary read of history takes minutes on `git/git`. That decided the clone flags: a clone from the mirror holds the whole history rather than a partial one.

Measurements, beelink (btrfs host, about ten builds running at once, so timings are noisy), three runs each:

| Item | Setup | Before | After |
| --- | --- | --- | --- |
| DK-12 | Clone of this repository (206 MB, 8,478 files), Docker volume on btrfs, move step only | 400–602 ms; extra peak disk 0–31 MB, because `cp` reflinks on btrfs | 9–42 ms; no extra disk |
| DK-12 | Same clone, tmpfs volume (no reflinks, like ext4 or Docker Desktop's VM disk) | 134–153 ms; extra peak disk 206 MB, a second whole clone | 8–21 ms; no extra disk |
| DK-12 | Real helper in a container, then `git status` | n/a | 26 ms; clean status, `.orkestrator` intact |
| DK-15 | Whole `move_environment`, worktree with nested submodules and 200 MB in 2,000 files, tmpfs | 128–141 ms; one `cp`; extra peak disk 196 MB | 87–128 ms; no `cp`; extra peak disk 1–8 MB (sampling noise) |
| DK-15 | Same, on btrfs | 260–1,119 ms; one `cp` (reflinked) | 160–232 ms; no `cp` |
| DK-15 | Same, 20,000 files of 10 KB, btrfs | 1,399–1,947 ms | 120–147 ms |

DK-14, beelink (btrfs host, other builds running, so timings are noisy), rootful Docker with no relay, real containers with `--network none` and fixture homes. Older image (`staged-inputs=4`, `orkestrator-v2:dev-01fd2aa23403`) against this branch's. Each cell is two containers of five starts. The time is from the first line of Claude's setup to the end of the shared skills block, including its `sync` (9–167 ms):

| Fixture | Starts | Before | After |
| --- | --- | --- | --- |
| 174 files, 1.1 MB (10 skills per root, 50 plugin files) | First | 1,047–1,098 ms | 594–976 ms |
| Same | Restarts, unchanged | 554–1,204 ms | 145–293 ms; 11 inputs unchanged, 0 copied |
| 6,004 files, 40 MB (200 skills per root, 2,000 plugin files) | First | 11,457–17,060 ms | 16,315–17,957 ms |
| Same | Restarts, unchanged | 8,993–18,139 ms | 502–775 ms; 11 inputs unchanged, 0 copied |

The first start's hashing did not show above the noise. Real homes were not measured: fixture homes only, so the sizes above are chosen rather than typical. The numbers came from a throwaway script that bound the image's own entrypoint with timing lines added, then started and stopped each container.

DK-13, beelink, 2026-11-04 (btrfs host, other builds running, load average 5–10, so timings are noisy), Docker Engine 29.9.2, default bridge, image `orkestrator-v2:dev-04afd6671451` with this branch's `workspace-setup.sh` bound over its own, writable-layer workspace, git 2.47.3 in the container and 2.56.0 on the host. Each cell is three containers of `workspace-setup.sh --prepare-only`. Network is the container's `eth0` receive counter. Disk is `du -sb`. "Before" is the blobless clone that was the only path until now; "after" is a second environment, with the mirror published.

| Repository | Clone time before | Clone time after | Network before | Network after | Workspace before | Workspace after | Git directory before | Git directory after |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `orkestrator-ai/orkestrator-v2` | 6.5–7.1 s | 1.4–1.6 s | 43.2–43.4 MiB | 0.01 MiB | 160 MiB | 202 MiB | 45 MiB | 87 MiB |
| `git/git` | 9.6–11.2 s | 4.3–4.7 s | 124.4–124.6 MiB | 0.01 MiB | 179 MiB | 371 MiB | 131 MiB | 323 MiB |

The mirror itself, built on the host by `refreshProjectGitMirror`: 5.6 s and 86 MiB for `orkestrator-ai/orkestrator-v2`, 16.6 s and 322 MiB for `git/git`. A refresh with nothing new took 0.34–0.35 s. So the first environment of a project pays its blobless clone and, in the background, the mirror; the second and later ones save the network but hold more disk, since `--dissociate` copies the history into each.

Reads of history after each clone of `git/git`, from one run of each in the same image. "Lazy fetches" counts `child_start` fetches in `GIT_TRACE2_EVENT`:

| Read | Blobless (today's clone) | Full, from the mirror |
| --- | --- | --- |
| Objects missing after the clone | 162,097 | 0 |
| `git diff HEAD~1 HEAD` | 0.4 s, 1 lazy fetch | 0.0 s, none |
| `git log -p -20` | 1.4 s, 3 lazy fetches | 0.0 s, none |
| `git log -p -200` | 43.0 s, 106 lazy fetches, 3.2 MiB | 0.1 s, none |
| `git diff --stat HEAD~300 HEAD` | 3.1 s, 2 lazy fetches, 5.4 MiB | 0.2 s, none |
| `git log --stat -500` | 78.5 s, 194 lazy fetches, 6.9 MiB | 0.3 s, none |
| `git blame Makefile` | Stopped at the 150 s limit, 354 lazy fetches, 14.2 MiB | 0.7 s, none |
| Git directory after those reads | 140 MiB | 323 MiB |

The combination the report's fix could have used, `--filter=blob:none` with `--reference --dissociate`, on `git/git`:

| Mirror | Clone | Network | Git directory | Objects missing |
| --- | --- | --- | --- | --- |
| Up to date | 4.4 s | 0.0 MiB | 323 MiB | 0, and reads as above, but still marked partial |
| 2,000 commits behind | 9.7 s | 29.3 MiB | 32 MiB | 31,276; `git blame Makefile` then took 113 s and 262 lazy fetches |
| The same, 2,000 behind, no `--filter` | 16.5 s | 73.2 MiB | 319 MiB | 0; reads as above |

Without `--filter`, a stale mirror costs a real download of what it lacks. With it, `--dissociate` discards what the mirror held (`repack` treats objects a partial clone's pack refers to as the promisor remote's), so the result depends on how stale the mirror happens to be, and the clone goes back to the remote for them.

The numbers came from throwaway scripts: one bound the real setup script into containers and read the counters above, the other ran the flag variants and reads directly with the image's git. Neither is committed. Rootless Docker and Docker Desktop were not measured.

The DK-12 numbers came from a throwaway script that runs the old and new steps on a scratch volume. The DK-15 numbers came from a temporary benchmark test that was not committed: it timed `moveEnvironmentTask` and sampled `statfs` every 5 ms, once with the old `environment-move.ts` and once with the new one.

**Decisions.**

- **Order?**
  - **DK-12 and DK-14's stamp first, then DK-13's mirror (recommended).**
    - Pros: the first two are local script changes; the mirror is a new per-project host resource with its own lifecycle.
    - Cons: the clone network cost stays until the mirror lands.
  - **DK-13 first.**
    - Pros: the largest saving for big repositories.
    - Cons: a new mounted resource to create, refresh, bound and clean up before anything else lands.
  - Taken 2026-11-02: DK-12 and DK-15 now; DK-14 next, once the other `portable-inputs.ts` build has merged, then DK-13.
- **DK-13: which clone flags?** (decided 2026-11-04, measured above)
  - **`--no-tags --reference <mirror> --dissociate`, with no `--filter` (taken).**
    - Pros: no download on a fresh mirror; a stale one pays only the difference; self-contained, so reads and later mirror removal need nothing else. Reads of history go from minutes to under a second.
    - Cons: each environment's Git directory holds the history: 45 to 87 MiB and 131 to 323 MiB on the two repositories measured, where the blobless clone leaves it on the remote.
  - **Add `--filter=blob:none` as well.**
    - Pros: looks like the smallest change, and keeps today's flags.
    - Cons: not stable. With a mirror behind the remote, `--dissociate` drops what the mirror held and the environment fetches it back lazily, so it pays both the mirror and the remote.
  - **A blobless clone over `file://` from the mirror, then point `origin` at the remote.**
    - Pros: the same disk as today with no download.
    - Cons: keeps the lazy round trips measured above; needs `safe.directory` and `uploadpack.allowFilter` for the mirror, and several more steps between clone and checkout to fail partway through.
- **DK-13: where does the mirror live?** (decided 2026-11-04)
  - **A host directory, `<data>/git-mirrors/<project id>/mount/mirror.git`, bound read-only (taken).**
    - Pros: the backend fetches with host Git and the project's existing credential path. A rename publishes it. No Docker lifecycle of its own, and the ticket names it a host resource.
    - Cons: a bind source can go away underneath a stopped container, which is why the mount is `-v` rather than `--mount`; world-readable inside an owner-only parent, for rootless Docker.
  - **A labelled named volume.**
    - Pros: Docker refuses to remove one a container references, and it is fast on Docker Desktop.
    - Cons: the host cannot write it, so every refresh needs a helper container with network access and the project's credentials inside it, which the ticket rules out.
- **DK-13: when does it refresh?** (decided 2026-11-04)
  - **In the background on each container creation, at most every 15 minutes per project, never waited for (taken).**
    - Pros: a launch is never delayed or blocked, an idle project makes no requests, and staleness only costs the difference. Git publishes a pack before the refs that reach it, so a clone may read during a refresh.
    - Cons: the first environment pays its clone and the mirror's own download; the second is the first to benefit. A build now seeds from the host checkout where it can, which saves that download.
  - **Wait for the first build, then clone from it.**
    - Pros: one download rather than two for a new project.
    - Cons: delays the first environment by a whole clone, and a slow or failing remote would hold up a launch, which the ticket forbids.
  - **A periodic timer per project.**
    - Pros: always fresh.
    - Cons: network traffic for projects nobody is using, for no benefit: a clone already fetches what is missing.
- **DK-13: how is it locked?** (decided 2026-11-04)
  - **One refresh per mirror in the backend, launches join it, with no lock for readers (taken).**
    - Pros: no lock to go stale; a crash cannot block anyone. A second backend on the same data directory holds no writer lease, so it creates no containers and starts no refresh. Tested with clones, refreshes and a compaction at once, followed by `git fsck --full`.
    - Cons: relies on the writer lease across processes, though Git's own ref locks still apply if that ever failed. A lock left by a crash fails fetches until the third failure rebuilds the mirror; clones are unaffected.
  - **A lock file readers also honour.**
    - Pros: explicit.
    - Cons: the mount is read-only, so a container could not take it, and a stale one is exactly the failure this must not have.
- **DK-13: how is disk bounded?** (decided 2026-11-04)
  - **2 GiB per project, past which it has no mirror and the blobless clone stays, retried weekly (taken).**
    - Pros: bounds each environment's copy as well as the mirror. A size check every 5 s stops a transfer that passes the limit. Also: 3 GiB free needed to build, 1 GiB to fetch, compaction past 30 packs, branches only.
    - Cons: a fixed number, not a setting. A repository just over it loses the mirror entirely.
  - **Remove mirrors idle for some time.**
    - Pros: also reclaims projects nobody launches.
    - Cons: another background removal for a resource bounded per project anyway. Not done; the disk report shows them.
- **DK-13: when is it removed?** (decided 2026-11-04)
  - **With the project in `cleanupProjectForRemoval`, by the orphan sweep for what that left, and by its own refresh past the limit (taken).**
    - Pros: shared by `remove_project` and `project.remove`; a failure never blocks removing the project, and the sweep retries, refusing an unreadable project store. Any stopped container still starts, because a clone needs nothing from it and `-v` recreates the source.
    - Cons: deleting a project's last environment keeps the mirror until the project goes, so the next environment is quick.
- **DK-14: what makes a skip safe?** (decided 2026-11-04)
  - **Hash each input's content and compare it with the stamp and with what the home holds; skip only when all three agree (taken).**
    - Pros: skips exactly when the copy would change nothing, so an edited or deleted import comes back as it does today, and a stale or forged stamp can only cause a copy. It survives the backend rewriting a revision in place and the relay's new inodes and whole-second times.
    - Cons: reads every input's bytes on each start, twice for a tree. In the table above that costs 0.5–0.8 s at 40 MB.
  - **A stamp holding the revision, which the report and 0490 recommended.**
    - Pros: no hashing; one comparison.
    - Cons: not safe here. `refreshStagedAgentAccountLogins`, `scrubStagedProvider` and the MCP defaults writer all change a revision without renaming it, so a rotated login or a revocation would keep the old revision name. The revision is fixed when the container is created, so it would also skip everything for the container's whole life.
  - **Compare file sizes and times.**
    - Pros: no reading of contents.
    - Cons: the relay's `tar` keeps whole seconds and the login refresh rewrites unchanged files, so it can both miss a change and copy for nothing.
- **DK-14: which inputs may be skipped?** (decided 2026-11-04)
  - **Everything but the logins (taken).**
    - Pros: logins are short-lived, rewritten by the entrypoint's own filter and by backend pushes, so they would rarely match anyway, and skipping one is the failure the ticket forbids.
    - Cons: five small files are still copied on every start.
  - **Logins too, through the same stamp.**
    - Pros: one code path.
    - Cons: a login's home copy differs from its mount by design, so it would need the filter's output hashed as well, and a skip could keep an old token.
- **DK-14: how does a removed input leave the home?** (decided 2026-11-04)
  - **The stamp remembers the paths imported, and only those are removed (taken).**
    - Pros: state the container made itself is never touched, including a CLI's files beside the imports.
    - Cons: a workload can edit the list. It is checked for links and `..`, and it only ever names paths the workload could delete itself.
  - **Mirror the mount, deleting anything else in the destination.**
    - Pros: simple.
    - Cons: would delete `~/.claude/plugins` runtime state, OpenCode's `node_modules` and anything else the home legitimately holds.
- **DK-12: how is the clone moved?** (decided 2026-11-02)
  - **`mv -n` per top-level entry, skipping `.orkestrator` and `lost+found`, then a check that nothing was left behind (taken).**
    - Pros: one rename per entry within the volume. The existing `.clone-copy-in-progress` marker keeps the step resumable. The check catches an entry `mv -n` skipped, which GNU coreutils 9.7 (the image's) does silently with exit status 0. Per-entry `mv` without `-t` also runs on macOS, where the unit test runs.
    - Cons: one `mv` process per top-level entry (dozens, not thousands).
  - **`mv -n -t /workspace` with `find ... {} +`, as the report suggested.**
    - Pros: one process.
    - Cons: GNU-only `-t`; on its own it does not notice a skipped entry.
  - **Clone straight into `/workspace`.**
    - Pros: no move at all.
    - Cons: the clone would sit beside the storage marker with no staging folder, so an interrupted clone could not be told apart from user files.
  - A repository's own `.orkestrator` folder is left in the staging folder and deleted with it. The old merge copied it, but the restore of `.orkestrator` straight afterwards replaced it anyway, so the end state is the same.
- **DK-15: where does the rename go?** (decided 2026-11-02)
  - **Keep `git worktree move` first and rename only when git refuses because of submodules; copy only on `EXDEV` (taken).**
    - Pros: git still checks the ordinary case (locked worktrees, its own records). The submodule case gets the same journal as the copy: the record, with its submodules, is saved before the rename, so restart recovery adopts a destination whose source is gone and re-links it.
    - Cons: two code paths that rename.
  - **Replace `git worktree move` with `rename` plus `git worktree repair` for every move.**
    - Pros: one path.
    - Cons: drops git's own checks and rewrites a path that already works.
  - When git reports a cross-device error the move goes straight to the copy, without trying a rename that would fail. A failed repair or re-link, or a rejected path commit, renames the folder back and repairs the source. `git worktree move` cannot undo the rename, because git refuses submodules in that direction too. If renaming back fails, the record stays and restart recovery adopts the destination.

### 16. CLI and logging

**Problem.** `session transcript --follow` re-downloads its page every 2 s for up to 24 h, the CLI transport buffers responses three times, and the log sink runs `mkdir` and `appendFile` per line.

**Context.** `packages/cli/src/client/commands/session.ts`, `packages/cli/src/client/transport.ts`, `packages/protocol/src/node/application-logging.ts`. A `knownToken` on the public API is a contract change (`docs/architecture/public-cli.md`).

DK-16 and DK-17 done on 2026-11-03. `session.transcript` takes an optional `knownToken` (`apps/backend/src/core/public-api/actions-transcript.ts`): while the live window still has that token it answers `{sessionId, status: "unchanged", token}` with no messages (`PublicTranscriptUnchanged` in `public-api-resources.ts`). It is refused with `before`. The backend advertises it as `features.transcriptKnownToken`; `--follow` reads capabilities once and sends the held token only when the answering backend (the `--node` leaf when routed) advertises it, because an older backend refuses unknown input. Against an older backend it keeps the old full read and token comparison. The CLI transport now reads the bounded body once inside the request deadline and decodes those bytes directly; it no longer wraps them in a second `Response` and reads them again, and a refused answer (redirect, 401, 403) has its body cancelled unread. `readStreamBounded` hands back a single chunk without copying. Tests: `public-api-launch.test.ts` (unchanged, stale token, moved transcript, `before` refusal, the feature flag), `client-waits.test.ts` (tokens sent where advertised, never otherwise), `client-transport.test.ts` (chunked decoding, refused body unread). DK-18 was out of that change's scope.

DK-18 done on 2026-11-04. The writer (`installProductionApplicationLogging` in `application-logging.ts`) queues lines and each link of its one write chain appends everything queued, on the next event-loop turn, in pieces of at most `maxBatchBytes` (256 KiB). `mkdir` runs before the first write and again only after a failed write. Lines logged during an append share the next one, so `flush` and `stop` still await the chain's tail. The 4 MiB `maxPendingBytes` bound and its drop markers are unchanged, and it now has a count bound beside it, `maxPendingEntries` (65,536 entries), as the invariants require of every queue. `ENOENT` on an append means the folder was removed: the unwritten lines get one retry through a fresh `mkdir`, and the file index is rescanned from what is on disk. Any other failure loses that batch, writes one `write.failed` line to the console with its `entries` and `bytes`, and never rejects the chain. Tests: `apps/desktop/electron/application-logging.test.ts` ("production application log batching": a counted burst, order across batches, the batch bound, the flush bound in event-loop turns, stop and the quit hold, a removed folder, failed `mkdir` and append, a report that throws, the byte and count bounds) and `apps/backend/src/standalone-logging.test.ts` (shutdown keeps every queued line).

**Investigation.** Re-checked 2026-11-03 against `main` at `7b48c23f`. The backend still reads the window fresh (`forceSnapshot: true`) on an unchanged answer; the saving is the page's mapping, serialisation and transfer, not the provider read. `attention --follow` already pages runs and setups by `cursor`, but each poll re-sends every pending question and approval; not changed here. Measured with the scripted provider on 2026-11-05 and left unconditional on that fixture evidence. Default/maximum pages with three-byte names and 36-character interaction ids have 32/80 KiB regression budgets, not universal bounds; escaped names and longer provider ids can exceed them; see [5560](../cli-and-slash-commands/5560-attention-follow-page-size.md).

**Decisions.**

- **DK-16: how does the CLI learn nothing changed?**
  - **An optional `knownToken` on the public transcript action that answers `unchanged` (recommended).**
    - Pros: the same contract every other read already uses.
    - Cons: public API surface; older backends ignore it, so the CLI must handle a full page.
  - **Back off the follow interval when pages repeat.**
    - Pros: CLI-only.
    - Cons: still downloads every page; slower to show new output.
  - Done with the recommended option.
- **DK-17: how does the transport stop buffering three times?**
  - **Return the bounded bytes from the send step and decode them directly (recommended).**
    - Pros: one bounded read inside the deadline, no second `Response`; the error mapping stays in one place.
    - Cons: a small internal response type instead of `Response`.
  - **Stream-parse the JSON as it arrives.**
    - Pros: no whole-body buffer at all.
    - Cons: needs a streaming parser; responses are at most 8 MiB, so the saving is small.
  - Done with the recommended option.
- **DK-18: when does the log sink write?**
  - **Coalesce on the next event-loop turn into one append (recommended).**
    - Pros: no timer; a lone line waits for nothing but an append already in flight, which suits 0880's note that a line logged before a hold reaches the file late; under load the batch grows by itself while the previous append runs.
    - Cons: a slow trickle still makes one append per line, so the saving is on bursts.
  - **A timer of about 100 ms, flushing `error` at once.**
    - Pros: fewer appends under a sustained trickle.
    - Cons: every line waits, a timer has to be cleared on stop, and a crash loses up to one interval.
  - Done with the recommended option.
- **DK-18: keep the file handle open between batches?**
  - **No: one `appendFile` per batch, with `mkdir` only after a failure (recommended).**
    - Pros: no descriptor to close on rollover and quit; a removed folder or file recovers on the next write.
    - Cons: still one open and close per batch.
  - **Yes, while the day and index are unchanged.**
    - Pros: no open per batch.
    - Cons: a deleted file goes on being written unseen, and rollover and quit each have a handle to close.
  - Done with the recommended option.
- **DK-18: what happens to a batch whose write fails?**
  - **Lose it and report it, retrying only `ENOENT` (recommended).**
    - Pros: as before a batch cannot grow memory or wedge the chain; `ENOENT` is raised at open, so its retry cannot write a line twice.
    - Cons: a failed batch loses more lines than one failed line did. They are reported on the console but not marked in the file.
  - **Requeue it and retry every failure.**
    - Pros: survives a short `ENOSPC`.
    - Cons: a partial write would be repeated, and old lines would compete with new ones for the queue bound.
  - Done with the recommended option.

## Assumptions and decisions

Made on 2026-11-01 while doing the first batch. Uncommitted at the time of
writing, on the worktree branch `20261101-012617-580e11a7c62c`.

### Task 2: how environment archive scrubs keep their recovery guarantee (2026-11-04)

Chose two content-free journal kinds committed with the row (`delete-item`,
`drop-item-field`), following the compose-draft pattern. `prune-row` was not
used because it expects record-shaped copies and stores a copy of the row's
new value, which for an environment can hold base64 attachments. A build that
predates the kinds removes the store's archived copies if it replays one. That
needs a crash followed by a downgrade before the next start, keeps the deletion
and loses only the recovery copy; observed with `HEAD` code against a crashed
temporary data directory.

### Task 2: environment writers stay under the lease (2026-11-04)

Kept the lease, as the ticket decided, and made the writer guard require it on
every row write of this store. The guard's rule 3 alone would have accepted a
row writer with no lease, whose read would then race the others.

### Task 2: a type error fixed on the way (2026-11-04)

`commands-environment.ts` failed `bun check` on a clean `96ee1eb3e`: a closure
read `environment.id` from a reassigned `let`. It now uses the `environmentId`
parameter, the same value, so the backend typecheck can pass.

### Task 3: which polls WEB-18 covers (2026-11-04)

The report names "dialog polls at 2–5 s" without listing them. Took that as every bare timer reading state for a dialog, settings panel or sheet at about that rate, and added two like them: GitHub CLI login (1.5 s) and the Multi Review pull request phase (2 s). Left the slower `TicketSyncStrip` and `useMaintenanceSummaries`, which the finding does not name, and the others listed under WEB-18 for the reasons there.

### Task 3: a poll's priority on return (2026-11-04)

Annotation selection is `critical`, so a selection that ended while hidden clears within 50 ms. The Docker probe is `auxiliary`, up to about 1.5 s. Everything else is `standard`, up to about 0.6 s. These are the coordinator's existing bands, and a shown window repaints before any of them.

### Task 3: an unrecognised record on the single-environment read (2026-11-04)

A record not held yet is ignored while a creation is active or just finished, rather than added. If that record belonged to another client's creation, it arrives with the next announcement or resync. This matches what the list path does in the same window, which drops the whole snapshot.

### Task 3: the digest and the file tree (2026-11-04)

Used `conditionalSnapshot`, not `snapshotResponse`, because `snapshotResponse` counts outcomes under `file-tree-read` and a folder read is not one. Folder reads therefore have no recurring-work outcome counter yet.

### Task 3: what counts as the WEB-9 startup closure (2026-11-04)

Counted `src/renderer-entry.tsx` and its static imports with `index.html`'s, because `main.tsx` always imports it dynamically. Counting strict static imports alone gives 2 chunks and 0.13 MB, which measures nothing useful. The report's own figure is not comparable either way: it came from an older build by a method the report does not spell out.

### Task 3: scope of the WEB-9 boundaries (2026-11-04)

Stopped once the chat, Markdown and xterm code had left the closure, which is what the finding names. `CreateEnvironmentDialog`, the action bar and other non-chat code stay eager; no sidebar component was touched, because a compact sidebar build was running at the same time. Added `apps/web/scripts/startup-closure.ts` and `startup-closure.test.ts` beyond the report's list, so the sizes can be repeated and a stray static import fails a test instead of silently undoing the work.

### Task 3: mobile host detection for WEB-11 (2026-11-04, superseded)

The mobile-host policy this recorded was reverted in review and then replaced by the terminal ping (see "Task 3: terminal liveness probe for WEB-11" below).

### Task 14: preserve unrelated task records (review, 2026-11-02)

Compared the complete document diff from the recorded review base
`82598d869d6b79e44d6c6a1b0577cd261ab8b71f` to reviewed commit
`a88ed87f5d7142222747ca00a213a41536ef2557`: only task 14's index line
and section differ. Tasks 2, 3, 6, 7, 10, 11 and 15 already match that
base. Preserve them; restoring older open statuses would undo records
already present in the review base. Round 2 completed amd64 qualification
(20 passed, 4 live-provider skips); retain only DK-10 as the open decision.

### Task 14: qualification on the shared host (round 2, 2026-11-02)

Chose explicit subnets for this disposable profile (recommended): it preserves
foreign networks and daemon/firewall configuration, at the cost of a temporary
test-only PATH wrapper. Removing foreign networks or changing daemon pools
would reclaim default capacity but violates this run's constraints. Reuse the
existing browser startup helper and assert the backend's current coordinator
selection (recommended): this preserves the tested behavior and diagnoses real
startup errors. Skipping those cases or loosening their behavior assertions
would be less work but would leave acceptance coverage incomplete.

### Task 14: review coverage and durable evidence (2026-11-02)

Keep measurements, the final command, setup constraints and outcomes in this
record (recommended): this remains readable after temporary artifacts expire.
Keeping every failed attempt and local log path gives more chronology but no
portable evidence. For subsequent preparation, choose the self-contained Docker
task (recommended): it records actual qualification and cleanup together but
adds a small supervised setup path. Keeping the manual-profile command is
simpler but requires a live profile that cleanup deliberately removes and
cannot reproduce the recorded pass unaided. The coordinator scenario now
explicitly selects Codex and
asserts it persists; deriving the expectation from each snapshot tested display
consistency but could miss an unexpected selection. Final-image smoke now
checks linked Bun and bunx offline as `node`, with both the image home and an
empty mounted home, using default mise discovery instead of a forced data path.

### Task 2: unreadable rows

`getNativeAgentSession` still throws for a row it cannot read, and falls back
to the whole store only when the store is held as a document, so a corrupt
store still refuses rather than reading as "no session". Other getters return
`null` for an unreadable row, as the whole-store versions did.

### Task 2: carrying the cache forward

`updateStoreRow` copies the cached row map (references only) so a rollback
restores the committed one, and drops the cache when another connection moved
the store first. A graph-run benchmark pinned one row fetch per running pass;
it now fetches none, and the pin was updated.

### Task 3: hydrate once per id

A failed restore is forgotten and retried on the next change to the
environment list, and an environment that leaves and returns hydrates again.

### Task 3: failed layout save cadence (WEB-4)

Review correction on 2026-11-02: unchanged hydrated environments skip work even
after a save failure. Retrying on every unrelated store update would introduce
new behavior and repeated requests under persistent failure. The regression
checks no retry after another environment changes, then a retry containing the
unsaved layout when the failed environment itself changes.

### Task 3: quiet background reads (WEB-5)

Made on 2026-11-02, on the branch `renderer-paths-optimization-845c78394eb7-r1`.
A background read stays quiet only while session state is `current` and a
projection is held, because only then does the connection surface ignore the
flags. A read before that, or any manual read, raises them as before. If a
quiet read loses authority (missing state, an unavailable response, or a thrown
read error), `isRefreshing` stays raised until the independent transcript read
also settles. Deferred-transcript tests cover all three paths and recovery
after both error forms. The first poll after
a connecting read can still render once: React sometimes renders before it
discards a same-value state write that follows a real update.

### Task 3: snapshot ordering in the rebuild section (GW-13)

Reads and events apply through one setter that keeps the snapshot with the
higher revision for the same environment, so a read that started before an
event cannot roll progress back. A snapshot for a different environment always
replaces the held one, as the unconditional setter did. The 15 s backstop and
the 2 s fallback are exported as `REBUILD_BACKSTOP_POLL_MS` and
`REBUILD_POLL_MS`. A regression invokes the registered 15 s timer without
emitting an event or resync and verifies both newer progress and completion
are installed from snapshot reads.

### Task 3: test seams for the WEB-7 and WEB-17 render counts

Made on 2026-11-03. The counts observe the root without mocking the module
under test: `AppShell` and the tmux tab count renders of a direct child stub
that has no subscriptions of its own (the existing `AgentInfoButton` and
`react-virtuoso` stubs), and the Multi Review test counts reads of the
`workflowId` getter on its tab data, which only the root's render reads. Each
test also shows the counter moving when the root really renders. The tmux test
uses two real one-second ticks over a controlled `Date.now`, because the tab
mounts its interval before fake timers could be installed; it adds about two
seconds to that file.

### Task 3: `ClaudeTmuxChatTab.test.tsx` stays one file

Made on 2026-11-03. The tmux render-count test went into the existing
3,900-line file next to the elapsed-status test it extends, because it needs
that file's whole mock setup. Splitting the file is separate work.

### Task 6: ACP persistence interval

A fixed one-second timer that is not reset by later chunks, so it is also the
maximum wait. Every other change still persists through `schedulePersist`, and
any such write carries the output so far.

### Task 6: BR-8 and BR-9 in the Claude bridge (2026-11-03)

- **Where the stamp lives (BR-8).** Stamped onto the `ToolTracker` entry by a new `getToolWithCreatedAt` rather than in `addTool`, because the timestamp belongs to the ordered-part entry, not to the call, and is only known at build time. The first known timestamp wins, as before. Other bridges and the Codex half (BR-2, BR-11) were not touched.
- **What counts as a change (BR-9).** "Published a frame" is the test, with one addition: a changed `sdkUuid` alone still moves the transcript token, because it is serialized with the message (rewind reads it) but carried by no frame. A no-op rebuild also no longer notes the row in `revisedRows`; nothing a reader sees changed. `content` is derived from the text parts and model id changes force a full frame, so neither needs its own check.

### Task 6: Codex single-record config read and session-index cache (BR-2, BR-11)

Made on 2026-11-03.

- **Where `loadRecord` looks when the record file is missing.** Chose a
  read-only look at the former aggregate file and then the login's own records
  directory, because `load()` would have published either there before
  listing, so `durable` stays exactly what it was. Returning false straight
  away would be simpler, but a session that still has only a legacy or
  unadopted copy would turn non-durable until the next `load()`. Calling
  `load()` on a miss would also match, but would bring back the migration and
  adoption writes on a path that should not write.
- **No chmod on the single-record read.** `load()` tightens modes at startup
  and every write sets them, so a read on the hot path has nothing to fix.
  The one difference left: when `load()` cannot create or tighten the records
  directory, it returns the legacy entries only, while `loadRecord` still
  reads the record file. In that state the newer answer is the right one.
- **Cache granularity for the session index.** Kept every parsed line in file
  order plus a last-position-per-id map, rather than only the last entry per
  id. The listing calls `getPersistedSessionMeta` once per line, and a later
  line without `updated_at` for a thread with no rollout resolves to nothing
  and keeps the earlier line's entry. Deduplicating would change that.
- **What happens past the bounds.** Chose to parse an index that alone exceeds
  the bounds uncached on every read, which is the old cost, rather than cache a
  partial index. A partial index could answer "no entry" wrongly.
- **Rewrite detection.** Added the 64-byte anchor check from
  `transcript-cache.ts`, on top of the ticket's shrink-or-inode rule, so a
  same-inode rewrite that grew is not taken as an append. A changed mtime or
  ctime at the same size also re-reads.
- **One behaviour change.** The old listing threw a `TypeError` on an index
  line that parsed to `null` (`entry.id` of null); the cache skips that line,
  as hydrate always did.

### Task 6: BR-7, BR-10, BR-12 to BR-14 and BR-16 (2026-11-04)

- **BR-7, the cache key.** Keyed on `accumulator.version` alone. Every mutator already moves it through `ensureItem` or `touch`, a measurement and the turn ending around an unsettled item included, so a second check on `commandChanges` would add nothing. Kept apart from `completedItemParts`, whose key is the immutable source item.
- **BR-7, a tick with nothing new.** A running card that did not change now produces no patch and moves no revision. Rendering a running card reads no clock, so an unchanged version means unchanged output.
- **BR-10, what is hashed.** Name, size, mtime, ctime and inode, as BR-11 did, rather than the report's path, size and mtime: a same-size replacement should re-read. A digest keeps the entry a fixed size for any directory. A list over 2 MiB, the backend's own body limit, is not kept.
- **BR-10, the directory.** Asked of `SessionManager.create(...).getSessionDir()`, because `getDefaultSessionDir` is not exported and the directory's name is Pi's own format. It writes no file; the directory creation is what `SessionManager.list` did anyway.
- **BR-12, a module of its own.** `acp-context.ts` is close to the 2,000-line limit, and a pure framer can be tested against the old loop without a child process.
- **BR-13, the bounds.** Tasks run synchronously between stdout chunks today, so depth is about one chunk's lines and no real high-water mark was read. 100,000 is far above any chunk. The byte bound was added beyond the report's count bound, because invariant 11 names both and a count alone allows 64 MiB per line. It is a line-length estimate, not a heap measurement.
- **BR-13, order across keys.** A key's backlog now drains before the next key's starts, where promise chains interleaved them. Keys were already independent: account proof compares its own `sequence` because of that, and the engine's "a start delayed on another queue" tests cover it.
- **BR-14, no fragment cache.** Followed the recommended option: no per-session cache of clean records. As with ACP's BR-1 remainder, a missed revision would write stale state, and writes only happen at turn and request edges.
- **BR-16, how far it goes.** Removed what the report names and what only it used. The `cursor/*` handlers stayed because they are gated by method, not provider, so this change's evidence does not cover them.

### Task 6: BR-15's SSE replay rings (2026-11-05)

- **What a Claude snapshot collapses.** Every earlier `message.updated` and `message.patched` frame for the same session and message, not only the previous snapshot as on Codex. Codex's first-match scan would have left the patches since the last snapshot, and a client replayed them after a collapsed base would apply them to a message it never received. The shared ring's scan therefore continues past a replaced entry and stops at one already collapsed; Codex's output is unchanged.
- **Observation replays.** `?observe=1` replays keep one content-free frame per revision under the original type, collapsed or not, so the backend's observer reads exactly what it read before. Full-mode replays send `bridge.cursor` for a collapsed frame, the frame Codex already sends.
- **Revisions from Claude's emitter.** The ring takes them through `appendAt` and `advanceTo` instead of numbering events itself, so a ring revision is the cursor the client holds. A jump past the next revision drops what is retained, since those frames could no longer be replayed as a dense range; `advance` does the same, which changes nothing for Codex because it only advances an emptied ring.
- **Where the ring lives.** `packages/protocol/src/node/event-ring.ts`, beside the transcript helpers BR-15 already moved, although the code itself needs nothing from Node.

### Task 7: stat-stamp settle window

A host capture skips reading a file only when its stat-cache entry is
`settled`: mtime and ctime were at least 2 s old when it was last read. Chose
2 s rather than one kernel tick so FAT's two-second timestamps and small clock
steps are covered; the cost is that a file written in the last 2 s is read
again. `WorktreeChangeOwner.invalidate(paths)` now also drops those paths'
entries, which is what the comment in `service.ts` already claimed it did.
The benchmark waits `--settle-ms` (2.5 s) after writing its fixtures so warm
captures measure the settled path.

### Task 7: line-count cache scope

The cache is module-level, shared by every comparison in the process, because
blob ids are content addresses; a hit is accepted only after `store.has` on
both blobs, so a different or pruned store still reports `body-unavailable`.

### Task 7: what "batched per capture" means for the fsync count (2026-11-04)

A capture still makes one file fsync per new object, as Git's loose format has no shared file to sync. "Batched" here means they are grouped at the flush and issued concurrently, 16 at a time, so the filesystem commits them together, and each directory is synced once per flush rather than once per object's own step. A batch also flushes itself at 512 objects or 64 MiB, so one large capture has several flushes; a ledger row still waits for the last.

### Task 7: changes beyond the two findings (2026-11-04)

Closing the durability gaps was taken as part of "durability must not weaken", since batching would otherwise have widened them: `resolveLiveDetail` now syncs what it stores, a capture waits for names it adopts from another writer, a new process syncs its fan-out directories at its first flush, and a new fan-out directory also syncs `objects/`. Inflating moved off the loop too, though the report's line references name only the write side, because its title says synchronous zlib and the change is a few lines.

### Task 7: whitespace view's reason text (2026-11-04)

Rendering once leaves one difference from the old double render, kept deliberately: when a diff limit is reached in only one of the two diffs, the file now names the limit of the whitespace diff it shows. The old view could show hunks beside a limit reason, or an empty truncated body with no reason. Within limits the output is byte for byte the old view's, which `diff-bodies-lookup.test.ts` checks.

### Task 7: the benchmark's before tree (2026-11-04)

The "before" runs used `git archive a8bdce444` of `apps/backend/src` and `packages/protocol/src` with this change's benchmark script copied in, and one addition to its `capture.ts`: `findManifestEntry` as the linear find diff pages used, so the script runs on both. The scratch tree was not committed.

### Task 8: idle cadence

Eight quiet ticks (2 s) before polling at 1 s; liveness every two idle ticks, so
an ended session is still noticed in about 2 s. A hook can take one idle
interval to be seen, within the 2 s approval budget.

### Task 8: signalled idle safety read

Made on 2026-11-03. A tab whose doorbell is confirmed reads every 2.5 s when no
hook rings, and that read carries liveness and the pane. 2.5 s keeps the 3 s
hidden-tab pane cadence and stays inside the 3 s liveness age mail presence
accepts, so presence never probes on its own. A longer read (5 s) would halve
the idle cost again but let presence spawn its own `has-session` and slow pane
observation; it was not chosen.

### Task 8: a ring wakes, never speeds up

A ring only ends a wait early; the loop still keeps 250 ms after its previous
read. A container can therefore never make the host read faster than the
per-tick poll, so the doorbell needs no ring-rate limit of its own (the Claude
state signal has one because each ring there is a read).

### Task 8: missed-ring judgement a read later

A safety read that finds an unannounced hook file demotes the doorbell only if
no ring has arrived by the next read, about 250 ms later. The hook rings after
writing, so a safety read can see the file just before its ring lands.

### Task 8: discovery memo by mtime

BG-1 asked for a memo of rejected `(path, size)` pairs. The `find` already
returns mtimes, so the memo keys on mtime instead: a candidate is read again
only if it changed while its head was short, and never once its head is full.

### Task 8: one image script, one more capability

The doorbell is a `hook` mode of `orkestrator-state-signal` with its own
config file and credential route rather than a new script. An older image's
script exits 0 on the unknown argument, so the new hook script is safe on it,
and the separate credential keeps tmux hooks (several per turn) out of the
Claude state signal's 30-a-minute flood limit.

### Task 8: BG-7 keeps one adoption read

A container with no terminal shell or tmux tab keeps its Claude state poll
but at the 30 s safety read, after one read on adoption that can still correct
a state stored before a restart. Dropping the poll entirely would lose that
correction.

### Task 8: BG-14 page size

512 KiB and 500 records. On one host's 3,976 Claude transcripts (median 171 KB, 99th percentile 6.4 MB, longest 37 MB) that holds the median file whole and costs a long one about 1.4% of a whole read. A record longer than a page grows the window, up to 32 MiB; past that it becomes a notice row, so the read stays bounded and nothing vanishes silently.

### Task 8: BG-14 historical task snapshots

Kept per session as `tool_use_id` to snapshot, fed by the tail's one pass, bounded to 4,096 calls and 16 MiB, oldest first. A forgotten call's row renders from its own args, as a call the backend could not parse does. The alternative of replaying from the start for each page was rejected: it would put the whole-file read back behind every older page.

### Task 8: BG-14 stays one command

`claude_tmux_transcript` gains an optional `page`. An older backend ignores it and answers an array, which the client reads as a whole transcript, so a new renderer needs no capability probe or failed round trip. A call without `page` is an older renderer and still gets the array, counted as `tmux-transcript.whole-read`; both are in the [compatibility register](../../architecture/version-compatibility.md#register).

### Task 8: BG-14 keeps paged-in rows across a reopen

A reopened tail that overlaps the loaded rows keeps the older ones and their cursor, so a reader's place survives an environment switch. Without an overlap (more than a page was missed), or on a manual refresh, the tab starts again from the tail, which repairs any gap; earlier history stays a click away.

### Task 8: the image check counts a bound idle tab

Made on 2026-11-03. The image test's idle window first counted an unbound tab
after a fixed 2.5 s settle, so its count (4 to 7) depended on where the
fallback search's 2 s to 10 s backoff and the last pre-idle ticks fell. Raising
the bound would have hidden that. The test now seeds the transcript and waits
for 2 s with no exec in flight, which happens only inside the idle wait, so it
measures the claim it makes: a bound idle tab reads once per 2.5 s. The
unbound tab's search cost is measured by `tmux-exec-count.ts` instead.

### Task 9: batch freshness and quiet thresholds

Made on 2026-11-03. A background poll accepts a group reading up to 10 s old
(half the 20 s cadence), so a change can be seen up to 10 s later than
before; anything a user or agent waits on asks fresh. Quiet starts after
15 min without a change (the report suggested an hour; 15 min still saves
most polls of PRs that wait hours for review) and polls every 2 min, inside
the report's 2–5 min range, because a GitHub-side merge or close is then
seen within about 2 min. Unknown GitHub auto-merge, unknown mergeability and
a failed rollup all count as "not quiet".

### Task 10: paused messaging

Presence still refreshes while messaging is paused, because pausing only holds
delivery and the mail surfaces stay visible.

### Task 10: refused mail dispatch on a stopped environment

Made on 2026-11-02. The native presence read also clears a session's refused
mail dispatch when the refusal could not clear it itself. Skipping that read
for a stopped environment defers this backstop until the environment runs
again; the drain never dispatches to a stopped environment and calls the same
read before any delivery, so mail is not affected. Chosen because keeping the
session read would leave a per-mailbox read for every stopped environment,
which is what BG-3 removes.

### Task 10: tmux liveness age

Made on 2026-11-02. Presence reuses a `has-session` answer up to 3 s old. The
poll loop checks about every 2 s busy or idle and removes a session it finds
dead, so a dead session reads `working` (status null) within about 2 s either
way. Mail dispatch keeps its own probe, so a stale answer can only delay a
presence change, never send mail to a dead session.

### Task 10: reviewer prompt failures

Made on 2026-11-02. A rejected shared-prompt build is dropped from the pass's
memo, so the next reviewer reads the instruction and notes again, as each did
before.

### Task 10: digest-first MCP digests

Made on 2026-11-02. Building the handoff remembers the active login's MCP
refresh-token digests (`hostMcpRefreshDigests`). It now does so before the
marker check, for a container on another account too. The digests are the
active account's and the call is idempotent for the same login, so a later
handoff carries the same list it would have carried anyway.

### Task 13: full-check interval

Made on 2026-11-03. A full check runs once a week (`FULL_CHECK_INTERVAL_MS`),
when the stamp file is missing or unreadable, when the clock is behind the
last full check, and on the in-app toolchain repair. Daily would cost most
users the old launch time every time they open the app; never would leave a
forged stamp file trusted indefinitely. Anyone who can rewrite the stamp file
can also rewrite the binaries and the app itself, so the check bounds how
long a corrupted cache goes unnoticed rather than defending against that user.

### Task 13: racy stamps

Made on 2026-11-03. A stamp taken within 2 s of the file's own mtime or ctime
is re-verified by hashing (the rule git uses for its index), so a file changed
in the same timestamp tick as its stamp is never trusted on metadata alone. A
freshly installed or re-signed file is therefore hashed once more on the next
launch, and skipped from the one after.

### Task 13: how launch-to-ready was measured

Made on 2026-11-03. Launch-to-ready is timed on a disposable `dev:test`
profile from Electron's spawn to the launcher's `ready` write, rather than
from the launcher's own start, because the launcher's start also includes
compiling the Electron bundle (16 s of the first run after the code change).
The old code was measured by checking out only the two changed areas from
`7b48c23f` into the worktree for those runs and restoring them afterwards, so
the rest of startup was identical in both sets. The real installed toolchain
was only copied (the profile's seeding), never verified or rewritten.

### Task 13: download retries

Made on 2026-11-03. Within one call an interrupted download retries, resuming,
up to five attempts while each attempt adds bytes; an attempt that adds none
fails at once, so a refused or offline host still reaches the existing retry
dialog quickly. The partial stays for that retry and the next launch. Partials
no pinned archive references are removed after a day unused, not at once,
because another build sharing the cache may pin them.

### Task 16: attention payload budgets describe a fixture (DK-16)

On 2026-11-05, scoped the 32/80 KiB budgets to the tested three-byte names and 36-character interaction ids. Kept unconditional attention polling on the fixture evidence and live measurement in 5560. A universal byte limit would require a public-contract change; this correction makes no such change and does not claim coverage of escaped strings or longer provider ids.

### Task 16: when follow sends `knownToken` (DK-16)

Made on 2026-11-03. An older backend refuses an unknown input field with
`invalid-input`. So `--follow` checks `features.transcriptKnownToken` once
rather than sending the token and retrying without it on refusal. The check
reads capabilities once per follow, through the same routing as the read,
and never depends on matching the server's error prose.

### Task 16: a count bound beside the log sink's byte bound (DK-18)

Made on 2026-11-04. The queue used to be a promise chain bounded by bytes alone.
AGENTS.md invariant 11 asks every queue for both bounds, so the array that
replaced it has `maxPendingEntries` as well. At 65,536 entries it stays out of
the way at a typical line length, where the 4 MiB byte bound is reached first.
A line over it is dropped and announced exactly as one over the byte bound is.

### Task 16: test seam for the log sink's file calls (DK-18)

Made on 2026-11-04. `installProductionApplicationLogging` takes an optional
`files` with `mkdir` and `appendFile`, as it already takes `now` and `bounds`.
The tests need to count and fail those calls, and `mock.module` on
`node:fs/promises` would be global across the suite.

### Task 16: unchanged still reads the window fresh (DK-16)

Made on 2026-11-03. The action keeps `forceSnapshot: true` and compares the
token afterwards. Dropping the forced read would let the backend answer from
its cache or with a delta the public page cannot express. It would also make
`unchanged` depend on cache state rather than on the transcript. The provider
read on each poll stays, and reducing it belongs with task 4.

### Task 5: baseline gate (TX-1, TX-2)

Made on 2026-11-04. Task 1 gates TX-1 and TX-2 on a baseline. Ticket
`ef867c11` asked for both to be built, so the build went ahead with fake-provider
tests only. No live snapshot-rate or bytes-per-send figure exists on either side;
that stays open under task 1.

### Task 5: ring size and bounds (TX-1)

Made on 2026-11-04. Eight views per key, 2 MiB per key and 32 MiB in total
(`native-agent-transcript-delta-bases.ts`), the top of the recommended 4 to 8.
The per-key and total bytes match `NATIVE_SYNC_MAX_REVISION_BYTES` and
`NATIVE_SYNC_MAX_TOTAL_REVISION_BYTES`. A base is charged only for rows its
successor no longer holds, plus one reference per row, so shared rows count once.
The sync path's 60-second expiry was not copied: the ticket asks for count and
bytes, and expiry runs only on a write, so it would release nothing on an idle
session.

### Task 5: deltas across several revisions (TX-1)

Made on 2026-11-04. Comparing a base with the newest view misses what happened
between them, so `chainedTranscriptDelta` walks the views in between. It keeps
deletions the endpoints would read as aging out, and carries in `revisedMessages`
any held row that changed before leaving the window, skipping part-trimmed head
rows. It answers with a snapshot when the windows share nothing or the carried
rows exceed the revised-list bounds. The ring empties on a new epoch, session or
generation, or a base too large to keep, because a delta across a hole could miss
something.

### Task 5: the early cached answer (TX-1)

Made on 2026-11-04. The cached answer path tries the ring too (0160's
recommendation), because that is the path a reader who is behind takes. The delta
is marked `freshness: "cached"` like the snapshot it replaces and may be one read
stale; the background read still runs. A forced read skips the ring.

### Task 5: how post-dispatch reads are bounded (TX-2)

Made on 2026-11-04. Reads other than `sync-v1` ask the bridge for the window plus
one row, the extra row showing that older history exists. `sync-v1` stays whole
because it fills `projectionHistory`. Refreshes whose result is dropped (dispatch
outcomes, settled queue dispatches, interaction answers) read a 32-row tail
through `refreshProjectionState`. They still do everything else a refresh does,
including the announcement, and do not change the window readers inherit.

A state-only read was not used for these sites. `sessionStateSnapshot` has a
different shape from the snapshot the refresh builds on, and 0150 lists the side
effects of a full refresh as unverified. Fork, stop and control changes return a
projection, so they keep their window and gain only the limit.

Two consequences are handled in code. A tail read reports its own cut as
truncation, so the "16 MiB transport limit" notice now requires fewer or more rows
than asked, or shed parts. A paused coordinator compares a cut cached view with
the saved display tail and shows the longer one, so a short tail cannot hide saved
history.

One is accepted: a legacy reader whose next read fails sees the cached tail under
the error state until a read succeeds.

### Task 15: an input is what is staged, not the host's file (DK-14)

Made on 2026-11-04. "Changing, adding or removing one input" means the container's staged revision, which is what a start reads. Only logins and MCP defaults are restaged during a container's life; a skill edited on the host still needs a rebuild, as before. Widening that was not part of this work.

### Task 15: a removed input now leaves the home (DK-14)

Made on 2026-11-04. The ticket describes this as today's behaviour, but the old entrypoint never removed anything: `copy_agent_file` returned when its source was missing, and `cp -R` only added. The backend removed some logins on its own paths. The acceptance criteria ask for removal, so this is new behaviour, limited to paths an earlier boot of this entrypoint imported. A revoked provider's staged configuration therefore also leaves the home at the next start, where before it stayed.

### Task 15: an unreadable mount is not a removal (DK-14)

Made on 2026-11-04. A relay that fails leaves a mount `node` cannot open, which looks the same as an empty one. Non-login inputs stay in place in that case and their stamps are kept. A login's copy is still removed if it is unchanged, because the safe failure for a credential is to lose it; a backend push or the next good boot restores a valid one.

### Task 15: no separate capability helper (DK-14)

Made on 2026-11-04. Earlier `staged-inputs` versions each have an `imageCopies…` helper because the backend stages differently for them. This one has no such helper: the backend does nothing differently, and an older image keeps its full copy because its own entrypoint is unchanged. The live test proves that against an older image when `ORKESTRATOR_QUALIFICATION_OLD_IMAGE` is set.

### Task 7: a store that is not told its grace always renews (ST-3)

Made on 2026-11-04. `ObjectStore` takes `orphanGraceMs` as an option, read fresh
from the policy on each reuse. Unset, it means 0, so every reuse renews as before.
A wrong default here would delete objects, and a missing option only costs time.
The benchmark passes the policy's value, so it measures what the service runs.

### Task 7: `sweep`'s grace argument stays separate (ST-3)

Made on 2026-11-04. `sweep` keeps its explicit `graceMs` rather than reading the
store's option, because tests and `ChangeRetentionService` already pass it.
Retention reads the same policy field, so the two agree in production. A caller
passing a much shorter grace than the store's would narrow the margin.

### Task 7: the gap's value (ST-16)

Made on 2026-11-04. 2 s, the top of the report's 1–2 s and the value containers
already use, so a local and a container environment refresh at the same rate
under load. It is a service option (`localScanMinGapMs`), not a setting.

### Task 7: the owner tests turn the gap off by default (ST-16)

Made on 2026-11-04. The harness in `worktree-snapshots.test.ts` and one case in
`recurring-work-metrics.test.ts` pass `localScanMinGapMs: 0`, because they assert
what one hint does at once on a clock that does not advance. The "minimum scan
gap" cases and the real-Git case in `worktree-snapshots-git.test.ts` use the
real value.

### Task 7: a request during a recompute runs one more (ST-18)

Made on 2026-11-04. A scan or read that arrives while a scope computes now starts
one pass after it, and whoever joined waits for that pass. Before, it joined a
pass that might already have read the tree, which matters more now that a read
after expiry is what makes a view correct. Bounded at one follow-up per scope, it
stops once the service shuts down, and a retired scope is not rerun.

### Task 7: stale marker at expiry (ST-18)

Made on 2026-11-04. An expired resource is marked stale without a bump or a
`projection` event: every `changes_get_view` recomputes first, so no client sees
the mark unless a recompute fails, and an open view does not flash a stale tag
between the `reset` and its read.

### Task 7: no test seam for the demand or settle clocks (ST-15, ST-18)

Made on 2026-11-04. The tests move `Date.now` with `spyOn` instead of adding a
clock option, because both checks are one comparison. mtime and ctime are real, and
ctime cannot be set back, so a real settled file needs either this or a 2 s wait.

### Task 12: a renderer-side composition rather than a preload-side stream (DK-1, DK-2)

Chose to compose `window.orkestrator` in the renderer from a preload host and the existing gateway client. Running the stream in the preload needs no renderer change, but each event and command would still be copied across the context bridge, and it would duplicate the gateway client's reconnect and terminal recovery. Cost: the preload exposes `orkestratorDesktopHost` instead of `orkestrator` for these windows, and `waitForDesktopConnection` has to look at both.

### Task 12: commands move with events (DK-2)

Moved commands too, as 0400 recommends, since that is what removes the serialisations. Terminal input ordering is preserved by the gateway client's own `TerminalInputSequencer`, the one browser clients use, which passes the shared terminal input contract in `web-gateway-local-desktop.test.ts`. Its ambiguous-send fence now lives in the page, so a reload clears it, as it does in a browser tab. Under the relay it lived in main and survived a reload.

### Task 12: one shared terminal stream, and a command sent as the page goes

A gateway client with a `baseUrl` opened one fetch per terminal, which on a plain-HTTP listener would exhaust Chromium's six connections and stall commands, so `sharedTerminalStream` kept them on one. Since 2026-11-05 (GW-3) every client shares one terminal stream, and the option, renamed `terminalEventSource`, only keeps that stream on an `EventSource`. Widening that stream reopens it, which costs each mounted terminal a snapshot read, as in a browser. A fetch ends with its page, unlike a command held by main, so `keepaliveOnPageHide` sets `keepalive` on commands sent during `pagehide` that fit its 64 KiB limit (a final pane layout write). A larger one is lost if the page goes first.

### Task 12: DK-6 by multiplexing rather than a measurement first (2026-11-04)

The ticket's criterion is "fixed with a test or recorded as no longer applying", and DK-6 still applied, so 4500's first recommendation (measure, then decide) could not meet it. Built the report's fix, tunnel v2. Raising `poolIdleMs` alone would not have helped parallel requests, which are the case the pool misses. Cost: a second protocol version to keep until the support window passes v1, registered in version-compatibility.md. Choices inside v2 are in 4500's Assumptions and decisions.

### Task 12: the setting

Read per window at creation from `config.json`, off by default, on Settings → Experimental for a local desktop window only, as the ticket decides. The switch is not offered in a browser or on a remote window, where it would edit a config this app does not read.

### Task 11: the watermark constant stays in the server (GW-6)

`TERMINAL_WEBSOCKET_FLUSH_LOW_WATERMARK_BYTES` lives in `terminal-websocket-server.ts`, not beside the buffer limits in `packages/protocol`, because no client reads it and a protocol change would be wide-reaching for nothing.

### Task 11: no flush-pause metric (GW-6)

The ticket asks for a metric only on oversized appends, and `desyncs` and `peakQueuedBytes` already show the effect, so the metrics shape did not grow.

### Task 11: frames are encoded with `TextEncoder`, not `Buffer.from` (GW-5)

`Buffer.from(string)` may place a small frame in a shared pool slab, and a retained frame would then pin the whole slab, which the ring's byte bound would not count. `encodeGatewayFrame` gives each frame memory of its own. The bound counts the same bytes as before.

### Task 11: the flood test stalls the server's socket by hand (GW-6)

A non-reading peer needs several megabytes to fill the kernel's buffers, and how many varies by platform. `terminal-websocket-backpressure.test.ts` therefore holds `send` and its callback on the real server socket, and `terminal-flood` in `gateway-frame-costs.ts` covers the real stalled peer. With the watermark disabled, the flood, resume and ordering tests fail.

## Current state

Done on 2026-11-01 (see each task's Context): ST-7, ST-8, WEB-2 (partly),
WEB-3, BG-3 (partly), BR-1, BR-3, GW-4, and the first halves of BG-1, BG-2 and
BG-8; GW-2 in 0052. Format, lint and typecheck passed. `mise run test` failed
only on the six `tests/unit/playwright-validation.test.ts` cases, which fail
identically on `0bd214ee`, and once on the known flake 1314. The Docker,
browser and real-stack suites were not run.

## Constraints and rationale

- The report's invariants: live events stay incremental over authoritative
  snapshots with missed events detectable; every new cache, ring and buffer has
  byte and count bounds; unmount is not cancel; Codex's stdout loop never
  awaits; transcript deltas carry `revisedMessages`; metrics stay content-free.
- Durability changes (ST-12) need the maintainer's sign-off.

## Needs verification

- Task 12 on a packaged `file://` window: the Electron spec uses the dev renderer, so the packaged Content Security Policy and origin are unexercised on the new transport (read from code: `connect-src` allows `http:`, and main rewrites `Origin`). Tracked in [4501](4501-local-window-transport-default.md).
- Before-and-after numbers for every landed item (task 1): taken on macOS on 2026-11-06; what an isolated macOS profile could not measure, and why, is the last table of task 1's "Before and after on macOS". Linux was not re-run for them.
- A React Profiler run with two visible agent tabs, idle and streaming, for
  WEB-2: answered 2026-11-05 by E12's closing check
  (efficiency outcome report (`git show 413bd6219:docs/reports/2026-11-06-efficiency-logging-database-outcome.md`)). In Chromium with
  React's development build and a fake backend, idle tabs committed nothing,
  and streaming tabs committed 170 times in 20 s whether or not the hook
  subscribed to its cache entries (5.2 to 5.8 ms mean per commit). Production
  React was not measured.
- The compression default under real remote load: tracked in 0052 task 2.
- Task 7: `lstatSync` numbers come from the Linux host only. Warm capture and
  the local diff scan were also measured on macOS on 2026-11-06 (task 1): the
  warm 10,000-file capture about 40% faster, the diff scan's git processes
  and untracked reads down as on Linux, its time not. ST-16's scan rate comes from a fake watcher and clock;
  a real install was not measured. ST-14 and ST-15's numbers are from `scan-1k` on
  the Linux host and, since 2026-11-06, macOS; a real container was not
  measured. The container script's changes ran against real Git through `bash`,
  not in a container. ST-18's open-view path is proved at the backend and by the
  renderer's existing `reset` test, not in a live browser session.

- DK-13 on a real rootless daemon and on Docker Desktop: only Docker Engine 29.9.2, rootful, was run. A foreign uid reading the mirror (`--user 12345`) stands in for a rootless workload user. See [what is not yet qualified](../../architecture/container-lifecycle.md#project-git-mirror).

- WEB-12, WEB-13 and WEB-18 with `localWindowGatewayTransport` on and off in a real Electron window: `local-gateway-transport-electron.spec.ts` was not run, because this host has no disposable display (`xvfb-run`). From code, the polls and the new reads all go through the same `invoke`, and neither the gateway nor the relay filters commands by name; the Chromium run exercised the gateway path only. Tracked in [5460](5460-renderer-polling-live-evidence.md) task 3, with E23's other live-evidence items.
- WEB-19 timings in Chromium: answered 2026-11-05 by E22's closing check (`git show 413bd6219:docs/reports/2026-11-06-efficiency-logging-database-outcome.md`). With React's development build and a `<Profiler>` around a rich `MessageMarkdown`, the median per update at 30 KB was 27.1 ms for a full render and 5.5 ms for the live path (5 KB: 4.8 and 1.3 ms). Production React in Chromium was not measured.
- WEB-11 on a real mobile WebView and over a slow remote link: that a socket left dead in the background gets no pong and is replaced, and that 2.5 s is long enough for a healthy pong. Only fake-socket client tests and the real gateway's ping handling in a backend test have run. Tracked in [5080](5080-terminal-websocket-live-evidence.md).
- GW-16 past loopback Chromium: the input-results subprotocol through the Tailscale Serve route, a command-node relay in a browser, WebKit and a mobile WebView. Tracked in [5080](5080-terminal-websocket-live-evidence.md).
- Task 7, ST-13: measured on macOS only, on a synthetic 512 MiB database and on `dev:test` profiles seeded with 256 MiB of free pages; a real store with free pages left by deletions (sizes in [5101](5101-store-size-and-write-rate-live.md)) and Linux were not run. Task 8, BG-15: seen live on 2026-11-06 on a real claude-tmux tab with a loopback fake model, on macOS (task 1); no real model, and the `queue` hold not exercised live.

## Related

- Efficiency report (`git show 413bd6219:docs/reports/2026-10-27-efficiency.md`).
- [0052 remote client bandwidth](../transcripts-and-observation/0052-remote-client-bandwidth.md), D14.
- [0048 recurring work qualification](../transcripts-and-observation/0048-recurring-work-qualification.md).
- [Flake 1314](../../tests/flaky-tests/design-canvas-and-artifacts/1314-design-profile-ledger-cleanup-race.md).

## Assumptions and decisions

### Task 15: DK-13's mirror holds branches only

The ticket asked for a mirror without saying which refs. Took `+refs/heads/*` because clones use `--no-tags`, and `refs/pull/*` can dwarf a repository on GitHub. A tag or pull request an environment later asks for comes from the remote, as it did before.

### Task 15: `--reference`, not the suggested `--reference-if-able`

The report and the ticket suggested `--reference-if-able`. With no `--filter`, a mirror removed between the check and the clone would then download the whole history silently. `--reference` fails instead, so that race falls back to the blobless clone and says why. The script does the check itself, so the flag's tolerance added nothing.

Superseded by E25 (its closing check (`git show 413bd6219:docs/reports/2026-11-06-efficiency-logging-database-outcome.md`)): the clone now uses `--reference-if-able`, as the E25 ticket required, and the script checks the mirror again after the clone, reporting `vanished` when it went away, so the full-history download is no longer silent.

### Task 15: stale means the difference, not a fallback

The ticket lists a stale mirror among those that fall back to today's clone. A clone from a stale mirror already works and downloads only what it lacks (73 MiB rather than the 124 MiB of a blobless clone, in the 2,000-commit case above), so it is not treated as a failure. It is logged as `used`.

### Task 3: terminal foreground recovery after review

Chose unconditional foreground replacement until terminal-specific liveness was
available. The main stream heartbeat cannot establish terminal socket health.
Superseded the same day by the liveness probe below.

### Task 3: terminal liveness probe for WEB-11 (2026-11-04)

Added `ping`/`pong` to terminal WebSocket protocol version 1 rather than
bumping the version: the server advertises it in `ready.features`, an older
client ignores the field, and the client sends a ping only to a server that
listed it, because an older server closes the socket on an unknown frame type.
The pong goes through the server's bounded control queue, so it needs no new
bound. The 2.5 s timeout is a judgment, not a measurement: long enough for a
round trip over a slow remote link, short enough that a dead mobile socket is
replaced soon after the page returns. A probe whose page is hidden again before
it settles replaces nothing, so hiding alone never cuts background work.


### Task 11 review repairs (2026-11-04)

**Choice.** Serialize a replay frame before publishing its revision. This preserves the contiguous-window invariant required by indexed lookup without restoring a full-window filter. Regression tests exercise BigInt, circular payloads and a throwing `toJSON`, followed by successful appends and every valid reconnect cursor.

**Coverage.** Added a real stalled TCP peer integration test, a paused send-callback failure test, and scoped/unscoped removal during replay. The real-peer test is explicitly slow-tier by its integration filename.

**Measurement.** Removed the healthy-peer sleep and replaced the old timing row above; retain the stall delay only to build stalled-peer backpressure. The corrected figures support successful ordered delivery, not a claim of zero latency overhead.

### Task 11 verification repairs (2026-11-04)

Verification named four desktop failures. None of them came from a gateway change on this branch, and they were repaired rather than excused.

**Revoked-access recovery (three cases in `preview-transport-manager.test.ts`).** A real bug in tunnel v2: a pooled stream stayed reusable between the session `error` frame and the close frame, so a request after a revocation got a 502. Fixed in `PreviewTunnelSession`; the choice is recorded in [4500](4500-preview-tunnel-one-socket-per-connection.md).

**Node pull-mode receive window (`preview-tunnel-session.test.ts`).** On Node 26.7.0 `read()` with no size returned one 64 KiB chunk of the four buffered, where the test expected all of them. The credit logic was correct, so the test now drains the stream until `read()` returns null. Only Node 26.7.0 is installed on the host, so the test was not run on an older Node.

### Task 7: how the watch plan degrades and when it reads Git again (ST-17, 2026-11-04)

Anything that cannot be planned watches the whole worktree: no answer from Git, more than 256 left-out subtrees, more than 1,024 watches, or a directory name that did not decode (`fs` could not reopen it). Too many events are a cost; too few would be a wrong count. Git is asked again on a settled burst touching the index or a `.gitignore`, and at once when a `node_modules` appears, so it is left out before an install enters it. `.git/info/exclude` and global ignore files do not ask again: a linked worktree's `info/exclude` is outside anything watched, and watching it for a change that almost never happens was not worth a watch per environment.

### Task 7: a watcher with an injected `startWatch` has no plan unless given one (ST-17, 2026-11-04)

A test that injects `startWatch` almost always emits on a fake, so a default plan would start Git against a path like `/wt` and swap the fake's root. `plan` defaults to `null` in that case and a test that wants one passes `worktreeWatchPlanIo`, as `worktree-snapshots-git.test.ts` does.

### Task 7: the real-watch tests' deadlines (ST-17, 2026-11-04)

`worktree-watcher-real.test.ts` keeps writing distinct files for up to 90 s and asserts an absence only against a later delivered event. On arktech-mini the first event has taken 35 s to arrive, so a shorter deadline measured `fseventsd` rather than the watcher. It is in the slow tier for that reason. `worktree-snapshots-git.test.ts` does the same on macOS since a side-by-side run showed the host losing events for Bun and Node alike (flake 5061).

### Task 7: review follow-up status (2026-11-05)

Corrected the ST-17 status to the recorded passing macOS service runs in resolved flake 5061. Healthy-host single-write delivery remains in 5060; these runs do not establish it.

### Task 11: GW-16 cumulative input results (2026-11-04)

Kept the report's recommended per-flush batching after measuring it, although a real shell at typing speed still gets one frame per key: it adds no wait, costs fewer bytes per key either way, and collapses results that finish together. A timed window would merge more, and the ticket rules out delaying a keystroke's result. Input-only, because resizes are rare and carry their own failures. The frame uses a new subprotocol rather than a `ready` feature, as the report suggested, so a socket's result format is fixed from its first frame. Results are collected per socket rather than per channel object, because a result can complete after its channel retired, and it is then sent and ignored exactly as the older frame was.

### Task 11: leftovers from efficiency report 0100 (2026-11-04)

Report `docs/reports/efficiency-logging-database/0100-e19-terminal-websocket.md` was checked item by item and deleted; `git show e198fd4a7:<that path>` still reads it. Its GW-6 and WEB-11 work was confirmed in code and tests. What needs evidence no host here could give went to [5080](5080-terminal-websocket-live-evidence.md).


#### E19 retained task outcome table

The complete pre-retirement report is readable with:
`git show 48d2ed40c87dfda6cd1d681fa54bc930e26e03f8:docs/reports/efficiency-logging-database/0100-e19-terminal-websocket.md`.
The six rows below preserve its original part/task numbering; the report stays deleted.

| Original part / task | Outcome | Code and validation evidence |
| --- | --- | --- |
| 0100 task 1 — stop channel flushing above the socket watermark (GW-6) | Done; existing implementation confirmed | `apps/backend/src/terminal-websocket-server.ts`: `flush`, `socketBackedUp` and send-callback resume; `apps/backend/tests/terminal-websocket-backpressure.test.ts`, `terminal-websocket-stalled.integration.test.ts`; task 11 measurements above and `apps/backend/scripts/gateway-frame-costs.ts` terminal-flood workload. |
| 0375 task 1 — refresh idle timers (GW-16) | Done | `apps/backend/src/gateway-proxy.ts` and `packages/protocol/src/node/preview-forward.ts`; `apps/backend/tests/gateway-proxy-idle-timers.test.ts` and `packages/protocol/src/node/preview-forward.test.ts` cover steady traffic, last-chunk silence deadlines and one timer per body. |
| 0375 task 2 — reuse decoders (GW-16) | Done | Module-level fatal control and non-fatal input decoders in `apps/backend/src/terminal-websocket-server.ts`; `apps/backend/tests/terminal-websocket-input-results.test.ts` covers allocation counts, split UTF-8 and recovery after malformed input. |
| 0375 task 3 — batch input operation results (GW-16) | Done; remote qualification moved | `packages/protocol/src/terminal-websocket.ts`, server `operationResult` / `queueInputResults`, client `resolveInputThrough`; protocol, server input-results, client-gateway and renderer client tests cover ordering, failures and v1 compatibility. Remote/browser matrix remains [5080 task 3](5080-terminal-websocket-live-evidence.md). |
| 0375 task 4 — reduce advisory terminal acknowledgements (GW-16) | Done | `apps/web/src/lib/native/terminal-websocket-client.ts` default acknowledgement delay is 1 s; its owning tests cover coalescing; task 11 benchmark above records 100 to 5 acknowledgements in 5 seconds. |
| 0610 task 1 — rebuild only unhealthy sockets on visibility return (WEB-11) | Done; device qualification moved | Client visibility probe and server ping handler; `apps/web/src/lib/native/terminal-websocket-client.visibility.test.ts` and `apps/backend/tests/gateway-terminal-liveness.test.ts`; [5080 task 2](5080-terminal-websocket-live-evidence.md) retains mobile/slow-link evidence. |

| Original verification item or remaining qualification | Outcome / retained evidence |
| --- | --- |
| 0100: Bun `bufferedAmount`, send callbacks and quiet-channel desync reproduction | Done; task 11 measurements and backpressure / real stalled-peer tests above; terminal-flood workload reproduced the old desync. |
| 0375: exercise `timer.refresh()` under Bun on these paths | Done; gateway and preview-forward owning tests exercise refresh, single allocation and cleanup. These real socket/wall-clock files are assigned to the slow tier; they remain runnable directly. |
| 0610: how many users enabled the opt-in transport | Moved to [5080 task 1](5080-terminal-websocket-live-evidence.md); no real-install usage evidence collected. |
| WEB-11 probe on a mobile WebView and slow link | Moved to [5080 task 2](5080-terminal-websocket-live-evidence.md). |
| Negotiated results over Tailscale Serve, browser command-node relay, WebKit/mobile and a real-latency link | Moved to [5080 task 3](5080-terminal-websocket-live-evidence.md); earlier loopback Chromium evidence is recorded above. |

### Task 11 review decisions (2026-11-04)

**Task 11 — real-time validation.** Keep the actual socket and runtime timer tests and assign both owning files to the slow tier. This preserves integration evidence without making the deterministic default depend on host scheduling. A fake-clock rewrite could run in the default tier but would not exercise Bun's real `refresh()` and network paths. Silence assertions now measure from the final chunk.

**Task 11 — compatibility usage.** Count the v1 path when an authenticated socket becomes ready, for both header and in-band authentication. Counting upgrades included peers that never authenticated; counting only input results would omit authenticated older peers before their first write. Tests cover unauthenticated, in-band and header-authenticated sockets.

**Task 11 — coverage.** Added queue-saturation rejection between successful input results and a delayed successful result after channel unsubscribe. Corrected the flush comment to identify `queueControl` as the hard-limit owner.

### Task 4: following a section that has not settled (2026-11-04)

The analysis listed the triggers and a 30 s backstop. That alone would have stranded a view: the first read schedules at most two of the four sections per provider, so the rest stay `loading` until a later read asks again, and a refreshed section with an unchanged value is not announced, so a read that found it `stale` would have kept showing that until the next backstop, which would find it expired and `stale` again. A failed refresh announces nothing either. So a view with a section `loading` or `stale` looks again after 2 s, the backend's own section deadline, and one with a section `unavailable` after 5 s, the backend's retry. A provider that keeps failing costs one read every 2 s, down from two a second. No new backend announcement was added, since the read is what starts the refresh in any case.

### Task 4: detecting the combined read by capability (2026-11-04)

The analysis expected an older backend to be detected by the missing command. `get_native_agent_sync_capabilities` already carries this kind of answer (`transcriptPatchVersions`), so the backend advertises `liveUpdateVersions` and an older one is never sent a command it would refuse, which keeps its gateway's failure counts clean. The missing-command path stays only for a backend replaced by an older one before the next resync: both parts then answer `pending` in that round and are read on their own.

### Task 4: a slow part answers `pending` (2026-11-04)

The reads were separate, so a slow transcript could not delay session state, which carries pending approvals and the turn phase. Waiting for both would have traded that away, and the ticket asks for a running tab to stay as live as it is. A part still running after 250 ms answers `pending` and the client reads it alone, joining the provider read in flight. 250 ms is a judgment, half a round, not a measurement; the two reads took about 2 ms each in the runs above. First, manual and post-mutation reads stay two requests, so a cold transcript never travels with state.

### Task 4: discovery causes instead of a new signal (2026-11-04)

The analysis said an invalidation would have to start naming discovery. #1659 (2026-11-03) had already added a `cause` to each change, so the listener reads that and no event changed. A change with no cause (a backend before v2.36.0) or an unknown one counts as naming discovery, which keeps such a backend correct at the cost of some reads, and is listed in the compatibility register.

### Task 7: ST-13 measured what remained, not what the report named (2026-11-06)

The report named the hourly `VACUUM INTO` and `quick_check`. Both were already in a child process (#1363), and the measurement showed the hourly and ledger checks holding the loop 4–25 ms. Moving them again would have saved nothing, so the work went to the step that did block: the five-minute upkeep's free-page release. The pre-migration copy and the deletion scrub also block, but are outside the snapshot check; they are recorded in [7210](7210-storage-work-left-on-the-event-loop.md) with a recommendation each rather than changed here.

### Task 7: the release child's step, pause and busy rule (2026-11-06)

256 pages (1 MiB) a transaction and 5 ms between them. The step bounds how long a backend writer waits behind the child's write lock; at 4 MiB that wait would be the 4 MiB step's own cost again. The pause gives the backend's writers a window between steps; it is why the release's total time roughly doubled (1.5 s to 3.0 s p50 for 64 MiB), which is off the loop and once per five minutes at most. The child waits at most one second for the lock and then stops rather than failing: the next check retries, and the backend's writers come first. Each step ends with a passive checkpoint in the child, so the backend's next commit does not cross the automatic-checkpoint threshold on the child's frames and pay that fsync on the loop. Both numbers are judgments checked against the contention runs in task 7, not tuned.

### Task 7: the release has no lease (2026-11-06)

The copies hold the `storage-backup` lease so two backends sharing a data directory do not copy at once. The release does not take it: SQLite's write lock already serialises two releases, each stops on a busy database, and a lease held across a child's run would make the other backend's check wait for it.

### Task 8: BG-15 keeps an extra environment read after the probe (2026-11-06)

Before, the post-probe re-read covered only the queue and the draft. `mailInjectHold`, shared by both reads, also checks the environment, so a deletion requested between the gate and the dispatch now holds the mail as `environment-unready` after the probe, before the queue boundary, whose `assertEnvironmentAcceptsBackgroundState` would otherwise refuse it with an error. That is why the environment reads per delivery stay at 2 while the queue and draft reads drop by one each.

### Task 1: how the live ST-13 baseline gets work to do (2026-11-06)

A fresh `dev:test` profile's database has almost no free pages, so its upkeep would have nothing to release and both sides would measure the same. The profile was stopped and 256 MiB of free pages were written into its own database before the second start, in two layouts, because where the free pages sit decides what a release costs: at the end of the file it only truncates, between live pages it moves them. The interleaved layout is the one deletions leave behind and the one that showed the difference. The backend's 500 ms event-loop sampler cannot resolve stalls of tens to hundreds of milliseconds, so the gateway's login page was probed every 20 ms; it is served by the backend's event loop and needs no token, so no credential was read or printed.

### Task 1: one before-and-after pair for everything landed (2026-11-06)

The decision above recommends measuring `0bd214ee` against the branch that
landed each change. Those branches are merged, so the macOS pass compared
`0bd214ee` with `main` at `ee2cc8423`, which holds all of them: one pair that
shows what the whole set changed for each measurement. Items whose own task
already has a pair (ST-13, BG-15, WEB-1, DK-3, DK-7 to DK-9) keep it; BG-15's
live pair used its own base, `c1724ab74`, because the change under test was
BG-15 alone. The cost is that a difference in the composite pair cannot be
pinned on one item without the code, which is why each row names the items
it bears on.

### Task 1: what the base checkout was given (2026-11-06)

Two additions to the scratch worktrees, neither committed: base's agent-test
environment allowlist got the `ORKESTRATOR_HOST_REACHABILITY_CHECK` entry
`main` has since 2026-11-01, so its boot probe made no Docker networks (the
ticket required the switch), and the base benchmark script got the current
script's 2.5 s fixture settle on both trees. The first is a test switch; the
second is benchmark setup, the same on both sides.
BG-15's base got the claude-tmux isolation fix below, without which the check
would have read the host's `~/.claude`.

### Task 1: a visible window on both sides (2026-11-06)

Base's launcher predates `--headless`, so its Electron window is always shown.
A hidden window's renderer polls less, so after ran with `--no-headless` too
(`--window visible`) rather than comparing a visible base with a hidden after.

### Task 1: it stays open (2026-11-06)

The ticket asked for every item measurable on macOS. What is left needs
access an isolated profile does not have (a real PR and `gh` login, root for a
cold page cache), or a
busy profile with stores, mailboxes, sessions and
pipelines in use, which 0048 already plans. Closing task 1 would drop those
from view, so it stays open with them listed in its last table.

### Task 5: closed on measurements, not live evidence (2026-11-06)

The ticket asked to close task 5 if its items were all done or measured.
They are: every TX item is built or (TX-17) closed after profiling, and the
two gated on a baseline are measured, TX-1 live and TX-2 with a fake. The
live figures still wanted are already open in 5340 and 6680, so closing task
5 loses nothing.

### Task 1: a claude-tmux tab in an agent-test profile used the host's Claude home (2026-11-06)

Found while unblocking BG-15: a local claude-tmux session runs on the host's
shared tmux server and, with no added Claude account, exported no
`CLAUDE_CONFIG_DIR`, so the CLI read the tmux server's environment (on this
host, `~/.claude`) while the backend looked for its transcript in the
profile's isolated directory. `tmuxLocalClaudeConfigDirectory` now returns
the backend's own `CLAUDE_CONFIG_DIR` in an agent-test profile with no added
account; production is unchanged (covered in
`backend-runtime-wiring.test.ts`). To-do 7211, which asked for this live
check, was folded into task 1 and deleted.

### Task 1: DK-7 to DK-9 on macOS use task 14's own pair (2026-11-06)

The image figures were rebuilt from `d6040915c` and `fd679c0e2`, the parent
and the merge of the change, not from `0bd214ee` and `main`: five later
commits changed `docker/Dockerfile` (bridge credentials, the egress gateway,
security hardening), so a composite pair would mix their bytes into DK-7 to
DK-9's. This follows the earlier entry, where items with a pair of their own
keep it. The sizes come from a committed script,
`scripts/docker-image-layers.ts`, rather than a throwaway one, so the next
pass (another host, or the arm64 qualification task 14 still lacks) can
repeat them; it pairs `docker history` rows with `RootFS.Layers` and refuses
to guess when the counts disagree. Docker Desktop reports uncompressed sizes
from its containerd store, the same basis as the Linux figures. No smoke or
suite ran on these images, because the measurement needs neither and the
ticket asked for numbers, not qualification.

### Task 1: review repairs and WEB-3 baseline (2026-11-06)

**Choice: reject unsafe benchmark routing.** The benchmark now requires a
credential-free agent-test profile with matching profile/data paths and no
active added Claude account, checking only the profile's own registry. Keeping
credentialed profiles would preserve their host login, but their tmux config
routing bypasses the loopback settings; rejecting them (recommended) preserves
the no-billed-turn requirement without transporting credentials. Focused tests
cover a Claude grant, missing grant metadata, SQLite and legacy JSON active
accounts, and the credential-free success path.

**Choice: transactional fixture installation.** Construct the restorer before
either write and roll back inside setup's catch (recommended). Returning a
restorer only after successful setup is simpler but cannot undo a failed second
write. Restoration attempts both files and reports rollback failures in the
artifact. Injected second-write failures verify original settings, fake-server
cleanup and no launched tab; another case verifies a rollback failure is visible.

**Choice: measure WEB-3 through the gateway browser.** A native loopback turn
(recommended) works safely on the unpatched baseline and observes the real
renderer's list hydration. A tmux turn would need the later directory fix;
counting Electron IPC would miss the gateway command counters. The committed
script records both per-command transition windows and a quiet control, with
two cycles per pinned commit. It measures the two remaining list hydrators;
it does not infer the original report's third list or attribute all RPC savings
to WEB-3. Task 1 stays open for the separately listed measurements requiring
additional access or a busy fixture.

### Task 1: count a container's execs from Docker, not the backend's counters (2026-11-10)

**Choice.** `scripts/container-tmux-tab-live.ts` records, for each window,
every `exec_start` Docker reports for the container (`docker events`,
labelled by program only) beside the `recurringWork` deltas, and the
comparison uses Docker's count. The backend's counters alone (the 2026-11-06
method) would have been simpler and need no Docker stream, but the
claude-tmux tab loop has no recurring kind on either commit and base charges
fewer of its loops at all (its tab cleanup charged none of the 5 execs a
minute it made), so the counters would have reported 64 a minute on both
sides while Docker saw 297–471 against 124.5–128.5. Docker's count is the
same instrument on both commits. Adding a recurring kind for the tab loop is
[7562](../transcripts-and-observation/7562-tmux-tab-loop-recurring-kind.md).

### Task 1: a container-local fake model for the container tab (2026-11-10)

**Choice.** The tab's `claude` talks to `container-fake-claude-api.ts` on the
container's own loopback, installed by `container-fake-claude-install.ts` as
the container Claude spec does. A host-side fake, as BG-15's local run used,
would need the container to reach the host, which this host's containers
cannot; a real login was ruled out by the ticket. The fake answers every
message, so a turn is real CLI work with no provider.

### Task 1: the base profiles' launcher kept headless by a wrapper (2026-11-10)

**Choice.** `0bd214ee`'s launcher has no `--headless`, and on this host a
window would open on the signed-in desktop (the ticket required headless and
forbade Xvfb). Its `node_modules/.bin/electron` honours
`ELECTRON_OVERRIDE_DIST_PATH`, so a scratch wrapper `exec`ed base's own
Electron 45.0.0 with today's `HEADLESS_ELECTRON_SWITCHES` and no display
variables. Both sides' renderers were therefore headless, unlike the macOS
pair, which kept both visible; within this pair the window state matches.
The wrapper and base's Electron download were in the scratch worktree and
went with it.

### Task 1: the busy phase uses the checkout's CLI (2026-11-10)

**Choice.** `runArm` now passes `--checkout` to the busy phase's CLI runner,
as the freshness probes and the soak already did. With today's CLI the base
busy run failed at its first step: the CLI refused a backend that publishes
no Linux process identity (`connection-failed`), which the busy phase
reported as a missing fixture. Base's CLI ran every step except `review
launch` with a Pi reviewer, so base's busy rows have no Multi Review. The
busy phase's error now names the CLI's exit status and error code (never its
output). Covered by a runner test in `recurring-live-ab-runner.test.ts`.

### Task 1: per-item counts on the kept busy profile (2026-11-10)

**Choice.** `scripts/busy-item-counts-live.ts` reads idle windows on the
profile the busy driver kept, restarted, rather than adding a post-busy
phase to `recurring-live-ab.ts`. The restart loses in-memory state (the Pi
sessions' fake model is gone, so nothing runs turns), but the stores the
items live in are what the counts are about, and the driver stays as 0048
left it. Stopping the nine `busy-*` environments through `environment.stop`
gives BG-3 its stopped environments with mailboxes, on both commits through
the same public action.

### Task 1: what stays open, and why (2026-11-10)

- **BG-2's doorbell rate live**: needs a host whose containers reach the
  backend's agent tools port. Beelink's do not and its firewall may not be
  changed; macOS Docker Desktop's do (agent-doable there).
- **BG-9 live**: needs a working Claude or Codex native session, because
  only those report the content revision BG-9 keys on; the busy driver's Pi
  sessions do not. A native Claude tab on the loopback model, as WEB-3's
  driver opens, would do it (agent-doable; not run in this round).
- **BG-11 live**: needs a build pipeline's review fan-out, which needs Codex
  or a ticket-driven pipeline on a fake model (0048 task 1 left it out for
  the same reason).
- **BG-12 live, `gh-spawn` per hour, cold-cache launch**: the user's; they
  need a real Claude login handed to a container, a real PR with a `gh`
  login, and root to drop the page cache.
