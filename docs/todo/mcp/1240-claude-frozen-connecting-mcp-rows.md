# Claude MCP rows stay "connecting" after a CLI exits before they connect

## Task analysis

Analysed 2026-11-01 on the branch that fixed [1163](1163-claude-probe-reconnect-inventory.md).

### Tasks

1. **Stop showing a dead CLI's servers as connecting**: a `connecting` row with no CLI behind it should say that its state is unknown. Status: open.

### 1. Stop showing a dead CLI's servers as connecting

**Problem.** When a Claude CLI exits before any read reaches it, every row of the live MCP panel stays `connecting` until the next turn, although nothing is connecting.

**Context.** The init frame lists servers as `pending`. If no `mcpServerStatus()` read lands while the CLI is up, `readSessionMcpServers` serves those rows from `session.initData` (`session-manager-catalog.ts`, `retainedMcpInventory`), and a status never changes without a running CLI.

**Investigation.** Observed in a real browser on a `--no-agent-credentials` profile, 2026-11-01, on `main` at `0658de646`, at host load about 4: one run of the unmodified `mcp-ui-matrix.spec.ts` stayed `connecting` for the full 60 s the spec waits, and so did three runs with one more fixture server added, where the rows were read and every server, `orkestrator` included, was `connecting`. The fixture server's log shows the CLI stopping it about 100 ms after starting it. Only a turn the CLI ends straight away reaches this; a CLI that stays warm answers later reads. A signed-in session was not observed.

**Decisions.**

- **What should a row say once its CLI has gone?**
  - **Map `connecting` to `unknown` when the session has no readable control (recommended).**
    - Pros: small, read-side only; the panel stops implying progress.
    - Cons: needs the same care on the probe path, which keeps the other rows as they were.
  - **Read a final status before the bridge closes a refused turn's CLI.**
    - Pros: can report real results when the servers connect in time.
    - Cons: the servers usually have not connected yet, so it still needs the first option.

## Assumptions and decisions

- Rated low because the state clears on the next turn and a click on the row still runs a reconnect.

## Current state

- The panel shows `connecting` for a CLI that has exited.
- `mcp-ui-matrix.spec.ts` avoids this state with a hook that holds the CLI open, so it does not guard it.

## Outstanding work

### Code

1. Report a retained `connecting` row as unknown when no CLI is running.

### Qualification

- A component or bridge test is enough; a credential-free CLI reproduces it in a real browser.

## Constraints and rationale

- A row's last reported state is kept on purpose while no CLI runs ([1163](1163-claude-probe-reconnect-inventory.md)). Only a state that implies ongoing work is misleading.

## Open questions

None.

## Related

- [1163-claude-probe-reconnect-inventory.md](1163-claude-probe-reconnect-inventory.md), where this was found
- `e2e/agent-testing/mcp-ui-matrix.spec.ts`

## Replaces

Nothing; new observation.
