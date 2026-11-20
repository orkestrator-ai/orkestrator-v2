import type {
  NativeAgentMessageWindow,
  PersistedNativeAgentSession,
  StorageService,
  NativeAgentRuntimeProvider,
  NativeAgentProjectionInput,
  NativeAgentServiceOptions,
  ProviderTranscriptSnapshot,
  NativeAgentTranscriptUpdateInput,
  NativeAgentProgressiveInput,
} from "./service-shared.js";
import {
  nativeAgentSessionStorageKey,
  createHash,
  NATIVE_SYNC_MAX_SNAPSHOT_BYTES,
  NATIVE_REVISED_MESSAGES_MAX_BYTES,
  ProviderUnavailableError,
} from "./service-shared.js";
import {
  NATIVE_AGENT_PROGRESSIVE_VIEW_VERSION,
  NATIVE_AGENT_REVISED_MESSAGES_MAX,
  type NativeAgentTranscriptDelta,
  type NativeAgentTranscriptUpdate,
  type NativeAgentTranscriptView,
} from "@orkestrator/protocol/native-agent";
import { randomUUID } from "node:crypto";
import { revisedRowsReconciliationToken } from "@orkestrator/protocol/node/revised-rows";
import { createNativeAgentDisplayTail, displayTailRecoveryWindow } from "./display-tails.js";
import { NativeAgentDisplayTailScheduler } from "./display-tail-scheduler.js";
import { ProgressiveReadPhaseTimer, monotonicMs } from "./progressive-metrics.js";
import { encodeDirectHistoryCursor } from "./direct-history.js";
import {
  artifactPublicationIds,
  overlayArtifactParts,
  type ArtifactOverlay,
} from "./service-projection-artifacts.js";
import { type ProjectionEntryContext } from "./projection-entries.js";
import { NATIVE_AGENT_TRANSCRIPT_PATCH_VERSION } from "@orkestrator/protocol/native-agent-transcript-patch";
import {
  chainedTranscriptDelta,
  TranscriptDeltaBases,
  type TranscriptDeltaChain,
} from "./transcript-delta-bases.js";
import { encodedPatchBytes, patchTranscriptDelta } from "./transcript-patches.js";
import {
  encodedBytesWithMessages,
  encodedValue,
  reuseUnchangedMessages,
  sameEncoding,
  sameIds,
  tailDeletions,
  updateHashWithFingerprints,
} from "./projection-encoding.js";
import { PreviewFillAnswers } from "./preview-fill.js";
import {
  PROGRESSIVE_HYDRATION_MAX_ATTEMPTS,
  PROGRESSIVE_HYDRATION_READ_STARTS_LIMIT,
  PROGRESSIVE_HYDRATION_RETRY_BASE_MS,
  PROGRESSIVE_HYDRATION_SETTLE_MS,
  firstNamedCursor,
  isNormalizedProgressiveMessage,
  normalizedProgressiveMessages,
  progressiveHydrationToken,
  firstUserMessageOf,
} from "./projection-helpers.js";
import {
  type ProjectedProgressiveTranscript,
  type DirectCursorSource,
  hasServerPromptPreamble,
  type ProgressiveTranscriptEntry,
  type ProgressiveHydrationEntry,
  type NativeAgentTranscriptProjectionHost,
  revisedRowsChanged,
  type NativeAgentProjectionContext,
} from "./projection-context.js";

/**
 * The progressive transcript view (`get_native_agent_transcript_update`): the
 * bounded view cache with its delta bases and patches, the background
 * recovery of an incomplete provider preview, held coordinator transcripts and
 * the restart display tails.
 *
 * The view cache (`progressiveTranscriptBytes`), the delta bases and the
 * display-tail checkpoints are bounded and reconstructible.
 */
export class NativeAgentProgressiveTranscript {
  private readonly host: NativeAgentTranscriptProjectionHost;
  private readonly storage: StorageService;
  private readonly options: NativeAgentServiceOptions;

  constructor(private readonly context: NativeAgentProjectionContext) {
    this.host = context.host;
    this.storage = context.storage;
    this.options = context.options;
    this.displayTailScheduler = new NativeAgentDisplayTailScheduler({
      write: (key, tail, fence) => this.storage.putNativeAgentDisplayTail(key, tail, { fence }),
      // Optional because narrow test doubles of the storage omit them.
      captureFence: () =>
        typeof this.storage.captureNativeAgentDisplayTailFence === "function"
          ? this.storage.captureNativeAgentDisplayTailFence()
          : 0,
      subscribeDeletions: (listener) =>
        typeof this.storage.onNativeAgentDisplayTailDeleted === "function"
          ? this.storage.onNativeAgentDisplayTailDeleted(listener)
          : () => undefined,
    });
  }

  /** Test-only view of the transcript state; production code must not call it. */
  forTesting() {
    return {
      progressiveTranscriptCache: this.progressiveTranscriptCache,
      transcriptDeltaBases: this.transcriptDeltaBases,
      progressiveHydrations: this.progressiveHydrations,
      transcriptDelta: (previous: NativeAgentTranscriptView, current: NativeAgentTranscriptView) =>
        this.transcriptDelta(previous, current),
    };
  }

  /** Key counts and charged bytes of the transcript caches, for `native-projection` diagnostics. */
  cacheGauges(): Record<string, number> {
    return {
      progressiveTranscripts: this.progressiveTranscriptCache.size,
      progressiveTranscriptBytes: this.progressiveTranscriptBytes,
      transcriptDeltaBases: this.transcriptDeltaBases.size,
      transcriptDeltaBaseBytes: this.transcriptDeltaBases.retainedBytes,
      progressiveSourceTokens: this.progressiveSourceTokens.size,
      progressiveHydrations: this.progressiveHydrations.size,
      progressiveHydrationTimers: this.progressiveHydrationTimers.size,
      progressiveHydrationReadStarts: this.progressiveHydrationReadStarts.size,
      progressivePreviewFills: this.progressivePreviewFills.size,
      displayTailCheckpoints: this.displayTailScheduler.size,
    };
  }

  /**
   * Stop accepting checkpoints and drain the newest pending previews within a
   * bounded deadline. A skipped preview only costs restart latency; the
   * provider stays authoritative, so shutdown never waits on it indefinitely.
   */
  drainDisplayTails(): Promise<{ attempted: number; written: number; skipped: number }> {
    return this.displayTailScheduler
      .shutdown()
      .catch(() => ({ attempted: 0, written: 0, skipped: 0 }));
  }

  /** Cancel every scheduled preview recovery (shutdown). */
  cancelHydrationTimers(): void {
    for (const timer of this.progressiveHydrationTimers.values()) clearTimeout(timer);
    this.progressiveHydrationTimers.clear();
  }

  /** Wait for the preview recoveries already running to settle (shutdown). */
  async settleHydrations(): Promise<void> {
    await Promise.allSettled(
      Array.from(this.progressiveHydrations.values(), (entry) => entry.promise).filter(
        (promise): promise is Promise<void> => promise !== undefined,
      ),
    );
  }

  /** Drop every transcript view and recovery; run after the reads settled. */
  clear(): void {
    this.progressiveHydrations.clear();
    this.progressiveHydrationReadStarts.clear();
    this.progressivePreviewFills.clear();
    this.progressiveTranscriptCache.clear();
    this.transcriptDeltaBases.clear();
    this.progressiveSourceTokens.clear();
    this.progressiveTranscriptBytes = 0;
  }

  /** Drop the views, delta bases and recoveries of a session whose identity changed. */
  forgetSession(sessionKey: string): void {
    const progressivePrefix = `${sessionKey}\0progressive-v1\0`;
    for (const candidate of Array.from(this.progressiveTranscriptCache.keys())) {
      if (!candidate.startsWith(progressivePrefix)) continue;
      const entry = this.progressiveTranscriptCache.get(candidate);
      if (entry) this.progressiveTranscriptBytes -= entry.bytes;
      this.progressiveTranscriptCache.delete(candidate);
      this.transcriptDeltaBases.forget(candidate);
      this.progressiveSourceTokens.delete(candidate);
    }
    for (const candidate of Array.from(this.progressiveHydrationReadStarts.keys())) {
      if (candidate.startsWith(progressivePrefix)) {
        this.progressiveHydrationReadStarts.delete(candidate);
      }
    }
    this.progressivePreviewFills.forgetPrefix(progressivePrefix);
    for (const candidate of Array.from(this.progressiveHydrations.keys())) {
      if (!candidate.startsWith(progressivePrefix)) continue;
      const timer = this.progressiveHydrationTimers.get(candidate);
      if (timer) clearTimeout(timer);
      this.progressiveHydrationTimers.delete(candidate);
      this.progressiveHydrations.delete(candidate);
    }
  }

  /** Collect the sessions of a deleted environment that have a cached view. */
  collectEnvironmentSessions(environmentId: string, sessionKeys: Set<string>): void {
    for (const { value } of this.progressiveTranscriptCache.values()) {
      if (value.identity.environmentId !== environmentId) continue;
      sessionKeys.add(
        nativeAgentSessionStorageKey(
          environmentId,
          value.identity.platform,
          value.identity.logicalSessionKey,
        ),
      );
    }
  }

  readonly progressiveTranscriptCache = new Map<string, ProgressiveTranscriptEntry>();
  /** Source of `ProgressiveTranscriptEntry.contentSequence`; only ever increases. */
  private progressiveContentSequence = 0;
  private progressiveTranscriptBytes = 0;
  /** Views the newest one superseded, for readers who are behind; has its own bounds. */
  private readonly transcriptDeltaBases = new TranscriptDeltaBases();
  private readonly progressiveSourceTokens = new Map<string, string>();
  /** Bounded restart-preview checkpoints; see display-tail-scheduler.ts. */
  private readonly displayTailScheduler: NativeAgentDisplayTailScheduler;
  private readonly progressiveHydrations = new Map<string, ProgressiveHydrationEntry>();
  private readonly progressiveHydrationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** When the last exact recovery read started, per key; spaces those reads out. */
  private readonly progressiveHydrationReadStarts = new Map<string, number>();
  /** Whether a view's incomplete preview fills the live window, per provider token. */
  private readonly progressivePreviewFills = new PreviewFillAnswers();
  /**
   * A background recovery of the same conversation keeps the title the view
   * already shows: it carries only the provider's own, which the read path
   * may have replaced with the backend's (`sessionTitles.resolve`).
   */
  private withShownTitle(
    key: string,
    projection: ProjectedProgressiveTranscript,
  ): ProjectedProgressiveTranscript {
    const shown = this.progressiveTranscriptCache.get(key)?.value;
    if (
      !shown?.title ||
      shown.title === projection.value.title ||
      shown.identity.providerSessionId !== projection.value.identity.providerSessionId
    ) {
      return projection;
    }
    return { ...projection, value: { ...projection.value, title: shown.title } };
  }

  private transcriptDelta(
    previous: NativeAgentTranscriptView,
    current: NativeAgentTranscriptView,
  ): NativeAgentTranscriptDelta {
    const previousById = new Map(
      previous.messages.map((message) => [(message as { id: string }).id, message] as const),
    );
    const currentIds = current.messages.map((message) => (message as { id: string }).id);
    const previousIds = previous.messages.map((message) => (message as { id: string }).id);
    const messageUpserts = current.messages.filter((message) => {
      const id = (message as { id: string }).id;
      const existing = previousById.get(id);
      return !existing || !sameEncoding(existing, message);
    });
    return {
      messageUpserts,
      ...(sameIds(previousIds, currentIds) &&
      previous.historyReconciliationToken === current.historyReconciliationToken
        ? {}
        : { liveMessageIds: currentIds }),
      // Rows that only aged out of the window are not deletions: the client
      // keeps them, and pages back to anything it does not hold. Older history
      // exists whenever the view says so, including a provider that trimmed
      // its own window (OpenCode) before this projection counted anything.
      deletedMessageIds: tailDeletions(
        previousIds,
        currentIds,
        !current.historyComplete || current.historyCursor !== undefined,
      ),
      freshness: current.freshness,
      historyEpoch: current.historyEpoch,
      historyComplete: current.historyComplete,
      ...(current.historyCursor ? { historyCursor: current.historyCursor } : {}),
      ...(current.title ? { title: current.title } : {}),
      ...(current.messageWindow ? { messageWindow: current.messageWindow } : {}),
      ...(current.providerRevision === undefined
        ? {}
        : { providerRevision: current.providerRevision }),
      // A snapshot rehydrates all noted rows; a delta carries only revisions
      // that changed since its base. Empty/absent lists clear transient notes,
      // while the client's already-replaced history copies stay authoritative.
      ...(current.historyReconciliationToken
        ? { historyReconciliationToken: current.historyReconciliationToken }
        : {}),
      ...(current.revisedMessages
        ? {
            revisedMessages: current.revisedMessages.filter((message) => {
              const previousRow = previous.revisedMessages?.find(
                (row) => (row as { id: string }).id === (message as { id: string }).id,
              );
              return previousRow === undefined || !sameEncoding(previousRow, message);
            }),
          }
        : {}),
    };
  }

  /**
   * The delta taking a reader from the view it holds to `value`, or `null` when
   * a snapshot is the better answer: the reader is older than the ring, the base
   * is a different history, or the delta would not be smaller.
   */
  private transcriptDeltaForReader(
    input: NativeAgentTranscriptUpdateInput,
    key: string,
    value: NativeAgentTranscriptView,
    snapshotBytes: number,
    /** The view this read replaced, in case the ring could not keep it. */
    replaced?: ProgressiveTranscriptEntry,
  ): NativeAgentTranscriptDelta | null {
    const knownToken = input.knownToken;
    if (!knownToken) return null;
    const chain: TranscriptDeltaChain | undefined =
      (input.forceSnapshot ? undefined : this.transcriptDeltaBases.chain(key, knownToken)) ??
      (replaced?.token === knownToken ? { base: replaced.value, later: [] } : undefined);
    if (
      !chain ||
      chain.base.identity.providerSessionId !== value.identity.providerSessionId ||
      chain.base.historyEpoch !== value.historyEpoch
    ) {
      return null;
    }
    const delta = chainedTranscriptDelta(this.transcriptDelta(chain.base, value), chain, value);
    if (!delta) return null;
    if (input.patchVersion === NATIVE_AGENT_TRANSCRIPT_PATCH_VERSION) {
      patchTranscriptDelta(delta, chain.base.messages);
    }
    const operationCount =
      delta.messageUpserts.length +
      (delta.messagePatches?.length ?? 0) +
      delta.deletedMessageIds.length +
      (delta.liveMessageIds?.length ?? 0);
    const deltaBytes =
      encodedBytesWithMessages({
        ...delta,
        messages: delta.messageUpserts,
        messageUpserts: [],
        messagePatches: [],
      }) + (delta.messagePatches ? encodedPatchBytes(delta.messagePatches) : 0);
    return operationCount <= 1024 && deltaBytes < snapshotBytes ? delta : null;
  }

  private scheduleDisplayTailPersist(
    input: NativeAgentProgressiveInput,
    value: NativeAgentTranscriptView,
  ): void {
    if (value.freshness !== "current" && value.freshness !== "empty") return;
    const sessionKey = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    // One pending latest value per key; stripping and serialization happen
    // once, when the checkpoint is actually written.
    this.displayTailScheduler.update(sessionKey, {
      environmentId: input.environmentId,
      build: () => {
        const messageWindow = displayTailRecoveryWindow(value.messageWindow);
        return createNativeAgentDisplayTail({
          environmentId: input.environmentId,
          agent: input.agent,
          logicalSessionKey: input.logicalSessionKey,
          providerSessionId: value.identity.providerSessionId,
          historyEpoch: value.historyEpoch,
          ...(value.title ? { title: value.title } : {}),
          messages: value.messages,
          historyComplete: value.historyComplete,
          ...(messageWindow ? { messageWindow } : {}),
          updatedAt: new Date(this.host.now()).toISOString(),
        });
      },
    });
  }

  /** Immediate checkpoint of a pending tail (tests and explicit flushes). */
  async flushDisplayTailPersist(sessionKey: string): Promise<void> {
    await this.displayTailScheduler.flush(sessionKey);
  }

  private trimProgressiveTranscriptCache(): void {
    while (
      this.progressiveTranscriptCache.size > 128 ||
      this.progressiveTranscriptBytes > 64 * 1024 * 1024
    ) {
      const oldest = this.progressiveTranscriptCache.keys().next().value as string | undefined;
      if (!oldest) break;
      const entry = this.progressiveTranscriptCache.get(oldest);
      if (entry) this.progressiveTranscriptBytes -= entry.bytes;
      this.progressiveTranscriptCache.delete(oldest);
      this.transcriptDeltaBases.forget(oldest);
      /*
       * The source token and any background recovery belong to the view just
       * evicted: the next read has no base to send the token against, reads
       * the whole window again and schedules its own recovery. Keeping them
       * left one token per key ever read (todo 7100 task 3); a recovery still
       * in flight finds its entry gone and drops its result.
       */
      this.progressiveSourceTokens.delete(oldest);
      const timer = this.progressiveHydrationTimers.get(oldest);
      if (timer) clearTimeout(timer);
      this.progressiveHydrationTimers.delete(oldest);
      this.progressiveHydrations.delete(oldest);
    }
  }

  /**
   * A live preview that still fits the window is not "older history".
   *
   * Providers report `complete: false` for a hydration hole as well as for a
   * genuine remainder. Treating the flag alone as pageable hid the first
   * prompt behind "Load earlier messages" on a two-row transcript. If the
   * preview has not filled the live window, recover the bounded remainder in
   * the background and keep the preview available until that read settles.
   */
  private resolveProgressiveSnapshot(
    key: string,
    snapshot: ProviderTranscriptSnapshot,
  ): ProviderTranscriptSnapshot {
    if (snapshot.complete !== false) return snapshot;
    const cached = this.progressiveHydrations.get(key);
    if (cached && cached.sourceToken === progressiveHydrationToken(snapshot) && cached.snapshot) {
      return cached.snapshot;
    }
    return snapshot;
  }

  private scheduleIncompleteProgressiveHydration(
    input: NativeAgentTranscriptUpdateInput,
    key: string,
    provider: NativeAgentRuntimeProvider,
    sessionId: string,
    snapshot: ProviderTranscriptSnapshot,
    initialPromptPresentation: PersistedNativeAgentSession["initialPromptPresentation"],
    /** Whether the view built from `snapshot` pages directly from its cursor. */
    directPagingAdopted: boolean,
  ): void {
    const sourceToken = progressiveHydrationToken(snapshot);
    // Even a complete/current snapshot that needs no recovery supersedes an
    // older exact read. Fence it before any of the no-hydration fast paths.
    this.invalidateStaleProgressiveHydration(key, sourceToken);
    if (snapshot.complete !== false) return;
    /*
     * A summary window is measured without raw artifacts, so a short one means
     * the history before it is genuinely there to page, not that a tool body
     * crowded it out. Re-reading the legacy full transcript would bring back
     * exactly the payloads the summary exists to avoid. Only a part-trimmed
     * head — one row larger than the whole window — still needs exact recovery.
     *
     * A *cached* summary is the exception. It is the bridge's no-touch preview
     * of a session whose rollout body it has not loaded (a detached or restarted
     * Codex thread), so its short or empty window says nothing about what the
     * conversation holds. Display reads never attach the thread, which makes
     * this exact read the only thing that ever will: skipping it left a
     * finished session rendering as empty until something else touched it.
     *
     * A page cursor the view adopted says the same as a summary: the provider
     * has already said where the rest of the history is, so its window is
     * short on purpose. One merely offered says nothing — a view that could
     * not hold the whole window, and could not name a cursor at a row it kept
     * either, dropped the row the cursor names, and without this read the
     * history before what it kept is unreachable.
     */
    if (
      (snapshot.representation === "summary" || directPagingAdopted) &&
      snapshot.freshness !== "cached" &&
      (snapshot.omittedParts ?? 0) <= 0
    )
      return;
    // A recovery already scheduled for this revision settles the question;
    // asking first spares measuring the raw window.
    const existing = this.progressiveHydrations.get(key);
    if (existing && existing.sourceToken === sourceToken) return;
    if (
      (snapshot.omittedParts ?? 0) <= 0 &&
      this.progressivePreviewFills.fills(key, snapshot, input.liveWindow)
    )
      return;
    const previousTimer = this.progressiveHydrationTimers.get(key);
    if (previousTimer) clearTimeout(previousTimer);
    const entry: ProgressiveHydrationEntry = {
      sourceToken,
      attempts: 0,
      holdPreview: (snapshot.omittedParts ?? 0) > 0,
    };
    this.progressiveHydrations.set(key, entry);
    /*
     * While a part-trimmed head is in the window every streamed revision lands
     * here with a new source token, and each read below is a whole `messages`
     * read whose head row alone outgrows the window. Recovery therefore starts
     * at most once per settle interval: the first read for a quiet key starts
     * at once, and a newer token arriving during the wait replaces the pending
     * one without moving its deadline, so a streaming turn still recovers once
     * an interval and a cached summary (the only thing that attaches a
     * detached Codex thread) is never starved. The pending timer keeps the
     * preview held meanwhile, as an in-flight read did.
     */
    const settleMs = this.options.progressiveHydrationSettleMs ?? PROGRESSIVE_HYDRATION_SETTLE_MS;
    const lastStart = this.progressiveHydrationReadStarts.get(key);
    const sinceLastStart = lastStart === undefined ? settleMs : monotonicMs() - lastStart;
    const scheduleAttempt = (delayMs: number): void => {
      const timer = setTimeout(() => {
        if (this.progressiveHydrationTimers.get(key) === timer) {
          this.progressiveHydrationTimers.delete(key);
        }
        if (this.host.isStopped() || this.progressiveHydrations.get(key) !== entry) return;
        entry.attempts += 1;
        this.recordProgressiveHydrationReadStart(key, settleMs);
        // What the view shows as this read starts. The read is no older than it.
        const shownSequence = this.progressiveTranscriptCache.get(key)?.contentSequence;
        const promise = this.fillIncompleteProgressiveSnapshot(
          provider,
          sessionId,
          snapshot,
          input.liveWindow,
        )
          .catch(() => snapshot)
          .then((hydrated) => {
            if (this.host.isStopped()) return;
            const pending = this.progressiveHydrations.get(key);
            const current =
              pending === entry && this.progressiveSourceTokens.get(key) === snapshot.sourceToken;
            /*
             * A newer revision arrived while this read was in flight. Once
             * reading and parsing the exact row outlasts the gap between two
             * revisions, that is every read, and discarding them all froze
             * the view on the last recovery that finished in a quiet gap
             * (to-do 7845 (retired), task 2). The read is still newer than what the view
             * shows if the view has not moved since it started, and a newer
             * revision's recovery is still pending (so the view is a held
             * preview, not a complete snapshot): commit it, and let that
             * recovery replace it.
             */
            const newerThanShown =
              !current &&
              pending !== undefined &&
              shownSequence !== undefined &&
              this.progressiveTranscriptCache.get(key)?.contentSequence === shownSequence;
            if (!current && !newerThanShown) return;
            if (hydrated === snapshot) {
              // The newer revision's recovery owns the retries.
              if (!current) return;
              // The preview is safer than freezing a stale, fuller revision.
              // Keep retrying exact recovery in the background, but only the
              // first attempt is allowed to hold the visible transcript.
              entry.holdPreview = false;
              if (entry.attempts < PROGRESSIVE_HYDRATION_MAX_ATTEMPTS) {
                scheduleAttempt(PROGRESSIVE_HYDRATION_RETRY_BASE_MS * 2 ** (entry.attempts - 1));
              }
              return;
            }
            entry.holdPreview = false;
            entry.snapshot = hydrated;
            this.commitProgressiveTranscript(
              key,
              input,
              this.withShownTitle(
                key,
                this.projectProgressiveTranscript(
                  input,
                  key,
                  hydrated,
                  sessionId,
                  initialPromptPresentation,
                ),
              ),
            );
            // An idle view reads on a slow cadence. Say the recovered transcript
            // is there rather than leaving it to wait for the next poll.
            this.storage.announceNativeAgentSessionProjection(input.environmentId, "hydration", {
              agent: input.agent,
              logicalSessionKey: input.logicalSessionKey,
            });
          })
          .finally(() => {
            if (entry.promise === promise) entry.promise = undefined;
          });
        entry.promise = promise;
      }, delayMs);
      this.progressiveHydrationTimers.set(key, timer);
    };
    scheduleAttempt(Math.min(settleMs, Math.max(0, settleMs - sinceLastStart)));
  }

  private recordProgressiveHydrationReadStart(key: string, settleMs: number): void {
    const now = monotonicMs();
    this.progressiveHydrationReadStarts.delete(key);
    this.progressiveHydrationReadStarts.set(key, now);
    // A start older than the interval no longer delays anything.
    if (this.progressiveHydrationReadStarts.size <= PROGRESSIVE_HYDRATION_READ_STARTS_LIMIT) return;
    for (const [candidate, startedAt] of Array.from(this.progressiveHydrationReadStarts)) {
      if (
        this.progressiveHydrationReadStarts.size > PROGRESSIVE_HYDRATION_READ_STARTS_LIMIT ||
        now - startedAt >= settleMs
      ) {
        this.progressiveHydrationReadStarts.delete(candidate);
      }
    }
  }

  private invalidateStaleProgressiveHydration(key: string, sourceToken: string): void {
    const existing = this.progressiveHydrations.get(key);
    if (!existing || existing.sourceToken === sourceToken) return;
    const timer = this.progressiveHydrationTimers.get(key);
    if (timer) clearTimeout(timer);
    this.progressiveHydrationTimers.delete(key);
    this.progressiveHydrations.delete(key);
  }

  private async fillIncompleteProgressiveSnapshot(
    provider: NativeAgentRuntimeProvider,
    sessionId: string,
    snapshot: ProviderTranscriptSnapshot,
    liveWindow: { messages: number; targetBytes: number },
  ): Promise<ProviderTranscriptSnapshot> {
    let fuller: unknown;
    try {
      fuller = await provider.messages(sessionId, { limit: liveWindow.messages });
    } catch {
      return snapshot;
    }
    const normalized = normalizedProgressiveMessages(fuller);
    if (!normalized) return snapshot;
    // A single long Codex turn can lose tool/commentary parts without losing a
    // message. Message count alone rejects that exact recovery indefinitely.
    const previewHead = snapshot.messages[0];
    const recoveredHead = normalized.find(
      (message) =>
        isNormalizedProgressiveMessage(previewHead) &&
        isNormalizedProgressiveMessage(message) &&
        message.id === previewHead.id,
    );
    const recoveredParts =
      snapshot.omittedParts &&
      isNormalizedProgressiveMessage(previewHead) &&
      isNormalizedProgressiveMessage(recoveredHead) &&
      recoveredHead.parts.length > previewHead.parts.length;
    if (
      normalized.length < snapshot.messages.length ||
      (normalized.length === snapshot.messages.length && !recoveredParts)
    )
      return snapshot;
    const historyStartIndex =
      snapshot.historyStartIndex === undefined
        ? undefined
        : Math.max(0, snapshot.historyStartIndex + snapshot.messages.length - normalized.length);
    return {
      ...snapshot,
      messages: normalized,
      omittedParts: undefined,
      byteOmittedMessages: undefined,
      ...(historyStartIndex === undefined ? {} : { historyStartIndex }),
      complete: normalized.length < liveWindow.messages,
      freshness: "current",
    };
  }

  private projectProgressiveTranscript(
    input: NativeAgentTranscriptUpdateInput,
    key: string,
    snapshot: ProviderTranscriptSnapshot,
    providerSessionId: string,
    initialPromptPresentation: PersistedNativeAgentSession["initialPromptPresentation"],
  ): ProjectedProgressiveTranscript {
    const previous = this.progressiveTranscriptCache.get(key);
    const overlay = this.context.parts.artifactOverlay(input);
    const sourceGeneration = this.host.providerGeneration(input) ?? `in-process:${input.agent}`;
    const identity = this.context.reads.progressiveIdentity(
      input,
      providerSessionId,
      sourceGeneration,
    );
    const previewHead = snapshot.messages[0];
    const displayedHead = previous?.value.messages.find(
      (message) =>
        isNormalizedProgressiveMessage(previewHead) &&
        isNormalizedProgressiveMessage(message) &&
        message.id === previewHead.id,
    );
    /*
     * A byte-trimmed message is not a replacement for the full turn already on
     * screen. Keep the bounded display snapshot until the background exact read
     * above recovers its parts. Merging by array index would misidentify tool
     * details (and progress rows need not project one-to-one), so install that
     * recovery atomically instead. Epoch/session/generation changes and complete
     * snapshots remain authoritative replacements, including real deletions.
     */
    const hydration = this.progressiveHydrations.get(key);
    const hydrationHoldingPreview =
      hydration?.sourceToken === progressiveHydrationToken(snapshot) &&
      hydration.holdPreview &&
      (hydration.promise !== undefined || this.progressiveHydrationTimers.has(key));
    if (
      snapshot.complete === false &&
      (snapshot.omittedParts ?? 0) > 0 &&
      hydrationHoldingPreview &&
      snapshot.historyEpoch !== undefined &&
      previous?.value.historyEpoch === snapshot.historyEpoch &&
      previous.value.historyReconciliationToken === snapshot.historyReconciliationToken &&
      previous.value.identity.providerSessionId === providerSessionId &&
      previous.value.identity.sourceGeneration === identity.sourceGeneration &&
      isNormalizedProgressiveMessage(previewHead) &&
      isNormalizedProgressiveMessage(displayedHead)
    ) {
      return this.keptProgressiveProjection(previous, overlay);
    }
    const summary = snapshot.representation === "summary";
    const sessionKey = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    if (snapshot.historyEpoch !== undefined) {
      // A new epoch is a rewritten history: rows kept for the old one go now
      // rather than aging out, and so do pages cut from it.
      if (previous !== undefined && previous.value.historyEpoch !== snapshot.historyEpoch) {
        this.context.parts.projectedMessages.forgetSession(sessionKey);
      }
      if (summary || snapshot.historyCursor !== undefined) {
        this.context.parts.directHistoryPages.observeEpoch(
          sessionKey,
          providerSessionId,
          snapshot.historyEpoch,
        );
      }
    }
    if (previous?.value.historyReconciliationToken !== snapshot.historyReconciliationToken) {
      this.context.parts.directHistoryPages.forgetSession(sessionKey);
    }
    const normalized = this.context.parts.projectionMessages(
      sessionKey,
      snapshot.messages,
      input.liveWindow.messages,
      NATIVE_SYNC_MAX_SNAPSHOT_BYTES,
      initialPromptPresentation,
      hasServerPromptPreamble(input.environmentId),
      summary ? { providerSessionId } : undefined,
      overlay,
    );
    let projectedMessages = normalized.messages;
    let projectedStartIndex = snapshot.historyStartIndex;
    let sourceComplete = snapshot.complete;
    /*
     * A bridge bounds raw tool output and inline attachments before we move
     * them behind detail references. Its preview can therefore omit the first
     * prompt even when the projected conversation fits comfortably here.
     * Hydration recovers that prefix, but each streaming revision changes the
     * hydration token. Do not publish the smaller preview again while its next
     * recovery is pending: that removes and reinserts the prompt every poll.
     *
     * Carry only a prefix whose sequence position is proven by the provider,
     * from the same explicit history epoch and runtime identity. Directly
     * overlapping rows must still match in order; an adjacent disjoint window
     * is the append-only case that ids alone cannot prove. Complete snapshots,
     * rewritten histories, gaps and unpositioned windows remain authoritative
     * replacements. Reapply the normal count/byte bounds after joining.
     */
    if (
      snapshot.complete === false &&
      snapshot.historyEpoch !== undefined &&
      previous?.value.historyEpoch === snapshot.historyEpoch &&
      previous.value.historyReconciliationToken === snapshot.historyReconciliationToken &&
      previous.value.identity.providerSessionId === providerSessionId &&
      previous.value.identity.sourceGeneration === identity.sourceGeneration &&
      previous.historyStartIndex !== undefined &&
      previous.historyEndIndex !== undefined &&
      projectedStartIndex !== undefined &&
      projectedMessages.length > 0
    ) {
      const id = (message: unknown) => (message as { id: string }).id;
      const earlier = previous.value.messages;
      const incomingEndIndex = projectedStartIndex + projectedMessages.length;
      const prefixLength = projectedStartIndex - previous.historyStartIndex;
      const overlapLength = previous.historyEndIndex - projectedStartIndex;
      if (
        prefixLength > 0 &&
        prefixLength <= earlier.length &&
        projectedStartIndex <= previous.historyEndIndex &&
        incomingEndIndex >= previous.historyEndIndex &&
        overlapLength >= 0 &&
        earlier
          .slice(prefixLength)
          .every((message, index) => id(message) === id(projectedMessages[index]))
      ) {
        projectedMessages = [...earlier.slice(0, prefixLength), ...projectedMessages];
        projectedStartIndex = previous.historyStartIndex;
        sourceComplete = previous.value.historyComplete;
      }
    }
    const bounded = this.context.parts.boundedProjectedMessages(
      projectedMessages,
      input.liveWindow.messages,
      input.liveWindow.targetBytes,
    );
    const droppedProjectedMessages = projectedMessages.length - bounded.messages.length;
    const boundedStartIndex =
      projectedStartIndex === undefined
        ? undefined
        : projectedStartIndex + droppedProjectedMessages;
    if (snapshot.complete === false && sourceComplete === true && droppedProjectedMessages > 0) {
      // The old complete base justified the join only while its carried rows
      // remained visible. A byte bound that drops them leaves an incomplete,
      // non-pageable provider preview and must not claim complete history.
      sourceComplete = false;
    }
    /*
     * A provider page cursor names the position of the snapshot's first
     * message. It is usable only while this view starts at or before that
     * position: a joined prefix merely overlaps the first page (the client
     * deduplicates by id), but a bound that dropped leading rows would leave
     * a gap no page could ever fill.
     *
     * A provider that pages by message (OpenCode) reports no position, and
     * nothing can be joined ahead of its window, so the view must hold every
     * row of the snapshot instead. Inline bodies need no summary for this:
     * the page projection registers them as local details like any other.
     */
    const viewStartsAtSnapshot =
      snapshot.historyStartIndex === undefined
        ? normalized.messages.length === snapshot.messages.length && droppedProjectedMessages === 0
        : boundedStartIndex !== undefined && boundedStartIndex <= snapshot.historyStartIndex;
    /*
     * Otherwise the provider names a cursor for the first row the view kept
     * (or, for a provider that pages by message, the first kept row a page can
     * end at). Rows between the view's start and that position come back on
     * the first page as well, and the client deduplicates them by id; rows the
     * bound dropped come back after them. A window at the first message names
     * one too, although it carries no `historyCursor` of its own (#2285).
     *
     * When no kept row can name a cursor (only an OpenCode inline error row
     * remains, its response's main row dropped by the bound), the cursor at
     * the window's end pages the whole window again: the client deduplicates
     * the rows it holds and the dropped ones come back with them. Without
     * these the view would have nothing older to load: joined paging, which
     * once minted a cursor here with a whole transcript read, is gone (0232).
     */
    const providerHistoryCursor = viewStartsAtSnapshot
      ? snapshot.historyCursor
      : (firstNamedCursor(bounded.messages, snapshot.historyCursorBefore) ??
        snapshot.historyCursorAtEnd);
    const directCursorSource: DirectCursorSource | undefined =
      providerHistoryCursor && snapshot.historyEpoch !== undefined
        ? {
            sessionKey,
            providerSessionId,
            historyEpoch: snapshot.historyEpoch,
            providerCursor: providerHistoryCursor,
          }
        : undefined;
    const directHistoryCursor = directCursorSource
      ? encodeDirectHistoryCursor(directCursorSource, this.context.parts.directHistoryCursorHandles)
      : undefined;
    const localPageable =
      directHistoryCursor !== undefined ||
      bounded.window.canLoadEarlier === true ||
      (normalized.window.canLoadEarlier === true && normalized.window.truncationReason !== "bytes");
    // A provider tail that already fills the live window cannot produce a
    // local count slice, so incompleteness itself is the remainder signal.
    const pageable =
      localPageable ||
      (sourceComplete === false && bounded.messages.length >= input.liveWindow.messages);
    /*
     * Whole messages dropped for bytes ahead of this window, by the provider or
     * by the bound above. One oversized turn leaves a tail too short to fill
     * the count window, so neither signal above fires and the reader saw an
     * unexplained cut. A wider live window cannot restore these, but history
     * paging can, and the renderer offers it for exactly this shape: an
     * incomplete window reporting byte-omitted messages. A joined prefix has
     * already restored part of the provider's omission, so count from the
     * joined start when it is positioned.
     */
    const providerByteOmitted =
      sourceComplete === false && snapshot.byteOmittedMessages
        ? (projectedStartIndex ?? snapshot.byteOmittedMessages)
        : 0;
    const localByteOmitted =
      bounded.window.truncationReason === "bytes" ? (bounded.window.omittedMessages ?? 0) : 0;
    const byteOmitted = providerByteOmitted > 0 || localByteOmitted > 0;
    const truncated =
      Boolean(bounded.window.truncated || normalized.window.truncated) ||
      sourceComplete === false ||
      byteOmitted;
    const complete = !pageable && sourceComplete !== false && !byteOmitted;
    const historyEpoch =
      snapshot.historyEpoch ??
      (previous?.value.identity.providerSessionId === providerSessionId
        ? previous.value.historyEpoch
        : randomUUID());
    // Rows the provider says changed outside its window. One can sit in the
    // prefix joined ahead of that window from the previous view, which holds
    // its older copy: the revised copy replaces it there and is not sent again.
    const revised = this.projectedRevisedMessages(
      sessionKey,
      snapshot.revisedMessages,
      normalized.messages,
      initialPromptPresentation,
      hasServerPromptPreamble(input.environmentId),
      summary ? { providerSessionId } : undefined,
      overlay,
    );
    const deliveredRevisions = new Set(
      [...normalized.messages, ...(revised ?? [])].map((row) => (row as { id: string }).id),
    );
    const omittedRevisions =
      snapshot.revisedMessages?.filter(
        (row) => !deliveredRevisions.has((row as { id: string }).id),
      ) ?? [];
    const historyReconciliationToken = omittedRevisions.length
      ? revisedRowsReconciliationToken(0, [
          snapshot.historyReconciliationToken,
          ...omittedRevisions,
        ])
      : snapshot.historyReconciliationToken;
    const revisedById = new Map(
      (revised ?? []).map((message) => [(message as { id: string }).id, message] as const),
    );
    const replaced = revisedById.size
      ? bounded.messages.map((message) => {
          const id = (message as { id?: unknown }).id;
          const replacement = typeof id === "string" ? revisedById.get(id) : undefined;
          if (replacement === undefined) return message;
          revisedById.delete(id as string);
          return replacement;
        })
      : bounded.messages;
    // A prefix joined from the previous view carries that read's placements;
    // publications committed since then are placed here (idempotently).
    const viewed = overlayArtifactParts(replaced, overlay);
    const providerRevisedMessages =
      revised?.filter((message) => revisedById.has((message as { id: string }).id)) ?? [];
    const ledgerRevised = this.ledgerRevisedRows({
      sessionKey,
      context: {
        sessionKey,
        ...(summary ? { remoteSessionId: providerSessionId } : {}),
        coordinator: hasServerPromptPreamble(input.environmentId),
      },
      previous,
      sameHistory:
        previous?.value.historyEpoch === historyEpoch &&
        previous.value.identity.providerSessionId === providerSessionId,
      overlay,
      window: viewed,
      providerRevised: providerRevisedMessages,
    });
    const revisedMessages = [...providerRevisedMessages, ...ledgerRevised];
    // A cached history page holds whatever copy of a row it was read with; a
    // row that has changed since must not come back from one.
    if (
      revised?.length &&
      revisedRowsChanged(
        [...(previous?.value.messages ?? []), ...(previous?.value.revisedMessages ?? [])],
        revised,
      )
    ) {
      this.context.parts.directHistoryPages.forgetSession(sessionKey);
    }
    // Unchanged rows keep the objects already held, so every later comparison
    // and encoding of them in this read and the next is a reference check.
    const messages = reuseUnchangedMessages(previous?.value.messages, viewed);
    return {
      value: {
        identity,
        freshness:
          messages.length === 0 && complete
            ? "empty"
            : snapshot.freshness === "cached"
              ? "cached"
              : "current",
        messages,
        messageWindow: {
          ...bounded.window,
          truncated,
          canLoadEarlier: pageable,
          ...(byteOmitted
            ? {
                truncationReason: "bytes" as const,
                omittedMessages: providerByteOmitted + (bounded.window.omittedMessages ?? 0),
              }
            : {}),
        },
        ...(snapshot.title ? { title: snapshot.title } : {}),
        ...(snapshot.revision === undefined ? {} : { providerRevision: snapshot.revision }),
        ...(directHistoryCursor ? { historyCursor: directHistoryCursor } : {}),
        historyEpoch,
        historyComplete: complete,
        ...(revisedMessages.length ? { revisedMessages } : {}),
        ...(historyReconciliationToken ? { historyReconciliationToken } : {}),
      },
      ...(boundedStartIndex === undefined
        ? {}
        : {
            historyStartIndex: boundedStartIndex,
            historyEndIndex: boundedStartIndex + bounded.messages.length,
          }),
      ledgerRevision: overlay?.revision ?? 0,
      ...(ledgerRevised.length
        ? { ledgerRevisedIds: ledgerRevised.map((row) => (row as { id: string }).id) }
        : {}),
      ...(directHistoryCursor && directCursorSource ? { directCursor: directCursorSource } : {}),
    };
  }

  /**
   * A view kept from an earlier read, with publications committed since then
   * placed into its rows. Its rows are never modified, and its ledger
   * revision is not advanced: rows outside it are searched by the next full
   * projection.
   */
  private keptProgressiveProjection(
    previous: ProgressiveTranscriptEntry,
    overlay: ArtifactOverlay | null,
  ): ProjectedProgressiveTranscript {
    const messages = overlayArtifactParts(previous.value.messages, overlay);
    // Hold the view's cursor again: a handle is named by a digest of what it
    // holds, so this re-registers the same handle the view already carries.
    if (previous.directCursor) {
      encodeDirectHistoryCursor(
        previous.directCursor,
        this.context.parts.directHistoryCursorHandles,
      );
    }
    return {
      value:
        messages === previous.value.messages ? previous.value : { ...previous.value, messages },
      ...(previous.historyStartIndex === undefined
        ? {}
        : { historyStartIndex: previous.historyStartIndex }),
      ...(previous.historyEndIndex === undefined
        ? {}
        : { historyEndIndex: previous.historyEndIndex }),
      ...(previous.ledgerRevision === undefined ? {} : { ledgerRevision: previous.ledgerRevision }),
      ...(previous.ledgerRevisedIds ? { ledgerRevisedIds: previous.ledgerRevisedIds } : {}),
      ...(previous.directCursor ? { directCursor: previous.directCursor } : {}),
      keptContentSequence: previous.contentSequence,
    };
  }

  /**
   * Rows outside the window that a publication committed since the previous
   * view now reaches, plus rows sent this way before that are still outside
   * it. Readers re-read only the window, so like a provider's revised rows
   * these travel in `revisedMessages` and replace the reader's copy.
   *
   * A row is taken from the previous view or the per-row projection cache,
   * never fabricated, and never a part-trimmed head row (a reader would lose
   * the parts it holds). A publication whose row this backend no longer holds
   * is left to the reader's own merge, which places it when that row is
   * paged. Bounded together with the provider's revised rows by
   * `NATIVE_AGENT_REVISED_MESSAGES_MAX` and `NATIVE_REVISED_MESSAGES_MAX_BYTES`.
   */
  private ledgerRevisedRows(input: {
    sessionKey: string;
    context: ProjectionEntryContext;
    previous: ProgressiveTranscriptEntry | undefined;
    sameHistory: boolean;
    overlay: ArtifactOverlay | null;
    window: readonly unknown[];
    providerRevised: readonly unknown[];
  }): unknown[] {
    const { previous, overlay } = input;
    if (!overlay || !previous || !input.sameHistory) return [];
    const room = NATIVE_AGENT_REVISED_MESSAGES_MAX - input.providerRevised.length;
    if (room <= 0) return [];
    const idOf = (row: unknown): string | undefined => {
      const id = (row as { id?: unknown } | null | undefined)?.id;
      return typeof id === "string" ? id : undefined;
    };
    const excluded = new Set<string>();
    for (const row of [...input.window, ...input.providerRevised]) {
      const id = idOf(row);
      if (id !== undefined) excluded.add(id);
    }
    const candidates = new Map<string, unknown>();
    const since = previous.ledgerRevision;
    if (since !== undefined && overlay.revision > since) {
      const shown = artifactPublicationIds([...input.window, ...input.providerRevised]);
      const fresh = new Set(
        overlay.publications
          .filter(
            (publication) =>
              publication.conversationSequence > since && !shown.has(publication.ref.publicationId),
          )
          .map((publication) => publication.ref.publicationId),
      );
      const previousRows = previous.value.messages;
      const trimmedHead =
        (previous.value.messageWindow?.omittedParts ?? 0) > 0 ? idOf(previousRows[0]) : undefined;
      const consider = (row: unknown): void => {
        const id = idOf(row);
        if (id === undefined || excluded.has(id) || candidates.has(id) || id === trimmedHead) {
          return;
        }
        const [overlaid] = overlayArtifactParts([row], overlay);
        if (overlaid === row) return;
        let reached = false;
        for (const publicationId of artifactPublicationIds([overlaid])) {
          if (fresh.delete(publicationId)) reached = true;
        }
        if (reached) candidates.set(id, overlaid);
      };
      for (const row of [...(previous.value.revisedMessages ?? []), ...previousRows]) {
        if (fresh.size === 0 || candidates.size >= room) break;
        consider(row);
      }
      if (fresh.size > 0 && candidates.size < room) {
        for (const entry of this.context.parts.projectedMessages.sessionEntries(input.context)) {
          if (fresh.size === 0 || candidates.size >= room) break;
          const id = idOf(entry.projected);
          if (id === undefined || excluded.has(id) || candidates.has(id)) continue;
          // Its detail references must resolve like the window's do.
          if (!this.context.parts.restoreDetailRegistrations(input.sessionKey, entry.details))
            continue;
          consider(entry.projected);
        }
      }
    }
    for (const id of previous.ledgerRevisedIds ?? []) {
      if (excluded.has(id) || candidates.has(id)) continue;
      const row = previous.value.revisedMessages?.find((candidate) => idOf(candidate) === id);
      if (row !== undefined) candidates.set(id, overlayArtifactParts([row], overlay)[0]);
    }
    let bytes = input.providerRevised.reduce<number>(
      (total, row) => total + encodedValue(row).bytes,
      0,
    );
    const rows: unknown[] = [];
    for (const row of candidates.values()) {
      if (rows.length >= room) break;
      const size = encodedValue(row).bytes;
      if (bytes + size > NATIVE_REVISED_MESSAGES_MAX_BYTES) continue;
      bytes += size;
      rows.push(row);
    }
    return rows;
  }

  /**
   * A provider's revised rows from before the window, projected like window
   * rows so their details register and resolve the same way.
   *
   * Rows the window holds are dropped (it is authoritative for them), and so
   * is any row its projection would have to trim: a reader replaces its whole
   * copy with what arrives here, and a trimmed row would lose parts it holds.
   * The session's first prompt is presented by its position in the whole
   * transcript, which a lone revised row does not carry, so a user row is left
   * to the copy the reader already presents. Malformed rows are skipped rather
   * than failing a read that is otherwise sound. Bounded by count and bytes.
   */
  private projectedRevisedMessages(
    sessionKey: string,
    revised: readonly unknown[] | undefined,
    window: readonly unknown[],
    initialPromptPresentation: PersistedNativeAgentSession["initialPromptPresentation"],
    coordinatorTranscript: boolean,
    remote: { providerSessionId: string } | undefined,
    artifactOverlay: ArtifactOverlay | null,
  ): unknown[] | undefined {
    if (!revised?.length) return undefined;
    const seen = new Set(window.map((message) => (message as { id?: unknown }).id));
    const projected: unknown[] = [];
    let bytes = 0;
    for (const row of revised) {
      if (projected.length >= NATIVE_AGENT_REVISED_MESSAGES_MAX) break;
      const record =
        row && typeof row === "object" && !Array.isArray(row)
          ? (row as Record<string, unknown>)
          : undefined;
      const id = record?.id;
      if (typeof id !== "string" || seen.has(id)) continue;
      seen.add(id);
      if (initialPromptPresentation && record!.role === "user") continue;
      let one: { messages: unknown[]; window: NativeAgentMessageWindow };
      try {
        one = this.context.parts.projectionMessages(
          sessionKey,
          [row],
          1,
          NATIVE_REVISED_MESSAGES_MAX_BYTES,
          undefined,
          coordinatorTranscript,
          remote,
          artifactOverlay,
        );
      } catch (error) {
        if (error instanceof ProviderUnavailableError) continue;
        throw error;
      }
      const message = one.messages[0];
      if (one.window.truncated || message === undefined) continue;
      const size = encodedValue(message).bytes;
      if (bytes + size > NATIVE_REVISED_MESSAGES_MAX_BYTES) continue;
      bytes += size;
      projected.push(message);
    }
    return projected.length > 0 ? projected : undefined;
  }

  private commitProgressiveTranscript(
    key: string,
    input: NativeAgentTranscriptUpdateInput,
    projection: ProjectedProgressiveTranscript,
  ): string {
    const value = projection.value;
    const observed = this.progressiveTranscriptCache.get(key);
    if (observed?.value === value) return observed.token;
    // Each row enters as its memoized fingerprint: a read that moved one row
    // hashes that row once, not the whole window's JSON.
    const token = updateHashWithFingerprints(
      updateHashWithFingerprints(
        createHash("sha256").update(
          JSON.stringify([
            value.identity,
            value.historyEpoch,
            value.providerRevision,
            this.progressiveSourceTokens.get(key),
            projection.historyStartIndex,
            projection.historyEndIndex,
            // A publication moves the view even before its row is read. No
            // ledger read (a persisted tail) and an empty ledger hash alike, so
            // an identical view keeps its token.
            projection.ledgerRevision ?? 0,
          ]),
        ),
        value.messages,
      ),
      // A provider's token already moves when a revised row changes; hashing
      // them too keeps "unchanged" honest for one whose token does not.
      value.revisedMessages ?? [],
    )
      .digest("base64url")
      .slice(0, 43);
    const current = this.progressiveTranscriptCache.get(key);
    if (!current || current.token !== token) {
      const bytes =
        encodedBytesWithMessages(value) + (projection.directCursor?.providerCursor.length ?? 0);
      if (current) {
        this.progressiveTranscriptBytes -= current.bytes;
        this.transcriptDeltaBases.record(key, current, value);
      }
      this.progressiveTranscriptCache.delete(key);
      this.progressiveTranscriptCache.set(key, {
        token,
        sourceToken: this.progressiveSourceTokens.get(key),
        value,
        bytes,
        contentSequence: projection.keptContentSequence ?? ++this.progressiveContentSequence,
        ...(projection.historyStartIndex === undefined
          ? {}
          : { historyStartIndex: projection.historyStartIndex }),
        ...(projection.historyEndIndex === undefined
          ? {}
          : { historyEndIndex: projection.historyEndIndex }),
        ...(projection.ledgerRevision === undefined
          ? {}
          : { ledgerRevision: projection.ledgerRevision }),
        ...(projection.ledgerRevisedIds ? { ledgerRevisedIds: projection.ledgerRevisedIds } : {}),
        ...(projection.directCursor ? { directCursor: projection.directCursor } : {}),
      });
      this.progressiveTranscriptBytes += bytes;
      this.trimProgressiveTranscriptCache();
      this.scheduleDisplayTailPersist(input, value);
    }
    return token;
  }

  private async readProgressiveTranscript(
    input: NativeAgentTranscriptUpdateInput,
    key: string,
    phases?: ProgressiveReadPhaseTimer,
    bypassSourceToken = false,
  ): Promise<ProjectedProgressiveTranscript | null> {
    const resolved = await this.host.resolveProjectionSession(input);
    if (!resolved) return null;
    const previous = this.progressiveTranscriptCache.get(key);
    // A publication committed since the previous view changes rows the
    // provider has not: its "unchanged" would keep the view without them.
    const ledgerMoved =
      previous !== undefined &&
      (previous.ledgerRevision ?? 0) !== (this.context.parts.artifactOverlay(input)?.revision ?? 0);
    phases?.sourceStarted();
    const providerResult = resolved.provider.transcriptSnapshot
      ? await resolved.provider.transcriptSnapshot(resolved.session.providerSessionId, {
          limit: input.liveWindow.messages,
          targetBytes: input.liveWindow.targetBytes,
          ...(previous?.sourceToken && !ledgerMoved && !bypassSourceToken
            ? { knownSourceToken: previous.sourceToken }
            : {}),
          // This projection resolves detail locators, so it can take the
          // lightweight form; other consumers keep reading bodies inline.
          representation: "summary",
        })
      : resolved.provider.interactiveSnapshot
        ? await this.context.reads
            .sharedInteractiveSnapshot(input, resolved.provider, resolved.session.providerSessionId)
            .then(
              (snapshot) =>
                ({
                  messages: snapshot.messages,
                  complete: snapshot.messagesComplete,
                  freshness: "current" as const,
                  ...(snapshot.title ? { title: snapshot.title } : {}),
                  ...(snapshot.providerRevision === undefined
                    ? {}
                    : { revision: snapshot.providerRevision }),
                }) satisfies ProviderTranscriptSnapshot,
            )
        : ({
            messages: await resolved.provider.messages(resolved.session.providerSessionId, {
              limit: input.liveWindow.messages,
            }),
            freshness: "current" as const,
          } satisfies ProviderTranscriptSnapshot);
    phases?.sourceEnded();
    const sessionKey = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    if (this.context.reads.progressiveRequests.get(sessionKey)?.forgotten) return null;
    if ("unchanged" in providerResult) {
      if (!previous) {
        throw new ProviderUnavailableError("Provider returned unchanged without a transcript base");
      }
      this.invalidateStaleProgressiveHydration(key, providerResult.sourceToken);
      this.progressiveTranscriptCache.delete(key);
      this.progressiveTranscriptCache.set(key, {
        ...previous,
        sourceToken: providerResult.sourceToken,
      });
      this.progressiveSourceTokens.set(key, providerResult.sourceToken);
      return this.keptProgressiveProjection(previous, this.context.parts.artifactOverlay(input));
    }
    const snapshot = this.resolveProgressiveSnapshot(key, providerResult);
    if (snapshot.sourceToken) this.progressiveSourceTokens.set(key, snapshot.sourceToken);
    else this.progressiveSourceTokens.delete(key);
    const scheduleHydration = (directPagingAdopted: boolean) =>
      this.scheduleIncompleteProgressiveHydration(
        input,
        key,
        resolved.provider,
        resolved.session.providerSessionId,
        providerResult,
        resolved.session.initialPromptPresentation,
        directPagingAdopted,
      );
    /*
     * The projection reads whether a recovery is holding the preview, which
     * only one for a part-trimmed head does, so that one is scheduled first.
     * Any other is scheduled after projecting: whether the view could adopt
     * the provider's cursor decides whether it is needed at all.
     */
    const holdsPreview = (snapshot.omittedParts ?? 0) > 0;
    const previewHeadId = (snapshot.messages[0] as { id?: unknown } | undefined)?.id;
    const trimmedPreviewHeadId = typeof previewHeadId === "string" ? previewHeadId : undefined;
    if (holdsPreview) scheduleHydration(false);
    /*
     * A restarted Codex bridge knows the durable thread identity before it has
     * loaded the rollout body. Its no-touch preview is therefore empty, cached,
     * and explicitly incomplete. Keep a non-empty persisted display tail on
     * screen while the exact messages read above re-attaches the thread; the
     * preview has no authority to erase content it admits it has not loaded.
     */
    if (
      providerResult.freshness === "cached" &&
      providerResult.complete === false &&
      providerResult.messages.length === 0 &&
      previous?.value.identity.providerSessionId === resolved.session.providerSessionId &&
      previous.value.messages.length > 0
    ) {
      if (!holdsPreview) scheduleHydration(false);
      return this.keptProgressiveProjection(previous, this.context.parts.artifactOverlay(input));
    }
    let projection: ProjectedProgressiveTranscript;
    try {
      projection = this.projectProgressiveTranscript(
        input,
        key,
        snapshot,
        resolved.session.providerSessionId,
        resolved.session.initialPromptPresentation,
      );
      const title = this.context.sessionTitles.resolve({
        sessionKey: resolved.key,
        session: resolved.session,
        agent: input.agent,
        ...(projection.value.title ? { providerTitle: projection.value.title } : {}),
        ...firstUserMessageOf(
          projection.value.messages,
          projection.value.historyCursor === undefined
            ? projection.value.messageWindow
            : { truncated: true },
          // The provider bound only ever trims the oldest row of its window.
          holdsPreview ? trimmedPreviewHeadId : undefined,
        ),
        transient: resolved.transient,
        ...(resolved.provider.setSessionTitle
          ? {
              setProviderTitle: (id: string, value: string) =>
                resolved.provider.setSessionTitle!(id, value),
            }
          : {}),
      });
      if (title !== projection.value.title) {
        const { title: _providerTitle, ...rest } = projection.value;
        projection = { ...projection, value: { ...rest, ...(title ? { title } : {}) } };
      }
    } catch (error) {
      if (!holdsPreview) scheduleHydration(false);
      throw error;
    }
    if (!holdsPreview) scheduleHydration(projection.value.historyCursor !== undefined);
    return projection;
  }

  /** A held conversation may expose saved history, but must never resolve a provider. */
  async heldCoordinatorTranscript(
    input: NativeAgentProjectionInput | NativeAgentTranscriptUpdateInput,
    limit: number,
    targetBytes: number,
  ): Promise<{ view: NativeAgentTranscriptView | null; message: string } | undefined> {
    const held = await this.context.reads.heldCoordinatorRead(input);
    if (!held) return undefined;
    const view = await this.savedCoordinatorTranscript(input, limit, targetBytes);
    return { view, message: held.message };
  }

  private async savedCoordinatorTranscript(
    input: NativeAgentProjectionInput | NativeAgentTranscriptUpdateInput,
    limit: number,
    targetBytes: number,
  ): Promise<NativeAgentTranscriptView | null> {
    const sessionKey = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    const session = await this.storage.getNativeAgentSession(sessionKey);
    if (!session) return null;
    let progressive: NativeAgentTranscriptView | undefined;
    for (const { value } of this.progressiveTranscriptCache.values()) {
      if (
        value.identity.environmentId === input.environmentId &&
        value.identity.logicalSessionKey === input.logicalSessionKey &&
        value.identity.platform === input.agent &&
        value.identity.providerSessionId === session.providerSessionId &&
        (!progressive || value.messages.length >= progressive.messages.length)
      )
        progressive = value;
    }
    const legacy = this.context.full.cachedProjectionSnapshot(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    const heldLegacy = legacy?.sessionId === session.providerSessionId ? legacy : null;
    // A cut legacy view may be only a state refresh's short tail, so the saved
    // tail is consulted before showing it as all that is left of the history.
    const persisted =
      progressive || (heldLegacy && !heldLegacy.messageWindow?.truncated)
        ? null
        : await this.storage.getNativeAgentDisplayTail(sessionKey);
    const saved = persisted?.providerSessionId === session.providerSessionId ? persisted : null;
    const cached =
      progressive ??
      (heldLegacy && (!saved || heldLegacy.messages.length >= saved.messages.length)
        ? heldLegacy
        : null);
    const source = cached ?? saved;
    if (!source)
      throw new ProviderUnavailableError(
        "This conversation cannot run and has no saved transcript",
      );
    const bounded = this.context.parts.boundedProjectedMessages(
      source.messages,
      limit,
      targetBytes,
    );
    const priorWindow = source.messageWindow;
    const messageWindow = {
      ...priorWindow,
      ...bounded.window,
      truncated: priorWindow?.truncated === true || bounded.window.truncated,
      // Loading provider history would require running this conversation.
      canLoadEarlier: false,
    };
    return {
      identity: this.context.reads.progressiveIdentity(
        { ...input, viewVersion: 1 },
        session.providerSessionId,
        progressive?.identity.sourceGeneration ?? legacy?.generation ?? `saved:${input.agent}`,
      ),
      freshness: "cached",
      messages: bounded.messages,
      historyEpoch:
        progressive?.historyEpoch ?? saved?.historyEpoch ?? `saved:${session.providerSessionId}`,
      historyComplete:
        (progressive?.historyComplete ??
          (saved ? saved.historyComplete === true : priorWindow?.truncated === false)) &&
        !messageWindow.truncated,
      messageWindow,
      ...(source.title ? { title: source.title } : {}),
    };
  }

  getTranscriptUpdate(
    input: NativeAgentTranscriptUpdateInput,
    bypassSourceToken = false,
  ): Promise<NativeAgentTranscriptUpdate> {
    return this.context.reads.trackProgressiveRequest(input, () =>
      // A forced view confirms unread work only from the provider, after
      // any earlier conditional read has settled.
      this.getTranscriptUpdateOnce(input, bypassSourceToken || input.freshSource === true),
    );
  }

  private async getTranscriptUpdateOnce(
    input: NativeAgentTranscriptUpdateInput,
    bypassSourceToken = false,
  ): Promise<NativeAgentTranscriptUpdate> {
    this.host.assertProjectionInput(input);
    if (input.viewVersion !== NATIVE_AGENT_PROGRESSIVE_VIEW_VERSION) {
      throw new Error("Native agent progressive view version is unsupported");
    }
    const key = this.context.reads.progressiveKey(
      input,
      `transcript:${input.liveWindow.messages}:${input.liveWindow.targetBytes}`,
    );
    const sessionKey = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    const epoch = this.context.projectionEpochs.get(sessionKey) ?? 0;
    const startedAt = monotonicMs();
    const cached = this.progressiveTranscriptCache.get(key);
    try {
      const held = await this.heldCoordinatorTranscript(
        input,
        input.liveWindow.messages,
        input.liveWindow.targetBytes,
      );
      if (held?.view === null) return { viewVersion: 1, status: "missing" };
      if (held?.view) {
        // Saved reads must not replace a wider cached view or checkpoint a
        // smaller held window over the durable tail.
        const saved = held.view;
        const token = createHash("sha256").update(JSON.stringify(saved)).digest("base64url");
        if (!input.forceSnapshot && input.knownToken === token) {
          return { viewVersion: 1, status: "unchanged", token, identity: saved.identity };
        }
        return { viewVersion: 1, status: "snapshot", token, value: saved };
      }
    } catch (error) {
      return {
        viewVersion: 1,
        status: "unavailable",
        retryable: false,
        error: error instanceof Error ? error.message : "Saved transcript unavailable",
      };
    }
    // Phase timings for the read this caller waits on; background refreshes
    // behind a cached answer are not attributed to this response.
    const phases = new ProgressiveReadPhaseTimer();
    const publish = (
      timer?: ProgressiveReadPhaseTimer,
    ): Promise<NativeAgentTranscriptView | null> =>
      this.context.reads.trackProgressiveRequest(input, async () => {
        // Recovery needs rows even if an already-started conditional poll says
        // unchanged. Drain it before synchronously claiming fresh source work.
        if (bypassSourceToken) {
          while (this.context.reads.progressiveReads.has(key)) {
            await this.context.reads.progressiveReads.get(key)!.catch(() => undefined);
          }
        }
        const read = () => this.readProgressiveTranscript(input, key, timer, bypassSourceToken);
        const cover = () =>
          this.context.reads.progressiveReadCovering(
            key,
            sessionKey,
            epoch,
            input.forceSnapshot === true,
            timer ? timer.own(read) : read,
            // A recovery read already drained the running read above; it must
            // not take a push-observed session's settled answer either.
            bypassSourceToken,
            input.pushObservation,
          );
        const projection = await (timer ? timer.covering(cover) : cover());
        if (!projection || this.context.reads.progressiveRequests.get(sessionKey)?.forgotten)
          return null;
        const commit = () => this.commitProgressiveTranscript(key, input, projection);
        if (timer) timer.normalize(commit);
        else commit();
        return projection.value;
      });
    if (!cached && !input.forceSnapshot && !input.pushObservation) {
      const persisted = await this.storage.getNativeAgentDisplayTail(sessionKey).catch(() => null);
      if (persisted && persisted.logicalSessionKey === input.logicalSessionKey) {
        const historyComplete = persisted.historyComplete === true;
        const messageWindow = displayTailRecoveryWindow(persisted.messageWindow);
        const value: NativeAgentTranscriptView = {
          identity: this.context.reads.progressiveIdentity(
            input,
            persisted.providerSessionId,
            this.host.providerGeneration(input) ?? `in-process:${input.agent}`,
          ),
          freshness: persisted.messages.length === 0 ? "empty" : "cached",
          // Tails are written from the already-stripped progressive projection.
          // Stripping again here would drop a user-authored leading context
          // block that the first pass is documented to keep visible.
          messages: persisted.messages,
          historyEpoch: persisted.historyEpoch,
          // A write that omitted remainder metadata cannot prove the start
          // of history. Claim complete only when persisted.
          historyComplete,
          ...(messageWindow ? { messageWindow } : {}),
          ...(persisted.title ? { title: persisted.title } : {}),
        };
        const token = this.commitProgressiveTranscript(key, input, { value });
        void publish().catch(() => undefined);
        this.context.reads.recordProgressiveMetric("transcript", startedAt, "persisted", "cached");
        return { viewVersion: 1, status: "snapshot", token, value };
      }
    }
    if (
      cached &&
      !input.forceSnapshot &&
      !input.pushObservation &&
      input.knownToken !== cached.token
    ) {
      void publish().catch(() => undefined);
      const value: NativeAgentTranscriptView = { ...cached.value, freshness: "cached" };
      // This is the path a reader who is behind actually takes, so it gets what
      // it is missing rather than the whole view, without waiting for the read.
      const delta = this.transcriptDeltaForReader(input, key, value, cached.bytes);
      this.context.reads.recordProgressiveMetric(
        "transcript",
        startedAt,
        "memory",
        delta ? "delta" : "cached",
      );
      return delta
        ? {
            viewVersion: 1,
            status: "delta",
            baseToken: input.knownToken!,
            token: cached.token,
            identity: value.identity,
            delta,
          }
        : { viewVersion: 1, status: "snapshot", token: cached.token, value };
    }
    try {
      const previous = cached;
      const value = await publish(phases);
      if (!value) {
        this.context.reads.recordProgressiveMetric(
          "transcript",
          startedAt,
          "provider",
          "missing",
          phases.phases(),
        );
        return { viewVersion: 1, status: "missing" };
      }
      const entry = this.progressiveTranscriptCache.get(key)!;
      if (!input.forceSnapshot && input.knownToken === entry.token) {
        this.context.reads.recordProgressiveMetric(
          "transcript",
          startedAt,
          "provider",
          "unchanged",
          phases.phases(),
        );
        return {
          viewVersion: 1,
          status: "unchanged",
          token: entry.token,
          identity: entry.value.identity,
        };
      }
      const delta = this.transcriptDeltaForReader(input, key, value, entry.bytes, previous);
      if (delta) {
        this.context.reads.recordProgressiveMetric(
          "transcript",
          startedAt,
          "provider",
          "delta",
          phases.phases(),
        );
        return {
          viewVersion: 1,
          status: "delta",
          baseToken: input.knownToken!,
          token: entry.token,
          identity: value.identity,
          delta,
        };
      }
      this.context.reads.recordProgressiveMetric(
        "transcript",
        startedAt,
        "provider",
        "snapshot",
        phases.phases(),
      );
      return {
        viewVersion: 1,
        status: "snapshot",
        token: entry.token,
        value,
        resetReason: input.forceSnapshot
          ? "forced"
          : input.knownToken
            ? "unknown-token"
            : "initial",
      };
    } catch (error) {
      this.context.reads.recordProgressiveMetric(
        "transcript",
        startedAt,
        "provider",
        "unavailable",
        phases.phases(),
      );
      return {
        viewVersion: 1,
        status: "unavailable",
        retryable: true,
        error: error instanceof Error ? error.message.slice(0, 4_000) : "Transcript unavailable",
      };
    }
  }
}
