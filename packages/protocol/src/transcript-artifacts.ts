/**
 * Transcript artifacts: durable, immutable, verified rich content published
 * into a conversation by Orkestrator's own agent tools.
 *
 * Four records stay distinct: an immutable source revision, an asynchronous
 * verification operation, an immutable successful receipt, and an immutable
 * transcript publication. A viewer's loading/ready/error state is none of
 * them. An artifact reference is a locator, never an authorization token and
 * never the executable body; readers resolve it with their own authenticated
 * scope. See docs/architecture/transcript-artifacts.md.
 */
import type { ChartSpecV1 } from "./chart-spec.js";
import type { FieldError } from "./field-validation.js";
import { ORKESTRATOR_MCP_SERVER_NAME } from "./agent-mail.js";
import type { WorkflowSnapshotV1 } from "./workflow-snapshot.js";

export const TRANSCRIPT_ARTIFACT_SCHEMA_VERSION = 1;

export const ARTIFACT_KINDS = [
  "html-static",
  "html-interactive",
  "mermaid",
  "chart",
  "workflow-snapshot",
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export function isArtifactKind(value: unknown): value is ArtifactKind {
  return typeof value === "string" && (ARTIFACT_KINDS as readonly string[]).includes(value);
}

export type ArtifactOrigin = "agent" | "user" | "workflow";

export type ArtifactProbeV1 =
  | { op: "click"; target: string }
  | { op: "set-number"; target: string; value: number }
  | { op: "fill"; target: string; text: string }
  | { op: "expect-text"; target: string; equals: string }
  | { op: "expect-number"; target: string; equals: number; tolerance?: number }
  | { op: "wait-visible"; target: string; timeoutMs?: number };

export type ArtifactPayload =
  | { kind: "html-static"; html: string }
  | {
      kind: "html-interactive";
      html: string;
      dependencyIds?: string[];
      probes?: ArtifactProbeV1[];
    }
  | { kind: "mermaid"; source: string }
  | { kind: "chart"; spec: ChartSpecV1 }
  | { kind: "workflow-snapshot"; snapshot: WorkflowSnapshotV1 };

/** What an agent may submit: workflow snapshots are requested, never authored. */
export type ArtifactDraftPayload =
  | Exclude<ArtifactPayload, { kind: "workflow-snapshot" }>
  | {
      kind: "workflow-snapshot";
      workflowId: string;
      runId: string;
      expectedWorkflowRevision?: string;
    };

export interface ArtifactDraft {
  title: string;
  summary: string;
  payload: ArtifactDraftPayload;
  assets?: Array<{ name: string; assetRef: string }>;
}

/** Backend-only: derived from authenticated bindings, never from caller input. */
export interface ArtifactOwner {
  backendId: string;
  environmentId: string;
  projectId: string;
  conversationKey: string;
}

export interface TranscriptArtifactRef {
  schemaVersion: 1;
  artifactId: string;
  /** Positive integer; names an immutable revision. */
  revision: number;
  publicationId: string;
  kind: ArtifactKind;
  title: string;
  summary: string;
  provenance: { backendId: string; origin: ArtifactOrigin };
}

export interface ArtifactAssetRecord {
  name: string;
  assetId: string;
  sha256: string;
  mimeType: string;
  byteLength: number;
}

export interface ArtifactRevisionRecord {
  schemaVersion: 1;
  artifactId: string;
  revision: number;
  owner: ArtifactOwner;
  title: string;
  summary: string;
  payload: ArtifactPayload;
  sourceHash: string;
  assetManifestHash: string;
  assets: ArtifactAssetRecord[];
  createdAt: string;
  createdBy: { origin: ArtifactOrigin; turnId?: string };
}

export interface ArtifactHeadRecord {
  schemaVersion: 1;
  artifactId: string;
  owner: ArtifactOwner;
  kind: ArtifactKind;
  currentRevision: number;
  publishedRevision: number | null;
  storageGeneration: number;
  createdAt: string;
  updatedAt: string;
}

export const ARTIFACT_OPERATION_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
] as const;
export type ArtifactOperationStatus = (typeof ARTIFACT_OPERATION_STATUSES)[number];

export function isTerminalArtifactOperationStatus(status: ArtifactOperationStatus): boolean {
  return status !== "queued" && status !== "running";
}

export interface ArtifactOutputRef {
  assetId: string;
  sha256: string;
  mimeType: string;
  byteLength: number;
}

export type ArtifactCapture = ArtifactOutputRef & {
  mimeType: "image/png";
  width: number;
  height: number;
};

export interface ArtifactProbeResultV1 {
  index: number;
  op: ArtifactProbeV1["op"];
  target: string;
  status: "passed" | "failed" | "skipped";
  observed?: string | number;
  errorCode?: string;
}

export interface ArtifactDiagnostic {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  /** Bounded location: a field path, line:column, or probe index. */
  location?: string;
}

export interface ArtifactPreviewProfile {
  theme: "light" | "dark";
  viewport: { width: number; height: number; deviceScaleFactor: 1 };
}

export interface ArtifactOperation {
  schemaVersion: 1;
  operationId: string;
  artifactId: string;
  revision: number;
  status: ArtifactOperationStatus;
  profile: ArtifactPreviewProfile | null;
  /** Present only on successful verification. */
  receiptId?: string;
  error?: ArtifactError;
  diagnostics: ArtifactDiagnostic[];
  omittedDiagnostics: number;
  /** Failed preview evidence; never a receipt. */
  diagnosticCaptures?: ArtifactCapture[];
  probeResults?: ArtifactProbeResultV1[];
  /** A committed cancellation request; a running job stays `running` until it really ends. */
  cancellationRequestedAt?: string;
  /** Explicit: a rendered result is never proof of semantic correctness. */
  semantics: "not-assessed" | "probes-passed" | "probes-failed";
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface ArtifactVerificationIdentity {
  artifactId: string;
  revision: number;
  kind: ArtifactKind;
  sourceHash: string;
  /** Sanitized or prepared product, or sourceHash when nothing is derived. */
  effectiveSourceHash: string;
  assetManifestHash: string;
  validatorVersion: string;
  rendererVersion: string;
  rendererBundleHash: string;
  dependencyManifestHash: string;
  sanitizerVersion: string;
  policyId: string;
  policyVersion: string;
  browserBuild: string;
  reducedMotion: "reduce" | "not-applicable";
  previewProfileVersion: string;
  probesHash: string;
  theme: "light" | "dark" | "not-applicable";
  themeTokensHash: string;
  fontManifestHash: string;
  locale: string;
  viewport: { width: number; height: number; deviceScaleFactor: 1 } | null;
}

export type ArtifactVerificationGate =
  | "schema"
  | "authoritative-source"
  | "syntax"
  | "bounded-render"
  | "supervised-visual";

export type ArtifactVerificationEvidence =
  | { kind: "html-static"; captures: ArtifactCapture[] }
  | { kind: "html-interactive"; captures: ArtifactCapture[]; probeResults: ArtifactProbeResultV1[] }
  | { kind: "mermaid"; rendererOutput: ArtifactOutputRef; captures?: ArtifactCapture[] }
  | { kind: "chart"; rendererOutput: ArtifactOutputRef; captures?: ArtifactCapture[] }
  | {
      kind: "workflow-snapshot";
      sourceSnapshot: {
        workflowId: string;
        runId: string;
        sourceRevision: string;
        snapshotHash: string;
        capturedAt: string;
      };
    };

export interface ArtifactVerificationReceipt {
  schemaVersion: 1;
  receiptId: string;
  operationId: string;
  artifactId: string;
  revision: number;
  kind: ArtifactKind;
  inputHash: string;
  identity: ArtifactVerificationIdentity;
  gates: Array<{ gate: ArtifactVerificationGate; result: "passed" }>;
  evidence: ArtifactVerificationEvidence;
  diagnosticsHash: string;
  completedAt: string;
}

/** Gates every successful receipt of a kind must carry. */
export const REQUIRED_ARTIFACT_GATES: Record<ArtifactKind, readonly ArtifactVerificationGate[]> = {
  "html-static": ["schema", "syntax", "supervised-visual"],
  "html-interactive": ["schema", "syntax", "supervised-visual"],
  mermaid: ["schema", "syntax", "bounded-render"],
  chart: ["schema", "bounded-render"],
  "workflow-snapshot": ["schema", "authoritative-source"],
};

export interface ArtifactPublication {
  schemaVersion: 1;
  publicationId: string;
  artifactId: string;
  revision: number;
  receiptId: string;
  owner: ArtifactOwner;
  conversationSequence: number;
  publishedAt: string;
  /** Provider correlation when known; either field may be absent. */
  anchor?: { turnId?: string; messageId?: string; toolCallId?: string };
  ref: TranscriptArtifactRef;
}

export const ARTIFACT_ERROR_CODES = [
  "invalid_input",
  "validation_failed",
  "revision_conflict",
  "idempotency_conflict",
  "preview_required",
  "preview_stale",
  "policy_denied",
  "renderer_unavailable",
  "render_timeout",
  "capacity_exceeded",
  "package_size_exceeded",
  "not_found",
  "expired",
  "cancelled",
  "interrupted",
  "storage_unavailable",
  "storage_corrupt",
  "unsupported_kind",
  "repair_budget_exhausted",
] as const;
export type ArtifactErrorCode = (typeof ARTIFACT_ERROR_CODES)[number];

export type ArtifactRetryClass = "never" | "after-edit" | "after-refresh" | "transient";

export interface ArtifactError {
  code: ArtifactErrorCode;
  message: string;
  retryClass: ArtifactRetryClass;
  operationId?: string;
  currentRevision?: number;
  fieldErrors?: FieldError[];
  /** Which bounded resource was exhausted, for capacity errors. */
  resource?: string;
  suggestion?: string;
}

export const DEFAULT_ARTIFACT_RETRY_CLASS: Record<ArtifactErrorCode, ArtifactRetryClass> = {
  invalid_input: "after-edit",
  validation_failed: "after-edit",
  revision_conflict: "after-refresh",
  idempotency_conflict: "never",
  preview_required: "after-refresh",
  preview_stale: "after-refresh",
  policy_denied: "after-edit",
  renderer_unavailable: "never",
  render_timeout: "after-edit",
  capacity_exceeded: "transient",
  package_size_exceeded: "after-edit",
  not_found: "never",
  expired: "never",
  cancelled: "never",
  interrupted: "after-refresh",
  storage_unavailable: "transient",
  storage_corrupt: "never",
  unsupported_kind: "never",
  repair_budget_exhausted: "never",
};

export function artifactError(
  code: ArtifactErrorCode,
  message: string,
  extra: Partial<Omit<ArtifactError, "code" | "message">> = {},
): ArtifactError {
  return {
    code,
    message: message.slice(0, 500),
    retryClass: extra.retryClass ?? DEFAULT_ARTIFACT_RETRY_CLASS[code],
    ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== "retryClass")),
  };
}

export class ArtifactFailure extends Error {
  constructor(readonly error: ArtifactError) {
    super(error.message);
    this.name = "ArtifactFailure";
  }
}

/** Ordinary agent tools. Kept in one list so bridges and tests agree. */
export const ARTIFACT_TOOL_NAMES = Object.freeze([
  "create_artifact",
  "update_artifact",
  "preview_artifact",
  "publish_artifact",
  "get_artifact",
  "get_artifact_operation",
  "cancel_artifact_operation",
] as const);
export type ArtifactToolName = (typeof ARTIFACT_TOOL_NAMES)[number];

/**
 * MCP server name of the artifact-only connection a backend workflow turn
 * (Multi Review reviewer, build-pipeline stage, feature planning) gets beside
 * its restricted workflow-result server. It serves the artifact tools only,
 * authenticated by that turn's artifact grant.
 */
export const ORKESTRATOR_ARTIFACT_MCP_SERVER_NAME = "orkestrator-artifacts";
/** Path of that server on the agent tool server (beside `/mcp`). */
export const ORKESTRATOR_ARTIFACT_MCP_PATH = "/artifact-mcp";

const ORKESTRATOR_TOOL_SERVERS: readonly string[] = [
  ORKESTRATOR_MCP_SERVER_NAME,
  ORKESTRATOR_ARTIFACT_MCP_SERVER_NAME,
];

/**
 * The Orkestrator tool a transcript tool call names, or null.
 *
 * Providers spell MCP tools differently (`mcp__orkestrator__x`,
 * `orkestrator__x`, `orkestrator_x`, bare `x` with an `orkestrator:x` title).
 * A bare name counts only when neither the title nor the reported MCP server
 * names a different server. Both Orkestrator servers count: the common
 * `orkestrator` server and the workflow turn's `orkestrator-artifacts` one.
 */
export function orkestratorToolName<T extends string>(
  toolName: string | undefined,
  tools: readonly T[],
  options: { toolTitle?: string; mcpServerName?: string } = {},
): T | null {
  const name = toolName?.trim();
  if (!name) return null;
  if (options.mcpServerName && !ORKESTRATOR_TOOL_SERVERS.includes(options.mcpServerName)) {
    return null;
  }
  for (const tool of tools) {
    if (name === tool) {
      const server = /^([\w-]+)\s*[:./]\s*[\w-]+$/.exec(options.toolTitle?.trim() ?? "")?.[1];
      return !server || ORKESTRATOR_TOOL_SERVERS.includes(server) ? tool : null;
    }
    for (const serverName of ORKESTRATOR_TOOL_SERVERS) {
      const qualified: string[] = [
        `mcp__${serverName}__${tool}`,
        ...["__", "_", ".", "/", ":"].map((separator) => `${serverName}${separator}${tool}`),
      ];
      if (qualified.includes(name)) return tool;
    }
  }
  return null;
}

/** What an artifact scope grant is replaced with wherever a transcript is projected. */
export const REDACTED_ARTIFACT_GRANT = "[redacted]";
/** Prefix of backend-minted artifact scope grants (`oag1.<id>.<signature>`). */
export const ARTIFACT_GRANT_PREFIX = "oag1.";

/**
 * Tool arguments with an artifact `scopeCapability` grant replaced by
 * {@link REDACTED_ARTIFACT_GRANT}, or undefined when nothing needs redacting.
 *
 * A shared provider registration (OpenCode) passes its per-turn grant as an
 * argument of the artifact tools, so the provider's transcript holds it. It is
 * a bearer credential: every Orkestrator projection, export and cached view
 * redacts it. Applies to canonical artifact tool calls, and to any argument
 * value shaped like a grant. Never mutates its input.
 */
export function redactArtifactGrantArgs(
  toolName: unknown,
  args: unknown,
  options: { toolTitle?: unknown; mcpServerName?: unknown } = {},
): Record<string, unknown> | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const record = args as Record<string, unknown>;
  if (!Object.hasOwn(record, "scopeCapability")) return undefined;
  const value = record.scopeCapability;
  if (value === REDACTED_ARTIFACT_GRANT) return undefined;
  const artifactTool =
    typeof toolName === "string" &&
    orkestratorToolName(toolName, ARTIFACT_TOOL_NAMES, {
      ...(typeof options.toolTitle === "string" ? { toolTitle: options.toolTitle } : {}),
      ...(typeof options.mcpServerName === "string"
        ? { mcpServerName: options.mcpServerName }
        : {}),
    }) !== null;
  const grantShaped = typeof value === "string" && value.startsWith(ARTIFACT_GRANT_PREFIX);
  if (!artifactTool && !grantShaped) return undefined;
  return { ...record, scopeCapability: REDACTED_ARTIFACT_GRANT };
}

/** Version identifiers bound into receipts. Bump with the code they describe. */
export const ARTIFACT_VERSIONS = {
  validator: "artifact-validator:v1",
  staticPolicyId: "html-static",
  staticPolicyVersion: "html-static-policy:v1",
  interactivePolicyId: "html-interactive",
  interactivePolicyVersion: "html-interactive-policy:v1",
  interactiveRuntime: "html-interactive-runtime:v1",
  staticSanitizer: "design-runtime-sanitizer:v1",
  mermaidRenderer: "mermaid-renderer:v1",
  mermaidSanitizer: "mermaid-svg-sanitizer:v1",
  workflowCollector: "workflow-snapshot-collector:v1",
  previewProfile: "preview-profile:v1",
  frameChannel: "artifact-frame-channel:v1",
} as const;

export const NOT_APPLICABLE = "not-applicable";

/** Logical asset names: bounded, no path separators, no traversal. */
export const ARTIFACT_ASSET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** Opaque identifiers minted by the backend. */
export const ARTIFACT_ID_PATTERN = /^(?:art|pub|op|rcpt|asset)_[A-Za-z0-9_-]{8,64}$/;

/** A filename derived independently from untrusted titles. */
export function safeArtifactFilename(title: string, extension: string): string {
  const base = title
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f"*/:<>?\\|]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+/, "")
    .trim()
    .slice(0, 80);
  const ext = extension.replace(/[^a-z0-9]/gi, "").slice(0, 8);
  return `${base || "artifact"}.${ext || "txt"}`;
}

/**
 * The transcript part a publication projects as. The backend emits it either
 * beside the publishing tool call or in a backend-attributed publication row
 * (`ARTIFACT_PUBLICATION_MESSAGE_PREFIX + publicationId`); clients de-duplicate
 * by `artifact.publicationId`. `content` is the textual summary used for copy
 * and search; it is never the artifact body.
 */
export interface TranscriptArtifactPartWire {
  type: "artifact";
  content: string;
  artifact: TranscriptArtifactRef;
  publishedAt: string;
  conversationSequence: number;
}

export const ARTIFACT_PUBLICATION_MESSAGE_PREFIX = "orkestrator-artifact:";

export function artifactPartContent(
  ref: Pick<TranscriptArtifactRef, "title" | "summary" | "kind" | "revision">,
): string {
  const summary = ref.summary ? ` — ${ref.summary}` : "";
  return `[Artifact: ${ref.title} (${ref.kind}, revision ${ref.revision})${summary}]`;
}
