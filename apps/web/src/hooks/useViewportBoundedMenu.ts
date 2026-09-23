import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

/** Gap between the anchor (compose input) and the menu. */
const MENU_GAP_PX = 4;
/** Breathing room kept between the menu and the viewport edge. */
const VIEWPORT_EDGE_PADDING_PX = 8;
/** Below this much room above the anchor, prefer opening downwards if roomier. */
const FLIP_THRESHOLD_PX = 160;
/** Never collapse the menu entirely; keep at least a row visible. */
const MIN_MENU_HEIGHT_PX = 48;

export interface VerticalBounds {
  top: number;
  bottom: number;
}

export interface ViewportBoundedPlacement {
  side: "top" | "bottom";
  maxHeight: number;
}

/**
 * Decide where a composer popup should open and how tall it may be so it stays
 * inside the visible viewport. Menus open above the anchor by default and only
 * flip below when the space above is cramped and there is more room below.
 */
export function computeViewportBoundedPlacement(
  anchor: VerticalBounds,
  viewport: VerticalBounds,
  preferredMaxHeight: number,
): ViewportBoundedPlacement {
  const spaceAbove = anchor.top - viewport.top - MENU_GAP_PX - VIEWPORT_EDGE_PADDING_PX;
  const spaceBelow = viewport.bottom - anchor.bottom - MENU_GAP_PX - VIEWPORT_EDGE_PADDING_PX;
  const fitsAbove = spaceAbove >= Math.min(preferredMaxHeight, FLIP_THRESHOLD_PX);
  const side = fitsAbove || spaceAbove >= spaceBelow ? "top" : "bottom";
  const available = side === "top" ? spaceAbove : spaceBelow;

  return {
    side,
    maxHeight: Math.max(MIN_MENU_HEIGHT_PX, Math.min(preferredMaxHeight, Math.floor(available))),
  };
}

/**
 * The visible viewport in layout-viewport coordinates (the same space as
 * `getBoundingClientRect`). On mobile the visual viewport shrinks when the
 * on-screen keyboard opens, which is exactly when composer menus are shown.
 */
function readViewportBounds(): VerticalBounds {
  const visualViewport = window.visualViewport;
  if (visualViewport) {
    return {
      top: visualViewport.offsetTop,
      bottom: visualViewport.offsetTop + visualViewport.height,
    };
  }
  return { top: 0, bottom: window.innerHeight };
}

/**
 * Keeps an absolutely positioned composer menu (anchored to its relative
 * parent) within the visible viewport, so long suggestion lists are scrollable
 * instead of being cut off by the screen edge on small or keyboard-shrunk
 * displays.
 */
export function useViewportBoundedMenu<TElement extends HTMLElement>(preferredMaxHeight: number) {
  const menuRef = useRef<TElement | null>(null);
  const [menuElement, setMenuElement] = useState<TElement | null>(null);
  const [placement, setPlacement] = useState<ViewportBoundedPlacement | null>(null);

  const setMenuRef = useCallback((node: TElement | null) => {
    menuRef.current = node;
    setMenuElement(node);
  }, []);

  useLayoutEffect(() => {
    if (!menuElement) return;
    const anchor = menuElement.offsetParent ?? menuElement.parentElement;
    if (!anchor) return;

    const update = () => {
      const rect = anchor.getBoundingClientRect();
      const next = computeViewportBoundedPlacement(
        { top: rect.top, bottom: rect.bottom },
        readViewportBounds(),
        preferredMaxHeight,
      );
      setPlacement((current) =>
        current && current.side === next.side && current.maxHeight === next.maxHeight
          ? current
          : next,
      );
    };

    update();

    const visualViewport = window.visualViewport;
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, { capture: true, passive: true });
    visualViewport?.addEventListener("resize", update);
    visualViewport?.addEventListener("scroll", update);
    // The composer grows as the user types multi-line prompts, moving the anchor.
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    resizeObserver?.observe(anchor);

    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, { capture: true });
      visualViewport?.removeEventListener("resize", update);
      visualViewport?.removeEventListener("scroll", update);
      resizeObserver?.disconnect();
    };
  }, [menuElement, preferredMaxHeight]);

  const style: CSSProperties =
    placement?.side === "bottom"
      ? {
          top: "100%",
          left: 0,
          marginTop: MENU_GAP_PX,
          maxHeight: placement.maxHeight,
        }
      : {
          bottom: "100%",
          left: 0,
          marginBottom: MENU_GAP_PX,
          maxHeight: placement?.maxHeight ?? preferredMaxHeight,
        };

  return { menuRef, setMenuRef, style, side: placement?.side ?? "top" };
}
