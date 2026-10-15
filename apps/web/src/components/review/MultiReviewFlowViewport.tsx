import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Maximize, Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMultiReviewFlowViewStore } from "@/stores/multiReviewFlowViewStore";
import type { FlowRect } from "./multi-review-flow";
import {
  DEFAULT_FLOW_VIEW,
  canZoomIn,
  canZoomOut,
  fitFlowView,
  flowContentOffset,
  flowViewportHeight,
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

/**
 * Zoom and pan for the graph's scrolling viewport, kept per workflow.
 *
 * Pan is the viewport's scroll position, so ordinary scrolling pans it and the
 * browser bounds it. Ctrl/⌘ + wheel and pinch zoom around the pointer; a plain
 * wheel is left to scrolling, so the page around the graph still scrolls. A
 * view is restored only at the width it was taken at, and a change of panel
 * width resets it.
 */
export function useFlowViewport({
  viewKey,
  measuredWidth,
  content,
}: {
  viewKey: string;
  measuredWidth: number | null;
  content: FlowSize;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [viewportElement, setViewportElement] = useState<HTMLDivElement | null>(null);
  const viewport: FlowSize = {
    width: measuredWidth ?? content.width,
    height: flowViewportHeight(content.height),
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
  const sizesRef = useRef({ content, viewport, measuredWidth, viewKey });
  useLayoutEffect(() => {
    sizesRef.current = { content, viewport, measuredWidth, viewKey };
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
    const { content: size, viewport: box } = sizesRef.current;
    apply(fitFlowView(size, box));
  }, [apply]);

  /** Bring a node (canvas coordinates) into view before it takes focus. */
  const reveal = useCallback(
    (rect: FlowRect) => {
      const element = viewportRef.current;
      if (!element) return;
      const { content: size, viewport: box } = sizesRef.current;
      const view = currentView();
      const next = revealFlowRect(view, rect, size, box);
      if (next.scrollLeft === view.scrollLeft && next.scrollTop === view.scrollTop) return;
      if (pendingRef.current) pendingRef.current = next;
      else {
        element.scrollLeft = next.scrollLeft;
        element.scrollTop = next.scrollTop;
      }
      save(next);
    },
    [currentView, save],
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
    viewportElement.addEventListener("wheel", onWheel, { passive: false });
    viewportElement.addEventListener("gesturestart", onGestureStart);
    viewportElement.addEventListener("gesturechange", onGestureChange);
    return () => {
      viewportElement.removeEventListener("wheel", onWheel);
      viewportElement.removeEventListener("gesturestart", onGestureStart);
      viewportElement.removeEventListener("gesturechange", onGestureChange);
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

  return {
    zoom,
    viewport,
    offset: flowContentOffset(zoom, content, viewport),
    panning,
    attachViewport,
    viewportHandlers,
    zoomBy,
    resetZoom,
    fit,
    reveal,
  };
}

const CONTROL_CLASS = "size-7 rounded-md";

/** −, the zoom level (which resets to 100%), + and Fit, over the canvas's corner. */
export function FlowZoomControls({
  zoom,
  onZoomOut,
  onZoomIn,
  onReset,
  onFit,
}: {
  zoom: number;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onReset: () => void;
  onFit: () => void;
}) {
  const percent = Math.round(zoom * 100);
  return (
    <div
      role="group"
      aria-label="Zoom"
      data-flow-zoom-controls=""
      className="absolute right-4 bottom-4 flex items-center gap-0.5 rounded-lg border border-border bg-flow-node/95 p-0.5 shadow-[0_8px_24px_rgb(0_0_0/0.45)]"
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
        className="h-7 min-w-12 rounded-md px-1.5 font-mono text-[11px] tabular-nums"
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
        <Maximize className="size-3.5" />
      </Button>
    </div>
  );
}
