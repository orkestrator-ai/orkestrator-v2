/**
 * Permission identity for a backend workflow turn's artifact-only server
 * (`orkestrator-artifacts`), which the backend attaches beside the turn's
 * workflow-result server and authenticates with the turn's artifact grant.
 */
import {
  ARTIFACT_TOOL_NAMES,
  ORKESTRATOR_ARTIFACT_MCP_SERVER_NAME,
} from "@orkestrator/protocol/transcript-artifacts";
import { isObject, type AgentMcpConnection, type JsonObject } from "./acp-context.js";
import { GROK_USE_TOOL } from "./acp-tools.js";

const SERVER = ORKESTRATOR_ARTIFACT_MCP_SERVER_NAME;
const ARTIFACT_SERVER_TOOL_IDS = new Set(
  ARTIFACT_TOOL_NAMES.flatMap((tool) => [
    `${SERVER}__${tool}`,
    `mcp__${SERVER}__${tool}`,
    `${SERVER}_${tool}`,
    `${SERVER}/${tool}`,
    `${SERVER}.${tool}`,
  ]),
);

/**
 * Whether a permission request is for a tool of this turn's artifact-only
 * server. Present only when the backend attached one for the turn. Its tools
 * write only to Orkestrator's artifact store, never the workspace, so the
 * caller allows them under every approval policy, a read-only turn's `deny`
 * included, after its explicit tool-denial check. Identity follows
 * `orkestratorToolPermissionOption`: a server-qualified name, Grok's
 * namespaced metadata, or the tool Grok's `use_tool` wraps; never a bare
 * name or a display title.
 */
export function isArtifactServerToolCall(
  params: JsonObject,
  connection: AgentMcpConnection | undefined,
  recordedInput?: unknown,
): boolean {
  if (!connection?.artifacts) return false;
  const toolCall = isObject(params.toolCall) ? params.toolCall : undefined;
  if (!toolCall || toolCall.kind === "execute" || toolCall.kind === "edit") return false;
  const meta = isObject(toolCall._meta) ? toolCall._meta : undefined;
  const xaiTool = meta && isObject(meta["x.ai/tool"]) ? meta["x.ai/tool"] : undefined;
  const vendorName = xaiTool ? xaiTool.name : toolCall.name;
  const input = toolCall.rawInput === undefined ? recordedInput : toolCall.rawInput;
  const name =
    typeof vendorName === "string" && vendorName.trim() === GROK_USE_TOOL
      ? isObject(input) && typeof input.tool_name === "string"
        ? input.tool_name
        : undefined
      : vendorName;
  if (
    xaiTool?.namespace === SERVER &&
    typeof xaiTool.name === "string" &&
    (ARTIFACT_TOOL_NAMES as readonly string[]).includes(xaiTool.name.trim())
  ) {
    return true;
  }
  return typeof name === "string" && ARTIFACT_SERVER_TOOL_IDS.has(name.trim());
}
