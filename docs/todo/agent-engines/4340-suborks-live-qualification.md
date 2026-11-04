# Suborks: live qualification

## Task analysis

Analysed 2026-11-04 against `main` at `96ee1eb3e`.

### Tasks

1. **Live six-provider sweep**: run `/subork` end to end on every provider, as a caller and as a target. Status: open.
2. **Plain-text form**: check that models call `ask_agents` when asked in plain words. Status: open.
3. **Container run**: repeat one sweep in a container environment. Status: open.
4. **Backend restart with real turns**: kill the backend mid-subork and confirm delivery. Status: open.

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

## Related

- [`docs/architecture/suborks.md`](../../architecture/suborks.md)
- [`docs/architecture/goals.md`](../../architecture/goals.md)
