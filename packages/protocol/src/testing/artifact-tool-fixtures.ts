/**
 * Recorded-shape `publish_artifact` traffic for provider projection tests.
 *
 * Every bridge (and the backend's OpenCode projection) replays these through
 * its real tool-call translation and checks the part it produces with
 * `publishArtifactCallContract`, which reads a part exactly the way the web
 * client's publication merge does: the tool is recognised by
 * `orkestratorToolName`, and the publication is matched by the call's
 * `artifactId` / `expectedRevision` arguments, never by the tool output.
 */
import { ARTIFACT_TOOL_NAMES, orkestratorToolName } from "../transcript-artifacts.js";

export const RECORDED_ARTIFACT_ID = "art_fixture0001";
export const RECORDED_ARTIFACT_REVISION = 2;
export const RECORDED_PUBLICATION_ID = "pub_fixture0001";
export const RECORDED_RECEIPT_ID = "rcpt_fixture0001";
export const RECORDED_ARTIFACT_ERROR_CODE = "preview_stale";

/** `publish_artifact` arguments as a model sends them. */
export const RECORDED_PUBLISH_ARTIFACT_ARGS: Readonly<Record<string, unknown>> = Object.freeze({
  requestKey: "publish-chart-1",
  artifactId: RECORDED_ARTIFACT_ID,
  expectedRevision: RECORDED_ARTIFACT_REVISION,
  receiptId: RECORDED_RECEIPT_ID,
});

/** The compact JSON text a successful publish returns (`artifactToolResult`). */
export const RECORDED_PUBLISH_ARTIFACT_RESULT_TEXT = JSON.stringify({
  schemaVersion: 1,
  ok: true,
  publicationId: RECORDED_PUBLICATION_ID,
  artifactId: RECORDED_ARTIFACT_ID,
  revision: RECORDED_ARTIFACT_REVISION,
  conversationSequence: 7,
  publishedAt: "2026-10-20T10:00:00.000Z",
  ref: {
    schemaVersion: 1,
    artifactId: RECORDED_ARTIFACT_ID,
    revision: RECORDED_ARTIFACT_REVISION,
    publicationId: RECORDED_PUBLICATION_ID,
    kind: "chart",
    title: "Illustrative test outcomes",
    summary: "Synthetic fixture chart.",
    provenance: { backendId: "backend-fixture", origin: "agent" },
  },
});

/** The same envelope for a refused publish (`errorResponse`, `isError: true`). */
export const RECORDED_PUBLISH_ARTIFACT_ERROR_TEXT = JSON.stringify({
  schemaVersion: 1,
  ok: false,
  error: {
    code: RECORDED_ARTIFACT_ERROR_CODE,
    message: "Revision 2 requires verification under the current render policy.",
    retryClass: "after-refresh",
    currentRevision: RECORDED_ARTIFACT_REVISION,
  },
});

/** An MCP `CallToolResult` as the Orkestrator server returns it. */
export function recordedArtifactCallToolResult(isError = false): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: true;
} {
  const text = isError
    ? RECORDED_PUBLISH_ARTIFACT_ERROR_TEXT
    : RECORDED_PUBLISH_ARTIFACT_RESULT_TEXT;
  return {
    content: [{ type: "text", text }],
    structuredContent: JSON.parse(text) as Record<string, unknown>,
    ...(isError ? { isError: true as const } : {}),
  };
}

/**
 * What the web client reads from a normalized tool part when placing a
 * published artifact (see `artifact-publication-merge.ts`). A part anchors a
 * publication only when `tool` is `"publish_artifact"`, `artifactId` is a
 * string, `expectedRevision` a number and `toolState` `"success"`. Accepts
 * any bridge's part type; only these fields are read.
 */
export function publishArtifactCallContract(part: object): {
  tool: string | null;
  artifactId: unknown;
  expectedRevision: unknown;
  toolState: unknown;
} {
  const fields = part as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" ? value : undefined);
  const args =
    fields.toolArgs && typeof fields.toolArgs === "object" && !Array.isArray(fields.toolArgs)
      ? (fields.toolArgs as Record<string, unknown>)
      : undefined;
  return {
    tool: orkestratorToolName(text(fields.toolName), ARTIFACT_TOOL_NAMES, {
      toolTitle: text(fields.toolTitle),
      mcpServerName: text(fields.mcpServerName),
    }),
    artifactId: args?.artifactId,
    expectedRevision: args?.expectedRevision,
    toolState: fields.toolState,
  };
}

/** The contract a successful recorded publish must satisfy. */
export const SUCCESSFUL_PUBLISH_CONTRACT = Object.freeze({
  tool: "publish_artifact",
  artifactId: RECORDED_ARTIFACT_ID,
  expectedRevision: RECORDED_ARTIFACT_REVISION,
  toolState: "success",
});
