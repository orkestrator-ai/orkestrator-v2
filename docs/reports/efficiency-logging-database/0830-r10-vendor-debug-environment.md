# Stop inherited vendor debug variables reaching local bridges

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Filter vendor debug variables on local bridge launch**: with a documented way to keep them. Status: open.

### 1. Filter vendor debug variables on local bridge launch

**Problem.** A stray `DEBUG`, `RUST_LOG` or `DEBUG_CLAUDE_AGENT_SDK` in the shell that launched Orkestrator turns on vendor debug output in a bridge. That output is not a logger call, so it is captured whatever the level is, and a vendor's debug text can hold prompts or tool content.

**Context.** Report L10 and R10. Since the report, levels and the structured log are in place, but raw output bypasses them by design: "output that is not a logger call ... is captured as text whatever the level is" (`docs/architecture/logging.md:583-584`). AGENTS.md invariant 12 keeps file and terminal contents out of logs.

**Investigation.** `commands-servers.ts:961` builds the local bridge environment from `...process.env`. A search of `apps/backend/src`, `packages/protocol/src` and `bridges/*/src` finds no reference to `DEBUG_CLAUDE_AGENT_SDK` or `RUST_LOG` and no filter. `configureBridgeLogger` consumes only Orkestrator's own relay, format and level variables, so agent commands do not inherit those (`logging.md:656-661`). Container bridges do not inherit the host environment at all.

**Decisions.**

- **How to filter?**
  - **Remove a short named list (`DEBUG`, `RUST_LOG`, `DEBUG_CLAUDE_AGENT_SDK`) in the local launch, unless `ORKESTRATOR_KEEP_VENDOR_DEBUG=1` (recommended).**
    - Pros: predictable; a one-line escape hatch to document, as the report asks.
    - Cons: a list needs maintaining, and a new vendor variable slips through.
  - **Honour them only from an explicit "advanced environment" field, as the report proposes.**
    - Pros: a user states intent where it can be seen.
    - Cons: the field is new settings surface for a developer need.
  - **Leave them and document it.**
    - Pros: no behaviour change; a developer exporting `DEBUG=…` gets what they asked for.
    - Cons: the shell setting is often forgotten, and the leak is silent.
- **What about agent commands?**
  - **The filter applies to the bridge process and what it spawns, as with today's relay variables (recommended).**
    - Pros: one rule; the vendor CLI is the child that honours most of these.
    - Cons: a command an agent runs in the worktree no longer inherits `DEBUG` from the launch shell. A project's own `DEBUG=x npm test` is unaffected.
  - **Strip it only from the bridge and restore it for tools.**
    - Pros: tool behaviour is exactly as now.
    - Cons: needs per-provider plumbing, and vendors spawn tools themselves.

## Current state

Nothing has landed. Split from [0850](0850-r10-docker-log-bounds.md) because it can ship alone and is a privacy matter rather than a disk one.

## Needs verification

- Whether any supported provider needs one of these set in normal use. None was found, but vendor CLIs were not run.
- Whether an existing settings field already passes user-set variables to local bridges was not traced.

## Related

- [Logging and database report, R10](../2026-10-29-logging-and-database-efficiency.md#r10-docker-log-hygiene-l9) and [L10](../2026-10-29-logging-and-database-efficiency.md#l10-consistency-low)
- [Application logging](../../architecture/logging.md#the-bridge-hop)
