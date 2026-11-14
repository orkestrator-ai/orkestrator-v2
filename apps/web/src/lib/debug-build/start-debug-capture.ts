import { windowCapture } from "@/lib/native/window";
import { useDebugBuildStore, type DebugBuildTarget } from "@/stores/debugBuildStore";

/** How long a window capture may take before the dialog opens without it. */
export const DEBUG_CAPTURE_TIMEOUT_MS = 10_000;

/** Shown when the capture did not finish within {@link DEBUG_CAPTURE_TIMEOUT_MS}. */
export const DEBUG_CAPTURE_TIMED_OUT =
  "The window capture did not finish in time, so no screenshot is attached.";

/** Shown when this client has no way to capture its own window (a browser tab). */
export const DEBUG_CAPTURE_UNAVAILABLE =
  "This client cannot capture its window. Screenshots are available in the desktop app.";

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

const TIMED_OUT = Symbol("debug-capture-timed-out");

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(TIMED_OUT), timeoutMs);
  });
  // A late rejection of the abandoned capture is not an unhandled one.
  work.catch(() => undefined);
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() || "The window could not be captured";
}

/**
 * The debug button's press: capture the window as it is now, then open the
 * debug dialog with that capture.
 *
 * The capture happens before the dialog exists, so it shows the page the user
 * was looking at and never the dialog itself. Two frames let a menu or
 * tooltip the press dismissed finish closing first. A press while a capture
 * or the dialog is already in progress is ignored.
 *
 * A capture that never settles must not leave the button disabled: after
 * `timeoutMs` the dialog opens without a screenshot and says why, and the
 * capture's late answer is ignored.
 */
export async function startDebugCapture(
  target: DebugBuildTarget,
  capture: (() => Promise<string>) | null = windowCapture(),
  timeoutMs: number = DEBUG_CAPTURE_TIMEOUT_MS,
): Promise<void> {
  const store = useDebugBuildStore.getState();
  if (store.capturing || store.open) return;
  store.beginCapture(target);
  let screenshot: string | null = null;
  let captureError: string | null = null;
  if (!capture) {
    captureError = DEBUG_CAPTURE_UNAVAILABLE;
  } else {
    try {
      await nextFrame();
      await nextFrame();
      screenshot = await withTimeout(capture(), timeoutMs);
    } catch (error) {
      captureError = error === TIMED_OUT ? DEBUG_CAPTURE_TIMED_OUT : errorText(error);
    }
  }
  // Closed meanwhile (another surface reset it): do not reopen.
  if (!useDebugBuildStore.getState().capturing) return;
  useDebugBuildStore.getState().showDialog({ screenshot, captureError });
}
