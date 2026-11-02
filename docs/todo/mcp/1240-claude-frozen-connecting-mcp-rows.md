# Claude MCP rows stay "connecting" after a CLI exits before they connect

## Task analysis

Analysed 2026-11-01 on the branch that fixed [1163](1163-claude-probe-reconnect-inventory.md). Rechecked 2026-11-02 against main at 38d55ee14: unchanged, `readSessionMcpServers` still served the retained init rows as they were.

### Tasks

1. **Stop showing a dead CLI's servers as connecting**: a `connecting` row with no CLI behind it should say that its state is unknown. Status: done.

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

### Task 1: map on the way out, not in the stored row

Chose the recommended option. `readSessionMcpServers` (`bridges/claude-bridge/src/services/session-manager-catalog.ts`) serves every retained `connecting` row as `unknown` through `inventoryWithoutCli` whenever no readable control answers. `session.mcpInventory` is left as the CLI reported it. Rewriting the stored row was the alternative; it would lose the CLI's last word for nothing, since a running CLI's next answer replaces the whole list anyway, and 1163 keeps a row's last state on purpose.

### Task 1: the probe path needs nothing of its own

A probe is closed before `performSessionMcpAction` returns, and the panel reads the list through `readSessionMcpServers` afterwards. So the same read covers both the rows the probe did not touch and a row the probe itself left `pending`. No mapping was added inside `applyProbeMcpStatus`.

### Task 1: a read that loses the race with the CLI exiting counts as no CLI

When `mcpServerStatus()` fails with the SDK's closed-transport error, the CLI has gone even though `readableControl` returned it a moment earlier. That fallback now serves the same mapped rows instead of the raw retained list. A live CLI that answers `pending` still reads `connecting`.

### Task 1: the row keeps its actions

An `unknown` row keeps `reconnect` and `disable`, so a click still runs a reconnect through a probe. The renderer already has a dot for `unknown` (`AgentInfoButton.panels.tsx`).

### Task 1: the second option was not built

Reading a final status before the bridge closes a refused turn's CLI was not built. The to-do already notes the servers usually have not connected by then, so it would add a control request on the close path for little gain.

## Current state

- A retained `connecting` row reads `unknown` when no CLI can answer, on the session path, the probe path and a read that loses the race with the CLI exiting. Bridge tests in `session-manager-catalog-transport.test.ts` cover each, and that a live CLI still reports `connecting`.
- `mcp-ui-matrix.spec.ts` still avoids this state with a hook that holds the CLI open, so it does not guard it in a real browser.

## Needs verification

- The fix was not observed in a real browser. A credential-free `dev:test` profile running `mcp-ui-matrix.spec.ts` without its hold-open hook should now show `unknown` rather than `connecting` after the CLI exits.

## Constraints and rationale

- A row's last reported state is kept on purpose while no CLI runs ([1163](1163-claude-probe-reconnect-inventory.md)). Only a state that implies ongoing work is misleading.

## Open questions

None.

## Related

- [1163-claude-probe-reconnect-inventory.md](1163-claude-probe-reconnect-inventory.md), where this was found
- `e2e/agent-testing/mcp-ui-matrix.spec.ts`

## Replaces

Nothing; new observation.
