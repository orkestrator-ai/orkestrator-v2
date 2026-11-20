import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { useOverlayPortalLayer } from "./overlay-portal-layer";

/** How long the pointer rests on a trigger before its popover opens. */
export const HOVER_POPOVER_OPEN_DELAY_MS = 250;
/** How long a popover waits after the pointer leaves before it closes. */
export const HOVER_POPOVER_CLOSE_DELAY_MS = 200;
/** The exit animation's length (`hover-popover-out` in `index.css`). */
export const HOVER_POPOVER_EXIT_MS = 120;
/** When a closing panel unmounts if its exit animation never reports its end. */
export const HOVER_POPOVER_EXIT_FALLBACK_MS = HOVER_POPOVER_EXIT_MS + 100;

/** The panel stays this far inside the viewport's edges. */
const VIEWPORT_MARGIN_PX = 8;

export interface HoverPopoverGroup<K extends string> {
  /** The trigger whose popover is open, or null. */
  openKey: K | null;
  /** The pointer entered a trigger or its popover. */
  enter: (key: K) => void;
  /** The pointer left a trigger or its popover. */
  leave: (key: K) => void;
  /** Opens a trigger's popover at once (keyboard). */
  openNow: (key: K) => void;
  /** Closes at once. */
  close: () => void;
  /** Focus left a trigger or its popover: closes unless the pointer still holds it open. */
  blurred: (key: K) => void;
}

/**
 * Hover intent for a set of triggers that share one popover. The first opens
 * after `openDelay`, so a pointer passing across the triggers opens nothing;
 * once one is open, moving to another switches at once, so only one is ever
 * shown. Leaving waits `closeDelay`, which carries the pointer across the gap
 * between a trigger and its popover.
 */
export function useHoverPopoverGroup<K extends string>({
  openDelay = HOVER_POPOVER_OPEN_DELAY_MS,
  closeDelay = HOVER_POPOVER_CLOSE_DELAY_MS,
}: { openDelay?: number; closeDelay?: number } = {}): HoverPopoverGroup<K> {
  const [openKey, setOpenKey] = useState<K | null>(null);
  const openKeyRef = useRef<K | null>(null);
  const hoveredRef = useRef<K | null>(null);
  const focusedRef = useRef<K | null>(null);
  const openTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  const clearTimers = useCallback(() => {
    if (openTimerRef.current !== null) window.clearTimeout(openTimerRef.current);
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    openTimerRef.current = null;
    closeTimerRef.current = null;
  }, []);

  const show = useCallback((key: K | null) => {
    openKeyRef.current = key;
    setOpenKey(key);
  }, []);

  const enter = useCallback(
    (key: K) => {
      hoveredRef.current = key;
      // A keyboard user can still be navigating rows or a nested modal.
      if (focusedRef.current !== null) return;
      clearTimers();
      if (openKeyRef.current !== null) {
        if (openKeyRef.current !== key) show(key);
        return;
      }
      openTimerRef.current = window.setTimeout(() => {
        openTimerRef.current = null;
        show(key);
      }, openDelay);
    },
    [clearTimers, openDelay, show],
  );

  const leave = useCallback(
    (key: K) => {
      if (hoveredRef.current !== key) return;
      hoveredRef.current = null;
      clearTimers();
      if (openKeyRef.current === null || focusedRef.current === openKeyRef.current) return;
      closeTimerRef.current = window.setTimeout(() => {
        closeTimerRef.current = null;
        show(null);
      }, closeDelay);
    },
    [clearTimers, closeDelay, show],
  );

  const openNow = useCallback(
    (key: K) => {
      clearTimers();
      focusedRef.current = key;
      show(key);
    },
    [clearTimers, show],
  );

  const close = useCallback(() => {
    clearTimers();
    focusedRef.current = null;
    show(null);
  }, [clearTimers, show]);

  const blurred = useCallback(
    (key: K) => {
      if (focusedRef.current === key) focusedRef.current = null;
      if (openKeyRef.current === key && hoveredRef.current !== key) close();
    },
    [close],
  );

  useEffect(() => clearTimers, [clearTimers]);

  return { openKey, enter, leave, openNow, close, blurred };
}

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * A floating panel beside `anchor`, portaled to the body. It slides out when
 * `open` turns on and back in when it turns off, staying mounted for the exit
 * animation; under reduced motion it simply appears and disappears. A
 * transparent strip `sideOffset` wide joins it to the anchor, so the pointer
 * crossing the gap never leaves it. The panel is kept inside the viewport and
 * follows the anchor through scrolling and resizing.
 */
export function HoverPopoverPanel({
  getAnchor,
  anchorKey,
  open,
  sideOffset = 8,
  className,
  children,
  onPointerEnter,
  onPointerLeave,
  panelRef,
  ...panelProps
}: {
  /** The element the panel sits beside, read when it is placed. */
  getAnchor: () => HTMLElement | null;
  /** Changes when the panel moves to another anchor. */
  anchorKey?: string | null;
  open: boolean;
  sideOffset?: number;
  className?: string;
  children: ReactNode;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
  /** The visible panel (not the strip that joins it to the anchor). */
  panelRef?: Ref<HTMLDivElement>;
} & Omit<HTMLAttributes<HTMLDivElement>, "onPointerEnter" | "onPointerLeave" | "children">) {
  const [present, setPresent] = useState(open);
  if (open && !present) setPresent(true);
  // Reduced motion has no exit animation to wait for.
  if (!open && present && prefersReducedMotion()) setPresent(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const portalLayerClassName = useOverlayPortalLayer();

  // A fallback for an exit animation that never reports its end.
  useEffect(() => {
    if (open || !present) return;
    const timer = window.setTimeout(() => setPresent(false), HOVER_POPOVER_EXIT_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [open, present]);

  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    if (!present || !wrapper) return;
    const place = () => {
      const anchor = getAnchor();
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const rootZoom = getComputedStyle(document.documentElement).zoom ?? "";
      const zoom = Number.parseFloat(rootZoom) / (rootZoom.endsWith("%") ? 100 : 1) || 1;
      const left = rect.right / zoom;
      const viewportHeight = window.innerHeight / zoom;
      wrapper.style.setProperty(
        "--hover-popover-available-height",
        `${Math.max(0, viewportHeight - VIEWPORT_MARGIN_PX * 2)}px`,
      );
      wrapper.style.setProperty(
        "--hover-popover-available-width",
        `${Math.max(0, window.innerWidth / zoom - left - sideOffset - VIEWPORT_MARGIN_PX)}px`,
      );
      const height = wrapper.offsetHeight;
      const bottomLimit = viewportHeight - VIEWPORT_MARGIN_PX - height;
      const top = Math.max(VIEWPORT_MARGIN_PX, Math.min(rect.top / zoom - 4, bottomLimit));
      wrapper.style.left = `${left}px`;
      wrapper.style.top = `${top}px`;
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(place) : null;
    observer?.observe(wrapper);
    observer?.observe(document.documentElement);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      observer?.disconnect();
    };
  }, [anchorKey, getAnchor, present, sideOffset]);

  if (!present) return null;

  return createPortal(
    <div
      ref={wrapperRef}
      data-slot="hover-popover"
      inert={!open}
      aria-hidden={!open || undefined}
      className={cn(
        "fixed top-0 left-0 z-50",
        // A closing panel takes no pointer: it is already on its way out.
        !open && "pointer-events-none",
        portalLayerClassName,
      )}
      style={{ paddingLeft: sideOffset }}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <div
        {...panelProps}
        ref={panelRef}
        data-state={open ? "open" : "closed"}
        className={cn(
          "hover-popover rounded-xl border border-zinc-700/70 bg-zinc-900/95 text-popover-foreground shadow-[0_18px_48px_rgba(0,0,0,0.42)] backdrop-blur-sm",
          className,
        )}
        onAnimationEnd={(event) => {
          if (event.target === event.currentTarget && !open) setPresent(false);
        }}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
