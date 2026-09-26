/**
 * Internal seams between the web annotation service (storage, commands,
 * lifecycle) and its execution adapters (brief compiler, native dispatch,
 * agent tools). The service owns persistence and revisions; adapters are
 * stateless with respect to annotation storage and receive exactly the data
 * they need. Native dispatch remains the only execution authority.
 */
import type {
  WebAnnotation,
  WebAnnotationAsset,
  WebAnnotationBlockedReason,
  WebAnnotationCancelRefusal,
  WebAnnotationCapture,
  WebAnnotationDestination,
  WebAnnotationDestinationOption,
  WebAnnotationDispatchMode,
  WebAnnotationEntry,
  WebAnnotationEvidenceManifest,
  WebAnnotationFileCheck,
  WebAnnotationOutcome,
  WebAnnotationPreparationIssue,
  WebAnnotationReadOnlyMode,
  WebAnnotationRequest,
  WebAnnotationRequestAttachment,
  WebAnnotationRequestInteraction,
  WebAnnotationRequestOperation,
  WebAnnotationRequestSelection,
  WebAnnotationRequestState,
  WebAnnotationResponseExcerpt,
  WebAnnotationResult,
  WebAnnotationTurnOutcome,
} from "@orkestrator/protocol/web-annotations";
import type { WebAnnotationResultReportInput } from "@orkestrator/protocol/web-annotations-validation";

// ---------------------------------------------------------------------------
// Brief compilation (pure; deterministic for identical input)

export interface BriefAnnotationInput {
  annotation: WebAnnotation;
  /** Null when the referenced capture record is unavailable. */
  capture: WebAnnotationCapture | null;
  /** Published, non-superseded entries relevant to this request, oldest first. */
  entries: WebAnnotationEntry[];
  /** Assets referenced by the capture that are still stored. */
  assets: WebAnnotationAsset[];
  desiredOutcome: string | null;
  allowHistoricalEvidence: boolean;
  /**
   * Entry ids already delivered to this same destination by earlier requests.
   * Follow-ups carry only newer entries plus essential target context.
   */
  previouslyDeliveredEntryIds: ReadonlySet<string>;
  /**
   * Bounded, deterministic, attributed excerpt of earlier discussion: for a
   * different destination session, or the entries a follow-up already
   * delivered. Never replaces the latest explicit human instruction.
   */
  threadSummary: WebAnnotationThreadSummary | null;
  /** For a follow-up: what the previous request's latest result reported. */
  previousOutcome?: {
    outcome: WebAnnotationOutcome;
    note: string | null;
  } | null;
}

export interface WebAnnotationThreadSummary {
  /** Deterministic excerpt lines with attribution; page/agent text is untrusted. */
  text: string;
  /** Entries excerpted, oldest first. */
  entryIds: string[];
  context: "other-session" | "follow-up";
}

/** Link from a follow-up request to the request (and result) it continues. */
export interface BriefFollowUp {
  requestId: string;
  state: WebAnnotationRequestState;
  resultId: string | null;
  /** Agent-reported summary of the previous result (untrusted, bounded). */
  summary: string | null;
}

export interface BriefDestinationCapabilities {
  images: boolean;
  /** `model` when the selected model's image support was known; else `agent`. */
  imageSupport?: "model" | "agent";
  /** Per-turn plan mode that does not change the session's own mode. */
  planMode: boolean;
  resultTools: boolean;
}

export interface CompileBriefInput {
  operation: WebAnnotationRequestOperation;
  destination: WebAnnotationDestination;
  /** Stable user-visible order; references are assigned 1..n from it. */
  annotations: BriefAnnotationInput[];
  /** Host-authored overall instruction (may be empty for single notes). */
  instruction: string;
  textOnly: boolean;
  capabilities: BriefDestinationCapabilities;
  /** Set when this request follows up on a settled earlier request. */
  followUp?: BriefFollowUp | null;
}

export interface CompiledBrief {
  /**
   * Canonical body without the request-id marker line. `bodyHash` is the
   * SHA-256 hex digest of these exact UTF-8 bytes.
   */
  body: string;
  bodyHash: string;
  bytes: number;
  selections: WebAnnotationRequestSelection[];
  /** Effective instruction after "use the latest host note" defaulting. */
  instruction: string;
  evidence: WebAnnotationEvidenceManifest;
  /** Planned attachments (deduplicated by digest), not yet materialized. */
  attachments: Array<
    Pick<WebAnnotationRequestAttachment, "assetId" | "digest" | "bytes" | "relativePath">
  >;
  readOnly: WebAnnotationReadOnlyMode;
  issues: WebAnnotationPreparationIssue[];
}

/** Final dispatched text = marker line + blank line + body. */
export type ComposeDispatchText = (
  requestId: string,
  brief: Pick<CompiledBrief, "body">,
  operation: WebAnnotationRequestOperation,
  annotationCount: number,
) => string;

// ---------------------------------------------------------------------------
// Native dispatch adapter

export interface DispatchEnvironment {
  id: string;
  environmentType: "local" | "docker" | string;
  worktreePath?: string;
  containerId?: string;
}

export interface MaterializeInput {
  environment: DispatchEnvironment;
  requestId: string;
  attachments: WebAnnotationRequestAttachment[];
  /** Bytes for each attachment, keyed by asset id. Already validated PNG. */
  readAsset(assetId: string): Promise<Buffer>;
}

export interface PublishInput {
  request: WebAnnotationRequest;
  /** Exact dispatched text (marker + body). */
  text: string;
}

export type PublishReceipt =
  /** Appended now, or already present with an identical fingerprint. */
  | { status: "queued"; dispatchMode?: WebAnnotationDispatchMode }
  /** Already consumed by native dispatch (dispatched or parked unknown). */
  | { status: "consumed" }
  /** Refused before enqueue; nothing was published. */
  | { status: "rejected"; reason: string };

/** Authoritative, content-free observation of one request's native state. */
export interface DispatchObservation {
  /**
   * Suggested next state. The service validates it with the lifecycle
   * transition table and never regresses a request on a stale observation.
   */
  state: WebAnnotationRequestState;
  blockedReason: WebAnnotationBlockedReason | null;
  reason: string | null;
  dispatchConfirmed: boolean;
  interactionIds: string[];
  /** True when the destination session no longer exists at all. */
  destinationMissing: boolean;
  /** Pending interactions of this request's waiting turn (replaces the stored list). */
  interactions?: WebAnnotationRequestInteraction[];
  turnOutcome?: WebAnnotationTurnOutcome;
  turnError?: string | null;
  /** Transcript anchor of this request's prompt, when locatable without I/O. */
  transcript?: { messageId?: string; turnId?: string };
  /** A cancel was requested, but the turn finished normally before it applied. */
  cancelArrivedLate?: boolean;
  cancelSource?: "user" | "chat-queue" | "retarget";
}

export type CancelOutcome =
  /** Removed from the queue before its dispatch fence (or its destination is gone). */
  | { outcome: "cancelled"; reason?: string }
  /** A stop was sent to the correlated current turn; settlement follows. */
  | { outcome: "cancelling" }
  | { outcome: "not-cancellable"; reason: string; code: WebAnnotationCancelRefusal };

export interface WebAnnotationDispatchPort {
  listDestinations(
    environmentId: string,
    defaultTabId: string | null,
  ): Promise<WebAnnotationDestinationOption[]>;
  /** Revalidate ownership/readiness/capabilities right before send and dispatch. */
  validateDestination(
    environmentId: string,
    destination: WebAnnotationDestination,
  ): Promise<
    | { ok: true; capabilities: BriefDestinationCapabilities }
    | { ok: false; reason: string; code: "destination-unavailable" | "environment-not-ready" }
  >;
  materialize(input: MaterializeInput): Promise<WebAnnotationRequestAttachment[]>;
  publish(input: PublishInput): Promise<PublishReceipt>;
  observe(request: WebAnnotationRequest): Promise<DispatchObservation>;
  cancel(request: WebAnnotationRequest): Promise<CancelOutcome>;
  /** Same-id native recovery; never allocates a new request id. */
  recover(
    request: WebAnnotationRequest,
    action: "reconcile" | "retry" | "discard",
  ): Promise<DispatchObservation>;
  /**
   * On-demand transcript excerpt for a settled request. May hydrate the one
   * session asked about; never called from background reconciliation.
   */
  readResponse(request: WebAnnotationRequest): Promise<{
    excerpt: WebAnnotationResponseExcerpt | null;
    sourceAvailable: boolean;
    /** Transcript anchor of this request's prompt message and turn. */
    transcript?: { messageId?: string; turnId?: string };
  }>;
  /**
   * Containment/existence checks for repository-relative paths in the
   * environment workspace. Optional; absent means checks are unavailable.
   */
  checkWorkspacePaths?(
    environment: DispatchEnvironment,
    paths: readonly string[],
  ): Promise<WebAnnotationFileCheck[]>;
}

// ---------------------------------------------------------------------------
// Agent tool host (milestone C). Implemented by the service; consumed by the
// agent tools server. Binding comes from backend state, never from a
// model-supplied request id alone.

export interface WebAnnotationToolScope {
  environmentId: string;
  /** Tab identity bound into the credential that made the call. */
  tabId: string | null;
}

export interface WebAnnotationToolHost {
  /** The request currently assigned to this scope (latest active or awaiting review). */
  assignedRequest(scope: WebAnnotationToolScope): Promise<{
    request: WebAnnotationRequest;
    brief: string;
    /** Highest result revision for the request (any provenance), if any. */
    latestResult?: WebAnnotationResult | null;
  } | null>;
  evidence(
    scope: WebAnnotationToolScope,
    requestId: string,
    annotationId: string,
  ): Promise<{
    annotation: WebAnnotation;
    capture: WebAnnotationCapture | null;
    entries: WebAnnotationEntry[];
  }>;
  reportResult(
    scope: WebAnnotationToolScope,
    report: WebAnnotationResultReportInput,
  ): Promise<WebAnnotationResult>;
}
