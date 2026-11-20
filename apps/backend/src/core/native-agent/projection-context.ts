/**
 * What the transcript projection's read models share: the service host, the
 * session epochs and lifecycle callbacks of the owner
 * (`NativeAgentTranscriptProjection`), and each other. Also the cache-entry
 * and row types more than one read model names.
 */
import type {
  NativeAgentComposerState,
  NativeAgentToolDetails,
  PersistedNativeAgentSession,
  StorageService,
  NativeAgentRuntimeProvider,
  ProviderInteractiveSnapshot,
  EnsureNativeAgentSessionInput,
  NativeAgentProjectionInput,
  NativeAgentServiceOptions,
  ProviderTranscriptSnapshot,
} from "./service-shared.js";
import { bugReportIdFromRuntimeId } from "@orkestrator/protocol/bug-report";
import { coordinatorIdFromRuntimeId } from "@orkestrator/protocol/coordinator";
import {
  type NativeAgentContextUsage,
  type NativeAgentTranscriptView,
  normalizeNativeAgentSelectionPricing,
} from "@orkestrator/protocol/native-agent";
import type { NativeAgentCatalogCache } from "./catalog-cache.js";
import type { PermissionRuleEnforcer } from "../permission-rules/index.js";
import { sameEncoding } from "./projection-encoding.js";
import { goalPublicView, sessionGoal } from "@orkestrator/protocol/native-agent-goal";
import type { NativeAgentResumeIdentityObserver } from "./resume-identity.js";
import type { NativeAgentSessionTitles } from "./session-titles.js";
import type { UsageHistoryRecorder } from "../usage-history-recorder.js";
import type { QueuedTurnPhaseLog } from "./queued-turn-log.js";
import type { NativeAgentProjectionParts } from "./projection-parts.js";
import type { NativeAgentProgressiveReads } from "./progressive-reads.js";
import type { NativeAgentProgressiveTranscript } from "./progressive-transcript.js";
import type { NativeAgentProgressiveSessionState } from "./progressive-session-state.js";
import type { NativeAgentProgressiveDiscovery } from "./progressive-discovery.js";
import type { NativeAgentHistoryPages } from "./history-pages.js";
import type { NativeAgentToolDetailReads } from "./tool-detail-reads.js";
import type { NativeAgentFullProjection } from "./full-projection.js";

/**
 * The shared context every read model takes. The owner builds it once; the
 * read models reach one another only through it, never by `extends`.
 */
export interface NativeAgentProjectionContext {
  readonly host: NativeAgentTranscriptProjectionHost;
  readonly storage: StorageService;
  readonly options: NativeAgentServiceOptions;
  readonly catalogs: NativeAgentCatalogCache;
  /** Invalidates an in-flight read when a logical tab changes provider identity. */
  readonly projectionEpochs: Map<string, number>;
  /** Content-free debug line for a queue held while the turn is not running. */
  readonly queuedTurnLog: QueuedTurnPhaseLog;
  /** The backend's choice of title per session, and its push to the provider. */
  readonly sessionTitles: NativeAgentSessionTitles;
  readonly resumeIdentity: NativeAgentResumeIdentityObserver;
  /** Durable token and spend history, fed from the per-turn usage providers report. */
  readonly usageRecorder: UsageHistoryRecorder;
  observeSessionUsage(
    session: Pick<
      PersistedNativeAgentSession,
      "environmentId" | "agent" | "logicalSessionKey" | "providerSessionId"
    >,
    usage: NativeAgentContextUsage | undefined,
  ): void;
  /** Drop everything kept for a session whose identity changed, and bump its epochs. */
  invalidateProjection(key: string): void;
  /** Drop a key's epoch once nothing caches or reads it. */
  pruneProjectionEpoch(key: string): void;
  /** Reclaim the epochs a deleted environment's settled reads left behind. */
  releaseForgottenProjectionEpochs(sessionKey: string): void;
  /** Tool details, projected rows, direct pages, artifact overlays and the composer. */
  readonly parts: NativeAgentProjectionParts;
  /** Joined progressive reads, their epochs, metrics and shared provider snapshots. */
  readonly reads: NativeAgentProgressiveReads;
  readonly transcript: NativeAgentProgressiveTranscript;
  readonly sessionState: NativeAgentProgressiveSessionState;
  readonly discovery: NativeAgentProgressiveDiscovery;
  readonly history: NativeAgentHistoryPages;
  readonly toolDetails: NativeAgentToolDetailReads;
  readonly full: NativeAgentFullProjection;
}

/** Serialized body plus the cache's reference and bookkeeping allowance. */
export function toolDetailEntryBytes(serializedBytes: number, localImagePath = ""): number {
  return serializedBytes + Buffer.byteLength(localImagePath) + 64;
}

export interface ProjectedProgressiveTranscript {
  value: NativeAgentTranscriptView;
  historyStartIndex?: number;
  historyEndIndex?: number;
  /** Artifact ledger revision the view's artifact parts reflect. */
  ledgerRevision?: number;
  /** Ids in `value.revisedMessages` sent because a publication reached them. */
  ledgerRevisedIds?: readonly string[];
  /** The content sequence of the view this projection keeps unchanged, if it keeps one. */
  keptContentSequence?: number;
  /** What the view's direct `historyCursor` was minted from. */
  directCursor?: DirectCursorSource;
}

/**
 * The input a view's direct cursor was minted from. A kept view mints it again
 * when it is served, so an overlong provider cursor whose handle the bounded
 * store has since evicted is held again rather than handed out dead.
 */
export type DirectCursorSource = {
  sessionKey: string;
  providerSessionId: string;
  historyEpoch: string;
  providerCursor: string;
};

/**
 * Whether user rows of this runtime may open with a server-authored context
 * block: a coordinator conversation's, or a bug report's pointer to its
 * briefing. Both use the coordinator context tags.
 */
export function hasServerPromptPreamble(environmentId: string): boolean {
  return Boolean(
    coordinatorIdFromRuntimeId(environmentId) || bugReportIdFromRuntimeId(environmentId),
  );
}

export type PromptPresentationKind = NonNullable<
  PersistedNativeAgentSession["initialPromptPresentation"]
>["kind"];

/** A provider transcript row after `projectionMessages` validated its shape. */
export type ProviderTranscriptRow = Record<string, unknown> & {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  parts: unknown[];
  createdAt: string;
};

export interface ProjectedTranscriptMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  parts: unknown[];
  createdAt: string;
  modelId?: string;
  turnId?: string;
  planReview?: boolean;
  promptPresentation?: PromptPresentationKind;
}

export type ProgressiveTranscriptEntry = {
  token: string;
  sourceToken?: string;
  value: NativeAgentTranscriptView;
  bytes: number;
  historyStartIndex?: number;
  historyEndIndex?: number;
  ledgerRevision?: number;
  ledgerRevisedIds?: readonly string[];
  directCursor?: DirectCursorSource;
  /**
   * Moves only when the view's content does, not when a held preview, an
   * `unchanged` answer or an artifact overlay re-commits the same content
   * under a new token. A head-row recovery compares it to decide whether what
   * it read is still no older than what the view shows (to-do 7845 (retired), task 2).
   */
  contentSequence: number;
};

/** One deferred detail: an inline body, an image path or a provider locator. */
export type ToolDetailCacheEntry = {
  sessionKey: string;
  details: NativeAgentToolDetails;
  bytes: number;
  /** Exact provider-reported image path; never supplied by the renderer. */
  localImagePath?: string;
  /**
   * A provider-held body behind a summary locator, fetched on first
   * expansion. `resolved` once `details` holds the exact body.
   */
  remote?: { providerSessionId: string; locator: string; resolved: boolean };
};

export type ProgressiveHydrationEntry = {
  sourceToken: string;
  snapshot?: ProviderTranscriptSnapshot;
  promise?: Promise<void>;
  attempts: number;
  holdPreview: boolean;
};

/** A projection session resolved against storage and its runtime provider. */
export interface ResolvedProjectionSession {
  key: string;
  session: PersistedNativeAgentSession;
  provider: NativeAgentRuntimeProvider;
  transient: false;
}

/** What the transcript projection needs from the service that wires it. */
export interface NativeAgentTranscriptProjectionHost {
  storage: StorageService;
  options: NativeAgentServiceOptions;
  catalogs: NativeAgentCatalogCache;
  /** A provider already serving this runtime; never starts a bridge. */
  cachedProvider?(input: NativeAgentProjectionInput): NativeAgentRuntimeProvider | undefined;
  /** Last provider-owned activity; read without touching the provider. */
  observedActivity(
    sessionKey: string,
  ): { providerSessionId: string; contentRevision?: string } | undefined;
  /** The bridge generation serving this environment and agent, if a provider is cached. */
  providerGeneration(
    input: Pick<NativeAgentProjectionInput, "environmentId" | "agent">,
  ): string | undefined;
  now(): number;
  isStopped(): boolean;
  assertProjectionInput(input: NativeAgentProjectionInput): void;
  resolveProjectionSession(
    input: NativeAgentProjectionInput,
  ): Promise<ResolvedProjectionSession | null>;
  provider(input: EnsureNativeAgentSessionInput): Promise<NativeAgentRuntimeProvider>;
  recordAsyncQuestionAttention(
    environmentId: string,
    sessionKey: string,
    itemIds: readonly string[],
    /** The session's logical key, which the unread badge is attributed to. */
    logicalSessionKey?: string,
  ): Promise<void>;
  /** Settle a parked prompt dispatch against its provider in the background. */
  scheduleAmbiguousDispatchSettle(
    input: NativeAgentProjectionInput,
    key: string,
    requestId: string,
    provider: NativeAgentRuntimeProvider,
  ): void;
  /** Settle a parked steer against its provider in the background. */
  scheduleAmbiguousSteerSettle(
    input: NativeAgentProjectionInput,
    key: string,
    requestId: string,
    provider: NativeAgentRuntimeProvider,
  ): void;
  /**
   * Orkestrator's permission rules (todo 0723 (retired)): answers the pending requests a
   * rule covers before any card is built, and offers "Approve and remember"
   * on the rest. Absent in tests that do not wire it.
   */
  permissionRules?: PermissionRuleEnforcer;
}

/** The goal a view shows. The session record is the only place it lives. */
export function goalProjectionField(session: PersistedNativeAgentSession) {
  const goal = sessionGoal(session);
  return goal ? { goal: goalPublicView(goal) } : {};
}

/** One provider snapshot joined by the reads of a session that overlap it. */
export interface InteractiveSnapshotShare {
  promise: Promise<ProviderInteractiveSnapshot>;
  sessionKey: string;
  epoch: number;
  degraded: true;
  settled?: true;
}

/** Whether `next` names a row the previous view did not carry in exactly this form. */
export function revisedRowsChanged(
  previous: readonly unknown[],
  next: readonly unknown[],
): boolean {
  const held = new Map(
    previous.map((message) => [(message as { id?: unknown }).id, message] as const),
  );
  return next.some((message) => {
    const before = held.get((message as { id?: unknown }).id);
    return before === undefined || !sameEncoding(before, message);
  });
}

/**
 * Carry the bridge's premium-pricing indicator onto the projected composer.
 *
 * The bridge computes it for *its* selection. The projection can override that
 * selection with stored or pending controls, and an indicator describing a
 * different combination would be wrong in both directions, so it is kept only
 * when model, reasoning, speed and parameters all agree with the bridge's.
 */
export function withProviderSelectionPricing(
  composer: NativeAgentComposerState,
  providerComposer: NativeAgentComposerState | undefined,
): NativeAgentComposerState {
  const pricing = normalizeNativeAgentSelectionPricing(providerComposer?.selectionPricing);
  if (!pricing || !providerComposer) return composer;
  const providerValues = providerComposer.parameterValues ?? {};
  const sameSelection =
    composer.selectedModelId === providerComposer.selectedModelId &&
    composer.selectedReasoningId === providerComposer.selectedReasoningId &&
    // The projection shows an untouched speed toggle as off where the bridge
    // still holds "never chosen"; both mean the default, standard-speed run.
    (composer.fastModeEnabled ?? false) === (providerComposer.fastModeEnabled ?? false) &&
    Object.entries(composer.parameterValues ?? {}).every(
      ([id, value]) => providerValues[id] === value,
    );
  return sameSelection ? { ...composer, selectionPricing: pricing } : composer;
}
