# Suborks: live qualification

## Task analysis

Analysed 2026-11-13 against `main` at `17d28238c` (first analysed 2026-11-04 against `96ee1eb3e`).

### Tasks

1. **Live six-provider sweep**: write the opt-in live spec (recommended below) that runs `/subork` end to end on every provider, as a caller and as a target, on a host or a container environment, skipped unless its switch is set. Running it on real logins is in the manual-test checklist (7568, 4340 task 1). Status: done (2026-11-13: `suborks-live.spec.ts`, passing on scripted models).
2. **Plain-text form**: if the live check (7568, 4340 task 2) shows a provider answering a plain-words request with its own sub-agents instead of `ask_agents`, sharpen the tool description. Status: done (2026-11-13: moved whole into the checklist item, with this task's decision, so no agent work waits here).
4. **Backend restart with real turns**: write the opt-in restart spec, following `goals-restart-live.spec.ts`, that kills the backend mid-subork and confirms delivery. Running it on real logins is in the manual-test checklist (7568, 4340 task 4). Status: done (2026-11-13: `suborks-restart-live.spec.ts`, passing on scripted models; the OpenCode-target defect it found is to-do 8045).
5. **Electron agent suite on a quiet host**: rerun `test:agent:electron` for this branch where Docker is not churning the host's interfaces. Status: done (2026-11-13, see task 5 Investigation).

### 1. Live six-provider sweep

**Problem.** Provider fakes cover the feature, but nothing has run it against real agents. The build was limited to fakes: no billed turns or real logins.

**Context.** `docs/architecture/suborks.md` describes the path. A subork uses the same plan-turn and result-tool path as a goal's verifier, which passed live on all six providers (`docs/architecture/goals.md`, Qualification), so a surprise is more likely in `ask_agents` being reached and in the wake than in the subork's turn.

**Investigation.** 2026-11-13: `e2e/agent-testing/suborks-live.spec.ts` and `mise run test:agent:suborks` (a disposable `--no-agent-credentials --agent-platforms pi,opencode` profile, `suborks-fake-model.ts` on loopback) passed on this Mac: Pi and OpenCode each asked itself and the other, every subork finished on its expected tier (Pi `enforced`, OpenCode `provider-configured` and guarded), the delivery was `sent` and the caller was woken once with both answers, 5 to 9 s from typing to the wake. The first run failed only because the fake took OpenCode's tool-less title request for a second `/subork` turn; the fake now answers such requests as titles. The same spec runs live on all six without `ORKESTRATOR_AGENT_TEST_SUBORKS_FAKE`.

No live model has run it. On 2026-11-04 `native-agent-suborks-opencode.live.test.ts` ran the pinned `opencode serve` (1.19.5) against a scripted model on loopback, as caller and as target, and passed. That test was removed with OpenCode 1.x on 2026-11-11 (`git show 5f4e27b1c:apps/backend/src/core/native-agent-suborks-opencode.live.test.ts`); its OpenCode 2 port, `apps/backend/src/core/opencode2/opencode2-suborks.live.test.ts` (in `mise run verify:opencode2:live`), ran the pinned `opencode2 serve` (2.2.6) the same way on 2026-11-11 and passed, with the caller on its per-tab MCP server and the subork offered no editing tool, no `subagent` and only its result connection's tools. It found that a reviewer-session subork on OpenCode was offered `orkestrator_ask_agents` and the environment-wide ticket tools, and the same change denies both (see Assumptions and decisions). The other five providers have no real-process run. Worth watching: Codex and Grok tool approval for `ask_agents`; whether each provider surfaces the handle; the mail wake after a real turn end; `suborkLatestAction` against each provider's real rows, because the fake rows are hand-written.

**Decisions.** Where to run it:
- A new `e2e/agent-testing` spec driven by `test:agent:browser:isolated` (recommended). Pros: repeatable at the next provider bump, like `goals-*-live.spec.ts`. Cons: spends real turns on each run.
- A one-off manual sweep in a `dev:test` profile. Pros: cheapest now. Cons: nothing guards later bumps.

### 2. Plain-text form

**Problem.** "Ask opus 5.5 and grok 4.7 to rate this" relies on the model choosing the tool from its description. A test proves the tool and description are offered, not what a model does with them.

**Context.** `SUBORK_TOOL_DESCRIPTION` in `apps/backend/src/core/agent-tools-subork-schema.ts`, shared by the agent tools server and the coordinator's control MCP. Some providers have their own sub-agent tools competing for the same request.

**Investigation.** A test proves the tool and description are offered (`native-agent-suborks.test.ts`). The real-OpenCode 1.x test (retired 2026-11-11, see task 1) and its OpenCode 2 port showed a plain-text request reaching `ask_agents` through OpenCode's own MCP client with that description, but their script, not a model, chose the tool. Real models not run.

**Decisions.** If a provider prefers its own sub-agents:
- Sharpen the tool description first (recommended). Pros: the same text on every provider, in keeping with the design. Cons: may not be enough for every model.
- Add a line to that provider's system instructions. Pros: stronger. Cons: per-provider divergence, which the design avoids.

### 4. Backend restart with real turns

**Problem.** A restart is covered with fakes that outlive the process. A real bridge's behaviour across a backend restart, including the result credential, is unproven for suborks.

**Context.** `goals-restart-live.spec.ts` is the pattern. Agent tool credentials are held in process, so a subork that submits after a restart depends on the runner's reminder turn to get a fresh connection.

**Investigation.** 2026-11-13: `e2e/agent-testing/suborks-restart-live.spec.ts`, in the same suite, passed with an OpenCode caller and a Pi target: the fake held the target's request, the backend was `SIGKILL`ed and the profile restarted; the row was resumed, the Pi target finished on the runner's continuation turn, the `/subork` turn was not sent again and the answer woke the OpenCode caller once. With an OpenCode target (reproduced twice) the target stayed `running` after the restart: OpenCode's store keeps the session busy and the backend reads it as running until the 45-minute bound. That is to-do 8045, and `ORKESTRATOR_AGENT_TEST_SUBORK_RESTART_TARGETS=pi,opencode` reproduces it.

**Decisions.** No material choice: follow `goals-restart-live.spec.ts`.

### 5. Electron agent suite on a quiet host

**Problem.** The review validation's `mise run test:agent:electron` run for this branch (commit `fe32ed945`) failed 16 of 62 cases, so no green Electron result exists for it.

**Context.** The branch changes no file under `apps/desktop/` or `e2e/agent-testing/`. Thirteen of the sixteen failures stopped at the first title check with the window still titled `Orkestrator AI`, and their Electron diagnostics hold 56 to 139 `net::ERR_NETWORK_CHANGED` lines ending in `renderer.load-failed ... Failed to fetch dynamically imported module .../src/renderer-entry.tsx`. That is flake [2340](../../tests/flaky-tests/aggregate-validation-runs/2340-chromium-network-changed-under-docker-churn.md): other builds' containers adding and removing veths and bridges on beelink. The connection-outage case failed at the same title check. The other two are native-view assertions: `web-annotations-electron.spec.ts` is open flake 1400, and `service-preview-electron.spec.ts` "a crashed service renderer reports the failure and recovers on reload" (view not visible) has no case of its own.

**Investigation.** The run was not repeated on beelink. Most of these specs open a window on the host display, which on beelink is the user's live desktop. `ip monitor` during this round showed a Docker veth being created and torn down within 30 s, at interface index 7009.

2026-11-13, rerun on this Mac (macOS 27.2, Apple silicon, Docker not creating networks; shared with nine other builds, CPU meter at 100 % in the failure snapshots), branch `electron-suite-rerun-4896909ed3cc-r1` on `17d28238c`: `ORKESTRATOR_AGENT_TEST_RUN_ID=electron-4340 mise run test:logged -- --name agent-electron -- mise run test:agent:electron` reported **43 passed, 4 failed, 6 skipped, 25 not run** (serial cases behind a failure) in 25.9 min. No failure had an `ERR_NETWORK_CHANGED` line, so 2340's cause did not recur. Each failing owner was rerun alone:

- `electron-main.spec.ts`, "remote nicknames refresh all native titles and Window menu entries" (the `Workstation` poll after the second renderer's reload): passed alone (9 passed, 2 skipped). Recorded as a recurrence of flake 9863.
- `web-annotations-electron.spec.ts`, "Home native preview hides beneath board panels and returns without losing its tab" (**Browser address** not shown within 5 s after selecting Home; its 18 later serial cases did not run): passed alone (17 passed, 2 skipped). Flake 0272 reopened with this recurrence.
- `service-preview-electron.spec.ts`, "a Vite app keeps HMR updates made while its tab is hidden, unmounted or reloaded" (`HMR v2 not applied in place`): failed alone too (16 passed, 1 failed, 7 skipped). Recorded under flake 1303, which already reproduces in the owner on macOS and on `main`.
- `local-gateway-transport-electron.spec.ts`, "a local window on the gateway transport shows terminal output and recovers": failed alone too, because this worktree had no `apps/backend/dist` or `apps/web/dist` and the case relaunches Electron from them (the relaunched backend logged `Module not found .../backend/main.js` and the window closed). After `bun run --cwd apps/backend build` and `bun run --cwd apps/web build` the owner passed alone (2 passed). The case now fails up front naming the missing bundle and the two build commands, instead of as a closed window.

The earlier beelink failure in `service-preview-electron.spec.ts`, "a crashed service renderer reports the failure and recovers on reload", passed here in the full suite and alone.

**Decisions.** Where to rerun it:
- On a host with no concurrent Docker work, or on macOS with Docker Desktop (recommended). Pros: removes the 2340 cause without changing any test. Cons: needs a quiet window on a host whose desktop may be used.
- Add headless launch to every Electron spec, as `design-canvas-electron.spec.ts` has. Pros: avoids the live desktop on beelink. Cons: unrelated test work, and it does not by itself avoid network churn.

## Assumptions and decisions

### Scripted mode covers Pi and OpenCode only (task 1)

The ticket asked for specs that pass on scripted models. Pi and OpenCode both send OpenAI chat completions to a configured endpoint, so one loopback fake (`suborks-fake-model.ts`) serves both through the profile's own settings. Claude, Codex, Cursor and Grok have no scripted model that reaches a profile's own bridge (the existing Claude and Codex fakes need a hand-started profile with a made-up Codex key, and Cursor and Grok have fake engines only in place of their bridges), so the same specs cover them only in live mode, which is on the manual-test checklist. Chose this over adding four more fakes, which would have been new harness work beyond this ticket.

### One mise task runs both specs on one disposable profile (tasks 1 and 4)

`mise run test:agent:suborks` follows the other fake-model runners (`runIsolatedBrowser`, `--no-agent-credentials`, `--no-host-seed`, reachability check off). The restart spec restarts the profile, so it runs second (`suiteRestartsProfiles`), the way `coordinator-notice-live` does. Chose one profile over two to halve the start-up cost.

### The restart spec's scripted target is Pi until 8045 (task 4)

With an OpenCode target the restart case fails on a real defect (to-do 8045). Rather than leave a red default or loosen the assertion, the scripted default is an OpenCode caller and a Pi target, so both providers still cross the restart, and `ORKESTRATOR_AGENT_TEST_SUBORK_RESTART_TARGETS=pi,opencode` reproduces the defect. 8045 task 2 turns it back on.

### Task 2 moved whole to the checklist (task 2)

Task 2 waited only on the user's live check, which a to-do may not do. Its decision (sharpen the description first, a per-provider system line only if that fails) now travels in the checklist item, so whoever records a provider ignoring the tool can hand the follow-up to an agent, and this file has no work left.

### The gateway-transport case fails up front without its bundles (task 5)

It needs the production backend and web bundles, which `agent-testing.md` already says, but without them it failed as a closed Electron window. A pre-check now names the missing file and the build commands. Chose this over building the bundles in `beforeAll`, which would add minutes to every run on hosts that already have them.

### Coordinator suborks run in the project home (task 6)

A coordinator has no environment, and suborks need one for their sessions, transcripts and guard. The project home is the environment whose working directory is the coordinator's own checkout, so a subork reads exactly what the coordinator reads. Suborks are read-only, so this does not let a coordinator delegate writes into its checkout, the reason a coordinator credential may not otherwise target the home.

### The guard covers every tier below `enforced` (task 7)

Grok's gap was the reason, but Cursor, OpenCode and an unsandboxed Claude are also only provider-configured, so the same check applies to them. Codex, Pi and a sandboxed Claude are not guarded: their providers already block writes, and a guard there would only add a false failure when something else edits the workspace.

### OpenCode subork turns deny `ask_agents` and the environment-wide tools by permission rule (task 1)

A subork runs in a reviewer session, and OpenCode applies no per-turn tool map to one, so the tool map that hid `ask_agents` never reached a subork. `openCodeWorkflowResultPermissionRules` (now in `apps/backend/src/core/opencode2/policy-rules.ts`, applied by `opencode2/permissions.ts`) now denies `orkestrator_ask_agents` on every workflow turn, and on a subork's turn `orkestrator_*` apart from its own result tools, matching the result-only credential other providers get. The `ask_agents` deny is not lifted at settle, because only sessions Orkestrator runs itself take workflow turns, and those cannot start suborks.

### OpenCode 2 replaces the retired 1.x real-process run (task 1)

Retiring OpenCode 1.x removed the only real-process subork run. Its port, `opencode2/opencode2-suborks.live.test.ts`, keeps the same scope (one OpenCode caller, one OpenCode and one Codex-fake target, the real mail drain) on the shared `startOpenCode2Fixture`, so it runs in `verify:opencode2:live` with the other OpenCode 2 live tests rather than needing its own switch. The caller uses its tab's own `agentMcp` connection, as a 2.x tab does, instead of the 1.x environment-wide registration. This does not change task 1's status: the six-provider sweep against real models is still open.

## Related

- [`docs/architecture/suborks.md`](../../architecture/suborks.md)
- [`docs/architecture/goals.md`](../../architecture/goals.md)
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (task 3, task 6, task 7, and the real-agent runs of task 1, task 2 and task 4) moved there on 2026-11-10; on 2026-11-13 they were rewritten for the landed specs and task 2's follow-up joined them.
- [8045](8045-opencode-turn-cut-by-backend-restart-stays-busy.md): the OpenCode restart defect task 4's spec found.
- [`docs/development/agent-testing.md`](../../development/agent-testing.md#suborks-on-every-provider-and-across-a-restart-fake-model): the suite.
