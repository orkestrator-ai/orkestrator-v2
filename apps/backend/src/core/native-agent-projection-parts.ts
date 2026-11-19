import { bugReportIdFromRuntimeId } from "@orkestrator/protocol/bug-report";
import { bugReportInitialApprovalMode, validBugReportApprovalMode } from "./bug-report-runtime.js";
import * as shared from "./native-agent-service-shared.js";
import type {
  NativeAgentComposerState,
  NativeAgentControlUpdate,
  NativeAgentMessageWindow,
  NativeAgentToolDetails,
  PersistedNativeAgentSession,
  StorageService,
  NativeAgentRuntimeProvider,
  NativeAgentProjectionInput,
  NativeAgentServiceOptions,
  NativeAgentMessagePage,
} from "./native-agent-service-shared.js";
import {
  nativeCapabilities,
  createHash,
  NATIVE_DISCOVERY_RETRY_MS,
  NATIVE_PROJECTION_MAX_BYTES,
  NATIVE_FILE_DETAIL_MAX_BYTES,
  inlineFileContentLabel,
  inlineFileUrlDisposition,
  NATIVE_TOOL_DETAIL_CACHE_MAX_BYTES,
  NATIVE_TOOL_DETAIL_CACHE_MAX_ENTRIES,
  NATIVE_TOOL_DETAIL_MAX_BYTES,
  NATIVE_PROJECTED_MESSAGE_CACHE_MAX_BYTES,
  NATIVE_PROJECTED_MESSAGE_CACHE_MAX_ENTRIES,
  NATIVE_PROJECTED_MESSAGE_CACHE_MAX_ENTRY_BYTES,
  NATIVE_PROJECTED_MESSAGE_CACHE_MAX_SESSION_BYTES,
  NATIVE_PROJECTED_MESSAGE_CACHE_MAX_SESSION_ENTRIES,
  NATIVE_DIRECT_PAGE_CACHE_MAX_BYTES,
  NATIVE_DIRECT_PAGE_CACHE_MAX_ENTRIES,
  NATIVE_DIRECT_PAGE_CACHE_MAX_SESSION_BYTES,
  NATIVE_DIRECT_PAGE_CACHE_MAX_SESSION_ENTRIES,
  NATIVE_DIRECT_PAGE_CACHE_TTL_MS,
  ProviderUnavailableError,
  boundTranscriptResponse,
  resolveReasoningId,
} from "./native-agent-service-shared.js";
import {
  findRemoteDetailRegistration,
  REMOTE_DETAIL_REF_PREFIX,
} from "./native-agent-remote-detail-recovery.js";
import {
  resolveNativeComposerModelId,
  withResolvedNativeComposerModel,
  nativeAgentApprovalModes,
  resolveNativeAgentApprovalMode,
} from "@orkestrator/protocol/native-agent";
import type { NativeAgentCatalogCache } from "./native-agent-catalog-cache.js";
import { legacyCompatibilityCounts } from "./change-tracking/index.js";
import { claudeReasoningSelection } from "@orkestrator/protocol/claude-model-catalog";
import { type AgentInteractionSnapshot } from "@orkestrator/protocol/agent-interactions";
import { parseCoordinatorDelegatedPrompt } from "@orkestrator/protocol/review-evidence-frames";
import { inferredComposerSelectionToPersist } from "./native-agent-composer-selection.js";
import { nativeAgentPlatformPolicy } from "./native-agent-platform-policy.js";
import { heldSessionModel } from "./session-held-model.js";
import { readBridgePartDetail as bridgePartDetail } from "@orkestrator/protocol/node/bridge-transcript-summary";
import {
  DirectHistoryPageCache,
  DirectHistoryCursorHandles,
} from "./native-agent-direct-history.js";
import {
  ArtifactOverlayIndex,
  overlayArtifactParts,
  type ArtifactOverlay,
} from "./native-agent-service-projection-artifacts.js";
import {
  ProjectedMessageCache,
  copyProjectionSource,
  type ProjectionDetailRegistration,
  type ProjectionEntryContext,
} from "./native-agent-projection-entries.js";
import {
  NATIVE_TOOL_DETAIL_MEMO_LIMITS,
  ToolDetailEncodingMemo,
  type ToolDetailEncoding,
} from "./native-agent-tool-detail-memo.js";
import { encodedValue } from "./native-agent-projection-encoding.js";
import {
  attachProgressToToolRows,
  backgroundTaskIdFromProjectedLaunch,
  displayMessage,
  modelCatalogKey,
  providerReportedImagePath,
  redactArtifactGrant,
} from "./native-agent-projection-helpers.js";
import {
  deferredThinkingPreview,
  deferredToolArgsPreview,
} from "./native-agent-deferred-display.js";
import {
  toolDetailEntryBytes,
  type PromptPresentationKind,
  type ProviderTranscriptRow,
  type ProjectedTranscriptMessage,
  type ToolDetailCacheEntry,
  type NativeAgentTranscriptProjectionHost,
  withProviderSelectionPricing,
  type NativeAgentProjectionContext,
} from "./native-agent-projection-context.js";

/**
 * The one owner of the caches every read model builds views from: tool
 * details (with their encodings and pins), projected rows, direct history
 * pages and their cursor handles, and artifact overlays. Also the row and
 * composer projection steps that fill them, which the full projection, the
 * progressive transcript and state reads, direct pages and tool details share.
 *
 * Every cache here is bounded and reconstructible: providers stay
 * authoritative, so dropping any of it costs a re-read, never user state.
 */
export class NativeAgentProjectionParts {
  private readonly host: NativeAgentTranscriptProjectionHost;
  private readonly storage: StorageService;
  private readonly options: NativeAgentServiceOptions;
  private readonly catalogs: NativeAgentCatalogCache;

  constructor(context: NativeAgentProjectionContext) {
    this.host = context.host;
    this.storage = context.storage;
    this.options = context.options;
    this.catalogs = context.catalogs;
    this.toolDetailEncodings = new ToolDetailEncodingMemo({
      ...NATIVE_TOOL_DETAIL_MEMO_LIMITS,
      ...this.options.toolDetailMemoLimits,
    });
    this.projectedMessages = new ProjectedMessageCache({
      maxEntries: NATIVE_PROJECTED_MESSAGE_CACHE_MAX_ENTRIES,
      maxBytes: NATIVE_PROJECTED_MESSAGE_CACHE_MAX_BYTES,
      maxSessionEntries: NATIVE_PROJECTED_MESSAGE_CACHE_MAX_SESSION_ENTRIES,
      maxSessionBytes: NATIVE_PROJECTED_MESSAGE_CACHE_MAX_SESSION_BYTES,
      maxEntryBytes: NATIVE_PROJECTED_MESSAGE_CACHE_MAX_ENTRY_BYTES,
      ...this.options.projectedMessageCacheLimits,
    });
    this.directHistoryPages = new DirectHistoryPageCache({
      maxEntries: NATIVE_DIRECT_PAGE_CACHE_MAX_ENTRIES,
      maxBytes: NATIVE_DIRECT_PAGE_CACHE_MAX_BYTES,
      maxSessionEntries: NATIVE_DIRECT_PAGE_CACHE_MAX_SESSION_ENTRIES,
      maxSessionBytes: NATIVE_DIRECT_PAGE_CACHE_MAX_SESSION_BYTES,
      ttlMs: NATIVE_DIRECT_PAGE_CACHE_TTL_MS,
      ...this.options.directHistoryPageCacheLimits,
    });
  }

  /** Test-only view of the caches this owner holds; production code must not call it. */
  forTesting() {
    return {
      projectedMessages: this.projectedMessages,
      directHistoryPages: this.directHistoryPages,
      directHistoryCursorHandles: this.directHistoryCursorHandles,
      toolDetailCache: this.toolDetailCache,
      toolDetailCacheBytes: () => this.toolDetailCacheBytes,
      toolDetailEncodings: this.toolDetailEncodings,
      /** Simulate capacity eviction of every tool detail. */
      evictToolDetails: () => {
        this.toolDetailCache.clear();
        this.toolDetailCacheBytes = 0;
      },
      projectionPart: (sessionKey: string, messageId: string, raw: unknown, partPath: string) =>
        this.projectionPart(sessionKey, messageId, raw, partPath) as Record<string, unknown>,
    };
  }

  /** Key counts and charged bytes of the shared caches, for `native-projection` diagnostics. */
  cacheGauges(): Record<string, number> {
    return {
      directHistoryCursorHandles: this.directHistoryCursorHandles.size,
      directHistoryCursorHandleBytes: this.directHistoryCursorHandles.bytes,
      toolDetails: this.toolDetailCache.size,
      toolDetailBytes: this.toolDetailCacheBytes,
      pinnedToolDetails: this.pinnedToolDetailRefs.size,
      toolDetailEncodings: this.toolDetailEncodings.size,
      toolDetailEncodingBytes: this.toolDetailEncodings.bytes,
      projectedMessages: this.projectedMessages.size,
      projectedMessageSessions: this.projectedMessages.sessionCount,
      projectedMessageBytes: this.projectedMessages.bytes,
      directHistoryPages: this.directHistoryPages.size,
      directHistoryPageBytes: this.directHistoryPages.bytes,
      directHistorySessions: this.directHistoryPages.observedSessions,
      directHistoryReads: this.directHistoryPages.pendingReads,
      artifactOverlays: this.artifactOverlays.size,
    };
  }

  /** Drop every tool detail and its encodings (the full projection's shutdown clear). */
  clearToolDetails(): void {
    this.toolDetailCache.clear();
    this.pinnedToolDetailRefs.clear();
    this.toolDetailCacheBytes = 0;
    this.toolDetailEncodings.clear();
  }

  /** Drop projected rows, direct pages, cursor handles and overlays (the progressive shutdown clear). */
  clearRowsAndPages(): void {
    this.projectedMessages.clear();
    this.directHistoryPages.clear();
    this.directHistoryCursorHandles.clear();
    this.artifactOverlays.clear();
  }

  /** The cached detail behind a reference, if the bounded cache still holds it. */
  toolDetail(detailRef: string): ToolDetailCacheEntry | undefined {
    return this.toolDetailCache.get(detailRef);
  }

  /** Mark a detail most recently used. */
  touchToolDetail(detailRef: string, entry: ToolDetailCacheEntry): void {
    this.toolDetailCache.delete(detailRef);
    this.toolDetailCache.set(detailRef, entry);
  }

  /** Protect a reference from eviction while a refresh recreates it. */
  pinToolDetail(detailRef: string): void {
    this.pinnedToolDetailRefs.add(detailRef);
  }

  /** Release a pin and enforce the bounds it held off. */
  unpinToolDetail(detailRef: string): void {
    this.pinnedToolDetailRefs.delete(detailRef);
    this.pruneToolDetailCache();
  }

  /**
   * Remove a detail whose provider body is gone. The cache may have evicted
   * (and already un-counted) this entry while the read was in flight; only
   * remove what is still ours.
   */
  dropToolDetail(detailRef: string, entry: { readonly bytes: number }): void {
    if (this.toolDetailCache.get(detailRef) === entry) {
      this.toolDetailCache.delete(detailRef);
      this.toolDetailCacheBytes -= entry.bytes;
    }
  }

  /** Replace a detail with its resolved body, if the cache still holds the entry read. */
  replaceToolDetail(
    detailRef: string,
    entry: { readonly bytes: number },
    replacement: ToolDetailCacheEntry,
  ): void {
    const current = this.toolDetailCache.get(detailRef);
    if (current === entry) {
      this.toolDetailCacheBytes += replacement.bytes - entry.bytes;
      this.toolDetailCache.set(detailRef, replacement);
      this.pruneToolDetailCache();
    }
  }

  /**
   * Register an evicted provider-held reference again from the registration a
   * cached row or direct history page kept, with no read.
   */
  reregisterRemoteToolDetail(
    detailRef: string,
    sessionKey: string,
    now: number,
  ): ToolDetailCacheEntry | undefined {
    const registration = findRemoteDetailRegistration(detailRef, [
      ...this.projectedMessages.sessionDetails(sessionKey),
      ...Array.from(this.directHistoryPages.sessionValues(sessionKey, now), (page) => page.details),
    ]);
    if (!registration) return undefined;
    const sink = this.detailRegistrations;
    this.detailRegistrations = undefined;
    try {
      this.cacheRemoteToolDetails(sessionKey, registration.messageId, registration.partPath, {
        providerSessionId: registration.providerSessionId,
        locator: registration.locator,
      });
    } finally {
      this.detailRegistrations = sink;
    }
    return this.toolDetailCache.get(detailRef);
  }

  /**
   * Rewind, resume and replacement all land here: nothing kept for the old
   * history may be reused, and a page read still in flight is not admitted.
   */
  forgetSession(sessionKey: string): void {
    this.projectedMessages.forgetSession(sessionKey);
    this.directHistoryPages.forgetSession(sessionKey);
    this.directHistoryCursorHandles.forgetSession(sessionKey);
    this.toolDetailEncodings.forgetSession(sessionKey);
  }

  /**
   * The session's pending requests as a card list: the provider's own list,
   * minus what a permission rule just answered, with remember offers. A
   * transient read has no stored session for a rule to belong to.
   */
  pendingInteractions(resolved: {
    session: PersistedNativeAgentSession;
    provider: NativeAgentRuntimeProvider;
    transient: boolean;
  }): Promise<Pick<AgentInteractionSnapshot, "requests" | "revision">> {
    const interactions = resolved.provider.interactions;
    if (!interactions) return Promise.resolve({ requests: [], revision: 0 });
    const read = interactions.listPendingInteractions(resolved.session.providerSessionId);
    const rules = this.host.permissionRules;
    if (!rules || resolved.transient) return read;
    return read.then((snapshot) =>
      rules
        .apply(resolved.session, resolved.provider, snapshot)
        .then((applied) => applied.snapshot)
        .catch(() => snapshot),
    );
  }

  /** Provider cursors too long to wrap, named by handle (#2285). */
  readonly directHistoryCursorHandles = new DirectHistoryCursorHandles();
  /** Heavy, reconstructible fields omitted from ordinary renderer snapshots. */
  readonly toolDetailCache = new Map<string, ToolDetailCacheEntry>();
  /** Entries temporarily protected while an authoritative refresh recreates them. */
  private readonly pinnedToolDetailRefs = new Set<string>();
  private toolDetailCacheBytes = 0;
  /** Projected rows reused while their provider rows are unchanged (step 12). */
  readonly projectedMessages: ProjectedMessageCache;
  /** Detail references of inline bodies, so an unchanged one is not re-hashed. */
  private readonly toolDetailEncodings: ToolDetailEncodingMemo;
  /** Immutable direct history pages of each session's current epoch (step 11). */
  readonly directHistoryPages: DirectHistoryPageCache<{
    page: NativeAgentMessagePage;
    details: readonly ProjectionDetailRegistration[];
    /**
     * The provider's own continuation. The page's `nextCursor` is minted from
     * it again on every answer, so a held handle the bounded store evicted
     * after the page was cached is registered again rather than served dead.
     */
    providerCursor?: string;
  }>;
  /** Per-conversation publication ledger reads, keyed by ledger revision. */
  private readonly artifactOverlays = new ArtifactOverlayIndex(
    () => this.options.artifactLedger?.() ?? null,
  );
  /**
   * Collects the detail references registered while one row (or one page) is
   * projected, so a reuse can re-register them without the bodies. Projection
   * is synchronous, so a single slot cannot interleave between reads.
   */
  detailRegistrations: ProjectionDetailRegistration[] | undefined;

  /** The calls a view shows, from the service's index: a session with none costs nothing. */
  suborkProjectionField(session: PersistedNativeAgentSession) {
    const suborks = this.host.options.suborks?.views(session.key);
    return suborks ? { suborks } : {};
  }

  /**
   * Whether a parked dispatch is still reconciling or has become a final
   * failure.
   *
   * Only a prompt gets the grace window: it is the kind whose acknowledgement
   * the provider's own journal can positively confirm on a later projection
   * read. A steer is reported as a choice immediately, because its best-effort
   * settle needs a provider that answers the steer dispatch journal, and a
   * provider that never does would otherwise leave the user locked behind a
   * spinner for the whole window.
   *
   * An unparseable or future-dated timestamp is treated as final: a decision
   * the user can make beats a record that can never leave the reconciling
   * state. A timestamp ahead of the service clock (a backward clock adjustment
   * between write and read) would otherwise keep the elapsed time negative for
   * as long as the skew lasts.
   */
  recoverableDispatchStatus(
    createdAt: string,
    kind: "prompt" | "steer" = "prompt",
  ): "reconciling" | "action-required" {
    if (kind === "steer") return "action-required";
    const created = Date.parse(createdAt);
    const now = this.host.now();
    if (!Number.isFinite(created) || created > now) return "action-required";
    return now - created >= shared.PARKED_DISPATCH_RECONCILE_GRACE_MS
      ? "action-required"
      : "reconciling";
  }

  private cacheToolDetails(
    sessionKey: string,
    messageId: string,
    partPath: string,
    details: Omit<NativeAgentToolDetails, "detailRef">,
    /**
     * Per-entry ceiling. Defaults to the tool-output cap; a deferred image
     * raises it because one attachment legitimately outweighs a tool result.
     */
    options: {
      maximumBytes?: number;
      /** Exact path observed in a trusted provider transcript. */
      localImagePath?: string;
      /** The body's encoding when the caller already measured it. */
      encoding?: ToolDetailEncoding;
    } = {},
  ): string {
    // Memoized per part: an unchanged body on a re-projected row is neither
    // serialized nor hashed again. Its reference is still registered below.
    const { detailRef, serializedBytes } =
      options.encoding ??
      this.toolDetailEncodings.encode(
        sessionKey,
        messageId,
        partPath,
        details,
        options.localImagePath,
      );
    let stored: NativeAgentToolDetails = { detailRef, ...details };
    let bytes = toolDetailEntryBytes(serializedBytes, options.localImagePath);
    let storedLocalImagePath = options.localImagePath;
    if (bytes > (options.maximumBytes ?? NATIVE_TOOL_DETAIL_MAX_BYTES)) {
      stored = {
        detailRef,
        toolError: "Tool details exceeded the deferred display limit.",
      };
      storedLocalImagePath = undefined;
      bytes = Buffer.byteLength(JSON.stringify(stored));
    }

    const previous = this.toolDetailCache.get(detailRef);
    if (previous) this.toolDetailCacheBytes -= previous.bytes;
    this.toolDetailCache.delete(detailRef);
    this.toolDetailCache.set(detailRef, {
      sessionKey,
      details: stored,
      bytes,
      ...(storedLocalImagePath ? { localImagePath: storedLocalImagePath } : {}),
    });
    this.toolDetailCacheBytes += bytes;
    this.pruneToolDetailCache();
    this.detailRegistrations?.push({ ref: detailRef });
    return detailRef;
  }

  /**
   * Register a provider-held detail behind a summary locator. Nothing is read
   * until the row is expanded; the reference is stable for as long as the
   * locator is, and the locator changes whenever the body does.
   */
  private cacheRemoteToolDetails(
    sessionKey: string,
    messageId: string,
    partPath: string,
    remote: { providerSessionId: string; locator: string },
  ): string {
    // The prefix tells a miss on this reference from one on an inline body,
    // whose recovery differs (`getProjectionToolDetails`).
    const detailRef =
      REMOTE_DETAIL_REF_PREFIX +
      createHash("sha256")
        .update(`remote\0${sessionKey}\0${messageId}\0${partPath}\0${remote.locator}`)
        .digest("hex")
        .slice(0, 32);
    this.detailRegistrations?.push({
      ref: detailRef,
      remote: {
        messageId,
        partPath,
        providerSessionId: remote.providerSessionId,
        locator: remote.locator,
      },
    });
    const previous = this.toolDetailCache.get(detailRef);
    if (previous) {
      // Keep an already-fetched body; just refresh its recency.
      this.toolDetailCache.delete(detailRef);
      this.toolDetailCache.set(detailRef, previous);
      return detailRef;
    }
    const bytes = remote.locator.length + remote.providerSessionId.length + detailRef.length + 64;
    this.toolDetailCache.set(detailRef, {
      sessionKey,
      details: { detailRef },
      bytes,
      remote: { ...remote, resolved: false },
    });
    this.toolDetailCacheBytes += bytes;
    this.pruneToolDetailCache();
    return detailRef;
  }

  /**
   * Re-register the detail references a reused row or page carries, as its
   * projection would have: refresh each entry's recency, and register a
   * provider-held one again if it was evicted. False when an inline body was
   * evicted — only a fresh projection of the row can restore it.
   */
  restoreDetailRegistrations(
    sessionKey: string,
    registrations: readonly ProjectionDetailRegistration[],
  ): boolean {
    const sink = this.detailRegistrations;
    this.detailRegistrations = undefined;
    try {
      for (const registration of registrations) {
        const entry = this.toolDetailCache.get(registration.ref);
        if (entry && entry.sessionKey === sessionKey) {
          this.toolDetailCache.delete(registration.ref);
          this.toolDetailCache.set(registration.ref, entry);
          continue;
        }
        if (!registration.remote) return false;
        this.cacheRemoteToolDetails(
          sessionKey,
          registration.remote.messageId,
          registration.remote.partPath,
          {
            providerSessionId: registration.remote.providerSessionId,
            locator: registration.remote.locator,
          },
        );
      }
    } finally {
      this.detailRegistrations = sink;
    }
    sink?.push(...registrations);
    return true;
  }

  private pruneToolDetailCache(): void {
    while (
      this.toolDetailCache.size >
        (this.options.toolDetailCacheMaxEntries ?? NATIVE_TOOL_DETAIL_CACHE_MAX_ENTRIES) ||
      this.toolDetailCacheBytes >
        (this.options.toolDetailCacheMaxBytes ?? NATIVE_TOOL_DETAIL_CACHE_MAX_BYTES)
    ) {
      const oldest = [...this.toolDetailCache.keys()].find(
        (candidate) => !this.pinnedToolDetailRefs.has(candidate),
      );
      if (!oldest) break;
      const entry = this.toolDetailCache.get(oldest);
      if (entry) this.toolDetailCacheBytes -= entry.bytes;
      this.toolDetailCache.delete(oldest);
    }
  }

  private projectionPart(
    sessionKey: string,
    messageId: string,
    raw: unknown,
    partPath: string,
    /** Set when `raw` is a provider summary whose details resolve remotely. */
    remote?: { providerSessionId: string },
    /** A later part of the same row follows this one, so it stopped streaming. */
    settled = false,
  ): unknown {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
    const part = raw as Record<string, unknown>;
    const projected: Record<string, unknown> = { ...part };
    // A summary locator is provider-internal: it becomes a session-scoped
    // backend reference here and never reaches a renderer.
    delete projected.detail;
    const redactedArgs = redactArtifactGrant(part);
    if (redactedArgs) projected.toolArgs = redactedArgs;
    // Large input values and finished reasoning travel as previews; the whole
    // value is fetched when the row is expanded (native-agent-deferred-display.ts).
    // The detail holds the redacted input, never the grant.
    const argsPreview = deferredToolArgsPreview(part, projected.toolArgs);
    const argsDetails = { toolArgs: projected.toolArgs as Record<string, unknown> };
    // Keep the full value inline when the cache cannot serve it. Count JSON
    // escaping, UTF-8 and entry overhead exactly as cacheToolDetails does.
    const argsEncoding = argsPreview
      ? this.toolDetailEncodings.encode(sessionKey, messageId, `${partPath}/args`, argsDetails)
      : undefined;
    if (
      argsEncoding &&
      toolDetailEntryBytes(argsEncoding.serializedBytes) <= NATIVE_TOOL_DETAIL_MAX_BYTES
    ) {
      projected.toolArgsDetailRef = this.cacheToolDetails(
        sessionKey,
        messageId,
        `${partPath}/args`,
        argsDetails,
        { encoding: argsEncoding },
      );
      projected.toolArgs = argsPreview;
    }
    const thinkingPreview = deferredThinkingPreview(part, settled);
    const thinkingDetails = { thinking: part.content as string };
    const thinkingEncoding =
      thinkingPreview === undefined
        ? undefined
        : this.toolDetailEncodings.encode(
            sessionKey,
            messageId,
            `${partPath}/thinking`,
            thinkingDetails,
          );
    if (
      thinkingEncoding &&
      toolDetailEntryBytes(thinkingEncoding.serializedBytes) <= NATIVE_TOOL_DETAIL_MAX_BYTES
    ) {
      projected.contentDetailRef = this.cacheToolDetails(
        sessionKey,
        messageId,
        `${partPath}/thinking`,
        thinkingDetails,
        { encoding: thinkingEncoding },
      );
      projected.content = thinkingPreview;
    }
    const summaryDetail = remote ? bridgePartDetail(part.detail) : undefined;
    if (summaryDetail && remote) {
      projected.detailRef = this.cacheRemoteToolDetails(sessionKey, messageId, partPath, {
        providerSessionId: remote.providerSessionId,
        locator: summaryDetail.locator,
      });
    }
    const deferredImagePath = providerReportedImagePath(part);
    const backgroundTaskId = backgroundTaskIdFromProjectedLaunch(part);
    if (backgroundTaskId) projected.backgroundTaskId = backgroundTaskId;

    /*
     * A file/image part can name its bytes three ways: a readable workspace
     * path, an inline data URL, or a remote URL. The live window must never be
     * dominated by inline bytes, because a single pasted screenshot is larger
     * than the whole 512 KiB target and would evict every other message.
     *
     * - A readable path is the durable reference: the renderer re-reads the
     *   file, so the inline copy is pure duplication.
     * - With no path (OpenCode persists a pasted attachment as a bare filename
     *   plus a data URL) the bytes only exist inline. Move them behind a detail
     *   reference the renderer fetches on demand, provided they still fit the
     *   detail cache; an oversized image keeps its inline copy rather than
     *   losing its preview entirely.
     * - Remote URLs are already a reference and stay put.
     */
    const fileUrlDisposition = inlineFileUrlDisposition(part);
    if (fileUrlDisposition === "drop") {
      delete projected.fileUrl;
    } else if (fileUrlDisposition === "defer") {
      delete projected.fileUrl;
      projected.detailRef = this.cacheToolDetails(
        sessionKey,
        messageId,
        partPath,
        { fileDataUrl: part.fileUrl as string },
        { maximumBytes: NATIVE_FILE_DETAIL_MAX_BYTES },
      );
    }
    /*
     * OpenCode falls back to the part's `url` for `content` when it has no
     * filename, so a data-URL attachment arrives with its bytes duplicated in
     * both `content` and `fileUrl`. Moving `fileUrl` behind a reference is not
     * enough: the live copy would still carry the whole payload and the
     * renderer's display name would be a multi-megabyte string. Substitute a
     * short label whenever `content` is itself the data URL.
     */
    const contentLabel = inlineFileContentLabel(part);
    if (contentLabel !== undefined) projected.content = contentLabel;

    const rawDiff =
      part.toolDiff && typeof part.toolDiff === "object" && !Array.isArray(part.toolDiff)
        ? (part.toolDiff as Record<string, unknown>)
        : undefined;
    const hasHeavyDiff = Boolean(
      rawDiff &&
      (typeof rawDiff.diff === "string" ||
        typeof rawDiff.before === "string" ||
        typeof rawDiff.after === "string"),
    );
    if (typeof part.toolOutput === "string" || typeof part.toolError === "string" || hasHeavyDiff) {
      projected.detailRef = this.cacheToolDetails(sessionKey, messageId, partPath, {
        ...(typeof part.toolOutput === "string" ? { toolOutput: part.toolOutput } : {}),
        ...(typeof part.toolError === "string" ? { toolError: part.toolError } : {}),
        ...(rawDiff ? { toolDiff: rawDiff } : {}),
      });
      delete projected.toolOutput;
      delete projected.toolError;
      if (rawDiff) {
        // Older clients read these counts: give them backend CountPolicyV1
        // numbers (or none), never the bridges' whole-side totals.
        const counts = hasHeavyDiff
          ? legacyCompatibilityCounts(projected.detailRef as string, {
              toolName: typeof part.toolName === "string" ? part.toolName : undefined,
              filePath: typeof rawDiff.filePath === "string" ? rawDiff.filePath : undefined,
              before: typeof rawDiff.before === "string" ? rawDiff.before : undefined,
              after: typeof rawDiff.after === "string" ? rawDiff.after : undefined,
              diff: typeof rawDiff.diff === "string" ? rawDiff.diff : undefined,
              additions: typeof rawDiff.additions === "number" ? rawDiff.additions : undefined,
              deletions: typeof rawDiff.deletions === "number" ? rawDiff.deletions : undefined,
            })
          : {
              ...(typeof rawDiff.additions === "number" ? { additions: rawDiff.additions } : {}),
              ...(typeof rawDiff.deletions === "number" ? { deletions: rawDiff.deletions } : {}),
            };
        projected.toolDiff = {
          ...(typeof rawDiff.filePath === "string" ? { filePath: rawDiff.filePath } : {}),
          ...counts,
          // Without this the renderer cannot tell a stripped diff from a
          // location-only hint, and every provider that identifies a file
          // mutation by diff content rather than tool name loses its edit
          // treatment until the row is expanded.
          ...(hasHeavyDiff ? { deferred: true } : {}),
        };
      }
    }

    if (deferredImagePath) {
      const imageDetailRef = this.cacheToolDetails(
        sessionKey,
        messageId,
        `${partPath}/image`,
        {},
        { localImagePath: deferredImagePath },
      );
      if (part.type === "tool-invocation") projected.imageDetailRef = imageDetailRef;
      else if (part.type === "image") projected.detailRef = imageDetailRef;
    }

    for (const field of ["parts", "childTools", "subagentActions"] as const) {
      if (!Array.isArray(part[field])) continue;
      projected[field] = part[field].map((child, index) =>
        this.projectionPart(sessionKey, messageId, child, `${partPath}/${field}/${index}`, remote),
      );
    }
    if (part.task && typeof part.task === "object" && !Array.isArray(part.task)) {
      projected.task = this.projectionPart(
        sessionKey,
        messageId,
        part.task,
        `${partPath}/task`,
        remote,
      );
    }
    return projected;
  }

  /**
   * One validated provider row, projected — or the projection kept from an
   * earlier read of an identical row in the same context (see
   * `native-agent-projection-entries.ts`). A miss projects from a private copy
   * of the row, so the value kept for later reads shares nothing a provider
   * could mutate afterwards.
   */
  private projectedMessage(
    context: ProjectionEntryContext,
    message: ProviderTranscriptRow,
    promptPresentation: PromptPresentationKind | undefined,
    remote: { providerSessionId: string } | undefined,
  ): ProjectedTranscriptMessage {
    const cached = this.projectedMessages.lookup(context, message.id, message, promptPresentation);
    if (cached && this.restoreDetailRegistrations(context.sessionKey, cached.details)) {
      return cached.projected as ProjectedTranscriptMessage;
    }
    const source = this.projectedMessages.enabled ? copyProjectionSource(message) : undefined;
    const row = (source?.copy ?? message) as ProviderTranscriptRow;
    const sink = this.detailRegistrations;
    const details: ProjectionDetailRegistration[] = [];
    this.detailRegistrations = details;
    let projected: ProjectedTranscriptMessage;
    try {
      const projectedParts = attachProgressToToolRows(
        row.parts.map((part, index) =>
          this.projectionPart(
            context.sessionKey,
            row.id,
            part,
            String(index),
            remote,
            index < row.parts.length - 1,
          ),
        ),
      );
      const projectedMessage: ProjectedTranscriptMessage = {
        id: row.id,
        role: row.role,
        content: row.content,
        parts: projectedParts,
        createdAt: row.createdAt,
        ...(typeof row.modelId === "string" ? { modelId: row.modelId } : {}),
        ...(typeof row.turnId === "string" ? { turnId: row.turnId } : {}),
        ...(typeof row.planReview === "boolean" ? { planReview: row.planReview } : {}),
        ...(promptPresentation ? { promptPresentation } : {}),
      };
      projected = displayMessage(projectedMessage, Boolean(context.coordinator));
    } finally {
      this.detailRegistrations = sink;
    }
    sink?.push(...details);
    if (source) {
      let encodedBytes: number | undefined;
      try {
        // Memoized: every later measurement of this row reuses it.
        encodedBytes = encodedValue(projected).bytes;
      } catch {
        // Not serializable: the window bound below reports it; keep it uncached.
      }
      if (encodedBytes !== undefined) {
        this.projectedMessages.store(context, message.id, source, promptPresentation, {
          projected,
          details,
          encodedBytes,
        });
      }
    }
    return projected;
  }

  projectionMessages(
    sessionKey: string,
    messages: unknown[],
    limit: number,
    maximumBytes = NATIVE_PROJECTION_MAX_BYTES,
    initialPromptPresentation?: PersistedNativeAgentSession["initialPromptPresentation"],
    coordinatorTranscript = false,
    remote?: { providerSessionId: string },
    /**
     * Publications placed beside their calls after the per-row cache. Omit
     * for a read whose projected rows are themselves cached (history pages):
     * those apply the overlay on the way out instead.
     */
    artifactOverlay?: ArtifactOverlay | null,
  ): { messages: unknown[]; window: NativeAgentMessageWindow } {
    const firstUserMessageIndex = messages.findIndex(
      (candidate) =>
        candidate !== null &&
        typeof candidate === "object" &&
        !Array.isArray(candidate) &&
        (candidate as Record<string, unknown>).role === "user",
    );
    const requestedStart = Math.max(0, messages.length - limit);
    const context: ProjectionEntryContext = {
      sessionKey,
      ...(remote ? { remoteSessionId: remote.providerSessionId } : {}),
      coordinator: coordinatorTranscript,
    };
    const projectedRows = messages.slice(requestedStart).map((raw, requestedIndex) => {
      const message =
        raw && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : null;
      const role = message?.role;
      if (
        !message ||
        typeof message.id !== "string" ||
        (role !== "user" && role !== "assistant" && role !== "system") ||
        typeof message.content !== "string" ||
        !Array.isArray(message.parts) ||
        typeof message.createdAt !== "string"
      ) {
        throw new ProviderUnavailableError("Provider returned a non-normalized native transcript");
      }
      const parsedDelegation =
        requestedStart + requestedIndex === firstUserMessageIndex && initialPromptPresentation
          ? parseCoordinatorDelegatedPrompt(message.content)
          : null;
      const promptPresentation =
        initialPromptPresentation && parsedDelegation?.frame === initialPromptPresentation.frame
          ? initialPromptPresentation.kind
          : undefined;
      return this.projectedMessage(
        context,
        message as ProviderTranscriptRow,
        promptPresentation,
        remote,
      );
    });
    // Never written back into the per-row cache: an overlaid row is a new
    // object, valid only for the ledger read that produced it.
    const requested = overlayArtifactParts(projectedRows, artifactOverlay);
    let boundedTranscript;
    try {
      boundedTranscript = boundTranscriptResponse(requested, maximumBytes, {
        // The bound applies to the bare message array; the surrounding
        // projection is not what this ceiling protects.
        envelopeReserveBytes: 0,
        // Projected rows are immutable: measure them once for every consumer.
        measure: (message) => encodedValue(message).bytes,
        // A half-rendered final message is worse than an explicit failure here:
        // the renderer has a recovery path for an unavailable projection, and
        // the bridges have already bounded their own responses well below this.
        contentFallbackBytes: null,
      });
    } catch (error) {
      /*
       * The bound's only failure mode is the `JSON.stringify` it uses to
       * measure, which throws a `TypeError` on a circular structure or a
       * BigInt. The normalized provider contract is JSON, so that is a
       * transport violation rather than something to leak to a renderer.
       * Measuring separately up front just to say so would serialize the whole
       * transcript twice on every refresh.
       */
      if (!(error instanceof TypeError)) throw error;
      throw new ProviderUnavailableError("Provider returned a non-serializable native transcript");
    }
    const { messages: bounded, messageWindow, overflowed } = boundedTranscript;
    if (overflowed) {
      throw new ProviderUnavailableError(
        "Provider transcript contains one message body larger than 16 MiB",
      );
    }
    const omittedParts = messageWindow.omittedParts ?? 0;
    const truncatedByCount = messages.length > requested.length;
    const droppedByBytes = bounded.length < requested.length;
    const truncatedByBytes = droppedByBytes || omittedParts > 0;
    const omittedMessages = messages.length - bounded.length;
    const truncated = truncatedByCount || truncatedByBytes;
    return {
      messages: bounded,
      window: {
        limit,
        truncated,
        /*
         * Whether a larger `limit` can actually reveal more messages, which is
         * not the same question as whether anything was truncated. Only the
         * count slice responds to the limit: once the byte ceiling has dropped
         * whole messages, widening the slice returns the identical set, and a
         * client that read `truncated` alone put an inert control on screen.
         * Trimmed parts are not that case — every requested message is still
         * present, so the limit is still the binding constraint.
         *
         * Reported only for a truncated window, where it is the answer to a
         * question the caller is actually asking.
         */
        ...(truncated ? { canLoadEarlier: truncatedByCount && !droppedByBytes } : {}),
        ...(truncatedByBytes
          ? {
              truncationReason: "bytes" as const,
              ...(omittedMessages > 0 ? { omittedMessages } : {}),
              ...(omittedParts > 0 ? { omittedParts } : {}),
            }
          : truncatedByCount
            ? { truncationReason: "count" as const }
            : {}),
      },
    };
  }

  boundedProjectedMessages(
    messages: unknown[],
    limit: number,
    maximumBytes: number,
  ): { messages: unknown[]; window: NativeAgentMessageWindow } {
    let boundedTranscript;
    const requested = messages.slice(-limit) as Array<{
      content: string;
      parts: unknown[];
    }>;
    try {
      boundedTranscript = boundTranscriptResponse(requested, maximumBytes, {
        envelopeReserveBytes: 0,
        contentFallbackBytes: null,
        measure: (message) => encodedValue(message).bytes,
      });
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      throw new ProviderUnavailableError("Provider returned a non-serializable native transcript");
    }
    // A single valid message may exceed the soft live/page target. The hard
    // transcript limit was already enforced while normalizing history.
    const omittedParts = boundedTranscript.overflowed
      ? 0
      : (boundedTranscript.messageWindow.omittedParts ?? 0);
    const messagesInWindow = boundedTranscript.overflowed
      ? requested.slice(-1)
      : boundedTranscript.messages;
    const omitted = messages.length - messagesInWindow.length;
    const truncatedByCount = messages.length > requested.length;
    const droppedByBytes = messagesInWindow.length < requested.length || omittedParts > 0;
    const truncated = omitted > 0 || omittedParts > 0;
    return {
      messages: messagesInWindow,
      window: {
        limit,
        truncated,
        ...(truncated
          ? {
              /*
               * Only a count slice responds to a larger `limit`. Part-trimming
               * and whole-message byte drops return the same set when the
               * caller asks for more, so the load-earlier control must stay
               * off — it cannot restore omitted leading parts of the live head.
               */
              canLoadEarlier: truncatedByCount && !droppedByBytes,
              truncationReason:
                truncatedByCount && !droppedByBytes ? ("count" as const) : ("bytes" as const),
              ...(omitted > 0 ? { omittedMessages: omitted } : {}),
              ...(omittedParts > 0 ? { omittedParts } : {}),
            }
          : {}),
      },
    };
  }

  artifactOverlay(input: {
    environmentId: string;
    logicalSessionKey: string;
  }): ArtifactOverlay | null {
    return this.artifactOverlays.overlay(input.environmentId, input.logicalSessionKey);
  }

  /**
   * `turn.quietObservation`: the activity observer holds a content revision
   * for this provider session, so every change to its idle view is announced
   * (`onObservationInvalidation`) and the view may read less often. Absent
   * before the first observation and for a bridge that reports none.
   */
  quietObservationFlag(session: PersistedNativeAgentSession): {
    quietObservation?: true;
  } {
    const observed = this.host.observedActivity(session.key);
    return observed?.providerSessionId === session.providerSessionId &&
      observed.contentRevision !== undefined
      ? { quietObservation: true }
      : {};
  }

  async projectionComposer(
    input: NativeAgentProjectionInput,
    session: PersistedNativeAgentSession,
    providerComposer?: NativeAgentComposerState,
    providerControls?: NativeAgentControlUpdate,
    discoveryInBackground = false,
    hints: {
      lastAssistantModelId?: string;
      lastAssistantReasoningId?: string;
      sessionModelId?: string;
      sessionReasoningId?: string;
      persistSelection?: boolean;
    } = {},
  ): Promise<NativeAgentComposerState> {
    let models = providerComposer?.models ?? [];
    if (models.length === 0) {
      const cached = this.catalogs.cachedModels(input.environmentId);
      if (cached) {
        models = cached.models.filter((model) => model.platform === input.agent);
        if (cached.expiresAt <= this.host.now()) {
          // Model discovery can probe several runtimes and take seconds. An
          // expired entry is still perfectly adequate for rendering the
          // transcript and existing picker selection, so refresh it out of the
          // transcript-critical path. The next projection poll observes the
          // refreshed catalogue.
          void this.catalogs
            .refreshModels(input.environmentId)
            .then((refreshed) => {
              // The same catalogue changes no view; announcing it would wake
              // every idle view of the environment once per TTL.
              if (
                !this.host.isStopped() &&
                modelCatalogKey(refreshed) !== modelCatalogKey(cached.models)
              ) {
                this.storage.announceNativeAgentSessionProjection(
                  input.environmentId,
                  "model-catalog-refresh",
                );
              }
            })
            .catch(() => {
              this.catalogs.retryModelsAfter(
                input.environmentId,
                cached,
                NATIVE_DISCOVERY_RETRY_MS,
              );
            });
        }
      } else {
        const refresh = this.catalogs.refreshModels(input.environmentId);
        if (discoveryInBackground) {
          void refresh
            .then(() => {
              if (!this.host.isStopped()) {
                this.storage.announceNativeAgentSessionProjection(
                  input.environmentId,
                  "model-catalog-load",
                  {
                    agent: input.agent,
                    logicalSessionKey: input.logicalSessionKey,
                  },
                );
              }
            })
            .catch(() => undefined);
        } else {
          try {
            const bounded = await refresh;
            models = bounded.filter((model) => model.platform === input.agent);
          } catch {
            // A stale or unavailable catalog must not hide the transcript.
          }
        }
      }
    }
    const sessionSelectionHints =
      nativeAgentPlatformPolicy(input.agent).infersComposerSelection === true;
    const selectedModelId = resolveNativeComposerModelId({
      providerControlsModelId: providerControls?.modelId,
      sessionControlsModelId: session.controls?.modelId,
      ...(sessionSelectionHints
        ? {
            lastAssistantModelId: hints.lastAssistantModelId,
            sessionModelId: hints.sessionModelId,
            inferredModelId: session.inferredComposerSelection?.modelId,
          }
        : {}),
      catalogDefaultModelId: providerComposer?.selectedModelId,
      firstCatalogModelId: models[0]?.id,
    });
    if (
      nativeAgentPlatformPolicy(input.agent).runsSessionHeldModel === true &&
      selectedModelId &&
      models.length > 0 &&
      !models.some((model) => model.id === selectedModelId)
    ) {
      models = [...models, heldSessionModel(input.agent, selectedModelId)];
    }
    const resolvedSelection = withResolvedNativeComposerModel(models, selectedModelId, input.agent);
    models = resolvedSelection.models;
    const selectedModel = resolvedSelection.selectedModel;
    if (hints.persistSelection && sessionSelectionHints) {
      const persist = inferredComposerSelectionToPersist({
        sessionControlsModelId: session.controls?.modelId,
        lastAssistantModelId: hints.lastAssistantModelId,
        lastAssistantReasoningId: hints.lastAssistantReasoningId,
        sessionModelId: hints.sessionModelId,
        sessionReasoningId: hints.sessionReasoningId,
      });
      if (persist) {
        void this.storage
          .initializeNativeAgentSessionInferredComposerIfAbsent(
            session.key,
            session.providerSessionId,
            persist,
          )
          .catch(() => undefined);
      }
    }
    const storedReasoningId =
      providerControls?.reasoningId ??
      session.controls?.reasoningId ??
      (sessionSelectionHints
        ? (hints.lastAssistantReasoningId ??
          hints.sessionReasoningId ??
          session.inferredComposerSelection?.reasoningId)
        : undefined) ??
      providerComposer?.selectedReasoningId ??
      // The advertised default matters for Cursor/Grok, where it carries the
      // agent's own current effort rather than a static catalog value.
      resolveReasoningId(
        selectedModel?.reasoning ?? [],
        undefined,
        selectedModel?.defaultReasoningId,
      ) ??
      selectedModel?.defaultReasoningId;
    const selectedReasoningId =
      input.agent === "claude"
        ? claudeReasoningSelection(storedReasoningId, session.controls?.parameterValues)
        : storedReasoningId;
    const capabilities = nativeCapabilities(input.agent);
    // The compose bar renders `fastModeAvailable` directly, so the table has to
    // be consulted here and not only in `nativeComposerControls`. Without it a
    // provider that grew a fast surface would show the toggle on a platform the
    // table says has none, and `updateProjectionControls` would then accept the
    // patch because its own guard reads this same field.
    const supportsSpeed =
      capabilities.composer.speed &&
      (providerComposer?.fastModeAvailable === true || selectedModel?.supportsSpeed === true);
    const executionProfiles = capabilities.composer.executionProfile
      ? (providerComposer?.executionProfiles ?? [])
      : [];
    // A session created before a platform's Build/Plan pair was reclassified as
    // an execution profile still carries `controls.mode`. That value was already
    // dispatched as the provider's agent name, so it names the same thing the
    // profile now names; without this the upgraded session silently falls back
    // to the provider default and runs a different agent than the user chose.
    const legacyModeProfileId = !capabilities.composer.mode ? session.controls?.mode : undefined;
    const storedExecutionProfileId =
      providerControls?.executionProfileId ??
      session.controls?.executionProfileId ??
      providerComposer?.selectedExecutionProfileId ??
      legacyModeProfileId;
    // Only drop the stored selection when the provider actually told us which
    // profiles exist. An empty list means the agent listing failed or has not
    // arrived, and the stored id is then the best evidence we have — discarding
    // it there would swap the user's agent for the provider default on a
    // transient read. A non-empty list that omits the id is different: that id
    // demonstrably does not exist, and sending it would fail the dispatch.
    const profilesAreKnown = executionProfiles.length > 0;
    const selectedExecutionProfileId =
      capabilities.composer.executionProfile &&
      storedExecutionProfileId !== undefined &&
      (!profilesAreKnown ||
        executionProfiles.some((profile) => profile.id === storedExecutionProfileId))
        ? storedExecutionProfileId
        : undefined;
    const isReport = Boolean(bugReportIdFromRuntimeId(session.environmentId));
    const approvalModes = nativeAgentApprovalModes(input.agent, session.policy).map((mode) => {
      if (!isReport || input.agent !== "codex") return mode;
      if (mode.id === "auto-review") {
        return {
          ...mode,
          description: "Review eligible requests automatically. Sandbox escapes are denied.",
        };
      }
      if (mode.id === "never") {
        return {
          ...mode,
          label: "No prompts",
          description: "Run within the report sandbox without asking.",
        };
      }
      return mode;
    });
    const selectedApprovalModeId =
      isReport && (input.agent === "claude" || input.agent === "codex")
        ? (validBugReportApprovalMode(
            input.agent,
            session.policy,
            session.controls?.approvalMode,
          ) ?? bugReportInitialApprovalMode(input.agent))
        : resolveNativeAgentApprovalMode(
            input.agent,
            session.policy,
            providerControls?.approvalMode ?? session.controls?.approvalMode,
          );
    const composer: NativeAgentComposerState = {
      models,
      ...(resolvedSelection.selectedModelId
        ? { selectedModelId: resolvedSelection.selectedModelId }
        : selectedModel
          ? { selectedModelId: selectedModel.id }
          : {}),
      ...(selectedReasoningId
        ? {
            selectedReasoningId,
          }
        : {}),
      fastModeAvailable: supportsSpeed,
      fastModeEnabled: supportsSpeed
        ? (providerControls?.fastMode ??
          session.controls?.fastMode ??
          providerComposer?.fastModeEnabled ??
          false)
        : null,
      ...(capabilities.composer.mode
        ? {
            selectedModeId:
              providerControls?.mode ??
              session.controls?.mode ??
              providerComposer?.selectedModeId ??
              "build",
          }
        : {}),
      modes: capabilities.composer.mode
        ? providerComposer?.modes.length
          ? providerComposer.modes
          : [
              { id: "build", label: "Build" },
              { id: "plan", label: "Plan" },
            ]
        : [],
      // Execution profiles were previously copied across whenever the provider
      // reported any, so a platform whose table says `executionProfile: false`
      // would grow the control the moment its bridge started listing agents.
      ...(executionProfiles.length ? { executionProfiles } : {}),
      ...(selectedExecutionProfileId ? { selectedExecutionProfileId } : {}),
      ...(capabilities.composer.localSettings
        ? {
            includeLocalSettings:
              providerControls?.includeLocalSettings ??
              session.controls?.includeLocalSettings ??
              providerComposer?.includeLocalSettings ??
              false,
          }
        : {}),
      ...(capabilities.composer.promptSuggestions
        ? {
            promptSuggestionsEnabled:
              providerControls?.promptSuggestions ??
              session.controls?.promptSuggestions ??
              providerComposer?.promptSuggestionsEnabled ??
              false,
          }
        : {}),
      ...(providerComposer?.parameterValues ||
      session.controls?.parameterValues ||
      providerControls?.parameterValues
        ? {
            parameterValues: {
              ...providerComposer?.parameterValues,
              ...session.controls?.parameterValues,
              ...providerControls?.parameterValues,
            },
          }
        : {}),
      ...(providerComposer?.persistedDefaults === undefined
        ? {}
        : { persistedDefaults: providerComposer.persistedDefaults }),
      ...(approvalModes.length > 0 && selectedApprovalModeId
        ? { approvalModes, selectedApprovalModeId }
        : {}),
    };
    return withProviderSelectionPricing(composer, providerComposer);
  }
}
