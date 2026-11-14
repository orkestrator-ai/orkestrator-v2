# Recurring work qualification

## Task analysis

Analysed 2026-11-13 against main at 17d28238c (tasks 8, 13 and 18 on
macOS, arktech-mini: task 18's reconnect timing measured in a real headed
background tab, see
[Background-tab reconnect](#background-tab-reconnect-2026-11-13-macos);
task 8's simulator run moved to 7568 because the host has no iOS simulator
runtime; task 13's `ORKESTRATOR_NATIVE_OBSERVATION_SHARING` removed;
decisions Q1 to Q4). Tasks 12 and 13 are what is left, both blocked on
7568's live GitHub run (0048 task 5).

Analysed 2026-11-11 against main at 498b68766 (task 12: the client-only and
validation candidates measured on Linux and decided, decisions C1 to C7, see
[Client-only and validation candidates](#client-only-and-validation-candidates-2026-11-11-linux);
tasks 8 and 18 rechecked and still need a macOS node and a headed browser).

Tasks 6 and 13 rechecked 2026-11-11 against main at 498b68766: 0049, which
task 6 delegated to and task 13's observation-sharing removal waited on,
finished that day and was retired.

Analysed 2026-11-10 against main at c98b20e6f (task 13: the `multi-review`
rollback driver removed, decision W6).

Analysed 2026-11-10 against main at 04639b12b (tasks 2 and 13; live
evidence from Linux that day, see
[Workflow client visibility](#workflow-client-visibility-2026-11-10-linux)).

Analysed 2026-11-06 against main at 37d0966ff9cf02ff55693c21edcd8506a8b8beae.

Analysed 2026-10-27 against `main` at `863b5782`.

Checked against `main` at `00a0cb82` (2026-10-25); tasks 3 and 4 rechecked
against `main` at `93b99bfba` (2026-11-01). Live evidence from macOS on
2026-10-22 and 2026-10-25, and from Linux on 2026-11-01; see
[Live evidence](#live-evidence-2026-10-22-macos),
[Live soak](#live-soak-2026-10-25-macos),
[Container fetch policy and app wiring](#container-fetch-policy-and-app-wiring-2026-11-01-linux)
and [its follow-up](#container-app-wiring-follow-up-2026-11-01-linux).
Task 10 rechecked against `main` at `281de1a17` (2026-11-06), with live
evidence from Linux that day; see [Long soak](#long-soak-2026-11-06-linux).
Tasks 1, 2, 7 and 19 to 21 rechecked against `main` at `c1724ab74`
(2026-11-06), with live evidence from macOS that day; see
[macOS watcher, change-to-visible and remote freshness](#macos-watcher-change-to-visible-and-remote-freshness-2026-11-06-macos)
and [Event-stream reader inventory](#event-stream-reader-inventory-2026-11-06).
Tasks 1, 2, 5, 8, 9, 12 to 14 and 16 to 18 rechecked against `main` at
`ee2cc8423` (2026-11-06), with live evidence from Linux that day; see
[Busy profile](#busy-profile-2026-11-06-linux).

### Tasks

1. **Busy live profile**: 10 environments, 0 to 2 browser clients, bursts, an active turn, an approval, a queued prompt, a workflow completion, an outage and a client resume. Status: done (2026-11-06: `recurring-live-ab.ts --busy-rounds` on Linux with a fake model, keyed and rollback arms, 0 to 2 headless clients; every obligation kept in 17 of 18 rounds, the 18th lost to a client page that never loaded (a harness fault; such a page is now reloaded, and a second run's 12 client rounds all passed); the keyed drivers met every budget row the profile reaches, and the rollback drivers missed workflow progress; decisions B1 to B9, follow-ups in 7202 (retired 2026-11-14; both done or closed, see [Related](#related))).
2. **Client-side change-to-visible latency**: measure every latency-budget row as a client sees it, not at backend detection. Status: done (2026-11-10: workflow progress measured in a client's review view on Linux, p50 224 ms and p95 4.27 s against ≤ 3 s; the tail is the backend's, 7557, fixed and retired 2026-11-10, [after the fix](#workflow-progress-after-the-7557-fix-2026-11-10-linux); the four PR rows need live GitHub and moved to task 5, decision W3, now in 7568) (2026-11-06: the diff badge and Files panel rows measured in a real browser on macOS, `change-to-visible-latency.spec.ts`, all within budget except the tail of a container Changes refresh, 7201; turn completion, activity and queued prompts measured client-side by task 11; the approval and mail rows measured by task 1's busy profile on Linux).
3. **Container fetch policy live**: recovery fetch, explicit refresh and the routine policy on an environment without `createdFromCommit`, then keep or remove the routine policy. Status: done (2026-11-01: all three ran live on Linux; the routine policy stays, decision 11; a wasted revert fetch found and fixed).
4. **Container app wiring and real-browser QA**: Files panel on a container, merge from the UI, inactive switch, two windows, hidden document, reload, missed final invalidation, coordinator view, validation output. Status: done (2026-11-01: every case checked in a real browser on Linux, decisions 19 to 23; GitHub's own merge behaviour stays with task 5 (now in 7568) and real-model validation plans with 0049; a build-tab selection bug found and fixed, decision 23).
6. **Live providers**: delegated to 0049. Status: done (2026-11-11: 0049 finished and was retired; what it qualified is summarised in [agent-testing.md](../../development/agent-testing.md), and its Grok and Cursor runs are on the manual-test checklist, 7568).
7. **macOS watcher paths**: packaged Electron app, plus the burst-overflow and failure-to-polling paths. Status: done (2026-11-06: real FSEvents bursts up to 50,000 files and a lost watch helper, in `scripts/worktree-watcher-live.ts` (two runs), in a browser on `dev:test` and in the packaged app, `watcher-packaged-electron.spec.ts`; every burst converged, every failure fell back to polling and re-attached).
8. **iOS hidden pause and resume**: the read coordinator across backgrounding and screen lock in the `apps/ios` wrapper, on the iOS simulator. Status: done (moved to 7568 on 2026-11-13: the macOS node, arktech-mini, has Xcode but no iOS simulator runtime, and installing one changes a shared host; the wrapper also needs a Tailscale Serve HTTPS origin and a typed gateway token, decision Q1; the physical-device run moved to 7568 on 2026-11-10).
10. **Long soak and cache gauges**: 50 or more cycles over an hour or more with agent sessions open, and gauges for caches the footprint cannot see. Status: done (2026-11-06: cache gauges in recurring diagnostics, a 60-cycle local soak over more than an hour with fake-model Pi sessions open, and a fix for the one unbounded growth it found, decisions 24 to 28; container lifecycle, a browser reader and three projection maps without eviction moved to [7100](7100-long-soak-follow-ups.md)).
11. **Multi-client, restarts and an older backend**: two clients with one disconnected, backend and bridge restarts at durable transition boundaries, an older backend. Status: done (2026-11-06: all qualified on Linux with a fake model, `multi-client-restarts-live.spec.ts`, against v2.21.0 for the older backend; two defects fixed, decisions T11.1 and T11.2; what needed a decision was in 7120 (retired 2026-11-13; in Git history at the parent of the commit that deleted it (`git log -1 --diff-filter=D -- docs/todo/transcripts-and-observation/7120-multi-client-restart-follow-ups.md`)), all of it since done).
12. **Measured candidates**: 12 cadence and limit candidates to decide from live data. Status: blocked (waits on 7568: 0048 task 5; only the two PR candidates are left) (2026-11-11: the six client-only and validation candidates measured on Linux and decided: Docker availability sharing, the design canvas cursor interval, a shared display clock, the validation reader's spawn per poll and B20's split all kept unchanged, decisions C1 to C4 and C6; B19's demand gating is needed only for terminals no client detached, which keep capturing, moved to to-do 7745, decision C5, which leased the terminal and observed the orphan and its end live on 2026-11-11 before it was retired; see [recurring-work.md](../../architecture/recurring-work.md) row B19) (2026-11-06: the busy profile decided the three it reaches, admission limits, scan re-prioritisation and mail retention, all kept, decision B7; the two PR candidates wait for task 5 (now 7568: 0048 task 5); the client-only and validation candidates never needed task 1 and are re-scoped to their own runs; the feature-planning row read is done, and the container fetch failure ladder is decided (keep 5 to 30 min, decision 11)).
13. **Remove the rollback drivers**: `ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK` and its whole-store drivers, `WorkflowDueScheduler`, and `ORKESTRATOR_NATIVE_OBSERVATION_SHARING`, updating the catalogue. Status: blocked (waits on 7568: 0048 task 5) for the `feature-planning` and `build-pipeline` rollback drivers and the switch itself (2026-11-13: `ORKESTRATOR_NATIVE_OBSERVATION_SHARING` is removed with its code paths, desktop allowlist entry, the recurring baseline's rollback mode and the A/B rollback arm's value; sharing is the only driver, decision Q3) (2026-11-10: the `backend-activity` and `native-queues` rollback drivers are removed, decision W2; task 5 never gated them, decision W1; later that day the `multi-review` rollback driver, `WorkflowDueScheduler`, is removed too, on task 2's fresh keyed timing (every review reaching `ready`, tail in 7557, fixed and retired 2026-11-10, [after the fix](#workflow-progress-after-the-7557-fix-2026-11-10-linux)), decision W6; the other two drivers were rechecked and stay blocked, decision W7).
14. **Metrics switch decision**: keep `ORKESTRATOR_RECURRING_METRICS` as a permanent kill switch. Status: done (2026-11-06: the stale comment is reworded).
15. **Provenance comments**: "recurring-processes step NN" comments pointing at deleted plans. Status: deferred (decided: leave them).
18. **Reconnect timing in a real background tab**: a hidden tab's retries under timer throttling, and an immediate retry when it becomes visible. Moved from to-do 0051 (deleted 2026-11-06). Status: done (2026-11-13: `background-tab-reconnect-live.spec.ts` in headed Chromium on macOS, the tab hidden behind another tab with Chromium's own throttling on; 5 passing runs, one hidden about 12 minutes: hidden timers woke once a second, the hidden tab reconnected 2.3 to 10.0 s after the link returned (budget 20 s), retry gaps never grew past the 16 s cap after 12 minutes hidden, and showing it retried both streams 8 to 163 ms later, against a next rung at least 8 s away; decisions Q2 and Q4).
19. **Changes-tab remote freshness**: qualify `WorktreeSnapshotState.remote` and the stale-base warning through the real browser. Carried from 0020's pointer to retired 0051. Status: done (2026-11-06: qualified on a legacy container record on macOS, `changes-remote-freshness.spec.ts`; it found that the Changes tab's Refresh never asked a container for its remote, fixed, decision M3).
20. **Other event-stream readers**: assess silent-drop detection and retry spread beyond the browser gateway and Electron client. Moved from 0051's unverified scope note (deleted 2026-11-06). Status: done (2026-11-06: a disposition per reader; four gaps in 7200, two fixed with tests).
21. **Retired to-do pointers in source comments**: repoint five comments in a code-allowed follow-up; this retirement ticket changes documentation only. Status: done (2026-11-06).

### 1. Busy live profile

**Problem.** Recurring work is on by default, but the only live evidence is an idle, credential-free profile. None of the obligations the keyed drivers must keep (result consumption, prompt dispatch, PR terminal effects) has run live, so a missed wakeup under load would show as a stale workflow or a stuck queue for every user.

**Context.** The idle A/B and a 10-cycle soak ran on macOS (Live evidence, Live soak). The file says each busy step needs credentials, a scripted UI or a fault injector that `scripts/recurring-live-ab.ts` lacks. Outage and resume overlap with the live outage workload in 0051. The run is batched for macOS and Docker Desktop in 0031.

**Investigation.** `scripts/recurring-live-ab.ts` still drives only profile lifecycle, sampling, freshness probes and the soak (`--soak-cycles`, `scripts/recurring-live-ab.ts:141`). It has no client, credential or fault-injection phase. The keyed domains it would exercise are still switched per domain at `apps/backend/src/core/build-pipeline-context.ts:145`, `feature-planning.ts:259`, `looped-review-service.ts:420`, `multi-review-service.ts:625`, `native-agent-service.ts:988` and `index.ts:359`. Nothing since `00a0cb82` has added busy-profile tooling. Scheduled jobs (#1242) added a new recurring kind, `scheduled-job-tick` (`packages/protocol/src/recurring-work.ts:325`), which a busy profile should include.

**Decisions.**

- **How to drive the busy workload?**
  - **Extend `recurring-live-ab.ts` with a scripted busy phase using the `orkestrator` CLI and a Playwright client (recommended).** Add phases for turns, queued prompts and workflows through the CLI, and attach 0 to 2 real browser clients.
    - Pros: reuses the script's ownership checks, guard-line count and A/B arms; repeatable.
    - Cons: needs credentials and a client driver; the script grows further.
  - **A one-off manual run with diagnostics snapshots.**
    - Pros: quickest route to first evidence.
    - Cons: not repeatable, and the arms are hard to compare fairly.
- **Run the outage and resume parts here or in 0051?**
  - **In 0051's outage workload, cited from here (recommended).**
    - Pros: one fault injector, and no duplicated evidence.
    - Cons: this file's busy profile depends on 0051's tooling.
  - **Here, as part of the busy profile.**
    - Pros: one self-contained run.
    - Cons: duplicates 0051's harness work.

**Outcome (2026-11-06, not done).** Rechecked on `c1724ab74`; the
references above hold. The busy profile was not attempted in the macOS run.
The fake-model soak driver from task 10 (`recurring-live-ab.ts --soak-cycles`)
drives profile lifecycle and opens idle fake-model Pi sessions; extending it
to this workload needs, at least: a scripted turn and a held approval against
the fake model (task 11's `multi-client-restarts-live.spec.ts` already does
both for Claude, and a queued prompt), a workflow that completes without a
real provider, 10 environments, 0 to 2 Playwright clients attached for the
whole run, and the outage link from `client-outage-support.ts`. That is a new
driver phase plus a client harness, larger than this run's remaining scope;
it stays open with the recommendation unchanged (one CLI-and-Playwright busy
phase in `recurring-live-ab.ts`). No real provider or login is needed.

**Outcome (2026-11-06).** Rechecked on `ee2cc8423`: the driver still had no
client, approval or workflow phase, and the keyed domains are switched at
`build-pipeline-context.ts:241`, `feature-planning.ts:265`,
`multi-review-service.ts:751`, `native-agent-service.ts:1438`, `index.ts:525`
and, since graph runs, `graph-run-service.ts:241` (looped review is retired).
The recommendation was taken, with every turn on a fake model: a busy phase
(`--busy-rounds`, `scripts/recurring-live-ab-busy.ts` with its Playwright
clients in `recurring-live-ab-busy-clients.ts`, decision B1) brings up 10
local environments with real Pi sessions on the loopback fake model and,
for 0, 1 and 2 headless clients, runs rounds of a 200-file burst in every
environment, a turn held at the model with a prompt queued behind it, a
command approval Pi parks under an `ask` policy, agent mail, a cut link (two
clients) or a hidden document (one client), a Multi Review driven to `ready`
by the fake model (decision B3) and the client's resume. It ran on Linux in
both arms; see [Busy profile](#busy-profile-2026-11-06-linux). On the keyed
drivers every round kept every obligation and every budget row the profile
reaches was met. On the rollback drivers workflow progress after a result
took p95 4.05 s against 3 s, and Multi Review needed 16 s instead of 4.8 s
from launch to `ready`. The outage and resume ran here with the outage link
of `client-outage-support.ts` rather than waiting for 0051's workload, which
was retired; a real two-machine drop stays task 16. Not covered: containers
(this host's Docker pools, decision 27), feature planning and build
pipelines (they need Codex or a ticket-driven pipeline), and PR monitoring
(task 5).

### 2. Client-side change-to-visible latency

**Problem.** Freshness was measured only from a write to the backend `diff-scan` counter moving. That is a lower bound; the budgets in [recurring-work.md](../../architecture/recurring-work.md#latency-budgets) are about what the user sees.

**Context.** Watched local p95 was 739 to 872 ms against 2 s, and container p95 13.4 s against 20 s, backend-side. The read coordinator, SSE and rendering add latency on top.

**Investigation.** No client-side probe exists in `scripts/recurring-live-ab.ts` or under `e2e/agent-testing/`. The container margin (13.4 s of 20 s) is the tightest, so client overhead matters most there.

**Decisions.**

- **How to measure change-to-visible?**
  - **A Playwright probe that writes through the CLI and waits for the badge's accessible state to change (recommended).**
    - Pros: measures what the user sees; reusable for task 4.
    - Cons: browser timing adds jitter; needs many probes for a stable p95.
  - **Timestamp the renderer's store update and report it through the metrics endpoint.**
    - Pros: precise, and no browser driver needed.
    - Cons: misses paint time and adds renderer instrumentation.

**Outcome (2026-11-06).** Rechecked on `c1724ab74`: still no client-side
probe existed. The recommended option was taken:
`e2e/agent-testing/change-to-visible-latency.spec.ts` writes a file into a
watched local worktree or a container and times, in the Playwright process,
until the page shows the sidebar badge, a Changes row and an All files
entry, and after an explicit Refresh. Container probes start at random
offsets in the 15 s scan interval. On macOS every row it covers was within
budget except the container Changes refresh, whose p95 is pulled over 1 s by
refreshes that follow a scan already running (decision M6,
7201). See [macOS evidence](#macos-watcher-change-to-visible-and-remote-freshness-2026-11-06-macos). The other
budget rows need a live turn, approvals, mail, PRs or workflows; task 11
already measured turn completion, the activity indicator and queued prompts
on two clients, and the rest belong with tasks 1 and 5.

**Outcome (2026-11-06, Linux).** Task 1's busy profile measured the rows that
needed a live turn, an approval, mail or a workflow, on headless Chromium
clients of a 10-environment profile under load, keyed drivers: pending
approval visible p95 154 ms (≤ 2 s), mail shown on the tab p95 119 ms
(≤ 4 s), the background activity indicator turning to working p95 1.85 s
(≤ 4 s), turn completion visible after an approval p95 104 ms (≤ 3 s; the reply row in the client's open tab),
a queued prompt dispatched after the turn ends p95 1.63 s (≤ 3 s), and
workflow progress after a result p95 157 ms (≤ 3 s, backend-side: a Multi
Review phase change read through `review.get` after the model got its result
back). The diff badge after a 200-file burst in every environment showed in
p95 519 ms and returned in 2.03 s after removal (2.4 s from the write,
decision M1). See [Busy profile](#busy-profile-2026-11-06-linux). Left: the
four PR rows, which need task 5's live GitHub.

**Outcome (2026-11-10, Linux).** Rechecked on `04639b12b`: the busy clients
stayed on the approval tab, so workflow progress had only a backend row
(Review repair: task 2 workflow visibility). Each busy client now opens a
review view: a second signed-in context of its own, through the same link,
on the review environment before the review is launched
(`recurring-live-ab-busy-clients.ts`, decision W4). After the launch it
selects the review's tab, whose element id ends with the backend's
`multi-review:<workflowId>` tab id. A recorder in the page notes each phase
the review's header shows; the header now carries the phase and workflow id
as data (`data-testid="multi-review-phase"`, `data-phase`,
`data-workflow-id` in `MultiReviewTab.tsx`; no visible change). Each result
is timed from the fake model's submission to the first sighting of the phase
it leads to or a later one (`clientProgressSample`). A result that reached
the backend before the view showed the review is counted as not sampled,
never inflated. The cut client of a two-client round does not watch; the
hidden one-client round's view is its own, visible document.

Two live runs on a fresh 10-environment profile, keyed drivers, one and two
clients, three rounds each: every view watched its review from before the
first result (12 of 12 results timed in each run, none unobserved). Client
p50 221 and 224 ms; p95 3.90 and 4.27 s against ≤ 3 s. The tail is the
backend's: the backend row's p95 was 3.71 and 4.08 s for the same results,
and the client showed each phase 30 to 250 ms after the backend observed
it. It is always the consolidated result's move to `ready`, three times in
twelve reviews, and matches the 3 s observation interval plus jitter
(7557, fixed and retired 2026-11-10, [after the fix](#workflow-progress-after-the-7557-fix-2026-11-10-linux)). See
[Workflow client visibility](#workflow-client-visibility-2026-11-10-linux).
The first run also showed that the repaired harness expected a
`submit_review_preparation` result Multi Review never sends; fixed (decision
W5).

### 3. Container fetch policy live

**Problem.** The container fetch policy and its failure ladder have never run live. New containers never reach the routine policy, so it guards only older records and failed commit captures.

**Context.** Narrowed on 2026-10-25 (decision 6): every new container records its creation commit and compares against it, so a "branch-baseline container" cannot come from normal creation.

**Investigation.** Still accurate. `establishCreatedFromCommit` is at `apps/backend/src/core/commands-local-server-lifecycle.ts:87`, `resolveComparisonRef` at `packages/protocol/src/diff-stats.ts:194`, and the cooldowns at `apps/backend/src/core/container-git-fetch.ts:97` (5 min) and `:99` (30 min). The routine path therefore serves a shrinking population that new users never reach.

**Decisions.**

- **Keep the routine fetch policy?**
  - **Qualify the recovery fetch and explicit refresh live, then remove the routine policy unless a pre-capture record turns up in real data (recommended).**
    - Pros: drops a path with no reachable live state for new environments; the failure ladder candidate closes with it.
    - Cons: an old environment without `createdFromCommit` loses routine freshness; needs a check that such records are rare.
  - **Keep it and qualify it on an old-format record.**
    - Pros: no behaviour change for legacy environments.
    - Cons: needs a hand-made legacy record (decision 6 rejected a fixture side door), and the ladder stays a measured candidate.
  - **Backfill `createdFromCommit` once by migration, then remove the policy.**
    - Pros: every environment converges on the commit baseline.
    - Cons: a migration that guesses a baseline for old records could change their diffs.

**Outcome (2026-11-01).** Rechecked on `93b99bfba`: the references above
hold (`establishCreatedFromCommit` is now at `:88`). A start whose capture fails cannot leave a running
environment without `createdFromCommit`: `prepareEnvironmentForSetup`
(`commands-environment.ts`) throws and the start fails. So the routine
policy's only population is a containerized record whose setup completed
before the field existed (`ensureCreatedFromCommitBeforeSetup` skips a record
with `setupScriptsComplete`). All three cases ran live on a disposable Linux
profile; see
[Container fetch policy and app wiring](#container-fetch-policy-and-app-wiring-2026-11-01-linux).
The routine policy stays (decision 11). The run found that a Files-panel
revert fetched the environment's creation commit on every revert; fixed
(decision 13).

### 4. Container app wiring and real-browser QA

**Problem.** The Files panel, coordinator view, validation output and hidden-document reconcile are covered only by deterministic tests. An inactive-environment or two-window regression would show stale data to users.

**Context.** The AGENTS.md inactive-environment cycle applies. 0051 added Files panel `stale`/`degraded` indicators and container `remote` freshness, which need the same real-browser pass.

**Investigation.** No real-stack spec covers these flows today. `mise run test:agent:browser:isolated` and `mise run test:agent:docker` exist and are the natural hosts.

**Decisions.**

- **Where to put the QA?**
  - **A new isolated agent-testing spec run by `mise run test:agent:browser:isolated`, with container cases under `mise run test:agent:docker` (recommended).**
    - Pros: repeatable, and covers 0051's indicators in the same pass.
    - Cons: spec-writing cost; the Docker suite is opt-in.
  - **A manual pass recorded here.**
    - Pros: cheap, done once.
    - Cons: no regression guard.

**Outcome (2026-11-01).** The recommended spec exists:
`e2e/agent-testing/container-files-wiring.spec.ts`, picked up by
`mise run test:agent:docker` (its test names start with "Docker fixture"). It
passed against a fresh `--fixture-environments local,container
--no-agent-credentials` profile; see
[Container fetch policy and app wiring](#container-fetch-policy-and-app-wiring-2026-11-01-linux).
Merge from the UI needs a pull request (`merge_environment_pr` and
`merge_pr_local` both require `prUrl` and run `gh pr merge`), and validation
output only appears in Multi Review and build pipelines, whose plans come from
a model turn. The first pass left both open (decision 16). The follow-up
(decisions 20 to 22) checks them in a second spec,
`e2e/agent-testing/container-app-wiring.spec.ts`, without GitHub or a model:
every `gh` call for a container runs inside it, so a stand-in `gh` there
covers the merge; and the validation worker runs real commands from a
hand-written plan that a pipeline record then names. The same spec replaces
the coordinator smoke check with delegations, a repository context change and
their closing, each across a switch, a hidden document, a reload and a second
window. It found that a Build tab the backend selects in a build-only layout
lost the selection to a seeded terminal; fixed (decision 23). See
[Container app wiring, follow-up](#container-app-wiring-follow-up-2026-11-01-linux).

### 6. Live providers

**Problem.** Provider-side observation (idle backoff, background output) is unproved for several providers.

**Context.** This file defers it entirely to 0049 (retired 2026-11-11; `git show 498b68766:docs/todo/transcripts-and-observation/0049-native-agent-idle-observation.md`, summarised in [agent-testing.md](../../development/agent-testing.md)).

**Investigation.** `NATIVE_QUIET_BACKOFF_TRIAL_MS` is still `[3_000, 5_000, 10_000, 15_000]` at `apps/web/src/lib/native-session-read-policy.ts:24`; 0049 owns its evidence.

**Decisions.**

- **Keep this bullet?**
  - **Keep it as a pointer and do not duplicate the work (recommended).**
    - Pros: one owner for provider evidence.
    - Cons: task 13 cannot close until 0049 also has enough evidence.
  - **Drop it from this file.**
    - Pros: shorter list.
    - Cons: hides a real dependency of the rollback removal.

### 7. macOS watcher paths

**Problem.** The recursive watcher's overflow and polling fallback have not run on macOS, and a packaged app has not been checked. A silent watcher failure would leave a local diff badge stale until the next poll.

**Context.** Under `dev:test` a save was detected at p50 516 to 649 ms. Batched in 0031 under macOS and the Electron window.

**Investigation.** `apps/backend/src/core/worktree-watcher.ts:150` still calls `watch(target, { recursive, persistent: false }, ...)` and degrades when recursion is unavailable (`:19`). The injectable `watch` (`:73`) allows a deterministic failure test; the live gap is the real FSEvents behaviour.

**Decisions.**

- **How to prove burst overflow and the fallback?**
  - **A live burst (thousands of files written by script) on macOS, plus a packaged-app smoke run (recommended).**
    - Pros: exercises real FSEvents coalescing.
    - Cons: needs a macOS host and a packaged build.
  - **Rely on the injected-watcher unit tests.**
    - Pros: free.
    - Cons: does not show how real FSEvents behaves.

**Outcome (2026-11-06).** Rechecked on `c1724ab74`: the references above
hold (the injectable `watch` now sits behind `watch-host.ts`, the helper
process that holds a macOS backend's directory watches). The recommended
option was taken, at three levels:

- `scripts/worktree-watcher-live.ts` drives the backend's own
  `startWorktreeWatcher` against real FSEvents in a temporary repository:
  single saves, bursts of 1,000 to 50,000 files, a commit of all of them,
  the helper killed, the root removed and recreated, a missing root.
- The burst and helper-loss cases of `change-to-visible-latency.spec.ts` on a
  `dev:test` profile, measured at the browser's badge.
- `watcher-packaged-electron.spec.ts`, run by
  `mise run test:agent:electron:packaged` on a `package:mac:unpacked:test`
  build: the packaged app's bundled Bun spawns the helper, a save reaches the
  badge, a 20,000-file burst converges, and a killed helper falls back to
  polling and is replaced.

Every burst ended with a hint after its last write, the badge always returned
to its exact count, and every helper loss fell back to polling within 50 to
325 ms and re-attached on the 30 s retry. See [macOS evidence](#macos-watcher-change-to-visible-and-remote-freshness-2026-11-06-macos). The run corrected two
assumptions of the probes rather than the product (decisions M1 and M2).

### 8. iOS hidden pause and resume

**Problem.** The read coordinator's hidden pause and resume are unproved on iOS, where backgrounding and screen lock suspend the web view more aggressively than desktop browsers.

**Context.** Needs the `apps/ios` wrapper (present: `apps/ios/OrkestratorMobile`) and macOS with Xcode; batched in 0031.

**Investigation.** Nothing new since `00a0cb82`.

**Decisions.**

- **Simulator or device?**
  - **A real device first (recommended).**
    - Pros: real suspension and screen-lock semantics.
    - Cons: needs a provisioned device and tailnet access.
  - **The simulator.**
    - Pros: scriptable and easy to repeat.
    - Cons: lifecycle differs from a device, so a pass proves less.

**Scope (2026-11-10).** This task is now the simulator run: background the
wrapper and lock the simulated device while a `dev:test` profile changes
state, then check reads pause while hidden and resume with exact state. The
real-device run, which the recommended option puts first, needs a provisioned
device and moved to the
[manual-test checklist](../manual-test/7568-manual-test-checklist.md).

**Outcome (2026-11-06, not done).** Not run: it needs macOS with Xcode and a
device or simulator, and this run was on Linux. The busy profile's hidden
client (one client, `visibilityState` emulated) resumed in p95 123 ms, which
says nothing about iOS suspension.

**Outcome (2026-11-11, not done).** Not run: the host was Linux again
(beelink2), with no Xcode or simulator.

**Outcome (2026-11-13, moved to 7568).** The host was macOS (arktech-mini,
macOS 27.2) with Xcode 27.2 and its iOS 27.2 simulator SDK, but
`xcrun simctl list runtimes` listed no simulator runtime and
`xcrun simctl list devices available` no device. Installing one
(`xcodebuild -downloadPlatform iOS -architectureVariant arm64`, several
gigabytes) changes the Xcode install of a host shared with other builds,
which this build did not do. The wrapper also accepts only an HTTPS origin
and a gateway token typed into the app (`apps/ios/README.md`), so the run
needs a profile published through Tailscale Serve. The simulator run is a
[manual-test checklist](../manual-test/7568-manual-test-checklist.md) item
beside the device run (decision Q1); nothing agent-buildable is left in this
task.

### 10. Long soak and cache gauges

**Problem.** A 10-cycle soak left no leaked footprint, but a slow leak or an RSS that never plateaus would only show over a long run with sessions open. Worktree snapshot and row caches have no gauge.

**Context.** Owed: at least 50 cycles over an hour or more, with agent sessions open. The 2026-10-25 run's final `dev:stop` exited non-zero and left a container.

**Investigation.** The footprint (`soakFootprint`, `scripts/recurring-live-ab-summary.ts:244`) covers schedulers, pools, fetch and signal records, jobs, streams and terminals, not caches. `apps/backend/src/core/recurring-work-metrics.ts` counts `cacheHits`/`cacheMisses` (`:85`) but no cache size. The `dev:stop` failure is already handled: since #1271 the cleanup re-reads status and still resets a profile that reports `stopped` with no live launcher (`scripts/recurring-live-ab.ts:736`). The "needs its own todo against `dev:stop`" note can close unless the failure recurs.

**Decisions.**

- **Add cache-size gauges before the long soak?**
  - **Yes: expose entry counts for the worktree snapshot and row caches in recurring diagnostics, then soak (recommended).**
    - Pros: the soak can detect cache leaks; content-free counts.
    - Cons: a small code change before a qualification run.
  - **Soak now and use RSS plateau as the cache proxy.**
    - Pros: no code change.
    - Cons: the file already says RSS is not a leak gauge under Bun.
- **Agent sessions in the soak?**
  - **One credentialed Claude session per environment kind (recommended).**
    - Pros: covers observation timers and subscriptions.
    - Cons: real provider cost over an hour.
  - **Credential-free only.**
    - Pros: free and repeatable.
    - Cons: misses the provider observation footprint.

**Outcome (2026-11-06).** Rechecked on `281de1a17`: the references above
hold. Both recommendations were taken, the second in a changed form: the
sessions are real Pi sessions on a fake model rather than credentialed
Claude ones (decision 25), because this run must make no billed provider
turn. Recurring diagnostics gained a `caches` block (decision 24): the
storage row cache, the worktree snapshot caches, the local scan cache, the
native projection's per-session maps and change tracking's fences. The soak
samples them after every cycle and reports what is still rising. A 60-cycle
local soak on the build before the fix found the native projection keeping
every deleted environment's session views (fixed, decision 26), and a
60-cycle soak over more than an hour on the fixed build kept those gauges
flat; see [Long soak](#long-soak-2026-11-06-linux). Containers could not be
soaked on this host (decision 27). The `dev:stop` failure recurred and is
fixed in the driver (decision 28), so the note about a `dev:stop` todo is
closed.

### 11. Multi-client, restarts and an older backend

**Problem.** Two clients with one disconnected, restarts at durable transition boundaries and a mixed-version backend are unproved, so a restart mid-dispatch could duplicate or lose a turn.

**Context.** Overlaps 0051's outage workload (backend restart) and the invariants in AGENTS.md (replay, cursors, dispatch journals).

**Investigation.** No live harness for restarts at chosen boundaries exists. 0051 notes the browser harness's gateway token lapses on a backend restart, so a durable-token or bearer client is needed.

**Decisions.**

- **How to hit durable transition boundaries?**
  - **Restart through `dev:stop`/`dev:test` at points chosen from diagnostics (a dispatch journaled, a result accepted), using a bearer CLI client (recommended).**
    - Pros: no test-only backend hooks.
    - Cons: timing is approximate; several attempts are needed per boundary.
  - **Add a test-only crash hook at each boundary.**
    - Pros: exact boundaries.
    - Cons: new backend surface that must never ship enabled.

**Outcome (2026-11-06).** Done on Linux without a billed turn or a backend
hook: the recommended option with a fake model as the boundary control. The
profile's real Claude CLI talks to a loopback Anthropic endpoint
(`e2e/agent-testing/fake-anthropic-model.ts`) that parks any prompt marked
`[hold:<id>]`, so "a dispatch journaled, the provider working" is held for as
long as a restart takes, and every call is counted.
`e2e/agent-testing/multi-client-restarts-live.spec.ts` drives two headless
clients through a disconnect, a queued prompt, a backend crash and a graceful
restart with a turn held and a prompt queued, a bridge `SIGKILL` mid-turn and
idle, and today's renderer against v2.21.0, the oldest supported release in
the register. Results are in
[Multi-client, restarts and an older backend](#multi-client-restarts-and-an-older-backend-2026-11-06-linux).
Two defects were fixed (decisions T11.1 and T11.2). The bearer-client concern
above did not arise: each client signs in again with a fresh `dev:login` link
after a restart. Follow-ups needing a decision were in 7120 (retired
2026-11-13), all done.

### 12. Measured candidates

**Problem.** Twelve cadence and limit changes might save cost but must not change without evidence.

**Context.** The idle A/B decides none. The feature-planning keyed row read was decided from the harness (decision 4).

**Investigation.** All still present at the values listed: `pr-check-rollup` 60 s (`packages/protocol/src/recurring-work.ts:191`), `mail-retention` 60 s (`:297`), admission limits (`apps/backend/src/core/work-admission.ts:85`; no re-prioritisation in `WorkAdmissionPool`, `:185`), `DOCKER_AVAILABILITY_POLL_INTERVAL_MS` (`apps/web/src/App.tsx:111`), `DESIGN_CANVAS_CURSOR_CHECK_MS` (`apps/web/src/components/design/design-controller.ts:38`), B19 (`tmux-interactive.ts`) and B20 (`review-validation-worker.ts`). The feature-planning item is done: `getFeaturePlan` reads one row (`apps/backend/src/core/storage-kanban.ts:684`) and warm reads come from the row cache (`apps/backend/src/core/storage-database.ts:500`). B18 (decision 3) has moved on in 0020: `claude-state-signal` images now poll twice a minute when idle ([recurring-work.md](../../architecture/recurring-work.md), row B18), so the "59.9 of 63.9 `docker exec`" figure holds only for older images.

**Decisions.**

- **Which order to decide them in?**
  - **By measured cost once the busy profile reports, largest first (recommended).**
    - Pros: effort goes where the cost is.
    - Cons: nothing moves until task 1 runs.
  - **Decide the client-only ones (Docker availability, display clock, design canvas) from browser profiling now.**
    - Pros: they need no credentials.
    - Cons: probably small savings; the design canvas item also waits on missed-final-hint qualification.
- **What to do with the container fetch failure ladder?**
  - **Close it together with task 3's decision (recommended).**
    - Pros: no tuning of a path that may be removed.
    - Cons: none if the routine policy goes.
  - **Tune it from `git-fetch-container` metrics.**
    - Pros: as written.
    - Cons: new containers produce no such metrics.

**Outcome (2026-11-06).** Re-scoped by what each candidate needs, now that
the busy profile has run (decision B7):

- Decided from the busy profile, all kept unchanged: the admission pool
  limits (over 18 rounds `git-docker-scan` reached its 4-lease limit with at
  most 3 waiting and an oldest wait of 86 ms, `workflow-provider` and
  `external-pr` never queued, nothing was refused); raising a queued
  discovery scan's priority (no wait long enough to matter); and the
  `mail-retention` deadline (0.8 to 1 start a minute, one read and one stat
  each, with nine mails a run).
- Waiting for task 5: the settled check-rollup backoff and the
  container-scoped PR cooldown.
- Never blocked on task 1, now their own runs: Docker availability sharing,
  the design canvas cursor check (after missed-final-hint recovery), the
  shared display clock (browser profiling), the validation reader's spawn per
  poll, B19 and B20 (the busy profile ran nine validation runs a run, 1.1 s
  each, but measured neither the reader nor crash recovery).

**Outcome (2026-11-11, Linux).** Rechecked on `498b68766`: every value above
still holds (`DOCKER_AVAILABILITY_POLL_INTERVAL_MS` is at `App.tsx:99`,
`DESIGN_CANVAS_CURSOR_CHECK_MS` at `design-controller.ts:46`). The six
candidates that never needed task 1 were measured on this host, each at the
cost it actually pays; numbers in
[Client-only and validation candidates](#client-only-and-validation-candidates-2026-11-11-linux):

- Docker availability sharing (C09): one probe is a `docker info`, about
  60 ms of CPU, once a minute per visible client. Kept (decision C1).
- The design canvas cursor check (C12): an unchanged check costs the design
  service under 0.1 ms. Kept at 3 s; missed-final-hint recovery is still
  qualified only by its unit test, which a longer interval would need first
  (decision C2).
- A shared display clock: a real browser saves at most a few milliseconds of
  main-thread time a second even with 200 clocks. Kept as is (decision C3).
- The validation reader's `bun` spawn per poll (C06): about 10 ms a poll
  locally, plus a `docker exec` in a container, only while a person has the
  output open on a running result. Kept (decision C4).
- B19: an attached terminal's capture is about 2 ms locally but one
  `docker exec` (about 50 ms wall, 60 to 70 ms CPU) in a container. Demand
  gating is needed for terminals nobody detached, not for attached views: a
  reload or a closed window leaves the loop running until the environment's
  tmux cleanup. Moved to to-do 7745 (decision C5; retired 2026-11-11: the
  client lease, row B19 of [recurring-work.md](../../architecture/recurring-work.md)).
- B20: the 500 ms tick costs under 0.1 ms; splitting the liveness write would
  save about half of that. Kept (decision C6).

Left here: the two PR candidates, which wait for task 5 (now 7568: 0048
task 5).

### 13. Remove the rollback drivers

**Problem.** Every keyed domain keeps a second whole-store driver, and Multi Review keeps `WorkflowDueScheduler`. That doubles upkeep and test surface.

**Context.** Decision 1 is to wait for the busy live profile. `stableJitterMs` has already moved, so deleting `multi-review-scheduler.ts` is self-contained.

**Investigation.** Unchanged. `KEYED_SCHEDULING_ROLLBACK_ENV` and `keyedSchedulingEnabled` are at `apps/backend/src/core/workflow-supervisor.ts:77` and `:79`, with six call sites (task 1). `WorkflowDueScheduler` is at `apps/backend/src/core/multi-review-scheduler.ts:52`, and `stableJitterMs` at `multi-review-scheduling.ts:157`. The desktop allowlist entries are at `apps/desktop/electron/backend-process.ts:71` to `:73`, and observation sharing is read at `apps/backend/src/core/index.ts:699`. The catalogue still describes the adaptive scheduler as Multi Review's rollback (`packages/protocol/src/recurring-work.ts:363`).

**Decisions.**

- **All at once or domain by domain?**
  - **Domain by domain, lowest risk first (backend activity, native queues, then the workflows, Multi Review last) (recommended).**
    - Pros: each removal is small; a regression points at one domain.
    - Cons: several PRs, and the switch stays until the last.
  - **One removal PR once the evidence is complete.**
    - Pros: one review, and the switch is gone at once.
    - Cons: a large diff; a regression has no remaining rollback.
- **What evidence is enough?**
  - **The busy profile, live GitHub and the long soak, as decision 1 says (recommended).**
    - Pros: covers exactly the obligations the keyed drivers keep.
    - Cons: depends on credentialed runs not yet scheduled.
  - **Production use since #852 plus the idle evidence.**
    - Pros: removal can start now.
    - Cons: decision 1 already rejected it; busy obligations stay unproved.

**Outcome (2026-11-06).** Rechecked on `ee2cc8423`: `KEYED_SCHEDULING_ROLLBACK_ENV`
and `keyedSchedulingEnabled` are at `workflow-supervisor.ts:79` and `:81`,
with seven call sites (task 1, `graph-run` added; its "rollback" only turns
graph runs off). `WorkflowDueScheduler` is at `multi-review-scheduler.ts:55`,
the desktop allowlist entries at `backend-process.ts:144` to `:146`, and
observation sharing is read at `index.ts:1002`. Re-scoped (decision B8): the
`backend-activity`, `native-queues` and `multi-review` domains now have
decision 1's evidence (the busy profile and the long soak; none of them owns
a PR obligation) and can be removed domain by domain in that order, Multi
Review with `WorkflowDueScheduler`. Not done here: this change only
qualifies. `feature-planning` (Codex only) and `build-pipeline` (PR terminal
effects) wait for task 5 and 0049, and `ORKESTRATOR_NATIVE_OBSERVATION_SHARING`
for 0049.

**Outcome (2026-11-10).** Rechecked on `04639b12b`: the task list said
"depends on 5" while this outcome and the index said the first two domains
were unblocked. They were: neither driver owns work that live GitHub would
qualify differently (decision W1). Both are removed (decision W2):

- `backend-activity`: the 2 s bundle and 60 s tab timer that
  `ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK=backend-activity` selected are gone
  from `index.ts`; the named due jobs (`backend-activity-jobs.ts`) are the
  only driver. The `keyedActivityJobs` option is gone.
- `native-queues`: the reconciler's `startTimer` rollback interval is gone;
  `NativeAgentService.initialize` always starts the keyed launch/queue
  scheduler. The `keyedQueueScheduling` option is gone.
- The switch can no longer name either domain
  (`REVERTIBLE_KEYED_SCHEDULING_DOMAINS`, `workflow-supervisor.ts`); a value
  that still names one, or `all`, leaves them keyed. Both stay in
  `KEYED_SCHEDULING_DOMAINS`, which also labels the supervisors.
- Tests that drove the rollback drivers now drive the keyed ones on a manual
  clock (`index.test.ts`: tab-resource coalescing, periodic activity and
  shutdown, a rejected sweep, repeated init, fault wiring;
  `native-agent-service-dispatch.test.ts`: launch scans and the cadence
  floor), and `workflow-supervisor.test.ts` pins the revertible list.
- `recurring-work.md`, `native-agent-service.md`, `testing-guide.md` and the
  `recurring-live-ab.ts` header describe the change. The catalogue
  (`RECURRING_JOB_CATALOGUE`) named no rollback for either domain, so it is
  unchanged.

Not done here: `multi-review` with `WorkflowDueScheduler`, `feature-planning`,
`build-pipeline` and observation sharing. The desktop allowlist entry stays
because the switch still serves the other domains. For `multi-review`, task
2's two busy runs on 2026-11-10 are the fresh keyed timing the review repair
asked for: twelve reviews reached `ready` with every obligation kept, and
progress after a result was within budget except a 3.7 to 4.1 s tail on one
review in four (7557, fixed and retired 2026-11-10, [after the fix](#workflow-progress-after-the-7557-fix-2026-11-10-linux)). The runs had no
rollback arm, so they do not compare the two drivers; removing it is the
next domain in decision B8's order, in its own change.

**Outcome (2026-11-10, later).** Rechecked on `c98b20e6f`. The `multi-review`
rollback driver is removed (decision W6):

- `WorkflowDueScheduler` (`multi-review-scheduler.ts`) and its test are
  deleted. `MultiReviewService` always starts its keyed supervisor when
  `autoAdvance` is on; the due scheduler's own lease-renewal timer, its
  metered pass and discovery wrappers (`runScheduled`,
  `discoverSupervisedWorkflows`, `renewLeases`) and the 15 s reconciliation
  default are gone. Lease renewal is only the supervisor's critical job.
- `MultiReviewServiceOptions` no longer accepts `keyedScheduling`
  (`Omit<KeyedWorkflowServiceOptions, "keyedScheduling">`), so a caller that
  still asks for the old driver fails the typecheck. `reconcileIntervalMs`
  stays as the keyed safety discovery's fallback period.
- `REVERTIBLE_KEYED_SCHEDULING_DOMAINS` drops `multi-review`; a value naming
  it, or `all`, leaves Multi Review keyed. The efficiency vocabulary drops
  `scheduler.pass`, which only the due scheduler recorded.
- Tests: the three Multi Review tests that ran under both drivers (interactive
  Address Findings settlement, background auto-PR, a running review kept
  scheduled to `ready`) run on the keyed driver only; a new test checks that
  `ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK=multi-review` or `all` still runs a
  review to `ready` on the keyed supervisor; the due scheduler's lease-renewal
  test is replaced by one that drives the keyed critical job on a manual clock
  (one renewal per interval, none overlapping a slow one, one job after a
  repeated `init`, none after shutdown); `workflow-supervisor.test.ts` pins the
  smaller revertible list.
- The recurring baseline harness keeps a rollback mode for feature planning
  and build pipelines only, and `recurring-baseline.test.ts` checks Multi
  Review's keyed counts on their own.
- The catalogue comment (`RECURRING_JOB_CATALOGUE`, B16), `recurring-work.md`,
  `testing-guide.md`, the `recurring-live-ab.ts` header and 0027's
  current state describe the change.

Not done here: the `feature-planning` and `build-pipeline` rollback drivers,
and with them the switch and its desktop allowlist entry, still wait for
task 5 (decision W7); observation sharing waits for 0049.

**Outcome (2026-11-13).** Rechecked on `17d28238c`. 0049, the wait for
observation sharing, was retired on 2026-11-11, so
`ORKESTRATOR_NATIVE_OBSERVATION_SHARING` is removed (decision Q3):

- The backend no longer reads it (`index.ts`), and `NativeAgentServiceOptions`
  no longer accepts `observationSharing`, so a stably idle group of a
  qualified provider always backs off and a busy queue always reuses the
  sweep's fresh observation (`native-agent-launch-activity-reconciler.ts`).
  Dispatch and generation fences and the mail freshness gate are unchanged.
- The desktop allowlist (`backend-process.ts`) drops it; its test no longer
  passes it through.
- `recurring-live-ab.ts`'s `rollback` arm sets only
  `ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK=all`; its runner test checks that.
- The recurring baseline's `nativeObservation` block drives one mode,
  `shared` (`recurring-baseline-native.ts`); `recurring-baseline.test.ts`
  checks the shared counts on their own: no status reads, fewer observation
  reads than one per session per sweep, retained group passes, discovery
  within budget and two turn-end edges.
- `recurring-work.md`, `version-compatibility.md`, `testing-guide.md` and
  7570's current state describe the change. The catalogue
  (`RECURRING_JOB_CATALOGUE`) named no switch for sharing, so it is
  unchanged.

Left: the `feature-planning` and `build-pipeline` drivers and the switch,
which wait for task 5's live GitHub run (7568: 0048 task 5, decision W7).

### 14. Metrics switch decision

**Problem.** None left; decided on 2026-10-25.

**Context.** Decision 2: keep `ORKESTRATOR_RECURRING_METRICS` as a diagnostic kill switch.

**Investigation.** The switch is read at `apps/backend/src/core/recurring-work-metrics.ts:209`. The class comment at `:47` called it "the rollback switch", which contradicted decision 2.

**Decisions.**

- **Fix the stale comment?**
  - **Reword it as a diagnostic kill switch in the next change that touches the file (recommended).**
    - Pros: no standalone churn.
    - Cons: the drift stays until then.
  - **Fix it now in its own change.**
    - Pros: immediately consistent.
    - Cons: a one-line PR.

**Outcome (2026-11-06).** The recommended option: task 1's change touched the
recurring-work driver, and the comment now reads "a permanent diagnostic kill
switch for the recorder itself, not a scheduling rollback".

### 15. Provenance comments

**Problem.** Comments citing "recurring-processes step NN" point at deleted plans. They are harmless but misleading.

**Context.** Decision 10: leave them except in touched files.

**Investigation.** 12 files under `apps`, `packages` and `tests` still contain the phrase (decision 10 counted about 60 sites).

**Decisions.**

- **Sweep or leave?**
  - **Leave them, and remove them as files are touched (recommended).**
    - Pros: no cross-area churn.
    - Cons: the drift lingers.
  - **Sweep them in one change after the rollback drivers go.**
    - Pros: clean, and many sit in code that removal deletes anyway.
    - Cons: collides with parallel work.

### 18. Reconnect timing in a real background tab

**Problem.** Headless Chromium keeps a page `visible`, so the 2026-10-31 runs
never measured reconnect timing in a background tab, where the browser
throttles timers.

**Context.** Moved from to-do 0051 (deleted 2026-11-06). The gateway client
retries waiting streams when the document becomes visible
(`retryWaitingStreams` in `web-gateway.ts`). Task 4 covers a hidden document in
other workflows.

**Investigation.** Steps:

1. In a headed browser, open the app on a `dev:test` profile, then put the tab
   in the background.
2. Cause an outage (stop the profile's backend or drop the link) and restore it
   while the tab is hidden.
3. Check the reconnect timing while hidden, and that making the tab visible
   retries the main stream and the terminal fallbacks at once.

**Decisions.**

- **Which browser?**
  - **Headed Chromium through Playwright (recommended).**
    - Pros: scriptable; the same engine as the desktop app.
    - Cons: needs a display.
  - **Safari.**
    - Pros: the strictest throttling.
    - Cons: manual.

**Outcome (2026-11-06, not done).** Not run: this host may run browsers
headless only, and a headless page is never really backgrounded. The busy
profile's one-client rounds emulate a hidden document (decision B5), which
covers the read coordinator's pause and resume but not timer throttling.

**Outcome (2026-11-11, not done).** Not run: the host (beelink2) allows
headless browsers only and no virtual display (Xvfb), so a page can still not
be put in a real background tab. The next run needs a host with a display or a
disposable one.

**Outcome (2026-11-13, done).** Run on macOS (arktech-mini) with headed
Chromium, the recommended option, through a new opt-in spec,
`e2e/agent-testing/background-tab-reconnect-live.spec.ts`. Its results are in
[Background-tab reconnect](#background-tab-reconnect-2026-11-13-macos):
every step held in five passing runs (one with a 330 s outage, past
Chromium's five-minute intensive-throttling threshold), within the budgets
the spec sets. Two
things had kept earlier attempts from seeing a hidden tab at all, and the
spec now avoids both (decision Q2): Playwright's default Chromium switches
turn background throttling off, and Playwright enables DevTools focus
emulation on every page it attaches, which keeps a page `visible` behind
another tab or in a minimised window. Safari, the other option, stays
unmeasured; nothing here needs it.

### 19. Changes-tab remote freshness

**Problem.** 0020 still owed a real-browser check of the remote snapshot state;
retiring 0051 did not supply that result.

**Context.** The Files panel's Changes tab renders `WorktreeSnapshotState.remote`,
including "Base may be behind remote". This is separate from task 17's PR marker.

**Investigation.** On an isolated `dev:test --fixture` profile, prepare an
environment with a known fetched base and advance its disposable remote from a
second fixture checkout. Open Changes, exercise refresh and a safely injected
remote-read failure, and compare the warning/freshness state with the backend
snapshot. Switch away while the backend updates, return, and reload; verify the
same state rehydrates. Restore remote reads, refresh, and confirm the warning
clears after bringing the fixture base current. Record expected/observed states,
commit and viewports without repository contents, then stop/reset the profile.

**Decisions.** Add a dedicated browser check here (recommended): keeps snapshot
freshness separate from PR freshness, but needs fixture Git setup. Treating task
17 as coverage is cheaper but exercises a different state source.

**Outcome (2026-11-06).** Done on macOS with
`e2e/agent-testing/changes-remote-freshness.spec.ts`. A new container
compares against its creation commit: remote `not-required`, no strip, as
expected. The legacy case used a record made the way decision 12 made one.
Its first run found a defect: since the Changes tab is served by the change
projection, its Refresh went to `changes_refresh`, which rescanned without
telling the container fetch policy, so it never fetched the base (the
fetch counter stayed at one fetch per backend start). Fixed (decision M3).
After the fix every step agreed with the backend: a fetch kept it `current`
with no strip; a broken origin made it `stale` (`no-remote`) with "Base may
be behind remote" in 352 ms; a switch away and back and a reload showed the
same state; restoring the origin and refreshing cleared the strip in 702 ms,
and the list then compared against the advanced remote. `unknown` ("Base not
fetched yet") was not reached: the first scan after a start fetches at once.
See [macOS evidence](#macos-watcher-change-to-visible-and-remote-freshness-2026-11-06-macos).

### 20. Other event-stream readers

**Problem.** Retired 0051 said its silent-drop and lock-step reconnect fixes
were applied only to the browser gateway and Electron client; other readers
were not assessed.

**Context.** That scope limit remains unverified. A successful task 16 run
does not establish every stream consumer has a silence watchdog and retry jitter.

**Investigation.** Inventory event-stream readers and reconnect owners outside
those two clients. For each, record its silence detection, bounded backoff and
retry spread, or the evidence that another layer owns those guarantees. Exercise
silent-drop and immediate-error paths in isolated fixtures. Create code-allowed
follow-ups for missing guarantees; close only with a per-reader disposition.

**Decisions.** Inventory before changing readers (recommended): identifies real
gaps without assuming identical transports, but requires tracing ownership.
Applying the same patch everywhere is quicker but may duplicate existing logic.

**Outcome (2026-11-06).** Done. Every long-lived reader outside the browser
gateway and Electron clients was traced and given a disposition; see
[Event-stream reader inventory](#event-stream-reader-inventory-2026-11-06).
Three gaps and one possible gap went to 7200.
Two were fixed with tests in the same change: the desktop connection
manager's reconnect ladder now spreads its retries (7200 task 2), and a v2
preview tunnel session that answers no pings for about 30 s is destroyed
instead of staying selectable (7200 task 3). OpenCode's stream (task 1) needs
a live `opencode serve` to see what it sends while idle, and the terminal
socket (task 4) is a design choice; both stay open there. The silent-drop
and immediate-error paths were exercised in fixtures for the two fixed
readers only (scripted sockets and timers); the others either already have
tests for their watchdogs or are not stream reconnect owners.

### 21. Retired to-do pointers in source comments

**Problem.** Four source comments point to files retired on 2026-11-06, and a fifth to a task number removed when 0241 was rewritten that day.

**Context.** The retirement ticket is docs-only, so the source edits are tracked
here for the next code-allowed change. This records the review's requested
follow-up rather than silently dropping the references.

**Investigation.** Replace these exact pointers, then search source for the
retired paths and run the checks required for the files changed:

1. `e2e/agent-testing/client-outage.spec.ts:35`: deleted
   `0051-client-reconnect-and-freshness.md` →
   `docs/development/agent-testing.md#live-client-outage` and this file's tasks 16–20.
2. `e2e/agent-testing/connection-outage-electron.spec.ts:21`: the same 0051
   replacement.
3. `apps/backend/src/core/preview-verification-window.test.ts:11`: deleted
   `3230-restart-inside-verification-window.md` →
   `docs/todo/previews-and-annotations/0045-preview-service-discovery.md` task 3
   (0045 retired 2026-11-11; the comment now points at
   `docs/architecture/browser-previews.md` and 0042's evidence log).
4. `apps/desktop/electron/native-dialogs.ts:19`: deleted
   `0880-desktop-main-thread-held-by-modal-dialog.md` →
   `docs/todo/cross-cutting/0741-backend-responsiveness-under-load.md` task 7.
5. `scripts/probe-network-sweep.ts:5`: `todo 0241 task 5`, a task removed
   when 0241 was rewritten to hold only its live check →
   `docs/development/disk-usage.md` (the sweep's rules); its live run is
   0241 task 1.

**Decisions.** Record a concrete code-allowed follow-up (recommended): respects
the ticket's boundary and preserves every destination, but the comments stay
stale until that work lands. Editing source now fixes navigation immediately but
breaks the docs-only constraint.

**Outcome (2026-11-06).** Done in this code-allowed change: all five
comments point at the destinations above, and `git grep` over `apps/`,
`bridges/`, `packages/`, `scripts/`, `e2e/` and `tests/` finds no other
reference to `0051-client-reconnect-and-freshness`,
`3230-restart-inside-verification-window`,
`0880-desktop-main-thread-held-by-modal-dialog` or "0241 task 5".

#852 changed how often the app collects and reads facts: shared worktree
snapshots, a container fetch policy, lifecycle-aware PR monitoring, the client
read coordinator, the native observation broker and keyed workflow
supervision. It was qualified on Linux with deterministic call counts and one
credential-free idle A/B run. The instrumentation fixes are done and a
credential-free macOS idle A/B with freshness probes has run. Since then the
long soak (task 10) and, on 2026-11-06, the busy live profile (task 1) have
run. What remains here is the provider runs (0049), an iOS simulator run, a
real background tab, and then the two PR candidates and the rest of the
rollback drivers once live GitHub has run; the client-only and validation
candidates were decided on 2026-11-11. The live GitHub,
iOS device, host suspend and two-machine runs moved to the
[manual-test checklist](../manual-test/7568-manual-test-checklist.md) on
2026-11-10. On 2026-10-25 the feature-planning keyed row read landed (the one
candidate the deterministic harness could decide), keyed row reads began
reusing a warm row cache, `stableJitterMs` moved out of the rollback-only
file, the live A/B script gained a lifecycle soak, flake 0177 was resolved,
and the decisions below were recorded.

## Current state

- Recorder: `recurringWorkMetrics` (`apps/backend/src/core/recurring-work-metrics.ts`)
  labels work only by the kinds in `RECURRING_JOB_CATALOGUE`
  (`packages/protocol/src/recurring-work.ts`), whose `inventory` field carries
  the B, C and L IDs of the inventory in
  [recurring-work.md](../../architecture/recurring-work.md). Only
  backend-recorded work has a kind. The 19 renderer, bridge and desktop kinds
  that nothing recorded were dropped from the vocabulary (with them the stale
  `acp-disconnect-poll` 50 ms and `client-browser-annotation` 150 ms
  entries), and the inventory's C and L rows describe that work by ID.
- Storage accounting follows the rule in "Constraints and rationale" on
  every path. Uncached `StorageDatabase.rows()` queries are `storage-read`s,
  and a workflow-result entry index hit is a `storage-stat`. Every
  `openBackendDatabase` connection reports, not only `StorageService`'s.
  Content fetched from the database charges its serialized length as `bytes`
  (`observeFetch`), so a cache miss shows bytes beside its read and a
  cache-served read shows none. Terminal session buffers and Kanban images
  are blob files: `file-read`s with bytes, not storage reads.
- Keyed row reads (2026-10-25): feature planning's per-record pass reads its
  plan as one row (`getFeaturePlan` uses `loadStoreRow`, `storage-kanban.ts`),
  not the whole feature-plan store. `StorageDatabase.readStoreRow` takes the
  row from the connection's row cache when that cache holds the committed
  revision, so a warm keyed read fetches nothing; a miss fetches the one row
  and leaves the cache alone. Looped and Multi Review row reads gain the same.
- OpenCode SDK clients fetch through `openCodeSdkFetch`
  (`http-bridge-transport.ts`): the provider's default client
  (`createOpenCodeSdkClient`, `opencode-sdk-client.ts`), the host catalogue
  refresh and provider sign-in. Each SDK request, event-stream connects and
  reconnects included, is a `provider-request` like a `bridgeFetch`. The SDK
  and `opencode-sdk-client.ts` were removed with OpenCode 1.x on 2026-11-11;
  OpenCode 2 is reached through Orkestrator's own HTTP client
  (`opencode2/client.ts`), which nothing now passes `openCodeSdkFetch`.
- The activity jobs `coordinator-repair`, `claude-state-reconcile` and
  `pending-rename-reconcile` register as `recovery`, as catalogued (they were
  `maintenance`, `progress` and `progress`). In `BackendActivityJobs` the
  class only orders overdue runs after a host resume: every job has its own
  slot.
- Read through `get_recurring_work_diagnostics` (`commands-registry-system.ts`)
  and the `recurringWork` block of the gateway's `/__orkestrator/metrics`.
- Harness: `apps/backend/scripts/recurring-baseline.ts` with its `-harness`,
  `-native` and `-workflows` modules; flags `--out`, `--compare`,
  `--fail-on-change` and `--overhead`. It drives real owners on a manual clock
  and counts calls; `apps/backend/tests/recurring-baseline.test.ts` keeps it
  deterministic. Method and scenario matrix:
  [testing-guide.md](../../development/testing-guide.md#recurring-work-harness);
  latency budgets:
  [recurring-work.md](../../architecture/recurring-work.md#latency-budgets).
  No reference artifact is committed; generate one before any comparison.
  The workflows block drives feature planning, build pipelines and multi
  review on the keyed drivers, and the first two also on their rollback
  drivers (Multi Review's rollback, `WorkflowDueScheduler`, was removed on
  2026-11-10). It reports `storageReads`
  beside `storageStats` and `storageBytes` (what those reads fetched from
  SQLite, since 2026-10-25), and the test holds each attempt to a per-domain
  storage budget (`STORAGE_PER_ATTEMPT`). The harness now closes each
  temporary `StorageService` before deleting its directory. Before that fix a
  run logged `Hourly database snapshot failed: disk I/O error` and its process
  stayed alive for minutes after the work finished.
- Live idle A/B: `scripts/recurring-live-ab.ts`, documented in
  [testing-guide.md](../../development/testing-guide.md#live-idle-ab). Since
  2026-10-25 `--soak-cycles N --soak-environments local,container` adds a
  lifecycle soak: each cycle creates, starts to `ready`, stops, restarts and
  deletes one environment per kind through the CLI. It compares a
  content-free footprint (scheduler keys per owner and kind, admission
  leases, fetch and signal records, running jobs, event-stream and terminal
  subscribers) before and after, counts guard lines, and exits 1 on a failed
  step, a leaked gauge or a guard line (`soakFootprint`, `soakLeaks` in
  `recurring-live-ab-summary.ts`).
- Cache gauges (2026-11-06): the `caches` block of recurring diagnostics
  (`addCacheSource`, `recurring-diagnostics.ts`; table in
  [recurring-work.md](../../architecture/recurring-work.md)) counts the
  caches the footprint cannot see: each open connection's row cache, the
  diff-stats tracker's tree lineages, bodies, ad hoc reads and
  per-environment maps, the local scan cache, every per-session map of the
  native projection, and change tracking's owners and deletion fences. The
  soak reads them after every cycle (`soakCacheGauges`) and lists gauges
  still rising (`gaugeTrends`). `--soak-sessions N` keeps real Pi sessions
  open on a loopback fake model (`recurring-live-ab-fake-model.ts`),
  `--soak-cycle-gap-ms` spaces cycles out, and `--agent-platforms` narrows
  the profile's toolchains.
- Environment deletion releases the native projection's caches for that
  environment's sessions (`forgetEnvironmentProjections`, 2026-11-06).
- Busy profile (2026-11-06): `--busy-rounds N` adds the busy phase
  (`recurring-live-ab-busy.ts`, clients in `recurring-live-ab-busy-clients.ts`,
  documented in [testing-guide.md](../../development/testing-guide.md#live-idle-ab)).
  The fake model (`recurring-live-ab-fake-model.ts`) also holds a prompt
  marked `[hold:<id>]` until released, answers `[tool:<id>]` with a `bash`
  call, and completes Multi Review slots with fixed, finding-free results.
- Rollback switches, each read once at startup and let through the desktop
  environment allowlist in `apps/desktop/electron/backend-process.ts`:
  - `ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK` (`KEYED_SCHEDULING_ROLLBACK_ENV`,
    `workflow-supervisor.ts`): a comma list of `feature-planning`,
    `build-pipeline`, `graph-run`, or `all`. A named domain runs its old
    whole-store driver instead of the keyed one (`graph-run` is turned off).
    `multi-review`, `native-queues` and `backend-activity` are no longer
    revertible (2026-11-10, task 13).
  - `ORKESTRATOR_NATIVE_OBSERVATION_SHARING=0` was removed on 2026-11-13
    (task 13, decision Q3); observation sharing has no switch.
  - `ORKESTRATOR_RECURRING_METRICS=0` turns the recorder off.
- Multi review's own rollback gates (`adaptiveScheduling: false`, the legacy
  1 s tick, and `evidencePermits`) were removed on 2026-10-25 by
  [0027-multi-review-scale-and-cost.md](../coordinator-and-multi-review/0027-multi-review-scale-and-cost.md).
  The `multi-review` domain of the switch above and its
  `WorkflowDueScheduler` were removed on 2026-11-10 (task 13, decision W6).
- Trial constants: `DEFAULT_PR_MONITOR_POLICY` (terminal discovery 5 min plus
  30 s jitter), `CONTAINER_FETCH_COOLDOWN_MS` (5 min) and
  `CONTAINER_FETCH_FAILURE_COOLDOWN_MAX_MS` (30 min),
  `DEFAULT_ADMISSION_POOL_LIMITS` (`git-docker-scan` 4 total and 1 per target,
  `external-pr` 2 and 1, `workflow-provider` 8 and 2),
  `DEFAULT_WORKFLOW_DISCOVERY_MS` (30 s) and `NATIVE_QUIET_BACKOFF_TRIAL_MS`.
- `HostSuspendDetector` re-times every live scheduler after a host sleep so
  overdue keys run once.
- `stableJitterMs` lives in `multi-review-scheduling.ts` (moved 2026-10-25),
  which is why removing `multi-review-scheduler.ts` on 2026-11-10 did not
  touch the keyed path.
- Container fetch reach (found 2026-10-25): every new container records its
  creation commit before setup (`establishCreatedFromCommit`,
  `commands-local-server-lifecycle.ts`), and `resolveComparisonRef`
  (`packages/protocol/src/diff-stats.ts`) prefers that commit. A container's
  diff baseline is therefore a full commit SHA, which the status script
  classifies as `commit` and the policy never fetches. The routine fetch
  policy reaches only environments with no `createdFromCommit`: records whose
  setup completed before the field existed. (A start whose capture fails does
  not count: the start fails.) Missing-baseline recovery and explicit
  refreshes still fetch. Since 2026-11-01 a Files-panel revert no longer
  fetches a ref the latest scan of that clone classified as `commit`
  (`refreshForAction`); before, every revert on a new container ran
  `git fetch origin <creation commit>`.

### Harness effect (2026-10-25)

`--compare` against an artifact generated from the same tree before the
storage changes (with the new `storageBytes` field, so only real changes
show) moved five counters, all bytes; every count, read and stat is
unchanged. Default fixture (200 completed, 2 active, 10 min), rollback/keyed
`storageBytes`:

| Domain | Before | After |
| --- | --- | --- |
| Feature planning | 0 / 0 | 0 / 0 |
| Build pipelines | 25,844 / 25,844 | 25,844 / 19,383 |
| Looped review | 14,134,620 / 14,157,570 | 3,128,420 / 3,665,450 |
| Multi review | 7,723,120 / 8,532,320 | 1,435,470 / 1,630,630 |

Feature planning fetched nothing before or after because its row cache is
warm, but a cached whole-store read still parsed every plan. A direct
benchmark over 202 small plans with a warm cache measured `getFeaturePlan`
at 3.9 to 4.3 µs per pass against 80.0 to 81.9 µs for the whole-store read and
find it replaced (three runs of 2,000 passes each), so a pass now costs one
row. Looped and Multi Review row reads now come from the warm cache instead
of a SQLite query, a 4 to 5 times drop in bytes fetched.

### Harness effect (2026-10-22)

`--compare` against an artifact generated at `b83ae534` moved only the
workflows block. Build-pipeline storage reads rose from 8 to 24 in rollback
and from 12 to 24 keyed: the startup sweep's transcript-manifest row
listings, now charged. The new multi-review domain read as follows at
the default fixture (200 completed, 2 active, 10 min): rollback 600 ticks,
11,400 storage reads and 2,400 provider reads; keyed 361 attempts, 3,421
reads and 680 provider reads. A keyed pass reads its record ten times
(one-row reads and `validateMultiReviewController` fence checks); a
whole-store tick reads 19 times with two active workflows. Every scenario
counter is unchanged. The base artifact itself read keyed build pipelines as
18/829, not 12/827, during a run slowed to 16 minutes by heavy disk
contention and the unclosed-storage linger. Two direct runs at the base
commit gave 12/827, so that domain's full-matrix counts are not reliable
under load. The full matrix now takes about 30 s.

### Live evidence (2026-10-22, macOS)

Host: macOS (Darwin 25.6.0, arm64), Docker Desktop 29.7.2, Bun 1.4.3, a
`dev:test` build of this branch. `scripts/recurring-live-ab.ts` ran three
repeats of three arms (candidate, rollback, metrics off). Each run was a fresh
fixture profile with one local and one container environment and no agent
credentials, settled for 60 s and was sampled every 30 s over a 6-minute
window. No browser client was attached, so the Electron window was the only
client; its title-bar meter is the `system-usage-sample` row. Starts per minute,
mean of three repeats (every repeat within ±0.1):

| Job | Rollback | Candidate |
| --- | --- | --- |
| Feature planning tick | 59.9 | 2.0 |
| Looped review tick | 59.9 | 2.0 |
| Build pipeline tick | 39.9 | 2.0 |
| Multi review tick | 4.0 | 2.0 |
| Native launch scan | 30.0 | 2.0 |
| Native queue scan | 30.0 | 2.0 |
| Pending rename reconcile | 30.0 | 2.0 |
| Native activity sweep, mail presence and injection, Claude state, tmux drain | 30.0 each | 30.0 each |
| Claude terminal-state poll (1 container) | 59.9 | 59.9 |
| Diff scans (1 local watched, 1 container) | 4.5 | 4.5 |
| Container git fetch | 0 | 0 |

- Work units per minute: candidate 76.8 storage reads and 96.0 stats,
  rollback 132.7 and 133.9. `docker exec` was 63.9 in both arms, 59.9 of it
  the container's terminal-state poll (B18), and Git spawns were 4.0. The
  fixture stores are empty, so the saving is wakeups and launch and rename
  scans, not workflow history. The ratios match the Linux run of #852.
- Process cost per repeat, backend process only. CPU in ms per minute:
  candidate 245, 250 and 262; rollback 248, 277 and 250; metrics off 253,
  245 and 292. RSS median: 163 to 263 MiB in every arm, with no trend by arm.
  The Electron process tree used 645 to 730 ms/min (repeats 2 and 3; repeat 1
  sampled only the launcher wrapper). At this idle load neither the keyed
  drivers' saving nor the recorder's cost shows above the run-to-run spread.
- Freshness, measured backend-side from the write to the `diff-scan`
  `changed` counter moving. This is a lower bound on change-to-visible.
  - Watched local worktree (recursive `fs.watch` on macOS): p50 516 ms and
    p95 739 ms over 15 probes per arm, the same in both arms. A later run with
    randomised probe offsets gave p50 649 ms and p95 872 ms over 12. Budget:
    2 s or less.
  - Container: 12 probes at random offsets in the 15 s poll gave p50 6.5 s,
    p95 13.4 s and a maximum of 13.4 s, including the `environment exec`
    write's round trip. Budget: 20 s or less. The 45 probes in the A/B runs
    used a fixed gap that phase-locked them to the poll (all 11.9 to 12.1 s),
    so only their maximum is meaningful.
- Zero `Unhandled promise rejection (continuing)` guard lines in each of the
  ten profiles' logs (the nine A/B runs and the freshness rerun), every one
  started, stopped and reset by the script.
- No container fetch ran. The fixture's environments use immutable commit
  baselines (`base.branch: null`), which never fetch, and the
  `container-git-fetch` policy held no records. The fetch policy and its
  failure ladder are therefore still unqualified live.

### Live soak (2026-10-25, macOS)

Host: macOS 27.0 arm64, Docker Desktop 29.9.2, Bun 1.4.4, a `dev:test` build
of this branch on a shared host (load average 12 to 15 from other work).
Command:

```bash
mise exec -- bun scripts/recurring-live-ab.ts --arms candidate --repeats 1 \
  --settle-ms 60000 --window-ms 60000 --sample-ms 30000 --freshness-probes 0 \
  --soak-cycles 10 --soak-environments local,container --profile-prefix rw-soak \
  --out output/benchmarks/recurring-soak-2026-10-25.json
```

- The profile was ready after 46 s with the fixture's local and container
  environments. Ten cycles each created, started to `ready`, stopped,
  restarted and deleted one local and one container environment: 20
  environments, 100 CLI steps, 310 s. No step failed.
- Every footprint gauge returned to its baseline exactly: 8 schedulers and
  3 admission pools registered; scheduler keys 2 (agent observation), 11
  (maintenance) and 6 (workflows) with none settling; no admission lease
  active or waiting; container fetch 0 records and 1 container, signal
  sources 1 container each (the fixture's); no recorded job running; one
  event stream (the Electron window) and no terminal sockets. `soakLeaks`
  reported none.
- Zero `Unhandled promise rejection (continuing)` guard lines in the profile's
  four logs.
- Backend RSS was 175 MiB before the cycles and 238 MiB after the settle, one
  reading each. RSS is not a leak gauge here (Bun's heap grows and does not
  return memory promptly); a long soak has to show whether it plateaus.
- The script's final `dev:stop` exited non-zero although the profile had
  stopped (`dev:status`: `stopped`, nothing live), so it skipped the reset
  and left the fixture container running. `dev:reset` run by hand then
  removed one exact-owner container, two volumes and one network. The soak
  numbers are unaffected. If it recurs it needs its own todo against
  `dev:stop`.

### Container fetch policy and app wiring (2026-11-01, Linux)

Host: Linux (Arch, kernel 7.1), native Docker, Bun 1.4.4, a `dev:test` build
of this branch on a host shared with other builds, so no timing here is a
reference figure. Profile `q48`, started with `mise run dev:test --profile q48
--fixture --fixture-environments local,container --no-agent-credentials
--agent-platforms codex`. No provider turn ran. Electron ran headless (see
[2181](../cross-cutting/2181-dev-test-electron-opens-on-the-linux-desktop.md)).
Fetch counts come from `get_recurring_work_diagnostics`
(`fetchPolicies[0].status` and `metrics.kinds["git-fetch-container"]`). The
fixture's origin is a bare repository on the host, bind-mounted into the
container, so every fetch was a real `git fetch`.

- **New containers never fetch.** With both fixture containers polled by the
  diff badges, the policy held 0 records and 2 containers: the creation
  commit is classified `commit`.
- **Missing-baseline recovery.** A branch `qa-recover` pushed to origin after
  the container was created, then `get_git_status` with that target: one
  fetch inside the scan (`started` +1, `completed` +1), the baseline resolved,
  and the rescan's consultation was a cache hit. The panel listed the
  branch's file. A second read 16 s later did not fetch. On a container whose
  origin bind was dangling (below), recovery failed as `no-remote`, the read
  returned "Target ref is not present in the container: qa-recover", and the
  next read did not retry (failure cooldown).
- **Explicit refresh.** After 16 s, a new commit pushed to `qa-recover`; a
  plain read was a cache hit and still showed the old base. A read with
  `refresh: true` answered from local refs, marked the key dirty and started
  one background fetch (`inFlight` 1, then `completed` +1). The next read
  showed the new upstream file.
- **Routine policy on a legacy record.** The profile was stopped,
  `createdFromCommit` removed from one container environment's row in the
  profile's own `orkestrator.sqlite` (setup already complete, as an old
  record has), and restarted without `--fixture`. Its badge compared against
  `main`. The first scan fetched at 02:53:20.4. A commit pushed to origin
  `main` at 02:53:36. Scans every 15 s were cache hits (`requested` +2 per
  30 s, `started` unchanged). The second fetch ran at 02:58:20.9, 5 min after
  the first, moved `origin/main`, and the badge's diff stats were recomputed
  in the same second (0 to 1 file): change-to-visible 4 min 44 s, inside the
  cooldown plus one scan.
- **Revert from the Files panel fetched the creation commit (fixed).**
  `revert_container_file` on a new container passed its creation commit to
  `refreshForAction`, which ran `git fetch origin <sha>`: `started` and
  `records` each +1 per revert. Git skips the transport when the commit is
  already local, so it cost a `docker exec` and an interactive admission slot
  rather than a network round trip; with the commit missing it would have
  fetched. After the fix, the browser spec's revert step asserts that
  `started` does not move.
- **Fixture restart.** The first start was stopped and started again with
  `--fixture`, which deletes and recreates `fixtures/origin.git` and
  `fixtures/test-project`. The first start's container kept a bind to the
  deleted origin (empty inside, `does not appear to be a git repository`),
  and its local worktree's `.git` pointed at a deleted repository. Recorded as
  2180 (deleted 2026-11-06; its live check was task 7 of 0019, retired 2026-11-11, done 2026-11-06);
  the run above used the second start's container.

Real-browser QA, on a fresh profile after `dev:reset` (headless Chromium, run
with `ORKESTRATOR_AGENT_TEST_PROFILE=q48 ORKESTRATOR_AGENT_TEST_DOCKER=1 bunx
playwright test --config e2e/agent-testing/playwright.browser.config.ts
container-files-wiring.spec.ts --workers=1`): 3 passed.

| Case | What was checked | Result |
| --- | --- | --- |
| Files panel on a container | A file written in the container appears in the Changes tab through the 5 s poll | Passed |
| Inactive switch | A file written while `fixture-local` was open appears on return to the container | Passed |
| Hidden document | With `visibilityState` hidden for 12 s, a new file does not appear; it appears after return | Passed; about 3 s after return |
| Reload | All three files still listed after a reload | Passed |
| Two windows | A second window on the same container; a file written and then removed shows and clears in both | Passed |
| Revert from the panel | Right-click, Revert, confirm: "File reverted", the row clears, `git status` clean, no fetch started | Passed |
| Missed final invalidation | Local worktree, All files tab: a file saved while hidden (its tree announcement skipped) appears after return | Passed; about 3 s after return |
| Coordinator view | The project's Coordinator tab opens with container environments present, before and after selecting the container and after a reload; never "Coordinator unavailable" | Passed (smoke: it lists nothing environment-specific without a delegation) |
| Merge from the UI | Needs a pull request and `gh` | Not run |
| Validation output | Needs a Multi Review or build pipeline plan from a model turn | Not run |

On a current backend the Changes tab of a local environment is the
event-driven change projection, which applied the save while the document was
hidden. So the missed-final-invalidation case was moved to the All files tree,
which re-reads on announced revisions and skips one while hidden.

### Container app wiring, follow-up (2026-11-01, Linux)

Same host and harness as above (headless Electron, no provider turn, no
GitHub, no agent credentials). Profile `q48m`, started once with `mise run
dev:test --profile q48m --fixture --fixture-environments local,container
--no-agent-credentials --agent-platforms codex` and reset before the recorded
run. Recorded run: `ORKESTRATOR_AGENT_TEST_PROFILE=q48m
ORKESTRATOR_AGENT_TEST_DOCKER=1 mise run test:logged -- --name
container-wiring-full -- bunx playwright test --config
e2e/agent-testing/playwright.browser.config.ts container-files-wiring.spec.ts
container-app-wiring.spec.ts --workers=1`: all 5 tests passed on the fresh
profile. Afterwards the container had its own `gh` back, origin `main` at the
fixture commit, no leftover branch or validation artifacts, and both fixture
environments running. The profile's store held no native agent session.

| Case | What was checked | Result |
| --- | --- | --- |
| Merge: PR state | `set_environment_pr` with mergeability unknown; the PR monitor's `gh pr view` inside the container turns it mergeable and enables "Merge PR" | Passed |
| Merge: from the UI | "Merge PR", then the dialog's "Merge PR": `gh pr merge <url> --squash --delete-branch` ran in the container, origin `main` holds the file, the branch is gone, "Branch merged", "PR Merged" and "Clean Up" show, `prState` is `merged` | Passed |
| Merge: inactive, second window, reload | A second window on `fixture-local` during the merge shows "PR Merged" on return; a reload shows it too | Passed |
| Merge: failure | First attempt, before the stand-in's clone was fixed: the dialog stayed open with "Failed to merge PR: …" and git's message | Seen once (not a spec step) |
| Validation output | Two real commands through `start_review_validation` in the container (one passes with stdout, one fails with stderr and exit 3); a pipeline record naming the run; Build tab, Prepare node, Tests: each command's terminal output dialog shows its own stream and status | Passed |
| Validation output: switch, second window, reload | The same output after a switch to `fixture-local` and back, in a second window, and after a reload | Passed |
| Build tab in a build-only layout | No persisted layout, then the layout `ensureBuildPipelineTab` writes for an existing environment: the seeded terminal joins the Build tab, which stays selected in the view and in the persisted layout | Failed before the fix (the terminal took the selection and it was persisted); passed after (decision 23) |
| Coordinator: inactive | A delegation to `fixture-container` opened while that environment was shown appears as "Waiting on 1 worker", naming it, when the Coordinator tab returns | Passed |
| Coordinator: hidden | A delegation to `fixture-local` opened while the document was hidden stays out of the count for 6 s, then appears after return | Passed |
| Coordinator: reload, second window, context | Both delegations after a reload and in a second window; a branch switch in the project checkout shows `Context r<n+1>` and "Repository context changed to …" in both windows | Passed |
| Coordinator: closing | Stopping `fixture-local`, then `fixture-container`, closes each delegation within the 60 s sweep; the second window, on another environment meanwhile, shows none on return; the main conversation still has no agent | Passed |
| Files panel, local tree | `container-files-wiring.spec.ts`, as in the table above | Passed |

Hidden-document coverage for merge and validation output: not separately
checked. The merge state reaches the view through environment events, which
the inactive and second-window steps cover. The output dialog polls only
while a command is queued or running, and these runs had finished.

### Long soak (2026-11-06, Linux)

Host: beelink, Linux 7.1.8 x86_64, Docker Engine 29.9.2 on a shared host, Bun
1.4.4, headless `dev:test` profiles of this branch with the reachability
check off. Each run was a fresh profile with one local fixture environment,
no agent credentials and only the Pi toolchain (seeded from the host).
Command of the acceptance run:

```bash
env -u DISPLAY -u WAYLAND_DISPLAY ORKESTRATOR_HOST_REACHABILITY_CHECK=off \
  mise exec -- bun scripts/recurring-live-ab.ts --arms candidate --repeats 1 \
  --settle-ms 60000 --window-ms 60000 --sample-ms 30000 --freshness-probes 0 \
  --fixture-environments local --agent-platforms pi --soak-cycles 60 \
  --soak-environments local --soak-cycle-gap-ms 65000 --soak-sessions 2 \
  --profile-prefix rw-fixsoak --out output/benchmarks/recurring-long-soak-fixed-2026-11-06.json
```

Every cycle created, started to `ready`, stopped, restarted and deleted one
local environment, opened a Pi session in it on the fake model before the
stop, and sent one prompt to each of two Pi sessions kept open on the
fixture environment for the whole soak. Two runs, both with exit 0:

| Run | Build | Cycles | Duration | Failed steps | Turns (model requests) | Leaked footprint gauges | Guard lines | Backend RSS MiB, first/last/max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Before the fix (45 s gap) | `7e3ee6a80` | 60/60 | 54 min | none | 182 | none | 0 | 250/406/481 |
| Acceptance (65 s gap) | `5755afef7` | 60/60 | 74 min | none | 182 | none | 0 | 243/302/413 |

Both started and reset their profile through the script; nothing was left
running. The footprint (9 schedulers, 3 pools, scheduler keys per kind, no
lease, fetch or signal record, one event stream) returned to its baseline
exactly in both.

Cache gauges, first and last of the 60 trend samples (one after each
cycle). Every gauge not listed was flat (worktree snapshot entries, tree
targets and watched worktrees at 1; owned and scan-cache worktrees at 2;
change tracking's owners and sources at 1; 10 row-cache connections):

| Gauge | Before the fix | Acceptance | Reading |
| --- | --- | --- | --- |
| `native-projection:projections`, `projectionRevisions`, `projectedMessageSessions` | 3 → 62 | 2 → 2 | One per deleted environment's session, kept until LRU churn (bug, fixed, decision 26). Flat at the two open sessions after the fix. |
| `native-projection:projectionEpochs` | 1 → 60 | 0 → 0 | The same, fixed. |
| `native-projection:projectedMessages` / `projectedMessageBytes` | 10 → 362 / 10 KB → 371 KB | 8 → 244 / 8 KB → 247 KB | After the fix, the two open sessions' own rows: two per prompt over 120 prompts. Bounded per session (4,096 rows) and in total (8,192 rows, 48 MiB). |
| `change-tracking:deletedEnvironments` | 1 → 60 | 1 → 50 | One fence per deleted environment until its purge finishes, after the 1 h orphan grace. The acceptance run levelled at 49 to 50 from about an hour in, as purges finished; bounded by an hour of deletions. |
| `storage-row-cache:rows` / `bytes` | 12 → 67 / 209 KB → 843 KB | 12 → 70 / 209 KB → 845 KB | The connection's cache of stores read whole, following durable data: the CLI's operation records, usage history, artifact grants and deletion tombstones, each with its own retention (tombstones are permanent by design and a few bytes each). Not a cache leak. |
| `native-projection` progressive and snapshot maps | 0 | 0 | Never filled: no client read a transcript ([7100](7100-long-soak-follow-ups.md) tasks 3 and 4). |

The trend check flagged the last three as rising, as designed: their floor
in the last third of the samples was above their peak in the first. Each
was read against its bound above. Backend RSS rose over the first run and
ended lower than its peak in the second; under Bun it is still not a leak
gauge, and the counts above are the evidence.

Not covered: containers (the daemon had no free address pool, decision 27;
[7100](7100-long-soak-follow-ups.md) task 2), a browser reader (7100 task
4), and providers other than Pi.

### Multi-client, restarts and an older backend (2026-11-06, Linux)

Host: Linux (Arch, kernel 7.1.8), Bun 1.4.4, a `dev:test` build of this
branch on a credential-free profile
(`--fixture --no-agent-credentials --agent-platforms claude --headless`,
`ORKESTRATOR_HOST_REACHABILITY_CHECK=off`), headless Chromium clients, and the
profile's managed Claude CLI 2.1.314 sent to the fake model through the
profile's isolated `CLAUDE_CONFIG_DIR`. One full run of
`multi-client-restarts-live.spec.ts` with 10 rounds passed all six cases.
Times are wall-clock in the test process, from the action to the client
showing the result.

| Scenario | Measure | Result | Budget (p95) |
| --- | --- | --- | --- |
| Two clients, connected client A (10 rounds) | turn completion visible | p50 175 ms, p95 375 ms | ≤ 3 s |
| | activity indicator working / idle | p95 2.3 s / 2.7 s | ≤ 4 s |
| | diff badge after a save (watched local) | p50 452 ms, p95 514 ms | ≤ 2 s |
| Two clients, client B cut off 4 to 5 s by the outage link | answer, idle and badge after the link returns | p50 6.3 s, p95 13.1 s | ≤ 16 s plus one read since 2026-11-13 (7120 (retired) task 2; [latency budgets](../../architecture/recurring-work.md#latency-budgets)) |
| Queued prompt (10 rounds) | dispatched after the running turn ends | p50 1.36 s, p95 1.81 s | ≤ 3 s |
| | shown on both clients | p95 1.92 s | ≤ 3 s |
| Backend crash / graceful restart, turn held, prompt queued | restart to `ready` | 3.1 s / 3.1 s | none |
| | both clients after sign-in: rows and settled state | ≤ 14 ms after the tab opened | none |
| | interrupted prompt sent again / queued prompt delivered | 0 / exactly once, after the next turn | at most once |
| | follow-up turn on the same conversation | 817 ms / 827 ms | ≤ 3 s |
| Bridge `SIGKILL` mid-turn | both clients settled | 107 ms / 113 ms | ≤ 4 s |
| | follow-up on the same conversation | 877 ms | ≤ 3 s |
| Bridge `SIGKILL` idle | next prompt shown on both clients | 826 ms / 831 ms | ≤ 3 s |
| Older backend v2.21.0, today's renderer, two clients | turn completion A / B | 269 ms / 2.07 s | ≤ 3 s |
| | activity idle A / B; diff badge A / B | 2.06 s / 2.07 s; 427 ms / 429 ms | ≤ 4 s; ≤ 2 s |

- **Two clients, one disconnected.** B sits behind the outage link from
  `client-outage-support.ts` in `reset` mode. Before its link returned B had
  seen neither the answer nor the badge; after it, each client showed the
  prompt and the answer once, and the model saw the prompt once. B's
  convergence time is its reconnect rung, not backend work (task 2 of 7120 (retired)).
- **Backend restarts.** A backend crash ends the whole `dev:test` profile and
  the local bridge with it (the parent-bound wrapper), so the held call is
  aborted and the turn settles as failed with "Claude restarted before this
  turn finished"; nothing re-sends the prompt. The first public
  `session.transcript` read after the restart was `current`, 50 rows,
  `complete: false` (an older-page cursor). An earlier attempt read a
  restarted bridge's empty preview as `complete: true`; fixed (T11.1). The
  queued prompt is held while the interrupted turn reads as failed and goes
  out after the user's next turn ends: delivered once, but after a prompt
  typed later (7120 (retired) task 1; fixed 2026-11-13, the queued prompt now goes first).
- **Bridge restarts.** The first run left the killed bridge's Claude CLI
  running as an orphan, still waiting on the parked model call; fixed (T11.2).
  After the fix the held call is aborted and no Claude process of the profile
  outlives its bridge; the backend logs `bridge.orphans-reaped` for each kill.
  The next prompt resumes the same conversation (its call carries every
  earlier prompt).
- **Older backend.** v2.21.0 was built from its tag in this worktree
  (`git archive v2.21.0`, `bun install --frozen-lockfile --ignore-scripts`,
  `bun run --cwd bridges/claude-bridge build` in the archived checkout) and started with
  `--data-dir`, `HOME` and `CLAUDE_CONFIG_DIR` of its own under `output/`,
  `--port <free> --control-port 0`, `ORKESTRATOR_CONTROL_MCP_PORT=0` and
  `--renderer-dev-server-url` set to the profile's current renderer, so the
  browser ran today's renderer against it. It was given the profile's Claude
  2.1.314 (it pins 2.1.296). v2.21.0 has no
  `ORKESTRATOR_HOST_REACHABILITY_CHECK` switch: its first start ran the boot
  probe (its network create failed, the probe container was ephemeral and
  nothing of it remained), so later starts set `DOCKER_HOST` to an absent
  socket. Today's renderer worked: sidebar, turn, legacy diff badge, no page
  errors; twelve newer commands answered 500 and their fallbacks held. It
  shows a misleading "has been updated" notice (7120 (retired) task 4; reworded 2026-11-13). Today's CLI ran
  project, environment and session commands against it over `--url`; its
  `--data-dir` connection is refused on Linux (7120 (retired) task 3; registered 2026-11-13).
- **Harness notes.** The fake key is not a Claude login, so the app's "Claude
  Code Is Not Logged In" notice opens and the spec dismisses it; a 30 s
  default click timeout once let a reopening notice outlast the wait, so
  clicks are bounded at 5 s. The renderer URL changes on every profile
  restart, so the older-backend case runs first.

### macOS watcher, change-to-visible and remote freshness (2026-11-06, macOS)

Host: macOS (Darwin 27.2.0, arm64), Bun 1.4.4, Docker Desktop. Browser runs
used a credential-free `dev:test` profile of this branch
(`--fixture --fixture-environments local,container --no-agent-credentials
--agent-platforms pi`, `ORKESTRATOR_HOST_REACHABILITY_CHECK=off`), headless
Chromium at 1400×900, and were reset afterwards. The packaged run used a
`package:mac:unpacked:test` build of this branch (made before the decision
M3 fix, which does not touch the watcher) on a throwaway profile under a
temporary root. No provider turn, login, GitHub call or firewall change.
Times are wall-clock from the write (or the click) to what the probe saw;
the watched-badge budget runs from when the save settles, 400 ms later, so
its bound from the write is 2.4 s (decision M1).

**Watcher alone** (`bun scripts/worktree-watcher-live.ts --bursts
1000,5000,20000,50000`, the backend's `startWorktreeWatcher` and helper
program, real FSEvents). Two runs that day, the second under more host load
(its writes were up to four times slower):

| Case | Run 1 | Run 2 |
| --- | --- | --- |
| 20 single saves, write to hint (400 ms of it the settle) | p50 464 ms, p95 465 ms | p50 454 ms, p95 460 ms |
| Burst 1,000 files: hints, overflow, last hint after the last write | 1, 0, 413 ms | 1, 0, 389 ms |
| Burst 5,000 files | 1, 0, 247 ms | 2, 0, 273 ms |
| Burst 20,000 files | 3, 1, 500 ms | 5, 0, 386 ms |
| Burst 50,000 files | 5, 4, 323 ms | 17, 0, 186 ms |
| `git add` and commit of every burst file | 1 metadata hint, 454 ms after it ended (21.8 s) | 1, 411 ms (150.7 s) |
| Helper killed | every watch errored within 3 ms (`EWATCHHOST`); a new watcher's new helper qualified in 24 ms and saw a save in 457 ms | 14 ms; 26 ms; 455 ms |
| Watched root removed, then recreated | no error, 1 hint; the old watch still reported the recreated path (first hint 459 ms) | the same, 454 ms |
| Missing root | not watched, `ENOENT` | the same |

Overflow (a hint without paths after too many events) appeared only when the
writes were fast enough; either way every burst's last hint came after its
last write (`finalCovered`), so no final change was lost to coalescing or
overflow.

**In a browser** (`change-to-visible-latency.spec.ts`, full run, then a second
run of the container case):

| Row (budget, p95) | Samples | p50 | p95 | Max |
| --- | --- | --- | --- | --- |
| Local badge, watched (2 s after settling: 2.4 s from the write) | 30 | 655 ms | 1.38 s | 1.43 s |
| Local Changes row, panel open (6 s) | 15 | 960 ms | 1.43 s | 1.43 s |
| Local All files entry (6 s) | 15 | 563 ms | 578 ms | 578 ms |
| Container badge (20 s) | 30 / 30 | 687 / 735 ms | 1.49 / 1.73 s | 1.63 / 2.72 s |
| Container Changes row (6 s) | 15 / 15 | 665 / 746 ms | 755 ms / 1.76 s | 755 ms / 1.76 s |
| Container All files entry (6 s) | 15 / 15 | 727 / 755 ms | 1.63 / 2.76 s | 1.63 / 2.76 s |
| Container Changes after Refresh (1 s) | 15 / 15 | 543 / 425 ms | **2.23 / 1.30 s** | 2.23 / 1.30 s |
| Container All files after Refresh (1 s) | 15 / 15 | 462 / 312 ms | 881 / 414 ms | 881 / 414 ms |

The container rows are far inside their budgets because the container's own
change signal announces a write; the 15 s poll is only a backstop. The one
miss is the Changes refresh: 14 of the second run's 15 refreshes took 317 to
635 ms and one 1.30 s, a refresh that followed a scan already running
(decision M6, 7201).

- **Bursts at the badge.** 2,000 files (exactly the untracked line-count
  cap): `+2,000` in 714 ms. 5,000 and 20,000 files: the badge turned
  approximate ("Too many untracked files to count them all") 1.7 s and at
  once after the last write (the 20,000 burst took 3.9 s to write and was
  capped part-way). After each burst was removed, the badge was back to its
  exact earlier count in 1.87, 2.02 and 2.87 s.
- **Lost helper on `dev:test`.** The helper (identified as the profile
  backend's child by pid, parent and start time) was killed: the watched
  gauge fell from 2 to 1 within 325 ms, two saves while polling showed in
  11.3 and 11.3 s (unwatched budget 20 s), the 30 s retry re-attached at
  30.8 s with a new helper, and the next save showed in 1.39 s.

**Packaged app** (`watcher-packaged-electron.spec.ts`, `app.isPackaged` true,
`userData` the throwaway profile):

- The new local environment was watched 49 ms after it started.
- 20 back-to-back saves: p50 2.05 s, p95 2.08 s from the write, 1.65 to 1.68 s
  after settling, inside the 2 s budget. They are slower than on `dev:test`
  because each save starts as soon as the previous one is shown, so each
  waits out `LOCAL_SCAN_MIN_GAP_MS` (2 s from the previous scan's end); the
  `dev:test` probes paused 0.5 to 2 s between saves. The budget table now
  names the gap.
- 20,000 files: capped badge 406 ms after the last write; exact again 2.03 s
  after removal.
- The helper was the bundled Bun inside `OrkestratorV2.app`. Killed: polling
  within 50 ms, a save shown in 15.0 s, re-attached at 30.1 s with a
  replacement helper, the next save in 2.12 s.

**Changes-tab remote freshness** (`changes-remote-freshness.spec.ts`, after
the decision M3 fix). A new container: comparison base a commit, remote
`not-required`, no strip. The legacy record (createdFromCommit removed from
the profile's own `orkestrator.sqlite` with the profile stopped, restarted
without `--fixture`; it compared against `main`):

| Step | Backend `remote` | Strip | Time |
| --- | --- | --- | --- |
| Changes opened | `current` | none | |
| Refresh | `current` | none | 529 ms (a fetch ran) |
| Remote advanced from a second checkout, no fetch | `current` | none | |
| Origin URL broken in the container, Refresh | `stale`, `no-remote` | "Base may be behind remote" | backend 322 ms, strip 352 ms |
| Another failed fetch while the page showed the local environment, then back | `stale` | same | 291 ms after returning |
| Reload | `stale` | same | 18 ms after the panel opened |
| Origin restored, Refresh | `current` | none | strip cleared 702 ms; the list compared with the advanced remote at 810 ms |

Fetch counters at the end: `started` 5, `completed` 3, `failed` 2. Before
the fix the same steps left `started` at 1 (the start-up fetch) and the
backend `current` throughout.

### Event-stream reader inventory (2026-11-06)

Task 20, read against `main` at `c1724ab74`. "Covered" means a silence bound
the peer's keepalive keeps from firing, a bounded backoff and jitter, each
with code and a test. Readers of a child process's stdio are not reconnect
owners: the child's exit is the signal.

| Reader | Transport | Silence | Backoff, spread | Disposition |
| --- | --- | --- | --- | --- |
| Bridge observation stream, Claude and Codex (`http-bridge-observation-stream.ts`) | SSE | 75 s (`BRIDGE_OBSERVATION_STREAM_SILENCE_MS`) against 30 s bridge keepalives | 1 to 30 s, `ReconnectBackoff` | Covered |
| Federation node event stream (`nodes/node-event-stream.ts`) | SSE | 75 s (`NODE_EVENT_STREAM_IDLE_MS`) against the gateway's 25 s keepalive | 1 to 30 s, `ReconnectBackoff` | Covered |
| `NodeLink` route heartbeat (`nodes/node-link.ts`) | HTTP probe every 30 s | a failed probe | 2 to 60 s, `ReconnectBackoff` | Covered |
| Desktop relayed stream (`backend-process.ts`) | SSE | 60 s (`GATEWAY_STREAM_SILENCE_LIMIT_MS`) | `ReconnectBackoff` | Covered (part of the Electron client) |
| Web filtered streams, shared terminal and relayed (`web-gateway.ts`) | EventSource or SSE | none of their own | `createStreamBackoff`, jittered | Another layer: the main stream's watchdog drops them (`dropSilentStreams`) |
| `FetchEventSource` polyfill (`gateway-auth-transport.ts`) | SSE | none; reports an error and closes | none | Another layer: `web-gateway.ts` owns reconnects |
| Web terminal WebSocket (`terminal-websocket-client.ts`) | WebSocket | a pong probe when the page returns (2.5 s); since 2026-11-10 a ping after each quiet 10 s while the page is visible, replacing the socket after two unanswered; operation timeouts (30 s); the main stream's watchdog | 500 ms to 10 s, jittered | Covered; the visible-page stall was 7200 task 4, fixed |
| OpenCode event monitor (`opencode-provider.ts` `monitorRequests`; removed with OpenCode 1.x on 2026-11-11) | SDK SSE | since 2026-11-10, 35 s silence once the stream has sent `server.heartbeat` (every 10 s from 1.19.5) | 1 to 30 s, jittered | Gap, fixed: 7200 task 1. The OpenCode 2.x provider's own stream (`opencode2/provider.ts`, `/api/event`) got the same watchdog on 2026-11-11, armed by its `: heartbeat` comment (every 15 s on 2.2.6) with a 50 s deadline: 7559 (retired; see [recurring-work.md](../../architecture/recurring-work.md) B22) |
| Desktop `ReconnectScheduler` (`connection-scheduling.ts`) | route and handover attempts, not a stream | n/a | 1, 2, 5, 10, 30, 60 s, **no jitter** | Gap, fixed: 7200 task 2 |
| Desktop preview tunnel, v1 stream and v2 session (`preview-tunnel-client.ts`, `preview-tunnel-session.ts`) | WebSocket | pinged every 15 s, **pong ignored**; a stream-open timeout retires only that stream | opened per request | Gap, fixed for v2: 7200 task 3 (v1 deliberately left, decision T3 there) |
| Codex app-server JSONL (`jsonl-rpc-client.ts`) | stdio child | stream end; 60 s request timeouts | supervisor 250 ms to 10 s with jitter and a circuit breaker | Not applicable (child exit) |
| ACP agent (`acp-context.ts`) and Claude SDK frames | stdio child | exit and stream errors; Claude's runtime idle detach | reattach on demand | Not applicable |
| Cursor SDK run stream (`cursor-bridge/src/prompt.ts`) | in-process SDK | the turn's `PROMPT_TIMEOUT_MS` | none | Another layer: the Cursor SDK; not a reconnect owner |
| Docker events (`container-oom-events.ts`) and container log followers | `docker` stdio | exit | events: 1 to 60 s doubling, one per backend | Not applicable |
| Gateway preview proxy (`gateway-proxy.ts`) | HTTP or SSE pass-through | body idle timer | none | Not applicable (the end client reconnects) |
| CLI `--follow` (`packages/cli`) | polling | n/a | n/a | Not applicable |
| iOS wrapper | WKWebView | n/a | n/a | Another layer: it hosts the web client |

Pi, Grok and Cursor bridges publish no event stream to the backend; their
groups keep the full activity sweep cadence (`http-bridge-observation-stream.ts`).

### Busy profile (2026-11-06, Linux)

Task 1. Host: beelink, Linux 7.1.8 x86_64 (16 cores, 62 GiB), Bun 1.4.4,
headless `dev:test` profiles of this branch (based on `main` at `ee2cc8423`)
with the reachability check off, on a host shared with other builds (load
average 14 to 44 while it ran), so no timing here is a reference figure. Each
arm was a fresh profile with one local fixture environment, no agent
credentials and only the Pi toolchain (seeded from the host). Every model
call went to the driver's loopback fake model; no provider, login, GitHub
call, firewall or network change. Recorded run:

```bash
env -u DISPLAY -u WAYLAND_DISPLAY ORKESTRATOR_HOST_REACHABILITY_CHECK=off \
  mise exec -- bun scripts/recurring-live-ab.ts --arms candidate,rollback --repeats 1 \
  --settle-ms 60000 --window-ms 60000 --sample-ms 30000 --freshness-probes 0 \
  --fixture-environments local --agent-platforms pi --busy-rounds 3 \
  --busy-clients 0,1,2 --busy-environments 10 --keep-profiles --profile-prefix q48busy \
  --out output/benchmarks/recurring-busy-2026-11-06.json
```

Each arm: 10 local environments (the fixture's, `busy-ask` with an `ask`
execution policy, `busy-1` to `busy-8`), Pi sessions in `busy-1` and
`busy-ask`, then 3 rounds each with 0, 1 and 2 clients. Both arms' profiles
were kept for inspection and reset afterwards; nothing was left running.
A second run with only the client rounds (`--busy-clients 1,2`, a 30 s
settle and window, no `--keep-profiles`, otherwise the same;
`output/benchmarks/recurring-busy-clients-2026-11-06.json`) measured turn
completion by the reply row in the client's open tab, after the first run
showed the sidebar marker cannot (decision B6). It kept every obligation in
all 12 rounds of both arms, with no failure or guard line, and agreed with
the first run on every other row: workflow progress after a result p95
144 ms keyed against 4.10 s rollback, a queued prompt dispatched in p95 1.45
and 1.22 s, a pending approval visible in p95 191 and 162 ms, mail in 124
and 116 ms, and a cut client converged in 1.1 to 7.5 s.

| | Keyed (candidate) | Rollback |
| --- | --- | --- |
| Rounds, failed | 9, none | 9, one (client 1 of a one-client round never painted its page; a harness fault, decision B9) |
| Held turns, queued prompts, approvals, mails, reviews to `ready` | 9 each | 8 each (the failed round stopped before them) |
| Duplicated dispatches, guard lines | 0, 0 | 0, 0 |
| Busy phase duration, model requests | 155 s, 101 | 373 s, 90 |
| Backend CPU per round, RSS median / max | 2.2 s, 312 / 328 MiB | 3.1 s, 289 / 341 MiB |

Latency, p50 / p95 (samples). "Client" rows are what a page showed, timed
from the cause: the fake model's own arrival time for a model-side event,
the command's return otherwise.

| Row (budget, p95) | Side | Keyed | Rollback |
| --- | --- | --- | --- |
| Pending approval visible (≤ 2 s) | client | 143 / 154 ms (9) | 167 / 186 ms (8) |
| Approval listed by `session.interactions` | backend | 32 / 50 ms (9) | 37 / 48 ms (8) |
| Mail shown on the tab's mail chip (≤ 4 s) | client | 105 / 119 ms (9) | 113 / 135 ms (8) |
| Background activity indicator to working (≤ 4 s) | client | 1.61 / 1.85 s (9) | 1.28 / 2.03 s (8) |
| Turn completion visible after the approval: reply row in the open tab, client run (≤ 3 s) | client | 101 / 104 ms (3) | 97 / 100 ms (3) |
| Queued prompt dispatched after the turn ends (≤ 3 s) | backend | 1.55 / 1.63 s (9) | 1.26 / 2.10 s (8) |
| Background indicator idle after the queued turn (≤ 4 s) | client | 44 / 51 ms (3) | 328 ms / 2.38 s (3) |
| Workflow progress after a result (withdrawn: callback pairing was unreliable) | backend | 84 / 157 ms (18) | **3.51 / 4.05 s (16)** |
| Validation plan result to reviewing (runs the plan) | backend | 2.18 / 5.78 s (9) | 5.66 / 8.30 s (8) |
| Multi Review launch to `ready` | backend | 4.79 / 8.47 s (9) | 15.9 / 18.2 s (8) |
| 200-file burst in all 10: change badge (2.4 s from the write) | client | 506 / 519 ms (90) | 628 / 701 ms (80) |
| Burst removed: badge back (2.4 s from the write) | client | 1.96 / 2.03 s (90) | 1.93 / 2.02 s (80) |
| Burst: every environment rescanned (`diff-scan` changed +10) | backend | 529 ms / 1.82 s (9) | 669 / 743 ms (8) |
| Cut client converged after its link returned | client | 5.7 / 12.5 s (3) | 10.4 / 10.4 s (3) |
| Hidden client converged after it was shown | client | 117 / 123 ms (3) | 141 / 176 ms (2) |

Starts over the busy phase (from the round-boundary samples), per round:

| Job | Keyed | Rollback |
| --- | --- | --- |
| Feature planning tick | 0.6 | 40.2 |
| Build pipeline tick | 0.6 | 26.9 |
| Multi review tick | 9.8 | 9.0 |
| Native queue scan | 6.8 | 20.1 |
| Native launch scan, pending rename reconcile | 9.0 each | 20.1 each |
| Diff scans | 22.0 | 19.6 |
| Mail injection | 12.2 | 23.3 |

- **Obligations.** Every held turn reached the model once and finished when
  released, every queued prompt went out once after it, every approval was
  answered (through the public action, decision B4) and its turn finished,
  every mail showed, and every review reached `ready` with the three results
  the fake model submitted. The fake model counted each marker's requests,
  so a duplicate would have shown.
- **Rollback.** The rollback drivers kept the same obligations but were
  slower where it shows: workflow progress after a result missed its budget
  in every review (all 16 samples 3.2 to 4.1 s; `WorkflowDueScheduler`
  passes rather than keyed wakes), so a review took three times as long, and the
  whole-store ticks started 40 times a round for feature planning with no
  plan to drive. The keyed drivers used less backend CPU per round (2.2 s
  against 3.1 s; `ps` time has one-second resolution). Per-minute rates are
  not comparable between arms, because the keyed arm finished the same
  rounds in less than half the time.
- **Admission.** `git-docker-scan`: 269 and 240 leases, at most 4 active and
  2 or 3 waiting, oldest wait 31 and 86 ms (the client run: at most 5
  waiting, oldest 65 ms); `workflow-provider` 83 leases
  (keyed) and none (the rollback driver takes none), never waiting;
  `external-pr` 27 and 22, never waiting; nothing refused.
- **Validation.** Each review's plan ran one `git rev-parse HEAD` through the
  validation worker: queued 4 to 13 ms in the host-wide test scheduler,
  1.07 to 1.18 s a run (the client run: 4 to 18 ms, 1.08 to 1.19 s). The
  first smoke run's first review waited 210 s after its plan; not seen again
  in 33 reviews (7202 (retired) task 2, closed on 2026-11-14 as a wait in
  the host test queue; see [Related](#related)).
- **Clients.** The two-client rounds cut the second client's link (`reset`)
  from just after the mail to the end of the review; it converged in
  4.4 to 12.5 s after the link returned (1.1 to 7.5 s in the client run), the reconnect ladder of
  7120 (retired) task 2. The one-client
  rounds hid the document for the same span; it converged in at most 176 ms.
  Burst rows have one sample per environment per client.
- **Harness notes.** Approving from the CLI is refused for an approval with
  no questions (7202 (retired) task 1; fixed on 2026-11-10). A Pi session
  keeps the model URL it was created with, so the fake model must outlive
  every session that uses it (it does: one per busy phase).

### Workflow client visibility (2026-11-10, Linux)

Task 2. Host: beelink, Linux 7.1.8 x86_64 (16 cores), Bun 1.4.4, headless
`dev:test` profiles of this branch (based on `main` at `04639b12b`) with the
reachability check off, on a host shared with other builds (load average
38 to 52). Each run was a fresh profile with one local fixture environment,
no agent credentials and only the Pi toolchain; every model call went to the
driver's loopback fake model; no provider, login, GitHub call, firewall or
network change. Both profiles were stopped and reset by the driver.

```bash
env -u DISPLAY -u WAYLAND_DISPLAY ORKESTRATOR_HOST_REACHABILITY_CHECK=off \
  mise exec -- bun scripts/recurring-live-ab.ts --arms candidate --repeats 1 \
  --settle-ms 30000 --window-ms 30000 --sample-ms 30000 --freshness-probes 0 \
  --fixture-environments local --agent-platforms pi --busy-rounds 3 \
  --busy-clients 1,2 --busy-environments 10 --profile-prefix q48wfvis \
  --out output/benchmarks/recurring-busy-workflow-visible-2026-11-10.json
```

Run 1 used the harness before decision W5 and recorded a false
`workflow-sample` failure per round (the build pipeline's preparation
result, which a review never sends); its other samples are valid. Run 2 is
the same command after the fix.

| | Run 1 | Run 2 |
| --- | --- | --- |
| Rounds (1 and 2 clients), failures | 6, the W5 harness fault only | 6, none |
| Held turns, queued prompts, approvals, mails, reviews to `ready` | 6 each | 6 each |
| Duplicated dispatches | 0 | 0 |
| Review views watching, results timed in a view, not sampled | 6, 12, 0 | 6, 12, 0 |

Latency, p50 / p95 / max (samples):

| Row (budget, p95) | Side | Run 1 | Run 2 |
| --- | --- | --- | --- |
| Workflow progress visible after a result, review view (≤ 3 s) | client | 221 ms / 3.90 s / 3.90 s (12) | 224 ms / 4.27 s / 4.27 s (12) |
| Backend phase observed after the same results (≤ 3 s, upper bound) | backend | 143 ms / 3.71 s / 3.71 s (12) | 146 ms / 4.08 s / 4.08 s (12) |
| Validation plan result to `reviewing` (runs the plan) | backend | 5.52 / 18.3 s (6) | 5.83 / 6.32 s (6) |
| Multi Review launch to `ready` | backend | 9.37 / 21.5 s (6) | 8.83 / 13.4 s (6) |
| Pending approval visible (≤ 2 s) | client | 168 / 331 ms (9) | 169 / 257 ms (9) |
| Queued prompt dispatched after the turn ends (≤ 3 s) | backend | 1.18 / 2.23 s (6) | 903 ms / 1.11 s (6) |

- **Per result.** Report to `consolidating`: 94 to 394 ms in every review,
  client and backend. Consolidated review to `ready`: about 100 to 300 ms in
  nine reviews of twelve, and 3.7 to 4.3 s in three (run 1: one; run 2:
  two), backend and client alike. The client view lagged the backend by 30
  to 250 ms throughout, so the budget miss is the backend's tail, recorded in
  7557, fixed and retired 2026-11-10, [after the fix](#workflow-progress-after-the-7557-fix-2026-11-10-linux).
- **Validation.** Each run took 1.13 to 1.19 s; one of run 1's queued 14.9 s
  in the host-wide test scheduler behind other builds, hence its 18.3 s row.
  The row is bimodal (about 2.4 s or 6 s) like the `ready` tail.
- **Other rows.** Unchanged from task 1's run and within budget; the drivers
  for native queues and backend activity are the keyed ones in both (the
  rollback drivers are removed, decision W2).

### Workflow progress after the 7557 fix (2026-11-10, Linux)

Task 2's tail was found and fixed by to-do 7557 (now retired; the behaviour
is in [recurring-work.md](../../architecture/recurring-work.md#latency-budgets)).
The lost wake was not a dropped hint: a result is accepted inside the model's
tool call, before its turn can end, and workflow sessions are not native
agent sessions, so nothing announces the turn's end. A pass that read the
turn still running left the result for the next observation pass. Multi
Review now polls an accepted, unconsumed result on a 250 ms cadence for one
observation interval from its acceptance
(`multi-review-result-settle.test.ts`, which fails without the fix).

Same host (beelink2, Linux, 16 cores, load average 54 to 57 at the start),
same command as above with `--settle-ms 120000`, `--keep-profiles` and
`--profile-prefix q7557wake2`, on this branch at `89452cec3`. One fresh
profile, loopback fake model only, reachability check off; the profiles
were stopped and reset afterwards. A first attempt stopped before its busy
phase because this worktree's `orkestrator` CLI was not built (`mise run
build:cli`); the driver reports that as "The busy phase needs the fixture's
ready local environment".

| Row (budget, p95) | Side | Before (run 2 above) | After |
| --- | --- | --- | --- |
| Workflow progress visible after a result, review view (≤ 3 s) | client | 224 ms / 4.27 s (12) | 247 / 648 ms (12) |
| Backend phase observed after the same results (≤ 3 s, upper bound) | backend | 146 ms / 4.08 s (12) | 162 / 362 ms (12) |
| Validation plan result to `reviewing` (runs the plan) | backend | 5.83 / 6.32 s (6) | 2.64 / 5.07 s (6) |
| Multi Review launch to `ready` | backend | 8.83 / 13.4 s (6) | 5.95 / 9.18 s (6) |

- **Per result.** Report to `consolidating`: 162 to 219 ms. Consolidated
  review to `ready`: 108 to 362 ms in all six reviews (before: 3.7 to 4.3 s
  in a quarter of them). Client views 152 to 648 ms.
- **Obligations.** 6 rounds (1 and 2 clients), no failures: 6 held turns,
  queued prompts, approvals, mails and reviews to `ready`, 0 duplicated
  dispatches; every other row within budget.
- **Validation.** Still bimodal, 2312 to 2671 ms in four reviews and 5060
  and 5069 ms in two, with runs of 1132 to 1180 ms: the validation run's
  completion raises no wake and is read on the observation cadence. The row
  has no budget; it was task 3 of 7564 (retired 2026-11-11), with graph
  runs, which read their turns the way Multi Review did. Both now follow
  the step on a short cadence
  ([recurring-work.md](../../architecture/recurring-work.md#latency-budgets)).

### Client-only and validation candidates (2026-11-11, Linux)

Task 12's six candidates that never needed task 1, measured on beelink2
(Linux 7.2, 16 cores, x86_64) at `498b68766`. No backend, profile, provider
or login was used: each cost was measured where it is paid, with the real
code where the code is in this repository. Docker ran only on a disposable
rootless daemon (`mise run docker:disposable -- start`) through
`apps/desktop/scripts/dev/docker-qualification-bin`, with one `busybox:1.37`
container; the container, the image and the daemon were removed afterwards.
The scratch benchmarks lived under the git-ignored `output/benchmarks/` and
were deleted. CPU is user plus system time; a child's comes from
`Bun.spawnSync`'s resource usage, a daemon's from `/proc/<pid>/stat`
(including its waited-for children, so runc counts under the shim).

| What | How | Result |
| --- | --- | --- |
| C09: one Docker availability probe (`docker info`, `checkDockerAvailability`) | 3 runs of 40 against the empty disposable daemon | wall p50 41.4 to 43.0 ms, p95 44.0 to 48.1 ms; CLI CPU p50 60.9 to 62.4 ms (the CLI loads its plugins to list them); dockerd and RootlessKit 2.5 to 2.75 ms a probe |
| `docker exec` floor (B19 container capture, C06 container reader) | 3 runs of 30 `docker exec <busybox> sh -c 'cat /proc/uptime'` | wall p50 47.9 to 57.2 ms; CLI CPU p50 25.7 to 28.7 ms; dockerd, RootlessKit, containerd and the shim with runc 33.7 to 41.0 ms an exec |
| B19: one local capture (`tmux capture-pane -p -e`) | 2 runs of 100 on a private tmux server (`-L`), 120×30 pane full of text | wall p50 2.08 to 2.39 ms, p95 2.92 to 3.16 ms; client CPU p50 1.58 to 1.80 ms (the tmux server's own CPU was not read) |
| C12: one unchanged design canvas cursor check | `DesignService.sync` at the current revision, in process (`createDesignHarness`), 3 runs of 2,000 | 2 frames 33 to 52 µs wall, 58 to 70 µs CPU; 20 frames of 2 KB HTML 40 to 80 µs wall, 72 to 96 µs CPU; a 123-byte `unchanged` answer. The gateway hop was not measured |
| C06: one validation output poll, local | the real `readReviewValidationOutput` with its spawned `bun` reader, append mode on a 200 KB stdout that grew a line per poll, 2 runs of 40 | wall p50 10.4 to 10.8 ms, p95 11.3 to 15.0 ms; the backend's own CPU 0.80 to 0.85 ms a poll; a bare `bun -e` child, the reader's floor, 9.0 to 9.1 ms CPU p50 |
| B20: one 500 ms heartbeat tick | the worker's tick (cancel checks, `persist`: stringify, `wx` write, rename) on a running run, 3,000 ticks, in the worktree's filesystem (btrfs), 2 runs | 6 commands (4.4 KB state) 63 to 76 µs CPU, 79 to 126 µs wall; 20 commands (14 KB) 84 µs CPU, 116 to 128 µs wall. A heartbeat-only write of the same tick: 29 to 31 µs and 45 to 48 µs CPU |
| Display clocks | headless Chromium (Playwright 1.65), a production React bundle of the real `useElapsedTimer` and `usePromptDeadline`, half turn clocks and half prompt deadlines, against one reference-counted shared clock; Performance metrics over 30 s after a 3 s settle, one run | script time a second: 1 clock 0.24 / 0.24 ms (each / shared), 10 clocks 2.24 / 0.34 ms, 50 clocks 1.26 / 0.74 ms, 200 clocks 4.77 / 0.70 ms; all main-thread task time: 1.42 / 1.31, 4.94 / 1.51, 4.12 / 4.65, 9.64 / 4.03 ms; layouts a second 1 to 2.2 / 1 |

What each pays at its cadence, from the rows above:

- C09: about 64 ms of CPU a minute per visible client (about 0.1 % of one
  core); a hidden client does not poll (`startCoordinatedPoll`). Sharing
  across clients would save that much per visible client after the first.
- C12: 20 checks a minute per visible canvas, about 1.2 to 1.9 ms of design
  service CPU a minute, plus the unmeasured gateway round trip.
- Display clocks: at 10 running clocks the per-component intervals cost about
  2 ms of script a second more than a shared clock (0.2 % of the main
  thread); at 200, about 4 ms. The 50-clock row shows the run-to-run noise.
- C06: locally about 10 ms of CPU every 2 s (0.5 % of one core) while the
  output modal is open on a queued or running result; a container adds one
  `docker exec`, about 60 to 70 ms, so about 4 % of one core while open.
- B19: locally about 1.7 ms a second for an idle attached pane (0.2 % of a
  core). A container capture is one `docker exec` (about 62 to 70 ms of CPU
  with the capture), so an idle attached container pane costs about 6 to 7 %
  of one core and a changing one (4 captures a second) about 25 %. The loop
  stops only on an explicit detach, the environment's tmux cleanup or backend
  shutdown; the client detaches on unmount, which a reload, a closed window
  or a lost connection never runs (read from `tmux-interactive.ts`,
  `tmux-commands.ts` and `ClaudeTmuxInteractiveTerminal.tsx`). Observed live
  on 2026-11-11 (to-do 7745 task 2, retired): one orphaned terminal in a
  container added 57.5 `docker exec` captures a minute, and a leased one
  nobody renewed added none once its 45 s lease had passed.
- B20: two ticks a second, about 0.15 ms of CPU a second for a 20-command
  run; the split would save about 0.07 ms a second.

### Background-tab reconnect (2026-11-13, macOS)

Task 18, on arktech-mini (macOS 27.2, Apple silicon) at `1e5e8692a` (main at
`17d28238c` plus the task 13 removal), against a disposable profile started
with `ORKESTRATOR_HOST_REACHABILITY_CHECK=off mise run dev:test --profile
q48t18 --fixture --no-agent-credentials --no-host-seed --agent-platforms pi
--headless`, then stopped and reset. Command:

```bash
ORKESTRATOR_AGENT_TEST_PROFILE=q48t18 ORKESTRATOR_AGENT_TEST_LIVE_BACKGROUND_TAB=1 \
  mise run test:logged -- --name background-tab -- \
  bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts \
  background-tab-reconnect-live.spec.ts --workers=1
```

The spec starts Playwright's Chromium 158 headed itself, without the
`--disable-background-timer-throttling`, `--disable-backgrounding-occluded-windows`
and `--disable-renderer-backgrounding` switches, and attaches with
`connectOverCDP(..., { noDefaults: true })`, so no focus emulation keeps the
page visible (decision Q2). It opens the real app over the outage link
(`client-outage-support.ts`; the machine's network is untouched), with one
local environment and one terminal over HTTP/SSE, then opens a second tab
in the same window. The link drop is `reset` mode (connections refused),
45 s each time, long enough to reach the ladder's 16 s cap.

| Run | Hidden by | Hidden timer p50 / p95 (visible p50) | Hidden attempts during outage, main / terminal | Main / terminal back after restore, still hidden | Shown by | Main / terminal retry after shown | Main / terminal answered after shown |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | another tab | 1000 / 1001 ms (100) | 5 / 5 | 4.9 / 3.9 s | bring to front | 81 / 106 ms | 236 / 236 ms |
| 2 | another tab | 1000 / 1001 ms (100) | 6 / 5 | 10.0 / 3.0 s | bring to front | 149 / 160 ms | 298 / 300 ms |
| 3 | another tab | 1000 / 1001 ms (100) | 5 / 6 | 9.2 / 9.2 s | bring to front | 146 / 163 ms | 355 / 355 ms |
| 4 | another tab | 1000 / 1001 ms (100) | 5 / 5 | 7.0 / 2.0 s | bring to front | 52 / 54 ms | 70 / 110 ms |

- **Throttling is real.** A 100 ms interval in the hidden tab woke once a
  second (p50 1000 ms, p95 1001 ms), against 100 ms just before it was
  hidden. Every hidden attempt gap was a whole number of seconds give or
  take 40 ms (for example 3999, 8001, 10035, 8969 and 11006 ms in run 2).
- **A hidden tab reconnects on its own.** In every run the page stayed
  `hidden` from the hide until both streams were back (no visibility edge),
  and the main stream and the terminal stream came back 2.0 to 10.0 s after
  the link returned, within the ladder's 16 s cap plus a second of timer
  alignment (budget 20 s). Throttling only rounded the ladder's delays to
  whole seconds.
- **Past five minutes hidden.** A fifth run held each outage for 330 s
  (`ORKESTRATOR_AGENT_TEST_OUTAGE_MS=330000`; the spec now prints a
  progress line every 30 s, since the logged runner ends a group silent for
  5 min, which ended the first attempt at it), so the tab stayed hidden for
  about 12 minutes, past the five minutes after which Chromium's intensive
  throttling can hold chained timers to once a minute. It passed: 28 refused
  attempts on each stream, every gap from 8.97 to 16.03 s (the capped rung's
  8 to 16 s, never stretched toward a minute), both streams back 2.3 and
  2.5 s after the link returned while still hidden, and an 8 and 12 ms retry
  once shown. Bringing the tab to the front did not show it in that run (the
  display had locked), so it was shown by focus emulation (`shownBy`); its
  hidden half is a real background tab, like the four runs above.
- **Showing the tab retries at once.** The tab was shown 0.7 to 1.5 s after
  a refused attempt, so the ladder's next rung was at least 6.5 s away. Both
  streams were retried 52 to 163 ms after the tab became `visible` and were
  answered 70 to 355 ms after (budget 1 s) in the four runs above:
  `retryWaitingStreams` clears the
  waiting timers on the visibility edge, as designed. No product change was
  needed.
- **Rerun after the review repair (decision Q5).** The runs above pinned
  only the main stream before showing the tab. With the spec now waiting
  until both streams have just failed and refusing any attempt before the
  edge, a sixth run on 2026-11-13 (profile `q48t18r`, at `f6ddfe0a1` plus
  the repair; display locked, so hidden by occlusion and shown by focus
  emulation) passed: hidden timers p50 1000 ms (visible 100), back 9.5 / 1.5 s
  after the link returned while hidden, then, with both streams' last
  failures 1.6 s before the tab became `visible` and no attempt by either
  between the link returning and the edge, a retry 16 / 17 ms after it and
  an answer 62 ms after it. Lining the two ladders up added 23 s to the
  second outage. The profile was stopped and reset.
- **Earlier attempts that day.** Two development runs did not reach these
  checks. While the Mac's screen was locked, every window was occluded:
  only the tab Chromium opened at launch was hidden, and in one run it
  turned `visible` again during the outage, so the spec failed its "still
  hidden" check, as it should. The spec now drives that launch tab and
  falls back from occlusion to a second tab to minimising, and shows the tab
  with DevTools focus emulation only when bringing it to the front does not
  work (`hiddenBy`, `shownBy` in its evidence). The four runs above used a
  real tab switch both ways.
- **Cleanup.** The profile was stopped and reset (`dev:status` reports
  `missing`); the spec deletes its environment and its Chromium user-data
  directory. Chromium ran with `--use-mock-keychain` and
  `--password-store=basic`. Two short probe launches made while finding why
  Playwright's pages stayed visible ran Chromium without those two switches.

## Outstanding work

### Qualification

Use isolated profiles (`../development/agent-testing.md`). Runs that need
credentials or a platform CI lacks are batched in
[0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md).

- Live isolated profile, started with
  `mise run dev:test --profile <name> --fixture --fixture-environments local,container`.
  The idle part is done on macOS (see Live evidence): 30 s samples, CPU/RSS
  with metrics on and off, three repeats, a window longer than the 5 min
  container fetch cooldown, a rollback arm, and backend-side freshness for a
  watched local and a container diff badge. Still owed:
  - ~~10 environments with 0, 1 and 2 browser clients, then burst saves, long
    Git reads, an active turn, a pending approval, a queued prompt, a workflow
    completion, a network outage and a client resume.~~ Done 2026-11-06 on
    Linux with a fake model (task 1; see
    [Busy profile](#busy-profile-2026-11-06-linux)); long Git reads were not
    driven separately (the bursts' rescans of 10 worktrees are the nearest);
  - change-to-visible as a client sees it (the script stops at backend
    detection), for every row of the latency budgets. Done 2026-11-06 on
    macOS for the diff badge and Files panel rows (see
    [macOS evidence](#macos-watcher-change-to-visible-and-remote-freshness-2026-11-06-macos));
    the container Changes refresh tail is accepted as one scan longer
    (7201, 2026-11-10); the turn,
    approval and mail rows were done 2026-11-06 by the busy
    profile; workflow visibility was done 2026-11-10 (a review view per
    client, over budget at p95 from a backend tail,
    7557, fixed and retired 2026-11-10, [after the fix](#workflow-progress-after-the-7557-fix-2026-11-10-linux)); the PR rows go with live
    GitHub (task 5, now in 7568);
  - ~~the container fetch policy live~~. Done 2026-11-01 on Linux: a
    missing-baseline recovery fetch, an explicit refresh and the routine policy
    on a legacy record, all on a real container (see
    [Container fetch policy and app wiring](#container-fetch-policy-and-app-wiring-2026-11-01-linux));
    the routine policy stays (decision 11);
  - ~~container app wiring~~. Done 2026-11-01 on Linux, including a merge
    from the UI against a stand-in `gh` (decision 20). The same merge against
    real GitHub belongs with live GitHub (task 5, now in 7568).
- Live providers: 0049, retired 2026-11-11 (summary in [agent-testing.md](../../development/agent-testing.md)).
- ~~macOS: recursive `fs.watch` (`worktree-watcher.ts`) detects a save in a
  watched worktree in under 1 s (Live evidence), with Electron under
  `dev:test` and Docker Desktop. Still owed: a packaged Electron app, and the
  watcher's burst-overflow and failure-to-polling paths on macOS.~~ Done
  2026-11-06 (task 7; see
  [macOS evidence](#macos-watcher-change-to-visible-and-remote-freshness-2026-11-06-macos)).
- ~~iOS: the `apps/ios` wrapper running the web client on the simulator,
  checking the read coordinator's hidden pause and resume across backgrounding
  and screen lock.~~ Moved to 7568 on 2026-11-13 with the device run (task 8,
  decision Q1).
- Soak: repeated add, remove, stop and restart cycles. Timer, subscriber and
  cache counts return to baseline, and profile logs hold zero
  `Unhandled promise rejection (continuing)` guard lines. The ten idle
  profile lifecycles of 2026-10-22 had zero guard lines each; that is not a
  soak. 2026-10-25: the driver exists (`--soak-cycles`, see Current state)
  and a first 10-cycle local and container soak ran (see
  [Live soak](#live-soak-2026-10-25-macos)). ~~Still owed: a long soak (at
  least 50 cycles over an hour or more, with agent sessions open), and cache
  counts the footprint cannot see yet.~~ Done 2026-11-06 on Linux for local
  environments with fake-model Pi sessions, with cache gauges (see
  [Long soak](#long-soak-2026-11-06-linux)). Still owed, in
  [7100](7100-long-soak-follow-ups.md): the same soak with containers, and
  one with a browser reader.
- ~~Two clients with one disconnected; backend and bridge restarts at durable
  transition boundaries; an older backend~~. Done 2026-11-06 on Linux (see
  [Multi-client, restarts and an older backend](#multi-client-restarts-and-an-older-backend-2026-11-06-linux));
  follow-ups in 7120 (retired 2026-11-13, all done).
- ~~Real-browser QA of the Files panel, the coordinator view, validation
  output and hidden-document reconcile~~. Done 2026-11-01
  (`container-files-wiring.spec.ts` and `container-app-wiring.spec.ts`; see
  [Container app wiring, follow-up](#container-app-wiring-follow-up-2026-11-01-linux)).
  Still owed elsewhere: a validation plan written by a real model turn and a
  live running-output stream in a pipeline (the live provider runs, 0049,
  batched in 0031). Real timer throttling in a backgrounded tab was measured
  on 2026-11-13 (task 18, see
  [Background-tab reconnect](#background-tab-reconnect-2026-11-13-macos)).

### Measured candidates

Decide each from the live data; change nothing without evidence. The
2026-10-22 idle A/B decides none of them (the six client-only and
validation candidates were measured on their own on 2026-11-11, see
[Client-only and validation candidates](#client-only-and-validation-candidates-2026-11-11-linux)).
It has no PRs, no GitHub, no
fetching container, a single client, no design canvas, no validation output
and no interactive terminal, so every candidate below except the
feature-planning row read (decided from the deterministic harness on
2026-10-25) is still open. The container fetch failure ladder needs the
routine policy to run first, which new containers never do (see "Container
fetch reach"); it was decided on 2026-11-01 without tuning (decision 11).

- Settled check-rollup backoff (`pr-check-rollup`, 60 s). Waits on live
  GitHub (7568: 0048 task 5), as does the next one.
- A container-scoped PR cooldown. It is per entry today because container
  credential scope cannot be proven from the backend.
- ~~The container fetch failure ladder (5 to 30 min), tuned from
  `git-fetch-container` metrics.~~ Decided 2026-11-01: keep it unchanged. It
  also rate-limits missing-baseline recovery, which every container can
  reach, and the routine fetches it would tune only run for legacy records
  (decision 11).
- The admission pool limits.
- Raising the priority of a queued discovery scan when an interactive read
  joins it; `WorkAdmissionPool` has no re-prioritisation.
- A coarser `mail-retention` deadline (60 s today).
- ~~Sharing Docker availability across clients
  (`DOCKER_AVAILABILITY_POLL_INTERVAL_MS`, 60 s, `apps/web/src/App.tsx`).~~
  Decided 2026-11-11: kept (decision C1).
- ~~A longer quiet interval for the design canvas cursor check
  (`DESIGN_CANVAS_CURSOR_CHECK_MS`, 3 s, `design-controller.ts`), after
  missed-final-hint recovery is qualified.~~ Decided 2026-11-11: kept at 3 s
  (decision C2).
- ~~One shared visible display clock for `useElapsedTimer` and
  `usePromptDeadline` (not profiled).~~ Profiled and decided 2026-11-11: not
  built (decision C3).
- ~~The validation reader's in-environment `bun` spawn per poll.~~ Decided
  2026-11-11: kept (decision C4).
- ~~Demand gating for interactive tmux capture (B19, `tmux-interactive.ts`).~~
  Decided 2026-11-11: needed only for terminals no client detached, done by
  to-do 7745 (decision C5; retired 2026-11-11, the client lease).
- ~~Splitting the validation worker's 500 ms liveness write from changed-result
  writes (B20, `review-validation-worker.ts`), only with cross-process
  crash-recovery and cancellation proof.~~ Decided 2026-11-11: kept (decision
  C6).
- ~~A keyed row read for feature planning's per-record pass.~~ Done
  2026-10-25: `getFeaturePlan` reads one row, and a warm keyed read is served
  from the row cache. Evidence: harness counts unchanged, bytes in "Harness
  effect (2026-10-25)", 3.9 to 4.3 µs against 80.0 to 81.9 µs per pass over
  202 plans, and `storage-read-accounting.test.ts` ("a feature-planning pass
  reads its plan's row, not the whole store").

### Code: after soak

Removal started 2026-11-10: the `backend-activity`, `native-queues` and
`multi-review` rollback drivers are gone (task 13, decisions W2 and W6). Its preparation was done
on 2026-10-25 (`stableJitterMs` moved, the metrics switch decided). The idle A/B on macOS shows the keyed
drivers starting no more often than the rollback drivers, with the same
freshness and no guard lines, and a 10-cycle lifecycle soak left no leaked
footprint, and on 2026-11-06 a 60-cycle local soak over more than an hour
with fake-model sessions open left none either. The busy profile ran on
2026-11-06 (task 1), so the `backend-activity`, `native-queues` and
`multi-review` domains can go (decision B8); live GitHub has not run, so
the `feature-planning` and `build-pipeline` drivers stay. Observation
sharing's switch went on 2026-11-13, once the live providers (0049) had run
(decision Q3).

- ~~Remove the `backend-activity` and `native-queues` rollback drivers.~~
  Done 2026-11-10 (task 13, decision W2).
- ~~Remove the `multi-review` domain together with `WorkflowDueScheduler`
  (`multi-review-scheduler.ts` and its test).~~ Done 2026-11-10 (task 13,
  decision W6).
- Remove `ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK` and the remaining
  whole-store drivers (`feature-planning`, `build-pipeline`), then the switch
  with its desktop allowlist entry (`graph-run`'s rollback only turns graph
  runs off and goes with the switch). Both drivers wait for task 5 (now in
  7568) and 0049
  (decision W7).
- ~~Remove `ORKESTRATOR_NATIVE_OBSERVATION_SHARING` and its allowlist entry.~~
  Done 2026-11-13 (task 13, decision Q3).
- ~~Decide whether `ORKESTRATOR_RECURRING_METRICS` stays as a permanent off
  switch.~~ Decided 2026-10-25: it stays, as a permanent diagnostic kill
  switch rather than a rollback driver (see "Assumptions and decisions"). On
  the 2026-10-22 idle A/B the recorder's cost did not show above run-to-run
  spread (backend CPU 245 to 262 ms/min with it on, 245 to 292 with it off).
- Update the affected `RECURRING_JOB_CATALOGUE` entries in the same change.

## Constraints and rationale

Scheduling architecture, kept from the plan:

- The backend, bridge or external process stays authoritative. Browser demand
  affects presentation reads and optional sampling, never execution or durable
  delivery.
- Scheduler mechanics stay separate from domain decisions.
  `RecurringScheduler` knows keys, deadlines, priority and capacity; PR
  lifecycle, workflow phases, approvals and dispatch journals stay in domain
  services.
- Active indexes and due jobs are rebuilt from durable state at startup.
  Scheduling is in memory; there is no second durable job database.
- Events give prompt reaction; authoritative snapshots reconcile. Reducing a
  safety interval needs explicit missed-event recovery evidence.
- Observation stays separate from attach, hydrate, dispatch and touch.
  Background observers never keep idle threads resident or start bridges.
- Prefer joining equivalent reads over caching results longer. Keys include
  connection and generation, target, identity, options and revision;
  credential-sensitive scopes never share results.
- Older backends and bridges keep working through capability negotiation and
  conservative fallback. A network or auth error is not proof that a
  capability is missing.
- The critical class (lease renewal, approval and auth expiry, watchdogs)
  is never queued behind best-effort work.
- In-process deadlines use monotonic elapsed time; durable expiry keeps
  wall-clock semantics. After a sleep, overdue work reconciles once and missed
  ticks are never replayed.
- No distributed queue, mandatory webhook server, extra database or single
  scheduler spanning backend, bridges and browser. A GitHub webhook
  integration or a container-side watcher may be a later measured experiment;
  both add lifecycle, authentication and recovery duties.

Obligations the keyed drivers must keep when the old drivers go:

- Obligations are named per domain, not inferred from a `running` phase.
  Feature planning owes every active phase. Build pipelines owe result
  consumption in any phase, provisioning, review fan-out, stage progression
  and terminal side effects. Multi review's list is shared by every driver in
  `multi-review-scheduling.ts`. A native queue owes work while pending or
  holding a reserved in-flight head; parked, empty and tmux queues owe
  nothing.
- Wakeups come from workflow-result acceptance, environment readiness and
  identity changes, provider transitions, enqueue and turn-end, queue
  mutations, deletions and explicit commands, with a 30 s discovery pass as
  the safety net.
- A terminal PR entry re-verifies every terminal obligation from storage
  (environment PR state, task status, link, comment and completion flag,
  merge-cleanup intent) before going quiet. The only runtime marker is
  `settledTerminal`; nothing durable claims "all effects done". Transition
  toasts are best-effort and never replayed.

Qualification and rollout:

- No savings claim without live numbers, and no savings percentage promised in
  advance. A migration that adds complexity without measurable benefit is
  reverted or deferred.
- A cadence change must hold its latency budget and record p50/p95 against it.
  Exceeding a budget must be accepted explicitly. Terminal PR discovery
  (within 5 min plus immediate explicit and completion wakes) is the one
  accepted slowdown.
- Never shadow `gh`, Git or provider reads at production scale, and never
  shadow a workflow mutation or prompt dispatch. Measurement must not add the
  load it measures.
- Roll back one policy at a time: disable the new driver before enabling the
  old one, then reconcile once. Indexes and caches may be rebuilt; dispatch
  journals and workflow results must survive. The PR terminal cadence rolls
  back by setting `terminalDiscoveryIntervalMs` to 20 s and
  `terminalDiscoveryJitterMs` to 0 in `DEFAULT_PR_MONITOR_POLICY`.
- Recurrent guard-caught unhandled rejections count as a failure.
- For every background feature: start work in environment A, switch to B, let
  A progress, return, verify transcript, status, pending prompts and controls,
  reload, and verify again. Repeat with two clients and one disconnected.
- `RECURRING_JOB_CATALOGUE` describes the system as it is: a cadence or policy
  change updates its entry in the same change, and the code cites the
  inventory's B, C and L IDs.

Storage accounting, settled at `9906db30`:

- Storage is charged by what the caller got, not where the rows came from.
  A `storage-read` is stored content decoded for a caller (a whole store, one
  owner's rows or one row), even when the connection's revision-validated
  row cache serves it. A `storage-stat` is a revision or stat check that
  reuses values already decoded: a write diffing against cached rows,
  `storeRowStats`, the build-pipeline control-record and live-tag caches, and
  the file stat cache. A database fetch for an internal lookup is still a
  read. `StorageDatabase` reports `read` or `stat`, and `storage-stores.ts` maps
  them one to one.
- Why: the counter exists to catch extra reads. A cached whole-store read
  still parses every row, and whether the cache is warm depends on unrelated
  writes, so a physical-fetch count cannot catch a pass that reads twice.
  The rejected alternative kept a cache hit as a `storage-stat` beside
  physical reads. An extra whole-store read would then show only as a stat,
  and `storageReads` would stay near zero for whole-store readers.
- The `cache-hit` attribution only partly explained the drop. At `9906db30`,
  before the fix, the default workflows block (200 completed, 2 active,
  10 min; rollback/keyed) read feature planning 0/0, build pipelines 4/4 and
  looped review 6,005/6,015. Its stats were 1,800/1,223, 5/10 and 601/22.
  The #852 artifact read 1,800/1,223, 1,200/823 and 6,604/6,035. So
  `cache-hit` explains feature planning exactly and looped review to within 2
  (its other reads are keyed row reads). It does not explain build pipelines.
  Their reads moved into the decoded control cache (`buildPipelineReadCache`)
  that #875 added, whose hits charged nothing. They dropped at #875, not
  #969. "`storageReads` = 0 in both modes" was true only of feature planning.
- After the fix, the same block reads feature planning 1,800/1,223, build
  pipelines 8/12 with 1,203/827 stats, and looped review 6,606/6,037. That
  matches #852 apart from the build-pipeline split and a few startup reads.
  Storage counts do not grow with retained history. Injecting one extra
  cache-served read into `getFeaturePlan` takes rollback feature planning to
  450 against its budget of 270.

## Open questions

Both questions were answered on 2026-10-25; see "Assumptions and decisions".

- ~~Are about three weeks of soak since #852 enough to retire the rollback
  drivers, or does retirement wait for the live profile?~~ It waits for the
  busy live profile.
- ~~Should the Claude terminal-state poll (B18) be measured first?~~ Yes, in
  [0020-container-state-observation.md](../containers-and-environments/0020-container-state-observation.md),
  which owns B18. On the macOS idle A/B it was 59.9 of 63.9 `docker exec`
  calls per minute, in both arms.

## Needs verification

- ~~Whether open flake 0177 (`recurring-baseline.test.ts` timeout) is
  load-only.~~ Verified 2026-10-25: load-only, and resolved. The case costs
  about 1 s on this host; half its wall time was 480 clamped `setTimeout(0)`
  waits, which stretch under load. The tick now yields with `setImmediate`
  (identical counts on both fixtures, 1284 to 1347 ms → 785 to 881 ms per
  run) and the case has an explicit 30 s timeout. Evidence in
  [0177](../../tests/flaky-tests/native-agents-and-transcripts/0177-driven-observation-baseline-timeout.md#resolution--2026-10-25).
- Whether the counters now match Docker for an open claude-tmux tab, and
  what one native Claude session costs the activity sweep, live. From
  to-do 7567 (retired 2026-11-11), which added the `tmux-tab-loop` kind
  (B30), stopped the change-evidence pull repeating an acknowledgment the
  bridge had already accepted, and observed `change-evidence-pull` as its
  own kind; each is proven by a deterministic test
  (`tmux-exec-count.test.ts`, `service-evidence.test.ts`), not live. Rerun
  `scripts/container-tmux-tab-live.ts` and `scripts/human-prompt-reads-live.ts`
  ([testing guide](../../development/testing-guide.md#a-claude-tmux-tab-in-a-container-and-per-item-counts-on-a-busy-profile)):
  `tmux-tab-loop` plus `tmux-poll` should account for Docker's
  `docker exec` count within the tab cleanup's share (7531), and
  `native-activity-sweep` should make about one provider request per read
  pass (36 a minute idle and 89 to 90 working before), with
  `change-evidence-pull` carrying about one more. Not run on 2026-11-11:
  the build host's session could not reach the Docker socket (its user is
  not in the `docker` group). This needs a host where the agent can reach
  Docker, not the user.

## Assumptions and decisions

### Tasks 16 and 19–21: review repair (2026-11-06)

Keep the omitted qualifications explicitly open; no live results are inferred
from their migration. Task 16 now requires silence through watchdog expiry and
retry observations. Task 21 preserves the docs-only boundary by naming all four
source-comment replacements as follow-up work.

Recorded 2026-10-25 by the worker that implemented this file's code items.

1. **Rollback driver retirement.** Options: retire now on about three weeks
   of production use since #852; or wait for the busy live profile (live
   GitHub, providers, a long soak). Chosen: wait. Why: the only live data is
   an idle, credential-free profile and a 10-cycle soak. Neither exercises an
   active turn, a workflow completion or PR monitoring, which are exactly
   the obligations the keyed drivers must keep, and the constraints below say
   to roll back one policy at a time with evidence. Pros: the switch stays a
   one-variable rollback if a busy-profile bug appears. Cons: two code paths
   per domain stay, and the rollback drivers keep needing upkeep. To make the
   eventual removal cheap, `stableJitterMs` moved now.
2. **`ORKESTRATOR_RECURRING_METRICS`.** Options: delete it with the rollback
   drivers; or keep it as a permanent off switch. Chosen: keep. Why: it is a
   kill switch for diagnostics, not a scheduling rollback. It costs one
   startup read and a branch per record, and its recorder cost was not
   measurable above run-to-run spread on the idle A/B. If the recorder ever
   faults or costs more on a busy profile, it is the only way to rule it out
   without a rebuild. Pros: a cheap safety valve; A/B arms stay possible.
   Cons: one more environment variable in the desktop allowlist, and a path
   (metrics off) that only the A/B exercises.
3. **B18 first.** Options: measure the Claude terminal-state poll before
   the other candidates; or keep it in queue order. Chosen: measure it first,
   in its owning file 0020. Why: it was 59.9 of 63.9 `docker exec` calls per
   minute per idle container in both arms, far above everything this file
   still lists. Pros: the largest remaining idle cost is decided first.
   Cons: none here; the work belongs to 0020.
4. **Feature-planning keyed read without live data.** The measured
   candidates say "change nothing without evidence". Options: wait for a busy
   live profile; or take the harness and a benchmark as the evidence.
   Chosen: implement. Why: the change is a read-path optimisation with no
   cadence or policy change, so it has no latency budget to hold. The
   deterministic harness proves its counts are unchanged, and the benchmark
   proves the per-pass cost (one row against every plan). Pros: O(row)
   passes. Cons: none measured; a keyed read takes a SQLite query when the
   cache is cold, which is the cost every other keyed read already pays.
5. **Keyed row reads from a warm cache.** Options: always query the one row;
   or take it from the connection's row cache when that cache holds the
   committed revision. Chosen: the cache when warm, and a one-row query
   otherwise that does not fill the cache. Why: without it, moving
   `getFeaturePlan` to a row read would have turned zero bytes fetched per
   pass (warm whole-store cache) into one row per pass. The revision is read
   in the same transaction as the cache check, and every write path already
   clears or replaces the cache, so correctness is unchanged; the accounting
   rule (a read is a read, bytes only for fetched content) still holds.
   Pros: looped and Multi Review passes fetch 4 to 5 times fewer bytes. Cons:
   a keyed read's bytes now depend on whether some other reader warmed the
   cache, as whole-store reads already did.
6. **Container fetch policy qualification.** The "branch-baseline
   container" sub-item assumed the fixture could make one. Every new
   container compares against its creation commit, so it cannot. Options:
   add a fixture hack that clears `createdFromCommit`; narrow the item to
   what real environments can reach; or remove the routine policy. Chosen:
   narrow it, and leave removing or keeping the routine policy to the run
   that qualifies it. Why: clearing a durable field through a side door would
   qualify a state users only reach by an old record or a failed capture, and
   removing a policy needs the evidence this file asks for. Pros: no test-only
   backend surface. Cons: the routine path stays unqualified live.
7. **Soak driver placement.** Options: a new script; or a phase of
   `recurring-live-ab.ts`. Chosen: a phase (`--soak-cycles`). Why: the A/B
   script already owns the profile lifecycle, the ownership checks before any
   destructive command, the signal handling and the guard-line count; a
   second script would copy all of it. Pros: one tested lifecycle. Cons: the
   script grows, and a soak always runs after an (optionally short) sampling
   window.
8. **Soak leak rule.** Options: compare single samples; or compare the
   highest of three readings before against the lowest of three after a
   settle. Chosen: the latter. Why: running jobs, due keys and admission
   leases move every few seconds, so a single sample would report a job that
   happens to be running as a leak. A real leak survives every reading.
   Pros: no false alarms from transient work. Cons: a leak smaller than the
   baseline's own swing is hidden until it grows; a long soak shows it.
9. **Flake 0177 timeout.** Options: only remove the timer clamp; only raise
   the timeout; or both. Chosen: both. Why: the clamp was a real share of the
   wall time and its removal keeps the counts identical, but the case still
   spins up four real on-disk stores, and isolated failures happened at load
   averages this host reaches routinely. Its sibling workflow baseline
   already carries 60 s for the same reason. Pros: no more load-only
   failures; assertions are unchanged. Cons: a real hang now takes 30 s to
   fail instead of 5.
10. **Provenance comments.** The "recurring-processes step NN" comments that
    point at deleted plans span about 60 sites in web, backend and test
    files. Options: sweep them now; or leave them. Chosen: leave them, except
    in the files this change already touched. Why: they are harmless, and a
    cross-area sweep collides with parallel work for no behaviour change.
    Pros: a small, reviewable diff. Cons: the drift stays.

Recorded 2026-11-01 by the worker that ran tasks 3 and 4 live on Linux.

11. **Keep or remove the routine container fetch policy.** Options: remove it
    (the recommendation, unless a pre-capture record turned up); keep it and
    qualify it on a legacy record; backfill `createdFromCommit` by migration,
    then remove it. Chosen: keep it unchanged, and keep the failure ladder
    (5 to 30 min) as it is. Why: it ran live as designed (one fetch per 5 min
    per legacy container, cache hits in between, the badge followed a moved
    base in 4 min 44 s), and new containers never reach it (0 records). Removal
    saves almost no code: explicit refresh, merge invalidation and recovery
    share its records, admission and cooldown. Recovery's rate limit *is* the
    failure ladder, and every container can reach recovery. What removal would
    take away is one clause (a key is due again once the cooldown passes), and
    with it a legacy environment's badge would silently stop following its
    base branch until a manual refresh. Whether such records exist in real
    installs could not be checked: this run may not read the real data
    directory. Pros: no behaviour change for legacy records; nothing to
    migrate. Cons: a path that only legacy records reach stays, and it needs
    a hand-made record to test live. The backfill was rejected because a
    guessed baseline could change an old environment's diffs.
12. **Making the legacy record.** Options: a fixture flag that clears
    `createdFromCommit` (decision 6 rejected that); or edit the disposable
    profile's database by hand with the backend stopped. Chosen: the hand
    edit, recorded in the live evidence. Why: it adds no test-only surface to
    the product, and the record it makes is the real legacy shape
    (`setupScriptsComplete` set, no `createdFromCommit`). Pros: no code. Cons:
    not repeatable by a spec; the next qualification repeats the edit.
13. **Where to skip the revert fetch.** Options: in `revertContainerFile`
    (skip when the target is a full SHA); or in the policy's
    `refreshForAction` (skip when the latest scan of the same container
    generation and clone classified the ref as `commit`). Chosen: the policy.
    Why: the policy already owns "a commit baseline never fetches", and only
    it knows the commit is present in this clone. A SHA alone does not prove
    that: a recreated clone may lack it, and then the fetch is still worth
    one try. Pros: one owner for the rule; any later action caller gets it.
    Cons: an action before the first scan of a container still fetches once
    (the Files panel always scans first, so a revert never does).
14. **Hidden-document emulation.** Options: background the tab for real (a
    headless browser has no window to hide); or override
    `document.visibilityState` and dispatch `visibilitychange`, which is
    exactly what the read coordinator and `useFilesPanel` read. Chosen: the
    override. Pros: deterministic, and it works headless. Cons: a real hidden
    tab also throttles timers; the spec does not cover that throttling (the
    0051 and iOS runs, task 8, do).
15. **Missed final invalidation.** A tree revision announced while hidden is
    skipped and never announced again; recovery is the coordinator's resume
    reconcile (it resets quiet backoff to the 5 s cadence) and the next poll.
    Options: mark the panel's read dirty when it skips an announcement, so
    return reads at once; or keep the bounded poll recovery. Chosen: no code
    change. Why: it measured about 3 s after return, within one 5 s poll, and
    the Changes tab of a current backend is the event-driven projection,
    which does not skip. Pros: no new state in the panel. Cons: up to one
    poll interval of staleness on return for the tree and for containers.
16. **Merge from the UI and validation output.** Options: build fakes (a
    fake `gh`, or a seeded validation record) to drive them here; or leave
    them to the runs that have the real dependencies. Chosen: leave them.
    Merge goes with live GitHub (task 5) and validation output with the live
    provider runs (0049, batched in 0031). Why: both UI paths need state only
    a real PR or a model-planned review creates, and a fake would qualify the
    fake. Pros: no test-only product surface. Cons: task 4 stays partly open.
    Superseded by decisions 20 and 21: review did not accept leaving them
    open.
17. **The two harness problems this run hit.** A `--fixture` restart orphans
    the previous start's environments, and `dev:test` opens Electron on the
    Linux desktop. Options: fix them here; or record them. Chosen: record them
    as 2180
    and [2181](../cross-cutting/2181-dev-test-electron-opens-on-the-linux-desktop.md).
    Why: both change behaviour every browser suite relies on and are outside
    this file's scope. The workarounds used here are in those files.
18. **Coordinator view depth.** Without a delegation the Coordinator tab lists
    nothing per environment, so the spec only proves it opens beside
    container environments, across a switch and a reload. Options: run a
    coordinator delegation (provider turns); or accept the smoke check.
    Chosen: the smoke check. The delegation path is covered by
    `coordinator-live.spec.ts`, which needs credentials. Superseded by
    decision 22.

### 19. Task 4 acceptance after review

Task 4 remains open. This repair accepts only the fetch-skip correctness fix
and the Files-panel regression test improvements. It does not complete task 4
or the overall qualification ticket. UI merge and validation-output QA remain
required in the live GitHub and provider runs (task 5 and 0049 respectively);
coordinator qualification still needs more than opening, switching and reload.
The original hidden-return pass did not observe the revision while hidden and
is not sufficient evidence of missed-event recovery. The revised spec waits
for the renderer's authoritative revision store to advance before returning.

Repair rerun (2026-11-01): profile `review-wiring-fix`, disposable local and
container fixtures with no agent credentials. Command:
`ORKESTRATOR_AGENT_TEST_PROFILE=review-wiring-fix ORKESTRATOR_AGENT_TEST_DOCKER=1 mise run test:logged -- --name wiring-fix -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts container-files-wiring.spec.ts --workers=1`.
All 3 tests passed in 107.1 s, including revision-observed hidden-return,
no-fetch UI revert and coordinator smoke. Results:
`output/agent-testing/review-wiring-fix/browser/results.json`. Profile stopped
and reset; its two exact-owner containers were removed. Visibility is still
emulated, so this does not qualify browser timer throttling.

Options: keep the task open with these explicit evidence limits (recommended:
accurate acceptance, but needs later live runs), or claim completion from smoke
coverage (less work, but does not establish the required behavior). Chosen:
keep it open and narrow this repair's acceptance to the regressions above.
Closed by the follow-up below (decisions 20 to 23), which checks the three
remaining cases in a real browser.

Deterministic repair validation also completed: the policy and real-Git caller
files passed, targeted backend and agent-spec type checks passed, and
`ORKESTRATOR_TEST_ALLOW_CONCURRENT=1 ORKESTRATOR_TEST_WORKERS=2 mise run test`
passed all four default-tier groups in 190.3 s (exit 0). The documented
concurrent opt-in was used after cancelling an exclusively queued attempt;
no other worktree's processes were stopped. Separate rerun output is at
`/tmp/ork-review-fix-tests-concurrent.log`; original review artifacts are unchanged.

Recorded 2026-11-01 by the worker that closed task 4's remaining cases.

20. **Merge from the UI without GitHub.** Options: wait for live GitHub
    (task 5); a fake `gh` on the host; or a stand-in `gh` inside the test
    container. Chosen: the stand-in in the container
    (`e2e/agent-testing/container-fake-gh.sh`, installed in `/usr/local/bin`
    for the test and removed after). Why: for a container every `gh` call (PR
    monitor, merge, state read) runs inside it through `docker exec`, so the
    host binary never takes part, and the app path from the PR monitor to the
    toolbar, dialog, `merge_environment_pr`, stored state and other views is
    unchanged. The stand-in merges with plain Git into the fixture's bare
    origin, so the effect is real too. Pros: no product change and no test
    side door in the app; it runs in `test:agent:docker`. Cons: GitHub's own
    behaviour (mergeability, rate limits, auth, latency) is not covered, and
    the stand-in answers only the calls the app makes today, so a new call
    fails the spec until the stand-in learns it. Real GitHub stays with
    task 5. Merge & Cleanup was not clicked: it deletes the fixture
    environment.
21. **Validation output without a model turn.** Options: wait for the live
    provider runs; seed a Multi Review row in SQLite with the backend
    stopped; or run real commands through `start_review_validation` and
    import a pipeline record naming the run (`import_legacy_build_pipelines`,
    in the `failed` phase so no supervisor pass starts a turn), adding its
    Build tab through `save_pane_layout` as `ensureBuildPipelineTab` would.
    Chosen: the last. Why: the output is real (written by the worker in the
    container, read back through `get_review_validation_output`), and both
    commands are supported entry points; a hand-written database row would
    bypass leases and change notifications. Pros: the UI path from the Build
    tab to the output dialog is the real one. Cons: the plan is
    hand-written, the run had finished before the UI saw it (so the live
    append while a command runs is not covered here; the component suite
    covers it with a mocked reader), and the Multi Review tab, which renders
    the same component, is not separately opened.
22. **Coordinator depth without a turn.** Options: keep the smoke check; run
    a credentialed delegation; or drive the state a delegation creates
    through owner commands (`open_coordinator_delegation` with a worker tab
    that has no session, a branch switch plus `get_project_git_status`, and
    stopping the workers). Chosen: the commands. Why: they change exactly
    what the view shows (the awaiting-workers badge, the context revision and
    notice) through the backend's own storage and events, so the view's
    inactive, hidden, reload and two-window paths are tested for real. The
    main conversation never gets an agent, and a closing delegation's notice
    is only stored. Pros: credential-free and repeatable. Cons: mail tiles,
    worker prompts and the conversation itself need a turn and stay with
    `coordinator-live.spec.ts`. The test stops and restarts both fixture
    environments, and counts delegations an interrupted earlier run left
    open.
23. **Build tab losing the selection to the seeded terminal (bug, fixed).**
    A pipeline started on an existing environment that has no persisted
    layout (a renderer persists one only on a change, so a container whose
    tabs were never rearranged has none) gets one holding only its Build tab,
    selected. The renderer then seeds its default terminal, which selected
    itself and was persisted, so the user, and every other window, landed on
    a new terminal instead of the pipeline. Options: select the build tab
    again after seeding; or let `addTab` add a tab without selecting it and
    seed that way when the pane's selected tab is a build tab. Chosen: the
    latter (`addTab(…, { activate: false })` in `paneLayoutStore.ts`, used by
    `TerminalContainer.view.tsx`). Why: one store write, so no window sees or
    persists the wrong selection in between. Pros: the backend's selection
    survives; other seeding paths are unchanged. Cons: one more option on
    `addTab`. Tests: `TerminalContainer.view.test.tsx` ("keeps a restored
    build-only layout's build tab selected while seeding the terminal", which
    fails without the fix), `paneLayoutStore.test.ts`, and the validation
    case of `container-app-wiring.spec.ts`, which starts from no persisted
    layout and checks the persisted selection.

### Task 10: long soak and cache gauges (2026-11-06)

24. **What the cache gauges count, and where they live.** Options: entry
    counts for the worktree snapshot and row caches only, as task 10
    proposed; every cache an owner keeps per environment or per session,
    reported through one registry; or heap snapshots during the soak.
    Chosen: the registry (`addCacheSource` in `recurring-diagnostics.ts`),
    with five sources: `storage-row-cache`, `worktree-snapshots`,
    `local-git-scan`, `native-projection` and `change-tracking`. Why: the
    soak is meant to find a map that grows with every session or
    environment ever seen, and the projection and change-tracking maps are
    where those live; heap snapshots name no owner and contain content.
    Pros: content-free by construction (the registry drops any field that
    is not a short identifier or a finite count, and bounds sources and
    fields); owners register and unregister with their own lifetime, so a
    leaked owner shows as an extra source. Cons: a cache nobody registers
    stays invisible; the row cache's `bytes` is serialized length, not heap.
    Tests: `recurring-diagnostics-caches.test.ts`,
    `storage-database-cache-gauges.test.ts`,
    `native-agent-projection-cache-gauges.test.ts`,
    `change-tracking/service-cache-gauges.test.ts`, and the worktree case
    in `public-api/test-support.test.ts`.
25. **Agent sessions without a billed turn.** Options: credentialed Claude
    sessions, as task 10 recommended; a credential-free profile with
    sessions that never get a turn; or real Pi sessions whose model is a
    fake endpoint. Chosen: Pi on a fake model. The driver serves an
    OpenAI-compatible endpoint on 127.0.0.1 and writes it into the new
    profile's own Pi `models.json` under the profile's isolated HOME, so the
    real Pi bridge, SDK session files, backend projection and observation
    run, and only the model is fake. Why: this run must make no billed turn
    and touch no real login, and a session that never runs a turn leaves
    the projection and turn paths idle. Pros: free and repeatable, and each
    cycle runs real turns (182 model requests in the first run). Cons: Pi
    alone, so Claude's and Codex's own observation paths are not soaked
    (0049 owns those); Pi runs end `run-unknown` (exit 7), so the driver
    counts a turn only when the fake model answered it.
26. **The deleted-environment projection growth (bug, fixed).** The first
    run found `projections`, `projectionRevisions`,
    `projectedMessageSessions` and `projectionEpochs` rising by one per
    deleted environment, to 62 after 60 cycles. Options: release them at
    environment deletion; or add a byte bound to the projection cache.
    Chosen: release at deletion (`forgetEnvironmentProjections`, called by
    `deleteEnvironment` after the session records go, and
    `NativeAgentTranscriptProjection.forgetEnvironment`). Why: nothing can
    read a deleted environment's sessions again, and the count-only bounds
    (1,024 projections of up to 16 MiB each) would otherwise hold them
    until churn. Pros: reuses `invalidateProjection` and its epoch fence.
    Cons: sessions are found through the cached projections' inputs (the
    key is a hash), so one read only through the progressive path is left
    to that path's own bounds. Tests: the release case in
    `native-agent-projection-cache-gauges.test.ts` and the ordering case in
    `commands-environment-cleanup.test.ts`; live, the fixed run kept them at
    the two long-lived sessions (see Long soak). Three other projection
    maps have no eviction at all but stayed at zero without a browser
    reader; they are [7100](7100-long-soak-follow-ups.md) task 3.
27. **Containers left out of the long soak.** Options: free the host's
    Docker address pools first; run on another host; or soak local
    environments only and record why. Chosen: local only. Why: 29 of the
    daemon's 34 networks were unattached reach-probe networks from other
    backends (created 2026-10-31 to 2026-11-02), `dev:test` with a
    container fixture failed with `resource-exhausted`, and this work may
    neither prune networks nor remove what it did not create (0241 task 5
    leaves that sweep to the user). Pros: the acceptance soak still ran.
    Cons: container lifecycle, signal and fetch records were not soaked for
    an hour; that is [7100](7100-long-soak-follow-ups.md) task 2.
28. **The driver's own failures on this host.** Three attempts stopped
    early, each fixed with a test, none a product bug: the container
    fixture above; a toolchain download that failed with
    `ERR_NETWORK_CHANGED` (an agent-test profile exits when it cannot
    prepare its toolchains), answered by `--agent-platforms pi`, since Pi is
    seeded from the host; and `agent options` refusing the `--timeout` the
    soak appended, so the fake model was never listed. The 2026-10-25
    `dev:stop` failure also recurred: `dev:stop` gives up about seven
    seconds into the launcher's shutdown, before the launcher records
    `stopped`, so the driver skipped the reset. It now waits for its own
    launcher to exit before judging the stop (`recurring-live-ab-runner.test.ts`,
    "a stop that gives up while the launcher is still exiting waits for it,
    then resets").

### Task 11 (2026-11-06)

Recorded by the worker that ran task 11. Numbered T11.n so they do not collide
with other tasks' decisions.

- **T11.1 Public transcript `complete` on a restart preview (bug, fixed).**
  The first `session.transcript` read after a backend restart answered
  `messages: []`, `freshness: "cached"`, `truncated: true` and
  `complete: true` for a conversation with three rows: a restarted Claude
  bridge's first preview holds no rows and no history cursor, and the action
  derived `complete` from the missing cursor alone. Options: report
  `complete` only when the view's own `historyComplete` says so; or hide the
  preview and wait for the hydrated view. Chosen: the former
  (`actions-transcript.ts`). Why: the contract says `complete` means no older
  history exists, and the view already states that; waiting would hold a read
  open on a bridge. Pros: one condition; a cached empty page now reads as
  incomplete. Cons: a reader that treated `complete` as "nothing more to
  fetch" re-reads once. Test: `public-api-launch.test.ts` ("a restart preview
  with no rows and no cursor is not complete", which fails without the fix).
- **T11.2 Agent CLIs outliving a bridge that died (bug, fixed).** A bridge
  killed or crashed mid-turn left its Claude CLI running, still on the turn
  the user was told had stopped: against a real provider it would finish (and
  bill) that turn and write into the conversation the next bridge resumes.
  `terminateProcessTree` finds descendants by parent pid, which only works
  while the bridge is alive, and the exit handler only logged. Options: reap
  the dead bridge's process group on an exit nobody asked for; make each
  bridge bind its CLI to its own lifetime; or both. Chosen: the group reap,
  for every local bridge kind (`reapProcessGroup` in `process-tree.ts`,
  `reapAfterUnrequestedExit` in `local-server-runtime.ts`, called from the
  bridge exit handler in `commands-servers.ts`). Why: the backend spawns each
  bridge `detached`, so the group is its own to signal (AGENTS.md), and one
  place covers all five bridges and OpenCode. SIGTERM, 2 s, then SIGKILL; an
  empty group answers ESRCH, and Linux does not reuse a pid that still names
  a live group. It is off when a test substitutes `spawn`, so a fake child's
  pid is never signalled as a group. New essential event
  `bridge.orphans-reaped` (`warn`, `error` if one survived). Pros: no bridge
  change, works for a bridge of any age. Cons: a CLI that leaves the group
  (none does today) is not reached. Tests: `process-tree.test.ts` (unit cases
  and a real SIGKILLed detached leader whose child is stopped),
  `local-server-runtime.test.ts`, `log-essential.test.ts`; live, the bridge
  case now sees the held call aborted.
- **T11.3 Fake model rather than real providers.** Options: a loopback
  Anthropic endpoint behind the real Claude CLI; the bridges' in-process fake
  engines (Pi, Cursor); real providers. Chosen: the loopback endpoint. Why:
  the ticket forbids billed turns, and the in-process engines need a test
  host rather than a `dev:test` profile, while the CLI path keeps the real
  bridge, CLI, journal and resume. Cons: Claude only; Codex and OpenCode
  restarts stay with 0049 and the cold-restart spec.
- **T11.4 Older backend from source.** Options: build v2.21.0 from its tag in
  this worktree; install the published npm package; record it as not run.
  Chosen: the tag, under `output/` (git-ignored), with its own data and home
  and Docker unreachable. Why: no external download beyond the frozen
  lockfile's packages, and the tag is the release. Cons: it ran the current
  Claude CLI rather than its pinned one; the launcher was not committed then; since 2026-11-13 it is
  `scripts/older-release-stack.ts` (7120 (retired) task 5,
  [Checking a pairing live](../../architecture/version-compatibility.md#checking-a-pairing-live)).
- **T11.5 What counts as a durable boundary here.** Local bridges die with
  their backend, so "restart mid-dispatch" for a local environment is always
  "turn interrupted": the boundaries qualified are the dispatch accepted with
  the provider working (held call), the prompt queued durably, and the result
  arriving after the restart (the follow-up and the queued prompt). Review
  added a separate result-accepted case for both backend crash and bridge
  restart: wait for the answer and settled turn, restart, recover the answer
  after opening and reloading, continue with the earlier prompt in context,
  and require exactly one original provider dispatch. This qualifies recovery
  of an already settled result; it does not inject a crash between accepting
  a provider result and publishing the settled turn.
  A container bridge outlives a backend restart and is not covered here; it
  belongs with the Docker runs in 0031.
- **T11.6 Review coverage.** The restart cases now await held-call abortion
  before continuing and assert the earlier prompt is present in the next
  provider request's context. Context stays in memory and is not written to
  evidence. The command integration tests inject a reaper to check the actual
  exit callback and verify replacement-start termination bypasses it. The
  public transcript regression pages to the start of an incomplete window
  without a history cursor and requires every page to remain incomplete.
  Targeted validation on credential-free profile `q48-fix-fe80`: both backend
  held-turn restart cases passed; the bridge case initially failed because
  it killed the bridge after rendering an answer without waiting for idle.
  After adding the idle-state barrier, the bridge case and both new
  result-accepted cases passed (3/3). The profile was stopped and reset.
  Focused command-exit and public transcript tests passed (18/18), as did
  fake-model tests (9/9), the documentation task-surface guard and Playwright
  spec loading. Earlier review-wide failures remain separately recorded.

### Tasks 1, 2, 7 and 19 to 21 on macOS (2026-11-06)

Recorded by the worker that ran these tasks on macOS. Numbered Mn so they do
not collide with other tasks' decisions.

- **M1 Where the watched-badge budget starts (tasks 2 and 7).** The budget is
  "≤ 2 s after the save settles", and the probes time from the write.
  Options: compare against 2 s from the write (strict, but not the budget:
  it failed 19 of 20 packaged saves that met it); move the clock to the
  settle (needs the backend's settle time in the browser); or compare
  against 2 s plus the 400 ms `WATCH_SETTLE_MS` from the write. Chosen: the
  last, in both specs, asserted on the p95 of 20 saves rather than on each
  one. Why: it is the documented budget measured from what a probe can see.
  The run also showed that back-to-back saves wait out the 2 s
  `LOCAL_SCAN_MIN_GAP_MS`, which the budget table's "Nominal today" did not
  mention; it now does.
- **M2 What "a burst converged" means past the scan cap (task 7).** The
  backend line-counts at most `UNTRACKED_SCAN_MAX_FILES` (2,000) untracked
  files per scan and marks the count approximate, so a burst over 2,000 can
  never show `+N`; the first probes waited for that and timed out. Options:
  read the backend's projection (not what the client sees); or count the
  burst as shown when the badge turns approximate and prove coverage by
  removing it and waiting for the exact earlier count. Chosen: the second.
  Why: an exact return after a mass removal is only possible if the last
  events were seen, and both checks are on the page.
- **M3 The Changes tab's Refresh never fetched a container's base (task 19,
  bug, fixed).** The Changes tab is served by the change projection, whose
  Refresh calls `changes_refresh`; that asked the scan owner for a rescan
  (`DiffStatsService.refresh`) and never invalidated the container fetch
  policy, unlike `get_git_status` and `refresh_environment_diff_stats`. On a
  legacy container the user's Refresh could not move a stale or moved base;
  only the 5 to 30 min cooldown could. Options: invalidate in the
  `changes_refresh` command (needs an async storage read per refresh); or
  give `DiffStatsTracking` one `refreshExplicitly(environmentId)` that
  invalidates a tracked container's fetch records as `explicit` and then
  scans, used by both explicit commands. Chosen: the second, wired through a
  separate `requestExplicitEnvironmentRefresh` so that change tracking's
  other rescan (after a restore) does not ask for a fetch. Why: one place
  decides what an explicit refresh means, and the order (invalidate, then
  scan) is what lets the scan find the fetch due. Tests:
  `diff-stats-explicit-refresh.test.ts` and "a manual refresh asks the scan
  owner for an explicit refresh, not a plain rescan" in
  `change-tracking/service-environment.test.ts`; the live spec now passes.
- **M4 How to fail a remote read (task 19).** Options: a firewall or network
  change (forbidden here); stopping the bind-mounted origin; or pointing the
  container's `origin` at a missing path for that step and restoring it in
  `finally`. Chosen: the URL. Why: it is local to the container, needs no
  privilege and is undone by the spec itself. It yields the `no-remote`
  category; `auth`, `network` and `timeout` failures were not exercised.
  The legacy record was made by hand as in decision 12.
- **M5 Signalling the watch helper (task 7).** The helper is a `bun -e`
  child of the backend. Options: find it by name (forbidden on a shared
  host); or take the backend pid from `dev:status` (or the packaged app's
  own process tree) and signal only a child of it whose pid, parent and start
  time are re-read just before the signal. Chosen: the second. The watcher
  script signals only the helper it spawned.
- **M6 The container refresh tail (task 2).** The Changes refresh follows a
  scan already running and then needs its own, so about one refresh in
  fifteen took 1.3 to 2.2 s against a 1 s budget. This is deliberate (a
  running scan may predate the click), so it is a budget decision, not a
  defect fixed here: 7201
  holds the options, recommending a budget amendment. Accepted 2026-11-10:
  the budget row reads "≤ 1 s, or one scan longer when a scan is already
  running", and the spec marks scan-wait qualification unverified on
  that row only.
- **M7 Task 1 not attempted.** Extending task 10's fake-model soak driver
  to the busy profile needs a fake-model turn and approval phase, a
  workflow that completes without a provider, 10 environments and attached
  clients. That is a harness of its own, larger than this run; nothing in it
  needs a real provider, so it stays open rather than blocked.
- **M8 Which reader gaps to fix now (task 20).** The inventory found four
  (7200). Fixed with tests: the desktop
  reconnect ladder's lock-step retries (each delay now drawn from the upper
  half of its rung) and the v2 preview tunnel's ignored pongs (two unanswered
  pings destroy the session). Left: OpenCode's silent stream, which needs a
  live `opencode serve` to see what it sends while idle, and the terminal
  socket's visible-page stall, a traffic-versus-detection choice. Both fixed
  with tests on 2026-11-10 (7200 tasks 1 and 4).
- **M9 Long, quiet live specs and `test:logged`.** The runner ends a command
  that prints nothing for 5 min; the container probe loop is quieter than
  that, which is what killed the first two runs. Options: raise
  `ORKESTRATOR_TEST_NO_PROGRESS_TIMEOUT_MS` per run, or have the spec print a
  content-free line a minute. Chosen: the line, in both new browser specs, so
  the documented command works as written.

### Task 1: busy profile, and tasks 2 and 12 to 18 (2026-11-06, Linux)

Recorded by the worker that ran task 1 on Linux. Numbered Bn so they do not
collide with other tasks' decisions.

- **B1 Where the busy phase lives (task 1).** Options: write it into
  `recurring-live-ab.ts` itself; a sibling module the driver calls behind a
  flag; or a Playwright spec, as task 11 did. Chosen: the flag
  (`--busy-rounds`) and its wiring in `recurring-live-ab.ts`, the phase in
  `recurring-live-ab-busy.ts` and its clients in
  `recurring-live-ab-busy-clients.ts`. Why: the driver already owns the
  profile lifecycle, ownership checks, arms and guard-line count (decision
  7), and it was 1,300 lines, so inlining a phase of about 1,000 would cross
  the repository's 2,000-line limit; a spec would have no A/B arms. Pros: one
  lifecycle, both arms, and the phase is unit-tested without a profile or a
  browser (`recurring-live-ab-busy.test.ts`,
  `recurring-live-ab-fake-model-script.test.ts`). Cons: three files to read
  for one run; the Playwright clients are only exercised live.
- **B2 Which fake model (task 1).** Options: Claude on the loopback Anthropic
  endpoint of task 11; Pi on the OpenAI-compatible endpoint of task 10's
  soak; real providers (forbidden here). Chosen: Pi, with the soak's fake
  model taught three scripts by markers the driver writes into its own
  prompts: `[hold:<id>]` parks the request until released, `[tool:<id>]`
  answers with a `bash` call, and a request offering a Multi Review result
  tool gets a call to it. Why: the driver already starts that model and
  writes it into the profile's own Pi `models.json`, and Pi parks every
  `bash` call under an `ask` policy, so one setting yields a real approval.
  Pros: no credential or login, and real bridge, SDK, journal, projection
  and observation paths. Cons: Pi only; Claude's and Codex's own approval
  and observation paths stay with 0049.
- **B3 A workflow completion without a provider (task 1).** Options: a
  scheduled job firing a prompt (not one of the keyed workflow drivers, and
  behind an experimental setting); importing a pipeline record (no live
  progress); `graph_run_mock` (no provider and no result tool); a Multi
  Review whose every slot is Pi on the fake model. Chosen: the Multi Review.
  The fake model reads the `resultKey` from the prompt and submits fixed,
  finding-free results through the real result tools; for the validation
  plan, which must name the workspace's HEAD, it first runs `git rev-parse
  HEAD` through `bash` and submits what that returned, as an agent would.
  Why: it drives the real path (tool call, acceptance, keyed wake, next
  phase) of the one domain whose rollback is a different scheduler
  (`WorkflowDueScheduler`), and it runs a real validation. Pros: a complete
  review in about 5 s. Cons: no findings, so Address Findings, auto-PR and
  reconciliation are not exercised; feature planning (Codex only) and build
  pipelines (a ticket and a PR step) are not either.
- **B4 Setting and answering the approval (task 1).** The `ask` execution
  policy is not a CLI setting, so `busy-ask` is created through the registry
  (`create_environment` with `agentSettings.executionPolicy.approvals:
  "ask"`), the way the idle-observation spec does. The CLI cannot approve an
  approval that has no questions (`--action answer needs --choose or
  --text`), so the driver answers through the public action
  `session.interaction.resolve` with `action: "answer"`, which the contract
  documents as approving. The CLI gap was 7202 (retired) task 1, fixed on
  2026-11-10 (`--action answer` with no answers approves); not fixed here
  because this change qualifies.
- **B5 The outage and the client resume (task 1).** Options: wait for 0051's
  outage workload (retired with 0051); drop the link for real (forbidden
  here, and task 16); cut one client with the in-process outage link of
  `client-outage-support.ts` and hide the other's document by emulation.
  Chosen: with two clients the second goes through the outage link and is
  cut (`reset`) from just after the mail to the end of the review; with one
  client its document is hidden for the same span. Pros: both resume paths
  in every client round, nothing on the host changes. Cons: the cut is a
  reset, not silence, and the hidden document's timers are not throttled
  (tasks 16 and 18).
- **B6 What each client row times (task 2).** Every row is timed from the
  cause, never from the driver's own command where a better clock exists:
  model-side events (the held turn reaching the model, the tool call, the
  reply after an approval, the queued prompt) use the fake model's own
  arrival time. The first full run read "turn completion visible" from the
  sidebar marker turning idle, and got 2 to 75 ms: the marker can read idle
  before the reply is shown. Options: keep the marker; read the reply row in
  the client's open tab (`[data-chat-message-index]` holding the fake reply).
  Chosen: the reply row, measured in a second, client-only run. The
  background environment's return to idle stays a marker read and is
  reported against the activity budget (≤ 4 s), not as turn completion.
  Workflow progress is read backend-side (`review.get` polled every 50 ms),
  and the validation plan's step is its own row, because its next phase
  waits for the plan's commands, which queue in the host-wide test
  scheduler with every other worktree's tests.
- **B7 The measured candidates the busy profile reaches (task 12).** The
  busy data (numbers in [Busy profile](#busy-profile-2026-11-06-linux)) shows no queueing
  worth a change: `git-docker-scan` waits of at most 86 ms at its 4-lease
  limit, no wait in `workflow-provider` or `external-pr`, no refusal, and
  `mail-retention` at about one start a minute costing one read and one stat.
  Options: keep the limits, priorities and deadline; or change them on this
  evidence. Chosen: keep all three unchanged ("change nothing without
  evidence"). Cons: one host, local environments only, and a fake model, so
  a container-heavy or provider-heavy load could still queue; that would
  reopen them. The other candidates were re-scoped by what they need (task
  12's outcome): two to task 5, the client-only and validation ones to their
  own runs.
- **B8 Which rollback domains the busy profile unblocks (task 13).** Decision
  1 asks for the busy profile, live GitHub and the long soak. Options: keep
  every domain until task 5 has run; or unblock the domains whose
  obligations the busy profile exercised and that own no PR obligation.
  Chosen: the latter: `backend-activity` (sweeps, launch and rename scans
  under 10 environments and clients), `native-queues` (every queued prompt
  sent once after its turn, p95 1.63 s keyed against 2.10 s rollback) and
  `multi-review` (every review to `ready`, progress p95 157 ms keyed against
  4.05 s rollback, over budget). The soak (task 10) covered their
  lifecycles. Removal itself is a separate code change, domain by domain in
  that order as task 13 recommends. Pros: the evidence decision 1 asked for,
  without waiting for GitHub on domains that never call it. Cons: Multi
  Review's Address Findings and auto-PR paths were not run (no findings), so
  its removal should still go last; `feature-planning` and `build-pipeline`
  keep their rollback until task 5 and 0049.
- **B9 The harness's own failures.** Three, none shown to be a product bug.
  The first full attempt stopped when a client did not find Pi's composer
  within 60 s after opening `busy-ask`, and the exception discarded the
  arm's rounds; no screenshot was taken, so the cause is unknown. The client
  now opens the sidebar row by its accessible name (the bare environment
  name also appears in mail and notices). In the recorded run a client's
  page never painted (a module load lost on a busy host; the screenshot was
  blank): the phase now
  reloads a page that has painted nothing in 45 s, at most twice, saves a
  screenshot of a client that cannot open its view, and records a round that
  throws instead of losing the arm (`recurring-live-ab-busy.test.ts`, "a
  round that throws is recorded and the next round still runs"). The first
  smoke run's 210 s review stall was unexplained at the time (7202
  (retired) task 2); each validation run's queue time is now recorded so a
  recurrence can be attributed, and the 2026-11-11 recurrence was (see
  [Related](#related)).

## Related

- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (tasks 5, 9, 16 and 17, and the device run of task 8) moved there on 2026-11-10, and the simulator run of task 8 on 2026-11-13.
- 7745 (retired 2026-11-11): an interactive tmux terminal no client detached
  kept capturing (task 12, decision C5); now leased, row B19 of
  [recurring-work.md](../../architecture/recurring-work.md).
- 7202 (retired 2026-11-14; `git show dc90609bf:docs/todo/transcripts-and-observation/7202-busy-profile-follow-ups.md`): what
  task 1's busy profile found. Task 1, approving from the CLI, was fixed on
  2026-11-10. Task 2, one review that waited 210 s after its validation
  plan, was closed on 2026-11-14 as a wait in the host-wide test queue: in
  its 2026-11-11 recurrence (150 busy rounds on beelink2 at `83731af28`,
  during 7562's reproduction) the waiting validation run spent 623,450 ms
  of 624,533 ms queued and 16 ms running its command, and the profile's
  backend log had nothing about the review. A missed wake cannot hide
  there: the review validation worker polls the scheduler every 100 ms,
  and each poll reaps finished and dead jobs and re-runs admission
  (`review-validation-worker.ts`, `host-test-scheduler.ts`), so a queued
  command waits only while other jobs hold the host's slots, memory or an
  exclusive resource.
- to-do 7200 (retired on 2026-11-10; see [recurring-work.md](../../architecture/recurring-work.md)): the
  reader gaps task 20 found, two fixed.
- to-do 7201 (retired on 2026-11-10; see [recurring-work.md](../../architecture/recurring-work.md)):
  the container Changes refresh tail task 2 measured.
- [7100-long-soak-follow-ups.md](7100-long-soak-follow-ups.md): what task 10's
  long soak left (containers, a browser reader, three projection maps
  without eviction).
- 7120 (retired 2026-11-13; in Git history at the parent of the commit that deleted it (`git log -1 --diff-filter=D -- docs/todo/transcripts-and-observation/7120-multi-client-restart-follow-ups.md`)):
  what task 11's run left for a decision, all since done.
- 0049 (retired 2026-11-11; `git show 498b68766:docs/todo/transcripts-and-observation/0049-native-agent-idle-observation.md`),
  retired `0051-client-reconnect-and-freshness.md` (deleted 2026-11-06;
  remaining checks are tasks 18 to 20 here, and tasks 16 and 17 in 7568) and
  0052 (retired 2026-11-11; [remote-bandwidth.md](../../development/remote-bandwidth.md)): the client and
  observation halves of #852.
- [0020-container-state-observation.md](../containers-and-environments/0020-container-state-observation.md): B18, the
  container Files panel status exec and `containerRevertFileCommand`'s inline
  fetch.
- [0027-multi-review-scale-and-cost.md](../coordinator-and-multi-review/0027-multi-review-scale-and-cost.md): the
  multi-review rollback gates and benchmark.
- [0050-transcript-history-efficiency.md](0050-transcript-history-efficiency.md):
  activity-sweep latency against real bridges.
- [web-page-annotations.md](../../architecture/web-page-annotations.md):
  annotation capture polling (`SELECTION_POLL_MS` in `useAnnotationCapture.ts`)
  belongs with web annotations (formerly todo 0043, retired on 2026-10-29), not
  here.
- [recurring-work.md](../../architecture/recurring-work.md) for the inventory
  (B, C and L IDs), scheduling primitives and latency budgets, and
  [testing-guide.md](../../development/testing-guide.md#recurring-work-harness)
  for the harness method and scenario matrix.
- Living-doc drift to fix: several modules carry "recurring-processes step
  NN" provenance comments that point at deleted plans; harmless.

## Replaces

- `docs/improvements/recurring-processes/plan/00-index.md` (deferral list;
  architecture decisions and trial policy carried into "Constraints and
  rationale")
- `docs/improvements/recurring-processes/plan/01-baseline-and-measurement.md`
  (live profile and instrumentation gaps)
- `docs/improvements/recurring-processes/plan/02-scheduling-and-admission.md`
  (done; trial-limit tuning)
- `docs/improvements/recurring-processes/plan/03-shared-worktree-snapshots.md`
  (qualification, macOS watcher, re-prioritisation; container read cost is in
  `container-state-observation.md`)
- `docs/improvements/recurring-processes/plan/04-container-git-fetch-policy.md`
  (app qualification, failure ladder; the inline revert fetch is in
  `container-state-observation.md`)
- `docs/improvements/recurring-processes/plan/05-pr-monitoring-policy.md`
  (live GitHub evidence, rollup backoff, container cooldown, rollback)
- `docs/improvements/recurring-processes/plan/06-client-read-coordination.md`
  (real-stack QA)
- `docs/improvements/recurring-processes/plan/08-workflows-queues-and-maintenance.md`
  (rollback drivers, multi review in the harness, mail retention)
- `docs/improvements/recurring-processes/plan/09-secondary-client-processes.md`
  (Docker availability, design canvas, display clock, validation reader)
- `docs/improvements/recurring-processes/plan/12-qualification-and-rollout.md`
  (gaps, rollback switches, soak)
- `docs/improvements/recurring-processes/baseline/README.md` (latency budgets
  and trial limits moved to `../architecture/recurring-work.md`, harness
  method to `../development/testing-guide.md`; the live isolated profile
  procedure is above)
- `docs/improvements/recurring-processes/baseline/step-01-baseline.json`
- `docs/improvements/recurring-processes/baseline/step-03-snapshots.json`
- `docs/improvements/recurring-processes/baseline/step-04-container-fetch.json`
- `docs/improvements/recurring-processes/baseline/step-05-pr-monitoring.json`
- `docs/improvements/recurring-processes/baseline/step-07-baseline.json`
- `docs/improvements/recurring-processes/baseline/step-12-final.json`
- `docs/imrovements/recurring-processes.md` (inventory moved to
  `../architecture/recurring-work.md` with current cadences; findings F01 to
  F10 shipped; B19 and B20 are measured candidates above; B18 is in
  `container-state-observation.md`)

## Assumptions and decisions

### Review repair: task 2 workflow visibility

**Problem.** The busy clients stay on the approval tab and do not observe review progress.
**Context.** Backend `review.get` observations cannot complete a client-visible latency row.
**Investigation.** The original workflow timings also paired delayed model callbacks with the next timestamp, which could skip or misattribute results.
**Decisions.** Leave the workflow client row open (recommended): accurately scopes the evidence without adding an unqualified UI path. Adding a review view reader would provide client latency but requires separate live qualification. (Superseded 2026-11-10: the review view reader was added and qualified live, decision W4.) The historical workflow latency values above are withdrawn as qualification evidence, including their use in decision B8 to unblock Multi Review rollback removal; that domain needs a fresh run. Activity and queue evidence is unchanged.

### Tasks 2 and 13 (2026-11-10, Linux)

- **W1 Does task 5 block the `backend-activity` and `native-queues`
  removals? (task 13)** The task list said "depends on 5"; its outcome,
  decision B8 and the index said these two were unblocked. Checked in the
  code: the only GitHub-facing work either driver starts is the coordinator
  PR-watch poll inside the 60 s `coordinator-repair` maintenance and the
  activity sweep's PR refresh after an agent finishes. Both drivers call the
  same functions at the same cadence (2 s; 60 s for maintenance), so live
  GitHub evidence could not tell them apart. Options: keep task 13 blocked
  on task 5; or remove the two drivers now. Chosen: remove them. Pros: the
  evidence decision 1 asked for (busy profile, soak) exists for both, and
  the review repair withdrew only Multi Review's workflow timings. Cons: no
  rollback remains for these two domains if a regression appears; one would
  need a revert.
- **W2 How to remove them (task 13).** Options: delete the domains from the
  switch's vocabulary; or keep them as keyed domains (they label the
  supervisors and the native-queue scheduler's owner) and narrow only what
  the switch can name. Chosen: the latter, `REVERTIBLE_KEYED_SCHEDULING_DOMAINS`
  and a `keyedSchedulingEnabled` that accepts only those, so a call for a
  removed domain fails the typecheck. A stale environment value naming them
  is ignored rather than refused, so an old desktop configuration still
  starts. The rollback-only tests were converted to the keyed drivers rather
  than deleted, where they covered behaviour the keyed tests did not
  (coalescing, the cadence floor, a rejected sweep, repeated init). The same
  change makes a repeated backend `init` arm the shared usage-reading timer
  once: `#2023` re-armed it on every call, which failed the named-jobs test on
  `main`.
- **W3 Where the PR rows of task 2 go.** Options: keep task 2 open until task
  5 runs; or move the four PR client rows into task 5. Chosen: move them.
  Pros: task 5 already owns live GitHub and the stale-marker run (task 17),
  and the same run gives both the backend and the client view of each PR
  row. Cons: task 5 grows.
- **W4 How a client watches a review (task 2).** Options: switch the busy
  client's page from the approval tab to the review and back; open a second
  page in the same context; or open a review view in a context of its own.
  Chosen: a context of its own, signed in with its own one-shot login and
  through the same outage link. Pros: the approval, mail and resume rows keep
  their page; nothing persisted in the browser (selected environment, tab
  state) is shared between the two views. Cons: one more login and page per
  client per round; under load it adds browser work to the host. The view is
  opened before the launch so it watches the first result, and the header's
  phase is read from data attributes so stalled-session copy cannot break the
  measurement.
- **W5 The repaired harness expected a result Multi Review never sends.** The
  review repair (`#1959`) correlated `submit_review_preparation` with
  `reviewing`; that result kind is a build pipeline's. Multi Review submits
  the validation plan, the reviewer reports and the consolidated review. The
  in-memory test harness mirrored the same wrong flow, so its tests passed.
  Fixed in both; the live row now has two progress results per review, which
  is also what the withdrawn 2026-11-06 figures counted (18 for 9 reviews).
- **W6 Remove the `multi-review` rollback driver now? (task 13)** Decision B8
  ordered it after the other two, and the review repair asked for fresh keyed
  timing first. Task 2's two busy runs on 2026-11-10 are that timing (twelve
  reviews to `ready`, every obligation kept, tail in 7557). B8's remaining
  con, that Address Findings and auto-PR never ran live, does not separate the
  drivers: both ran the same locked pass (`runLocked`) with the same due-time
  policy (`nextDelayMs`), and differed only in which timer called it, which
  is W1's argument for the first two domains. The keyed driver's Address
  Findings settlement and background auto-PR are covered by tests on that
  driver. Options: keep it until a live run with findings; or remove it now.
  Chosen: remove it. Pros: one Multi Review scheduler to maintain and test;
  the lease is renewed by one job. Cons: no rollback remains; a regression in
  the keyed driver needs a revert. The 7557 tail is on the keyed driver; the
  rollback's own figure was 3.51 / 4.05 s, so keeping it would not help.
  How: `MultiReviewServiceOptions` omits `keyedScheduling` so a stale caller
  fails the typecheck, and the switch ignores the value as for W2. The
  ticket's wording, "move Multi Review onto `WorkflowDueScheduler`", is read
  as moving it off: `WorkflowDueScheduler` is the rollback driver this task
  removes, and the keyed supervisor already ran by default.
- **W7 Are `feature-planning` and `build-pipeline` ready too? (task 13)**
  Rechecked 2026-11-10. Decision 1 asks for the busy profile, live GitHub and
  the long soak. Neither domain was in the busy profile (they need Codex or a
  ticket-driven pipeline; task 1, "Not covered"), and build pipelines own PR
  terminal effects that only task 5's live GitHub run can qualify. Task 5 is
  still open and cannot run on this host without GitHub credentials. Options:
  remove them on the deterministic harness alone; or keep them. Chosen: keep
  them, and the switch with them. Pros: decision 1 stays the bar for every
  domain. Cons: the switch and two whole-store drivers stay in the code.

### Review repair: task 1 backend workflow timing and recovery

The harness now associates each result submission identity with its tool's expected consuming phase. It requires exactly one submission for each of the four scripted slots and rejects missing, ambiguous or reversed observations. Submission precedes acceptance, so the new row is explicitly an upper bound from submission to backend phase observation, not acceptance latency. Delayed or absent model callbacks cannot silently erase samples. These revised timings have unit coverage but have not been qualified live.

Failed rounds release fake-model waiters and stop both owned sessions. A stop that cannot confirm completion aborts the phase, avoiding reuse of an uncertain session. This adds recovery overhead only to failed rounds; continuing with unresolved approvals could cascade failures. Tests cover a hidden approval in round one followed by a successful second round.

### Task 12: client-only and validation candidates (2026-11-11, Linux)

Numbered Cn so they do not collide with other tasks' decisions. Numbers are in
[Client-only and validation candidates](#client-only-and-validation-candidates-2026-11-11-linux).

- **C1 Share Docker availability across clients?** One `docker info` probe
  costs about 60 ms of CPU, once a minute per visible client; hidden clients
  do not poll. Options: let `check_docker` answer a poll from the backend's
  `DockerAvailabilityCache` while it is under 30 s old, keeping explicit
  retries and startup probes fresh; or keep one probe per client. Chosen:
  keep. Pros: no change to the onboarding and recovery paths that read a
  fresh answer; the saving is about 0.1 % of one core per extra visible
  client. Cons: two visible clients probe twice; reopen if a node routinely
  serves many visible clients.
- **C2 A longer quiet interval for the design canvas cursor check?** An
  unchanged check costs the design service 58 to 96 µs and answers 123 bytes,
  so 20 a minute cost under 2 ms a minute per visible canvas before the
  gateway hop (not measured). Options: lengthen it once missed-final-hint
  recovery is qualified live; or keep 3 s. Chosen: keep 3 s. Pros: the check
  is the recovery path for a missed final hint, and lengthening it would
  slow that recovery for a saving of well under 0.01 % of a core. Cons: the
  gateway's share of each check is unmeasured; it would have to be two
  orders of magnitude larger to change this.
- **C3 One shared visible display clock?** In headless Chromium the real
  hooks cost 2.2 ms of script a second at 10 running clocks against 0.3 ms
  for a shared clock, and 4.8 ms against 0.7 ms at 200. Options: build a
  reference-counted shared clock; or keep one interval per running clock.
  Chosen: keep. Pros: each clock stays local to the small component that
  shows it (the reason `LiveElapsed` exists), and the saving is about 0.2 %
  of the main thread at a realistic count. Cons: one run, headless, on Linux;
  a page showing hundreds of live clocks would reopen it.
- **C4 Stop spawning `bun` for each validation output poll?** A local poll is
  about 10 ms of CPU, a container poll adds a `docker exec` (60 to 70 ms), at
  2 s, and only while the output modal is open on a running result. Options:
  read local output in the backend process and keep the in-environment reader
  for containers; or keep one reader for both. Chosen: keep. Pros: one reader
  whose confinement and offset rules are the same for both kinds of
  environment; the cost is paid only while a person watches the output.
  Cons: about 4 % of one core for a watched container run; reopen if the
  modal is shown by default.
- **C5 Demand gating for interactive tmux capture (B19)?** An attached pane
  is captured at 250 ms to 1 s; locally that is about 0.2 % of a core, but a
  container capture is one `docker exec`, so an idle attached container pane
  costs about 6 to 7 % of a core. An attached pane is demand, but the loop
  also keeps running for a terminal no client detached (a reload, a closed
  window, a lost connection), found by reading the code. Options: slow the
  idle cadence for containers; gate the loop on a client lease or the owning
  connection; or keep it. Chosen: keep the cadence for attached views and
  stop orphaned loops, in to-do 7745 (task 1 there; retired 2026-11-11). Pros: the user watching a pane keeps its 1 s freshness, and
  the unbounded part of the cost is removed. Cons: the fix needs a client
  signal the backend does not have today (a contract change), so it is its
  own change (made by 7745: a client lease, 45 s after the last 15 s
  renewal); the orphan was observed live on 2026-11-11 (7745 task 2), and so
  was its end under the lease.
- **C6 Split B20's liveness write from result writes?** In the worktree's
  filesystem a tick costs 63 to 84 µs of CPU; a heartbeat-only write would
  cost 29 to 48 µs, saving under 0.01 % of a core. Options: split it, with the
  cross-process crash-recovery and cancellation proof the inventory asks
  for; or keep it. Chosen: keep. Pros: no change to the state file the
  control process, the reader and recovery all read. Cons: none measurable.
- **C7 How to measure these candidates.** Options: a busy `dev:test` profile
  with clients, as task 1 did; or each cost where it is paid, with the real
  code (the design service, the output reader, the worker's tick, the hooks
  in a real browser) and the real commands (`docker info`, `docker exec`,
  `tmux capture-pane`). Chosen: the second. Pros: each figure belongs to one
  candidate, and none of them depends on load the busy profile adds. Cons:
  the gateway hop of a design check and a validation poll is not included,
  Docker ran on a rootless daemon rather than the host's, and the B19 orphan
  is inferred from the code rather than seen.

### Tasks 8, 13 and 18 on macOS (2026-11-13)

#### Q1. Task 8: install a simulator runtime, or move the run to 7568

- **Install the iOS 27.2 runtime on arktech-mini and run it.**
  - Pros: the run could finish here.
  - Cons: a multi-gigabyte change to the Xcode install of a host other
    builds share; the wrapper also needs an HTTPS origin through Tailscale
    Serve and a gateway token typed into the app.
- **Move the simulator run to the manual-test checklist beside the device
  run (chosen).**
  - Pros: the host is left as it was; the user decides on the install or
    names a node, and one item holds the steps.
  - Cons: the simulator evidence waits on the user.

Chosen because the build may not change shared hosts, and an install of this
size is a host change. Task 8 is done here; its two runs are 7568 items.

#### Q2. Task 18: how to get a really hidden tab

- **A browser Playwright launches, with `ignoreDefaultArgs` for the three
  throttling switches.**
  - Pros: the shared browser fixture and `test.use`.
  - Cons: does not work. Playwright enables DevTools focus emulation on
    every page it attaches, which keeps the page `visible` behind another
    tab and in a minimised window (observed: `visibilityState` stayed
    `visible` both ways).
- **Start Chromium itself and attach with `connectOverCDP` and `noDefaults`
  (chosen).**
  - Pros: no focus emulation on the default context, so the browser alone
    decides visibility; Chromium's own throttling is on; module loads still
    go through `fetchModulesOutsideChromium`.
  - Cons: the spec owns a child process (stopped through its own handle) and
    is listed as a direct spec in `browser-test.test.ts`.
- **An emulated hidden document (the busy profile's way).**
  - Pros: headless and simple.
  - Cons: timers are not throttled, which is what the task measures.

#### Q3. Task 13: what goes with `ORKESTRATOR_NATIVE_OBSERVATION_SHARING`

- **Remove the switch and the `observationSharing` option, its checks and
  the recurring baseline's rollback mode (chosen).**
  - Pros: one code path; a caller that still passes the option fails the
    typecheck; nothing can run the old cadence by accident.
  - Cons: the baseline no longer shows the before-and-after saving; earlier
    artifacts still carry a `rollback` mode, which the comparison reports
    against zero.
- **Keep `observationSharing` as a test-only seam for the baseline.**
  - Pros: the baseline keeps its comparison.
  - Cons: keeps the branch the removal is meant to delete, for a comparison
    whose decision was taken.

The baseline test now checks the shared counts on their own (no status
reads, fewer observation reads than one per session per sweep, retained
group passes, discovery within budget, two turn-end edges).

#### Q4. Task 18: where the spec runs and its budgets

- **An opt-in live spec in the browser suite's config
  (`ORKESTRATOR_AGENT_TEST_LIVE_BACKGROUND_TAB=1`), skipped with no display
  (chosen).**
  - Pros: repeatable on any host with a display; it opens a window, so it
    never runs in the default suite.
  - Cons: on a locked display only the launch tab is hidden, and showing it
    needs focus emulation; the evidence says which (`hiddenBy`,
    `shownBy`).
- **A one-off script.**
  - Pros: nothing to maintain.
  - Cons: the next background-tab question starts from nothing.

Budgets: a hidden tab is back within the ladder's 16 s cap plus 4 s for the
once-a-second timer alignment (20 s), and a shown tab retries within 1 s; the
measured worst cases were 10.0 s and 163 ms.

#### Q5. Task 18 review repair: what makes a visible retry the visibility edge's

Multi Review found that the five runs above pinned only the main stream's
backoff before showing the tab: the terminal stream runs its own jittered
ladder, so its first attempt after the link returned could have been a
ladder rung just before the tab was shown, and the check (at most 1 s after
`visible`) accepted a negative delta.

- **Wait until both streams have just failed, then require every stream's
  first attempt to come at or after the visibility edge, none between the
  link returning and the edge, and each last failure well inside the capped
  rung's 8 s floor (chosen).**
  - Pros: an attempt the ladder made cannot pass as the edge's, for either
    stream; the rules are a pure function the default suite tests
    (`background-tab-reconnect-support.test.ts`).
  - Cons: the second outage runs until the two ladders' phases line up
    (bounded at 3 minutes, usually under a minute).
- **Keep pinning only the main stream and add a lower bound of 0 ms.**
  - Pros: no extra wait.
  - Cons: a terminal rung that lands just after the edge still passes.

The same review also made startup and cleanup exception-safe: a Chromium
that fails to start is terminated and awaited before the error reaches the
test, and the environment and outage link are released by the test's
`finally` from the moment each is acquired.
