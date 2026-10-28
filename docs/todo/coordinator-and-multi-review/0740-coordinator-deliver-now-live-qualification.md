# Coordinator `deliverNow`: live qualification and follow-ups

Checked against `main` at `7e3ceb7c` (2026-10-28).

A coordinator's `send_message` takes `deliverNow: true` to have a busy worker
receive the message as a steer into its running turn instead of at turn end.
It reuses the Deliver now path (`steerRequested` on the pending entry), so the
steer, its journal verification and the terminal-agent hold note are the same
code a person's Deliver now runs. It has deterministic evidence only.

## Current state

- Described in
  [`coordinator.md`, "Course corrections with deliverNow"](../../architecture/coordinator.md#course-corrections-with-delivernow)
  and
  [`agent-messaging.md`, "Releasing one message"](../../architecture/agent-messaging.md).
- `send_coordinator_agent_mail` passes `steer` to `sendAgentMail`, waits for
  one drain pass and reports `deliverNow` (`coordinator-deliver-now.ts`).
- Tests: `coordinator-deliver-now.test.ts` (MailWorld: steered, idle, terminal,
  unconfirmed steer, default, muted, side agent, worker sender) and the
  `send_message` schema/result test in `control-mcp-server.test.ts`.

## Outstanding work

### Qualification

1. **Live steer from a coordinator into a busy worker.** One run per steering
   provider (Claude, Codex, Pi, Cursor): delegate a long task, then send a
   `deliverNow` correction mid-turn; check the result says `steered`, the
   worker's transcript shows the mail inside the running turn, and the
   coordinator is woken once, when that turn ends. Add it as a scenario of
   the opt-in coordinator live suite (0024).
2. **Live terminal worker.** A tmux Claude worker: the result says
   `unsupported, queued` and the mail arrives at turn end.

### Code

3. **Across a node link.** `deliverNow` on mail to a worker on another node
   (`send_coordinator_node_mail`, `send_node_message`) is reported as
   `unsupported, queued` and delivered at idle. Carrying the flag needs a
   field on the node mail envelope and the leaf to set `steerRequested`.

## Constraints and rationale

- Coordinator-only: worker `send_message` and `reply_message` have no
  `deliverNow`, and `sendAgentMail` ignores `steer` for any sender that is not
  a coordinator. A worker interrupting its coordinator mid-turn would undo the
  delegation hold.
- Coordinator conversations (main ↔ side) are never steered, so a side agent
  cannot cut into the main's turn with the user.

## Related

- [0024-coordinator-live-conformance.md](0024-coordinator-live-conformance.md)
- [0005-mid-turn-steer-and-interrupt.md](../agent-engines/0005-mid-turn-steer-and-interrupt.md)

## Replaces

None.
