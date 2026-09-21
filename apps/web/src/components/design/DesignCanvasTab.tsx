import "./design.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, Minus, Save, Download, Layers, MousePointer2 } from "lucide-react";
import {
  DESIGN_EVENT,
  type DesignCanvas,
  type DesignChange,
  type DesignElement,
  type DesignFrame,
  type DesignLayer,
} from "@orkestrator/protocol/design-canvas";
import { Button } from "@/components/ui/button";
import { invoke } from "@/lib/native/backend";
import { NATIVE_EVENT_STREAM_CONNECTED_EVENT } from "@/lib/native/events";
import { designAction, getCanvas, getChanges } from "./design-client";
import { DesignFrameView, type DesignSelection } from "./DesignFrameView";
import { DesignInspector } from "./DesignInspector";
import { DesignFrameBridge } from "./frame-bridge";
import { LatestMutationQueue } from "./latest-mutation-queue";

export function DesignCanvasTab({
  canvasId,
  environmentId,
  isActive,
}: {
  canvasId: string;
  environmentId: string;
  isActive: boolean;
}) {
  const [canvas, setCanvas] = useState<DesignCanvas | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [selection, setSelection] = useState<DesignSelection | null>(null);
  const [layers, setLayers] = useState<Record<string, DesignLayer[]>>({});
  const [showLayers, setShowLayers] = useState(true);
  const [layersWidth, setLayersWidth] = useState(160);
  const layersResize = useRef<{ x: number; width: number } | null>(null);
  const [zoom, setZoom] = useState(0.65);
  const [pan, setPan] = useState({ x: 45, y: 65 });
  const panStart = useRef<{ x: number; y: number; origin: typeof pan } | null>(null);
  const viewport = useRef<HTMLElement>(null);
  const bridges = useRef(new Map<string, DesignFrameBridge>());
  const sync = useRef<(() => Promise<void>) | null>(null);
  const canvasRef = useRef<DesignCanvas | null>(null);
  const mutationWorker = useRef(
    async (_request: { action: string; input: Record<string, unknown> }) => {},
  );
  const mutationQueue = useRef<LatestMutationQueue<{
    action: string;
    input: Record<string, unknown>;
  }> | null>(null);
  mutationQueue.current ??= new LatestMutationQueue(
    (request) => mutationWorker.current(request),
    setBusy,
  );
  const errorOf = useCallback(
    (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)),
    [],
  );
  useEffect(() => {
    const target = viewport.current;
    if (!isActive || !target) return;
    const wheel = (event: WheelEvent) => {
      // A non-passive listener keeps Ctrl+wheel inside the design viewport.
      event.preventDefault();
      if (event.ctrlKey || event.metaKey)
        setZoom((value) => Math.max(0.1, Math.min(3, value * Math.exp(-event.deltaY * 0.002))));
      else setPan((value) => ({ x: value.x - event.deltaX, y: value.y - event.deltaY }));
    };
    target.addEventListener("wheel", wheel, { passive: false });
    return () => target.removeEventListener("wheel", wheel);
  }, [isActive]);
  useEffect(() => {
    if (!isActive) return;
    let disposed = false,
      running = false,
      again = false;
    let generation: string | undefined,
      after = 0;
    const refresh = async () => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        do {
          again = false;
          const changes = await getChanges(environmentId, canvasId, generation, after);
          if (disposed) return;
          if (changes.reset || changes.revision !== after) {
            const snapshot = await getCanvas(environmentId, canvasId);
            if (disposed) return;
            if (!canvasRef.current || canvasRef.current.revision <= snapshot.revision)
              canvasRef.current = snapshot;
            setCanvas((current) =>
              current && current.revision > snapshot.revision ? current : snapshot,
            );
            after = snapshot.revision;
          }
          generation = changes.generation;
        } while (again && !disposed);
      } catch (reason) {
        if (!disposed) errorOf(reason);
      } finally {
        running = false;
      }
    };
    sync.current = refresh;
    // Subscribe before reading. Reconnection and the periodic cursor check
    // repair a dropped final hint as well as visible revision gaps.
    const unlisten = window.orkestrator?.listen<DesignChange>(DESIGN_EVENT, (event) => {
      if (event.canvasId === canvasId) void refresh();
    });
    const reconnect = window.orkestrator?.listen(NATIVE_EVENT_STREAM_CONNECTED_EVENT, () => {
      generation = undefined;
      void refresh();
    });
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 3000);
    return () => {
      disposed = true;
      sync.current = null;
      clearInterval(timer);
      unlisten?.();
      reconnect?.();
    };
  }, [canvasId, environmentId, isActive, errorOf]);
  mutationWorker.current = async (request) => {
    setError(null);
    setNotice("");
    const frameId = typeof request.input.frameId === "string" ? request.input.frameId : null;
    const latestFrame = frameId
      ? canvasRef.current?.frames.find((frame) => frame.id === frameId)
      : undefined;
    const input =
      latestFrame && "expectedRevision" in request.input
        ? { ...request.input, expectedRevision: latestFrame.revision }
        : request.input;
    try {
      await designAction(environmentId, request.action, { canvasId, ...input });
    } catch (reason) {
      errorOf(reason);
    }
    try {
      await sync.current?.();
    } catch (reason) {
      errorOf(reason);
    }
  };
  const mutate = useCallback((action: string, input: Record<string, unknown>) => {
    const key = typeof input.frameId === "string" ? input.frameId : "canvas";
    mutationQueue.current!.enqueue(key, { action, input });
  }, []);
  const selectLayer = (frame: DesignFrame, selector: string) => {
    const bridge = bridges.current.get(frame.id);
    if (!bridge || bridge.renderedRevision !== frame.revision) return;
    void bridge
      .ask<DesignElement>({ op: "inspectElement", selector })
      .then((element) => {
        if (bridge.renderedRevision === frame.revision)
          setSelection({ frameId: frame.id, revision: frame.revision, element });
      })
      .catch(errorOf);
  };
  const save = async () => {
    if (!canvas || busy) return;
    setBusy(true);
    setError(null);
    const filePath = `${
      canvas.name
        .replace(/[^a-zA-Z0-9_-]/g, "-")
        .replace(/^[^a-zA-Z0-9]+/, "")
        .slice(0, 80) || "design"
    }.orkdes`;
    try {
      await invoke("design_save", {
        canvasId,
        environmentId,
        expectedRevision: canvas.revision,
        filePath,
      });
      setNotice(`Saved ${filePath}`);
    } catch (reason) {
      errorOf(reason);
    } finally {
      setBusy(false);
    }
  };
  const download = async () => {
    try {
      const snapshot = await getCanvas(environmentId, canvasId);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `${snapshot.name.replace(/[^a-zA-Z0-9_-]/g, "-")}.orkdes`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (reason) {
      errorOf(reason);
    }
  };
  const onLayers = useCallback(
    (id: string, value: DesignLayer[]) => setLayers((current) => ({ ...current, [id]: value })),
    [],
  );
  if (!isActive) return null;
  return (
    <div
      className="design-workspace absolute inset-0 flex min-h-0 flex-col bg-background"
      aria-label="Design canvas"
    >
      <header className="flex flex-wrap items-center gap-1 border-b border-divider px-2 py-2">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Toggle layers"
          onClick={() => setShowLayers((value) => !value)}
        >
          <Layers className="size-4" />
        </Button>
        <span className="mr-auto truncate text-sm font-medium">
          {canvas?.name ?? "Loading design…"}
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Zoom out"
          onClick={() => setZoom((value) => Math.max(0.1, value / 1.2))}
        >
          <Minus className="size-4" />
        </Button>
        <button
          className="px-1 text-xs tabular-nums"
          aria-label="Reset canvas view"
          onClick={() => {
            setZoom(0.65);
            setPan({ x: 45, y: 65 });
          }}
        >
          {Math.round(zoom * 100)}%
        </button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Zoom in"
          onClick={() => setZoom((value) => Math.min(3, value * 1.2))}
        >
          <Plus className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Add frame"
          disabled={!canvas || busy}
          onClick={() => {
            if (canvas)
              void mutate("create_frame", {
                expectedRevision: canvas.revision,
                name: `Frame ${canvas.frames.length + 1}`,
                x: canvas.frames.length * 850,
                y: 0,
                width: 800,
                height: 600,
                html: "<!doctype html><html><head><style>body{margin:0;font-family:system-ui;padding:48px;background:#fff;color:#18181b}</style></head><body><h1>Your next idea</h1><p>Ask your agent to design here.</p></body></html>",
              });
          }}
        >
          <Plus className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Save design to repository"
          disabled={!canvas || busy}
          onClick={() => void save()}
        >
          <Save className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Download orkdes"
          disabled={!canvas}
          onClick={() => void download()}
        >
          <Download className="size-4" />
        </Button>
      </header>
      {error && (
        <div
          role="alert"
          className="flex items-center gap-2 border-b border-divider p-2 text-xs text-destructive"
        >
          <span className="flex-1">{error}</span>
          <button
            onClick={() => {
              setError(null);
              void sync.current?.();
            }}
          >
            Refresh
          </button>
        </div>
      )}
      {notice && (
        <p role="status" className="px-3 py-1 text-xs">
          {notice}
        </p>
      )}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {showLayers && (
          <div
            className="design-hierarchy relative flex shrink-0"
            style={{ width: layersWidth, maxWidth: "45%" }}
            data-inspecting={Boolean(selection)}
          >
            <nav aria-label="Design hierarchy" className="min-w-0 flex-1 overflow-auto p-2 text-xs">
              <h3 className="mb-3 text-muted-foreground">Layers</h3>
              {canvas?.frames.map((frame) => (
                <div key={frame.id} className="mb-4">
                  <button
                    className="mb-1 w-full truncate text-left font-medium"
                    onClick={() => {
                      setPan({ x: 40 - frame.x * zoom, y: 65 - frame.y * zoom });
                      setSelection(null);
                    }}
                  >
                    {frame.name}
                  </button>
                  {(layers[frame.id] ?? []).map((layer) => (
                    <button
                      key={layer.selector}
                      className={`block w-full truncate py-1 text-left hover:bg-muted ${selection?.frameId === frame.id && selection.element.selector === layer.selector ? "bg-muted" : ""}`}
                      style={{ paddingLeft: Math.min(layer.depth, 8) * 10 }}
                      onClick={() => selectLayer(frame, layer.selector)}
                    >
                      {layer.label}
                    </button>
                  ))}
                </div>
              ))}
            </nav>
            <div
              role="separator"
              aria-label="Resize design hierarchy"
              aria-orientation="vertical"
              aria-valuemin={120}
              aria-valuemax={400}
              aria-valuenow={layersWidth}
              tabIndex={0}
              className="relative z-30 w-px shrink-0 cursor-col-resize touch-none bg-divider after:absolute after:inset-y-0 after:-left-1 after:w-2 hover:bg-primary/50 focus-visible:bg-primary/50 focus-visible:outline-none"
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.currentTarget.focus();
                event.currentTarget.setPointerCapture(event.pointerId);
                layersResize.current = {
                  x: event.clientX,
                  width: event.currentTarget.parentElement!.getBoundingClientRect().width,
                };
              }}
              onPointerMove={(event) => {
                const start = layersResize.current;
                if (!start) return;
                const available = event.currentTarget.parentElement!.parentElement!.clientWidth;
                setLayersWidth(
                  Math.max(
                    120,
                    Math.min(400, available * 0.45, start.width + event.clientX - start.x),
                  ),
                );
              }}
              onPointerUp={(event) => {
                layersResize.current = null;
                event.currentTarget.releasePointerCapture(event.pointerId);
              }}
              onLostPointerCapture={() => {
                layersResize.current = null;
              }}
              onPointerCancel={() => {
                layersResize.current = null;
              }}
              onKeyDown={(event) => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                const pane = event.currentTarget.parentElement!;
                const maximum = Math.max(
                  120,
                  Math.min(400, pane.parentElement!.clientWidth * 0.45),
                );
                const width = pane.getBoundingClientRect().width;
                setLayersWidth(
                  event.key === "Home"
                    ? 120
                    : event.key === "End"
                      ? maximum
                      : Math.max(
                          120,
                          Math.min(maximum, width + (event.key === "ArrowRight" ? 10 : -10)),
                        ),
                );
              }}
            />
          </div>
        )}
        <main
          ref={viewport}
          aria-label="Canvas viewport"
          className="relative min-w-0 flex-1 overflow-hidden bg-muted/40 touch-none"
          style={{
            backgroundImage: "radial-gradient(var(--muted-foreground) .6px, transparent .6px)",
            backgroundSize: "20px 20px",
          }}
          onPointerDown={(event) => {
            if (event.target !== event.currentTarget && event.button !== 1) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            panStart.current = { x: event.clientX, y: event.clientY, origin: pan };
            setSelection(null);
          }}
          onPointerMove={(event) => {
            const start = panStart.current;
            if (start)
              setPan({
                x: start.origin.x + event.clientX - start.x,
                y: start.origin.y + event.clientY - start.y,
              });
          }}
          onPointerUp={() => {
            panStart.current = null;
          }}
          onPointerCancel={() => {
            panStart.current = null;
          }}
        >
          {canvas?.frames.length === 0 && (
            <div className="pointer-events-none absolute inset-0 grid place-content-center p-8 text-center">
              <MousePointer2 className="mx-auto mb-4 size-8 text-muted-foreground" />
              <p className="font-medium">A blank canvas for your next idea</p>
              <p className="mt-2 max-w-xs text-sm text-muted-foreground">
                Ask Claude or Codex to review your repo and create a mockup, or add a frame above.
              </p>
            </div>
          )}
          <div
            style={{
              position: "absolute",
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: "0 0",
            }}
          >
            {canvas?.frames.map((frame) => (
              <DesignFrameView
                key={frame.id}
                frame={frame}
                zoom={zoom}
                selected={selection}
                onSelect={setSelection}
                onLayers={onLayers}
                onError={errorOf}
                bridges={bridges.current}
                onElementResize={(original, width, height) => {
                  void mutate("set_element_styles", {
                    frameId: original.frameId,
                    expectedRevision: original.revision,
                    selector: original.element.selector,
                    styles: {
                      width: `${width}px`,
                      height: `${height}px`,
                      "box-sizing": "border-box",
                      ...(original.element.styles.display === "inline"
                        ? { display: "inline-block" }
                        : {}),
                    },
                  });
                }}
                onGeometry={(original, patch) => {
                  void mutate("update_frame", {
                    frameId: original.id,
                    expectedRevision: original.revision,
                    patch,
                  });
                }}
              />
            ))}
          </div>
        </main>
        {selection && (
          <DesignInspector
            key={`${selection.frameId}:${selection.element.selector}:${selection.revision}`}
            selection={selection}
            onClose={() => setSelection(null)}
            stale={
              canvas?.frames.find((frame) => frame.id === selection.frameId)?.revision !==
              selection.revision
            }
            busy={busy}
            onApply={(styles) => {
              void mutate("set_element_styles", {
                frameId: selection.frameId,
                expectedRevision: selection.revision,
                selector: selection.element.selector,
                styles,
              });
            }}
          />
        )}
      </div>
      <footer className="flex gap-3 border-t border-divider px-3 py-1 text-[10px] text-muted-foreground">
        <span>Drag background to pan · Scroll to pan · Ctrl + scroll to zoom</span>
        <span className="ml-auto">{canvas ? `Revision ${canvas.revision}` : "Connecting"}</span>
      </footer>
    </div>
  );
}
