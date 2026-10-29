/**
 * Per-session user MCP servers on OpenCode (graphs item 404).
 *
 * OpenCode runs one `opencode serve` per directory, and every session in it
 * shares the MCP servers that instance loaded: a server cannot be attached to
 * one session or withheld from another. What a session does own is its
 * permission rules. A policy that selects its user servers
 * (`capabilityPolicy.userMcpServers`) therefore gets a deny rule for the
 * tools (`<server>_*`) of every server the instance lists (`mcp.status`)
 * outside the selection. The processes still run; the session cannot call
 * them. A granted server keeps its tools, approved up front unless the policy
 * asks, since the template's grant is the approval.
 *
 * When the instance's server list cannot be read, the session is refused:
 * without it the rules would leave every server callable.
 */
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import {
  nativeAgentAllowsUserMcpServer,
  nativeAgentRestrictsUserMcp,
  nativeAgentUserMcpGrant,
  type NativeAgentExecutionPolicy,
} from "@orkestrator/protocol/native-agent";
import { ORKESTRATOR_ARTIFACT_MCP_SERVER_NAME } from "@orkestrator/protocol/transcript-artifacts";
import { WORKFLOW_RESULT_MCP_SERVER_NAME } from "@orkestrator/protocol/workflow-results";
import { asRecord, assertSdkResponse } from "./agent-provider-runtime.js";
import { ORKESTRATOR_AGENT_MCP_SERVER_NAME } from "./agent-tools.js";

/** Servers Orkestrator posts itself; never a user's, never filtered. */
const RESERVED_OPENCODE_MCP_SERVERS: ReadonlySet<string> = new Set([
  ORKESTRATOR_AGENT_MCP_SERVER_NAME,
  "orkestrator-design",
  ORKESTRATOR_ARTIFACT_MCP_SERVER_NAME,
  WORKFLOW_RESULT_MCP_SERVER_NAME,
]);

/** Most listed servers a session's rules are computed over. */
export const MAX_OPENCODE_CONFIGURED_MCP_SERVERS = 256;

type PermissionAction = "allow" | "ask" | "deny";
interface PermissionRule {
  permission: string;
  pattern: string;
  action: PermissionAction;
}

/**
 * The tool-name prefixes OpenCode gives a server: it replaces characters
 * outside `[A-Za-z0-9_-]` with `_` before prefixing its tools, so both
 * spellings are covered.
 */
function toolPrefixes(server: string): string[] {
  return [...new Set([server, server.replace(/[^A-Za-z0-9_-]/g, "_")])];
}

/**
 * Permission rules that leave a session exactly the user servers its policy
 * selects, given the servers the instance lists. Appended after every other
 * rule (OpenCode applies the last match):
 *
 * 1. deny `<server>_*` for every listed user server the policy does not allow;
 * 2. for every granted server, its own rule again (`allow`, or `ask` when the
 *    policy asks), so a denied server whose name prefixes it (`docs` before
 *    `docs_v2`) does not take its tools too;
 * 3. the policy's own `toolPolicy.deny` entries under a granted prefix again,
 *    so step 2 cannot re-open a tool the user denied by name.
 *
 * Empty for a policy that narrows nothing.
 */
export function openCodeUserMcpRules(
  policy: NativeAgentExecutionPolicy,
  configured: readonly string[],
): PermissionRule[] {
  if (!nativeAgentRestrictsUserMcp(policy)) return [];
  const users = configured.filter((name) => !RESERVED_OPENCODE_MCP_SERVERS.has(name));
  const grant = new Set(nativeAgentUserMcpGrant(policy) ?? []);
  const rules: PermissionRule[] = [];
  for (const server of users) {
    if (nativeAgentAllowsUserMcpServer(policy, server)) continue;
    for (const prefix of toolPrefixes(server)) {
      rules.push({ permission: `${prefix}_*`, pattern: "*", action: "deny" });
    }
  }
  if (rules.length === 0) return rules;
  const grantedPrefixes = users
    .filter((server) => grant.has(server) && nativeAgentAllowsUserMcpServer(policy, server))
    .flatMap(toolPrefixes);
  const grantAction: PermissionAction = policy.approvals === "ask" ? "ask" : "allow";
  for (const prefix of grantedPrefixes) {
    rules.push({ permission: `${prefix}_*`, pattern: "*", action: grantAction });
  }
  for (const tool of policy.toolPolicy?.deny ?? []) {
    if (grantedPrefixes.some((prefix) => tool.startsWith(`${prefix}_`))) {
      rules.push({ permission: tool, pattern: "*", action: "deny" });
    }
  }
  return rules;
}

/**
 * The MCP servers the directory's instance lists, when `policy` narrows them;
 * `undefined` when it does not (no request is made). Throws when the list
 * cannot be read, which refuses the session or turn asking for it.
 */
export async function openCodeConfiguredMcpServersFor(
  policy: NativeAgentExecutionPolicy | undefined,
  client: OpencodeClient,
  directory: string | undefined,
  requestOptions: () => { signal: AbortSignal },
): Promise<string[] | undefined> {
  if (!nativeAgentRestrictsUserMcp(policy)) return undefined;
  const response = await client.mcp.status({ directory }, requestOptions());
  assertSdkResponse(response, "OpenCode MCP status for a session's MCP selection");
  const statuses = asRecord(response.data);
  if (!statuses) {
    throw new Error(
      "OpenCode did not list its MCP servers, so this session's MCP selection could not be applied",
    );
  }
  const names = Object.keys(statuses).sort();
  if (names.length > MAX_OPENCODE_CONFIGURED_MCP_SERVERS) {
    throw new Error(
      `OpenCode listed more than ${MAX_OPENCODE_CONFIGURED_MCP_SERVERS} MCP servers, so this session's MCP selection could not be applied`,
    );
  }
  return names;
}
