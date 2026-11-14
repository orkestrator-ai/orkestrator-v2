import { isAppShortcutId } from "@orkestrator/protocol/keyboard-shortcuts";
import type { DesignOperation } from "@orkestrator/protocol/design-canvas";
import { requestAppShortcut } from "@/lib/app-shortcuts";

let generations = 0;

/**
 * One window, bounded asks, source-checked replies; teardown rejects every ask.
 *
 * Construction has no side effect: the bridge listens only once `open()` is
 * called, and the code that opens it must also close it. Callers create a
 * bridge in an iframe's `load` handler and keep it in React state, where it can
 * be replaced (two loads before a render) or dropped (an unmount) before it is
 * ever committed. A listener added by the constructor would then never be
 * removed, and would keep the bridge and the frame's `Window` alive.
 *
 * The sandboxed frame's `Window` is cross-origin, so it lives in a true private
 * field: anything that enumerates this object (React's dev-mode prop diffing,
 * loggers, structured clones) must never touch it, or it throws a SecurityError.
 *
 * `close()` drops that `Window`. A closed bridge can outlive its iframe: the
 * previous render of `DesignFrameView` stays reachable from React until the
 * component renders again, and its closures share the render's scope, which
 * holds the bridge. Holding the `Window` too kept the culled frame's
 * RemoteFrame alive, one extra frame the perf harness's leak check counted
 * (to-do 7820, retired 2026-11-14; `design-canvas.md` → Tests).
 */
export class DesignFrameBridge {
  #target: Window | null;
  /** Legacy render marker (frame revision) for v1 backends. */
  renderedRevision: number | null = null;
  /** Content identity currently rendered; null while (re)rendering. */
  renderedContentId: string | null = null;
  /** Distinguishes recreated iframes: acknowledgments from older ones are ignored. */
  readonly generation = ++generations;
  closed = false;
  private opened = false;
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
  }
  /** Starts listening for replies. Idempotent; a closed bridge stays closed. */
  open(): this {
    if (this.opened || this.closed) return this;
    this.opened = true;
    window.addEventListener("message", this.receive);
    return this;
  }
  private receive = (event: MessageEvent) => {
    if (!this.#target || event.source !== this.#target) return;
    if (event.data?.channel === "orkestrator-design-shortcuts") {
      const shortcut: unknown = event.data.shortcut;
      if (isAppShortcutId(shortcut)) requestAppShortcut(shortcut);
      return;
    }
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
    const target = this.#target;
    if (this.closed || !target) return Promise.reject(new Error("Frame closed"));
    if (!this.opened) return Promise.reject(new Error("Frame bridge not open"));
    if (this.pending.size >= 32) return Promise.reject(new Error("Frame runtime busy"));
    const requestId = String(++this.sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Frame runtime did not respond"));
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve: (value) => resolve(value as T), reject, timer });
      target.postMessage({ channel: "orkestrator-design", requestId, operation }, "*");
    });
  }
  close() {
    this.closed = true;
    this.#target = null;
    window.removeEventListener("message", this.receive);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Frame closed"));
    }
    this.pending.clear();
  }
}
