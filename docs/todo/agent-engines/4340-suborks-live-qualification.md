# Suborks: live qualification

## Task analysis

Analysed 2026-11-04 against `main` at `96ee1eb3e`.

### Tasks

1. **Live six-provider sweep**: run `/subork` end to end on every provider, as a caller and as a target. Status: open.
2. **Plain-text form**: check that models call `ask_agents` when asked in plain words. Status: open.
3. **Container run**: repeat one sweep in a container environment. Status: open.
4. **Backend restart with real turns**: kill the backend mid-subork and confirm delivery. Status: open.
5. **Electron agent suite on a quiet host**: rerun `test:agent:electron` for this branch where Docker is not churning the host's interfaces. Status: open.

### 1. Live six-provider sweep

**Problem.** Provider fakes cover the feature, but nothing has run it against real agents. The build was limited to fakes: no billed turns or real logins.

**Context.** `docs/architecture/suborks.md` describes the path. A subork uses the same plan-turn and result-tool path as a goal's verifier, which passed live on all six providers (`docs/architecture/goals.md`, Qualification), so a surprise is more likely in `ask_agents` being reached and in the wake than in the subork's turn.

**Investigation.** Not run. Worth watching: Codex and Grok tool approval for `ask_agents`; whether each provider surfaces the handle; the mail wake after a real turn end; `suborkLatestAction` against each provider's real rows, because the fake rows are hand-written.

**Decisions.** Where to run it:
- A new `e2e/agent-testing` spec driven by `test:agent:browser:isolated` (recommended). Pros: repeatable at the next provider bump, like `goals-*-live.spec.ts`. Cons: spends real turns on each run.
- A one-off manual sweep in a `dev:test` profile. Pros: cheapest now. Cons: nothing guards later bumps.

### 2. Plain-text form

**Problem.** "Ask opus 5.5 and grok 4.7 to rate this" relies on the model choosing the tool from its description. A test proves the tool and description are offered, not what a model does with them.

**Context.** `SUBORK_TOOL_DESCRIPTION` in `apps/backend/src/core/agent-tools-suborks.ts`. Some providers have their own sub-agent tools competing for the same request.

**Investigation.** Not run.

**Decisions.** If a provider prefers its own sub-agents:
- Sharpen the tool description first (recommended). Pros: the same text on every provider, in keeping with the design. Cons: may not be enough for every model.
- Add a line to that provider's system instructions. Pros: stronger. Cons: per-provider divergence, which the design avoids.

### 3. Container run

**Problem.** A container environment's path differs in the bridge connection and tool reachability, and has only been exercised with a recorded target.

**Context.** `SuborkBranchHost.agentMcp` and `graphAgentBridgeConnection`.

**Investigation.** Not run.

**Decisions.** No material choice: run the task 1 scenario on a `--fixture-environments local,container` profile.

### 4. Backend restart with real turns

**Problem.** A restart is covered with fakes that outlive the process. A real bridge's behaviour across a backend restart, including the result credential, is unproven for suborks.

**Context.** `goals-restart-live.spec.ts` is the pattern. Agent tool credentials are held in process, so a subork that submits after a restart depends on the runner's reminder turn to get a fresh connection.

**Investigation.** Not run.

**Decisions.** No material choice: follow `goals-restart-live.spec.ts`.

### 5. Electron agent suite on a quiet host

**Problem.** The review validation's `mise run test:agent:electron` run for this branch (commit `fe32ed945`) failed 16 of 62 cases, so no green Electron result exists for it.

**Context.** The branch changes no file under `apps/desktop/` or `e2e/agent-testing/`. Thirteen of the sixteen failures stopped at the first title check with the window still titled `Orkestrator AI`, and their Electron diagnostics hold 56 to 139 `net::ERR_NETWORK_CHANGED` lines ending in `renderer.load-failed ... Failed to fetch dynamically imported module .../src/renderer-entry.tsx`. That is flake [2340](../../tests/flaky-tests/aggregate-validation-runs/2340-chromium-network-changed-under-docker-churn.md): other builds' containers adding and removing veths and bridges on beelink. The connection-outage case failed at the same title check. The other two are native-view assertions: `web-annotations-electron.spec.ts` is open flake 1400, and `service-preview-electron.spec.ts` "a crashed service renderer reports the failure and recovers on reload" (view not visible) has no case of its own.

**Investigation.** The run was not repeated. Most of these specs open a window on the host display, which on beelink is the user's live desktop. `ip monitor` during this round showed a Docker veth being created and torn down within 30 s, at interface index 7009.

**Decisions.** Where to rerun it:
- On a host with no concurrent Docker work, or on macOS with Docker Desktop (recommended). Pros: removes the 2340 cause without changing any test. Cons: needs a quiet window on a host whose desktop may be used.
- Add headless launch to every Electron spec, as `design-canvas-electron.spec.ts` has. Pros: avoids the live desktop on beelink. Cons: unrelated test work, and it does not by itself avoid network churn.

## Related

- [`docs/architecture/suborks.md`](../../architecture/suborks.md)
- [`docs/architecture/goals.md`](../../architecture/goals.md)
