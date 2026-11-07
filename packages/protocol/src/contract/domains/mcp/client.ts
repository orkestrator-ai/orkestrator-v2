/**
 * The `mcp` domain client (plan item 7008; §11.2 "Client adapters"): one
 * function per command (`commandApi`), keyed by command name.
 *
 * - Version 1 sends the envelope (no `mcp` key is critical) and decodes the
 *   result with the command's schema: the protocol's `McpTargetList`,
 *   `McpManagementSnapshot` (with its `protocolVersion`), operations and
 *   overlays, every undeclared field kept.
 * - Version 0 (a pre-contract node) is today's untyped call, answered as sent
 *   (`legacyCommandApi`). No MCP command was ever capability-gated: a node
 *   that predates MCP management answers `unknown-command`, which the
 *   settings page reads (`isUnknownMcpManagementCommandError`) as "this
 *   backend does not support it", at every version.
 *
 * Retirement: adapter 0 goes when the support floor passes the first Stable
 * release that advertises the `mcp` domain.
 *
 * Browser-safe.
 */
import { domainClient, type CommandCall, type DomainAdapterContext } from "../../client.js";
import { commandApi, legacyCommandApi, type CommandApi } from "../command-api.js";
import { MCP_COMMANDS } from "./commands.js";
import { mcpDomain } from "./domain.js";

export type McpApi = CommandApi<typeof MCP_COMMANDS>;

const mcpApi = (call: CommandCall): McpApi => commandApi(call, MCP_COMMANDS);
const legacyMcpApi = (_call: CommandCall, context: DomainAdapterContext): McpApi =>
  legacyCommandApi(context, MCP_COMMANDS);

export const mcpClient = domainClient(mcpDomain, {
  1: mcpApi,
  0: legacyMcpApi,
});
