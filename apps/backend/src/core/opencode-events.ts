/**
 * The SSE event vocabulary this backend knows about.
 *
 * Separate from `opencode-provider.ts` because it is a pure lookup table, and
 * because the provider module is already at its reviewed size limit. Its whole
 * value is the `Record` type below: an OpenCode release that adds an event
 * breaks this file's typecheck rather than arriving as an unexplained gap in
 * the request monitor.
 */
import type { Event as OpenCodeEvent } from "@opencode-ai/sdk/v2/types";

/**
 * Every SSE event type this provider knows about.
 *
 * Written as a `Record` over the SDK's own `Event` union rather than a loose
 * list, so an OpenCode release that adds an event **fails this typecheck**
 * instead of arriving as an unexplained gap at runtime. `true` means "this
 * provider has a branch for it"; `false` means "known and deliberately not
 * consumed here" — most events belong to the renderer's transcript stream, not
 * to this request monitor.
 */
export const KNOWN_OPENCODE_EVENTS: Record<OpenCodeEvent["type"], boolean> = {
  "models-dev.refreshed": false,
  "integration.updated": false,
  "integration.connection.updated": false,
  "catalog.updated": false,
  "session.created": false,
  "session.updated": false,
  "session.deleted": false,
  "message.updated": false,
  "message.removed": false,
  "message.part.updated": false,
  "message.part.removed": false,
  "session.next.agent.switched": false,
  "session.next.model.switched": false,
  "session.next.moved": false,
  "session.next.prompted": false,
  "session.next.prompt.admitted": false,
  "session.next.context.updated": false,
  "session.next.synthetic": false,
  "session.next.shell.started": false,
  "session.next.shell.ended": false,
  "session.next.step.started": false,
  "session.next.step.ended": false,
  "session.next.step.failed": false,
  "session.next.text.started": false,
  "session.next.text.delta": false,
  "session.next.text.ended": false,
  "session.next.reasoning.started": false,
  "session.next.reasoning.delta": false,
  "session.next.reasoning.ended": false,
  "session.next.tool.input.started": false,
  "session.next.tool.input.delta": false,
  "session.next.tool.input.ended": false,
  "session.next.tool.called": false,
  "session.next.tool.progress": false,
  "session.next.tool.success": false,
  "session.next.tool.failed": false,
  "session.next.retried": false,
  "session.next.compaction.started": false,
  "session.next.compaction.delta": false,
  "session.next.compaction.ended": false,
  "session.next.revert.staged": false,
  "session.next.revert.cleared": false,
  "session.next.revert.committed": false,
  "message.part.delta": false,
  "session.diff": false,
  "session.error": false,
  "installation.updated": false,
  "installation.update-available": false,
  "file.edited": false,
  "reference.updated": false,
  "permission.v2.asked": false,
  "permission.v2.replied": false,
  "plugin.added": false,
  "project.directories.updated": false,
  "file.watcher.updated": false,
  "pty.created": false,
  "pty.updated": false,
  "pty.exited": false,
  "pty.deleted": false,
  "question.v2.asked": false,
  "question.v2.replied": false,
  "question.v2.rejected": false,
  "todo.updated": false,
  "lsp.updated": false,
  "permission.asked": true,
  "permission.replied": false,
  "tui.prompt.append": false,
  "tui.command.execute": false,
  "tui.toast.show": false,
  "tui.session.select": false,
  "mcp.tools.changed": false,
  "mcp.browser.open.failed": false,
  "command.executed": false,
  "project.updated": false,
  "session.status": false,
  "session.idle": false,
  "question.asked": true,
  "question.replied": true,
  "question.rejected": true,
  "session.compacted": false,
  "vcs.branch.updated": false,
  "workspace.ready": false,
  "workspace.failed": false,
  "workspace.status": false,
  "worktree.ready": false,
  "worktree.failed": false,
  "server.connected": false,
  "global.disposed": false,
  "server.instance.disposed": false,
};

export function isKnownOpenCodeEvent(type: string): boolean {
  return type in KNOWN_OPENCODE_EVENTS;
}
