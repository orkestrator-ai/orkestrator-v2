# Container qualification follow-ups

Checked against `main` at `459d2944` plus the 0019 qualification branch
(2026-10-23). Worked through on 2026-10-26 against `main` at `93018933`
(branch `todo-0061-container-qual-follow-ups-56ae439cf200`).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Settle agent state after a stop (items 1–2)**: a stopped session reads idle, and every stop path withdraws requests. Status: done.
2. **Failure classification (items 3–5)**: specific boot codes, `daemon-unavailable` during a rebuild copy, and a lost daemon is not a legacy image. Status: done.
3. **Busy local Cursor bridge keeps its key (item 6)**. Status: done.
4. **Grok login from the agent-test profile (item 7)**: the code is done; the live `grok-container-login.spec.ts` run is owed. Status: blocked (on a current host Grok login).
5. **Container bridge logs (item 8)**: mawk buffering fixed with `-W interactive`. Status: done.
6. **OpenCode egress (item 9)**: `opencode.ai` is a required host. Status: done.
7. **Provider refusals in the transcript (item 10)**: Codex and Pi get a status row; the Pi refusal has never been reproduced live. Status: partly done (Pi live evidence owed).
8. **Budget warning on save (item 11)**. Status: done.
9. **Harness cleanup and orphaned setup (items 12–13)**. Status: done.
10. **Retire the file**: what happens to it once tasks 4 and 7 have their evidence. Status: open.

### 1. Settle agent state after a stop

**Problem.** A stopped session stayed `waiting`, so sends and moves were refused as busy.

**Context.** Decisions 1–2: a quiet settle to `idle` with `stoppedMidTurn`, an explicit call in `quiesceRuntime`, and a sweep catch-all.

**Investigation.** Present at HEAD: `settleStoppedSessions` (`apps/backend/src/core/native-agent-launch-activity-reconciler.ts:327`, called at `:420` and from `native-agent-service.ts:455`), `stoppedMidTurn` (`:69`, `:303`) and `settleStoppedRuntimeAgents` (`stopped-runtime-agents.ts`, imported at `commands-environment.ts:53`). The known limit stands: `stoppedMidTurn` is in memory only, so a backend restart while stopped turns the run's outcome into `unknown`.

**Decisions.** None: done. The in-memory flag is a recorded con of decision 1, not open work.

### 2. Failure classification

**Problem.** Boot, copy and manifest failures were reported under misleading codes.

**Context.** Decisions 7–8.

**Investigation.** `parseExitedBootRecord` (`apps/backend/src/core/container-readiness.ts:102`), `docker-cli-errors.ts`, `docker-copy-out.ts` and `dockerDaemonUnreachableNow` (used by `container-replacement.ts:21`) all exist. On 2026-10-26, rootful CI (run 40409285999) passed the readiness and rebuild-fault suites on linux-x64 and linux-arm64, in addition to the file's Docker Desktop runs.

**Decisions.** None: done, with live evidence on both daemons.

### 3. Busy local Cursor bridge keeps its key

**Problem.** A key change replaced a busy local Cursor bridge mid-turn.

**Context.** It now matches the container path.

**Investigation.** Covered by `commands-local-bridge-reuse.test.ts`, as the file says.

**Decisions.** None: done.

### 4. Grok login from the agent-test profile

**Problem.** Agent-test containers staged the host's real Grok login instead of the profile's snapshot. The code fix has not been run against a real login.

**Context.** This also unblocks the Grok half of C21 in [0019](0019-container-platform-qualification.md). The procedure is in `docs/development/agent-testing.md:122` ("Grok container login qualification"), gated by `ORKESTRATOR_AGENT_TEST_LIVE_GROK_LOGIN=1` (`e2e/agent-testing/grok-container-login.spec.ts:10`).

**Investigation.** `grokStagingHome` is at `apps/backend/src/core/portable-inputs.ts:184`. The host still has no usable Grok login: `~/.grok/` has an `auth.json.lock` dated 2026-10-26 but no `auth.json`. The auto-memory note on Grok ACP "Invalid params" (1.0.41 failing at `session/new`) also concerns this host's Grok setup.

**Decisions.**

- **How to unblock it?**
  - **Ask the user to run `grok login` on the host, then run the spec in an isolated `dev:test` profile following agent-testing.md (recommended).**
    - Pros: the agreed procedure; also closes 0019's C21 Grok half.
    - Cons: needs the user's interactive login; Grok's CLI version on the host may need checking first because of the ACP issue.
  - **Use a disposable Grok account on a second machine.**
    - Pros: no host credential involved.
    - Cons: needs another account and machine; the evidence would then not be on the qualification host.
  - **Defer and rely on the unit and staging tests.**
    - Pros: no work now.
    - Cons: the `expires_at == 2000-01-01` assertion, which would have caught the old staging, never runs.

### 5. Container bridge logs

**Problem.** Container bridge logs were missing because mawk block-buffers a piped stdin.

**Context.** Images built before the fix keep the old behaviour until they are rebuilt.

**Investigation.** The fix is in `docker/orkestrator-log-writer.sh` (comment at `:28`). `ce205ad3` ("keep bridge logs streaming and bounded", #1317) has since touched the same area.

**Decisions.** None: done.

### 6. OpenCode egress

**Problem.** OpenCode's zero-config providers failed in restricted mode.

**Context.** Decision 3.

**Investigation.** `packages/protocol/src/network-allowlist.ts:119` lists `opencode.ai` for OpenCode. `docker/default-allowed-domains` is generated from it and pinned by `version-drift.test.ts`.

**Decisions.** None: done.

### 7. Provider refusals in the transcript

**Problem.** A provider's refusal of a turn (for example a model the login does not offer) left no trace in the transcript.

**Context.** Decision 4: a `status` row in Codex and Pi, and `session start` stops pinning the configured default. Its recorded con remains: `session start`'s receipt still reports the configured model as the resolved one when the runtime swaps it.

**Investigation.** Codex: `recordProviderFailure` (`bridges/codex-bridge/src/app-server-runtime-lifecycle.ts:1154`), verified live. Pi: `appendTurnFailure` (`bridges/pi-bridge/src/translate.ts`, used in `prompt.ts:29`), tested only on a unit fixture of `stopReason: "error"`. The Pi login on this host answered every model it was asked for.

**Decisions.**

- **How to get the Pi live evidence?**
  - **Provoke a refusal with a provider the user already has, for example an OpenRouter or API-key provider asked for a model id the key cannot use, in an isolated `dev:test` profile (recommended).**
    - Pros: a real `stopReason: "error"` from Pi's SDK; no new account needed if such a key exists.
    - Cons: depends on which Pi providers the host is signed in to; uses real credentials, so prompts must stay trivial.
  - **Accept the unit fixture and drop the item.**
    - Pros: no live dependency.
    - Cons: a provider whose error shape differs (Pi fronts about fifteen) could still leave an empty row.
- **Fix the receipt's resolved-model report?**
  - **Leave it out of this file and open a new todo if it matters (recommended).**
    - Pros: README rule; it is a reporting gap, not a refusal.
    - Cons: CLI users see a model that did not run.
  - **Treat it as part of item 10.**
    - Pros: one place.
    - Cons: adds new work to an existing file, which the README forbids.

### 8. Budget warning on save

**Problem.** A saved global budget could name an axis the daemon cannot enforce, and nothing said so.

**Context.** Decision 5.

**Investigation.** `unenforceableOnThisDaemon` is used by `apps/backend/src/core/commands-registry-environments.ts:14`.

**Decisions.** None: done.

### 9. Harness cleanup and orphaned setup

**Problem.** Live suites leaked resources, and a setup retry raced an orphaned setup.

**Context.** Decision 6 (wait for the orphan, never run setup twice).

**Investigation.** `removeLabelledResources` (`apps/backend/tests/container-live-cleanup.ts:34-52`) and `CONTAINER_WORKSPACE_SETUP_WAIT_MESSAGE` (`apps/backend/src/core/container-scripts.ts:14`) are present. Note that this cleanup covers only resources the live suites label. The probe-network leak in [0241](0241-leaked-reach-probe-networks.md) comes from backends outside these suites.

**Decisions.** None: done.

### 10. Retire the file

**Problem.** Eleven of thirteen items are done. Only live evidence for items 7 and 10 (Pi) remains, and both depend on external logins.

**Context.** README: delete a file once its last item is done, after moving its durable behaviour. The file already lists where that behaviour lives (`container-lifecycle.md`, `public-cli.md` and the others).

**Investigation.** The folder index rates the file Medium because of the Grok spec. The Pi refusal is only a "Needs verification" item.

**Decisions.**

- **Keep the file open for both pieces of evidence?**
  - **Keep it open for the Grok spec; close the Pi item as accepted on unit evidence unless task 7's first option is cheap on this host (recommended).**
    - Pros: the Grok spec guards a credential-isolation fix and unblocks 0019; the Pi row is a display improvement.
    - Cons: the Pi path is never seen live.
  - **Move both runs into [0031](../cross-cutting/0031-live-provider-and-platform-qualification.md) and delete this file now.**
    - Pros: live runs batched in one place, as the README suggests.
    - Cons: 0031 is an existing file, so new items cannot be added to it; this needs a new file or a rule exception.

The 2026-10-23 qualification pass for
[0019-container-platform-qualification.md](0019-container-platform-qualification.md)
fixed what it found that was small and in scope. This file holds the gaps it
found but did not fix: misleading failure codes, two provider credential
paths, harness leaks, and one stale activity state. None of them grants an
approval, loses data or weakens a firewall today; each is reported with the
evidence that found it.

All thirteen items have code and tests as of 2026-10-26. What is still open is
live evidence only: the real-provider Grok login spec (item 7), which needs a
current host Grok login. See [Outstanding work](#outstanding-work).

## Current state

As of 2026-10-26:

- Every path that stops a runtime itself (an explicit stop, the quiesce
  before a rebuild or a recovery-copy restore) calls
  `NativeAgentService.environmentRuntimeStopped`. It withdraws the
  environment's outstanding agent requests and settles its sessions' turn
  activity to `idle` without announcing a transition. The activity sweep does
  the same once for a container runtime found stopped any other way.
- An exited container's final boot record is read with `docker cp`, so a
  fail-closed boot reports its own code (`firewall-missing`,
  `firewall-failed`) rather than `container-exited`.
- A rebuild copy that loses the daemon fails as `daemon-unavailable`, and the
  image manifest probe no longer reads a lost daemon as a legacy image.
- A busy local Cursor bridge keeps its old key until it is idle, as the
  container bridge already did.
- Agent-test containers take the profile's own Grok snapshot.
- Bridge logs in containers appear as soon as a bridge writes a line.
- OpenCode's `opencode.ai` is a required host when OpenCode is enabled.
- A turn Codex or Pi failed on a provider error (a refused model) says why in
  the transcript, and `session start` no longer pins the configured default
  model.
- Settings warns when a global budget names an axis the daemon cannot
  enforce.
- The live suites remove their resources one at a time and fail on leftovers.
- A setup retry that meets an orphaned setup run waits for it and says so.

Durable behaviour is in
[container-lifecycle.md](../../architecture/container-lifecycle.md) (readiness,
stop and drain, setup completion, copy, budgets, bounded logs),
[public-cli.md](../../architecture/public-cli.md),
[container-qualification.md](../../development/container-qualification.md),
[credentials-and-models.md](../../development/credentials-and-models.md),
[agent-testing.md](../../development/agent-testing.md), root and `docker/`
`AGENTS.md` (network isolation) and the Codex and Pi bridge `AGENTS.md` files.

## Outstanding work

### Agent state after a stop

1. **Done 2026-10-26.** Clear or settle a stopped session's turn activity
   (medium). The per-session activity (`observedSessionActivity`, now in
   `native-agent-launch-activity-reconciler.ts`) was not cleared on stop: the
   sweep skips environments that are not ready and only deletes observations
   whose mapping changed. A session last seen `waiting` therefore stayed
   `waiting` while stopped: `session get` showed `activity: waiting`,
   `session send` refused it as busy, a move was refused as running
   (`hasObservedLiveWork`), and the run observer reported `running`.
   - Fix: `settleStoppedSessions` sets each observed session of the stopped
     environment to `idle` after fencing activity reads in flight
     (`replaceEnvironmentGenerations`) and dropping the broker's retained
     record. It announces no activity transition and records no completion,
     only a view invalidation; the next start reads `idle` against `idle`, so
     no "finished" edge fires. A turn that was still working or waiting is
     marked `stoppedMidTurn`, and the run observer settles that run
     `interrupted` (evidence `none`). See decision 1.
   - Evidence: `native-agent-service-stopped-runtime.test.ts` (waiting →
     idle with no transition or completion, and none on the next start; a
     turn that had handed over to background work is not reported cut off; a
     read started before the stop cannot land after it; the sweep catch-all),
     `public-api-sessions.test.ts` ("a run whose environment stopped under it
     settles interrupted, not unknown", with `session.get` reading `idle`), and
     `commands-registry-environments-status.test.ts` (both stop lanes call it
     after the stop commits).
2. **Done 2026-10-26.** Withdraw outstanding requests on the other stop paths
   (low). `quiesceRuntime`, which both a rebuild and a recovery-copy restore
   run, now calls `settleStoppedRuntimeAgents` (withdraw and settle) once the
   runtime is stopped. A container that dies on its own and is found by
   lifecycle reconciliation is caught by the activity sweep: once per stop,
   for container environments whose status is `stopped`
   (`settleStoppedRuntimes`). Local environments are excluded there, because
   a local stop that could not end a bridge records `stopped` but
   deliberately keeps that bridge's requests. See decision 2. Evidence: the
   sweep test in `native-agent-service-stopped-runtime.test.ts` (withdrawn
   once per stop, re-armed by a start, a stopped local environment untouched).

### Failure classification

3. **Done 2026-10-26.** Keep the specific boot failure code (low). When the
   readiness poll finds the container not running, `waitForContainerBoot`
   copies the final boot record out with `docker cp` (bounded, no running
   process needed) and reports its code. With PID 1 gone the record counts
   only if its `updatedAt` is not before the run's `State.StartedAt`
   (`parseExitedBootRecord`); otherwise, or with no readable record, it stays
   `container-exited`. Evidence: `container-readiness.test.ts` (parser cases;
   a fake exited container whose copy returns a real tar; stale, missing and
   daemon-down copies stay `container-exited`), and the live readiness suite
   on Docker Desktop 29.7.2 (arm64) with image `orkestrator-v2:dev-328f789706d7`
   built from this branch, passed 2026-10-26 with its assertions tightened to
   exactly `firewall-missing` and `firewall-failed` (they previously accepted
   `container-exited`). A restart during launch may now read
   `entrypoint-failed`, the record the held entrypoint writes on SIGTERM; that
   scenario accepts either.
4. **Done 2026-10-26.** Report a daemon outage during a rebuild copy as
   `daemon-unavailable` (medium). `pipeContainerPath` now captures the helper's
   stderr as well and reports `daemonUnavailable` when either side reached no
   daemon; `runCopyStep` maps that, and a volume-copy helper that failed the
   same way, to `daemon-unavailable`, and the rebuild fails with
   `ContainerLifecycleError:daemon-unavailable` ("Docker stopped responding
   while the environment's files were being copied…") instead of
   `needs-attention … failed verification`. A step that failed without
   such wording asks the daemon directly (`dockerDaemonUnreachableNow`, a
   bounded `docker version`): the live suite showed that a `docker cp` cut off
   mid-stream reports its broken stream, not the daemon. The wording is classified once in
   `docker-cli-errors.ts`, which `operationFailureCode` and
   `dockerUnavailableReason` now share, so `failed to connect to the docker
   API` is recognised everywhere. Evidence: `docker-cli-errors.test.ts`,
   `container-replacement.test.ts` (pipe cases), and the live rebuild-fault
   suite, whose C15 disconnect assertions now require `daemon-unavailable`
   and pass (results below).
5. **Done 2026-10-26.** Stop misreading a lost daemon as a manifest-less image
   (medium). `copyOutBounded` moved to `docker-copy-out.ts` with the strict
   rule: only the daemon's "could not find the file" is `absent`; a CLI that
   reached no daemon is `daemon-unavailable`, and `readImageManifest` reads
   both that and any other failure as `unavailable`, which is never cached.
   Evidence: `docker-image.test.ts` ("a daemon lost between the probe's create
   and its copy is unavailable, never legacy", including the next read
   finding the manifest).

### Provider credentials

6. **Done 2026-10-26.** Keep a busy local Cursor bridge on its key (medium).
   Verified before the change, as asked: a new test in
   `commands-local-bridge-reuse.test.ts` started a real local Cursor bridge
   process, changed the configured key while `hasObservedLiveWork` answered
   true, and the bridge was replaced (`wasRunning: false`, a new pid). The
   reuse check in `startLocalServerAttempt` now treats a changed key as
   matching while the bridge has observed live work, as the container path
   and the local account switch do; the first start once it is idle applies
   the new key. The same test now passes: kept while busy, replaced once
   idle, and the replacement holds the new key.
7. **Code done 2026-10-26; live run owed.** Read the Grok login from the
   profile in agent-test profiles (medium). Container staging
   (`portableInputSpec`, `grok-home` and `grok-config`), the push before each
   bridge start and the login file watcher (`hostStagingSources().grokAuth`)
   and the legacy bind path now share `grokStagingHome`: in agent-test, the
   run's own restricted copy, which is `GROK_HOME` when set (a CLI scenario
   keeps the real `HOME` and its disposable copy there) and otherwise
   `$HOME/.grok`, a `dev:test` profile's isolated
   `<dataDir>/agent-credentials/home`, where `dev:test` seeds its snapshot and
   the profile's local Grok already read it. `HOME` is read from the
   environment because Bun reads `os.homedir()` once at startup; outside
   agent-test nothing changes. Evidence: `portable-inputs.test.ts` ("an
   agent-test profile stages its own Grok snapshot, never the real host's"
   and "an agent-test run's Grok home is GROK_HOME, else its own HOME, never
   the host's"), the staging, push and watcher tests in
   `agent-accounts-containers.test.ts` and
   `container-login-file-watcher.test.ts`, the legacy mounts in
   `commands-registry-environments-status.test.ts` (the host copy is a decoy
   that must not be mounted), and the CLI scenario
   `scenario-provider-homes.test.ts`, unchanged and passing.
   - Still owed: run `grok-container-login.spec.ts` against a live login.
     This host's Grok login expired on 2026-10-24, so the spec would skip.
     To close: run `grok` (or `grok login`) on the host, then follow
     [agent-testing.md](../../development/agent-testing.md#grok-container-login-qualification)
     (`ORKESTRATOR_AGENT_TEST_LIVE_GROK_LOGIN=1`). Expect a pass, including
     the `expires_at == 2000-01-01` assertion that the old staging would have
     failed. This also unblocks the Grok half of C21 in 0019.
8. **Done 2026-10-26.** Find out why container bridge logs are missing (low).
   Reproduced in a throwaway container of a current dev image: a healthy
   Cursor bridge under `orkestrator-log-writer` with debug logging on had no
   `/tmp/cursor-bridge.log`, while the same bridge redirected to a file wrote
   0 bytes at startup and `bun -e 'console.info(1); setInterval(…)'` reached a
   plain `| cat` at once but never reached the writer. The cause is the
   image's awk, Debian's mawk 1.3.4, which block-buffers a piped stdin unless
   given `-W interactive`. A bridge prints nothing until a turn runs with
   debug logging on, and then too little to fill the buffer, so the file was
   never created; a noisy bridge's last few KiB, the lines a failure diagnosis
   needs, were held back the same way. The writer now passes `-W interactive`
   to an awk that accepts it silently: mawk, but not BSD awk (rejects it) or
   gawk 5.4.1 on the Omarchy host (warns and ignores it). Verified in the
   container: the first line appears at once, and rotation and the
   no-newline bound behave as before. Regression test:
   `container-log-service.test.ts` ("writes a quiet producer's first line
   while its pipe stays open", meaningful on Linux CI, where awk is mawk).
   Images built before this change keep the old behaviour until rebuilt.

9. **Done 2026-10-26 (decision 3).** Decide whether restricted containers
   allow `opencode.ai` for OpenCode (medium). Chose to add `opencode.ai` to
   OpenCode's required hosts (`AGENT_NETWORK_DOMAINS_BY_PLATFORM.opencode`),
   added to a container's allowlist only while OpenCode is enabled, as for
   Codex, Cursor, Grok and Pi. `docker/default-allowed-domains` regenerated.
   Evidence: `constants.test.ts` ("OpenCode gets only its own providers'
   host"), `network-allowlist.test.ts`, `version-drift.test.ts`. A container
   created earlier gets the host when its list is next applied or the
   container is rebuilt.
10. **Done 2026-10-26.** Surface a provider's refusal of a turn (medium).
    Reproduced live with the Codex bridge from this branch (codex 0.162.1)
    on an isolated `CODEX_HOME` holding an access-only copy of a ChatGPT
    login: a `gpt-5.4` turn ended with `/status` `error` and the message
    "The 'gpt-5.4' model is not supported when using Codex with a ChatGPT
    account.", `/activity` `idle`, and a transcript holding only an empty
    assistant row. The session status did carry the error, and the native
    tab shows `turn.error` while it lasts, but the transcript kept nothing and
    the next turn replaced the status.
    - Codex: a turn app-server reports failed now gets an error `status`
      line on its last row (`recordProviderFailure`,
      `messages/turn-failure.ts`, which reduces the JSON body to its
      `error.message`), and the rollout replay adds the same line from the
      `task_complete` record's `error`. Re-run live: the transcript showed
      the refusal, live and after a bridge restart and resume. Tests:
      `app-server-runtime-lifecycle.test.ts`, `rollout-rows.test.ts`,
      `turn-failure.test.ts`.
    - Pi: a turn Pi ends on a failed response gets the same line
      (`appendTurnFailure`), and a retried response a later answer replaces
      adds nothing (`http.test.ts`). No refusal could be produced live: Pi
      from this branch on an access-only copy of the host's `openai-codex`
      login answered on its default (`openai-codex/gpt-5.6-luna`, picked with
      no saved default) and on `openai-codex/gpt-5.4`.
    - Defaults: the shipped Codex default `gpt-5.4` stays. An inherited
      default has been resolved against the live model list and swapped for an
      offered model since 2026-10-17, but `session start` passed the
      configured default as `modelId`, which pinned it. That is why the C13
      run needed `QUALIFY_MODEL`. It now passes `modelId` only for `--model`
      (`public-api-sessions.test.ts`, "an inherited default model stays a
      default the runtime may replace"). Pi's default needs no change. See
      decision 4.

### Rootless follow-ups

11. **Done 2026-10-26 (decision 5).** Check the global default budget against
    the daemon when it is saved (low). `set_container_resource_limits` still
    saves the budget but answers with `unenforceable` axes
    (`unenforceableOnThisDaemon`, built on the shared `unenforceableAxes`
    beside `axisEnforceable`). Settings shows the same warning inline while a
    custom budget is edited and as a warning toast on save. Evidence:
    `commands-registry-resource-limits.test.ts` (a rootless daemon with only
    memory delegated), `container-resources.test.ts` in the protocol package,
    and `ContainerResourceLimitsSettings.test.tsx`.

### Harness

12. **Done 2026-10-26.** Remove live-suite resources one at a time (low).
    `removeLabelledResources` (`apps/backend/tests/container-live-cleanup.ts`)
    removes every labelled container, then volume, then network, one per
    call, and returns what is left. The lifecycle, network, firewall,
    replacement and readiness suites' `afterAll` hooks use it and assert
    nothing is left; the rebuild-fault suite's own loop moved onto it, and the
    in-test multi-argument removals in the network, lifecycle and
    data-contract suites became one per call. Evidence:
    `live-suite-cleanup.test.ts`, and the live runs below.
13. **Done 2026-10-26 (decision 6).** In-container setup outlives a killed
    setup terminal (low). A retry now waits for the orphan, never stops it and
    never starts setup a second time, and says so first:
    `CONTAINER_WORKSPACE_SETUP_COMMAND` probes the lock with `flock -n` and
    prints `CONTAINER_WORKSPACE_SETUP_WAIT_MESSAGE` before blocking on it.
    Once the orphan is done, the script reports "Workspace already set up" if
    it succeeded or runs setup itself if it failed; the exit status is the
    script's. Documented in container-lifecycle.md ("Setup completion").
    Evidence: run in a container of the image with a held lock (message, a 3 s
    wait, "Workspace already set up", exit 0; a failing script's exit 3
    propagates), and `container-scripts.test.ts`, whose lock tests need
    util-linux `flock`: they passed in that container and skip on macOS.

### Live runs, 2026-10-26

Docker Desktop (Engine 29.7.2, arm64), image `orkestrator-v2:dev-328f789706d7`
built from this branch, `RUN_LIVE_DOCKER_TESTS=1`:

| Suite | Result | What it now proves here |
| --- | --- | --- |
| `container-live-readiness.test.ts` | pass (247 s) | Item 3: a missing firewall reads `firewall-missing` and a DNS-broken bootstrap `firewall-failed`, never `container-exited`; item 12 cleanup with no leftovers |
| `container-live-rebuild-faults.test.ts` | first run 4 pass, 1 fail; after the fix 5 pass (114 s) | Item 4: both C15 disconnects fail as `daemon-unavailable`. The first run found that a legacy migration whose `docker cp` stream is cut mid-copy still read `needs-attention … (source-read-failed)`: the CLI reports the broken stream, not the daemon. A failed copy step now asks the daemon directly (`dockerDaemonUnreachableNow`) before calling the files the cause |
| `container-live-qualification.test.ts` | 6 pass (20 s) | Item 12 cleanup |
| `container-live-network.test.ts` | pass (52 s) | Item 12 cleanup; C26 bounded logs through the fixed writer |
| `container-live-firewall.test.ts` | 2 pass (39 s) | Item 12 cleanup |
| `container-live-replacement.test.ts` | pass (169 s) | Items 2 and 12: rebuilds through `quiesceRuntime`, cleanup |

No container, volume or network was left after any run; every hook now
asserts that.

## Assumptions and decisions

Made on 2026-10-26. Each gives the options considered, the choice, why, and
its pros and cons.

### Assumptions

- Probes that used a real provider login used only an access-only copy (the
  refresh token blanked) in a private temporary directory, removed after the
  run, and only trivial prompts. The host's own login files were only read.
- The shared Docker Desktop was not restarted or pruned. Probe containers
  were created by name and removed by name.
- The Omarchy host was used read-only (awk and flock versions); nothing was
  written there.

### Decisions

1. **What a stop does to turn activity (item 1, the open question).**
   Options: mark the turn `interrupted` as a new activity state; clear the
   observation and let the reattached session report; or settle it to `idle`
   quietly and keep what happened in a flag. Chose the quiet settle with
   `stoppedMidTurn`. A new `AgentActivityState` would ripple into every
   consumer and the renderer. Clearing makes the next start a first
   observation, which with a PR recheck armed records a completion and
   re-announces a `waiting`, the false edge the item warned about; it also
   leaves the session `unknown` while stopped. Announcing an idle transition
   would tell a coordinator its worker finished and drain queued prompts into
   a stopped environment. Pros: busy refusals and stale `waiting` go away
   with no false edge, and the run observer can still say the turn was cut
   off. Cons: a turn that finished in the last two seconds before the stop
   but was not yet observed reads `interrupted` instead of `completed`
   (evidence `none`, so it claims nothing false about the outcome), and the
   flag lives in memory only, so a backend restart while stopped loses it and
   such a run then ends `unknown`.
2. **How the other stop paths are covered (item 2).** Options: an explicit
   call at every stop site; a sweep catch-all; or both. Chose both: explicit
   in `quiesceRuntime` (rebuild and restore, immediate), and the sweep for a
   runtime found stopped by reconciliation, once per stop and for container
   environments only. Pros: no future stop path is missed. Cons: a stop seen by
   both settles twice, which re-announces an unchanged projection revision
   once, and a container that is stopped and restarted within one sweep
   interval is not caught by the sweep (its new bridges answer for it).
3. **OpenCode egress (item 9).** Options: add `opencode.ai` to OpenCode's
   required hosts; leave it to each environment's list and document it; or add
   it only when OpenCode has no other provider login. Chose the required host.
   It is the vendor's own endpoint for the providers a fresh OpenCode offers
   with no login, which is how every other platform's vendor hosts are
   treated, and OpenCode was the only enabled platform whose zero-config path
   failed in the default restricted mode. Detecting "no other login" would
   tie the firewall to a credential file the user can change inside the
   container. Pros: works by default; one host, TCP 443 under policy 3. Cons:
   every restricted container of an install with OpenCode enabled can reach
   `opencode.ai`, including its session-sharing service, even for users who
   never use OpenCode's providers. As with every allowed host, the firewall
   limits destinations, not what leaves through them.
4. **Provider refusals (item 10).** Options: rely on the session status and
   the tab's error banner; add a transcript row; or change the defaults.
   Chose a transcript row in Codex and Pi, the `status` part Claude already
   uses for a startup failure, added only for the provider's own failure
   report (not the bridge's verdicts, which have their own presentation). And
   fix the CLI so a configured default stays a default rather than changing
   the shipped defaults: the Codex default is already swapped for an offered
   model where it can be, and Pi's default worked live. Pros: the reason
   survives the next turn and a reload, and CLI sessions on default settings
   work on a ChatGPT login. Cons: the reason is the provider's text (bounded
   to 2,000 characters); `session start`'s receipt still reports the
   configured model as resolved when the runtime swaps it.
5. **Budget check on save (item 11).** Options: refuse an unenforceable
   budget on save; save it and warn; or warn only in the editor. Chose save
   and warn, both inline and on save. Refusing would make Settings depend on
   a reachable Docker and block a default meant for another daemon. Pros:
   Settings says what the daemon would do, and the create-time refusal stays
   the enforcement. Cons: the budget can still be saved, and the warning
   reflects only the daemon reachable when it is shown.
6. **Orphaned setup (item 13).** Options: stop the orphan and rerun setup;
   wait for it; or refuse the retry while the lock is held. Chose to wait and
   say so. Stopping it part-way and rerunning would run setup twice, which the
   constraints forbid, and refusing would leave the user nothing to do but
   retry blindly. Pros: setup runs exactly once and the retry ends with that
   run's outcome. Cons: the orphan's own output went to the terminal that
   closed and is not replayed, and a retry waits as long as the orphan takes.
7. **Shared Docker CLI wording (items 4 and 5).** Options: patch each regex
   where it was; or one module. Chose `docker-cli-errors.ts`, shared by the
   copy steps, the manifest probe, `operationFailureCode` and the availability
   check. Pros: one place for the next CLI wording change. Cons:
   `operationFailureCode` now also maps "connect: no such file or directory"
   to `daemon-unavailable`, a wider match than before.
8. **A copy step that failed without naming the daemon (item 4).** Options:
   add the broken-stream wording to the table; treat every producer failure
   as an outage; or ask the daemon. Chose to ask: a bounded `docker version`
   once the step has failed. The cut-stream wording was not captured, and a
   broken stream can also be a daemon-side fault on a reachable daemon.
   Pros: reports what is true when the user reads it. Cons: up to 10 s more
   on a failed rebuild, and a daemon that comes back within that window
   reads as a file failure (still safe: the original is kept either way).

## Constraints and rationale

- None of these may grant an approval, run setup twice or weaken a firewall to
  fix a message. Generation death denies or withdraws (AGENTS.md invariant 10).
- Fault injection stays in test fixtures at the lifecycle-service boundary.

## Open questions

- None. Item 1's question (interrupted versus cleared) is answered by
  decision 1.

## Needs verification

- Item 7: the live Grok login spec, above.
- Item 10 for Pi: a live refusal. None could be produced on this host's login;
  the fix rests on the existing unit fixture of Pi's `stopReason: "error"`
  response. A Pi provider login that refuses its model would confirm it.

## Related

- [0019-container-platform-qualification.md](0019-container-platform-qualification.md):
  the qualification pass that found these.
- [0018-container-network-and-credential-isolation.md](0018-container-network-and-credential-isolation.md):
  Grok and Cursor credential delivery.
- [Container lifecycle](../../architecture/container-lifecycle.md),
  [container qualification](../../development/container-qualification.md).

## Replaces

Nothing; new work from the 2026-10-23 pass.
