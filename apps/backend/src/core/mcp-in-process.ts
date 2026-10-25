import { createMcpHandler, type McpServer } from "@modelcontextprotocol/server";

/**
 * Calls a tool of an MCP server built for one caller's scope, inside the
 * backend, without a socket or a bearer token.
 *
 * Scheduled jobs fire through this: a coordinator's or an agent's scheduled
 * action runs the very tool the owner would have called, with the same scope
 * object the HTTP endpoint would have authenticated, so its argument
 * validation, capability filter and command-boundary checks all apply. The
 * request takes the stateless legacy path, exactly like an HTTP request.
 */

export interface InProcessToolResult {
  isError: boolean;
  /** First text block, bounded. */
  text: string;
  structuredContent?: Record<string, unknown>;
}

export interface InProcessToolInfo {
  name: string;
  readOnly: boolean;
}

const MAX_TEXT_CHARS = 16_000;

async function rpc(
  factory: () => McpServer | Promise<McpServer>,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const handler = createMcpHandler(factory, { legacy: "stateless" });
  try {
    const response = await handler.fetch(
      new Request("http://in-process.invalid/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }),
    );
    const text = await response.text();
    const message = parseRpcMessage(text);
    if (!message)
      throw new Error(`MCP ${method} returned HTTP ${response.status} without a result`);
    if (isRecord(message.error)) {
      throw new Error(
        typeof message.error.message === "string" ? message.error.message : `MCP ${method} failed`,
      );
    }
    if (!isRecord(message.result)) throw new Error(`MCP ${method} returned no result`);
    return message.result;
  } finally {
    await handler.close().catch(() => undefined);
  }
}

/** The JSON-RPC message from a JSON body or the first `data:` frame of an SSE body. */
function parseRpcMessage(body: string): Record<string, unknown> | null {
  const candidates = body.trimStart().startsWith("{")
    ? [body]
    : body
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (isRecord(parsed) && ("result" in parsed || "error" in parsed)) return parsed;
    } catch {
      // try the next frame
    }
  }
  return null;
}

export async function callToolInProcess(
  factory: () => McpServer | Promise<McpServer>,
  name: string,
  args: Record<string, unknown>,
): Promise<InProcessToolResult> {
  const result = await rpc(factory, "tools/call", { name, arguments: args });
  const content = Array.isArray(result.content) ? result.content : [];
  const first = content.find(
    (item): item is { type: "text"; text: string } =>
      isRecord(item) && item.type === "text" && typeof item.text === "string",
  );
  return {
    isError: result.isError === true,
    text: (first?.text ?? "").slice(0, MAX_TEXT_CHARS),
    ...(isRecord(result.structuredContent) ? { structuredContent: result.structuredContent } : {}),
  };
}

export async function listToolsInProcess(
  factory: () => McpServer | Promise<McpServer>,
): Promise<InProcessToolInfo[]> {
  const result = await rpc(factory, "tools/list", {});
  const tools = Array.isArray(result.tools) ? result.tools : [];
  return tools.flatMap((tool) =>
    isRecord(tool) && typeof tool.name === "string"
      ? [
          {
            name: tool.name,
            readOnly: isRecord(tool.annotations) && tool.annotations.readOnlyHint === true,
          },
        ]
      : [],
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
