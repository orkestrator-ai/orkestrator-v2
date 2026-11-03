# The launch `agent` cannot be omitted, so defaults are not followed

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Let `agent` default**: a coordinator's `launch_environment` and `launch_job` resolve the repository default when `agent` is left out. Status: open.

### 1. Let `agent` default

**Problem.** The coordinator is told to omit choices so the user's defaults apply, but `agent` is a required enum. A model that writes `claude` out of habit runs workers on a platform other than the user's default, silently.

**Context.** `get_launch_options` returns `defaults.agent` (`docs/architecture/coordinator.md:2048-2050`). The doc also says that each "agent field" says omitting it uses the saved default (`:2045-2047`), which is not true of these two tools.

**Investigation.** `agent` is required at `control-mcp-tools.ts:1537` (`launch_environment`) and `:1760` (`launch_job`), with no description. `COORDINATOR_LAUNCH_DEFAULTS_RULE` (`packages/protocol/src/coordinator.ts:555-556`) lists `modelId`, `reasoningId` and build `agentType` as omittable; `agent` appears only as something to override on request, and nothing says to copy `defaults.agent`. `start_build_pipeline` already takes an optional `agentType`. `launch_node_environment` has the same required field (`control-mcp-nodes.ts:377`); see [0160](0160-tool-surface-and-legacy-node-tools.md).

**Decisions.**

- **Make it optional, or only document it?**
  - **Optional, resolving as `coordinatorService.preferredAgent` does (recommended).**
    - Pros: the rule becomes true as written; matches `modelId` and `agentType`; a model cannot pick wrongly by omission.
    - Cons: the node form must resolve on that node, where the default may differ; the `nodeId` path validates there.
  - **Keep it required and say "pass `defaults.agent`".**
    - Pros: no behaviour change; one description.
    - Cons: relies on the model reading it, and adds another line to a schema that is already large.

## Related

- [Coordinator report, 4.3 (A2)](../2026-10-27-coordinator.md#43-agent-experience-prompt-and-tools)
