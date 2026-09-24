import { createUuid } from "@/lib/uuid";
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { AlertTriangle, Loader2, MoreHorizontal, ShieldAlert } from "lucide-react";
import type { DesignElement, DesignFrame } from "@orkestrator/protocol/design-canvas";
import type { DesignFailure, DesignFrameMeta } from "@orkestrator/protocol/design-operations";
import { designBootstrap } from "@orkestrator/protocol/design-runtime";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { nextGestureId, useDesignCanvasActions, type GeometryPatch } from "./design-canvas-context";
import type { DesignSelection } from "./design-selection";
import { clampCoordinate, clampDimension } from "./design-viewport";
import { DesignFrameBridge } from "./frame-bridge";

export type { DesignSelection } from "./design-selection";

export function elementResizeChanged(
  initial: { width: number; height: number },
  width: number,
  height: number,
): boolean {
  return width !== Math.round(initial.width) || height !== Math.round(initial.height);
}

/** Keyboard step for frame move/resize; Shift uses the larger step. */
export function keyboardDelta(key: string, shift: boolean): { dx: number; dy: number } | null {
  const step = shift ? 10 : 1;
  switch (key) {
    case "ArrowLeft":
      return { dx: -step, dy: 0 };
    case "ArrowRight":
      return { dx: step, dy: 0 };
    case "ArrowUp":
      return { dx: 0, dy: -step };
    case "ArrowDown":
      return { dx: 0, dy: step };
    default:
      return null;
  }
}

interface Drag {
  base: DesignFrame;
  startX: number;
  startY: number;
  origin: { x: number; y: number; width: number; height: number };
  mode: "move" | "resize";
  gestureId: string;
  current: GeometryPatch;
}

const KEYBOARD_GESTURE_IDLE_MS = 800;

export const DesignFrameView = memo(function DesignFrameView({
  frame,
  committed,
  meta,
  live,
  zoom,
  mode,
  selected,
  pending,
  failure,
  canRestorePrevious,
  focused,
}: {
  /** Frame with optimistic previews applied. */
  frame: DesignFrame;
  /** Authoritative committed frame: the base of every new gesture. */
  committed: DesignFrame;
  meta?: DesignFrameMeta;
  live: boolean;
  zoom: number;
  mode: "inspect" | "preview";
  selected: DesignSelection | null;
  pending: boolean;
  failure?: DesignFailure;
  canRestorePrevious: boolean;
  focused: boolean;
}) {
  const actions = useDesignCanvasActions();
  // Effects read actions through a ref: the bridge's lifetime must follow the
  // iframe only, never the identity of canvas callbacks.
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const iframe = useRef<HTMLIFrameElement>(null);
  const [bridge, setBridge] = useState<DesignFrameBridge | null>(null);
  const [rendered, setRendered] = useState<string | null>(null);
  const html = useMemo(() => designBootstrap(createUuid()), []);
  const contentKey = meta?.contentId ?? `revision:${frame.revision}`;
  const drag = useRef<Drag | null>(null);
  const raf = useRef(0);
  const [gesture, setGesture] = useState<GeometryPatch | null>(null);
  const keyboard = useRef<{ gestureId: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const elementDrag = useRef<{
    selection: DesignSelection;
    x: number;
    y: number;
    width: number;
    height: number;
    gestureId: string;
  } | null>(null);
  const [elementSize, setElementSize] = useState<{ width: number; height: number } | null>(null);
  const invalid = meta?.validation.state === "invalid";

  useEffect(() => {
    if (!live) setBridge(null);
  }, [live]);
  useEffect(() => {
    if (!bridge) return;
    actionsRef.current.registerBridge(frame.id, bridge);
    return () => {
      actionsRef.current.registerBridge(frame.id, null);
      bridge.close();
    };
  }, [bridge, frame.id]);
  // Replace iframe DOM only when content identity changes; geometry and name
  // changes update frame chrome only.
  /* oxlint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    if (!bridge) return;
    let active = true;
    bridge.renderedContentId = null;
    setRendered(null);
    void bridge
      .ask({ op: "render", html: frame.html })
      .then(() => {
        if (!active || bridge.closed) return;
        bridge.renderedContentId = contentKey;
        bridge.renderedRevision = frame.revision;
        setRendered(contentKey);
        actionsRef.current.frameRendered(frame.id, contentKey);
      })
      .catch((error: unknown) => {
        if (active && !bridge.closed) actionsRef.current.reportError(error, frame.id);
      });
    return () => {
      active = false;
    };
  }, [bridge, contentKey]);
  /* oxlint-enable react-hooks/exhaustive-deps */
  useEffect(() => {
    if (!bridge || rendered !== contentKey) return;
    void bridge.ask({ op: "setMode", mode }).catch(() => undefined);
  }, [bridge, contentKey, mode, rendered]);
  useEffect(
    () => () => {
      cancelAnimationFrame(raf.current);
      if (keyboard.current) clearTimeout(keyboard.current.timer);
    },
    [],
  );

  const shown = { ...frame, ...gesture };
  const ready = Boolean(bridge) && rendered === contentKey;

  const scheduleGesture = () => {
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      if (drag.current) setGesture({ ...drag.current.current });
    });
  };
  const startDrag = (event: PointerEvent<HTMLElement>, dragMode: "move" | "resize") => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      base: committed,
      startX: event.clientX,
      startY: event.clientY,
      origin: { x: frame.x, y: frame.y, width: frame.width, height: frame.height },
      mode: dragMode,
      gestureId: nextGestureId(dragMode),
      current: {},
    };
    actions.pin(frame.id, true);
  };
  const moveDrag = (event: PointerEvent<HTMLElement>) => {
    const start = drag.current;
    if (!start) return;
    const dx = (event.clientX - start.startX) / zoom;
    const dy = (event.clientY - start.startY) / zoom;
    // Refs hold the latest sample so pointerup commits it even before a render.
    start.current =
      start.mode === "resize"
        ? {
            width: clampDimension(start.origin.width + dx),
            height: clampDimension(start.origin.height + dy),
          }
        : { x: clampCoordinate(start.origin.x + dx), y: clampCoordinate(start.origin.y + dy) };
    scheduleGesture();
  };
  const settleDrag = (commit: boolean) => {
    const start = drag.current;
    drag.current = null;
    cancelAnimationFrame(raf.current);
    raf.current = 0;
    if (start && commit) {
      const patch = start.current;
      const changed =
        start.mode === "resize"
          ? patch.width !== undefined &&
            (patch.width !== start.origin.width || patch.height !== start.origin.height)
          : patch.x !== undefined && (patch.x !== start.origin.x || patch.y !== start.origin.y);
      if (changed)
        actions.submitGeometry(
          start.base,
          patch,
          start.gestureId,
          start.mode === "resize" ? `Resize ${frame.name}` : `Move ${frame.name}`,
        );
    }
    setGesture(null);
    if (start) actions.pin(frame.id, false);
  };
  /** Abandons an element-resize drag (Escape, cancel, lost capture) and unpins the frame. */
  const cancelElementDrag = () => {
    if (!elementDrag.current) return;
    elementDrag.current = null;
    cancelAnimationFrame(raf.current);
    raf.current = 0;
    setElementSize(null);
    actions.pin(frame.id, false);
  };
  const onFrameKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape" && drag.current) {
      event.preventDefault();
      settleDrag(false);
      return;
    }
    const delta = keyboardDelta(event.key, event.shiftKey);
    if (!delta) return;
    event.preventDefault();
    submitKeyboard(event.altKey, delta);
  };
  /** One gesture per burst of keys; absolute values accumulate from the projected geometry. */
  const submitKeyboard = (resize: boolean, delta: { dx: number; dy: number }) => {
    if (!keyboard.current)
      keyboard.current = {
        gestureId: nextGestureId("keys"),
        timer: setTimeout(() => undefined, 0),
      };
    clearTimeout(keyboard.current.timer);
    keyboard.current.timer = setTimeout(() => {
      keyboard.current = null;
    }, KEYBOARD_GESTURE_IDLE_MS);
    const patch: GeometryPatch = resize
      ? {
          width: clampDimension(frame.width + delta.dx),
          height: clampDimension(frame.height + delta.dy),
        }
      : { x: clampCoordinate(frame.x + delta.dx), y: clampCoordinate(frame.y + delta.dy) };
    actions.submitGeometry(
      committed,
      patch,
      `${keyboard.current.gestureId}-${resize ? "r" : "m"}`,
      resize ? `Resize ${frame.name}` : `Move ${frame.name}`,
    );
  };

  const selection =
    selected?.frameId === frame.id && ready && !invalid ? selected.element.rect : null;
  const hitTest = (clientX: number, clientY: number, bounds: DOMRect) => {
    if (!bridge || !ready || invalid) return;
    const revision = committed.revision;
    const key = contentKey;
    void bridge
      .ask<DesignElement | null>({
        op: "hitTest",
        x: (clientX - bounds.left) / zoom,
        y: (clientY - bounds.top) / zoom,
      })
      .then((element) => {
        // Only apply a result for the content that was hit-tested.
        if (bridge.renderedContentId !== key) return;
        actions.select(
          element
            ? {
                frameId: frame.id,
                revision,
                element,
                ...(meta ? { structureId: meta.structureId, contentId: meta.contentId } : {}),
              }
            : null,
        );
      })
      .catch((error: unknown) => actions.reportError(error, frame.id));
  };
  const warnings =
    meta?.validation.reasons.filter(
      (reason) => reason.code !== "dom-limit" && reason.code !== "renderer-unavailable",
    ) ?? [];
  return (
    <section
      aria-label={`Frame ${frame.name}`}
      data-frame-id={frame.id}
      data-pending={pending || undefined}
      className="design-frame absolute"
      style={{ left: shown.x, top: shown.y, width: shown.width, height: shown.height }}
    >
      <div className="absolute -top-7 left-0 flex max-w-full items-center gap-1">
        <button
          type="button"
          className={`max-w-full cursor-grab truncate rounded-sm px-0.5 text-left text-xs text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring ${focused ? "text-foreground" : ""}`}
          onPointerDown={(event) => startDrag(event, "move")}
          onPointerMove={moveDrag}
          onPointerUp={() => settleDrag(true)}
          onPointerCancel={() => settleDrag(false)}
          onLostPointerCapture={() => {
            if (drag.current) settleDrag(false);
          }}
          onKeyDown={onFrameKey}
          onFocus={() => actions.focusFrame(frame.id)}
          aria-label={`Move frame ${frame.name}`}
          aria-description="Arrow keys move, Alt+Arrow keys resize, Shift for larger steps"
        >
          {frame.name} · {Math.round(shown.width)} × {Math.round(shown.height)}
          {pending && <span className="ml-1 text-[10px] text-primary">· saving</span>}
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`Frame actions for ${frame.name}`}
              className="rounded-sm p-0.5 text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
            >
              <MoreHorizontal className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onSelect={() => actions.frameAction(frame.id, "properties")}>
              Frame properties…
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => actions.frameAction(frame.id, "rename")}>
              Rename…
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => actions.frameAction(frame.id, "duplicate")}>
              Duplicate
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => actions.frameAction(frame.id, "fit")}>
              Zoom to frame
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => actions.frameAction(frame.id, "ask-agent")}>
              Ask agent about this frame
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive"
              onSelect={() => actions.frameAction(frame.id, "delete")}
            >
              Delete frame
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {live ? (
        <iframe
          ref={iframe}
          title={frame.name}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={html}
          tabIndex={mode === "preview" ? 0 : -1}
          className={`h-full w-full border-0 bg-white shadow-xl ${mode === "preview" ? "" : "pointer-events-none"}`}
          onLoad={() => {
            if (iframe.current?.contentWindow)
              setBridge(
                new DesignFrameBridge(iframe.current.contentWindow, 3000, actions.exitPreview),
              );
          }}
        />
      ) : (
        // A placeholder is never a hit-test surface: bring the frame into view
        // first so it gets a live, current render before any selection.
        <button
          type="button"
          tabIndex={-1}
          aria-label={`Show ${frame.name}`}
          className="grid h-full w-full place-content-center bg-white/80 text-center text-xs text-muted-foreground shadow-xl"
          onClick={() => actions.frameAction(frame.id, "fit")}
        >
          <span className="px-2">{frame.name}</span>
        </button>
      )}
      {live && !ready && !invalid && (
        <div
          className="pointer-events-none absolute inset-0 grid place-content-center bg-white/60"
          aria-hidden
        >
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      )}
      {mode === "inspect" && live && (
        <button
          type="button"
          aria-label={`Select element in ${frame.name}`}
          tabIndex={-1}
          className="absolute inset-0 cursor-crosshair bg-transparent"
          onClick={(event) =>
            hitTest(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect())
          }
        />
      )}
      {(pending || failure) && (
        <div
          className={`pointer-events-none absolute -inset-1 rounded-sm border-2 ${failure ? "border-destructive" : "border-dashed border-primary/70"}`}
          aria-hidden
        />
      )}
      {failure && (
        <p className="absolute -bottom-6 left-0 flex max-w-full items-center gap-1 truncate text-[11px] text-destructive">
          <AlertTriangle className="size-3 shrink-0" /> Edit not applied — review below
        </p>
      )}
      {invalid && (
        <div
          role="group"
          aria-label={`${frame.name} needs repair`}
          className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/95 p-4 text-center text-xs"
        >
          <ShieldAlert className="size-6 text-destructive" />
          <p className="font-medium">This frame can’t be edited</p>
          <p className="max-w-xs text-muted-foreground">
            {meta?.validation.message ?? "It could not be rendered by the design runtime."}
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            <button
              type="button"
              className="rounded border px-2 py-1 hover:bg-muted"
              onClick={() => actions.frameAction(frame.id, "retry-validation")}
            >
              Retry validation
            </button>
            <button
              type="button"
              className="rounded border px-2 py-1 hover:bg-muted"
              onClick={() => actions.frameAction(frame.id, "ask-agent")}
            >
              Ask agent to repair
            </button>
            {canRestorePrevious && (
              <button
                type="button"
                className="rounded border px-2 py-1 hover:bg-muted"
                onClick={() => actions.frameAction(frame.id, "restore-previous")}
              >
                Restore previous version
              </button>
            )}
          </div>
        </div>
      )}
      {!invalid && (meta?.validation.state === "renderer-unavailable" || warnings.length > 0) && (
        <p
          className="absolute -bottom-6 right-0 max-w-[70%] truncate text-[10px] text-muted-foreground"
          title={
            warnings.length
              ? `Blocked for safety: ${warnings.map((reason) => `${reason.count ?? ""} ${reason.code.replaceAll("-", " ")}`.trim()).join(", ")}. Data images/fonts and embedded CSS are supported; scripts and external requests never run.`
              : "Not yet validated by the design renderer"
          }
        >
          {warnings.length ? "Some content blocked" : "Not validated"}
        </p>
      )}
      {selection && selected && mode === "inspect" && (
        <div
          className="pointer-events-none absolute border-2 border-blue-500"
          style={{
            left: selection.x,
            top: selection.y,
            width: elementSize?.width ?? selection.width,
            height: elementSize?.height ?? selection.height,
          }}
        >
          <span className="absolute -left-1 -top-1 h-2 w-2 border border-blue-500 bg-white" />
          <button
            type="button"
            aria-label="Resize selected element"
            className="pointer-events-auto absolute -right-2 -bottom-2 h-4 w-4 cursor-nwse-resize border border-blue-500 bg-white focus-visible:outline-2 focus-visible:outline-ring"
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.stopPropagation();
              event.currentTarget.setPointerCapture(event.pointerId);
              elementDrag.current = {
                selection: selected,
                x: event.clientX,
                y: event.clientY,
                width: selection.width,
                height: selection.height,
                gestureId: nextGestureId("element"),
              };
              actions.pin(frame.id, true);
            }}
            onPointerMove={(event) => {
              const start = elementDrag.current;
              if (!start) return;
              const rect = start.selection.element.rect;
              start.width = Math.round(
                Math.max(1, Math.min(4096, rect.width + (event.clientX - start.x) / zoom)),
              );
              start.height = Math.round(
                Math.max(1, Math.min(4096, rect.height + (event.clientY - start.y) / zoom)),
              );
              if (!raf.current)
                raf.current = requestAnimationFrame(() => {
                  raf.current = 0;
                  if (elementDrag.current)
                    setElementSize({
                      width: elementDrag.current.width,
                      height: elementDrag.current.height,
                    });
                });
            }}
            onPointerUp={() => {
              const start = elementDrag.current;
              elementDrag.current = null;
              if (
                start &&
                elementResizeChanged(start.selection.element.rect, start.width, start.height)
              )
                actions.submitElementResize(
                  start.selection,
                  start.width,
                  start.height,
                  start.gestureId,
                );
              setElementSize(null);
              actions.pin(frame.id, false);
            }}
            onPointerCancel={cancelElementDrag}
            onLostPointerCapture={cancelElementDrag}
            onKeyDown={(event) => {
              const delta = keyboardDelta(event.key, event.shiftKey);
              if (!delta) {
                if (event.key === "Escape" && elementDrag.current) {
                  // Consumed here: the canvas-level Escape must not also clear the selection.
                  event.preventDefault();
                  cancelElementDrag();
                }
                return;
              }
              event.preventDefault();
              actions.submitElementResize(
                selected,
                Math.max(1, Math.min(4096, Math.round(selection.width) + delta.dx)),
                Math.max(1, Math.min(4096, Math.round(selection.height) + delta.dy)),
                nextGestureId("element-keys"),
              );
            }}
          />
        </div>
      )}
      <button
        type="button"
        aria-label={`Resize frame ${frame.name}`}
        className="absolute -bottom-2 -right-2 h-4 w-4 cursor-nwse-resize border border-blue-500 bg-white focus-visible:outline-2 focus-visible:outline-ring"
        onPointerDown={(event) => startDrag(event, "resize")}
        onPointerMove={moveDrag}
        onPointerUp={() => settleDrag(true)}
        onPointerCancel={() => settleDrag(false)}
        onLostPointerCapture={() => {
          if (drag.current) settleDrag(false);
        }}
        onKeyDown={(event) => {
          const delta = keyboardDelta(event.key, event.shiftKey);
          if (!delta) return;
          event.preventDefault();
          submitKeyboard(true, delta);
        }}
      />
    </section>
  );
});
