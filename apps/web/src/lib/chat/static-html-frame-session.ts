import {
  ArtifactFrameRateLimiter,
  normalizeArtifactLink,
} from "@orkestrator/protocol/artifact-frame-channel";
import { STATIC_PRESENTATION_POLICY } from "@orkestrator/protocol/rich-content-policy";
import {
  STATIC_HTML_FRAME_CHANNEL,
  STATIC_HTML_FRAME_PROTOCOL_VERSION,
  STATIC_HTML_MAX_FIND_QUERY_CHARACTERS,
  parseStaticHtmlFrameMessage,
  type StaticHtmlFrameErrorCode,
  type StaticHtmlFrameMessage,
  type StaticHtmlFrameRejection,
  type StaticHtmlFrameTheme,
  type StaticHtmlHostMessage,
} from "@orkestrator/protocol/static-html-presentation";

/**
 * Host side of one mounted static document frame. One instance per mount, with
 * a fresh nonce and generation:
 *
 *  - the frame document is opaque, so `event.origin` is just "null" and proves
 *    nothing; the sender window plus the per-mount identity is the check;
 *  - `render` goes out once, only after this mount's own `ready`;
 *  - a second load of the frame, or a second `ready`, means the document is
 *    not the one this mount rendered. The mount is invalidated and the
 *    protected document is never resent to whatever now occupies the frame;
 *  - persistent size oscillation or message flooding stops the mount.
 *
 * Outcomes are presentation effects only.
 */

export type StaticHtmlFrameOutcome =
  | { kind: "ready" }
  | { kind: "rendered"; height: number; themed: boolean }
  | { kind: "text"; text: string }
  | { kind: "text-partial" }
  | { kind: "size"; height: number }
  | { kind: "error"; code: StaticHtmlFrameErrorCode }
  | { kind: "interaction"; focused: boolean; hasSelection: boolean; pointerSelecting: boolean }
  | { kind: "link"; href: string; hostname: string; label: string }
  | { kind: "escape" }
  | { kind: "find-match"; top: number; height: number }
  | { kind: "reloaded" }
  | { kind: "unstable" }
  | {
      kind: "rejected";
      reason:
        | StaticHtmlFrameRejection
        | "wrong-source"
        | "wrong-nonce"
        | "invalidated"
        | "not-rendering"
        | "not-finding"
        | "rate-limited";
    };

export class StaticHtmlFrameSession {
  private phase: "awaiting-ready" | "ready" | "rendering" | "rendered" | "invalidated" =
    "awaiting-ready";
  private loads = 0;
  private refused = 0;
  private lastHeight: number | null = null;
  private sizeChanges: number[] = [];
  /** Chunks of the mount's one text report; null once it arrived or was abandoned. */
  private textChunks: string[] | null = [];
  /** What this mount's frame was last asked to find; nothing yet is the same as cleared. */
  private sentFind: { query: string; occurrence: number | null } = { query: "", occurrence: null };
  private readonly limiter: ArtifactFrameRateLimiter;
  private readonly now: () => number;

  constructor(private readonly init: { nonce: string; generation: string; now?: () => number }) {
    this.now = init.now ?? (() => Date.now());
    this.limiter = new ArtifactFrameRateLimiter(this.now);
  }

  get invalidated(): boolean {
    return this.phase === "invalidated";
  }

  invalidate(): void {
    this.phase = "invalidated";
  }

  /** The iframe fired `load`. Anything after the first is not our document. */
  noteLoad(): StaticHtmlFrameOutcome | null {
    this.loads++;
    if (this.loads < 2 || this.phase === "invalidated") return null;
    this.invalidate();
    return { kind: "reloaded" };
  }

  handle(event: { source: unknown; data: unknown }, frameWindow: unknown): StaticHtmlFrameOutcome {
    if (frameWindow == null || event.source !== frameWindow)
      return { kind: "rejected", reason: "wrong-source" };
    if (this.phase === "invalidated") return { kind: "rejected", reason: "invalidated" };
    const parsed = parseStaticHtmlFrameMessage(event.data, this.init.generation);
    if (!parsed.ok) return { kind: "rejected", reason: parsed.reason };
    // The size limit is applied by the host's coalescing, which keeps the
    // latest height; here only the overall message rate counts.
    if (!this.limiter.admit("link-request")) {
      if (++this.refused > STATIC_PRESENTATION_POLICY.maxRefusedMessages) {
        this.invalidate();
        return { kind: "unstable" };
      }
      return { kind: "rejected", reason: "rate-limited" };
    }
    const message = parsed.message;
    switch (message.type) {
      case "ready":
        if (message.nonce !== this.init.nonce) return { kind: "rejected", reason: "wrong-nonce" };
        if (this.phase !== "awaiting-ready") {
          this.invalidate();
          return { kind: "reloaded" };
        }
        this.phase = "ready";
        return { kind: "ready" };
      case "rendered":
        if (this.phase !== "rendering") return { kind: "rejected", reason: "not-rendering" };
        this.phase = "rendered";
        this.lastHeight = message.height;
        return { kind: "rendered", height: message.height, themed: message.themed };
      case "text":
        if (this.phase !== "rendered") return { kind: "rejected", reason: "not-rendering" };
        return this.noteText(message);
      case "size":
        if (this.phase !== "rendered") return { kind: "rejected", reason: "not-rendering" };
        return this.noteSize(message.height);
      case "error":
        if (this.phase !== "rendering" && this.phase !== "rendered")
          return { kind: "rejected", reason: "not-rendering" };
        this.invalidate();
        return { kind: "error", code: message.code };
      case "interaction":
        return {
          kind: "interaction",
          focused: message.focused,
          hasSelection: message.hasSelection,
          pointerSelecting: message.pointerSelecting,
        };
      case "link-request": {
        // The parser validated it; the display form is derived here, not taken from the frame.
        const link = normalizeArtifactLink(message.url);
        if (!link) return { kind: "rejected", reason: "bad-shape" };
        return { kind: "link", href: link.href, hostname: link.hostname, label: message.label };
      }
      case "escape":
        return { kind: "escape" };
      case "find-match":
        if (this.phase !== "rendered") return { kind: "rejected", reason: "not-rendering" };
        if (this.sentFind.occurrence === null) return { kind: "rejected", reason: "not-finding" };
        return { kind: "find-match", top: message.top, height: message.height };
    }
  }

  /**
   * Whole or not at all, like the document itself: a chunk out of sequence means
   * the rate limiter dropped one, and part of a report is never indexed.
   */
  private noteText(
    message: Extract<StaticHtmlFrameMessage, { type: "text" }>,
  ): StaticHtmlFrameOutcome {
    const chunks = this.textChunks;
    if (chunks === null || message.index !== chunks.length) {
      this.textChunks = null;
      return { kind: "rejected", reason: "bad-shape" };
    }
    chunks.push(message.text);
    if (chunks.length < message.count) return { kind: "text-partial" };
    this.textChunks = null;
    return { kind: "text", text: chunks.join("") };
  }

  private noteSize(height: number): StaticHtmlFrameOutcome {
    if (height === this.lastHeight) return { kind: "size", height };
    this.lastHeight = height;
    const now = this.now();
    const windowStart = now - STATIC_PRESENTATION_POLICY.sizeChangeWindowMs;
    this.sizeChanges = this.sizeChanges.filter((at) => at > windowStart);
    this.sizeChanges.push(now);
    if (this.sizeChanges.length > STATIC_PRESENTATION_POLICY.maxSizeChangesPerWindow) {
      this.invalidate();
      return { kind: "unstable" };
    }
    return { kind: "size", height };
  }

  /** The one `render` of this mount; null when it is not due or already sent. */
  renderMessage(
    html: string,
    theme: StaticHtmlFrameTheme,
    verifiedAppearance: "light" | "dark",
  ): StaticHtmlHostMessage | null {
    if (this.phase !== "ready") return null;
    this.phase = "rendering";
    return {
      channel: STATIC_HTML_FRAME_CHANNEL,
      v: STATIC_HTML_FRAME_PROTOCOL_VERSION,
      type: "render",
      generation: this.init.generation,
      html,
      theme,
      verifiedAppearance,
    };
  }

  themeMessage(theme: StaticHtmlFrameTheme): StaticHtmlHostMessage | null {
    if (this.phase !== "rendered") return null;
    return {
      channel: STATIC_HTML_FRAME_CHANNEL,
      v: STATIC_HTML_FRAME_PROTOCOL_VERSION,
      type: "theme",
      generation: this.init.generation,
      theme,
    };
  }

  /**
   * The query and active match, when they differ from what the frame last heard.
   * A query past the channel's limit clears the frame instead of being sent, which
   * leaves that card as it is with no frame: the match leads to the card.
   */
  findMessage(query: string, occurrence: number | null): StaticHtmlHostMessage | null {
    if (this.phase !== "rendered") return null;
    const sendable =
      query.trim().length > 0 && query.length <= STATIC_HTML_MAX_FIND_QUERY_CHARACTERS;
    const next = sendable ? { query, occurrence } : { query: "", occurrence: null };
    if (next.query === this.sentFind.query && next.occurrence === this.sentFind.occurrence)
      return null;
    this.sentFind = next;
    return {
      channel: STATIC_HTML_FRAME_CHANNEL,
      v: STATIC_HTML_FRAME_PROTOCOL_VERSION,
      type: "find",
      generation: this.init.generation,
      ...next,
    };
  }
}
