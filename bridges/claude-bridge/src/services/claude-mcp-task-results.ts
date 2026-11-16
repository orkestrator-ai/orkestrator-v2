/**
 * MCP tool calls the Claude CLI moved to the background as MCP tasks.
 *
 * Since Claude Code 2.1.319 a call to an MCP tool that declares `taskSupport`
 * can run as an MCP task. The call's `tool_result` is then the CLI's own
 * placeholder ("MCP tool "server - tool" started server-side task …, running
 * in the background as task k…"), and the real result arrives much later in a
 * `<task-notification>` user turn. Unlike an agent's or a shell command's
 * report, the CLI builds that turn without a `<tool-use-id>`
 * (`buildMcpTaskNotification` passes only the task id), so the report cannot
 * name the card it answers. Left alone, the card kept the placeholder as its
 * final output and the real result became a status row of its own.
 *
 * This module recognises the placeholder so the bridge can remember which call
 * a task belongs to; `ToolTracker` keeps that map and the report path resolves
 * the call from the task id. Nothing here depends on the rest of the bridge, so
 * the message parser can import it without a cycle.
 */

/**
 * The two placeholder openings the 2.1.319 CLI writes for a call it moved to
 * the background: one when the server sent a status note with the task handle,
 * one when it did not. Anchored to the start of the whole result, and only read
 * from an MCP tool's successful result, so ordinary tool output that happens to
 * quote the wording elsewhere cannot claim a task.
 *
 * The registry id is the CLI's own (`k` and eight base-36 characters for an MCP
 * task); the class is wider so a format change still matches, but excludes `.`
 * because the id is followed by a full stop in the first form.
 */
const MCP_TASK_PLACEHOLDER =
  /^MCP tool "[^"\r\n]{1,400}" started server-side task [^\r\n]{1,400}?(?:, running in the background as task |\. It was moved to the background as task )([A-Za-z0-9_-]{1,128})\b/;

/** The text of a tool result, whether a bare string or an array of text blocks. */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      // The placeholder is always the first and only text block.
      return (block as { text: string }).text;
    }
  }
  return "";
}

/**
 * The background task id an MCP tool result's placeholder names, or
 * `undefined` when the result is anything else (the tool's real output, a
 * refusal, or the "was not moved to the background" variants, which promise no
 * later result).
 */
export function mcpTaskIdFromPlaceholder(content: unknown): string | undefined {
  const text = toolResultText(content).trimStart();
  if (!text.startsWith("MCP tool ")) return undefined;
  return MCP_TASK_PLACEHOLDER.exec(text)?.[1];
}

/** Bound on the task-to-call map one tracker keeps; the oldest entries go first. */
export const MAX_TRACKED_BACKGROUND_TASK_CALLS = 512;
