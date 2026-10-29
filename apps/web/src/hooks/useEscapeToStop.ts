import { type RefObject, useEffect } from "react";
import { isAgentShortcutInScope } from "./agent-shortcut-scope";

interface UseEscapeToStopOptions {
  /** Only the visible tab should claim the Escape key. */
  isActive: boolean;
  /** Only bind while there is a turn to interrupt. */
  isLoading: boolean;
  onStop: () => void | Promise<void>;
  /**
   * The tab's composer. Escape stops the turn inside its pane or agent scope,
   * or when nothing has focus and no modal surface is open.
   */
  scopeRef: RefObject<HTMLElement | null>;
}

/**
 * Bind Escape to "stop the current turn" for the active chat tab.
 *
 * The guards matter and were identical in all three tabs before this was
 * extracted:
 * - `defaultPrevented` — a dialog or menu already consumed the key.
 * - `repeat` — holding Escape should not fire a second interrupt.
 * - modifier keys — Cmd/Ctrl/Alt+Escape belong to the OS or other bindings.
 * - `isComposing` — Escape cancels an IME composition, it is not a stop.
 * - scope — the listener is window-wide and usually registers before the
 *   surfaces it could collide with (fullscreen settings, the sidebar search,
 *   file previews), so it runs first and cannot rely on them preventing the
 *   key. An Escape aimed at anything outside the tab's pane is not a stop.
 */
export function useEscapeToStop({
  isActive,
  isLoading,
  onStop,
  scopeRef,
}: UseEscapeToStopOptions): void {
  useEffect(() => {
    if (!isActive || !isLoading) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        event.repeat ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.isComposing
      ) {
        return;
      }

      if (!isAgentShortcutInScope(event.target, scopeRef.current)) return;

      event.preventDefault();
      void onStop();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onStop, isActive, isLoading, scopeRef]);
}
