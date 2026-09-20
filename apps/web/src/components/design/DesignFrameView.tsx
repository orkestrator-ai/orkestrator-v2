import { createUuid } from "@/lib/uuid";
import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import type { DesignElement, DesignFrame, DesignLayer } from "@orkestrator/protocol/design-canvas";
import { designBootstrap } from "@orkestrator/protocol/design-runtime";
import { DesignFrameBridge } from "./frame-bridge";

export interface DesignSelection {
  frameId: string;
  revision: number;
  element: DesignElement;
}
export function DesignFrameView({
  frame,
  zoom,
  selected,
  onSelect,
  onLayers,
  onGeometry,
  onElementResize,
  onError,
  bridges,
}: {
  frame: DesignFrame;
  zoom: number;
  selected: DesignSelection | null;
  onSelect: (selection: DesignSelection | null) => void;
  onLayers: (id: string, layers: DesignLayer[]) => void;
  onGeometry: (frame: DesignFrame, patch: Record<string, number>) => void;
  onElementResize: (selection: DesignSelection, width: number, height: number) => void;
  onError: (error: unknown) => void;
  bridges: Map<string, DesignFrameBridge>;
}) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const [bridge, setBridge] = useState<DesignFrameBridge | null>(null);
  const [preview, setPreview] = useState<Partial<DesignFrame> | null>(null);
  const html = useMemo(() => designBootstrap(createUuid()), []);
  const drag = useRef<{ frame: DesignFrame; x: number; y: number; resize: boolean } | null>(null);
  const elementDrag = useRef<{
    selection: DesignSelection;
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const [elementSize, setElementSize] = useState<{ width: number; height: number } | null>(null);
  const callbacks = useRef({ onLayers, onError });
  callbacks.current = { onLayers, onError };
  useEffect(() => {
    if (!bridge) return;
    bridges.set(frame.id, bridge);
    return () => {
      bridges.delete(frame.id);
      bridge.close();
    };
  }, [bridge, bridges, frame.id]);
  useEffect(() => {
    if (!bridge) return;
    let active = true;
    bridge.renderedRevision = null;
    void bridge
      .ask({ op: "render", html: frame.html })
      .then(() => bridge.ask<DesignLayer[]>({ op: "hierarchy" }))
      .then((layers) => {
        if (active) {
          bridge.renderedRevision = frame.revision;
          callbacks.current.onLayers(frame.id, layers);
        }
      })
      .catch((error) => {
        if (active) callbacks.current.onError(error);
      });
    return () => {
      active = false;
    };
  }, [bridge, frame.html, frame.id, frame.revision]);
  const startDrag = (event: PointerEvent<HTMLButtonElement>, resize: boolean) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { frame, x: event.clientX, y: event.clientY, resize };
  };
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const start = drag.current;
    if (!start) return;
    const dx = (event.clientX - start.x) / zoom,
      dy = (event.clientY - start.y) / zoom;
    setPreview(
      start.resize
        ? {
            width: Math.round(Math.max(32, Math.min(4096, start.frame.width + dx))),
            height: Math.round(Math.max(32, Math.min(4096, start.frame.height + dy))),
          }
        : {
            x: Math.round(Math.max(-100000, Math.min(100000, start.frame.x + dx))),
            y: Math.round(Math.max(-100000, Math.min(100000, start.frame.y + dy))),
          },
    );
  };
  const end = () => {
    if (drag.current && preview) onGeometry(drag.current.frame, preview as Record<string, number>);
    drag.current = null;
    setPreview(null);
  };
  const shown = { ...frame, ...preview };
  const selection =
    selected?.frameId === frame.id && selected.revision === frame.revision
      ? selected.element.rect
      : null;
  return (
    <section
      aria-label={`Frame ${frame.name}`}
      className="absolute"
      style={{ left: shown.x, top: shown.y, width: shown.width, height: shown.height }}
    >
      <button
        className="absolute -top-7 left-0 max-w-full truncate text-left text-xs text-muted-foreground"
        onPointerDown={(e) => startDrag(e, false)}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={() => {
          drag.current = null;
          setPreview(null);
        }}
        aria-label={`Move frame ${frame.name}`}
      >
        {frame.name} · {frame.width} × {frame.height}
      </button>
      <iframe
        ref={iframe}
        title={frame.name}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        srcDoc={html}
        className="h-full w-full border-0 bg-white pointer-events-none shadow-xl"
        onLoad={() => {
          if (iframe.current?.contentWindow)
            setBridge(new DesignFrameBridge(iframe.current.contentWindow));
        }}
      />
      <button
        aria-label={`Select element in ${frame.name}`}
        className="absolute inset-0 cursor-crosshair bg-transparent"
        onClick={(event) => {
          if (!bridge || bridge.renderedRevision !== frame.revision) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          const revision = frame.revision;
          void bridge
            ?.ask<DesignElement | null>({
              op: "hitTest",
              x: (event.clientX - bounds.left) / zoom,
              y: (event.clientY - bounds.top) / zoom,
            })
            .then((element) => {
              if (bridge.renderedRevision === revision)
                onSelect(element ? { frameId: frame.id, revision, element } : null);
            })
            .catch(onError);
        }}
      />
      {selection && (
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
            aria-label="Resize selected element"
            className="pointer-events-auto absolute -right-2 -bottom-2 h-4 w-4 cursor-nwse-resize border border-blue-500 bg-white"
            onPointerDown={(event) => {
              if (event.button !== 0 || !selected) return;
              event.stopPropagation();
              event.currentTarget.setPointerCapture(event.pointerId);
              elementDrag.current = {
                selection: selected,
                x: event.clientX,
                y: event.clientY,
                width: selection.width,
                height: selection.height,
              };
            }}
            onPointerMove={(event) => {
              const start = elementDrag.current;
              if (!start) return;
              start.width = Math.round(
                Math.max(
                  1,
                  Math.min(
                    4096,
                    start.selection.element.rect.width + (event.clientX - start.x) / zoom,
                  ),
                ),
              );
              start.height = Math.round(
                Math.max(
                  1,
                  Math.min(
                    4096,
                    start.selection.element.rect.height + (event.clientY - start.y) / zoom,
                  ),
                ),
              );
              setElementSize({ width: start.width, height: start.height });
            }}
            onPointerUp={() => {
              const start = elementDrag.current;
              if (start) onElementResize(start.selection, start.width, start.height);
              elementDrag.current = null;
              setElementSize(null);
            }}
            onPointerCancel={() => {
              elementDrag.current = null;
              setElementSize(null);
            }}
            onKeyDown={(event) => {
              if (
                !selected ||
                !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
              )
                return;
              event.preventDefault();
              const step = event.shiftKey ? 10 : 1;
              onElementResize(
                selected,
                Math.max(
                  1,
                  Math.min(
                    4096,
                    Math.round(selection.width) +
                      (event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0),
                  ),
                ),
                Math.max(
                  1,
                  Math.min(
                    4096,
                    Math.round(selection.height) +
                      (event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0),
                  ),
                ),
              );
            }}
          />
        </div>
      )}
      <button
        aria-label={`Resize frame ${frame.name}`}
        className="absolute -bottom-2 -right-2 h-4 w-4 cursor-nwse-resize border border-blue-500 bg-white"
        onPointerDown={(e) => startDrag(e, true)}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={() => {
          drag.current = null;
          setPreview(null);
        }}
      />
    </section>
  );
}
