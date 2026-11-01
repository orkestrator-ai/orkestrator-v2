# Recurring work qualification

Checked against `main` at `00a0cb82` (2026-10-25); tasks 3 and 4 rechecked
against `main` at `93b99bfba` (2026-11-01). Live evidence from macOS on
2026-10-22 and 2026-10-25, and from Linux on 2026-11-01; see
[Live evidence](#live-evidence-2026-10-22-macos),
[Live soak](#live-soak-2026-10-25-macos) and
[Container fetch policy and app wiring](#container-fetch-policy-and-app-wiring-2026-11-01-linux).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Busy live profile**: 10 environments, 0 to 2 browser clients, bursts, an active turn, an approval, a queued prompt, a workflow completion, an outage and a client resume. Status: open.
2. **Client-side change-to-visible latency**: measure every latency-budget row as a client sees it, not at backend detection. Status: open.
3. **Container fetch policy live**: recovery fetch, explicit refresh and the routine policy on an environment without `createdFromCommit`, then keep or remove the routine policy. Status: done (2026-11-01: all three ran live on Linux; the routine policy stays, decision 11; a wasted revert fetch found and fixed).
4. **Container app wiring and real-browser QA**: Files panel on a container, merge from the UI, inactive switch, two windows, hidden document, reload, missed final invalidation, coordinator view, validation output. Status: open (partial evidence only: Files-panel cases and coordinator smoke have live results; hidden-return rerun now observes the revision while hidden. UI merge, validation output and deeper coordinator qualification remain open; decision 19).
5. **Live GitHub**: terminal discovery cadence, replacement and reopen, admission delay under real `gh` latency, rate-limit cooldown. Status: open.
6. **Live providers**: delegated to 0049. Status: open (tracked in 0049).
7. **macOS watcher paths**: packaged Electron app, plus the burst-overflow and failure-to-polling paths. Status: partly done (the `dev:test` save-detection run passed).
8. **iOS hidden pause and resume**: the read coordinator across backgrounding and screen lock in the `apps/ios` wrapper. Status: open.
9. **Real host suspend and resume**: `HostSuspendDetector` against a real sleep. Status: open.
10. **Long soak and cache gauges**: 50 or more cycles over an hour or more with agent sessions open, and gauges for caches the footprint cannot see. Status: partly done (driver and a 10-cycle soak exist).
11. **Multi-client, restarts and an older backend**: two clients with one disconnected, backend and bridge restarts at durable transition boundaries, an older backend. Status: open.
12. **Measured candidates**: 12 cadence and limit candidates to decide from live data. Status: blocked (on tasks 1, 5 and 10); the feature-planning row read is done, and the container fetch failure ladder is decided (keep 5 to 30 min, decision 11).
13. **Remove the rollback drivers**: `ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK` and its whole-store drivers, `WorkflowDueScheduler`, and `ORKESTRATOR_NATIVE_OBSERVATION_SHARING`, updating the catalogue. Status: blocked (on tasks 1, 5 and 10).
14. **Metrics switch decision**: keep `ORKESTRATOR_RECURRING_METRICS` as a permanent kill switch. Status: done (one stale comment left).
15. **Provenance comments**: "recurring-processes step NN" comments pointing at deleted plans. Status: deferred (decided: leave them).

### 1. Busy live profile

**Problem.** Recurring work is on by default, but the only live evidence is an idle, credential-free profile. None of the obligations the keyed drivers must keep (result consumption, prompt dispatch, PR terminal effects) has run live, so a missed wakeup under load would show as a stale workflow or a stuck queue for every user.

**Context.** The idle A/B and a 10-cycle soak ran on macOS (Live evidence, Live soak). The file says each busy step needs credentials, a scripted UI or a fault injector that `scripts/recurring-live-ab.ts` lacks. Outage and resume overlap with the live outage workload in [0051](0051-client-reconnect-and-freshness.md). The run is batched for macOS and Docker Desktop in 0031.

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
a model turn. Both stay open (decision 16).

### 5. Live GitHub

**Problem.** PR monitoring's terminal cadence (5 min plus 30 s jitter, the one accepted slowdown), replacement and reopen discovery, admission under real `gh` latency and rate-limit cooldown are unproved live.

**Context.** Batched in 0031 under "Live GitHub". The rollback is setting `terminalDiscoveryIntervalMs` to 20 s and the jitter to 0.

**Investigation.** `DEFAULT_PR_MONITOR_POLICY` at `apps/backend/src/core/pr-monitor-policy.ts:68` still holds 5 min, 30 s jitter and a 2 min rate-limit cooldown. `external-pr` admission is 2 total and 1 per target (`apps/backend/src/core/work-admission.ts:85`).

**Decisions.**

- **What repository to use?**
  - **A disposable test repository under the user's account, driven by `gh`, with PRs opened, closed, replaced and reopened by script (recommended).**
    - Pros: controllable transitions; no risk to real PRs.
    - Cons: the rate-limit cooldown is hard to trigger without real volume.
  - **Observe this repository's real PR traffic.**
    - Pros: realistic latency and volume.
    - Cons: transitions are not controllable, and timing depends on maintainers.
- **How to test the rate-limit cooldown?**
  - **Inject a rate-limit answer at the `gh` boundary in a focused test, and record only the live cadence (recommended).**
    - Pros: deterministic, no abuse of the API.
    - Cons: not a live proof of the cooldown.
  - **Exhaust a real token's limit.**
    - Pros: genuine evidence.
    - Cons: disrupts other work on the account.

### 6. Live providers

**Problem.** Provider-side observation (idle backoff, background output) is unproved for several providers.

**Context.** This file defers it entirely to [0049](0049-native-agent-idle-observation.md).

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

### 9. Real host suspend and resume

**Problem.** `HostSuspendDetector` re-times every scheduler after a sleep so overdue keys run once; that is proved only with a manual clock.

**Context.** Constraint: missed ticks are never replayed.

**Investigation.** `HostSuspendDetector` is at `apps/backend/src/core/host-suspend-detector.ts:42` with its own test file. No live record.

**Decisions.**

- **How to suspend?**
  - **A real lid-close or `pmset sleepnow` on macOS, with diagnostics read before and after (recommended).**
    - Pros: genuine monotonic-clock behaviour.
    - Cons: suspends the host's other work (production Orkestrator shares it).
  - **`systemctl suspend` on a spare Linux host.**
    - Pros: scriptable, isolated from the main host.
    - Cons: different clock semantics from macOS.

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

### 14. Metrics switch decision

**Problem.** None left; decided on 2026-10-25.

**Context.** Decision 2: keep `ORKESTRATOR_RECURRING_METRICS` as a diagnostic kill switch.

**Investigation.** The switch is read at `apps/backend/src/core/recurring-work-metrics.ts:203`. The class comment at `:47` still calls it "the rollback switch", which contradicts decision 2.

**Decisions.**

- **Fix the stale comment?**
  - **Reword it as a diagnostic kill switch in the next change that touches the file (recommended).**
    - Pros: no standalone churn.
    - Cons: the drift stays until then.
  - **Fix it now in its own change.**
    - Pros: immediately consistent.
    - Cons: a one-line PR.

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

#852 changed how often the app collects and reads facts: shared worktree
snapshots, a container fetch policy, lifecycle-aware PR monitoring, the client
read coordinator, the native observation broker and keyed workflow
supervision. It was qualified on Linux with deterministic call counts and one
credential-free idle A/B run. The instrumentation fixes are done and a
credential-free macOS idle A/B with freshness probes has run. What remains is
the busy live profile, the GitHub, provider, iOS, suspend and soak runs, the
measured-candidate decisions those runs feed, and then removing the rollback
drivers. On 2026-10-25 the feature-planning keyed row read landed (the one
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
  reconnects included, is a `provider-request` like a `bridgeFetch`.
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
  review (its rollback is the real `WorkflowDueScheduler`, on the
  harness's manual clock since 2026-10-25). It reports `storageReads`
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
- Rollback switches, each read once at startup and let through the desktop
  environment allowlist in `apps/desktop/electron/backend-process.ts`:
  - `ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK` (`KEYED_SCHEDULING_ROLLBACK_ENV`,
    `workflow-supervisor.ts`): a comma list of `feature-planning`,
    `build-pipeline`, `multi-review`, `native-queues`, `backend-activity`, or
    `all`. A named domain runs its old whole-store
    driver instead of the keyed one; `multi-review` falls back to
    `WorkflowDueScheduler`.
  - `ORKESTRATOR_NATIVE_OBSERVATION_SHARING=0` (read in `core/index.ts`).
  - `ORKESTRATOR_RECURRING_METRICS=0` turns the recorder off.
- Multi review's own rollback gates (`adaptiveScheduling: false`, the legacy
  1 s tick, and `evidencePermits`) were removed on 2026-10-25 by
  [0027-multi-review-scale-and-cost.md](../coordinator-and-multi-review/0027-multi-review-scale-and-cost.md).
  Only the `multi-review` domain of the switch above and its
  `WorkflowDueScheduler` remain.
- Trial constants: `DEFAULT_PR_MONITOR_POLICY` (terminal discovery 5 min plus
  30 s jitter), `CONTAINER_FETCH_COOLDOWN_MS` (5 min) and
  `CONTAINER_FETCH_FAILURE_COOLDOWN_MAX_MS` (30 min),
  `DEFAULT_ADMISSION_POOL_LIMITS` (`git-docker-scan` 4 total and 1 per target,
  `external-pr` 2 and 1, `workflow-provider` 8 and 2),
  `DEFAULT_WORKFLOW_DISCOVERY_MS` (30 s) and `NATIVE_QUIET_BACKOFF_TRIAL_MS`.
- `HostSuspendDetector` re-times every live scheduler after a host sleep so
  overdue keys run once.
- `stableJitterMs` lives in `multi-review-scheduling.ts` (moved 2026-10-25),
  which the keyed driver and the `WorkflowDueScheduler` rollback share, so
  removing `multi-review-scheduler.ts` no longer touches the keyed path.
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
  [2180](../cross-cutting/2180-fixture-restart-orphans-earlier-environments.md);
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
  - 10 environments with 0, 1 and 2 browser clients, then burst saves, long
    Git reads, an active turn, a pending approval, a queued prompt, a workflow
    completion, a network outage and a client resume. Each needs credentials,
    a scripted UI or a fault injector that `recurring-live-ab.ts` does not
    have;
  - change-to-visible as a client sees it (the script stops at backend
    detection), for every row of the latency budgets;
  - ~~the container fetch policy live~~. Done 2026-11-01 on Linux: a
    missing-baseline recovery fetch, an explicit refresh and the routine policy
    on a legacy record, all on a real container (see
    [Container fetch policy and app wiring](#container-fetch-policy-and-app-wiring-2026-11-01-linux));
    the routine policy stays (decision 11);
  - container app wiring: the Files panel open on a container and an
    inactive-environment switch are done (2026-11-01). A merge from the UI is
    still owed and needs a GitHub pull request, so it belongs with live GitHub
    below.
- Live GitHub: terminal discovery cadence, replacement and reopen discovery,
  admission queue delay under real `gh` latency, and rate-limit cooldown.
- Live providers: see [0049-native-agent-idle-observation.md](0049-native-agent-idle-observation.md).
- macOS: recursive `fs.watch` (`worktree-watcher.ts`) detects a save in a
  watched worktree in under 1 s (Live evidence), with Electron under
  `dev:test` and Docker Desktop. Still owed: a packaged Electron app, and the
  watcher's burst-overflow and failure-to-polling paths on macOS.
- iOS: the `apps/ios` wrapper running the web client, checking the read
  coordinator's hidden pause and resume across backgrounding and screen lock.
- A real host suspend and resume against `HostSuspendDetector`.
- Soak: repeated add, remove, stop and restart cycles. Timer, subscriber and
  cache counts return to baseline, and profile logs hold zero
  `Unhandled promise rejection (continuing)` guard lines. The ten idle
  profile lifecycles of 2026-10-22 had zero guard lines each; that is not a
  soak. 2026-10-25: the driver exists (`--soak-cycles`, see Current state)
  and a first 10-cycle local and container soak ran (see
  [Live soak](#live-soak-2026-10-25-macos)). Still owed: a long soak (at least
  50 cycles over an hour or more, with agent sessions open), and cache
  counts the footprint cannot see yet (worktree snapshot and row caches have
  no diagnostics gauge).
- Two clients with one disconnected; backend and bridge restarts at durable
  transition boundaries; an older backend.
- Real-browser QA of the Files panel (inactive-environment switch, two
  windows, hidden document, reload, missed final invalidation), the
  coordinator view and hidden-document reconcile: partial evidence from 2026-11-01
  (`container-files-wiring.spec.ts`); coordinator coverage is smoke-only and
  hidden-return passed with revision observation on the repair rerun. Validation output is still owed: it
  needs a Multi Review or build pipeline with model turns, so it belongs with
  the live provider runs (0049, batched in 0031).

### Measured candidates

Decide each from the live data; change nothing without evidence. The
2026-10-22 idle A/B decides none of them. It has no PRs, no GitHub, no
fetching container, a single client, no design canvas, no validation output
and no interactive terminal, so every candidate below except the
feature-planning row read (decided from the deterministic harness on
2026-10-25) is still open. The container fetch failure ladder needs the
routine policy to run first, which new containers never do (see "Container
fetch reach"); it was decided on 2026-11-01 without tuning (decision 11).

- Settled check-rollup backoff (`pr-check-rollup`, 60 s).
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
- Sharing Docker availability across clients
  (`DOCKER_AVAILABILITY_POLL_INTERVAL_MS`, 60 s, `apps/web/src/App.tsx`).
- A longer quiet interval for the design canvas cursor check
  (`DESIGN_CANVAS_CURSOR_CHECK_MS`, 3 s, `design-controller.ts`), after
  missed-final-hint recovery is qualified.
- One shared visible display clock for `useElapsedTimer` and
  `usePromptDeadline` (not profiled).
- The validation reader's in-environment `bun` spawn per poll.
- Demand gating for interactive tmux capture (B19, `tmux-interactive.ts`).
- Splitting the validation worker's 500 ms liveness write from changed-result
  writes (B20, `review-validation-worker.ts`), only with cross-process
  crash-recovery and cancellation proof.
- ~~A keyed row read for feature planning's per-record pass.~~ Done
  2026-10-25: `getFeaturePlan` reads one row, and a warm keyed read is served
  from the row cache. Evidence: harness counts unchanged, bytes in "Harness
  effect (2026-10-25)", 3.9 to 4.3 µs against 80.0 to 81.9 µs per pass over
  202 plans, and `storage-read-accounting.test.ts` ("a feature-planning pass
  reads its plan's row, not the whole store").

### Code: after soak

Removal not started; its preparation is done (2026-10-25: `stableJitterMs`
moved, the metrics switch decided). The idle A/B on macOS shows the keyed
drivers starting no more often than the rollback drivers, with the same
freshness and no guard lines, and a 10-cycle lifecycle soak left no leaked
footprint. But the busy profile, live GitHub, providers and a long soak have
not run, so the rollback drivers stay.

- Remove `ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK` and the whole-store drivers
  domain by domain, with the desktop allowlist entry. Remove the
  `multi-review` domain together with `WorkflowDueScheduler`
  (`multi-review-scheduler.ts` and its test). Since 2026-10-25 nothing else in
  Multi Review depends on it, and `stableJitterMs` has moved to
  `multi-review-scheduling.ts` (done 2026-10-25; its test moved with it), so
  deleting the file is now self-contained. Waits for the busy live profile
  (see "Assumptions and decisions").
- Remove `ORKESTRATOR_NATIVE_OBSERVATION_SHARING` and its allowlist entry.
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

## Assumptions and decisions

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
17. **The two harness problems this run hit.** A `--fixture` restart orphans
    the previous start's environments, and `dev:test` opens Electron on the
    Linux desktop. Options: fix them here; or record them. Chosen: record them
    as [2180](../cross-cutting/2180-fixture-restart-orphans-earlier-environments.md)
    and [2181](../cross-cutting/2181-dev-test-electron-opens-on-the-linux-desktop.md).
    Why: both change behaviour every browser suite relies on and are outside
    this file's scope. The workarounds used here are in those files.
18. **Coordinator view depth.** Without a delegation the Coordinator tab lists
    nothing per environment, so the spec only proves it opens beside
    container environments, across a switch and a reload. Options: run a
    coordinator delegation (provider turns); or accept the smoke check.
    Chosen: the smoke check. The delegation path is covered by
    `coordinator-live.spec.ts`, which needs credentials.

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

Deterministic repair validation also completed: the policy and real-Git caller
files passed, targeted backend and agent-spec type checks passed, and
`ORKESTRATOR_TEST_ALLOW_CONCURRENT=1 ORKESTRATOR_TEST_WORKERS=2 mise run test`
passed all four default-tier groups in 190.3 s (exit 0). The documented
concurrent opt-in was used after cancelling an exclusively queued attempt;
no other worktree's processes were stopped. Separate rerun output is at
`/tmp/ork-review-fix-tests-concurrent.log`; original review artifacts are unchanged.

## Related

- [0049-native-agent-idle-observation.md](0049-native-agent-idle-observation.md),
  [0051-client-reconnect-and-freshness.md](0051-client-reconnect-and-freshness.md) and
  [0052-remote-client-bandwidth.md](0052-remote-client-bandwidth.md): the client and
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
