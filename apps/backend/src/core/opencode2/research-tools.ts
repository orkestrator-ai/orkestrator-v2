/**
 * A coordinator's research MCP servers on OpenCode: their tools' exact ids.
 *
 * `coordinator.ts` registers the servers the launcher named (Settings →
 * Coordinator web research) on the coordinator's server and allows their
 * tools by exact id in the coordinator's permission rules. Exact ids rather
 * than a `context7_*` pattern, because OpenCode always loads the checkout's
 * project configuration: a project server named `context7_x` owns
 * `context7_x_*` tools, which the pattern would admit too. The research
 * server's tools are listed from the server itself.
 */
import { Client as McpClient, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

/** OpenCode's MCP tool key part: other characters than these become `_`. */
function openCodeToolKeyPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * The OpenCode tool ids a research server's `tools` are registered under,
 * without any another server could also produce.
 *
 * OpenCode names an MCP tool `<server>_<tool>`, so a project server whose name
 * extends the research server's (`context7_a`) produces `context7_a_b` for its
 * tool `b`, the same id as the research server's tool `a_b`. Such a tool is
 * left out rather than allowed under a name two servers share.
 */
export function openCodeResearchToolIds(
  server: string,
  tools: readonly string[],
  otherServers: readonly string[],
): string[] {
  const prefix = `${openCodeToolKeyPart(server)}_`;
  const shadows = otherServers
    .map(openCodeToolKeyPart)
    .filter((other) => other.startsWith(prefix))
    .map((other) => `${other}_`);
  return [...new Set(tools.map((tool) => `${prefix}${openCodeToolKeyPart(tool)}`))].filter(
    (id) => !shadows.some((shadow) => id.startsWith(shadow)),
  );
}

const LIST_TIMEOUT_MS = 10_000;
const MAX_RESEARCH_TOOLS = 128;

/**
 * The research server's own tool names, listed directly from the server
 * rather than from OpenCode.
 */
export async function listOpenCodeResearchTools(
  url: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const client = new McpClient(
    { name: "orkestrator-opencode-research", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const deadline = AbortSignal.timeout(LIST_TIMEOUT_MS);
  const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    await client.connect(transport, { signal: bounded, timeout: LIST_TIMEOUT_MS });
    const listed = await client.listTools(undefined, { signal: bounded, timeout: LIST_TIMEOUT_MS });
    return (listed.tools ?? [])
      .map((tool) => tool.name.trim())
      .filter((name) => name.length > 0 && name.length <= 128)
      .slice(0, MAX_RESEARCH_TOOLS);
  } finally {
    await Promise.allSettled([client.close(), transport.close()]);
  }
}
