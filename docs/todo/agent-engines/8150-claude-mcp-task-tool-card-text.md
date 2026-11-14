# What a Claude MCP tool card shows while the call runs as an MCP task

## Task analysis

Analysed 2026-11-14 against `main` at `dc90609bf`.

### Tasks

1. **Pin what the card shows for a task-run MCP call**: with Claude 2.1.319's MCP tasks, a call may return a placeholder tool result and deliver the real result later through `task_notification`; find out what the tab's tool card shows in between and after. Status: open.

### 1. Pin what the card shows for a task-run MCP call

**Problem.** Claude Code 2.1.319 can run an MCP tool call as an MCP task, and its release turned MCP tasks on by default. The upgrade's reading (1031 task 8) was that the tool result is then the CLI's placeholder text until a `task_notification` carries the real result. Nobody has looked at what an Orkestrator tool card shows in that case: the placeholder as if it were the answer, the real result once it arrives, or both. A user reading the placeholder as the tool's answer would be misled.

**Context.** Found while upgrading the pins (1031 (retired 2026-11-14) task 8, "Behaviour, no code change", and its Needs verification; `git show dc90609bf:docs/todo/agent-engines/1031-provider-upgrade-2026-11-06.md`). The bridge already has an `mcp_task` background-task kind (`bridges/claude-bridge/src/types/index.ts`) and turns `task_started`, `task_progress` and `task_notification` into background-task rows (`session-manager-background-tasks.ts`, `session-manager-prompt-handlers/system-tasks.ts`). Existing live MCP fixtures run the pinned CLI against a loopback model and a local MCP server: `claude-mcp-tool-hints.live-fixture.ts` and `session-manager-prompt-mcp-sync.live-fixture.ts`. No login or billed turn is needed.

**Investigation.** In the pinned 2.1.319 binary (darwin-arm64, read on 2026-11-14):

- MCP tasks are gated by `dA()`: off when `CLAUDE_CODE_DISABLE_MCP_TASKS` is set, otherwise the feature flag `tengu_glowing_lark`, whose default depends on the session kind and is off for `CLAUDE_CODE_REMOTE`. Whether it is on in a bridge session, with nonessential traffic disabled, is not known.
- The CLI's tool schema carries a `taskSupport` field (`required`, `optional` or `forbidden`), so a call can run as a task only on a server whose tool declares it in `tools/list`. Orkestrator's own MCP servers do not declare it (no `taskSupport` in this repository), which may be why nobody has seen the placeholder.
- `CLAUDE_CODE_DISABLE_MCP_TASK_BACKGROUND` also exists, and the CLI keeps a `restoreMcpTasks` resume record per task.

**Decisions.**

- **How to find out?**
  - **A slow-tier live probe on the pinned CLI with a loopback model and a fake MCP server whose tool declares `taskSupport: "optional"` and answers through the MCP tasks methods, recording the tool result, the task frames and the bridge's transcript rows (recommended).**
    - Pros: no login; it fails when a CLI bump changes the behaviour; it reuses the existing MCP live fixtures.
    - Cons: the fake server has to implement the tasks part of the MCP protocol, and the probe has to find out whether the flag is on in a bridge session at all.
  - **Set `CLAUDE_CODE_DISABLE_MCP_TASKS` in the bridge's CLI environment.**
    - Pros: the placeholder can never reach a card.
    - Cons: turns off an upstream feature without evidence that it misleads, and long-running MCP calls lose the task path.
  - **Leave it until a user reports it.**
    - Pros: no work now.
    - Cons: the first sighting would be on a real server, with no fixture to pin the fix.

## Related

- 1031 (retired 2026-11-14), the provider upgrade that found it: `git show dc90609bf:docs/todo/agent-engines/1031-provider-upgrade-2026-11-06.md`
- [0007-provider-sdk-adoption-backlog.md](0007-provider-sdk-adoption-backlog.md)
- [upgrade-agents.md](../../development/upgrade-agents.md) (Claude)
