# Container platform qualification

Checked against `main` at `31d0fb06` (2026-10-17).

The container lifecycle (durable operations, persistent storage, staged
inputs, per-environment networks, resource budgets, bounded logs) shipped in
#877 with live evidence from Linux Docker Engine 29.7.2 on amd64. On
2026-10-17 the full live set also passed on Docker Desktop for Apple Silicon
(see [Results, 2026-10-17](#results-2026-10-17)). This file lists the
real-platform and real-provider evidence that is still missing, and how to
reproduce the suites that produce it. Until it exists, rootless Engine and
five of the six providers' session resume are claims the product gates rather
than behaviour it has shown.

## Current state

- Four opt-in live suites run against a real daemon when
  `RUN_LIVE_DOCKER_TESTS=1` and `ORKESTRATOR_QUALIFICATION_IMAGE=<image>` are
  set: `apps/backend/tests/container-live-qualification.test.ts`,
  `container-live-replacement.test.ts`, `container-live-network.test.ts` and
  `container-live-firewall.test.ts`. Between them they cover C09, C11, C12,
  C14–C20, C22–C24 and C26. Every resource carries a per-run label and an
  owner label derived from a private temporary data directory, and `afterAll`
  removes exactly those resources. Their shared fixture
  (`memoryLifecycleContext`) supplies an empty account store, which container
  creation has needed since account switching (#889).
- The benchmark harness is `apps/backend/tests/container-benchmarks.test.ts`
  (`RUN_CONTAINER_BENCHMARKS=1`). It writes JSON under `output/benchmarks/`
  and covers C28.
- `docker/tests/final-image-smoke.sh <image>` runs in
  `.github/workflows/validate-bun-runtime.yml` on the native amd64 and arm64
  builds (manifest versions against the installed CLIs, every bridge's
  `/global/health`, Codex's code-mode host, Chromium). That is the smoke half
  of C27. The live C-scenarios ran natively on arm64 on 2026-10-17.
- Real-stack specs: `e2e/agent-testing/container-rebuild-cycle.spec.ts` (C29)
  and `e2e/agent-testing/container-settings.spec.ts` both match the
  "Docker fixture" grep of `test:agent:docker`.
  `e2e/agent-testing/container-approval-stop.spec.ts` (C11 approval half)
  matches it too, but runs only with
  `ORKESTRATOR_AGENT_TEST_LIVE_CONTAINER_APPROVAL=1`, because it sends a real
  Claude turn. `test:agent:browser:isolated` covers the local-worktree
  regression (C30).
- Provider session resume after a rebuild is gated by
  `RESUME_QUALIFIED_PROVIDERS` in `apps/backend/src/core/container-replacement.ts`,
  which holds only `claude`. `rebuildPreview` marks every other provider's
  resume as unverified. `scripts/qualify-session-resume.sh <profile> <agent>
  [environment-name]` is the C13 driver: it plants a codeword, rebuilds onto a
  new runtime generation and checks the resumed session repeats it (exit 0
  pass, 1 fail, 2 setup error).
- `detectDockerTopology` (`apps/backend/src/core/docker-image.ts`) reports
  `desktop` and `rootless`. Desktop is qualified; rootless is not. The living
  doc says "Qualified locally: Docker Engine 29.7.2 on Linux amd64 and Docker
  Desktop 4.93.0 (Engine 29.8.1) on Apple Silicon".
- Unit-only today: readiness failure typing (`apps/backend/tests/container-readiness.test.ts`),
  C10 (setup interrupted after a side effect), the fixture half of C21
  (interrupted revoke, staging interrupted by a restart), and kill-at-every-phase
  reconciliation of a rebuild. The live half of C21 ran for Codex on
  2026-10-21 (results below).

The commands that reproduce the evidence, the C01–C30 scenario matrix, the
platform dimensions and the benchmark targets are in
[container-qualification.md](../../development/container-qualification.md).

## Results, 2026-10-17

Commit `31d0fb06` (`main`). Host: macOS 27.0, Apple M5 Pro, 18 CPUs, 64 GB.
Docker Desktop 4.93.0 (Engine 29.8.1, API 1.56, linuxkit 7.0.14,
`linux/arm64`); the VM reports 18 CPUs and 8.3 GB, cgroup v2, with CPU, memory
and PID limits supported. Everything ran natively on arm64; nothing came from
emulation.

The qualification image was the workspace's isolated development image
`orkestrator-v2:dev-b4d6266ccb00`
(`sha256:3f4603f57e80d06b9799aa91bdf9ae421cb51a3e0c72e01cd180cddc4269457c`),
built with `mise run docker:build:dev --profile cq8efe-docker`. Its manifest
records source revision `31d0fb06`, app version 2.21.1, `network-policy=3`,
`persistent-workspace=1` and `claude-state-signal=2`. The real-stack profile
was `cq8efe-docker`, started with `--fixture --fixture-environments
local,container --credential-source claude`. Nine other environments were
running tests on the same host and daemon throughout, at a load average of
15–27.

| Suite (command) | Scenarios | Result |
| --- | --- | --- |
| `bash docker/tests/final-image-smoke.sh <image>` | C27 (arm64 half) | Pass: CLI versions match the manifest, all five bridges answer `/global/health`, Codex's code-mode host and Chromium work |
| Live lifecycle (`container-live-qualification.test.ts`) | C09 (2), C11 drain, C12 (2), C20 | 6/6 pass (first run 4/6, see below) |
| Live replacement (`container-live-replacement.test.ts`) | C14 (2), C15/C16 (5), C17/C18 (2), C19 | 10/10 pass |
| Live network (`container-live-network.test.ts`) | C22, C24 (2), C26 | 4/4 pass (first run 0/4, see below) |
| Live firewall (`container-live-firewall.test.ts`) | C23, policy-3 tuples | 2/2 pass |
| Benchmarks (`container-benchmarks.test.ts`) | C28 | Three runs; see the table below |
| `test:agent:docker` | C29, container settings (desktop and narrow), foreign-profile refusal, Playwright as both container users | 5/5 pass |
| Live approval (`container-approval-stop.spec.ts`) | C11 approval half, Claude | No run granted the approval. With the layout fix, 3 of 5 runs passed end to end; the other 2 showed Connection Failed after the restart. After the review fix (`99263373`), 4 of 4 runs passed (see below) |
| `test:agent:browser:isolated` | C30 | 25 passed, 15 opt-in skips, 1 failed: the narrow host picker, known flake [0224](../../tests/flaky-tests/0224-host-picker-narrow-tools-popover.md), which passed alone. Every local-worktree scenario passed |

After the fixture fix, the live suites ran twice each, both clean: once
through `mise run test:logged` (Bun 1.4.3) and once directly with Bun 1.4.2
from `PATH`, which printed the per-test counts. Nothing was skipped.

On Desktop specifically:

- C22 passes without the host-gateway alias, which `createDockerContainer`
  adds only for a Linux Engine. IPv6 is reported `blocked` or `disabled`
  (the assertion accepts either and does not print which). Siblings are refused by
  their IP, through the environment gateway and through a port a sibling
  publishes. Only the service port leaves the container.
- `get_docker_capacity` reports the VM (`operatingSystem: "Docker Desktop"`,
  8.3 GB), not the Mac's 64 GB. The preserving rebuilds in C14 and the
  benchmarks passed their capacity preflight.
- Volume sub-path mounts work (Engine 29.8.1 ≥ 26): C12 mounts every
  `PROVIDER_STATE_LAYOUT` path from the storage set.
- The host has Homebrew GNU `tar` and `date`, which the shell fixtures prefer
  (#988). Hosts without them were not tried.

### Benchmarks

The targets are from [container-qualification.md](../../development/container-qualification.md#benchmarks).
Run 1 used Bun 1.4.2 from `PATH`; runs 2 and 3 used the pinned 1.4.3 (`mise
exec`). All three ran with nine other environments active.

| Measure (median) | Target | Run 1 `bmvbp5040` | Run 2 `bmvbpaj1e` | Run 3 `bmvbpgt1f` |
| --- | --- | --- | --- | --- |
| Load average at start | | 26.7 | 19.6 | 23.8 |
| Fresh restricted to ready | ≤ 3 s | 1.98 s | **3.33 s** | 2.42 s |
| Incomplete fresh boots | none | none | none | none |
| Docker calls per fresh environment | ≤ 21 | 14 | 16 | 15 |
| Three concurrent, against the sequential median | ≤ 1.5× | 0.89× | 0.95× | 1.13× |
| Warm stop | ≤ 1 s | 0.58 s | 0.60 s | 0.60 s |
| Warm start to ready | ≤ 2 s | 1.13 s | 1.68 s | 1.52 s |
| Rebuild copy and verify, 5,000 files (100 MB) | ≤ 20 s | 13.1 s | 16.3 s | 10.5 s |
| Docker calls per minute, Docker view open | ≤ 36 | 24 | 24 | 24 |
| Log followers after the idle grace | 0 | 0 | 0 | 0 |

Run 2 missed the fresh-environment target by 0.33 s. Every phase of that run
was uniformly slower than run 1 (storage +39 %, create +35 %, start to ready
+83 %), while the median Docker call count barely moved (14 to 16). That
pattern points to
host contention rather than a regression, and run 3 was back within target.
The figures need a quiet host before they can count as a clean baseline.
Other figures: the 200-file rebuild took a median of 4.2 s, 7.2 s and 4.5 s in
total; the usage sampler took about 2.0 s for 8 running environments, with 3
Docker calls; observer churn left 0 followers, with no RSS growth.

### C11 approval half (Claude, real provider)

The spec opens a Claude tab in the fixture container and starts it in **Build**
mode with approvals set to **Ask**. The prompt is `touch
/workspace/.c11-approval-<n>`. Then it switches to `fixture-local` and stops
the container from the sidebar. It returns to the stopped view, starts the
container there and waits for the session to reattach. Observed states:

| Phase | Backend projection | UI |
| --- | --- | --- |
| Asked | `command-approval: pending` | Approval card shown |
| Stopped | `command-approval: pending` (last snapshot; the bridge and CLI were drained) | — |
| Stopped view opened | `command-approval: pending` | "Container is not running / Start Container"; no agent tab, no approve or deny button |
| Started, session reattached | no interactions; turn `idle` | The Claude tab is back; no approval card |

The marker file never existed, and no interaction ever reached `resolved`.
Every run checked the marker while the approval was pending. The passing runs
checked it again after the restart. Of the two that failed at the reattach,
the later one was checked by hand in the container afterwards, and its marker
was absent. The other one's container had been rebuilt by the next spec
before it could be checked.
The approval was withdrawn by process death and never granted. Claude's bridge
has no SIGTERM handler, so it neither denied nor withdrew the request
explicitly. The architecture doc used to claim that bridges "deny or withdraw
on the way out"; it now describes the actual behaviour. The stale `pending`
in the projection while stopped is not reachable from the stopped view; an
outstanding item below checks whether any other surface reads it.

In 2 of the 5 runs with the layout fix, the restored Claude tab showed
**Connection Failed — Unable to connect to Claude** after the start. No error
text was shown and nothing retried automatically. Meanwhile the Claude bridge
in the container answered `/global/health`, but the backend projection stayed
`null`. The first diagnosis blamed a read racing the bridge start. The Multi
Review found the actual cause: `paneLayoutStore.reset` called
`cleanupTabResources`, which requests `teardownTab` for native and tmux tabs.
With the bridge stopped, that teardown could not complete. It stayed as a
pending intent ("Tab teardown remains pending … bridge is unavailable" appears
in the backend log for these runs' tabs). The periodic teardown sweep then
closed the session once the restarted bridge answered. A `null` read follows,
which `useNativeAgentSession` treats as "no session"
(`useNativeAgentSession.ts:2488-2491`), so the controller shows the error
state (`AgentNativeTab.controller.tsx:2090-2101`). The intermittency is the
sweep's 60-second schedule. `99263373` makes `reset` release local views only,
so no teardown intent is created. The spec now forces
`reconcile_tab_teardowns` after the restart, sends a follow-up turn and checks
that the provider session mapping is unchanged. It passed in the Fix session's
run and in 3 of 3 runs on the merged branch (load average 15–20). If
Connection Failed comes back after a restart without a pending teardown
intent, reopen this as a bridge-start race.

Also seen on this host: the backend's reachability probes from inside the
container got `outcome=reachable http=405` from
`http://host.docker.internal:<port>/mcp`. So on Desktop the agent-tools port
is actually answered, not merely left the container. That is evidence for the
C22 live host-service item below; it was not checked by a dedicated run.

### Problems found and fixed

1. **Live-suite fixture drift.** The first lifecycle run failed C12
   (backend-created runtime) and C20. The first network run failed all four
   tests, and the benchmark harness had the same gap. Each failed with
   `context.storage.loadAgentAccounts is not a function`, because
   `createDockerContainer` has resolved the active account since #889
   (`agent-accounts-containers.ts:91`). The replacement and firewall suites
   had their own inline stubs. The empty account store now lives in the shared
   `memoryLifecycleContext` (`apps/backend/tests/container-lifecycle-fixtures.ts`),
   and the two inline copies are gone.
2. **Agent tabs vanished when a stopped container was started from its own
   view.** `TerminalContainer.view.tsx` resets the renderer's panes when the
   container stops. `paneLayoutStore.reset` emptied the layout but left the
   environment's hydration marked `done`. On the next start the seeding effect
   saw no tabs and added a default "Terminal 1" instead of restoring the
   persisted layout. The backend refused to write that terminal over the
   durable layout ("Pane layout intent targets stale environment generation:
   expected <container id>, received local"), so a reload brought the tab
   back. `reset` now also clears the hydration marker, so a restart re-reads
   the backend layout. The regression test is "restores the persisted layout,
   not a default terminal, when a stopped container starts again" in
   `TerminalContainer.view.test.tsx`; it fails without the fix. The live C11
   spec covers the same path.

### Pane reset review follow-up, 2026-10-17

Validated the review fixes on top of `309f7a5d` in
`todo-container-live-qualification-8efe5278910a-r1`, using the disposable
profile `qa-pane-reset-review` (Docker Desktop 29.8.1, macOS arm64). Runtime
reset now releases local views without requesting native/tmux tab closure.
Stopping during the first pending hydration also clears it; request identities
prevent its late response from settling the next start's restore.

- The focused pane store, persistence, TerminalContainer and resource-sync
  tests passed through `test:logged` (`--name reset-final`, one Bun worker).
  Coverage includes native stop/start, replacement container IDs, a stale
  pending hydration, and suppression of the reset's empty persisted layout.
- `ORKESTRATOR_AGENT_TEST_PROFILE=qa-pane-reset-review ORKESTRATOR_AGENT_TEST_DOCKER=1 ORKESTRATOR_AGENT_TEST_LIVE_CONTAINER_APPROVAL=1 mise run test:logged -- --name c11-live-reselect -- mise run test:agent:browser -- e2e/agent-testing/container-approval-stop.spec.ts`
  passed (one test, 85.3 s). The fixture had no prior pane layout. The browser
  used the profile's loopback gateway at 1440×1000. It stopped/restarted the
  container from its own stopped view after switching away, retained the
  original native mapping, forced teardown reconciliation, completed another
  turn while inactive, and reopened/reloaded the native tab. Cleanup confirmed
  both the layout and mapping were absent. The first run reached the completed
  follow-up turn but failed because reload returned to the unselected workspace;
  the spec now explicitly selects the environment after reload. Evidence:
  `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.RlXZkp/c11-live.log.gz`.
- `ORKESTRATOR_AGENT_TEST_PROFILE=qa-pane-reset-review mise run test:logged -- --name docker-fixture -- mise run test:agent:docker`
  passed (five tests, one live-provider opt-in skip, 61.1 s). The live case
  was already run separately above. Results are under
  `output/agent-testing/qa-pane-reset-review/browser/`.
- Format, lint, full typecheck, the flaky-register test and the backend
  retaining-close tests passed. The broad repository/browser runs also hit
  unrelated failures, recorded in the flaky-test register (0165, 0174, 0178,
  0194, 0210, 0226 and 0278). Pi runtime staging also timed out on both owning-file
  reruns, so this validation does not establish a fully green repository suite.
  The full suite finished in 565.3 s: web passed 7892 tests (10 skipped),
  backend reported four failures and one late error, root one failure, and
  bridges one failure. Full evidence:
  `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.XKPva3/`
  (outer logged artifact `orkestrator-test-run.XD6iJX/full-suite.log.gz`).

`dev:stop` and `dev:reset` completed for this profile; no launcher was retained.
Reset removed two exact-owner containers, four volumes, one network and the
disposable profile state. No Electron-only or iOS behavior changed; those
scenario suites were not selected.

3. **A stop's pane reset closed native sessions after the restart.** Found by
   the Multi Review and fixed in `99263373`; the diagnosis is in the C11
   section above. The reset also cancels pending layout writes, and a
   hydration request from before the stop can no longer settle the restore
   the next start begins.

Seen but not fixed: a dev or agent-test profile shows "Orkestrator has been
updated … the server now runs 44.7.0". The dev launcher starts Electron on a
bare script (`apps/desktop/scripts/dev/lifecycle.ts:629`), so
`app.getVersion()` returns Electron's own version, and that becomes
`ORKESTRATOR_VERSION`. Tracked in
[0030-test-suite-and-ci-health.md](../cross-cutting/0030-test-suite-and-ci-health.md).

### Decisions

1. **Qualification image.** Options: an existing image from earlier in the
   day, a separate `docker/build.sh` tag, or the profile's development image.
   We used the development image built from `31d0fb06`. One image id then
   serves the live suites, the benchmarks and the real-stack run, and its
   manifest proves the source revision. `orkestrator-v2:latest` was never used.
2. **Fixture drift.** Options: an inline stub in each failing suite (matching
   replacement and firewall), or one default in the shared fixture. We chose
   the shared default, which fixes all three and stops the next suite from
   drifting the same way. Suites can still override it with `Object.assign`.
3. **C11 approach.** Options: drive the browser by hand, write a backend-only
   script, or add an opt-in Playwright spec. We added the spec, gated on
   `ORKESTRATOR_AGENT_TEST_LIVE_CONTAINER_APPROVAL=1`, so the evidence can be
   reproduced and the real user path (sidebar stop, stopped view, start) is
   the one exercised.
4. **C11 provider.** Only Claude was qualified, because the profile authorized
   only Claude credentials. Codex, OpenCode, Pi, Cursor and Grok approvals
   under a stop are not claimed.
5. **Stale `pending` while stopped.** Options: mark the request `withdrawn`
   in the backend when the stop commits, or document the behaviour and verify
   other surfaces first. We documented it and added an outstanding item,
   because the stopped view cannot show or answer the request.
6. **Benchmarks under load.** Options: wait for a quiet host, or record three
   runs with their load averages. We recorded the runs. The host could not be
   quietened without stopping other environments' work.
7. **Where to fix the vanishing tabs.** Options: stop resetting agent tabs
   when a container stops, special-case the seeding effect in
   `TerminalContainer`, or have `paneLayoutStore.reset` drop the hydration
   marker. We chose the store change. It is one line, keeps the reset that
   tears down dead terminal sessions, and makes a restart behave like a page
   reload, which already restores the persisted layout.
8. **The dev version banner.** It is unrelated to containers, so it was
   recorded as a low-scored follow-up rather than fixed here.
9. **The Connection Failed after a restart.** It was first filed as a High
   item with the spec left strict; pressing **Retry** in the spec would have
   hidden the failure. The Multi Review then traced it to the teardown intent
   that `reset` left pending, and `99263373` fixed it. The item is closed on
   that diagnosis and 4 of 4 passing runs, including a forced teardown sweep.
   It stays reopenable if the failure appears without a pending intent.

## Results, 2026-10-21 (C21 live: Codex rotation and account switching)

Commit `688f9f69` plus this change. Host: macOS 27.0, Apple M5 Pro, Docker
Desktop (Engine 29.8.2, `linux/arm64`), shared with other environments'
test runs (load average about 8). Image: the workspace's isolated development
image `orkestrator-v2:dev-4ec6b15ad812` (`8cd8f2f670ba` at `688f9f69`, then
`19c1be6fb5ac` with the fixes below; codex-cli 0.162.1, Grok 1.0.52). Profile
`cred-rot-0700`, started with `--fixture --fixture-environments
local,container --credential-source codex --credential-source grok
--agent-platforms codex,grok` and `CODEX_HOME` pointed at a disposable copy
of the host login with its refresh token blanked. Every "host" rotation below
rewrote that copy (or an added account's directory in the profile), never the
host's `~/.codex`. Turns went through `ensure_native_agent_session` and
`dispatch_native_agent_prompt`, the path the renderer uses, so the backend's
live-work guard saw them.

- Baseline: the container's `~/.codex/auth.json` had an empty refresh token,
  a fresh `last_refresh` and mode 600; a real turn answered.
- Host rotation during a turn: while a 1,200-number turn ran, the host login
  was rewritten (a `rotation-1` field added) and `start_codex_server` called
  again. The bridge was reused (same port and token), the container's login
  was untouched and the turn finished. This is the documented behaviour:
  Codex is re-read from the host only before a start.
- Restart: `stop_environment` and `start_environment` restaged the rotated
  login (refresh token blank, `last_refresh` reset, mode 600). The staged
  revision held no `.partial` or `.tmp` entries. The same session then
  recalled a codeword from before the restart.
- Container copy past expiry: the container's own access token was given an
  `exp` an hour in the past (claims otherwise real; the server rejects it) and
  the bridge restarted. Codex tried a refresh with the blank token; OpenAI
  answered 400 `empty_string`, and turns failed with "workspace routing
  discovery unauthorized (401)". Nothing on the host was read for this and
  nothing could be spent: the container holds no refresh token. A restart
  restaged the host login and the next turn answered.
- Host login expired: staging withheld it (the staged file was removed) and
  the container kept the copy it had, which in practice is the same expired
  token. After restoring the host copy, a restart signed the container in.
- Account switching under a running turn: with a second Codex account
  seeded into the profile (an access-only copy of the same login, tagged
  `account-b`), the active account was switched while a 1,500-number turn
  ran, and `start_codex_server` called during it. The busy bridge kept its
  login and the turn finished (all 1,500 numbers and `DONE`). Once idle, the
  backend pushed account B's login access-only, wrote the account marker and
  replaced the bridge; the same session recalled its codeword on account B.
  Rotating account B's own login and restarting restaged B's login, not the
  host's.
- Opt-in Grok live renewal spec (`grok-container-login.spec.ts`): skipped
  explicitly at 2026-10-21T07:58Z, because the host Grok access token expired
  at 2026-10-20T16:24:55Z (see the Grok qualification item in
  [0018-container-network-and-credential-isolation.md](0018-container-network-and-credential-isolation.md)).
- `test:agent:docker` on the same profile and the rebuilt image: 9 passed,
  2 skipped (the opt-in live Claude C11 spec and the Grok spec above).
- Host `~/.codex/auth.json` and `~/.grok/auth.json`: SHA-256 prefix and
  mtime recorded before and after the run; both unchanged.

### Problems found and fixed

1. **A restart left a switched-back container on the added account.** With
   account B active, a restart restaged B's login, then the start path cleared
   the container's Codex account marker, and a missing marker reads as the
   host login. Switching back to the host then matched that marker, so
   nothing was pushed and turns kept running on account B until the next
   restart. Reproduced live. A first fix recorded the staged account in an
   in-process map for the start path to write, and was re-run live (the
   marker named B after the restart, and the switch back pushed the host
   login). Multi Review then found four ways that hint could still name the
   wrong login: the marker and the login came from two registry reads; a
   start of an already-running container restaged without importing; a lost
   hint cleared the marker; and a failure after `docker start` left the old
   marker. Now staging never names an account. A real start (the container
   was stopped) sets the Codex marker to `unstaged`, a value no account
   matches, right after `docker start` and before any later step can fail;
   the entrypoint does the same before it imports, so a backend that dies
   mid-start is covered too. The next idle bridge start then pushes the
   active login and writes its marker, taking the account, home and
   generation from one registry read. A start of a running container leaves
   the login and marker alone. The revised design has unit and registry
   fixture coverage but has not been re-run live.
2. **A lapsed Codex login read as "temporarily unavailable".** Codex 0.162.1
   answers `account/read` with an RPC error ("workspace routing discovery
   unauthorized (401)") rather than a signed-out account once its token is
   refused and cannot be refreshed. The bridge returned HTTP 500 for
   `/global/auth`, the backend reported "authentication status is temporarily
   unavailable", and the sign-out was never confirmed, so no sign-in prompt
   appeared. The engine now reads that refusal as the signed-out answer. Re-run
   live on the rebuilt image: auth status `needs-auth`, and the session
   projection carries `readiness: authentication-required` with "You've been
   signed out of Codex" and the "Codex sign-in expired" notice.

### Decisions

1. **How the start path records the installed Codex account.** Options: an
   in-process map from container to marker, filled by the restage and taken
   by the start (the first fix); a marker file inside the staged revision
   copied by the entrypoint; writing the current active account's marker at
   start; or never naming an account at start, invalidating the marker on a
   real start and letting the next idle bridge start reconcile. The map
   needed no image change, but review showed it can be lost, consumed by an
   overlapping start, or applied when nothing was imported. A file in the
   revision still trusts that the entrypoint ran and imported it, and the
   current account at start can name an account switched to after the
   restage. We chose invalidation: only a push the backend made itself
   writes a real marker. It costs one access-only Codex login push on the
   first bridge start after each real start, for users who have used
   accounts, and a one-line entrypoint change (the backend write covers
   older images). Going back to a hint means re-solving the four review
   findings.
2. **Codex sign-out detection.** Options: map only `account/read` errors that
   say `unauthorized (401)`, `HTTP 401` or `401 Unauthorized` to signed out;
   or treat every account read failure as signed out. Only the first keeps a
   transient failure from asking a working account to sign in. A future Codex
   that reports the refusal differently falls back to today's "unavailable".
3. **Scope.** Claude credential handling is being changed elsewhere in the
   same batch, so its rotation was left to run after that lands, and logged.

## Outstanding work

### Qualification

- Desktop residuals. The 2026-10-17 real-stack run used the restricted
  fixture container, and its terminals were ordinary ones. Run the real-stack
  Docker set once more with a full-network environment and through a root
  terminal (**New root terminal**). Both container users were already shown
  to work through `docker exec`, by the Playwright launch check.
- Rootless Engine. Show that cgroup or firewall enforcement the daemon cannot
  provide is reported as unsupported (the resource policy's unsupported axes,
  the `rootless` topology flag) and refused precisely, never silently
  weakened.
- arm64 live suites. Run the C-scenarios on native arm64 hardware (Desktop on
  Apple Silicon covers this) and mark any evidence that came only from
  emulation. The 2026-10-17 run is native arm64 evidence for the four live
  suites, the benchmarks, the final-image smoke and `test:agent:docker`, and
  none of it came from emulation.
- Registry measurements: compressed manifest and layer bytes, and cold pull
  time, against a pushed GHCR image. `publish-container.yml` records the
  digest in `image-release.json`.
- Provider session resume after a rebuild (C13) for Codex, OpenCode, Pi,
  Cursor and Grok. Add each provider that passes to
  `RESUME_QUALIFIED_PROVIDERS`, and update its `PROVIDER_PRESERVATION` text in
  `container-state-layout.ts`. This includes the relocated Codex runtime
  databases (`CODEX_SQLITE_HOME`) and the Grok session index, both "pending
  qualification" today. The earlier attempt failed before any rebuild:
  Codex app-server turns finished with no assistant message, the OpenCode
  model was not connected, Pi's first turn did not finish, and Cursor and
  Grok sessions did not start. The proof also requires that an ambiguous
  dispatch stays unresolved rather than being resent.
- Live credential rotation (C21 live half) for Claude, Cursor and Grok while
  a provider process runs. Codex rotation and Codex account switching passed
  on 2026-10-21 (results above). Still to run: the Claude start sync and
  login-renewal push (`syncContainerAgentAccountsOnStart`,
  `markContainersForClaudeLoginRefresh`) once the access-only Claude change
  in [0018-container-network-and-credential-isolation.md](0018-container-network-and-credential-isolation.md)
  lands, a Claude account switch under a running turn, the Cursor key file
  sync, and the Grok push before each bridge start with a live host login.
- A stopped environment's pending interactions in the backend projection.
  After a stop the projection still lists the dead request as `pending` until
  the session reattaches on the next start (C11, 2026-10-17). The stopped view
  renders no agent tab, so nobody can answer it there. Check whether any other
  surface reads that state for a stopped environment (the agent inbox,
  environment notifications, coordinator status). If one does, mark the
  request `withdrawn` when the stop commits.
- Readiness failure injection on a real daemon: missing firewall script,
  DNS/bootstrap failure, permission failure, an interrupted status write and
  a Docker restart during launch, plus C10. Inject faults through fixtures at
  the lifecycle-service boundary only.
- Daemon disconnect mid-copy and a live process kill just before and after the
  rebuild commit write. Both are covered by unit reconciliation and the
  capacity preflight, not by a live run.
- Backend upgrade and rollback with real releases. Start current `main` over
  a data directory and containers left by an older release (legacy images and
  records) and show nothing is migrated or mutated implicitly. Then open a
  directory current `main` has written with a release at the rollback floor
  (the first to ship `container-lifecycle.schema.json`) and show it stays
  read-only and refuses every container mutation. Only
  `apps/backend/tests/container-lifecycle-service.test.ts` covers the schema
  floor today, with in-process writers.
- Live host-service reply (C22). The original host's ufw dropped
  container-to-host traffic, so the agent-tools port was only shown to leave
  the container. On a host where `container-host-reachability.ts` reports the
  path open, check the port is actually answered.

## Constraints and rationale

- Never test against a production installation or the packaged user's Docker
  resources, and never use or retag `orkestrator-v2:latest` as the
  qualification image.
- Label every resource with a private owner namespace and remove exactly
  those. Never prune, globally or by owner.
- A skipped or timed-out run is incomplete, not a pass. Record flakes in the
  registry; do not weaken assertions to hide races.
- Provider runs use only authorized agent-test credential sources. Synthetic
  file, network and lifecycle scenarios need no real credentials.
- Never claim one provider's capability from another's success. An untested
  capability stays "pending qualification" in the product.
- A fake `docker` executable cannot prove filesystem retention, packet rules,
  mount permissions, name conflicts or signal delivery; those need the live
  suites.
- Benchmark artifacts carry no commands, paths, contents or private
  endpoints.

## Open questions

- Which Engine and Desktop versions become the published minimum once Desktop
  is qualified, and is rootless supported with gated features or refused?
- Should the live suites get a scheduled CI job on a Docker-capable runner
  (Linux amd64 and arm64)?

## Needs verification

- Whether anyone has run the live suites since #877. Answered: the
  replacement suite ran on 2026-10-16 (provider-state review) and the full set
  on 2026-10-17 ([Results, 2026-10-17](#results-2026-10-17)).

## Related

- [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md):
  shared prerequisites and batching. The Docker Desktop rows of
  [0042-service-preview-rollout.md](../previews-and-annotations/0042-service-preview-rollout.md) and
  [0014-cli-qualification.md](../cli-and-slash-commands/0014-cli-qualification.md) belong in the same platform
  run.
- [0035-mobile-layout-gaps.md](../cross-cutting/0035-mobile-layout-gaps.md): the environment settings
  dialog blocked by the projects drawer, found during the container settings
  real-stack run.
- [0021-container-rebuild-state-preservation.md](0021-container-rebuild-state-preservation.md),
  [0018-container-network-and-credential-isolation.md](0018-container-network-and-credential-isolation.md),
  [0022-container-resource-budgets-and-performance.md](0022-container-resource-budgets-and-performance.md),
  [0023-environment-and-disk-cleanup.md](0023-environment-and-disk-cleanup.md)
  (container deletion through the ledger on Desktop).
- [Container qualification](../../development/container-qualification.md):
  C01–C30 scenario definitions, platform dimensions, suite commands and
  benchmark targets.
- [Container lifecycle](../../architecture/container-lifecycle.md),
  [agent testing](../../development/agent-testing.md),
  [testing guide](../../development/testing-guide.md).

## Replaces

- `docs/improvements/containers/qualification.md` (reproduce commands, open
  limitations; the per-scenario evidence is historical)
- `docs/improvements/containers/remaining-work.md` (environment-limited list;
  items 1–39 shipped in #877)
- `docs/improvements/containers/plan/14-integrated-qualification-and-rollout.md`
  (release gates and the upgrade/rollback check; the scenario matrix, platform
  dimensions and evidence workflow moved to
  `docs/development/container-qualification.md`)
- `docs/improvements/containers/plan/00-index.md` (the minimum Engine/Desktop
  and rootless decision gate)
- `docs/improvements/containers/plan/01-immediate-data-loss-safeguards.md`,
  `docs/improvements/containers/plan/02-lifecycle-authority-and-durable-operations.md`,
  `docs/improvements/containers/plan/03-image-contracts-and-daemon-preflight.md`,
  `docs/improvements/containers/plan/04-runtime-readiness-and-graceful-shutdown.md`
  (limitation lines; the steps shipped in #877)
- `docs/improvements/containers/plan/05-persistent-workspace-and-agent-state.md`
  (per-provider resume limitation)
- `docs/improvements/containers/plan/06-migration-and-transactional-replacement.md`
  (live disconnect and kill limitation)
- `docs/improvements/containers/plan/08-portable-inputs-and-credential-lifecycle.md`
  (live rotation)
- `docs/improvements/containers/plan/09-environment-networks-and-egress-policy.md`
  (Desktop and arm64 packet tests, the ufw limitation)
- `docs/improvements/containers/plan/10-resource-budgets-and-usage-telemetry.md`
  (Desktop and rootless enforcement)
- `docs/improvements/containers/plan/12-image-build-and-release-delivery.md`
  (arm64, registry size and pull time)
- `docs/improvements/containers.md` (acceptance criteria for findings 5 and 9
  on Docker Desktop)
