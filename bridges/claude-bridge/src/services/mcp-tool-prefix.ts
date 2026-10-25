/**
 * The prefix the CLI gives a server's tools: `mcp__<name>__<tool>`.
 *
 * The CLI normalises the server name first (`normalizeNameForMCP`), and since
 * 2.1.299 a permission rule matches only that normalised spelling, so a rule
 * built from the configured name of a server with a `.` or a space matches
 * nothing. Its `claude.ai ` connectors also lose repeated and edge underscores.
 */
export function claudeMcpToolPrefix(name: string): string {
  let normalized = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (name.startsWith("claude.ai ")) {
    normalized = normalized.replace(/_+/g, "_").replace(/^_|_$/g, "");
  }
  return `mcp__${normalized}__`;
}
