import type { DesignOperation } from "@orkestrator/protocol/design-canvas";

/** One window, bounded asks, source-checked replies; teardown rejects every ask. */
export class DesignFrameBridge {
  renderedRevision: number | null = null;
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
    private readonly target: Window,
    private readonly timeoutMs = 3000,
  ) {
    window.addEventListener("message", this.receive);
  }
  private receive = (event: MessageEvent) => {
    if (event.source !== this.target || event.data?.channel !== "orkestrator-design") return;
    const pending = this.pending.get(event.data.requestId);
    if (!pending) return;
    this.pending.delete(event.data.requestId);
    clearTimeout(pending.timer);
    if (event.data.error) pending.reject(new Error(String(event.data.error).slice(0, 300)));
    else pending.resolve(event.data.result);
  };
  ask<T>(operation: DesignOperation): Promise<T> {
    if (this.pending.size >= 32) return Promise.reject(new Error("Frame runtime busy"));
    const requestId = String(++this.sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Frame runtime did not respond"));
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve: (value) => resolve(value as T), reject, timer });
      this.target.postMessage({ channel: "orkestrator-design", requestId, operation }, "*");
    });
  }
  close() {
    window.removeEventListener("message", this.receive);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Frame closed"));
    }
    this.pending.clear();
  }
}
