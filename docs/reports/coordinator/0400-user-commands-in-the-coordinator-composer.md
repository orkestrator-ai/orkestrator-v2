# `!` commands in the coordinator composer are undiscoverable

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Make them discoverable and correct the footer**: mention `!` commands, and stop the footer contradicting them. Status: open.
2. **Handle a first message starting with `!`**: more than a toast. Status: open.

### 1. Make them discoverable and correct the footer

**Problem.** Nothing shows that `!` runs a command as the user, and the footer says commands run elsewhere.

**Context.** `!` commands are the user's own action, outside the read-only boundary by design (`docs/architecture/coordinator.md:1075-1102`).

**Investigation.** The placeholder is "What would you like to get done?" (`CoordinatorPanelNotices.tsx:17`). The footer says "Code changes, commands, builds and fixes run in build pipelines or prompt environments." (`CoordinatorPanel.tsx:1157`).

**Decisions.** None: reword the footer to speak of the coordinator's work, and add a short hint near the composer rather than in the placeholder.

### 2. Handle a first message starting with `!`

**Problem.** The first message cannot be a command, and the user learns that only from a passing toast, with the text still in the box.

**Context.** A command needs a conversation to show it and an agent to hear about it, and neither exists yet (`AgentNativeTab.helpers.tsx:877-884`).

**Investigation.** The toast does explain the rule; it is the delivery that is weak.

**Decisions.**

- **What should happen?**
  - **Keep the rule and show the same text inline under the composer (recommended).**
    - Pros: no behaviour change; survives until read.
    - Cons: a state for one rare case.
  - **Run it anyway by starting the conversation first.**
    - Pros: does what the user asked.
    - Cons: binds a platform and starts a provider session for a shell command.

## Related

- [Coordinator report, 4.4 (U13)](../2026-10-27-coordinator.md#44-ui-and-ux)
