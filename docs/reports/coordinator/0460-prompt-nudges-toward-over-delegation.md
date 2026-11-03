# The prompt nudges toward over-delegation

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Mention existing workers first**: the prompt offers `launch_job` and `send_prompt_to_tab` on an idle worker before a new environment. Status: open.
2. **Soften the read rule**: "even when it only reads" applies when the read is expected to be long. Status: open.

### 1. Mention existing workers first

**Problem.** A fresh worktree, with its setup scripts, can be started for each question when an idle worker could answer.

**Context.** Marked plausible in the report, not observed. Since then the routing and environment-choice rules have added more on how to start work (`packages/protocol/src/coordinator.ts:571-572`).

**Investigation.** The delegation line names only `launch_environment` (`native-agent-service.ts:1302`). The routing rule says "launch_environment with a prompt, then work with that worker back and forth". The MCP instructions, not the context, mention `launch_job` (`control-mcp-tools.ts:598-599`).

**Decisions.** None: one added clause in `COORDINATOR_ROUTING_RULE`, which is short and shared by every provider.

### 2. Soften the read rule

**Problem.** The Scope line sends any "multi-file investigation" to a worker "even when it only reads".

**Context.** The same sentence stops a read-only coordinator doing long work itself, which is its purpose. The architecture doc records the intent at `docs/architecture/coordinator.md:610-611`.

**Investigation.** `native-agent-service.ts:1326`.

**Decisions.**

- **Change it now?**
  - **Reword after a live check of how often coordinators launch for reads (recommended).**
    - Pros: evidence first for a prompt that sets the role.
    - Cons: needs transcripts from real use.
  - **Reword now as the report suggests.**
    - Pros: one line.
    - Cons: may push long work back into the coordinator's turn, which the line is there to prevent.

## Needs verification

Whether over-delegation happens in practice. No transcript was read for this file.

## Related

- [Coordinator report, 4.3 (A7)](../2026-10-27-coordinator.md#43-agent-experience-prompt-and-tools)
