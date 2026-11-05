import { createLogger } from "@orkestrator/protocol/logger";
import {
  parseRendererErrorBatch,
  type RecordRendererErrorsResult,
} from "@orkestrator/protocol/renderer-errors";

const log = createLogger("renderer-errors");

/** The bound on what renderers may write, across every client of this backend. */
export const RENDERER_ERROR_WINDOW_MS = 60_000;
export const RENDERER_ERROR_ENTRIES_PER_WINDOW = 30;

/**
 * The backend half of the renderer error ring: a desktop window's new counts,
 * checked field by field and written to the essential log as `renderer-errors`
 * `error.recorded` (docs/architecture/logging.md, "Renderer failures in the essential log").
 *
 * Every entry is parsed against the fixed lists again here, so a renderer that
 * sends a message, a stack or a name outside the lists has the whole write
 * refused. Accepted entries are bounded per minute for all clients together;
 * the rest are counted in one `report.rate-limited` line per window. The
 * essential log's own per-event budget applies after this as well.
 */
export class RendererErrorRecorder {
  private windowStartedAt = Number.NEGATIVE_INFINITY;
  private usedInWindow = 0;
  private droppedInWindow = 0;
  private dropTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly perWindow = RENDERER_ERROR_ENTRIES_PER_WINDOW,
    private readonly schedule = (callback: () => void, delay: number) => {
      const timer = setTimeout(callback, delay);
      timer.unref();
      return timer;
    },
  ) {}

  record(value: unknown): RecordRendererErrorsResult {
    const entries = parseRendererErrorBatch(value);
    if (!entries) {
      throw new Error(
        "Renderer error entries must be a short list of errorClass, boundary, route, fingerprint and count",
      );
    }
    const now = this.now();
    if (now - this.windowStartedAt >= RENDERER_ERROR_WINDOW_MS || now < this.windowStartedAt) {
      this.flushDropped();
      this.windowStartedAt = now;
      this.usedInWindow = 0;
      this.droppedInWindow = 0;
    }
    const accepted = Math.min(entries.length, Math.max(0, this.perWindow - this.usedInWindow));
    this.usedInWindow += accepted;
    for (const entry of entries.slice(0, accepted)) {
      log.warn("error.recorded", {
        errorClass: entry.errorClass,
        boundary: entry.boundary,
        route: entry.route,
        fingerprint: entry.fingerprint,
        count: entry.count,
      });
    }
    const dropped = entries.length - accepted;
    if (dropped > 0) {
      // One bounded timer reports the entire window even if requests stop.
      this.droppedInWindow += dropped;
      if (this.dropTimer === undefined) {
        this.dropTimer = this.schedule(
          () => this.flushDropped(),
          Math.max(0, this.windowStartedAt + RENDERER_ERROR_WINDOW_MS - now),
        );
      }
    }
    return { accepted, dropped };
  }

  private flushDropped(): void {
    if (this.dropTimer !== undefined) clearTimeout(this.dropTimer);
    this.dropTimer = undefined;
    if (this.droppedInWindow > 0) {
      log.warn("report.rate-limited", { dropped: this.droppedInWindow });
      this.droppedInWindow = 0;
    }
  }
}
