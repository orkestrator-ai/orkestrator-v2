import { useSyncExternalStore } from "react";

/**
 * The user is looking at this window right now, not just has it open: the
 * page is visible and the window holds keyboard focus. A window left behind
 * another application, minimised, or on another desktop is not foreground.
 */
export function isWindowForeground(): boolean {
  if (typeof document === "undefined") return false;
  return document.visibilityState === "visible" && document.hasFocus();
}

/** Calls `listener` whenever {@link isWindowForeground} may have changed. */
export function subscribeWindowForeground(listener: () => void): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => undefined;
  window.addEventListener("focus", listener);
  window.addEventListener("blur", listener);
  document.addEventListener("visibilitychange", listener);
  return () => {
    window.removeEventListener("focus", listener);
    window.removeEventListener("blur", listener);
    document.removeEventListener("visibilitychange", listener);
  };
}

/** Whether this window is in the foreground, re-rendering when that changes. */
export function useWindowForeground(): boolean {
  return useSyncExternalStore(subscribeWindowForeground, isWindowForeground, () => false);
}
