# Suborks: live qualification

## Task analysis

Analysed 2026-11-04 against `main` at `96ee1eb3e`.

### Tasks

1. **Live six-provider sweep**: run `/subork` end to end on every provider, as a caller and as a target. Status: open.
2. **Plain-text form**: check that models call `ask_agents` when asked in plain words. Status: open.
3. **Container run**: repeat one sweep in a container environment. Status: open.
4. **Backend restart with real turns**: kill the backend mid-subork and confirm delivery. Status: open.
5. **Electron agent suite on a quiet host**: rerun `test:agent:electron` for this branch where Docker is not churning the host's interfaces. Status: open.
6. **Coordinator conversations**: run `/subork` from a main and a side coordinator conversation on real agents. Status: open.
7. **Read-only guard on a real Grok subork**: confirm a Grok subork that writes is refused at submit and failed at consumption. Status: open.

### 1. Live six-provider sweep

**Problem.** Provider fakes cover the feature, but nothing has run it against real agents. The build was limited to fakes: no billed turns or real logins.

**Context.** `docs/architecture/suborks.md` describes the path. A subork uses the same plan-turn and result-tool path as a goal's verifier, which passed live on all six providers (`docs/architecture/goals.md`, Qualification), so a surprise is more likely in `ask_agents` being reached and in the wake than in the subork's turn.

**Investigation.** No live model has run it. On 2026-11-04 `native-agent-suborks-opencode.live.test.ts` ran the pinned `opencode serve` (1.19.5) against a scripted model on loopback, as caller and as target, and passed. It found that a reviewer-session subork on OpenCode was offered `orkestrator_ask_agents` and the environment-wide ticket tools, and the same change denies both (see Assumptions and decisions). The other five providers have no real-process run. Worth watching: Codex and Grok tool approval for `ask_agents`; whether each provider surfaces the handle; the mail wake after a real turn end; `suborkLatestAction` against each provider's real rows, because the fake rows are hand-written.

**Decisions.** Where to run it:
- A new `e2e/agent-testing` spec driven by `test:agent:browser:isolated` (recommended). Pros: repeatable at the next provider bump, like `goals-*-live.spec.ts`. Cons: spends real turns on each run.
- A one-off manual sweep in a `dev:test` profile. Pros: cheapest now. Cons: nothing guards later bumps.

### 2. Plain-text form

**Problem.** "Ask opus 5.5 and grok 4.7 to rate this" relies on the model choosing the tool from its description. A test proves the tool and description are offered, not what a model does with them.

**Context.** `SUBORK_TOOL_DESCRIPTION` in `apps/backend/src/core/agent-tools-subork-schema.ts`, shared by the agent tools server and the coordinator's control MCP. Some providers have their own sub-agent tools competing for the same request.

**Investigation.** A test proves the tool and description are offered (`native-agent-suborks.test.ts`). The real-OpenCode test shows a plain-text request reaching `ask_agents` through OpenCode's own MCP client with that description, but its script, not a model, chooses the tool. Real models not run.

**Decisions.** If a provider prefers its own sub-agents:
- Sharpen the tool description first (recommended). Pros: the same text on every provider, in keeping with the design. Cons: may not be enough for every model.
- Add a line to that provider's system instructions. Pros: stronger. Cons: per-provider divergence, which the design avoids.

### 3. Container run

**Problem.** A container environment's path differs in the bridge connection and tool reachability, and has only been exercised with a recorded target.

**Context.** `SuborkBranchHost.agentMcp` and `graphAgentBridgeConnection`.

**Investigation.** Not run in a container. The local path now has real-process evidence on OpenCode (task 1).

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

### 6. Coordinator conversations

**Problem.** A coordinator conversation gets `ask_agents` from its control MCP, and its suborks run in the project home. Only provider fakes and a command-level test cover it.

**Context.** `control-mcp-coordinator-suborks.ts`, `coordinator-subork-actions.ts`, and `native-agent-suborks-coordinator.test.ts`. Each platform's coordinator admits control MCP tools its own way: Claude by the `mcp__orkestrator__*` allowlist, Pi and OpenCode by `COORDINATOR_CONTROL_TOOL_NAMES`, Cursor by listing the server, Codex by server-level approval, and Grok under its deny policy.

**Investigation.** Not run live. The command test shows the row on the conversation's session key, the run in the project home, and the mail in the conversation's mailbox.

**Decisions.** No material choice: run task 1's two examples from a Claude or Codex main conversation and from a side conversation, then confirm the answers wake the conversation and the group appears in its transcript.

### 7. Read-only guard on a real Grok subork

**Problem.** Grok's read-only tier is `advisory`, so a Grok subork's answer stands only while the workspace's Git state matches the call's baseline. The guard is tested with a scripted probe, not against a real Grok turn and a real worktree.

**Context.** `NativeAgentSuborkService.certifyGuarded` and `guardedAttempt`, `workspace-read-only-guard.ts`, and `native-agent-suborks-guard.test.ts`.

**Investigation.** Not run live. A Grok subork that never writes is the expected case; the profile already removes its write, edit and shell tools.

**Decisions.** How to provoke a write:
- Ask a Grok subork, in a fixture environment, to create a file through any tool that still runs (recommended). Pros: shows the real refusal text reaching the model and its repair. Cons: spends real turns.
- Write the file from a terminal while the subork runs. Pros: deterministic. Cons: shows only the consumption-time failure, which the fake test already covers.

## Assumptions and decisions

### Coordinator suborks run in the project home (task 6)

A coordinator has no environment, and suborks need one for their sessions, transcripts and guard. The project home is the environment whose working directory is the coordinator's own checkout, so a subork reads exactly what the coordinator reads. Suborks are read-only, so this does not let a coordinator delegate writes into its checkout, the reason a coordinator credential may not otherwise target the home.

### The guard covers every tier below `enforced` (task 7)

Grok's gap was the reason, but Cursor, OpenCode and an unsandboxed Claude are also only provider-configured, so the same check applies to them. Codex, Pi and a sandboxed Claude are not guarded: their providers already block writes, and a guard there would only add a false failure when something else edits the workspace.

### OpenCode subork turns deny `ask_agents` and the environment-wide tools by permission rule (task 1)

A subork runs in a reviewer session, and OpenCode applies no per-turn tool map to one, so the tool map that hid `ask_agents` never reached a subork. `openCodeWorkflowResultPermissionRules` now denies `orkestrator_ask_agents` on every workflow turn, and on a subork's turn `orkestrator_*` apart from its own result tools, matching the result-only credential other providers get. The `ask_agents` deny is not lifted at settle, because only sessions Orkestrator runs itself take workflow turns, and those cannot start suborks.

## Related

- [`docs/architecture/suborks.md`](../../architecture/suborks.md)
- [`docs/architecture/goals.md`](../../architecture/goals.md)
