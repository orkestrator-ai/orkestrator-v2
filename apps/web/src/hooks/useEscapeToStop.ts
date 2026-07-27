import { useEffect } from "react";

interface UseEscapeToStopOptions {
  /** Only the visible tab should claim the Escape key. */
  isActive: boolean;
  /** Only bind while there is a turn to interrupt. */
  isLoading: boolean;
  onStop: () => void | Promise<void>;
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
 */
export function useEscapeToStop({
  isActive,
  isLoading,
  onStop,
}: UseEscapeToStopOptions): void {
  useEffect(() => {
    if (!isActive || !isLoading) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape"
        || event.defaultPrevented
        || event.repeat
        || event.metaKey
        || event.ctrlKey
        || event.altKey
        || event.isComposing
      ) {
        return;
      }

      event.preventDefault();
      void onStop();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onStop, isActive, isLoading]);
}
