import type { DesignOperation } from "@orkestrator/protocol/design-canvas";

let generations = 0;

/**
 * One window, bounded asks, source-checked replies; teardown rejects every ask.
 *
 * The sandboxed frame's `Window` is cross-origin, so it lives in a true private
 * field: anything that enumerates this object (React's dev-mode prop diffing,
 * loggers, structured clones) must never touch it, or it throws a SecurityError.
 */
export class DesignFrameBridge {
  readonly #target: Window;
  /** Legacy render marker (frame revision) for v1 backends. */
  renderedRevision: number | null = null;
  /** Content identity currently rendered; null while (re)rendering. */
  renderedContentId: string | null = null;
  /** Distinguishes recreated iframes: acknowledgments from older ones are ignored. */
  readonly generation = ++generations;
  closed = false;
  private sequence = 0;
  private readonly pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (reason: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(
    target: Window,
    private readonly timeoutMs = 3000,
    private readonly onEscape?: () => void,
  ) {
    this.#target = target;
    window.addEventListener("message", this.receive);
  }
  private receive = (event: MessageEvent) => {
    if (event.source !== this.#target) return;
    if (event.data?.channel === "orkestrator-design-escape") {
      this.onEscape?.();
      return;
    }
    if (event.data?.channel !== "orkestrator-design") return;
    const pending = this.pending.get(event.data.requestId);
    if (!pending) return;
    this.pending.delete(event.data.requestId);
    clearTimeout(pending.timer);
    if (event.data.error) pending.reject(new Error(String(event.data.error).slice(0, 300)));
    else pending.resolve(event.data.result);
  };
  get pendingCount() {
    return this.pending.size;
  }
  ask<T>(operation: DesignOperation): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Frame closed"));
    if (this.pending.size >= 32) return Promise.reject(new Error("Frame runtime busy"));
    const requestId = String(++this.sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Frame runtime did not respond"));
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve: (value) => resolve(value as T), reject, timer });
      this.#target.postMessage({ channel: "orkestrator-design", requestId, operation }, "*");
    });
  }
  close() {
    this.closed = true;
    window.removeEventListener("message", this.receive);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Frame closed"));
    }
    this.pending.clear();
  }
}
