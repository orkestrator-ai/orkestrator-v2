import { windowCapture } from "@/lib/native/window";
import { useDebugBuildStore, type DebugBuildTarget } from "@/stores/debugBuildStore";

/** Shown when this client has no way to capture its own window (a browser tab). */
export const DEBUG_CAPTURE_UNAVAILABLE =
  "This client cannot capture its window. Screenshots are available in the desktop app.";

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
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
 */
export async function startDebugCapture(
  target: DebugBuildTarget,
  capture: (() => Promise<string>) | null = windowCapture(),
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
      screenshot = await capture();
    } catch (error) {
      captureError = errorText(error);
    }
  }
  // Closed meanwhile (another surface reset it): do not reopen.
  if (!useDebugBuildStore.getState().capturing) return;
  useDebugBuildStore.getState().showDialog({ screenshot, captureError });
}
