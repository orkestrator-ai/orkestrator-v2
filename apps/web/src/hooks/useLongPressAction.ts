import { useCallback, useEffect, useMemo, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

const LONG_PRESS_MS = 550;
/**
 * Mobile browsers synthesize a click once the pointer gesture completes, so a
 * long press that opened a dialog would also fire the button's ordinary action.
 * The suppression window is generous because that synthesized click can arrive
 * well after the pointer is lifted.
 */
const CLICK_SUPPRESSION_MS = 1_000;
/** Past this the gesture is a scroll, not a press. */
const MOVE_TOLERANCE_PX = 10;

export interface LongPressAction {
  /**
   * Whether the click currently being handled is the tail of a completed long
   * press. Consumes the suppression, so it must be called at most once per
   * click.
   */
  shouldSuppressClick: () => boolean;
  /** Drops a press in progress without firing it. */
  cancel: () => void;
  handlers: {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: () => void;
    onPointerCancel: () => void;
    onPointerLeave: () => void;
  };
}

/**
 * A touch long press that stands in for a right-click on a toolbar button.
 *
 * Mouse pointers are ignored: they have a real context menu. The action is read
 * from a ref so a caller can pass an inline callback without the handlers
 * changing identity on every render, and timers are cleared on unmount so a
 * pending press cannot fire into an unmounted tree.
 */
export function useLongPressAction(onLongPress: () => void, enabled = true): LongPressAction {
  const pressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const originRef = useRef<{ x: number; y: number } | null>(null);
  const suppressClickRef = useRef(false);
  const onLongPressRef = useRef(onLongPress);
  onLongPressRef.current = onLongPress;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const cancel = useCallback(() => {
    if (pressTimerRef.current) {
      clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
    originRef.current = null;
  }, []);

  useEffect(
    () => () => {
      if (pressTimerRef.current) clearTimeout(pressTimerRef.current);
      if (suppressionTimerRef.current) clearTimeout(suppressionTimerRef.current);
    },
    [],
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.pointerType === "mouse" || !enabledRef.current) return;
      cancel();
      originRef.current = { x: event.clientX, y: event.clientY };
      pressTimerRef.current = setTimeout(() => {
        pressTimerRef.current = null;
        originRef.current = null;
        suppressClickRef.current = true;
        suppressionTimerRef.current = setTimeout(() => {
          suppressClickRef.current = false;
          suppressionTimerRef.current = null;
        }, CLICK_SUPPRESSION_MS);
        onLongPressRef.current();
      }, LONG_PRESS_MS);
    },
    [cancel],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const origin = originRef.current;
      if (!origin) return;
      if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > MOVE_TOLERANCE_PX) {
        cancel();
      }
    },
    [cancel],
  );

  const shouldSuppressClick = useCallback(() => {
    if (!suppressClickRef.current) return false;
    suppressClickRef.current = false;
    if (suppressionTimerRef.current) {
      clearTimeout(suppressionTimerRef.current);
      suppressionTimerRef.current = null;
    }
    return true;
  }, []);

  return useMemo(
    () => ({
      shouldSuppressClick,
      cancel,
      handlers: {
        onPointerDown,
        onPointerMove,
        onPointerUp: cancel,
        onPointerCancel: cancel,
        onPointerLeave: cancel,
      },
    }),
    [cancel, onPointerDown, onPointerMove, shouldSuppressClick],
  );
}
