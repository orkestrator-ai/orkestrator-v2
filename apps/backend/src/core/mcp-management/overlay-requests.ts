/**
 * Request parsing for the environment overlay commands. Ids are opaque and
 * bounded; a container path is never accepted from a client.
 */

import {
  MCP_MANAGEMENT_LIMITS,
  mcpFailure,
  utf8ByteLength,
  type McpDefaultsRefreshRequest,
  type McpOverlayAction,
  type McpOverlayResolution,
} from "@orkestrator/protocol/mcp-management";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function opaque(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    utf8ByteLength(value) > MCP_MANAGEMENT_LIMITS.opaqueIdMaxBytes
  )
    throw mcpFailure("invalid-request", { message: `${field} is required.` });
  return value;
}

function action(value: unknown): McpOverlayAction {
  if (!isRecord(value)) throw mcpFailure("invalid-request", { message: "action is required." });
  switch (value.kind) {
    case "import":
    case "reapply":
    case "reset":
      return { kind: value.kind };
    case "keep-environment":
    case "take-inherited": {
      const name = value.name;
      if (
        typeof name !== "string" ||
        !name ||
        utf8ByteLength(name) > MCP_MANAGEMENT_LIMITS.nameMaxBytes
      )
        throw mcpFailure("invalid-request", { message: "action.name is required." });
      return { kind: value.kind, name };
    }
    default:
      throw mcpFailure("invalid-request", { message: "Unknown overlay action." });
  }
}

export function parseOverlayResolution(value: unknown): McpOverlayResolution {
  if (!isRecord(value)) throw mcpFailure("invalid-request");
  const expected = value.expectedRevision;
  if (expected !== null && typeof expected !== "string")
    throw mcpFailure("invalid-request", { message: "expectedRevision is required." });
  return {
    targetId: opaque(value.targetId, "targetId"),
    sourceId: opaque(value.sourceId, "sourceId"),
    expectedRevision: expected === null ? null : opaque(expected, "expectedRevision"),
    action: action(value.action),
  };
}

export function parseDefaultsRefreshRequest(
  value: unknown,
  requireToken: boolean,
): McpDefaultsRefreshRequest {
  if (!isRecord(value)) throw mcpFailure("invalid-request");
  return {
    targetId: opaque(value.targetId, "targetId"),
    sourceId: opaque(value.sourceId, "sourceId"),
    previewToken: requireToken ? opaque(value.previewToken, "previewToken") : "",
  };
}
