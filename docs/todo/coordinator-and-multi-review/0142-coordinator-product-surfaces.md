# Coordinator product surfaces

Checked against `main` at `20f6de91` (2026-10-25).

Coordinator capabilities that do not exist yet and are deliberately kept off
the platform-parity path. They are features, not provider adapters: every
qualified platform already inspects, delegates, wakes and queues through the
same interface ([`coordinator.md`](../../architecture/coordinator.md)). Moved
here from
[0028-coordinator-consistency-gaps.md](0028-coordinator-consistency-gaps.md),
whose parity gaps are all closed.

## Current state

- **MCP surface.** `COORDINATOR_CONTROL_TOOL_NAMES` in
  `packages/protocol/src/coordinator.ts` is the full list of coordinator tools.
  A backend `launch_terminal_job` command exists
  (`apps/backend/src/core/commands-registry-terminal.ts`) but is not exposed to
  coordinators.
- **Worker bases.** Workers start from a recorded base commit
  (`coordinatorBase` from `get_launch_options`); uncommitted root changes are
  never copied into a worker.

## Outstanding work

### Code (deferred)

Each needs its own authority and idempotency design before it is exposed:
what the credential may target, what a retry with the same `requestId` does,
and what the user sees and can undo.

1. **Uncommitted root changes in a worker.** A user-selected patch of the root
   checkout's uncommitted changes, applied to a new worker. The user picks the
   files; the coordinator cannot read or copy them on its own.
2. **Terminal or tmux launch** for coordinators, building on
   `launch_terminal_job`.
3. **Browser launch and navigation** in a worker's preview.
4. **Arbitrary pane editing** (opening, closing or moving a worker's tabs).
5. **Custom-fix model switches, reviewer subtabs, looped review and
   feature-plan launch** for Multi Review and planning workflows.

## Constraints and rationale

- Repository checkout mutation stays UI-only; it is not a coordinator tool.
- None of these blocks mail or delegation work, and none is a reason to give a
  platform a coordinator-only workaround.

## Open questions

- Which of these is wanted first? None has a user request attached yet.

## Needs verification

- Nothing yet.

## Related

- [0028-coordinator-consistency-gaps.md](0028-coordinator-consistency-gaps.md)
  (where these were listed before) and
  [`control-mcp.md`](../../architecture/control-mcp.md) for tool tiers and
  authority.

## Replaces

- The "Product surfaces kept off the parity path" section of
  [0028-coordinator-consistency-gaps.md](0028-coordinator-consistency-gaps.md).
