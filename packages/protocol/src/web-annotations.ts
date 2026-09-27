/**
 * Web page annotations: durable, backend-owned feedback attached to part of a
 * preview page, discussed with one explicitly chosen agent session and
 * resolved only by a human.
 *
 * The contract separates four things that the legacy flow conflated:
 *
 * - trusted human intent (`host-user` entries typed in Orkestrator's own UI),
 * - untrusted page evidence (DOM, text, attributes, screenshots),
 * - execution uncertainty (request lifecycle, including `unconfirmed`), and
 * - human acceptance (a resolution record naming the exact revisions accepted).
 *
 * Renderer stores are projections of these records. The pane layout carries
 * only identifiers and view preferences.
 */
import type { AgentInteractionKind, AgentInteractionState } from "./agent-interactions.js";
import type { AgentPlatform } from "./agent-platforms.js";

export const WEB_ANNOTATION_CONTRACT_VERSION = 1 as const;
export const WEB_ANNOTATION_SCHEMA_VERSION = 1 as const;
export const WEB_ANNOTATIONS_CHANGED_EVENT = "web-annotations-changed";
// Stable failure prefixes and the typed error trailer (see the errors module).
export {
  WEB_ANNOTATION_CAPACITY,
  WEB_ANNOTATION_CAPACITY_RESOURCES,
  WEB_ANNOTATION_CONFLICT,
  WEB_ANNOTATION_DEGRADED,
  WEB_ANNOTATION_ERROR_CODES,
  WEB_ANNOTATION_UNAVAILABLE,
  formatWebAnnotationError,
  parseWebAnnotationError,
  stripWebAnnotationErrorTrailer,
  type WebAnnotationCapacityResource,
  type WebAnnotationErrorCode,
  type WebAnnotationErrorDetail,
} from "./web-annotations-errors.js";
export {
  DEFAULT_WEB_ANNOTATION_ROLLOUT_MODE,
  WEB_ANNOTATION_METRIC_BUCKETS_MS,
  WEB_ANNOTATION_ROLLOUT_ENV,
  WEB_ANNOTATION_ROLLOUT_MODES,
  isWebAnnotationRolloutMode,
  normalizeWebAnnotationRolloutSettings,
  parseWebAnnotationRolloutOverride,
  type WebAnnotationDurationSummary,
  type WebAnnotationMetricsSnapshot,
  type WebAnnotationRolloutMode,
  type WebAnnotationRolloutSettings,
  type WebAnnotationRolloutSnapshot,
} from "./web-annotations-operations.js";
import type {
  WebAnnotationMetricsSnapshot,
  WebAnnotationRolloutMode,
  WebAnnotationRolloutSnapshot,
} from "./web-annotations-operations.js";
/** App-generated workspace directory for materialized evidence. */
export const WEB_ANNOTATION_WORKSPACE_DIRECTORY = ".orkestrator/annotations";

const KiB = 1024;
const MiB = 1024 * KiB;

/**
 * Release defaults, not measurements of existing usage. Both character counts
 * and serialized UTF-8 bytes are enforced. Smaller transport ceilings win and
 * surface as an explicit capacity error.
 */
export const WEB_ANNOTATION_LIMITS = Object.freeze({
  idChars: 200,
  titleChars: 200,
  entryChars: 8_000,
  instructionChars: 8_000,
  desiredOutcomeChars: 2_000,
  captureMetadataBytes: 64 * KiB,
  imageBytes: 8 * MiB,
  imageMaxDimension: 2_000,
  referenceTextChars: 12_000,
  briefBytes: 64 * KiB,
  briefAnnotations: 20,
  briefAttachments: 20,
  briefAttachmentBytes: 16 * MiB,
  listPageItems: 50,
  listPageBytes: 256 * KiB,
  entryPageBytes: 512 * KiB,
  entryPageItems: 50,
  threadEntries: 500,
  threadTextBytes: 2 * MiB,
  environmentAnnotations: 2_000,
  environmentRequests: 5_000,
  environmentMetadataBytes: 32 * MiB,
  environmentImageBytes: 512 * MiB,
  queuedMutations: 32,
  simultaneousPreparations: 4,
  pendingCapturesPerPreview: 4,
  pendingCapturesPerProcess: 16,
  pendingCaptureBytes: 64 * MiB,
  hintRingEntries: 256,
  hintRingBytes: 256 * KiB,
  hintEnvironments: 64,
  hintIdsPerChange: 32,
  operationReceipts: 512,
  resultSummaryChars: 8_000,
  resultFiles: 200,
  resultChecks: 50,
  resultRevisions: 20,
  responseExcerptChars: 4_000,
  anchorCandidates: 8,
  anchorTextChars: 300,
  visiblePins: 50,
  redactionRegions: 32,
  requestRecoveryBatch: 25,
  preparationTtlMs: 15 * 60 * 1000,
  pendingCaptureTtlMs: 24 * 60 * 60 * 1000,
  assetGcGraceMs: 24 * 60 * 60 * 1000,
  stagingGraceMs: 60 * 60 * 1000,
  reconcileIntervalMs: 3_000,
});

export type WebAnnotationLimits = typeof WEB_ANNOTATION_LIMITS;

// ---------------------------------------------------------------------------
// Identity and page

/**
 * A logical page identity that survives gateway restarts and origin changes.
 * The transport URL a desktop happened to use is never part of it.
 */
export type WebAnnotationServiceIdentity =
  | { kind: "service"; serviceId: string }
  | { kind: "port"; port: number }
  | { kind: "unknown" };

export interface WebAnnotationPageIdentity {
  service: WebAnnotationServiceIdentity;
  /** Sanitized app-relative path, meaningful query, and hash. Starts with `/`. */
  route: string;
  /** Sanitized human-readable URL. Display only; never navigated to directly. */
  displayUrl: string;
  title: string;
  /**
   * True when sanitization removed information (a token-like query value, a
   * credential) so an exact route cannot be reconstructed. The UI asks the
   * user to navigate rather than inventing a match.
   */
  requiresNavigation: boolean;
}

/** Stable comparison key for "current page" filters. */
export function webAnnotationPageKey(page: Pick<WebAnnotationPageIdentity, "service" | "route">) {
  const service =
    page.service.kind === "service"
      ? `service:${page.service.serviceId}`
      : page.service.kind === "port"
        ? `port:${page.service.port}`
        : "unknown";
  const route = page.route.split("#", 1)[0] ?? page.route;
  return `${service}${route}`;
}

// ---------------------------------------------------------------------------
// Targets and anchors

export const WEB_ANNOTATION_TARGET_KINDS = Object.freeze([
  "element",
  "text-range",
  "region",
  "page",
  "legacy-unresolved",
] as const);
export type WebAnnotationTargetKind = (typeof WEB_ANNOTATION_TARGET_KINDS)[number];

/**
 * Kinds a client may submit in a capture. `legacy-unresolved` is produced only
 * by migration: it stays readable but is never advertised as capturable.
 */
export const WEB_ANNOTATION_SUBMITTABLE_TARGET_KINDS = Object.freeze([
  "element",
  "text-range",
  "region",
  "page",
] as const satisfies readonly WebAnnotationTargetKind[]);

/** CSS pixels relative to the layout viewport at capture time. */
export interface WebAnnotationRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WebAnnotationTextQuote {
  exact: string;
  prefix: string;
  suffix: string;
}

export interface WebAnnotationAncestorDescriptor {
  tagName: string;
  id: string | null;
  role: string | null;
  testId: string | null;
  name: string | null;
}

export type WebAnnotationAnchorScope =
  | { kind: "document" }
  | { kind: "unsupported"; reason: "iframe" | "shadow-root" | "closed-root" | "cross-origin" };

/**
 * Descriptions, never live handles. Every candidate is optional corroborating
 * evidence; geometry alone never establishes DOM identity.
 */
export interface WebAnnotationAnchor {
  /** Present only when unique within its document when captured. */
  stableId?: { kind: "id" | "test-id"; value: string };
  semantic: { tagName: string; role: string | null; name: string | null };
  text: WebAnnotationTextQuote | null;
  ancestors: WebAnnotationAncestorDescriptor[];
  cssPath: string;
  scope: WebAnnotationAnchorScope;
}

export interface WebAnnotationElementTarget {
  kind: "element";
  /** Short human label, e.g. `button “Save”`. Never a raw selector. */
  label: string;
  anchor: WebAnnotationAnchor;
  rect: WebAnnotationRect;
}

export interface WebAnnotationTextRangeTarget {
  kind: "text-range";
  label: string;
  quote: WebAnnotationTextQuote;
  /** Anchor of the nearest containing element. */
  container: WebAnnotationAnchor;
  rect: WebAnnotationRect;
  rects: WebAnnotationRect[];
}

export interface WebAnnotationRegionTarget {
  kind: "region";
  label: string;
  /** CSS pixels. */
  rect: WebAnnotationRect;
  /** Pixels of the stored image; derived through the capture's image transform. */
  imageRect: WebAnnotationRect | null;
  /** Visual evidence only: no inferred DOM identity or source file. */
  parentCaptureId?: string;
}

export interface WebAnnotationPageTarget {
  kind: "page";
  label: string;
}

/** Imported from a legacy chat draft. Never parsed into a selector. */
export interface WebAnnotationLegacyTarget {
  kind: "legacy-unresolved";
  label: string;
  referenceText: string;
}

export type WebAnnotationTarget =
  | WebAnnotationElementTarget
  | WebAnnotationTextRangeTarget
  | WebAnnotationRegionTarget
  | WebAnnotationPageTarget
  | WebAnnotationLegacyTarget;

export type WebAnnotationAnchorState =
  | "matched"
  | "missing"
  | "ambiguous"
  | "stale"
  | "unsupported"
  /** The resolver hit its traversal budget or deadline; distinct from unsupported scope. */
  | "too-complex";

export type WebAnnotationAnchorRule =
  | "route-mismatch"
  | "stable-id"
  | "semantic-context"
  | "structural-path"
  | "text-quote"
  | "none";

/** Explainable resolver result. No numeric confidence score. */
export interface WebAnnotationAnchorResolution {
  state: WebAnnotationAnchorState;
  rule: WebAnnotationAnchorRule;
  candidateCount: number;
  documentGeneration: number | null;
  rect: WebAnnotationRect | null;
  offPage?: boolean;
  /**
   * Region notes are tied to captured pixels. Set when the layout, viewport,
   * or document changed since capture: the note is historical evidence and
   * should offer recapture instead of being placed on new pixels.
   */
  historical?: boolean;
}

/**
 * Optional development source hint. Candidate location only: verified for
 * containment separately and never treated as a filesystem authority.
 */
export interface WebAnnotationSourceHint {
  producer: string;
  path: string;
  line?: number;
  component?: string;
  verified: boolean;
}

// ---------------------------------------------------------------------------
// Captures

export interface WebAnnotationGeometry {
  viewport: { width: number; height: number };
  scroll: { x: number; y: number };
  zoomFactor: number;
  devicePixelRatio: number;
  /** Stored image size and CSS→image scale after any downscale. */
  image: { width: number; height: number; scale: number; reduced: boolean } | null;
}

/** Bounded, sanitized page evidence. Always untrusted. */
export interface WebAnnotationPageEvidence {
  text: string;
  attributes: Record<string, string>;
  styles: Record<string, string>;
  hierarchy: WebAnnotationAncestorDescriptor[];
  /** Sanitized structural HTML; values and event handlers removed. */
  html: string;
  sourceHints?: WebAnnotationSourceHint[];
}

export interface WebAnnotationRedactionSummary {
  attributesRemoved: number;
  valuesMasked: number;
  urlParametersRemoved: number;
  sensitiveRegionsMasked: number;
  manualRegions: number;
  imageExcluded: boolean;
}

export const EMPTY_WEB_ANNOTATION_REDACTION: WebAnnotationRedactionSummary = Object.freeze({
  attributesRemoved: 0,
  valuesMasked: 0,
  urlParametersRemoved: 0,
  sensitiveRegionsMasked: 0,
  manualRegions: 0,
  imageExcluded: false,
});

export type WebAnnotationCaptureState = "complete" | "stale" | "missing";
export type WebAnnotationCaptureProducer =
  | "desktop-native"
  | "legacy-import"
  | "text-only"
  | "result-capture";

export interface WebAnnotationCapture {
  id: string;
  annotationId: string;
  schemaVersion: typeof WEB_ANNOTATION_SCHEMA_VERSION;
  /** Monotonic per annotation; immutable once committed. */
  revision: number;
  producer: WebAnnotationCaptureProducer;
  capturedAt: string;
  documentGeneration: number | null;
  page: WebAnnotationPageIdentity;
  target: WebAnnotationTarget;
  geometry: WebAnnotationGeometry | null;
  evidence: WebAnnotationPageEvidence | null;
  assetIds: string[];
  redaction: WebAnnotationRedactionSummary;
  state: WebAnnotationCaptureState;
  stateReason?: string;
  /** Present on after-captures taken for review of a request result. */
  resultOf?: { requestId: string; resultId?: string };
  /** Comparison metadata recorded with a result (after) capture. */
  comparison?: WebAnnotationComparisonMetadata;
}

/** Whether the page had settled when an after-capture was taken. */
export type WebAnnotationCaptureStability = "stable" | "unstable";

/** One redaction applied to an after-capture image; `rect` is in document CSS pixels. */
export interface WebAnnotationResultCaptureMask {
  source: "sensitive-field" | "manual";
  rect: WebAnnotationRect;
}

/**
 * Optional desktop-supplied metadata for a result (after) capture. Every field
 * is optional so older clients keep working; the backend validates bounds.
 * `masks` are the redactions applied to the after-image (the same masking the
 * original capture used), kept with the comparison so it never resurrects a
 * redacted region.
 */
export interface WebAnnotationResultCaptureMetadata {
  zoomFactor?: number;
  deviceScaleFactor?: number;
  scroll?: { x: number; y: number };
  stability?: WebAnnotationCaptureStability;
  masks?: WebAnnotationResultCaptureMask[];
  /** Anchor resolution of the original target on the current page, if run. */
  targetResolution?: WebAnnotationAnchorResolution;
}

/** How an after-capture relates to the evidence it is compared with. */
export type WebAnnotationComparisonDifference =
  | "route"
  | "service"
  | "viewport"
  | "zoom"
  | "device-scale"
  | "target"
  | "unstable";

export interface WebAnnotationComparisonMetadata extends WebAnnotationResultCaptureMetadata {
  /** Annotation content/capture revisions current when the after-capture was taken. */
  contentRevision: number;
  captureRevision: number;
  /** The original (before) capture compared against. */
  comparedCaptureId: string;
  /** `same-target` when the after-capture's target identity matches the original. */
  targetMatch: "same-target" | "different-target" | "no-target";
  /** Labelled mismatches; empty when route, viewport and target all match. */
  differences: WebAnnotationComparisonDifference[];
}

/** What a client submits; the backend assigns ids, revision, and provenance. */
export interface WebAnnotationCaptureInput {
  producer: Exclude<WebAnnotationCaptureProducer, "legacy-import">;
  capturedAt: string;
  documentGeneration: number | null;
  page: WebAnnotationPageIdentity;
  target: Exclude<WebAnnotationTarget, WebAnnotationLegacyTarget>;
  geometry: WebAnnotationGeometry | null;
  evidence: WebAnnotationPageEvidence | null;
  assetIds: string[];
  redaction: WebAnnotationRedactionSummary;
  stale?: { reason: string };
  /** Member of a responsive capture set (one intent, separately captured widths). */
  responsive?: WebAnnotationResponsiveMember;
}

/**
 * One image of a responsive capture set. Each member records its own viewport,
 * route, time, and document generation; members were not captured simultaneously.
 */
export interface WebAnnotationResponsiveMember {
  setId: string;
  /** Zero-based position in the set, ordered by width. */
  index: number;
  count: number;
  /** Requested emulated viewport width in CSS pixels. */
  viewportWidth: number;
}

// ---------------------------------------------------------------------------
// Discussion

/**
 * Assigned by the receiving boundary. An untrusted payload can never declare
 * itself `host-user`.
 */
export const WEB_ANNOTATION_PROVENANCES = Object.freeze([
  "host-user",
  "legacy-page-comment",
  "page-evidence",
  "agent-reference",
  "system",
] as const);
export type WebAnnotationProvenance = (typeof WEB_ANNOTATION_PROVENANCES)[number];

export type WebAnnotationEntryKind =
  | "comment"
  | "legacy-comment"
  | "agent-response"
  | "result"
  | "lifecycle";

export type WebAnnotationLifecycleEvent =
  | "created"
  | "capture-replaced"
  | "request-sent"
  | "request-settled"
  | "resolved"
  | "reopened"
  | "imported"
  | "archived";

export interface WebAnnotationTranscriptRef {
  requestId: string;
  agent: AgentPlatform;
  tabId: string;
  logicalSessionKey: string;
  messageId?: string;
  turnId?: string;
}

export interface WebAnnotationEntry {
  id: string;
  annotationId: string;
  sequence: number;
  provenance: WebAnnotationProvenance;
  kind: WebAnnotationEntryKind;
  /** Null for lifecycle markers and pure transcript references. */
  body: string | null;
  transcript?: WebAnnotationTranscriptRef;
  lifecycle?: {
    event: WebAnnotationLifecycleEvent;
    requestId?: string;
    state?: string;
    /**
     * `archived`: the continuation thread. `created` on a continuation: the
     * archived thread it continues.
     */
    relatedAnnotationId?: string;
  };
  contentRevision: number;
  captureId: string | null;
  createdAt: string;
  supersedes?: string;
  /** Projection only: set when a later edit superseded this entry. */
  supersededBy?: string;
  /** Legacy import: the draft copies this variant came from (count only). */
  legacyVariantCount?: number;
}

// ---------------------------------------------------------------------------
// Annotation

export type WebAnnotationState = "open" | "resolved" | "deleted";

export interface WebAnnotationDestination {
  agent: AgentPlatform;
  /** Backend tab identity; distinct from any provider session id. */
  tabId: string;
  logicalSessionKey: string;
  label?: string;
}

export interface WebAnnotationResolution {
  acceptedBy: "host-user";
  acceptedAt: string;
  contentRevision: number;
  captureId: string;
  captureRevision: number;
  requestId?: string;
  resultId?: string;
  resultRevision?: number;
  note?: string;
}

export interface WebAnnotation {
  id: string;
  environmentId: string;
  schemaVersion: typeof WEB_ANNOTATION_SCHEMA_VERSION;
  /** Advances on any change, including execution progress. */
  metadataRevision: number;
  /** Advances only on human-meaningful content: entries, captures, title. */
  contentRevision: number;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  page: WebAnnotationPageIdentity;
  currentCaptureId: string;
  captureRevision: number;
  title: string;
  targetKind: WebAnnotationTargetKind;
  targetLabel: string;
  state: WebAnnotationState;
  hidden: boolean;
  defaultDestination: WebAnnotationDestination | null;
  resolution: WebAnnotationResolution | null;
  /** Active implementation reservation, if any. */
  activeRequestId: string | null;
  requestIds: string[];
  entryCount: number;
  entryBytes: number;
  lastSequence: number;
  /** Excerpt of the latest published host instruction; never page text. */
  latestIntent: string | null;
  thumbnailAssetId: string | null;
  imported: boolean;
  /** Set when a record this annotation references could not be read. */
  unavailable?: string;
  /**
   * Set when the thread was archived (read-only history). Archived threads are
   * excluded from default lists and stay readable/pageable through
   * `web_annotation_get` and `web_annotation_entries`.
   */
  archivedAt?: string | null;
  /** The continuation thread created when this one was archived. */
  continuationId?: string | null;
  /** The archived thread this one continues. */
  continuedFromId?: string | null;
}

export type WebAnnotationSummary = WebAnnotation & {
  activeRequest: Pick<
    WebAnnotationRequest,
    "id" | "state" | "operation" | "blockedReason" | "destination"
  > | null;
};

// ---------------------------------------------------------------------------
// Drafts

export interface WebAnnotationDraft {
  id: string;
  environmentId: string;
  /** Opaque per-editor identity, e.g. a client id + annotation id. */
  editorId: string;
  revision: number;
  annotationId: string | null;
  captureId: string | null;
  pendingCaptureId: string | null;
  text: string;
  operation: WebAnnotationRequestOperation | null;
  destination: WebAnnotationDestination | null;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Requests

export type WebAnnotationRequestOperation = "discuss" | "implement";

export const WEB_ANNOTATION_REQUEST_STATES = Object.freeze([
  "prepared",
  "queued",
  "dispatching",
  "unconfirmed",
  "running",
  "needs-input",
  "cancelling",
  "completed",
  "awaiting-review",
  "failed",
  "cancelled",
  "abandoned-unconfirmed",
] as const);
export type WebAnnotationRequestState = (typeof WEB_ANNOTATION_REQUEST_STATES)[number];

export type WebAnnotationBlockedReason =
  | "compose-draft"
  | "environment-stopped"
  | "destination-unavailable"
  | "queue-parked"
  | "capacity"
  | "agent-busy"
  /** The native queue rejected this request and is parked on it for the user. */
  | "dispatch-rejected";

export const WEB_ANNOTATION_TERMINAL_REQUEST_STATES: ReadonlySet<WebAnnotationRequestState> =
  new Set(["completed", "awaiting-review", "failed", "cancelled", "abandoned-unconfirmed"]);

/** States in which the request may still execute or has not been settled. */
export function isWebAnnotationRequestActive(state: WebAnnotationRequestState): boolean {
  return !WEB_ANNOTATION_TERMINAL_REQUEST_STATES.has(state);
}

/**
 * Allowed transitions. Identity (`from === to`) is always accepted so repeated
 * or out-of-order updates are idempotent; anything else returns false and the
 * caller reconciles instead of regressing.
 *
 * Native state is observed by polling, so a request can move forward past
 * states that were never observed (a turn can be claimed, dispatched, and
 * finished between two passes). Forward skips out of `queued`/`dispatching`
 * are therefore allowed; the step 01 plan justifies each one. A `prepared`
 * request only ever leaves through its own publication (`queued`) or a
 * pre-publication cancel/failure.
 */
export const WEB_ANNOTATION_REQUEST_TRANSITIONS: Readonly<
  Record<WebAnnotationRequestState, readonly WebAnnotationRequestState[]>
> = Object.freeze({
  prepared: ["queued", "cancelled", "failed"],
  queued: [
    "dispatching",
    "running",
    "unconfirmed",
    "needs-input",
    "completed",
    "awaiting-review",
    "failed",
    "cancelled",
  ],
  dispatching: [
    "running",
    "unconfirmed",
    "needs-input",
    "completed",
    "awaiting-review",
    "failed",
    "cancelled",
    "queued",
  ],
  unconfirmed: [
    "running",
    "needs-input",
    "completed",
    "awaiting-review",
    "failed",
    "abandoned-unconfirmed",
    "dispatching",
  ],
  running: ["needs-input", "completed", "awaiting-review", "failed", "cancelling", "cancelled"],
  "needs-input": ["running", "cancelling", "completed", "awaiting-review", "failed", "cancelled"],
  cancelling: ["cancelled", "failed", "completed", "awaiting-review", "running"],
  completed: [],
  "awaiting-review": [],
  failed: [],
  cancelled: [],
  "abandoned-unconfirmed": [],
});

export function canTransitionWebAnnotationRequest(
  from: WebAnnotationRequestState,
  to: WebAnnotationRequestState,
): boolean {
  return from === to || WEB_ANNOTATION_REQUEST_TRANSITIONS[from].includes(to);
}

export interface WebAnnotationRequestSelection {
  annotationId: string;
  /** 1-based display order; stable ids remain the correlation key. */
  reference: number;
  contentRevision: number;
  captureId: string;
  captureRevision: number;
  entryIds: string[];
  desiredOutcome: string | null;
  /** The user deliberately sent stale / legacy / missing evidence. */
  historicalEvidence: boolean;
}

export type WebAnnotationEvidenceSection =
  | "intent"
  | "target"
  | "page"
  | "text"
  | "geometry"
  | "styles"
  | "attributes"
  | "hierarchy"
  | "html"
  | "image"
  | "legacy-reference"
  | "thread-summary";

export interface WebAnnotationEvidenceManifestItem {
  annotationId: string;
  reference: number;
  included: WebAnnotationEvidenceSection[];
  omitted: WebAnnotationEvidenceSection[];
  unavailable: WebAnnotationEvidenceSection[];
  captureState: WebAnnotationCaptureState;
  targetKind: WebAnnotationTargetKind;
}

export interface WebAnnotationEvidenceManifest {
  items: WebAnnotationEvidenceManifestItem[];
  textBytes: number;
  imageCount: number;
  imageBytes: number;
}

export interface WebAnnotationRequestAttachment {
  assetId: string;
  digest: string;
  bytes: number;
  /** App-generated, relative to the workspace root. */
  relativePath: string;
  /** Agent-readable path written at materialization; absent until then. */
  materializedPath?: string;
  /**
   * Set when the backend removed its own materialized workspace file after the
   * request settled and its retention elapsed (or its notes were deleted).
   */
  removedAt?: string;
}

/**
 * How discussion avoided implementation. `plan-mode` asks the provider for its
 * own per-turn plan/read-only mode; `advisory` is an instruction only.
 * Neither is described to users as a sandbox guarantee.
 */
export type WebAnnotationReadOnlyMode = "plan-mode" | "advisory" | "not-applicable";

export interface WebAnnotationResponseExcerpt {
  text: string;
  capturedAt: string;
  provenance: "agent-reference";
  messageId?: string;
  truncated: boolean;
}

export interface WebAnnotationRequest {
  id: string;
  environmentId: string;
  schemaVersion: typeof WEB_ANNOTATION_SCHEMA_VERSION;
  revision: number;
  operation: WebAnnotationRequestOperation;
  destination: WebAnnotationDestination;
  selections: WebAnnotationRequestSelection[];
  instruction: string;
  bodyHash: string;
  briefBytes: number;
  evidence: WebAnnotationEvidenceManifest;
  attachments: WebAnnotationRequestAttachment[];
  textOnly: boolean;
  readOnly: WebAnnotationReadOnlyMode;
  state: WebAnnotationRequestState;
  blockedReason: WebAnnotationBlockedReason | null;
  /** Bounded, content-free-where-possible explanation for failures/holds. */
  stateReason: string | null;
  /** True while this request holds implementation reservations. */
  reservation: boolean;
  queueKey: string;
  enqueueIntentAt: string;
  queueReceiptAt: string | null;
  dispatchConfirmedAt: string | null;
  settledAt: string | null;
  cancelRequestedAt: string | null;
  abandonedAt: string | null;
  interactionIds: string[];
  transcript: WebAnnotationTranscriptRef;
  response: WebAnnotationResponseExcerpt | null;
  resultIds: string[];
  createdAt: string;
  updatedAt: string;
  // Optional fields below were added after the first contract version; records
  // written before them simply omit them.
  /** How the native turn ended, when known without reading the transcript. */
  turnOutcome?: WebAnnotationTurnOutcome | null;
  /** Bounded provider error for a `failed` turn outcome. */
  turnError?: string | null;
  /** Pending native interactions (questions/approvals) of this request's turn. */
  interactions?: WebAnnotationRequestInteraction[];
  /** Set while the destination session no longer exists; retarget or cancel. */
  destinationMissingAt?: string | null;
  /** Why the latest cancel/stop attempt did not take effect. */
  cancelRefusal?: WebAnnotationCancelRefusalRecord | null;
  /** Cancel was requested, but the turn had already been sent and finished normally. */
  cancelArrivedLate?: boolean;
  /** Where a cancellation came from, for cancelled requests. */
  cancelSource?: "user" | "chat-queue" | "retarget";
  /** Execution mode requested for the queued turn (`session` = left unchanged). */
  dispatchMode?: WebAnnotationDispatchMode;
  /** The earlier request this one follows up on (remaining items only). */
  followUpOf?: string;
  /** The request this one replaced with a new destination. */
  retargetOf?: string;
  /** The request that replaced this one after a retarget. */
  retargetedTo?: string;
}

/**
 * Outcome of the native turn: `failed` only on an authoritative provider
 * error; `unknown` when the backend could not tell without the transcript.
 */
export type WebAnnotationTurnOutcome = "completed" | "failed" | "unknown";

/** Mode sent with the queued turn. `session` leaves the session's own mode untouched. */
export type WebAnnotationDispatchMode = "plan" | "build" | "session";

/** Content-free reference to a pending native interaction; answer it with the existing interaction commands. */
export interface WebAnnotationRequestInteraction {
  id: string;
  kind: AgentInteractionKind;
  state: AgentInteractionState;
  /** False when the turn keeps running while the interaction is pending. */
  blocking: boolean;
  expiresAt?: number;
}

export type WebAnnotationCancelRefusal =
  | "claimed"
  | "unconfirmed"
  | "not-active"
  | "newer-turn"
  | "already-finished"
  | "stop-failed";

export interface WebAnnotationCancelRefusalRecord {
  code: WebAnnotationCancelRefusal;
  message: string;
  at: string;
}

/**
 * Typed origin carried by annotation items in the native prompt queue. Queue
 * items returned to clients keep it, so a chat UI can render them as frozen
 * annotation requests (not editable prompts).
 */
export interface WebAnnotationQueueOrigin {
  kind: "web-annotation";
  requestId: string;
  bodyHash: string;
}

/** Error prefix for edit/transfer attempts on an annotation queue item. */
export const WEB_ANNOTATION_QUEUE_ITEM_FROZEN = "Web annotation queue item is frozen:";

export function webAnnotationQueueOrigin(message: unknown): WebAnnotationQueueOrigin | null {
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const origin = (message as { origin?: unknown }).origin;
  if (!origin || typeof origin !== "object" || Array.isArray(origin)) return null;
  const record = origin as Record<string, unknown>;
  return record.kind === "web-annotation" &&
    typeof record.requestId === "string" &&
    record.requestId.length > 0 &&
    typeof record.bodyHash === "string"
    ? { kind: "web-annotation", requestId: record.requestId, bodyHash: record.bodyHash }
    : null;
}

// ---------------------------------------------------------------------------
// Results

export type WebAnnotationOutcome =
  | "addressed"
  | "partly-addressed"
  | "not-addressed"
  | "needs-clarification"
  | "unreported";

export type WebAnnotationCheckOutcome = "passed" | "failed" | "not-run" | "unavailable";
/** `agent-reported` can never impersonate `app-observed` or user acceptance. */
export type WebAnnotationCheckProvenance = "agent-reported" | "app-observed";

export interface WebAnnotationCheck {
  description: string;
  outcome: WebAnnotationCheckOutcome;
  provenance: WebAnnotationCheckProvenance;
  artifactId?: string;
}

export interface WebAnnotationResult {
  id: string;
  requestId: string;
  bodyHash: string;
  revision: number;
  provenance: "agent-reported" | "transcript-excerpt" | "user-capture";
  provisional: boolean;
  outcomes: Array<{ annotationId: string; outcome: WebAnnotationOutcome; note: string | null }>;
  summary: string;
  files: string[];
  checks: WebAnnotationCheck[];
  evidenceAssetIds: string[];
  /** After-captures taken by the user for comparison. */
  captureIds: string[];
  limitations: string[];
  questions: string[];
  supersedes: string | null;
  createdAt: string;
  /** Request evidence (attachment asset ids / capture ids) the agent report cites. */
  evidenceIds?: string[];
  /**
   * Revision of the agent report whose outcomes/summary/checks this revision
   * carries: equal to `revision` for an agent report, the carried report's
   * revision on a user-capture revision, and null when no agent reported.
   */
  reportedRevision?: number | null;
  /** App-observed after-captures accumulated across revisions. */
  observations?: WebAnnotationResultObservation[];
  /** Backend containment/existence checks of reported file paths. */
  fileChecks?: WebAnnotationFileCheck[];
}

export interface WebAnnotationResultObservation {
  captureId: string;
  annotationId: string;
  capturedAt: string;
  provenance: "app-observed";
  assetIds: string[];
  comparison: WebAnnotationComparisonMetadata;
}

export type WebAnnotationFileCheckStatus =
  | "exists"
  | "missing"
  | "outside-workspace"
  | "unavailable";

export interface WebAnnotationFileCheck {
  path: string;
  status: WebAnnotationFileCheckStatus;
}

// ---------------------------------------------------------------------------
// Assets

export interface WebAnnotationAsset {
  id: string;
  environmentId: string;
  digest: string;
  mediaType: "image/png";
  bytes: number;
  width: number;
  height: number;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Synchronization

export interface WebAnnotationChangeHint {
  environmentId: string;
  generation: string;
  revision: number;
  annotationIds: string[];
  requestIds: string[];
  /** The change set was too large to enumerate: refetch everything. */
  reset: boolean;
}

export interface WebAnnotationChanges {
  generation: string;
  revision: number;
  resetRequired: boolean;
  changes: Array<{ revision: number; annotationIds: string[]; requestIds: string[] }>;
}

export type WebAnnotationStorageStatus = "ready" | "degraded" | "unavailable";

export interface WebAnnotationCapabilities {
  contractVersion: typeof WEB_ANNOTATION_CONTRACT_VERSION;
  storage: WebAnnotationStorageStatus;
  degradedReason?: string;
  /**
   * Backend rollout switch. Absent from older backends (treat as `enabled`).
   * `read-only` is recovery mode: `read`, `resolve`, and `recover` stay on;
   * everything that creates new feedback or dispatches is off.
   */
  mode?: WebAnnotationRolloutMode;
  operations: {
    read: boolean;
    author: boolean;
    captureAccept: boolean;
    dispatch: boolean;
    batch: boolean;
    resultTools: boolean;
    comparison: boolean;
    migration: boolean;
    /** Resolve/reopen. Absent from older backends (derive from `author`). */
    resolve?: boolean;
    /** Inspect/cancel/recover requests already sent. Absent: derive from `dispatch`. */
    recover?: boolean;
    /** `web_annotation_archive` (archive + continuation). Absent: unsupported. */
    archive?: boolean;
  };
  /** Capture target kinds a client may submit (never `legacy-unresolved`). */
  targets: WebAnnotationTargetKind[];
  maxRequestAnnotations: number;
  limits: WebAnnotationLimits;
}

// ---------------------------------------------------------------------------
// Command surface. Every mutation names its operation id, environment, and
// the expected revision it protects.

export const WEB_ANNOTATION_COMMANDS = Object.freeze({
  capabilities: "web_annotations_capabilities",
  list: "web_annotations_list",
  changes: "web_annotations_changes",
  get: "web_annotation_get",
  entries: "web_annotation_entries",
  capture: "web_annotation_capture",
  draftGet: "web_annotation_draft_get",
  draftSave: "web_annotation_draft_save",
  draftDelete: "web_annotation_draft_delete",
  create: "web_annotation_create",
  receipt: "web_annotation_operation_receipt",
  entryAppend: "web_annotation_entry_append",
  entryEdit: "web_annotation_entry_edit",
  update: "web_annotation_update",
  captureReplace: "web_annotation_capture_replace",
  resolve: "web_annotation_resolve",
  reopen: "web_annotation_reopen",
  delete: "web_annotation_delete",
  assetStage: "web_annotation_asset_stage",
  assetGet: "web_annotation_asset_get",
  destinations: "web_annotation_destinations",
  requestPrepare: "web_annotation_request_prepare",
  requestSend: "web_annotation_request_send",
  requestGet: "web_annotation_request_get",
  requestList: "web_annotation_requests",
  requestCancel: "web_annotation_request_cancel",
  requestRecover: "web_annotation_request_recover",
  requestResponse: "web_annotation_request_response",
  requestFollowUp: "web_annotation_request_follow_up",
  resultCapture: "web_annotation_result_capture",
  migrate: "web_annotations_migrate",
  migrationStatus: "web_annotations_migration_status",
  archive: "web_annotation_archive",
  reconcileDraft: "web_annotations_reconcile_draft",
  rollout: "web_annotations_rollout",
  rolloutSet: "web_annotations_rollout_set",
  metrics: "web_annotations_metrics",
} as const);

export type WebAnnotationCommand =
  (typeof WEB_ANNOTATION_COMMANDS)[keyof typeof WEB_ANNOTATION_COMMANDS];

export interface WebAnnotationListInput {
  environmentId: string;
  filter?: {
    pageKey?: string;
    state?: "open" | "resolved" | "all";
    destinationTabId?: string;
    includeHidden?: boolean;
    importedOnly?: boolean;
    /** Include archived (read-only) threads. Default false. */
    includeArchived?: boolean;
  };
  cursor?: string;
  limit?: number;
}

export interface WebAnnotationListResult {
  generation: string;
  revision: number;
  items: WebAnnotationSummary[];
  /** Opaque; tagged with the snapshot revision and filter. */
  nextCursor: string | null;
  total: number;
  openOnPage?: number;
}

export interface WebAnnotationGetResult {
  generation: string;
  revision: number;
  annotation: WebAnnotation;
  capture: WebAnnotationCapture | null;
  entries: WebAnnotationEntry[];
  nextEntrySequence: number | null;
  /**
   * With `entryWindow: "latest"`: pass as `beforeSequence` to page older
   * entries; null when the page starts at the first entry. Absent from older
   * backends.
   */
  previousEntrySequence?: number | null;
  requests: WebAnnotationRequest[];
  results: WebAnnotationResult[];
}

export interface WebAnnotationEntriesResult {
  entries: WebAnnotationEntry[];
  nextSequence: number | null;
  /** Pass as `beforeSequence` to page older entries; null at the first entry. */
  previousSequence?: number | null;
  resetRequired: boolean;
}

export interface WebAnnotationOperationReceipt {
  operationId: string;
  annotationId: string;
  captureId: string | null;
  entryId: string | null;
  contentRevision: number;
  metadataRevision: number;
  captureRevision: number;
  environmentRevision: number;
}

export interface WebAnnotationCreateInput {
  environmentId: string;
  operationId: string;
  capture: WebAnnotationCaptureInput;
  /** Required and non-empty to publish; an empty note stays a draft. */
  body: string;
  title?: string;
  draftId?: string;
}

export interface WebAnnotationAssetStageInput {
  environmentId: string;
  operationId: string;
  mediaType: "image/png";
  /** Base64 PNG without a data-URL prefix. */
  data: string;
}

export interface WebAnnotationAssetStageResult {
  asset: WebAnnotationAsset;
  deduplicated: boolean;
}

export interface WebAnnotationDestinationOption {
  destination: WebAnnotationDestination;
  title: string;
  model: string | null;
  activity: "idle" | "working" | "waiting" | "unknown";
  images: boolean;
  planMode: boolean;
  resultTools: boolean;
  /** An unsent native composer draft or parked dispatch will hold the queue. */
  holds: Array<"compose-draft" | "parked-dispatch" | "queued-prompts">;
  isDefault: boolean;
  /**
   * Basis of `images`: `model` when the selected model's capability was known,
   * `agent` when only the platform's capability was (label it as unverified).
   */
  imageSupport?: "model" | "agent";
}

export interface WebAnnotationPrepareInput {
  environmentId: string;
  operation: WebAnnotationRequestOperation;
  destination: WebAnnotationDestination;
  annotations: Array<{
    annotationId: string;
    expectedContentRevision: number;
    expectedCaptureId: string;
    desiredOutcome?: string | null;
    allowHistoricalEvidence?: boolean;
  }>;
  /** Host-authored instruction. Empty means "use the latest host note". */
  instruction: string;
  textOnly?: boolean;
  /**
   * Follow up on a settled request. With an empty `annotations` list the
   * backend selects its remaining items (see `web_annotation_request_follow_up`);
   * the brief links and summarizes the previous result and discussion.
   */
  followUpOf?: string;
  /**
   * Replace an active request that was never dispatched (held, queued, or whose
   * destination was deleted) with the same selections at a new destination.
   * Send removes the old queue item and settles the old request as cancelled
   * in the same commit. An empty `annotations` list reuses its selections.
   */
  retargetOf?: string;
}

export type WebAnnotationPreparationIssueCode =
  | "missing-instruction"
  | "stale-revision"
  | "stale-capture"
  | "legacy-evidence"
  | "missing-evidence"
  | "images-unsupported"
  | "destination-unavailable"
  | "active-implementation"
  | "over-capacity"
  | "conflicting-instructions"
  | "environment-not-ready"
  | "queue-held"
  | "annotation-resolved"
  | "follow-up-empty"
  | "retarget-unavailable";

export interface WebAnnotationPreparationIssue {
  code: WebAnnotationPreparationIssueCode;
  severity: "blocker" | "warning";
  annotationId?: string;
  message: string;
}

export interface WebAnnotationPreparation {
  preparationId: string;
  expiresAt: string;
  operation: WebAnnotationRequestOperation;
  destination: WebAnnotationDestination;
  selections: WebAnnotationRequestSelection[];
  instruction: string;
  briefPreview: string;
  briefBytes: number;
  bodyHash: string;
  evidence: WebAnnotationEvidenceManifest;
  attachments: Array<Pick<WebAnnotationRequestAttachment, "assetId" | "bytes" | "digest">>;
  textOnly: boolean;
  readOnly: WebAnnotationReadOnlyMode;
  issues: WebAnnotationPreparationIssue[];
  sendable: boolean;
  followUpOf?: string;
  retargetOf?: string;
}

export interface WebAnnotationSendInput {
  environmentId: string;
  preparationId: string;
  /** Stable across retries: a lost response re-sends the same id. */
  requestId: string;
  bodyHash: string;
}

export interface WebAnnotationResolveInput {
  environmentId: string;
  operationId: string;
  annotationId: string;
  expectedContentRevision: number;
  expectedCaptureId: string;
  requestId?: string;
  resultId?: string;
  expectedResultRevision?: number;
  note?: string;
}

/**
 * Archive a thread (typically at its entry/text capacity) and continue in a
 * new linked thread, in one commit. The archived thread becomes read-only
 * history; the continuation carries the current capture (same target and
 * evidence) and the default destination, and links back to it.
 */
export interface WebAnnotationArchiveInput {
  environmentId: string;
  operationId: string;
  annotationId: string;
  expectedMetadataRevision: number;
  /** Title of the continuation; defaults to "<title> (continued)". */
  title?: string;
  /** Optional first host note in the continuation. */
  body?: string;
}

export interface WebAnnotationArchiveResult {
  /** Receipt of the continuation thread (its annotation/capture/entry ids). */
  continuation: WebAnnotationOperationReceipt;
  archivedAnnotationId: string;
  archivedMetadataRevision: number;
}

/** A legacy browser note in a compose draft that now lives in a thread. */
export interface WebAnnotationMigratedReference {
  legacyId: string;
  annotationId: string;
}

/**
 * Fixed neutral text of the lightweight reference that replaces a migrated
 * legacy browser annotation in a compose draft (`migratedTo` names the thread
 * holding the original note). Clients must not put these references in
 * prompts or consume them on send; they may render a link to the thread.
 */
export const WEB_ANNOTATION_MIGRATED_REFERENCE_TEXT = "Moved to a web annotation thread.";

/**
 * Result of `web_annotations_reconcile_draft`: a dirty in-memory compose
 * draft value run through the same idempotent import as server-side
 * migration. `value` is the input with every imported legacy browser note
 * replaced by a migrated reference (and its linked attachments removed);
 * everything else is untouched. Adopt it before the next draft save.
 */
export interface WebAnnotationDraftReconciliation {
  value: unknown;
  references: WebAnnotationMigratedReference[];
  /** Notes imported by this call (0 when all were already imported). */
  imported: number;
  /** Legacy note ids that could not be imported now; they stay unchanged in `value`. */
  failed: string[];
}

export interface WebAnnotationMigrationStatus {
  environmentId: string;
  scannedDrafts: number;
  importedAnnotations: number;
  pendingDrafts: number;
  deferredDrafts: number;
  failedDrafts: number;
  completedAt: string | null;
}

// ---------------------------------------------------------------------------
// Presentation helpers shared by every client.

export const WEB_ANNOTATION_REQUEST_STATE_LABELS: Readonly<
  Record<WebAnnotationRequestState, string>
> = Object.freeze({
  prepared: "Preparing",
  queued: "Queued",
  dispatching: "Sending",
  unconfirmed: "Delivery unconfirmed",
  running: "Running",
  "needs-input": "Needs input",
  cancelling: "Stopping",
  completed: "Response ready",
  "awaiting-review": "Review response",
  failed: "Failed",
  cancelled: "Cancelled",
  "abandoned-unconfirmed": "Discarded (may have run)",
});

export const WEB_ANNOTATION_BLOCKED_REASON_LABELS: Readonly<
  Record<WebAnnotationBlockedReason, string>
> = Object.freeze({
  "compose-draft": "Queued — existing draft needs attention",
  "environment-stopped": "Queued — environment is not running",
  "destination-unavailable": "Queued — agent session unavailable",
  "queue-parked": "Queued — an earlier prompt needs attention",
  capacity: "Queued — capacity reached",
  "agent-busy": "Queued — agent is busy",
  "dispatch-rejected": "Held — the agent rejected this request; retry or cancel",
});

export function webAnnotationUtf8Bytes(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Exact command argument and result shapes. Backend handlers and clients both
// adhere to these; anything not listed here is rejected by the handler.

export interface WebAnnotationDraftSaveInput {
  environmentId: string;
  editorId: string;
  /** 0 creates the draft. */
  expectedRevision: number;
  text: string;
  annotationId?: string | null;
  captureId?: string | null;
  pendingCaptureId?: string | null;
  operation?: WebAnnotationRequestOperation | null;
  destination?: WebAnnotationDestination | null;
}

export interface WebAnnotationRequestCancelResult {
  request: WebAnnotationRequest;
  /** `cancelling` while a claimed/running turn may still execute. */
  outcome: "cancelled" | "cancelling" | "not-cancellable";
  /** Typed reason when `not-cancellable` (also stored as `request.cancelRefusal`). */
  refusal?: WebAnnotationCancelRefusal;
}

/** Result (after) capture input; the comparison metadata fields are optional. */
export interface WebAnnotationResultCaptureInput extends WebAnnotationResultCaptureMetadata {
  environmentId: string;
  operationId: string;
  requestId: string;
  /** Required for batch requests: which selected annotation this capture shows. */
  annotationId?: string;
  capture: WebAnnotationCaptureInput;
}

/** Default selection for a follow-up to a settled request. */
export interface WebAnnotationFollowUpCandidates {
  requestId: string;
  /** Selected by default: not accepted and not reported addressed, or changed since. */
  remaining: Array<{
    annotationId: string;
    reference: number;
    reason: "not-addressed" | "unreported" | "request-failed" | "changed-since";
    previousOutcome: WebAnnotationOutcome;
  }>;
  /** Left out by default, with the reason; the user may still include them. */
  excluded: Array<{
    annotationId: string;
    reference: number;
    reason: "accepted" | "deleted" | "archived" | "addressed";
  }>;
  /** Latest result the follow-up links to, when any. */
  resultId: string | null;
}

export interface WebAnnotationCommandArgs {
  web_annotations_capabilities: { environmentId?: string };
  web_annotations_list: WebAnnotationListInput;
  web_annotations_changes: { environmentId: string; generation?: string; after: number };
  web_annotation_get: {
    environmentId: string;
    annotationId: string;
    entryLimit?: number;
    /** `oldest` (default): entries from sequence 1. `latest`: the newest page. */
    entryWindow?: "oldest" | "latest";
  };
  web_annotation_entries: {
    environmentId: string;
    annotationId: string;
    /** Forward paging: entries with a greater sequence, oldest first. */
    afterSequence: number;
    /**
     * Backward paging: when set, returns up to `limit` entries with a smaller
     * sequence (still oldest first) instead; `afterSequence` must then be 0.
     */
    beforeSequence?: number;
    limit?: number;
  };
  web_annotation_capture: { environmentId: string; captureId: string };
  web_annotation_draft_get: { environmentId: string; editorId: string };
  web_annotation_draft_save: WebAnnotationDraftSaveInput;
  web_annotation_draft_delete: {
    environmentId: string;
    editorId: string;
    expectedRevision: number;
  };
  web_annotation_create: WebAnnotationCreateInput;
  web_annotation_operation_receipt: { environmentId: string; operationId: string };
  web_annotation_entry_append: {
    environmentId: string;
    operationId: string;
    annotationId: string;
    expectedContentRevision: number;
    body: string;
    editorId?: string;
  };
  web_annotation_entry_edit: {
    environmentId: string;
    operationId: string;
    annotationId: string;
    entryId: string;
    expectedContentRevision: number;
    body: string;
  };
  web_annotation_update: {
    environmentId: string;
    operationId: string;
    annotationId: string;
    expectedMetadataRevision: number;
    title?: string;
    defaultDestination?: WebAnnotationDestination | null;
    hidden?: boolean;
  };
  web_annotation_capture_replace: {
    environmentId: string;
    operationId: string;
    annotationId: string;
    expectedContentRevision: number;
    capture: WebAnnotationCaptureInput;
    body?: string;
  };
  web_annotation_resolve: WebAnnotationResolveInput;
  web_annotation_reopen: {
    environmentId: string;
    operationId: string;
    annotationId: string;
    expectedMetadataRevision: number;
    body?: string;
  };
  web_annotation_delete: {
    environmentId: string;
    operationId: string;
    annotationId: string;
    expectedMetadataRevision: number;
  };
  web_annotation_asset_stage: WebAnnotationAssetStageInput;
  web_annotation_asset_get: { environmentId: string; assetId: string };
  web_annotation_destinations: { environmentId: string };
  web_annotation_request_prepare: WebAnnotationPrepareInput;
  web_annotation_request_send: WebAnnotationSendInput;
  web_annotation_request_get: { environmentId: string; requestId: string };
  web_annotation_requests: { environmentId: string; annotationId?: string; activeOnly?: boolean };
  web_annotation_request_cancel: {
    environmentId: string;
    requestId: string;
    expectedRevision: number;
  };
  web_annotation_request_recover: {
    environmentId: string;
    requestId: string;
    action: "reconcile" | "retry" | "discard";
  };
  web_annotation_request_response: { environmentId: string; requestId: string };
  web_annotation_request_follow_up: { environmentId: string; requestId: string };
  web_annotation_result_capture: WebAnnotationResultCaptureInput;
  web_annotations_migrate: { environmentId: string };
  web_annotations_migration_status: { environmentId: string };
  web_annotation_archive: WebAnnotationArchiveInput;
  web_annotations_reconcile_draft: { environmentId: string; value: unknown };
  web_annotations_rollout: Record<string, never>;
  web_annotations_rollout_set: { mode: WebAnnotationRolloutMode };
  web_annotations_metrics: Record<string, never>;
}

export interface WebAnnotationCommandResults {
  web_annotations_capabilities: WebAnnotationCapabilities;
  web_annotations_list: WebAnnotationListResult;
  web_annotations_changes: WebAnnotationChanges;
  web_annotation_get: WebAnnotationGetResult;
  web_annotation_entries: WebAnnotationEntriesResult;
  web_annotation_capture: { capture: WebAnnotationCapture };
  web_annotation_draft_get: { draft: WebAnnotationDraft | null };
  web_annotation_draft_save: { draft: WebAnnotationDraft };
  web_annotation_draft_delete: { deleted: boolean };
  web_annotation_create: WebAnnotationOperationReceipt;
  web_annotation_operation_receipt: { receipt: WebAnnotationOperationReceipt | null };
  web_annotation_entry_append: WebAnnotationOperationReceipt;
  web_annotation_entry_edit: WebAnnotationOperationReceipt;
  web_annotation_update: WebAnnotationOperationReceipt;
  web_annotation_capture_replace: WebAnnotationOperationReceipt;
  web_annotation_resolve: WebAnnotationOperationReceipt;
  web_annotation_reopen: WebAnnotationOperationReceipt;
  web_annotation_delete: WebAnnotationOperationReceipt;
  web_annotation_asset_stage: WebAnnotationAssetStageResult;
  web_annotation_asset_get: { asset: WebAnnotationAsset; data: string };
  web_annotation_destinations: { options: WebAnnotationDestinationOption[] };
  web_annotation_request_prepare: WebAnnotationPreparation;
  web_annotation_request_send: { request: WebAnnotationRequest; deduplicated: boolean };
  web_annotation_request_get: { request: WebAnnotationRequest; results: WebAnnotationResult[] };
  web_annotation_requests: { requests: WebAnnotationRequest[] };
  web_annotation_request_cancel: WebAnnotationRequestCancelResult;
  web_annotation_request_recover: { request: WebAnnotationRequest };
  web_annotation_request_response: {
    request: WebAnnotationRequest;
    response: WebAnnotationResponseExcerpt | null;
    /** False when the source session/transcript is gone; the snapshot remains. */
    sourceAvailable: boolean;
  };
  web_annotation_request_follow_up: WebAnnotationFollowUpCandidates;
  web_annotation_result_capture: { result: WebAnnotationResult; captureId: string };
  web_annotations_migrate: WebAnnotationMigrationStatus;
  web_annotations_migration_status: WebAnnotationMigrationStatus;
  web_annotation_archive: WebAnnotationArchiveResult;
  web_annotations_reconcile_draft: WebAnnotationDraftReconciliation;
  web_annotations_rollout: WebAnnotationRolloutSnapshot;
  web_annotations_rollout_set: WebAnnotationRolloutSnapshot;
  web_annotations_metrics: WebAnnotationMetricsSnapshot;
}

// ---------------------------------------------------------------------------
// Transcript correlation marker. The first line of every dispatched brief
// names its request id, so the backend correlates a transcript turn with a
// request deterministically and clients can link a chat turn back to its
// thread. Page content can never produce this line: it is emitted only by the
// backend compiler, before any evidence.

const REQUEST_MARKER =
  /^Orkestrator web annotation request ([A-Za-z0-9][A-Za-z0-9._:-]{0,199}) \((discuss|implement); (\d{1,2}) annotations?\)$/;

export function webAnnotationRequestMarker(
  requestId: string,
  operation: WebAnnotationRequestOperation,
  annotationCount: number,
): string {
  return `Orkestrator web annotation request ${requestId} (${operation}; ${annotationCount} annotation${annotationCount === 1 ? "" : "s"})`;
}

export function parseWebAnnotationRequestMarker(
  text: string,
): { requestId: string; operation: WebAnnotationRequestOperation; annotationCount: number } | null {
  const firstLine = text.trimStart().split("\n", 1)[0] ?? "";
  const match = REQUEST_MARKER.exec(firstLine.trim());
  if (!match) return null;
  return {
    requestId: match[1]!,
    operation: match[2] as WebAnnotationRequestOperation,
    annotationCount: Number(match[3]),
  };
}

/** Opening/closing fence of the inert evidence block inside a brief. */
export const WEB_ANNOTATION_EVIDENCE_OPEN = "<orkestrator_web_annotation_evidence>";
export const WEB_ANNOTATION_EVIDENCE_CLOSE = "</orkestrator_web_annotation_evidence>";
