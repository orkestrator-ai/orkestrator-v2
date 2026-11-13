# Test wait review

Reviewed 2026-11-13 against `main` at `17d28238c`. A measured review of where
the test suite spends wall-clock time waiting, what can be removed, what can
overlap, and how scheduler slots relate to real CPU use. The first sections
describe what was measured before any change; [What was changed](#what-was-changed)
and [What was not changed](#what-was-not-changed) record the follow-up work on
the same day.

## How this was measured

- **Wall time per file** comes from the 72 per-file timing files that past
  aggregate runs left in `/tmp/orkestrator-test-timings.*` (`bun test --timings`):
  3,889 files, 5,128 s of summed median wall time. Backend is 3,234 s of that,
  web 820 s, root 375 s, the bridges about 475 s together.
- **CPU per file** was measured on the 70 slowest files by running each alone, three
  at a time, in its own cgroup scope (`systemd-run --user --scope`) and reading
  the scope's `cpu.stat`. That counts every process in the scope, including ones
  `bash times` (what review validation records as `cpuMs`) would miss. For two
  files the two methods agreed to within a few milliseconds, so the `cores`
  number shown in review validation is accurate for ordinary process trees.
- **Static review** of those files, plus a sweep of `apps/backend`, was done by
  reading the tests and the production code they wait on. Where an estimate below
  says "static", the fix has not been tried.
- **Run conditions.** The host was shared (16 logical cores, other agent sessions
  running), so aggregate medians are inflated by contention for CPU-bound files.
  The first measurement pass ran with `NODE_ENV=production` inherited from the
  shell, which broke the React UI files; it was redone with `NODE_ENV=test`. Run
  focused tests with `env -u NODE_ENV` or `NODE_ENV=test`.

Raw per-file findings are in `output/agent-testing/test-wait-review/` (git-ignored):
`backend-1.md`, `backend-2.md`, `bridges.md`, `web-root-desktop-cli.md` and the
measurements in `cpu-measurement.jsonl`.

## Headline findings

1. **Half of the wall time of the slowest files is idle.** Of 63 cleanly measured
   files, the 15 with under 0.25 average cores hold 394 s of 782 s solo wall time
   but only 27 s of 395 s CPU. The overall average is 0.50 cores per file.
2. **The aggregate median overstates the cost of CPU-bound files.** The same 63
   files sum to 1,417 s as aggregate medians and 782 s run alone. `portable-inputs-stamps`
   is 108 s in aggregate runs and 10.3 s alone; `firewall-refresh` 11 s against 2.1 s.
   That is contention, and it falls only when CPU is freed.
3. **Waits that are real wall-clock waits are mostly production timers.** The
   repeat offenders are fixed sleeps and hard-coded timeouts that tests wait out
   (a 2 s scan gap, a 10 s Docker probe, a 5 s grace period, a 50 ms `waitFor` tick),
   and per-test process spawns where a shared fixture would do.
4. **Scenarios are not overlapped inside files.** There is no `test.concurrent`
   in `apps/backend` (the one package that was searched for it). The largest
   single wait (561 s) is a serial loop of independent scenarios.

## Question 1: waits that can be avoided

Savings are isolated-run seconds for the file, from static review unless noted.
"Slow tier" means `scripts/test-tiers.ts` keeps the file out of `mise run test`, so
a fix helps `test:slow`, `test:full` and CI, not the default run, until the file
is fast enough to move back.

| File (tier) | Solo wall / CPU | What it waits on | Fix | Saving |
| --- | --- | --- | --- | --- |
| `backend/src/core/worktree-snapshots-git.test.ts` | 28.6 s / 0.6 s | About 15 detections each gated by the 2 s `LOCAL_SCAN_MIN_GAP_MS` | `DiffStatsService` already takes `localScanMinGapMs` (`diff-stats-service.ts:212`); the test builds the service without it. Pass about 250 ms and use that value in the `sleep` calls at lines 323, 329 and 363. A fake-clock test of the 2 s gap exists in `worktree-snapshots.test.ts:1060` | ~23 s |
| `backend/src/core/transcript-artifacts/runtime-scratch.test.ts` | 20.9 s / 1.5 s | Three tests of ~7 s each; fixture child idles after its work | Hypothesis: the uncleared 10 s timer in `TranscriptPreviewRunner.close()` (`preview-runner.ts:750`). Time the child alone, then `unref` the timer or end the fixture with `process.exit(0)` | ~18 s, unconfirmed |
| `backend/tests/container-replacement.test.ts` | 16.4 s / 1.2 s | 10 s Docker-probe timeout, four serial `sleep 1` attempts | Thread a probe timeout through `replacementCopyFailure`; run the four attempts with `Promise.all` | ~12 s |
| `backend/src/core/storage-backups-release.integration.test.ts` (slow) | 13.5 s / 0.7 s | Six tests inject a real 1.5 s `Bun.sleepSync` | Use the existing `slowStepMs` option with a skewed `performance.now` in the child prelude. Not confirmed that `performance.now` is assignable in Bun | ~9 s |
| `backend/src/core/native-agent-service-progressive.test.ts` | 16.5 s / 1.8 s | Four `Bun.sleep(2_100)` waiting out the 2 s discovery deadline (`native-agent-transcript-projection.ts:4072`) | Inject the deadline or use fake timers | ~8 s |
| `web/src/lib/store-resource-sync.test.ts` | 10.5 s / 1.3 s | 97 `tick()` calls of 80 ms past a 50 ms coalesce timer (`resource-sync.ts:78`) | Controlled timers (`installControlledTimeout`). Could then leave the slow tier | ~7 s |
| `web/.../AgentNativeTab.render-count.test.tsx` | 14.0 s / 4.2 s | `settle()` waits the real 400 ms `CHAT_COLUMN_SHIFT_SETTLE_MS` 26 times | Controlled timers | ~9 s |
| `root/tests/unit/release/release-linux-remote-script.test.ts` (slow) | 10.7 s / 1.0 s | Fixed `sleep 1` in `follow()` (`release-linux-remote.sh:131`), about 9 times | Env override for the poll | ~8 s |
| `cli/tests/client-waits.test.ts` | 17.6 s / 0.6 s | Real poll backoff and deadlines | Use `createSandbox({virtualClock:true})`, which already exists, then split four ways | 8-11 s |
| `web/.../useArtifactPublications` test | 7.8 s median | Real 500 + 1500 + 4000 ms retry backoff | Controlled timers. Could leave the slow tier | ~6 s |
| `claude-bridge/src/services/session-manager-core.test.ts` (slow) | 10.5 s / 5.4 s | Real `sleep 30` waits the hard-coded 5 s in `getClaudeRuntimeVersions` | `execFileText` already takes `timeoutMs` (`session-manager-core.ts:1232`); expose it | ~5 s |
| `codex-bridge/src/app-server-http.test.ts` (slow) | 6.6 s median | 5 s handshake-timeout test | The timeout env knob exists; use 500 ms and update the regex | ~4.5 s |
| `root/tests/unit/design-qualification-processes.test.ts` (slow) | 7.1 s median | SIGTERM-ignoring server waits the 5 s `stopProcessGroup` grace | Make the grace injectable | ~4.8 s |
| `cli/tests/launcher.test.ts` | 9.6 s / 0.5 s | Hard-coded 500 ms ready poll (`orkestrator-launcher.js:149`) plus 1 s unready timeouts | Injectable poll interval | 4-5 s |
| `backend/src/core/commands-state-sync.test.ts` | 7.9 s / 3.4 s | About 4.5 s of real `await_bridge_ready` waits | Fake timers (medium confidence) | ~4 s |
| `backend/src/preview-publication.test.ts` | 5.3 s / 4.0 s | Two RSA-2048 keygens in every `beforeEach`, a 1.1 s sleep | Generate the PKI once or use EC keys (`preview-test-pki.ts`); use `-days` instead of the sleep | ~3.5 s wall, ~3 s CPU |
| ACP bridge files (`acp-transcript`, `acp-context`, `acp-http`, `acp-session`, `acp-prompt`, `acp-reconciliation`, all slow tier) | 6-13 s each, ~1 core | A cold `bun` bridge plus a cold fake-agent `bun` per test (about 0.2 CPU-s per spawn, ~225 spawns) | Use the existing `sharedBridge()` (`acp-test-harness.ts:380`, already used by `acp-fork` and `acp-policy-narrowing`) for the 110-135 spawns that need no restart or seeding. Replace fixed clocks with file gates (`whenFileExists` exists) | 60-70 s aggregate wall and 40-50% of acp CPU |
| Shared `waitFor`/`findBy` polling in the UI suites (about 3,150 call sites in ~22 files) | n/a | `@testing-library/dom` 10.4.2 polls at a fixed 50 ms (`wait-for.js:19`, a `waitFor` option, not in `configure`). A condition that changes no DOM waits for the next tick | A `bun patch` reading `getConfig().asyncUtilInterval`, set to 10 ms. About 3,150 call sites; the idle share is estimated at 10-20% and **not measured**. Section 5 of `web-root-desktop-cli.md` has a 10-line instrument to measure it first | unmeasured |

Two shared-fixture items from the backend sweep: `LOCAL_PROJECT_FOR_CREATE` in
`apps/backend/tests/command-fixtures.ts:734` does five git spawns at import for
each of 41 files and only one reads it (make it lazy); and the local-bridge
`waitForHealth` poll is a fixed 200 ms (`commands-server-health.ts:7`) paid by
79 `start_local_*` call sites. A ramped interval would help production latency
too, but the total was not measured.

Sweep counts for `apps/backend` (1,476 test files): 201 literal sleeps of
100 ms or more across 95 files, of which 106 are in live, Docker, integration
or bench files. The default tier has 95 such lines in 58 files and only 16 are
1 s or longer, so its 1-10 s tail is not sleep-dominated. There are about 102
local `waitFor` helpers and none polls coarsely, so there is no single poll-interval
fix in the backend.

## Question 2: waits that are needed, with low CPU, that can overlap

| File (tier) | Solo wall / CPU | Why the wait stays | How to overlap | Saving |
| --- | --- | --- | --- | --- |
| `backend/tests/account-switch-resend-live.test.ts` (slow) | not measured; 561 s median | Each scenario ends in `await Bun.sleep(SETTLE_MS)` with `SETTLE_MS = 20_000` (`account-switch-stack-host.ts:232`), to prove no second resend happens. The file is `describe.each(["claude","codex"])` over several scenarios (about 20 runs in total), run serially | Each scenario already has its own temp root, HOME, data dir, `port: 0` and host process. Split by platform or scenario, or run groups with `Promise.all`; build the bridge once, not per file | ~500 s |
| `backend/tests/gateway-keep-alive-live.test.ts` (slow) | 98.7 s / 1.2 s | Idle sleeps of 6.5 + 85 + 6.5 s; the 85 s case guards Bun's runtime timer | Keep the 85 s case; run the other two beside it | ~13 s |
| `backend/src/core/container-worktree-signal-install.test.ts` | 69.3 s / 1.3 s | One test runs a real script for 62 s (155 x `sleep 0.4`); `min_gap_us` is hard-coded | Make the gap injectable; split the rest off | ~6 s |
| `backend/src/core/review-validation-worker.test.ts` | 43.3 s / 8.8 s | 66 tests each doing `git init` and 3-5 `bun` spawns, plus ~22 s of real waits | Split into 2-4 files so `--parallel` spreads them | ~25 s wall |
| `cli/tests/cli-client.test.ts` | not measured | Six real backend boots, each with its own root and port, run serially | Split or `Promise.all` | ~15 s |
| `backend/tests/standalone.test.ts` | not measured | About 16 cold boots of the built backend, serially | Split | 15-18 s |
| `claude-bridge` live probes (`claude-first-turn.live` 20.1 s / 6.9 s, `claude-provider-sandbox.live` 14.4 s / 8.0 s) | 0.34 and 0.56 cores | Real CLI scenarios, serial | Overlap probe processes | ~25-30 s combined |
| `backend/src/core/public-api/public-api-exec.test.ts` | 12.4 s / 2.9 s | Real exec workers, 1 s hard-coded cancel heartbeat (`exec-worker.ts:112`), fully serial | Per-test cleanup, then `test.concurrent`; env override for the heartbeat | ~8 s |
| `backend/src/core/transcript-artifacts/preview-admission.test.ts` | 7.5 s / 1.9 s | Serial real `bun` fake workers | Per-test cleanup, then `test.concurrent` | ~4 s |
| `web/.../AgentNativeTab.test.tsx` (305 tests, 11.5 s / 13.1 s) and `ActionBar.test.tsx` (6.4 s / 8.8 s) | 1.1-1.4 cores | CPU: 335 renders, 307 name-based `getByRole` | Split so the long pole drops; **no** `test.concurrent` (shared happy-dom document and global stores) | long pole 29 s to ~12 s (static) |

What blocks in-file concurrency, per the reviews: global `afterEach` cleanup
(the ACP harness SIGTERMs every tracked child), `process.env` mutation,
prototype `spyOn`, blocking `spawnSync`, and shared module state in the UI
files. Splitting a file only helps when there is more than one worker for the
group. The bridges group already has two balanced lanes (about 244 s for all
tiers against a lower bound of 238 s), so the way down there is to make ACP
itself cheaper, not to add workers.

## Question 3: slots versus real CPU use

### What the numbers say

- Wait-bound files hold a worker, and therefore a slot, for their whole wall
  time. Among the 63 measured files, 15 average under 0.25 cores yet account
  for half of the summed wall time.
- CPU-bound files (acp, coordinator, preview, Chromium, firewall, UI) average
  0.75-1.8 cores each and do need real capacity. About 25 files sit at 0.75-1.5.
- The scheduler's `usage` table already records measured average parallelism per
  command and `estimateWorkers` sizes the next run from it
  (`host-test-scheduler.ts:385-415`). **It is used only for non-cooperative
  review-validation commands** (`review-validation-worker.ts:208`, `:395`). The
  aggregate runner's groups reserve a static count from `planWorkers`.

### What actually makes a run wait

A full run on this 16-core host reserves 10 of 16 slots: workspace 6 (backend 4
plus one UI package at 2), root 1, bridges 2, codex protocol 1. All groups
admit at once, so slots are not what blocks `mise run test` on this host. The
waits come from two other things:

1. **The aggregate mutex.** `AGGREGATE_SUITE_RESOURCE` (`scripts/test-admission.ts:10`)
   is a binary lock: a second worktree's `test`, `test:slow`, `test:full` or
   `test:all` queues until the first finishes, whatever the CPU is doing. The
   documented reason is that overlapping suites slowed each other into timeouts.
2. **The static worker plan.** `planWorkers` caps the aggregate at
   `MAX_AGGREGATE_TEST_WORKERS = 8` regardless of host size, and the comment
   there records that higher caps produced SIGTERM/SIGSEGV UI-worker crashes.
   The default-tier long poles by summed median wall are web (about 376 s on two
   workers), backend (about 315 s on four) and root (about 230 s on one).
   On a 16-core host those lanes are limited by the plan, not by free slots.

### What to change, in order of confidence

1. **Replace the binary mutex with a measured-load gate.** The failure being
   avoided is CPU starvation of CPU-bound files, which inflate 2-5x under
   contention. Linux exposes this directly in `/proc/pressure/cpu` (PSI).
   Admit a second complete run when recent CPU pressure is low and there is memory
   headroom, and keep the mutex as the fallback where PSI is unavailable. This
   targets the real cause rather than a proxy. It needs an experiment first:
   two concurrent full runs on this host with the existing timeout watchdogs, and
   compare failures against the serial baseline.
2. **Teach cooperative groups to learn.** Record each group's CPU time (the
   child's `times`, as review validation does) into the same `usage` table and
   size reservations from it, so a wait-bound group stops reserving what it does
   not use. **I did not measure group-level CPU** (no full aggregate run was
   made), so the current figures per group are unknown; the file-level data above
   suggests the backend and bridges groups would measure well under their
   reservation, and web and root would not.
3. **Use the elastic floor for cooperative groups.** `enqueue` supports
   `minWorkers`, but `test-admission.ts` never passes one, so a group needs its
   whole reservation. Giving wait-bound groups a floor would let them start on a
   busy host.
4. **Experiment with the backend worker count before touching the plan.**
   `MAX_BACKEND_TEST_WORKERS = 4`; the backend lane is the second-longest and has
   many wait-bound files, but its CPU-bound files (coordinator, preview) did not
   survive heavy parallelism in the past. Measure with the existing environment
   knob rather than raising the cap blind.
5. **Do not add workers to the bridges group.** Its two lanes are balanced and
   the acp files already use about one core each.

### Stale documentation found

`docs/development/testing-guide.md` ("Host capacity queue" table) says the host
ceiling defaults to 8 and is capped at logical CPUs minus 2. The code
(`host-test-scheduler.ts:49-55`) defaults to one slot per logical core and allows
up to four per core. Not fixed by this review.

## Suggested order of work

1. Quick, deterministic, large: `worktree-snapshots-git` (23 s), the
   `account-switch` split (about 500 s on `test:slow`), `container-replacement`
   (12 s), `store-resource-sync` and the other controlled-timer files (about 28 s
   across four web files), and the ACP `sharedBridge()` conversion.
2. Small injection points for hard-coded waits: the script polls, the SIGTERM
   grace, the launcher and `isolated-browser` polls, the Docker probe (about
   20 s combined).
3. Measure before deciding: the `waitFor` interval patch, group-level CPU, and
   the two-concurrent-runs experiment behind the mutex change.

Each change must follow the repository rule that a wait is never hidden by
loosening or skipping a test; every item above removes or shortens a real
wait, or overlaps independent scenarios, and leaves the assertions alone.

## Limits of this review

- The 70 files measured are the slowest by aggregate median. The long tail of
  roughly 800 files between 1 and 10 s (sum about 2,100 s) was swept by pattern
  search, not measured file by file.
- Five files could not be measured here (`content-server.engines` needs
  Firefox, `standalone` and `cli-client` need built output, `mcp-sync.live`
  hits the real-data-dir guard, one file ran too fast to measure). Their rows
  rely on static reading.
- `opencode-coordinator-read-boundary-live.test.ts` and
  `seed-coordinator-workflows.test.ts` appear in old timing data but no longer
  exist in the tree.
- Several savings are estimates from reading code, uncertain by roughly 40%.
  I spot-checked the `account-switch` structure, the `localScanMinGapMs`
  option and the 50 ms `waitFor` default in the source; the rest are the
  reviewers' reading and should be confirmed by timing the change.
- Average cores per file is not peak. A file at 0.3 average can still burst.

## What was changed

Times are solo wall seconds for the file on the shared 16-core host, before and
after. Every changed file was run at least three times alone and once with
`--parallel=2`, with unchanged test counts and no flakes, unless marked
unverified. The default suite was not re-timed per file.

### Waits removed

| File | Before | After | How |
| --- | --- | --- | --- |
| `backend/src/core/worktree-snapshots-git.test.ts` | 28.5 | 4.1 | Passes `localScanMinGapMs: 250`. Added a test that the production gap is exactly 2000 ms |
| `backend/src/core/transcript-artifacts/runtime-scratch.test.ts` | ~21 | 0.9 | Product fix: `TranscriptPreviewRunner.close()` left a 10 s bound timer uncleared, so every shutdown waited it out. It is now cleared in a `finally` |
| `backend/tests/container-replacement.test.ts` | 17.4 | 4.0 | Optional probe timeout on `replacementCopyFailure`; independent attempts run with `Promise.all` |
| `backend/src/core/storage-backups-release.integration.test.ts` | 13.5 | 4.5 | Slow step simulated with a skewed `performance.now` instead of `Bun.sleepSync` |
| `backend/src/core/native-agent-service-progressive.test.ts` | 16.4 | 4.2 | `installControlledTimeout(2_000)`; asserts the production deadline is still 2000 ms |
| `backend/src/core/commands-state-sync.test.ts` | 9.3 | ~3 | Fake clock |
| `backend/src/preview-publication.test.ts` | 5.5 | 1.6 | PKI generated once per process; `days` option replaces a 1.1 s sleep |
| `backend/tests/commands-local-bridge-reuse.test.ts` | 17.9 | 2.3 | `ORKESTRATOR_TEST_LOCAL_SERVER_POLL_MS` caps `waitForHealth` and the exit/unhealthy pollers; the fixtures set it to 20 ms. Most of the time was the 500 ms reuse-retry delay |
| `backend/src/core/container-worktree-signal-install.test.ts` | 69.3 | 16.5 | `ORKESTRATOR_WORKTREE_SIGNAL_MIN_GAP_US` in `docker/orkestrator-worktree-signal.sh` (default unchanged); the soak runs 4x compressed with times stretched back. A real-time test pins the one-second default gap |
| `backend/tests/account-switch-resend-live` | 561 | 32 (20 scenarios, two files, `--parallel=2`) | Split into `account-switch-claude-live` and `account-switch-codex-live`; scenarios run with `test.concurrent`. The 20 s settle window is unchanged |
| `backend/tests/gateway-keep-alive-live` | 98.9 | 85.7 with spare workers | Split into three `-live` files so the two short cases overlap the 85 s one |
| `backend/src/core/public-api/public-api-exec.test.ts` | 12.7 | 2.3 | Real-process tests moved to `public-api-exec-processes.test.ts` and run concurrently; `ORKESTRATOR_TEST_EXEC_HEARTBEAT_MS` shortens the worker's cancel poll |
| `backend/src/core/transcript-artifacts/preview-admission.test.ts` | 7.7 | 3.2 | Per-test runner; `test.concurrent` |
| `web/src/lib/store-resource-sync.test.ts` | 10.5 | 3.0 | Virtual timer (`apps/web/src/test/virtual-timeout.ts`) |
| `web/.../AgentNativeTab.render-count.test.tsx` | 14.4 | 4.8 | Controlled 400 ms timer |
| `web/src/hooks/useArtifactPublications.test.ts` | 7.6 | 1.0 | Controlled retry timers; asserts exact delays |
| `web/.../OpenCodeProvidersSection.test.tsx` | 5.0 | 0.5 | Controlled 1.5 s login poll |
| `web/.../AgentInfoButton.test.tsx` | 5.2 | 3.0 | Controlled 2 s follow-up read |
| `cli/tests/client-waits.test.ts` | 17.6 | 3.4 | Virtual clock; six cases whose subject is real elapsed time keep the real clock |
| `cli/tests/launcher.test.ts` | 9.6 | 3.3 | `ORKESTRATOR_LAUNCHER_READY_POLL_MS` (default 500) |
| `root/tests/unit/release/release-linux-remote-script.test.ts` | 10.8 | 2.8 | `ORKESTRATOR_RELEASE_FLUSH_SECONDS` (default 1) |
| `root/tests/unit/design-qualification-processes.test.ts` | 6.7 | 2.2 | `startOwnedPreview` passes an optional stop timeout (default 5 s) |
| `desktop/scripts/dev/isolated-browser.test.ts` | 7.4 | 5.4 | `statusPollMs` option (default 250). The three startup-deadline tests keep 250 ms because a faster poll made them flaky |
| `claude-bridge/.../session-manager-core.test.ts` | 10.5 | 5.9 | Optional `probeTimeoutMs` on `getClaudeRuntimeVersions` (default 5000) |
| `codex-bridge/src/app-server-http.test.ts` | 5.9 | 1.4 | Handshake timeout env set to 500 ms |
| Claude live probes (`first-turn`, `provider-sandbox`, `mcp-sync`) | 20.3 / 14.6 / 26.0 | 6.3 / 4.7 / 5.9 | Independent scenarios overlap with isolated homes, ports and workspaces; negative-assertion windows kept. The sandbox probe runs 4 child lanes (`SANDBOX_PROBE_LANES`) |
| `claude-bridge/src/sdk-compatibility.test.ts` | 5.8 | 2.6 | `test.concurrent` (each test already had its own subprocess and temp dir) |

### ACP bridge

The ten large ACP files now share bridges through `sharedBridge()` for every
test that needs no restart or state seeding, and keep `spawnBridge` for the rest.
Spawns fell sharply (`acp-transcript` 66 to 17, `acp-context` 54 to 23,
`acp-session` 26 to 3), CPU fell about 30-55% per file and wall about 10-45%.
Fixed clocks became release-file gates in the fake agents
(`FAKE_ACP_LATE_USAGE_FILE`, `FAKE_CLOSE_CANCEL_HOLD_FILE`,
`FAKE_ACP_FAIL_LOAD_RELEASE_FILE`, `FAKE_ACP_LOAD_RELEASE_FILE`), and the
SIGTERM grace in `acp-process-tree.ts` can be shortened with `ACP_TERM_GRACE_MS`
(default 2000, a test pins it; a larger value is capped at the default, so the
override never lengthens an agent close).

### Files split so `bun test --parallel` can spread them

| Original | Pieces | Result |
| --- | --- | --- |
| `review-validation-worker.test.ts` (66 tests) | `.queue`, `.cooperative`, `.lifecycle`, `.policy` | 43.5 s to 12.9 s at `--parallel=4` |
| `environment-move.test.ts` (50) | three files | 10.0 s to 4.3 s |
| `standalone.test.ts` (12) | three files | 11.6 s to 3.9 s |
| `multi-review-service.test.ts` (371) | `-part-1` to `-part-4`; the 2.2 s lease sleep runs on a 3x clock | 12.8 s to 3.5 s |
| `terminal-history.test.ts` (66) | `-part-1` to `-part-4` | 12.9 s to 4.2-6.2 s |
| `project-git-mirror.integration.test.ts` (72) | four `.integration` files; the two 5 s copy-guard tests land in different files | 19.7 s to 6.5 s |
| `content-server.engines.test.ts` (27) | nine files, three lanes per engine; each lane's tests are written once in `content-server.engines-lane-<n>-test-support.ts` | 29.3 s to 10.3 s (chromium part) |
| `AgentNativeTab.test.tsx` (390) | three files plus a support module | longest piece 12-15 s to 5.1 s |

The test-name multisets match the originals for multi-review, terminal history,
git mirror and `AgentNativeTab`; the other splits match by count.

### Testing Library `waitFor` interval

`@testing-library/dom` polls every 50 ms and its `configure` could not change
that. Measured idle time inside `waitFor` was 86% of
`useNativeAgentSession.progressive.test.tsx` (8.7 s to 2.5 s at 10 ms), 24% of
`AgentNativeTab.test.tsx`, 10% of `ActionBar.test.tsx` and under 1% of
`CreateEnvironmentDialog.test.tsx`, about 32% pooled across the files measured.
A `bun patch` (`patches/@testing-library%2Fdom@10.4.2.patch`) makes the default
interval read `getConfig().asyncUtilInterval` (default still 50), and
`tests/bounded-test-diagnostics.ts` sets it to 10.

### Scheduler

- `docs/development/testing-guide.md` no longer says the host ceiling defaults to
  8 capped at CPUs minus 2; it is one slot per logical core, up to four per core.
- Each undisturbed aggregate group (Linux) now records its observed average CPU
  parallelism, sampled from `/proc` every 500 ms, into the scheduler's `usage`
  table and prints `observed N cores of M slots` on its finish line. macOS
  records nothing.
- Two opt-in settings, both **off by default and not validated under real
  concurrent runs**: `ORKESTRATOR_TEST_ADAPTIVE_RESERVATION=1` sizes a group's
  reservation from the learned figure (with an elastic floor), and
  `ORKESTRATOR_TEST_AGGREGATE_PRESSURE_GATE=1` lets a second complete run start
  beside another when `/proc/pressure/cpu` and memory are calm, falling back to
  the mutex whenever pressure cannot be read. Documented in the testing guide.

## What was not changed

- **Tiers.** No file moved between tiers, so `mise run test` is no longer than
  before. Several slow-tier files are now fast enough to consider moving back
  (`client-waits`, `launcher`, `cli-client`, `storage-backups-release`,
  `commands-state-sync`, `preview-publication`, `store-resource-sync`,
  `useArtifactPublications`, the release and design-qualification root tests);
  that adds their coverage and time to the default run, so it is a separate
  decision. Each split piece stays in its original's tier.
- **`ActionBar.test.tsx`** was not split: a three-way trial cut the long pole
  from 6.2 s to 4.3 s but raised summed CPU from 8.5 s to 12.2 s.
- **`AgentNativeTab`** split helps a single-file run, but on the aggregate run's
  two web workers (about 820 s of work) it changes the wall time little.
- **Real waits kept on purpose:** the 85 s case in `gateway-keep-alive-live`
  (it guards Bun's runtime timer), every negative-assertion settle window
  (20 s in `account-switch`, 1.5 s parked, 2 s and 3 s alive checks), the 300 ms
  cancel delay in `acp-session-close` (a gate passes even when the bridge does
  not wait, shown by mutation), `isolated-browser`'s startup-deadline cadence,
  and the real 3 s deadline in `storage-backups-release`.
- **Compressed soak.** The 62 s real-default soak in
  `container-worktree-signal-install` is now a compressed run plus a real-time
  check of the one-second gap. The literal soak could live in a `-live` file.
- **Larger production knobs still open:** a 5 s size-check interval in
  `project-git-mirror.ts` costs about 10 s across two copy-guard tests; a
  `ORKESTRATOR_TEST_LOCAL_SERVER_POLL_MS=20` default in `tests/setup-node.ts`
  would speed the `src/core/*` files that start local servers through their own
  harnesses; `session-manager-core.test.ts` still takes about 5.9 s.
- **File sizes.** `multi-review-service-part-*` (1.7k to 5.5k lines) and the
  `AgentNativeTab` pieces (4.3k to 4.8k lines each) are over the 2,000-line
  guideline, as were the originals (13.4k and 14.5k lines).
- **Guard coverage.** Moving `settle` and `pause` into
  `content-server.engines-test-support.ts` first hid the engine parts' windows
  from the `sleep-before-negative-assertion` guard (baseline 5 became 3). The
  guard now follows sleep helpers imported from relative test-support modules.
  The engine parts were then nine copies of the same test bodies, so the
  baseline allowed the five windows once per engine (15 in all). Each lane's
  tests now live once in `content-server.engines-lane-<n>-test-support.ts`
  and each engine part only calls `defineEngineLane<n>` for its engine, so the
  baseline holds the original five (3 in lane 1, 2 in lane 2). The waits are
  unchanged.
- **Engine report.** With `ARTIFACT_ENGINE_REPORT` set, the nine engine parts
  merge into one report from separate workers. The merge
  (`content-server.engines-report-test-support.ts`) holds a lock file and
  publishes by rename, so a part can no longer erase a sibling's results;
  `content-server.engines-report.test.ts` races nine real writer processes.
- **Account-switch resend.** `mise run verify:accounts:resend-live` passed with
  all 20 concurrent scenarios run (none skipped) on Linux, in 32 s and 43 s.
- **Unverified:** Firefox is not installed here and WebKit is missing host
  libraries, so those engine parts only skip or fail in the same way as before;
  macOS behaviour of the 4-lane sandbox probe; the `docker`-gated exec and
  preview browser/baseline harnesses; behaviour of any of this under full
  aggregate contention and randomised test order.
- **Docker image.** `docker/orkestrator-worktree-signal.sh` is copied into the
  container image, so the image contents changed; the new variable defaults to
  the old behaviour. The image smoke test (`docker/tests/final-image-smoke.sh`)
  was not run.
