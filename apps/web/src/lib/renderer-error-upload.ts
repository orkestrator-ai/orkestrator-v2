import {
  RECORD_RENDERER_ERRORS_COMMAND,
  type RecordRendererErrorsResult,
  type RendererErrorEntry,
} from "@orkestrator/protocol/renderer-errors";
import { isUnsupportedBackendCommand } from "./backend/shared";
import type { RendererErrorRing } from "./renderer-error-ring";

/** How often new counts go to the backend, and the longest a failing backend waits. */
export const RENDERER_ERROR_UPLOAD_INTERVAL_MS = 10_000;
export const RENDERER_ERROR_UPLOAD_MAX_INTERVAL_MS = 5 * 60_000;

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
 * batch at a time and no more often than every ten seconds. A failed send puts
 * the counts back and waits longer each time, up to five minutes; a backend
 * that predates the command stops the upload for this load. Only a desktop
 * window's own renderer starts this (`renderer-entry.tsx`).
 */
export function startRendererErrorUpload({
  ring,
  send,
  intervalMs = RENDERER_ERROR_UPLOAD_INTERVAL_MS,
  maxIntervalMs = RENDERER_ERROR_UPLOAD_MAX_INTERVAL_MS,
  timer = browserTimer,
}: {
  ring: RendererErrorRing;
  send: (entries: RendererErrorEntry[]) => Promise<RecordRendererErrorsResult | unknown>;
  intervalMs?: number;
  maxIntervalMs?: number;
  timer?: UploadTimer;
}): () => void {
  let stopped = false;
  let handle: unknown = null;
  let delay = intervalMs;

  const schedule = () => {
    if (!stopped) handle = timer.set(tick, delay);
  };
  const tick = async () => {
    handle = null;
    const batch = ring.takeUnsent();
    if (batch.length > 0) {
      try {
        await send(batch);
        delay = intervalMs;
      } catch (error) {
        ring.restore(batch);
        if (isUnsupportedBackendCommand(error, RECORD_RENDERER_ERRORS_COMMAND)) {
          stopped = true;
          return;
        }
        delay = Math.min(delay * 2, maxIntervalMs);
      }
    }
    schedule();
  };
  schedule();
  return () => {
    stopped = true;
    if (handle !== null) timer.clear(handle);
  };
}
