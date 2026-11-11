import type { McpServerStatus } from "@anthropic-ai/claude-agent-sdk";
import {
  parseAgentInteractionToolHints,
  type AgentInteractionToolHints,
} from "@orkestrator/protocol/agent-interactions";

// The safety hints an MCP server declares for one of its tools (to-do 1031
// task 12), for the approval card of a Claude `mcp__*` call.
//
// `canUseTool` carries no annotations; only the CLI's MCP status read does.
// Observed against the pinned CLI 2.1.319 with a loopback model and a local
// MCP server (no credentials):
//
// - `mcpServerStatus()` lists each server under its configured name and each
//   tool under the bare name the server gave it (`wipe.disk tool`), while
//   `canUseTool` reports `mcp__<server>__<tool>` with every character outside
//   `[A-Za-z0-9_-]` replaced by `_` (`mcp__hint_srv_x__wipe_disk_tool` for
//   server `hint.srv x`), and `mcpServer.name` as the configured name.
// - The status annotations use the shared keys (`readOnly`, `destructive`,
//   `openWorld`) and keep only the hints the server set to `true`; a `false`
//   and `idempotentHint` are not reported.
// - The read answers in a few milliseconds while the CLI waits on the
//   `canUseTool` answer, so it can be made when the call is parked.
//
// The hints are self-declared by the server: they label the card and never
// change whether a rule may answer it.

/** Longest the approval waits on the status read before parking without hints. */
export const CLAUDE_MCP_TOOL_HINTS_TIMEOUT_MS = 2_000;

/** The part of `mcp__<server>__<tool>` the CLI makes from a server or tool name. */
export function claudeMcpNameSegment(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * The hints `statuses` record for the tool `canUseTool` named `toolName` on
 * the server it named `serverName`.
 *
 * Undefined unless exactly one server has that name and exactly one of its
 * tools makes that call name: two names the CLI writes the same way
 * (`a.b`, `a_b`) are ambiguous, and a wrong tag is worse than none. A server
 * whose call prefix the CLI writes differently (no such server was observed)
 * gets no hints rather than a guess.
 */
export function claudeMcpToolHintsFromStatus(
  statuses: readonly McpServerStatus[],
  serverName: string,
  toolName: string,
): AgentInteractionToolHints | undefined {
  if (!toolName.startsWith("mcp__") || serverName.length === 0) return undefined;
  const servers = statuses.filter((status) => status?.name === serverName);
  if (servers.length !== 1) return undefined;
  const prefix = `mcp__${claudeMcpNameSegment(serverName)}__`;
  if (!toolName.startsWith(prefix)) return undefined;
  const tools = Array.isArray(servers[0]!.tools) ? servers[0]!.tools : [];
  const matches = tools.filter(
    (tool) =>
      typeof tool?.name === "string" &&
      tool.name.length > 0 &&
      prefix + claudeMcpNameSegment(tool.name) === toolName,
  );
  if (matches.length !== 1) return undefined;
  return parseAgentInteractionToolHints(matches[0]!.annotations);
}

/** The one control method this needs, as the session's live query exposes it. */
export interface ClaudeMcpStatusReader {
  mcpServerStatus?: () => Promise<McpServerStatus[]>;
}

/**
 * Read the hints for an `mcp__*` call from the live CLI, when the call is
 * parked.
 *
 * Best-effort: no control, a non-MCP call, a failed or closed read, or one
 * slower than `timeoutMs` all give undefined, and the card shows no tag. A
 * read that settles after the timeout is ignored (its rejection is handled
 * by the race).
 */
export async function readClaudeMcpToolHints(
  control: ClaudeMcpStatusReader | undefined,
  serverName: string | undefined,
  toolName: string,
  timeoutMs: number = CLAUDE_MCP_TOOL_HINTS_TIMEOUT_MS,
): Promise<AgentInteractionToolHints | undefined> {
  if (!control?.mcpServerStatus || !serverName || !toolName.startsWith("mcp__")) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const statuses = await Promise.race([
      control.mcpServerStatus(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
    return Array.isArray(statuses)
      ? claudeMcpToolHintsFromStatus(statuses, serverName, toolName)
      : undefined;
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
