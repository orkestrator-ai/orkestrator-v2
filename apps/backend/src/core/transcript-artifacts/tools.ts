/**
 * Ordinary agent tools for transcript artifacts, registered on the common
 * `orkestrator` MCP server (never on the restricted workflow-result servers).
 *
 * Input schemas stay shallow and portable (no $ref/$defs/recursion): deep
 * payloads such as chart specs are typed as open objects here and validated
 * authoritatively by the protocol validators, which return stable field paths.
 * Results are compact versioned JSON delivered as BOTH text content and
 * structured content, so adapters that flatten results keep every id. Errors
 * use the same envelope with `isError: true`. HTML bodies and base64 never
 * appear in JSON; an operation read may add one separate image block.
 * Top-level arguments are strict (unknown keys are rejected); an oversized
 * result is trimmed by `fitToolResult`, never turned into an error.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ARTIFACT_TOOL_POLICY, utf8ByteLength } from "@orkestrator/protocol/rich-content-policy";
import { ARTIFACT_KINDS, type ArtifactToolName } from "@orkestrator/protocol/transcript-artifacts";
import type { ArtifactCallerScope } from "./owner.js";
import { MAX_REQUEST_KEY_BYTES, type ArtifactResponse } from "./service-context.js";

export interface TranscriptArtifactToolHost {
  toolsEnabled(): boolean;
  handleTool(
    name: ArtifactToolName,
    scope: ArtifactCallerScope,
    args: Record<string, unknown>,
    meta?: { toolCallId?: string },
  ): Promise<ArtifactResponse>;
  /**
   * Scope of an artifact-only connection authenticated by a turn's artifact
   * grant (`/artifact-mcp`), or null when the grant does not verify.
   */
  authenticateArtifactGrant?(token: string): { environmentId: string; projectId: string } | null;
}

/** Concise guidance appended to the common server's instructions. */
export const ARTIFACT_TOOL_INSTRUCTIONS =
  " Artifacts: answer in Markdown by default (small code fences and Mermaid fences render inline; HTML code fences never execute). " +
  "Use an artifact only for durable, larger or interactive output: html-static (scripts are stripped), html-interactive (runs offline in an isolated viewer; declare probes to verify behaviour), mermaid, chart (declarative ChartSpecV1 data), or workflow-snapshot (facts come from the backend; pass workflowId and runId only). " +
  "Flow: create_artifact → preview_artifact → get_artifact_operation (inspect diagnostics/capture) → publish_artifact with the receipt. " +
  "Repair failures with update_artifact (full replacement, expectedRevision) and preview again; at most two repairs. " +
  "Every mutation takes a requestKey you reuse only to retry the same call. Pass scopeCapability when your instructions provide one.";

/**
 * Instructions of the artifact-only `orkestrator-artifacts` server a backend
 * workflow turn gets beside its result tools. Its connection is already bound
 * to this conversation and turn, so no scopeCapability is needed.
 */
export const ARTIFACT_ONLY_SERVER_INSTRUCTIONS =
  "Transcript artifact tools for this conversation; they never change the repository or your result." +
  ARTIFACT_TOOL_INSTRUCTIONS.replace(
    " Pass scopeCapability when your instructions provide one.",
    " This connection is already bound to this conversation; omit scopeCapability.",
  );

const requestKey = z
  .string()
  .min(1)
  .max(ARTIFACT_TOOL_POLICY.maxRequestKeyCharacters)
  .refine((value) => utf8ByteLength(value) <= MAX_REQUEST_KEY_BYTES, {
    message: `At most ${MAX_REQUEST_KEY_BYTES} bytes of UTF-8`,
  })
  .describe("Caller-generated idempotency key; reuse it only to retry this exact call.");
const scopeCapability = z
  .string()
  .max(1_024)
  .optional()
  .describe("Artifact scope capability from this turn's Orkestrator instructions, when provided.");
const artifactId = z.string().min(1).max(80);
const positiveInteger = z.number().int().min(1);

const payloadSchema = z
  .object({
    kind: z.enum(ARTIFACT_KINDS),
  })
  .loose()
  .describe(
    'html-static: {kind, html}. html-interactive: {kind, html, dependencyIds? (from "d3@7.9.0", "chart.js@4.5.1"; classic scripts read the globals d3/Chart, module scripts import "d3", "chart.js" or "chart.js/auto"), probes?}. ' +
      "probes: up to 20 of {op:'click',target} | {op:'set-number',target,value} | {op:'fill',target,text} | " +
      "{op:'expect-text',target,equals} | {op:'expect-number',target,equals,tolerance?} | {op:'wait-visible',target,timeoutMs?}; " +
      "target is the value of a unique data-artifact-test attribute. mermaid: {kind, source}. " +
      "chart: {kind, spec} where spec = {schemaVersion:1, kind:'bar'|'line'|'area'|'scatter'|'donut', title, description, sourceNotes?, ...}; " +
      "bar adds xAxis:{kind:'category',label}, yAxis:{label,unit?}, categories:[{id,label}], series:[{id,label,points:[{categoryId,value|null}]}] (one point per category); " +
      "line/area/scatter add xAxis:{kind:'number'|'utc-time',label,unit?}, yAxis, series:[{id,label,points:[{x,y|null}]}]; donut adds valueLabel, unit?, slices:[{id,label,value}]. " +
      "workflow-snapshot: {kind, workflowId: multi-review|build-pipeline, runId, expectedWorkflowRevision?}.",
  );

const draftSchema = z
  .object({
    title: z.string().describe("At most 120 characters."),
    summary: z.string().describe("Plain-language summary, at most 400 characters."),
    payload: payloadSchema,
    assets: z
      .array(z.object({ name: z.string(), assetRef: z.string() }).loose())
      .max(32)
      .optional()
      .describe(
        "HTML only: {name, assetRef}. assetRef is a staged upload id (stg-…) the user attached to this conversation. Never a path or URL.",
      ),
  })
  .loose();

const profileSchema = z
  .object({
    theme: z.enum(["light", "dark"]),
    viewport: z.object({
      width: z.number().int(),
      height: z.number().int(),
      deviceScaleFactor: z.literal(1),
    }),
  })
  .optional()
  .describe("Defaults to light, 960×640, scale 1.");

const MUTATION = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** Fields a truncated result always keeps: identity, status and the error envelope. */
const KEPT_RESULT_FIELDS = new Set([
  "schemaVersion",
  "ok",
  "error",
  "replayed",
  "artifactId",
  "revision",
  "kind",
  "operationId",
  "publicationId",
  "receiptId",
  "status",
  "operation",
  "conversationSequence",
  "next",
  "visualInspection",
  "imageDelivery",
  "image",
]);

/**
 * Fits a result into the 16 KiB tool budget without misreporting it: the
 * largest optional top-level fields are dropped (largest first) and named in
 * `omittedFields` with `truncated: true`. The call itself already happened
 * (it may have committed), so an oversized success stays a success; the
 * omitted detail can be re-read with get_artifact / get_artifact_operation.
 */
export function fitToolResult(value: Record<string, unknown>): Record<string, unknown> {
  const budget = ARTIFACT_TOOL_POLICY.maxResultBytes;
  if (utf8ByteLength(JSON.stringify(value)) <= budget) return value;
  const optional = Object.keys(value)
    .filter((field) => !KEPT_RESULT_FIELDS.has(field))
    .map((field) => ({ field, bytes: utf8ByteLength(JSON.stringify(value[field]) ?? "") }))
    .sort((a, b) => b.bytes - a.bytes);
  const fitted: Record<string, unknown> = { ...value, truncated: true, omittedFields: [] };
  const omitted: string[] = [];
  for (const { field } of optional) {
    delete fitted[field];
    omitted.push(field);
    fitted.omittedFields = omitted;
    if (utf8ByteLength(JSON.stringify(fitted)) <= budget) return fitted;
  }
  // Only kept fields remain and they still do not fit: keep bare identity.
  const minimal: Record<string, unknown> = { truncated: true, omittedFields: Object.keys(value) };
  for (const field of [
    "schemaVersion",
    "ok",
    "artifactId",
    "revision",
    "operationId",
    "publicationId",
    "receiptId",
    "status",
  ]) {
    const entry = value[field];
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean")
      minimal[field] = typeof entry === "string" ? entry.slice(0, 200) : entry;
  }
  return minimal;
}

/** MCP tool result: the same JSON as text and structured content; optional image block. */
export function artifactToolResult(response: ArtifactResponse) {
  const value = fitToolResult(response.value);
  const text = JSON.stringify(value);
  const content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  > = [{ type: "text", text }];
  if (response.image)
    content.push({ type: "image", data: response.image.data, mimeType: response.image.mimeType });
  return {
    content,
    structuredContent: value,
    ...(response.isError ? { isError: true } : {}),
  };
}

function toolCallId(ctx: unknown): string | undefined {
  const meta = (ctx as { mcpReq?: { _meta?: Record<string, unknown> } } | undefined)?.mcpReq?._meta;
  const value = meta?.["claudecode/toolUseId"] ?? meta?.toolCallId;
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : undefined;
}

export function registerTranscriptArtifactTools(
  server: McpServer,
  host: TranscriptArtifactToolHost,
  scope: ArtifactCallerScope,
  options: {
    /**
     * The artifact grant that authenticated this connection (`/artifact-mcp`).
     * Every call is authorized with it, whatever `scopeCapability` the model
     * passed: the connection, not the model, names the conversation.
     */
    boundGrant?: string;
  } = {},
): void {
  const callerScope: ArtifactCallerScope = {
    environmentId: scope.environmentId,
    projectId: scope.projectId,
    ...(scope.tabId ? { tabId: scope.tabId } : {}),
    ...(scope.workflowResultKey ? { workflowResultKey: scope.workflowResultKey } : {}),
    ...(scope.workflowResultBroker ? { workflowResultBroker: true } : {}),
  };
  const run = async (name: ArtifactToolName, args: Record<string, unknown>, ctx: unknown) =>
    artifactToolResult(
      await host.handleTool(
        name,
        callerScope,
        options.boundGrant ? { ...args, scopeCapability: options.boundGrant } : args,
        { toolCallId: toolCallId(ctx) },
      ),
    );

  server.registerTool(
    "create_artifact",
    {
      title: "Create a transcript artifact",
      description:
        "Create a draft artifact (revision 1). Validates the draft and stores it; does not publish. Returns artifactId and revision. Next: preview_artifact.",
      inputSchema: z.object({ requestKey, draft: draftSchema, scopeCapability }).strict(),
      annotations: MUTATION,
    },
    async (args, ctx) => run("create_artifact", args as Record<string, unknown>, ctx),
  );

  server.registerTool(
    "update_artifact",
    {
      title: "Update a transcript artifact",
      description:
        "Replace the whole draft as revision expectedRevision + 1 (compare-and-swap; kind is fixed). Older revisions never change. Use this to repair a failed preview.",
      inputSchema: z
        .object({
          requestKey,
          artifactId,
          expectedRevision: positiveInteger,
          draft: draftSchema,
          scopeCapability,
        })
        .strict(),
      annotations: MUTATION,
    },
    async (args, ctx) => run("update_artifact", args as Record<string, unknown>, ctx),
  );

  server.registerTool(
    "preview_artifact",
    {
      title: "Verify a transcript artifact revision",
      description:
        "Start asynchronous verification of one exact revision and return its operationId immediately. Poll get_artifact_operation; a successful operation carries the receiptId publish_artifact needs.",
      inputSchema: z
        .object({
          requestKey,
          artifactId,
          revision: positiveInteger,
          profile: profileSchema,
          scopeCapability,
        })
        .strict(),
      annotations: MUTATION,
    },
    async (args, ctx) => run("preview_artifact", args as Record<string, unknown>, ctx),
  );

  server.registerTool(
    "publish_artifact",
    {
      title: "Publish a transcript artifact",
      description:
        "Publish exactly expectedRevision (it must be the current head) into this conversation using a successful receipt for that revision. Returns the durable reference. Retrying returns the same publication.",
      inputSchema: z
        .object({
          requestKey,
          artifactId,
          expectedRevision: positiveInteger,
          receiptId: z.string().min(1).max(80),
          scopeCapability,
        })
        .strict(),
      annotations: MUTATION,
    },
    async (args, ctx) => run("publish_artifact", args as Record<string, unknown>, ctx),
  );

  server.registerTool(
    "get_artifact",
    {
      title: "Read a transcript artifact",
      description:
        "Read artifact metadata (default) and optionally a bounded UTF-8 source slice: sourceRange {offsetBytes, limitBytes ≤ 8192}; continue with nextOffsetBytes until it is null.",
      inputSchema: z
        .object({
          artifactId,
          revision: positiveInteger.optional(),
          sourceRange: z
            .object({
              offsetBytes: z.number().int().min(0),
              limitBytes: z.number().int().min(1).max(ARTIFACT_TOOL_POLICY.maxSourceSliceBytes),
            })
            .optional(),
          scopeCapability,
        })
        .strict(),
      annotations: READ,
    },
    async (args, ctx) => run("get_artifact", args as Record<string, unknown>, ctx),
  );

  server.registerTool(
    "get_artifact_operation",
    {
      title: "Read a verification operation",
      description:
        "Read-only status of a preview operation: status, bounded diagnostics, probe results and evidence references. includePreviewImage adds one capture image (captureIndex, default 0); seeing it is not an assessment.",
      inputSchema: z
        .object({
          operationId: z.string().min(1).max(80),
          includePreviewImage: z.boolean().optional(),
          captureIndex: z.number().int().min(0).optional(),
          scopeCapability,
        })
        .strict(),
      annotations: READ,
    },
    async (args, ctx) => run("get_artifact_operation", args as Record<string, unknown>, ctx),
  );

  server.registerTool(
    "cancel_artifact_operation",
    {
      title: "Cancel a verification operation",
      description:
        "Request cancellation of a queued or running preview. Returns the actual status; a completed operation stays completed. Never affects publications.",
      inputSchema: z
        .object({
          requestKey,
          operationId: z.string().min(1).max(80),
          scopeCapability,
        })
        .strict(),
      annotations: MUTATION,
    },
    async (args, ctx) => run("cancel_artifact_operation", args as Record<string, unknown>, ctx),
  );
}
