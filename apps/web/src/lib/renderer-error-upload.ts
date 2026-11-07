import {
  RECORD_RENDERER_ERRORS_COMMAND,
  parseRendererErrorEntry,
  RENDERER_ERROR_RING_SIZE,
  type RecordRendererErrorsResult,
  type RendererErrorEntry,
} from "@orkestrator/protocol/renderer-errors";
import { incompatibility } from "@orkestrator/protocol/contract/errors";
import type { RendererErrorRing } from "./renderer-error-ring";

/** How often new counts go to the backend, and the longest a failing backend waits. */
export const RENDERER_ERROR_UPLOAD_INTERVAL_MS = 10_000;
export const RENDERER_ERROR_UPLOAD_MAX_INTERVAL_MS = 5 * 60_000;

export const RENDERER_ERROR_PENDING_KEY = "orkestrator:pending-renderer-errors";
const MAX_PENDING_CHARS = 32_768;
type PendingStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

interface UploadTimer {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

const browserTimer: UploadTimer = {
  set: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clear: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

/**
 * Sends the ring's new counts to the backend's essential log, one bounded
 * batch at a time. The first failure sends promptly; subsequent sends are spaced
 * by ten seconds, except a best-effort pagehide flush. Pending metadata is
 * journaled in per-window session storage until acknowledged (an ambiguous
 * delivery may be counted again after reload). A failed send puts
 * the counts back and waits longer each time, up to five minutes; a backend
 * that predates the command stops the upload for this load. Only a desktop
 * window's own renderer starts this (`renderer-diagnostics.ts`).
 */
export function startRendererErrorUpload({
  ring,
  send,
  intervalMs = RENDERER_ERROR_UPLOAD_INTERVAL_MS,
  maxIntervalMs = RENDERER_ERROR_UPLOAD_MAX_INTERVAL_MS,
  timer = browserTimer,
  storage,
  lifecycle = globalThis.window,
}: {
  ring: RendererErrorRing;
  send: (entries: RendererErrorEntry[]) => Promise<RecordRendererErrorsResult | unknown>;
  intervalMs?: number;
  maxIntervalMs?: number;
  timer?: UploadTimer;
  storage?: PendingStorage | null;
  lifecycle?: Pick<Window, "addEventListener" | "removeEventListener">;
}): () => void {
  let stopped = false;
  let handle: unknown = null;
  let delay = intervalMs;
  let sending = false;
  let activeBatch: RendererErrorEntry[] = [];
  let first = true;
  try {
    if (storage === undefined) storage = globalThis.sessionStorage;
    const raw = storage?.getItem(RENDERER_ERROR_PENDING_KEY);
    if (raw && raw.length <= MAX_PENDING_CHARS) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length <= RENDERER_ERROR_RING_SIZE) {
        ring.recover(
          parsed.flatMap((value) => {
            const entry = parseRendererErrorEntry(value);
            return entry ? [entry] : [];
          }),
        );
      }
    }
  } catch {
    /* Storage may be blocked; uploads still work. */
  }
  const persist = () => {
    try {
      const pending = [...activeBatch, ...ring.pendingEntries()].slice(-RENDERER_ERROR_RING_SIZE);
      if (pending.length) storage?.setItem(RENDERER_ERROR_PENDING_KEY, JSON.stringify(pending));
      else storage?.removeItem(RENDERER_ERROR_PENDING_KEY);
    } catch {
      /* Never fail an error handler because storage is unavailable. */
    }
  };

  const schedule = () => {
    if (!stopped) handle = timer.set(tick, delay);
  };
  const tick = async () => {
    if (stopped || sending) return;
    if (handle !== null) timer.clear(handle);
    handle = null;
    sending = true;
    const batch = ring.takeUnsent();
    activeBatch = batch;
    persist();
    if (batch.length > 0) {
      first = false;
      try {
        await send(batch);
        delay = intervalMs;
      } catch (error) {
        ring.restore(batch);
        if (incompatibility(error, RECORD_RENDERER_ERRORS_COMMAND)?.code === "unknown-command") {
          stopped = true;
        }
        delay = Math.min(delay * 2, maxIntervalMs);
      }
    }
    activeBatch = [];
    sending = false;
    persist();
    schedule();
  };
  const changed = () => {
    persist();
    if (first && !stopped && !sending) {
      if (handle !== null) timer.clear(handle);
      handle = timer.set(tick, 0);
    }
  };
  const unsubscribe = ring.subscribe(changed);
  const pagehide = () => {
    persist();
    void tick();
  };
  lifecycle?.addEventListener("pagehide", pagehide);
  if (ring.hasUnsent()) changed();
  else schedule();
  return () => {
    stopped = true;
    unsubscribe();
    lifecycle?.removeEventListener("pagehide", pagehide);
    if (handle !== null) timer.clear(handle);
  };
}
