import type {
  NativeAgentMessagePageInput,
  NativeAgentMessagePage,
} from "./native-agent-service-shared.js";
import {
  NATIVE_PROJECTION_MAX_BYTES,
  NATIVE_HISTORY_PAGE_DEFAULT_BYTES,
  NATIVE_HISTORY_PAGE_DEFAULT_MESSAGES,
  NATIVE_HISTORY_PAGE_MAX_MESSAGES,
  NATIVE_HISTORY_PAGE_MAX_TARGET_BYTES,
  boundTranscriptResponse,
} from "./native-agent-service-shared.js";
import { monotonicMs } from "./native-agent-progressive-metrics.js";
import { decodeHistoryCursor, encodeDirectHistoryCursor } from "./native-agent-direct-history.js";
import { overlayArtifactParts } from "./native-agent-service-projection-artifacts.js";
import { type ProjectionDetailRegistration } from "./native-agent-projection-entries.js";
import { encodedArrayBytes, encodedValue } from "./native-agent-projection-encoding.js";
import { DIRECT_PAGE_ROW_MAX_BYTES } from "./native-agent-projection-helpers.js";
import {
  hasServerPromptPreamble,
  type NativeAgentTranscriptProjectionHost,
  type NativeAgentProjectionContext,
} from "./native-agent-projection-context.js";

/**
 * Direct history pages (`get_native_agent_message_page`): older rows behind a
 * provider-positioned cursor, answered from the shared page cache or by
 * projecting only that range.
 */
export class NativeAgentHistoryPages {
  private readonly host: NativeAgentTranscriptProjectionHost;

  constructor(private readonly context: NativeAgentProjectionContext) {
    this.host = context.host;
  }

  /**
   * Serve one page of older rows behind a direct (provider-positioned) cursor.
   * No projection refresh, composer or interaction read, and no fingerprint
   * pass over earlier pages: validate the owner, then answer from the page
   * cache while the cursor's epoch is still the session's current one, or read
   * and project only that range. Every view whose provider pages names such a
   * cursor; any other cursor (including a retired joined v1 one) is expired.
   */
  async getMessagePage(input: NativeAgentMessagePageInput): Promise<NativeAgentMessagePage> {
    this.host.assertProjectionInput(input);
    if (input.before.length > 1024) throw new Error("History cursor is too large");
    const startedAt = monotonicMs();
    const resolved = await this.host.resolveProjectionSession(input);
    if (!resolved) throw new Error("Native agent history is unavailable");
    const providerSessionId = resolved.session.providerSessionId;
    const cursor = decodeHistoryCursor(
      input.before,
      { sessionKey: resolved.key, providerSessionId },
      this.context.parts.directHistoryCursorHandles,
    );
    if (cursor.version !== 2) throw new Error("Native agent history cursor expired");
    const transcriptPage = resolved.provider.transcriptPage?.bind(resolved.provider);
    if (!transcriptPage) {
      throw new Error("Native agent history cursor expired");
    }
    const limit = Math.min(
      input.limit ?? NATIVE_HISTORY_PAGE_DEFAULT_MESSAGES,
      NATIVE_HISTORY_PAGE_MAX_MESSAGES,
    );
    const targetBytes = Math.min(
      input.targetBytes ?? NATIVE_HISTORY_PAGE_DEFAULT_BYTES,
      NATIVE_HISTORY_PAGE_MAX_TARGET_BYTES,
    );
    const pageKey = [
      resolved.key,
      providerSessionId,
      cursor.epoch,
      cursor.providerCursor,
      limit,
      targetBytes,
    ].join("\0");
    const cached = this.context.parts.directHistoryPages.lookup(
      resolved.key,
      providerSessionId,
      cursor.epoch,
      pageKey,
      this.host.now(),
    );
    // Cached pages hold provider rows only; publications are placed on the
    // way out, so a ledger change never leaves a stale page behind.
    const withArtifacts = (page: NativeAgentMessagePage): NativeAgentMessagePage => ({
      ...page,
      messages: overlayArtifactParts(
        page.messages,
        this.context.parts.artifactOverlay(input),
      ).slice(),
    });
    const mintNextCursor = (providerCursor: string | undefined): string | undefined =>
      providerCursor
        ? encodeDirectHistoryCursor(
            {
              sessionKey: resolved.key,
              providerSessionId,
              historyEpoch: cursor.epoch,
              providerCursor,
            },
            this.context.parts.directHistoryCursorHandles,
          )
        : undefined;
    /*
     * Every answer mints its `nextCursor` again from the provider's own
     * continuation. An overlong one travels as a handle in a bounded store
     * that evicts on its own schedule, so the cursor cached with the page can
     * name a handle that is gone; minting registers it again. A short cursor
     * mints to the same bytes, so this is a no-op for it.
     */
    const answer = (value: {
      page: NativeAgentMessagePage;
      providerCursor?: string;
    }): NativeAgentMessagePage => {
      if (!value.providerCursor) return withArtifacts(value.page);
      const nextCursor = mintNextCursor(value.providerCursor);
      if (!nextCursor) throw new Error("Native agent history cursor expired");
      return withArtifacts({ ...value.page, nextCursor });
    };
    if (cached) {
      if (this.context.parts.restoreDetailRegistrations(resolved.key, cached.details)) {
        this.context.reads.recordProgressiveMetric("transcript", startedAt, "memory", "cached");
        return answer(cached);
      }
      // An inline detail body was evicted; only a fresh read registers it again.
      this.context.parts.directHistoryPages.delete(pageKey);
    }
    const loaded = await this.context.parts.directHistoryPages.load(
      { sessionKey: resolved.key, providerSessionId, epoch: cursor.epoch, key: pageKey },
      async () => {
        const sourceStartedAt = monotonicMs();
        const providerPage = await transcriptPage(providerSessionId, {
          cursor: cursor.providerCursor,
          limit,
          targetBytes,
        });
        const sourceMs = monotonicMs() - sourceStartedAt;
        // An epoch the provider no longer holds is a rewritten history. The
        // renderer resets and re-reads rather than stitching pages from two
        // histories together.
        if (
          !providerPage ||
          providerPage.status !== "page" ||
          providerPage.historyEpoch !== cursor.epoch
        ) {
          this.context.reads.recordProgressiveMetric(
            "transcript",
            startedAt,
            "provider",
            "missing",
            {
              sourceMs,
            },
          );
          throw new Error("Native agent history cursor expired");
        }
        const normalizeStartedAt = monotonicMs();
        const details: ProjectionDetailRegistration[] = [];
        const sink = this.context.parts.detailRegistrations;
        this.context.parts.detailRegistrations = details;
        let projected: { messages: unknown[] };
        try {
          /*
           * The provider already bounded the page, so this projection must
           * not drop a row of it: the row would fall between two cursors.
           * Only the hard transcript bound applies to the page as a whole.
           */
          projected = this.context.parts.projectionMessages(
            resolved.key,
            providerPage.messages,
            Math.max(limit, providerPage.messages.length),
            NATIVE_PROJECTION_MAX_BYTES,
            resolved.session.initialPromptPresentation,
            hasServerPromptPreamble(input.environmentId),
            { providerSessionId },
          );
        } finally {
          this.context.parts.detailRegistrations = sink;
        }
        const normalizeMs = monotonicMs() - normalizeStartedAt;
        if (projected.messages.length !== providerPage.messages.length) {
          throw new Error("Native agent history page exceeded its bound");
        }
        /*
         * A bridge sends a row larger than the page target whole, up to its
         * oversized-row ceiling, and projection only shrinks it. A provider
         * that pages raw rows (OpenCode) can still hand over one larger than
         * that — an inline attachment the projection keeps. Trim that row on
         * its own rather than refuse the page: refusing wedged the walk on it
         * forever, while a trimmed row still lets every older page load.
         */
        let trimmedRow = false;
        const pageMessages = projected.messages.map((message) => {
          if (encodedValue(message).bytes <= DIRECT_PAGE_ROW_MAX_BYTES) return message;
          const bounded = boundTranscriptResponse(
            [message as { content: string; parts: unknown[] }],
            DIRECT_PAGE_ROW_MAX_BYTES,
            { envelopeReserveBytes: 0, contentFallbackBytes: 64 * 1024 },
          );
          trimmedRow = true;
          return bounded.messages[0] ?? message;
        });
        const nextCursor = mintNextCursor(providerPage.historyCursor);
        if (providerPage.historyCursor && !nextCursor) {
          throw new Error("Native agent history cursor expired");
        }
        this.context.reads.recordProgressiveMetric(
          "transcript",
          startedAt,
          "provider",
          "snapshot",
          {
            sourceMs,
            normalizeMs,
          },
        );
        const page: NativeAgentMessagePage = {
          syncVersion: 1,
          messages: pageMessages,
          historyEpoch: cursor.epoch,
          ...(nextCursor ? { nextCursor } : {}),
          complete: !nextCursor && providerPage.complete,
          truncated:
            Boolean(nextCursor) || !providerPage.complete || providerPage.truncated || trimmedRow,
          // A provider page's own `truncated` means a row it trimmed.
          ...(providerPage.truncated || trimmedRow ? { rowsTrimmed: true as const } : {}),
        };
        const detailBytes = details.reduce(
          (total, detail) => total + 64 + detail.ref.length + (detail.remote?.locator.length ?? 0),
          0,
        );
        const providerCursor = providerPage.historyCursor;
        return {
          value: { page, details, ...(providerCursor ? { providerCursor } : {}) },
          bytes:
            encodedArrayBytes(page.messages) +
            detailBytes +
            (nextCursor?.length ?? 0) +
            (providerCursor?.length ?? 0) +
            256,
        };
      },
      () => this.host.now(),
    );
    // Callers share the cached page; each gets its own message array.
    return answer(loaded);
  }
}
