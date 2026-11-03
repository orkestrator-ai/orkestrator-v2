# Trim the coordinator tool surface and remove the legacy node tools

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Remove the legacy node tools**: drop the `*_node_*` forms that duplicate `nodeId` from the coordinator's set. Status: open.
2. **Hide `start_multi_review`**: coordinators get only `launch_multi_review`. Status: open.
3. **Measure, then trim schema prose**: find the largest schemas again and cut what repeats the context block. Status: open.

### 1. Remove the legacy node tools

**Problem.** Seven tools duplicate the `nodeId` forms, and they do less: the model can pick the weaker one.

**Context.** Their own descriptions call them older forms that `nodeId` improves on.

**Investigation.** `NODE_TOOL_CAPABILITIES` (`control-mcp-nodes.ts:594-604`) grants `list_node_environments`, `read_node_environment`, `launch_node_environment`, `start_node_environment`, `stop_node_environment`, `send_prompt_to_node_tab` and `send_node_message`. `list_nodes` and `request_environment_deletion` have no duplicate. `launch_node_environment` (`:367`) does not validate the model, per its description, and its result has no async contract (`:411-418`). `send_prompt_to_node_tab` (`:451`) dispatches first and opens the delegation after, swallowing an error (`:488-494`). Both do open a delegation now. The report's "skips the outstanding-delegation check" still stands, since no check precedes the dispatch.

**Decisions.**

- **Remove, or reroute?**
  - **Remove from the coordinator set; keep any operator use (recommended).**
    - Pros: fewer tools; only one behaviour to reason about.
    - Cons: a saved schedule using `tool` with one of these names stops working, so check `assertToolSchedulable` on firing.
  - **Route them through the same implementation.**
    - Pros: no compatibility question.
    - Cons: keeps seven schemas in every turn for nothing.

### 2. Hide `start_multi_review`

**Problem.** A tool kept for diagnostics is offered to every coordinator, and the prompt has to explain not to use it.

**Context.** `native-agent-service.ts:1305` and `control-mcp-tools.ts:601` both steer away from it.

**Investigation.** It is granted at `control-mcp-tools.ts:151` and registered at `control-mcp-coordinator-tools.ts:485`. The operator's own copy is separate (`control-mcp-operator-workflow-tools.ts:112`).

**Decisions.** None: remove it from the coordinator map and registration, and the two steering sentences with it. Check first that no live scenario calls it.

### 3. Measure, then trim schema prose

**Problem.** The report's figures (56 tools, about 13.5k tokens) are out of date, and the surface has grown.

**Context.** The capability maps now hold about 86 entries (a count of map lines across `control-mcp-tools.ts:124-183` and the seven spread lists), against the report's 56. `send_message`'s description alone (`control-mcp-tools.ts:2047`) is about 2,000 characters.

**Investigation.** No size was measured for this file: nothing was run. Prompt caching changes what this costs per turn, and [0025](../../todo/coordinator-and-multi-review/0025-multi-review-panel-value.md) records doubts about cache behaviour elsewhere.

**Decisions.**

- **Is there a limit to enforce?**
  - **Add a test that prints and bounds total schema size for a main coordinator (recommended).**
    - Pros: a measurement at last, and it stops silent growth.
    - Cons: a bound that needs raising whenever a real tool arrives.
  - **Trim once by hand.**
    - Pros: no test to maintain.
    - Cons: nothing stops it growing back.

## Needs verification

The per-turn token and cost figure on the current surface, per provider.

## Related

- [Coordinator report, 4.3 (A5)](../2026-10-27-coordinator.md#43-agent-experience-prompt-and-tools)
- [0040-launch-agent-cannot-be-omitted.md](0040-launch-agent-cannot-be-omitted.md)
- [0395-coordinator-worker-surfaces-follow-ups.md](../../todo/coordinator-and-multi-review/0395-coordinator-worker-surfaces-follow-ups.md): adds `nodeId` to more tools
