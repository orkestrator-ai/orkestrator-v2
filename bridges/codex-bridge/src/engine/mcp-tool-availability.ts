/**
 * Whether a loaded thread's live MCP connection exposes one tool.
 *
 * A workflow result turn can only finish by calling its submit tool. When that
 * tool is missing the model still runs the whole turn and ends it with the
 * result pasted as text, which the backend then waits on for minutes before
 * failing. Asking app-server before the turn starts turns that into an
 * immediate, explainable refusal.
 */

export type McpToolAvailability =
  | { state: "available" }
  | { state: "missing"; reason: string }
  /** app-server could not answer. Callers must not treat this as missing. */
  | { state: "unverified" };

export const MCP_TOOL_AVAILABILITY_TIMEOUT_MS = 5_000;
export const MCP_TOOL_AVAILABILITY_POLL_MS = 100;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Reads one `mcpServerStatus/list` answer. `undefined` means the server is
 * still connecting and the answer may change.
 */
export function classifyMcpToolAvailability(
  response: unknown,
  serverName: string,
  toolName: string,
): McpToolAvailability | undefined {
  const data = record(response).data;
  if (!Array.isArray(data)) return { state: "unverified" };
  const server = data.map(record).find((entry) => entry.name === serverName);
  if (!server) return { state: "missing", reason: "is not configured for this thread" };
  const tools = record(server.tools);
  if (
    Object.hasOwn(tools, toolName) ||
    Object.values(tools).some((tool) => record(tool).name === toolName)
  ) {
    return { state: "available" };
  }
  const status = server.runtimeStatus;
  if (status === "starting" || status === "notStarted" || status === null) return undefined;
  if (typeof server.toolsError === "string" && server.toolsError.trim()) {
    return { state: "missing", reason: "could not list its tools" };
  }
  if (status === "connected") {
    return { state: "missing", reason: `does not list ${toolName}` };
  }
  return {
    state: "missing",
    reason: typeof status === "string" ? `is ${status}` : "is unavailable",
  };
}

/**
 * Polls until the answer is definite or the bounded wait runs out. A server
 * still connecting at the deadline is `unverified`, never `missing`.
 */
export async function waitForMcpToolAvailability(
  list: () => Promise<unknown>,
  serverName: string,
  toolName: string,
  options: { timeoutMs?: number; pollMs?: number; now?: () => number } = {},
): Promise<McpToolAvailability> {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? MCP_TOOL_AVAILABILITY_TIMEOUT_MS);
  const pollMs = options.pollMs ?? MCP_TOOL_AVAILABILITY_POLL_MS;
  for (;;) {
    let response: unknown;
    try {
      response = await list();
    } catch {
      return { state: "unverified" };
    }
    const availability = classifyMcpToolAvailability(response, serverName, toolName);
    if (availability) return availability;
    if (now() >= deadline) return { state: "unverified" };
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
