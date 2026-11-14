# Coordinator tool surface: what needs real provider turns

From coordinator report C4 (Tool surface), parts `0160` and, for task 3,
`0040` and `0130`. Everything else in that report was built. The report was
deleted in the commit that added this file; it is in `main` at `7347e5093`,
and the version ending with its outcome table is in that deleting commit's
parent.

## Task analysis

Analysed 2026-11-05 against `main` at `7347e5093`; task 3 built 2026-11-14 against `main` at `dc90609bf` (see Assumptions and decisions).

### Tasks

2. **Decide whether field-level copies of context rules can go** (part `0160`, task 3, the part not built): the worker-prompt format rule on four prompt fields and the PR and validation notes on three tools. Agent part: once the tool-list measurement shows a provider does not cache the list, build a variant with the copies shortened to a pointer, then drop them if the billed comparison run shows no regression (the measurement and the comparison run are on the manual-test checklist). Status: blocked (waits on 7568: 4920 task 1 measurement).
3. **Confirm real coordinators follow the new wording** (parts `0040` and `0130`): add assertions to the live coordinator suite that a launch leaves `agent` out unless the user asked, and that each new action gets a new `requestId`. Status: done (2026-11-14: checks in the `routing` scenario, proven on a scripted coordinator; their billed run is the 7568 item "4920 task 3").

### 2. Decide whether field-level copies of context rules can go

**Problem.** Some schema text repeats the context block, so it is sent twice each turn.

**Context.** `COORDINATOR_WORKER_PROMPT_FORMAT_RULE` (`packages/protocol/src/coordinator.ts`) is in the context block and on the `prompt` field of `launch_environment`, `launch_job`, `send_prompt_to_tab` and `fork_worker`, about 1.5 KB in all. `control-mcp/server-coordinator-workflows.test.ts` ("publishes the worker prompt format rule on every delegation prompt field") pins it there deliberately: the field text is what a model reads when it writes the prompt. `COORDINATOR_WORKER_PROMPT_NOTE` (no pull requests from workers; focused checks when review follows) on three tools restates the PR and validation rules, and `LAUNCH_DEFAULTS_GUIDANCE` restates the defaults rule, also on purpose (`control-mcp/tools-shared.ts` and `control-mcp/launch-tools.ts`). C4 shortened the `nodeId` description on 27 tools instead, which repeated nothing behavioural.

**Investigation.** Not done: whether models still format prompts and omit choices without the field copies can only be judged from real transcripts. The per-provider cost of the tool list (whether a provider caches it) and the billed comparison run are on the [manual-test checklist](../manual-test/7568-manual-test-checklist.md). Build the shortened variant only if a provider does not cache the list, and drop the copies only if the comparison run shows nothing regresses.

**Decisions.**

- **Keep or drop the copies?**
  - **Run the live coordinator suite with the field copies shortened to a pointer, compare prompt formatting and launch choices with today's, and drop them only if nothing regresses (recommended).**
    - Pros: decides on evidence; saves about 2 KB a turn if it holds.
    - Cons: needs billed runs on several providers.
  - **Keep them.**
    - Pros: no risk to behaviour that was fixed by adding them.
    - Cons: the duplicate text stays in every turn.

### 3. Confirm real coordinators follow the new wording

**Problem.** C4 made `agent` optional and told coordinators to omit it, to use a new `requestId` per action, and not to poll `list_agents`. Fakes prove the tools behave; they cannot prove a model follows the text.

**Context.** The rules are `COORDINATOR_LAUNCH_DEFAULTS_RULE` and `COORDINATOR_REQUEST_ID_RULE` (context block and server instructions) and the `agent` field's description. A replayed request now says `replayed: true` with a note, and a colliding one says to choose a new id.

**Investigation.** What to look for in the live coordinator suite's transcripts ([agent-testing.md](../../development/agent-testing.md#live-coordinator-suite)): `launch_environment` and `launch_job` calls without `agent` when the user named none; distinct `requestId`s across a fresh main's first actions; no repeated `list_agents` reads while waiting.

Found on 2026-11-14: the `async` and `family` scenarios tell the coordinator to pass `agent` and "a fresh requestId" (`launchStep` in `coordinator-live-delegation.ts`), so they cannot show whether a model follows the rules unprompted. The `routing` scenario's four requests name no agent, model, effort or workflow (`coordinator-live-routing.ts`) and run on one conversation, so it is where the checks mean something.

**Outcome (2026-11-14).** Built in `apps/desktop/scripts/dev/coordinator-live-wording.ts` and run by `runRoutingScenario` after each case:

- `<case>-launch-defaults-omitted`: every `launch_environment` and `launch_job` call in the case leaves `agent`, `modelId` and `reasoningId` out. A successful launch whose arguments cannot be read fails closed; a case with no launch passes, since whether it delegated is that case's own check.
- `<case>-list-agents-not-polled`: at most one `list_agents` call in the case.
- `request-ids-fresh`, once per run over every case's rows: no request id names two different calls (another tool, or other arguments). Sending the same call again under its id, the one reuse the rule allows, is counted as a retry and passes. The summary records `request-ids:withRequestId`, `distinct`, `retries` and `reused` counts; no id is recorded.

Tests: `coordinator-live-wording.test.ts` (the verdicts) and `coordinator-live-routing-orchestration.test.ts` ("the C4 wording", a scripted coordinator that follows the rules, names an agent, reuses an id and polls `list_agents`). Running them against real providers is billed and is the 7568 item.

**Decisions.**

- **Where to check?**
  - **Add the three checks to the existing live coordinator suite's assertions (recommended).**
    - Pros: runs with the other live qualifications; no new harness.
    - Cons: each check adds to a billed run.
  - **Read a handful of production transcripts by hand.**
    - Pros: no harness change.
    - Cons: not repeatable, and transcripts may not contain the cases.

## Assumptions and decisions

### Task 3: judge the wording on the `routing` scenario

Chose to add the checks to the existing `routing` scenario rather than to `async` and `family`, which are the scenarios that launch most workers. Those two prompts spell out `agent` and "a fresh requestId", so a pass there would measure obedience to the harness, not to the tool text; rewriting them to stop naming the agent would also change which platform their workers run on, which their other checks depend on. `routing`'s requests name nothing, so a launch field set there is the coordinator's own choice. The cost is coverage: `routing` usually launches one worker (the `investigate` case), so the agent check rests on few calls per run.

### Task 3: what counts as reusing a request id

A request id may be reused only to retry the same call (`COORDINATOR_REQUEST_ID_RULE`), so `request-ids-fresh` compares each id's calls by tool and arguments with the id removed (keys sorted, so a reordered retry still matches). Reuse for a different call fails; an exact repeat is a counted retry. Comparing ids alone would have failed a coordinator for a legitimate retry after an ambiguous answer.

### Task 3: "not polled" means one `list_agents` per case

The rule is not to poll `list_agents` while waiting; one read to choose a tab is legitimate. The check allows one call per case and fails on a second. A stricter zero would refuse a normal lookup; a per-turn bound would miss polling spread over wakes.

## Related

- Coordinator report, 4.3 (A2, A3, A5) (`git show 413bd6219:docs/reports/2026-10-27-coordinator.md`)
- [The context block](../../architecture/coordinator.md#the-context-block): why the changing `Waiting on` line sits last (to-do 4901, retired 2026-11-10)
- [0025-multi-review-panel-value.md](0025-multi-review-panel-value.md)
- [The coordinator's tools](../../architecture/coordinator.md#multiple-machines)
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (task 1, the billed comparison run of task 2, the billed run of task 3's checks) moved there on 2026-11-10.
