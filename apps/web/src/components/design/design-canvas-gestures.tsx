/**
 * Canvas-level pointer gestures: frame moves and resizes that snap to the grid
 * and to other frames (with red guides), group moves of a board selection, and
 * the Shift-drag selection box. Geometry lives in `design-snapping.ts`; this
 * module owns the gesture state and draws the overlays.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type PointerEvent,
  type SetStateAction,
} from "react";
import type { DesignFrame } from "@orkestrator/protocol/design-canvas";
import type { DesignCanvasActions, GeometryPatch } from "./design-canvas-context";
import {
  MARQUEE_START_PX,
  SNAP_THRESHOLD_PX,
  alignmentGuides,
  framesInMarquee,
  gridStep,
  rectFromPoints,
  snapMove,
  snapResize,
  unionRect,
  type SnapGuide,
} from "./design-snapping";
import {
  clampCoordinate,
  clampDimension,
  toCanvas,
  type DesignViewport,
  type Rect,
} from "./design-viewport";

/** A frame move or resize in progress, as the canvas draws it. */
export interface FrameGestureView {
  /** Other frames of a group move, carried by `offset`. */
  members: readonly string[];
  offset: { dx: number; dy: number };
  guides: readonly SnapGuide[];
}

interface FrameGestureState {
  frameId: string;
  mode: "move" | "resize";
  /** Geometry of every moving frame when the gesture began. */
  origins: Map<string, DesignFrame>;
  /** Frames that stay put: the snapping targets. */
  others: DesignFrame[];
  members: string[];
  offset: { dx: number; dy: number };
  guides: SnapGuide[];
}

/** A Shift-press on the canvas that becomes a selection box once it moves. */
interface MarqueeGesture {
  pointerId: number;
  startX: number;
  startY: number;
  /** Board selection before the box: the box adds to it. */
  base: readonly string[];
  active: boolean;
}

const NO_OFFSET = { dx: 0, dy: 0 };
/** The smallest frame side `clampDimension` allows. */
const MIN_FRAME_SIZE = 32;
// The theme's token is `--color-muted-foreground` (Tailwind v4); `--muted-foreground`
// is not defined, which is why the canvas dots never showed before.
const GRID_LINE_COLOR = "color-mix(in srgb, var(--color-muted-foreground) 20%, transparent)";
const GRID_DOT_COLOR = "color-mix(in srgb, var(--color-muted-foreground) 55%, transparent)";

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

export interface DesignCanvasGestureDeps {
  /** Frames as drawn (optimistic previews applied): gesture origins and targets. */
  frames: readonly DesignFrame[];
  /** Committed frames: the base each submitted move is checked against. */
  committedFrames: () => readonly DesignFrame[];
  selectedFrames: () => readonly string[];
  viewport: () => DesignViewport;
  submitGeometry: DesignCanvasActions["submitGeometry"];
  setPinned: Dispatch<SetStateAction<ReadonlySet<string>>>;
  /** Replaces the board selection. */
  selectFrames: (ids: readonly string[]) => void;
  /** A selection box was released with this board selection. */
  onMarqueeSelected: (ids: readonly string[]) => void;
}

export function useDesignCanvasGestures(deps: DesignCanvasGestureDeps) {
  // Handlers stay stable for the memoised frames; they read the latest inputs here.
  const depsRef = useRef(deps);
  useLayoutEffect(() => {
    depsRef.current = deps;
  });
  const gestureRef = useRef<FrameGestureState | null>(null);
  const raf = useRef(0);
  const [frameGesture, setFrameGesture] = useState<FrameGestureView | null>(null);
  const marqueeRef = useRef<MarqueeGesture | null>(null);
  /** The selection box in viewport pixels while a marquee is dragged. */
  const [marquee, setMarquee] = useState<Rect | null>(null);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  const frameActions = useMemo<
    Pick<DesignCanvasActions, "beginFrameGesture" | "updateFrameGesture" | "endFrameGesture">
  >(
    () => ({
      beginFrameGesture: (frameId, mode) => {
        const { frames, selectedFrames, setPinned } = depsRef.current;
        const chosen = selectedFrames();
        // A move of one of several selected frames carries the whole selection.
        const ids =
          mode === "move" && chosen.length > 1 && chosen.includes(frameId) ? chosen : [frameId];
        const origins = new Map(
          frames.filter((frame) => ids.includes(frame.id)).map((frame) => [frame.id, frame]),
        );
        if (!origins.has(frameId)) return;
        const members = Array.from(origins.keys()).filter((id) => id !== frameId);
        gestureRef.current = {
          frameId,
          mode,
          origins,
          others: frames.filter((frame) => !origins.has(frame.id)),
          members,
          offset: NO_OFFSET,
          guides: [],
        };
        // Moving frames stay mounted even when they start offscreen.
        if (members.length) setPinned((current) => new Set([...Array.from(current), ...members]));
        setFrameGesture({ members, offset: NO_OFFSET, guides: [] });
      },
      updateFrameGesture: (frameId, delta, options) => {
        const gesture = gestureRef.current;
        if (!gesture || gesture.frameId !== frameId) return {};
        const primary = gesture.origins.get(frameId)!;
        const threshold = SNAP_THRESHOLD_PX / depsRef.current.viewport().zoom;
        const free = options?.free ?? false;
        let patch: GeometryPatch;
        let placed: Rect;
        if (gesture.mode === "move") {
          // A group snaps by its bounds, so its outer edges meet the guides.
          const bounds = unionRect(Array.from(gesture.origins.values()))!;
          const proposed = { ...bounds, x: bounds.x + delta.dx, y: bounds.y + delta.dy };
          const snapped = free ? proposed : snapMove(proposed, gesture.others, { threshold }).rect;
          const x = clampCoordinate(primary.x + snapped.x - bounds.x);
          const y = clampCoordinate(primary.y + snapped.y - bounds.y);
          gesture.offset = { dx: x - primary.x, dy: y - primary.y };
          patch = { x, y };
          placed = { ...bounds, x: bounds.x + gesture.offset.dx, y: bounds.y + gesture.offset.dy };
        } else {
          const proposed = {
            x: primary.x,
            y: primary.y,
            width: primary.width + delta.dx,
            height: primary.height + delta.dy,
          };
          const snapped = free
            ? proposed
            : snapResize(proposed, gesture.others, { threshold, minSize: MIN_FRAME_SIZE }).rect;
          const width = clampDimension(snapped.width);
          const height = clampDimension(snapped.height);
          patch = { width, height };
          placed = { x: primary.x, y: primary.y, width, height };
        }
        gesture.guides = free ? [] : alignmentGuides(placed, gesture.others);
        if (!raf.current)
          raf.current = requestAnimationFrame(() => {
            raf.current = 0;
            const latest = gestureRef.current;
            if (latest)
              setFrameGesture({
                members: latest.members,
                offset: latest.offset,
                guides: latest.guides,
              });
          });
        return patch;
      },
      endFrameGesture: (frameId, commit, gestureId) => {
        const gesture = gestureRef.current;
        if (!gesture || gesture.frameId !== frameId) return;
        gestureRef.current = null;
        cancelAnimationFrame(raf.current);
        raf.current = 0;
        const { offset, members } = gesture;
        const { committedFrames, submitGeometry, setPinned } = depsRef.current;
        if (commit && gesture.mode === "move" && (offset.dx !== 0 || offset.dy !== 0)) {
          // The dragged frame submits its own patch; the rest follow with the same offset.
          const committed = committedFrames();
          for (const id of members) {
            const origin = gesture.origins.get(id)!;
            const base = committed.find((frame) => frame.id === id);
            if (!base) continue;
            submitGeometry(
              base,
              {
                x: clampCoordinate(origin.x + offset.dx),
                y: clampCoordinate(origin.y + offset.dy),
              },
              gestureId,
              `Move ${origin.name}`,
            );
          }
        }
        if (members.length)
          setPinned((current) => {
            const next = new Set(current);
            for (const id of members) next.delete(id);
            return next;
          });
        setFrameGesture(null);
      },
    }),
    [],
  );

  /** Grows the selection box to the pointer and selects every frame it touches. */
  const updateMarquee = useCallback((surface: HTMLElement, clientX: number, clientY: number) => {
    const gesture = marqueeRef.current;
    if (!gesture) return;
    const { frames, viewport, selectedFrames, selectFrames } = depsRef.current;
    const bounds = surface.getBoundingClientRect();
    const box = rectFromPoints(
      { x: gesture.startX - bounds.left, y: gesture.startY - bounds.top },
      { x: clientX - bounds.left, y: clientY - bounds.top },
    );
    setMarquee(box);
    const view = viewport();
    const hits = framesInMarquee(
      rectFromPoints(
        toCanvas(view, { x: box.x, y: box.y }),
        toCanvas(view, { x: box.x + box.width, y: box.y + box.height }),
      ),
      frames,
    );
    const next = [...gesture.base, ...hits.filter((id) => !gesture.base.includes(id))];
    if (!sameIds(next, selectedFrames())) selectFrames(next);
  }, []);

  const finishMarquee = useCallback(() => {
    const gesture = marqueeRef.current;
    marqueeRef.current = null;
    if (!gesture?.active) return;
    setMarquee(null);
    depsRef.current.onMarqueeSelected(depsRef.current.selectedFrames());
  }, []);

  const cancelMarquee = useCallback(() => {
    const gesture = marqueeRef.current;
    marqueeRef.current = null;
    setMarquee(null);
    if (gesture?.active) depsRef.current.selectFrames(gesture.base);
  }, []);

  const marqueeHandlers = useMemo(
    () => ({
      /**
       * Shift-press on the background or a frame's body (`data-marquee-surface`).
       * It becomes a box only once it moves, so a Shift-click on a frame still
       * inspects its element. Returns true when the press was taken.
       */
      pointerDown(event: PointerEvent<HTMLElement>): boolean {
        const onSurface =
          event.target === event.currentTarget ||
          (event.target instanceof Element &&
            event.target.closest("[data-marquee-surface]") !== null);
        if (event.button !== 0 || !event.shiftKey || !onSurface) return false;
        marqueeRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          base: depsRef.current.selectedFrames(),
          active: false,
        };
        if (event.target === event.currentTarget) {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
        }
        return true;
      },
      /** Returns true while the pointer belongs to a (possible) selection box. */
      pointerMove(event: PointerEvent<HTMLElement>): boolean {
        const gesture = marqueeRef.current;
        if (!gesture || gesture.pointerId !== event.pointerId) return false;
        if (!gesture.active) {
          const travel = Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY);
          if (travel < MARQUEE_START_PX) return true;
          gesture.active = true;
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch {
            // The pointer is gone; pointerup or cancel ends the box.
          }
        }
        updateMarquee(event.currentTarget, event.clientX, event.clientY);
        return true;
      },
      pointerUp: finishMarquee,
      pointerCancel: cancelMarquee,
      lostPointerCapture() {
        if (marqueeRef.current?.active) finishMarquee();
      },
      /** Escape: drops a box in progress and restores the selection. */
      escape(): boolean {
        if (!marqueeRef.current?.active) return false;
        cancelMarquee();
        return true;
      },
    }),
    [cancelMarquee, finishMarquee, updateMarquee],
  );

  return { frameGesture, frameActions, marquee, marqueeHandlers };
}

/** The viewport background: dots on canvas grid points that scale and pan with the frames. */
export function gridBackground(viewport: DesignViewport) {
  const cell = gridStep(viewport.zoom) * viewport.zoom;
  return {
    backgroundImage: `radial-gradient(${GRID_DOT_COLOR} 0.8px, transparent 0.8px)`,
    backgroundSize: `${cell}px ${cell}px`,
    // A radial gradient centres in its cell; shift by half a cell onto the grid points.
    backgroundPosition: `${viewport.panX - cell / 2}px ${viewport.panY - cell / 2}px`,
  };
}

/** Grid lines shown while a frame is moved or resized: what it snaps to. */
export function DesignSnapGrid({ viewport }: { viewport: DesignViewport }) {
  const cell = gridStep(viewport.zoom) * viewport.zoom;
  return (
    <div
      data-testid="design-snap-grid"
      aria-hidden
      className="pointer-events-none absolute inset-0"
      style={{
        backgroundImage: `linear-gradient(to right, ${GRID_LINE_COLOR} 1px, transparent 1px), linear-gradient(to bottom, ${GRID_LINE_COLOR} 1px, transparent 1px)`,
        backgroundSize: `${cell}px ${cell}px`,
        backgroundPosition: `${viewport.panX}px ${viewport.panY}px`,
      }}
    />
  );
}

/** Red alignment guides in canvas coordinates; 1.5 screen pixels thick at any zoom. */
export function DesignSnapGuides({ guides, zoom }: { guides: readonly SnapGuide[]; zoom: number }) {
  const thickness = 1.5 / zoom;
  return guides.map((guide) => (
    <div
      key={`${guide.axis}:${guide.position}:${guide.start}:${guide.end}`}
      data-testid="design-snap-guide"
      data-axis={guide.axis}
      aria-hidden
      className="pointer-events-none absolute bg-red-500"
      style={
        guide.axis === "y"
          ? {
              left: guide.start,
              top: guide.position - thickness / 2,
              width: guide.end - guide.start,
              height: thickness,
            }
          : {
              left: guide.position - thickness / 2,
              top: guide.start,
              width: thickness,
              height: guide.end - guide.start,
            }
      }
    />
  ));
}

/** The Shift-drag selection box, in viewport pixels. */
export function DesignMarqueeBox({ rect }: { rect: Rect }) {
  return (
    <div
      data-testid="design-marquee"
      aria-hidden
      className="pointer-events-none absolute border border-primary bg-primary/10"
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
    />
  );
}
