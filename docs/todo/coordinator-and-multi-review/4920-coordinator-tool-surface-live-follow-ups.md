# Coordinator tool surface: what needs real provider turns

From coordinator report C4 (Tool surface), parts `0160` and, for task 3,
`0040` and `0130`. Everything else in that report was built. The report was
deleted in the commit that added this file; it is in `main` at `7347e5093`,
and the version ending with its outcome table is in that deleting commit's
parent.

## Task analysis

Analysed 2026-11-05 against `main` at `7347e5093`.

### Tasks

1. **Per-turn token and cost of the tool surface, per provider** (part `0160`, Needs verification): what the main coordinator's tool list costs each turn on each provider, with caching. Status: open.
2. **Decide whether field-level copies of context rules can go** (part `0160`, task 3, the part not built): the worker-prompt format rule on four prompt fields and the PR and validation notes on three tools. Status: open (depends on 1).
3. **Confirm real coordinators follow the new wording** (parts `0040` and `0130`): a launch leaves `agent` out unless the user asked, and each new action gets a new `requestId`. Status: open.

### 1. Per-turn token and cost of the tool surface, per provider

**Problem.** The tool list is sent with every coordinator turn. Its size is now measured in bytes, but not what it costs on each provider once prompt caching applies.

**Context.** `apps/backend/src/core/control-mcp-coordinator-schema-size.test.ts` prints and bounds the surface for a main coordinator with messaging and scheduling on: 89 tools and 125,040 bytes before C4, 82 tools and 115,114 bytes after (about 28,800 tokens at four bytes a token). Providers cache a stable prefix, so the real cost depends on whether the tool list sits in the cached part; [0025](0025-multi-review-panel-value.md) records doubts about cache behaviour elsewhere, and [4901](4901-coordinator-waiting-on-cache-cost.md) asks the same question about the context block.

**Investigation.** Not done: it needs billed provider turns, which this work could not spend. What to record, per provider (Claude, Codex, OpenCode, Pi, Cursor, Grok): input tokens and `cacheReadTokens` on the first and on consecutive coordinator turns, with the surface as it is now.

**Decisions.**

- **What to do with the figure?**
  - **Record it beside the test's bound and act only if a provider does not cache the tool list (recommended).**
    - Pros: one measurement settles whether trimming further is worth anything; a cached list costs little per turn.
    - Cons: needs a run on every provider, some of them signed out here.
  - **Trim further now, without the figure.**
    - Pros: no billed runs.
    - Cons: may remove guidance that changes behaviour, for a saving that caching may already give.

### 2. Decide whether field-level copies of context rules can go

**Problem.** Some schema text repeats the context block, so it is sent twice each turn.

**Context.** `COORDINATOR_WORKER_PROMPT_FORMAT_RULE` (`packages/protocol/src/coordinator.ts`) is in the context block and on the `prompt` field of `launch_environment`, `launch_job`, `send_prompt_to_tab` and `fork_worker`, about 1.5 KB in all. `control-mcp-server-coordinator-workflows.test.ts` ("publishes the worker prompt format rule on every delegation prompt field") pins it there deliberately: the field text is what a model reads when it writes the prompt. `COORDINATOR_WORKER_PROMPT_NOTE` (no pull requests from workers; focused checks when review follows) on three tools restates the PR and validation rules, and `LAUNCH_DEFAULTS_GUIDANCE` restates the defaults rule, also on purpose (`control-mcp-tools-shared.ts` and `control-mcp-launch-tools.ts`). C4 shortened the `nodeId` description on 27 tools instead, which repeated nothing behavioural.

**Investigation.** Not done: whether models still format prompts and omit choices without the field copies can only be judged from real transcripts.

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

**Investigation.** Not done: needs real provider turns. What to look for in the live coordinator suite's transcripts ([agent-testing.md](../../development/agent-testing.md#live-coordinator-suite)): `launch_environment` and `launch_job` calls without `agent` when the user named none; distinct `requestId`s across a fresh main's first actions; no repeated `list_agents` reads while waiting.

**Decisions.**

- **Where to check?**
  - **Add the three checks to the existing live coordinator suite's assertions (recommended).**
    - Pros: runs with the other live qualifications; no new harness.
    - Cons: each check adds to a billed run.
  - **Read a handful of production transcripts by hand.**
    - Pros: no harness change.
    - Cons: not repeatable, and transcripts may not contain the cases.

## Related

- [Coordinator report, 4.3 (A2, A3, A5)](../../reports/2026-10-27-coordinator.md#43-agent-experience-prompt-and-tools)
- [4901-coordinator-waiting-on-cache-cost.md](4901-coordinator-waiting-on-cache-cost.md)
- [0025-multi-review-panel-value.md](0025-multi-review-panel-value.md)
- [The coordinator's tools](../../architecture/coordinator.md#multiple-machines)
