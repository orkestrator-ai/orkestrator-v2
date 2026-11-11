import { createLogger } from "@orkestrator/protocol/logger";
import {
  isRendererErrorClientId,
  parseRendererErrorBatch,
  type RecordRendererErrorsResult,
} from "@orkestrator/protocol/renderer-errors";

const log = createLogger("renderer-errors");

/** The bound on what renderers may write, across every client of this backend. */
export const RENDERER_ERROR_WINDOW_MS = 60_000;
export const RENDERER_ERROR_ENTRIES_PER_WINDOW = 30;
/** One renderer's share of that bound, when it names itself with a `client` id. */
export const RENDERER_ERROR_ENTRIES_PER_CLIENT = 10;
/**
 * Distinct client ids one window tracks. Ids past this share one extra slot,
 * so a sender minting ids cannot grow the map or take more than one share.
 */
export const RENDERER_ERROR_CLIENTS_PER_WINDOW = 64;
const OVERFLOW_CLIENT = "";

/**
 * The backend half of the renderer error ring: the new counts of a desktop
 * window's renderer or a browser tab, checked field by field and written to
 * the essential log as `renderer-errors` `error.recorded`
 * (docs/architecture/logging.md, "Renderer failures in the essential log").
 *
 * Every entry is parsed against the fixed lists again here, so a renderer that
 * sends a message, a stack or a name outside the lists has the whole write
 * refused. Accepted entries are bounded per minute for all clients together,
 * and a write that names its renderer (`client`) also by that renderer's own
 * share, so one noisy tab cannot use the minute other windows need. A write
 * without one (a renderer from before the share) is bounded by the total
 * alone. The rest are counted in one `report.rate-limited` line per window.
 * The client id is never logged. The essential log's own per-event budget
 * applies after this as well.
 */
export class RendererErrorRecorder {
  private windowStartedAt = Number.NEGATIVE_INFINITY;
  private usedInWindow = 0;
  private droppedInWindow = 0;
  private readonly usedByClient = new Map<string, number>();
  private dropTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly perWindow = RENDERER_ERROR_ENTRIES_PER_WINDOW,
    private readonly schedule = (callback: () => void, delay: number) => {
      const timer = setTimeout(callback, delay);
      timer.unref();
      return timer;
    },
    private readonly perClient = RENDERER_ERROR_ENTRIES_PER_CLIENT,
  ) {}

  record(value: unknown, client?: unknown): RecordRendererErrorsResult {
    const entries = parseRendererErrorBatch(value);
    if (!entries) {
      throw new Error(
        "Renderer error entries must be a short list of errorClass, boundary, route, fingerprint and count",
      );
    }
    if (client !== undefined && !isRendererErrorClientId(client)) {
      throw new Error("Renderer error client must be a short id of letters, digits, - and _");
    }
    const now = this.now();
    if (now - this.windowStartedAt >= RENDERER_ERROR_WINDOW_MS || now < this.windowStartedAt) {
      this.flushDropped();
      this.windowStartedAt = now;
      this.usedInWindow = 0;
      this.droppedInWindow = 0;
      this.usedByClient.clear();
    }
    let room = Math.max(0, this.perWindow - this.usedInWindow);
    const key =
      client === undefined
        ? undefined
        : this.usedByClient.has(client) ||
            this.usedByClient.size < RENDERER_ERROR_CLIENTS_PER_WINDOW
          ? client
          : OVERFLOW_CLIENT;
    if (key !== undefined) {
      room = Math.min(room, Math.max(0, this.perClient - (this.usedByClient.get(key) ?? 0)));
    }
    const accepted = Math.min(entries.length, room);
    this.usedInWindow += accepted;
    if (key !== undefined) this.usedByClient.set(key, (this.usedByClient.get(key) ?? 0) + accepted);
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
