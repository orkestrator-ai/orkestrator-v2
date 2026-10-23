import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Maximize, Minimize, Minus, Plus, Scan } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useMultiReviewFlowViewStore } from "@/stores/multiReviewFlowViewStore";
import type { FlowRect } from "./multi-review-flow";
import {
  DEFAULT_FLOW_VIEW,
  FLOW_ZOOM_MAX,
  canZoomIn,
  canZoomOut,
  centerFlowRect,
  fitFlowView,
  fitStackedFlowZoom,
  flowContentOffset,
  flowViewportHeight,
  pinchFlowZoom,
  revealFlowRect,
  steppedFlowZoom,
  wheelZoomFactor,
  zoomFlowView,
  type FlowSize,
  type FlowView,
} from "./multi-review-flow-viewport";

/** Drag-to-pan starts only on the canvas itself, never on a node or a control. */
const NO_PAN_SELECTOR = '[role="tab"], [data-flow-zoom-controls]';

/** Safari reports a trackpad pinch as gesture events rather than ctrl+wheel. */
interface GestureEvent extends UIEvent {
  scale: number;
  clientX: number;
  clientY: number;
}

function touchDistance(touches: TouchList): number {
  const [first, second] = [touches[0], touches[1]];
  if (!first || !second) return 0;
  return Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
}

function touchMidpoint(touches: TouchList): { clientX: number; clientY: number } {
  const [first, second] = [touches[0]!, touches[1]!];
  return {
    clientX: (first.clientX + second.clientX) / 2,
    clientY: (first.clientY + second.clientY) / 2,
  };
}

/**
 * Zoom and pan for the graph's scrolling viewport, kept per workflow.
 *
 * Pan is the viewport's scroll position, so ordinary scrolling pans it and the
 * browser bounds it. Ctrl/⌘ + wheel, a trackpad pinch and a two-finger touch
 * pinch zoom around the pointer; a plain wheel is left to scrolling, so the
 * page around the graph still scrolls. A view is restored only at the width it
 * was taken at, and a change of panel width resets it.
 *
 * The wide graph scrolls both ways inside a viewport of bounded height. The
 * stacked column scrolls only sideways: its viewport grows with the scaled
 * column, so vertical scrolling stays with the page, and Fit fits the column
 * to the height `fitHeight` reports the page shows it in.
 *
 * In fullscreen the wide graph's viewport is `fillHeight` tall, the height it
 * is given, instead of its own.
 */
export function useFlowViewport({
  viewKey,
  measuredWidth,
  content,
  layout = "graph",
  fitHeight,
  fillHeight = null,
}: {
  viewKey: string;
  measuredWidth: number | null;
  content: FlowSize;
  layout?: "graph" | "stacked";
  fitHeight?: () => number | null;
  fillHeight?: number | null;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [viewportElement, setViewportElement] = useState<HTMLDivElement | null>(null);
  const stacked = layout === "stacked";
  const viewport: FlowSize = {
    width: measuredWidth ?? content.width,
    // The stacked viewport is as tall as the column at any zoom, so nothing
    // scrolls inside it vertically.
    height: stacked
      ? Math.max(1, content.height) * FLOW_ZOOM_MAX
      : (fillHeight ?? flowViewportHeight(content.height)),
  };
  // The remembered zoom applies only at the width it was taken at.
  const zoom =
    useMultiReviewFlowViewStore((state) => {
      const remembered = state.views.get(viewKey);
      return remembered && remembered.width === measuredWidth ? remembered.zoom : null;
    }) ?? DEFAULT_FLOW_VIEW.zoom;
  const zoomRef = useRef(zoom);
  /** A scroll position waiting for the render at its zoom. */
  const pendingRef = useRef<FlowView | null>(null);
  const sizesRef = useRef({ content, viewport, measuredWidth, viewKey, stacked, fitHeight });
  useLayoutEffect(() => {
    sizesRef.current = { content, viewport, measuredWidth, viewKey, stacked, fitHeight };
  });

  const attachViewport = useCallback((element: HTMLDivElement | null) => {
    viewportRef.current = element;
    setViewportElement(element);
  }, []);

  const save = useCallback((view: FlowView) => {
    const { viewKey: key, measuredWidth: width } = sizesRef.current;
    useMultiReviewFlowViewStore.getState().saveView(key, { ...view, width });
  }, []);

  const currentView = useCallback((): FlowView => {
    if (pendingRef.current) return pendingRef.current;
    const element = viewportRef.current;
    return {
      zoom: zoomRef.current,
      scrollLeft: element?.scrollLeft ?? 0,
      scrollTop: element?.scrollTop ?? 0,
    };
  }, []);

  const apply = useCallback(
    (view: FlowView) => {
      const element = viewportRef.current;
      if (view.zoom === zoomRef.current && !pendingRef.current && element) {
        // Same zoom, same canvas size: the scroll can land now.
        element.scrollLeft = view.scrollLeft;
        element.scrollTop = view.scrollTop;
      } else {
        pendingRef.current = view;
      }
      zoomRef.current = view.zoom;
      save(view);
    },
    [save],
  );

  // The canvas has its new size once the render at the new zoom commits, so
  // the scroll that goes with it can land without the browser clamping it.
  useLayoutEffect(() => {
    zoomRef.current = zoom;
    const pending = pendingRef.current;
    const element = viewportRef.current;
    if (!pending || !element || pending.zoom !== zoom) return;
    pendingRef.current = null;
    element.scrollLeft = pending.scrollLeft;
    element.scrollTop = pending.scrollTop;
  });

  // Restore the remembered scroll on the first measurement, and forget the
  // view when the panel width changes: the layout, and so every position,
  // depends on it.
  const lastWidthRef = useRef<{ key: string; width: number | null } | null>(null);
  useLayoutEffect(() => {
    const last = lastWidthRef.current;
    lastWidthRef.current = { key: viewKey, width: measuredWidth };
    const element = viewportRef.current;
    const store = useMultiReviewFlowViewStore.getState();
    const remembered = store.views.get(viewKey);
    const resized =
      last !== null &&
      last.key === viewKey &&
      last.width !== null &&
      measuredWidth !== null &&
      last.width !== measuredWidth;
    if (resized) {
      pendingRef.current = null;
      if (remembered) store.clearView(viewKey);
      if (element) {
        element.scrollLeft = 0;
        element.scrollTop = 0;
      }
      return;
    }
    if (last && last.key === viewKey && last.width === measuredWidth) return;
    if (!remembered) return;
    if (remembered.width !== measuredWidth) {
      // Until the first measurement there is nothing to compare against.
      if (measuredWidth !== null) store.clearView(viewKey);
      return;
    }
    if (element) {
      element.scrollLeft = remembered.scrollLeft;
      element.scrollTop = remembered.scrollTop;
    }
  }, [measuredWidth, viewKey]);

  const zoomTo = useCallback(
    (next: number, anchor?: { x: number; y: number }) => {
      const { content: size, viewport: box } = sizesRef.current;
      apply(zoomFlowView(currentView(), next, size, box, anchor));
    },
    [apply, currentView],
  );

  const zoomBy = useCallback(
    (direction: 1 | -1) => zoomTo(steppedFlowZoom(zoomRef.current, direction)),
    [zoomTo],
  );

  const resetZoom = useCallback(() => zoomTo(DEFAULT_FLOW_VIEW.zoom), [zoomTo]);

  const fit = useCallback(() => {
    const {
      content: size,
      viewport: box,
      stacked: column,
      fitHeight: available,
    } = sizesRef.current;
    apply(
      column
        ? {
            zoom: fitStackedFlowZoom(size.height, available?.() ?? null),
            scrollLeft: 0,
            scrollTop: 0,
          }
        : fitFlowView(size, box),
    );
  }, [apply]);

  const scrollTo = useCallback(
    (next: FlowView, smooth: boolean) => {
      const element = viewportRef.current;
      if (!element) return;
      const view = currentView();
      if (next.scrollLeft === view.scrollLeft && next.scrollTop === view.scrollTop) return;
      if (pendingRef.current) pendingRef.current = next;
      else if (smooth && typeof element.scrollTo === "function" && !prefersReducedMotion()) {
        element.scrollTo({ left: next.scrollLeft, top: next.scrollTop, behavior: "smooth" });
      } else {
        element.scrollLeft = next.scrollLeft;
        element.scrollTop = next.scrollTop;
      }
      save(next);
    },
    [currentView, save],
  );

  /** Bring a node (canvas coordinates) into view before it takes focus. */
  const reveal = useCallback(
    (rect: FlowRect) => {
      const { content: size, viewport: box } = sizesRef.current;
      scrollTo(revealFlowRect(currentView(), rect, size, box), false);
    },
    [currentView, scrollTo],
  );

  /**
   * Centre a node (canvas coordinates) across the viewport, within the scroll
   * range. `smooth` glides there, unless the user prefers reduced motion.
   */
  const center = useCallback(
    (rect: FlowRect, { smooth = false }: { smooth?: boolean } = {}) => {
      const { content: size, viewport: box } = sizesRef.current;
      scrollTo(centerFlowRect(currentView(), rect, size, box), smooth);
    },
    [currentView, scrollTo],
  );

  const zoomToRef = useRef(zoomTo);
  useLayoutEffect(() => {
    zoomToRef.current = zoomTo;
  });
  // React registers wheel listeners as passive, and a passive listener cannot
  // keep Ctrl + wheel from zooming the whole window.
  useEffect(() => {
    if (!viewportElement) return;
    const anchorOf = (event: { clientX: number; clientY: number }) => {
      const bounds = viewportElement.getBoundingClientRect();
      return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    };
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoomToRef.current(
        zoomRef.current * wheelZoomFactor(event.deltaY, event.deltaMode),
        anchorOf(event),
      );
    };
    let gestureStartZoom = zoomRef.current;
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      gestureStartZoom = zoomRef.current;
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      const gesture = event as GestureEvent;
      zoomToRef.current(gestureStartZoom * gesture.scale, anchorOf(gesture));
    };
    // A two-finger touch pinch. The viewport's `touch-action: pan-x pan-y`
    // keeps the browser from zooming the whole page instead; one finger still
    // scrolls natively.
    let pinch: { distance: number; zoom: number } | null = null;
    const onTouchStart = (event: TouchEvent) => {
      pinch =
        event.touches.length === 2
          ? { distance: touchDistance(event.touches), zoom: zoomRef.current }
          : null;
    };
    const onTouchMove = (event: TouchEvent) => {
      if (!pinch || event.touches.length !== 2) return;
      event.preventDefault();
      zoomToRef.current(
        pinchFlowZoom(pinch.zoom, pinch.distance, touchDistance(event.touches)),
        anchorOf(touchMidpoint(event.touches)),
      );
    };
    const onTouchEnd = (event: TouchEvent) => {
      if (event.touches.length < 2) pinch = null;
    };
    viewportElement.addEventListener("wheel", onWheel, { passive: false });
    viewportElement.addEventListener("gesturestart", onGestureStart);
    viewportElement.addEventListener("gesturechange", onGestureChange);
    viewportElement.addEventListener("touchstart", onTouchStart, { passive: true });
    viewportElement.addEventListener("touchmove", onTouchMove, { passive: false });
    viewportElement.addEventListener("touchend", onTouchEnd);
    viewportElement.addEventListener("touchcancel", onTouchEnd);
    return () => {
      viewportElement.removeEventListener("wheel", onWheel);
      viewportElement.removeEventListener("gesturestart", onGestureStart);
      viewportElement.removeEventListener("gesturechange", onGestureChange);
      viewportElement.removeEventListener("touchstart", onTouchStart);
      viewportElement.removeEventListener("touchmove", onTouchMove);
      viewportElement.removeEventListener("touchend", onTouchEnd);
      viewportElement.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [viewportElement]);

  const dragRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    scrollLeft: number;
    scrollTop: number;
  } | null>(null);
  const [panning, setPanning] = useState(false);

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setPanning(false);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const viewportHandlers = {
    onScroll: (event: { currentTarget: HTMLDivElement }) => {
      if (pendingRef.current) return;
      save({
        zoom: zoomRef.current,
        scrollLeft: event.currentTarget.scrollLeft,
        scrollTop: event.currentTarget.scrollTop,
      });
    },
    // Touch already pans by scrolling; the drag is for mouse and pen.
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || event.pointerType === "touch") return;
      // React bubbles events out of portals: a press in a node's context menu
      // reaches here, and capturing it would swallow the item's selection.
      if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
      if (event.target instanceof Element && event.target.closest(NO_PAN_SELECTOR)) return;
      dragRef.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        scrollLeft: event.currentTarget.scrollLeft,
        scrollTop: event.currentTarget.scrollTop,
      };
      event.currentTarget.setPointerCapture?.(event.pointerId);
      setPanning(true);
    },
    onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (drag?.pointerId !== event.pointerId) return;
      event.currentTarget.scrollLeft = drag.scrollLeft - (event.clientX - drag.x);
      event.currentTarget.scrollTop = drag.scrollTop - (event.clientY - drag.y);
    },
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
  };

  const offset = flowContentOffset(zoom, content, viewport);
  return {
    zoom,
    viewport,
    offset: stacked ? { x: offset.x, y: 0 } : offset,
    panning,
    attachViewport,
    viewportHandlers,
    zoomBy,
    resetZoom,
    fit,
    reveal,
    center,
  };
}

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * −, the zoom level (which resets to 100%), +, Fit and Fullscreen. Over the wide graph's
 * bottom-right corner; at the top of the stacked column, where they stay in
 * reach while it scrolls. Touch targets are 44 px wherever the pointer is
 * coarse, and always in the stacked layout, which is the phone layout.
 */
export function FlowZoomControls({
  zoom,
  onZoomOut,
  onZoomIn,
  onReset,
  onFit,
  fullscreen,
  onToggleFullscreen,
  placement = "corner",
}: {
  zoom: number;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onReset: () => void;
  onFit: () => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  placement?: "corner" | "inline";
}) {
  const percent = Math.round(zoom * 100);
  const touch = placement === "inline";
  const CONTROL_CLASS = cn("rounded-md", touch ? "size-11" : "size-7 pointer-coarse:size-11");
  return (
    <div
      role="group"
      aria-label="Zoom"
      data-flow-zoom-controls=""
      className={cn(
        "flex items-center gap-0.5 rounded-lg border border-border bg-flow-node/95 p-0.5 shadow-[0_8px_24px_rgb(0_0_0/0.45)]",
        placement === "corner" && "absolute right-4 bottom-4",
      )}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={CONTROL_CLASS}
        aria-label="Zoom out"
        title="Zoom out"
        disabled={!canZoomOut(zoom)}
        onClick={onZoomOut}
      >
        <Minus className="size-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        className={cn(
          "min-w-12 rounded-md px-1.5 font-mono text-[11px] tabular-nums",
          touch ? "h-11 min-w-14" : "h-7 pointer-coarse:h-11",
        )}
        aria-label={`Zoom ${percent}%, reset to 100%`}
        title="Reset to 100%"
        data-testid="multi-review-zoom-level"
        onClick={onReset}
      >
        {percent}%
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={CONTROL_CLASS}
        aria-label="Zoom in"
        title="Zoom in"
        disabled={!canZoomIn(zoom)}
        onClick={onZoomIn}
      >
        <Plus className="size-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={CONTROL_CLASS}
        aria-label="Fit the whole pipeline"
        title="Fit"
        onClick={onFit}
      >
        <Scan className="size-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={CONTROL_CLASS}
        aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
        aria-pressed={fullscreen}
        title={fullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"}
        data-testid="multi-review-fullscreen"
        onClick={onToggleFullscreen}
      >
        {fullscreen ? <Minimize className="size-3.5" /> : <Maximize className="size-3.5" />}
      </Button>
    </div>
  );
}
