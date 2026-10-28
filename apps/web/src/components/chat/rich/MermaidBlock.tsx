import { RichRenderCapacityError } from "@/lib/chat/rich-render-cache";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Code2,
  Copy,
  Download,
  ImageDown,
  Maximize2,
  Minimize,
  RotateCcw,
  Scan,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAppAppearance } from "@/lib/chat/artifact-theme";
import { artifactFilename, downloadBlob, downloadText } from "@/lib/chat/artifact-download";
import { copyRichText } from "@/lib/chat/rich-markdown/clipboard";
import { useFindReveal } from "@/lib/chat/rich-markdown/find-reveal";
import { codeDisplayText } from "@/lib/chat/rich-markdown/markdown-search";
import {
  describeMermaidFailure,
  MermaidDeterministicError,
  peekMermaidPreview,
  promoteMermaidPreview,
  requestMermaidPreview,
  useMermaidRenderOptions,
  type MermaidFailure,
  type MermaidPreview,
} from "@/lib/chat/rich-markdown/mermaid-render";
import { rasterizeSvgToPng, standaloneSvg } from "@/lib/chat/rich-markdown/svg-export";
import { useDialogFocusReturn } from "@/lib/chat/rich-markdown/dialog-focus";
import {
  useRichBlockVisibility,
  useRichRenderPriority,
  type RichRowVisibility,
} from "@/lib/chat/rich-render-priority";
import { useRichViewField, type RichViewState } from "@/stores/richContentViewStore";
import { cn } from "@/lib/utils";
import { RichBlockFrame, RichToolbarButton } from "./RichBlockFrame";
import { CodeLines } from "./CodeBlock";
import { RichPinRecoveryNotice, useRichViewPin } from "./CodeBlockViewer";
import { RichSearchMirror } from "./RichMarkdownBlocks.shared";

export interface MermaidBlockProps {
  /** Exact fence body. */
  source: string;
  /** Only a closed fence is ever rendered; an open or clipped one stays source. */
  closed: boolean;
  blockKey: string;
  live?: boolean;
  clipped?: boolean;
}

type Viewport = NonNullable<RichViewState["viewport"]>;
/** `scale: 0` means "fit to the frame". */
const FIT_VIEWPORT: Viewport = { x: 0, y: 0, scale: 0 };
const MIN_SCALE = 0.1;
const MAX_SCALE = 8;
const ZOOM_STEP = 1.25;

type PreviewState =
  | { status: "idle" }
  | { status: "pending"; stale: MermaidPreview | null }
  | { status: "ready"; preview: MermaidPreview }
  | {
      status: "error";
      failure: MermaidFailure;
      deterministic: boolean;
      stale: MermaidPreview | null;
    };

/**
 * Render a closed fence through the diagram lane. A deterministic failure is
 * cached by the scheduler and never retried automatically; a transient one
 * offers `retry`. While new work is pending, the previous source's preview is
 * returned as `stale` so it can be labelled rather than passed off as current.
 */
function useMermaidPreview(
  source: string,
  theme: "light" | "dark",
  enabled: boolean,
  visibility: RichRowVisibility | null,
) {
  const [settled, setSettled] = useState<{ key: string; state: PreviewState } | null>(null);
  const [retryState, setRetryState] = useState({ key: "", attempt: 0 });
  // The latest preview shown, labelled as earlier work while a new source renders.
  const [lastPreview, setLastPreview] = useState<MermaidPreview | null>(null);
  const key = `${theme}\u0000${source}`;
  // Cache identity is scoped to the conversation; priority follows this
  // block's own visibility (its row's until the block is observed).
  const render = useMermaidRenderOptions();
  const blockPriority = useRichRenderPriority(visibility);
  const scope = render.options.scope;
  const retryKey = JSON.stringify([scope, key, render.epoch]);
  const attempt = retryState.key === retryKey ? retryState.attempt : 0;
  const priorityRef = useRef(blockPriority.current);
  useLayoutEffect(() => {
    priorityRef.current = blockPriority.current;
  });
  const visible = blockPriority.priority === "visible";
  useEffect(() => {
    if (enabled && visible) promoteMermaidPreview(source, theme, { scope });
  }, [enabled, visible, source, theme, scope]);

  // Settled values keep their identity in the cache, so these are stable deps.
  const cached = enabled ? peekMermaidPreview(source, theme, { scope }) : null;
  const cachedPreview = cached?.ok ? cached.value : null;
  const cachedError = cached && !cached.ok ? cached.error : null;
  if (cachedPreview && cachedPreview !== lastPreview) setLastPreview(cachedPreview);

  useEffect(() => {
    if (!enabled || cachedPreview || cachedError) return;
    let disposed = false;
    let capacityTimer: ReturnType<typeof setTimeout> | undefined;
    const request = requestMermaidPreview(source, theme, {
      scope,
      priority: priorityRef.current(),
    });
    request.promise.then(
      (preview) => {
        if (disposed) return;
        setSettled({ key, state: { status: "ready", preview } });
      },
      (error: unknown) => {
        if (disposed || (error instanceof DOMException && error.name === "AbortError")) return;
        if (error instanceof RichRenderCapacityError && attempt < 4) {
          capacityTimer = setTimeout(() => {
            if (!disposed) setRetryState({ key: retryKey, attempt: attempt + 1 });
          }, [100, 300, 1000, 3000][attempt]);
          return;
        }
        setSettled({
          key,
          state: {
            status: "error",
            failure: describeMermaidFailure(error),
            deterministic: error instanceof MermaidDeterministicError,
            stale: null,
          },
        });
      },
    );
    return () => {
      disposed = true;
      clearTimeout(capacityTimer);
      request.cancel();
    };
  }, [
    enabled,
    cachedPreview,
    cachedError,
    source,
    theme,
    key,
    attempt,
    scope,
    render.epoch,
    retryKey,
  ]);

  const retry = useCallback(
    () => setRetryState({ key: retryKey, attempt: attempt + 1 }),
    [retryKey, attempt],
  );

  let state: PreviewState;
  if (!enabled) state = { status: "idle" };
  else if (cachedPreview) state = { status: "ready", preview: cachedPreview };
  else if (cachedError) {
    state = {
      status: "error",
      failure: describeMermaidFailure(cachedError),
      deterministic: true,
      stale: null,
    };
  } else if (settled?.key === key) state = settled.state;
  else {
    const settledPreview = settled?.state.status === "ready" ? settled.state.preview : null;
    state = { status: "pending", stale: settledPreview ?? lastPreview };
  }
  return { state, retry };
}

function failureTitle(failure: MermaidFailure): string {
  switch (failure.kind) {
    case "syntax":
      return "Diagram syntax error";
    case "limit":
      return "Diagram exceeds a rendering limit";
    case "timeout":
      return "Diagram took too long to render";
    default:
      return "Diagram renderer unavailable";
  }
}

function failureDetail(failure: MermaidFailure): string {
  const location =
    failure.line !== undefined
      ? ` (line ${failure.line}${failure.column !== undefined ? `, column ${failure.column}` : ""})`
      : "";
  return `${failure.message}${location}`;
}

function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/**
 * Pan/zoom surface for a sanitized diagram. Ordinary wheel scrolling passes
 * through to the transcript; Ctrl/⌘ + wheel zooms. Arrow keys pan, +/- zoom
 * and 0 fits when the surface has focus. The SVG is excluded from find.
 */
function DiagramCanvas({
  preview,
  viewport,
  onViewportChange,
  className,
  label,
}: {
  preview: MermaidPreview;
  viewport: Viewport;
  onViewportChange: (viewport: Viewport) => void;
  className?: string;
  label: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState<{ width: number; height: number } | null>(null);
  const width = preview.width;
  const height = preview.height;

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const measure = () => setFrame({ width: element.clientWidth, height: element.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const effective = useMemo<Viewport>(() => {
    if (
      viewport.scale > 0 ||
      !width ||
      !height ||
      !frame ||
      frame.width === 0 ||
      frame.height === 0
    ) {
      return viewport.scale > 0 ? viewport : { x: 0, y: 0, scale: 1 };
    }
    const scale = clampScale(Math.min(frame.width / width, frame.height / height, 2));
    return { x: (frame.width - width * scale) / 2, y: (frame.height - height * scale) / 2, scale };
  }, [frame, height, viewport, width]);

  const zoomAt = useCallback(
    (factor: number, originX: number, originY: number) => {
      const scale = clampScale(effective.scale * factor);
      const ratio = scale / effective.scale;
      onViewportChange({
        scale,
        x: originX - (originX - effective.x) * ratio,
        y: originY - (originY - effective.y) * ratio,
      });
    },
    [effective, onViewportChange],
  );

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      zoomAt(
        event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP,
        event.clientX - rect.left,
        event.clientY - rect.top,
      );
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  const drag = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origin: Viewport;
  } | null>(null);
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: effective,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    onViewportChange({
      scale: active.origin.scale,
      x: active.origin.x + event.clientX - active.startX,
      y: active.origin.y + event.clientY - active.startY,
    });
  };
  const endDrag = () => {
    drag.current = null;
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = 40;
    const centerX = (frame?.width ?? 0) / 2;
    const centerY = (frame?.height ?? 0) / 2;
    switch (event.key) {
      case "ArrowLeft":
        onViewportChange({ ...effective, x: effective.x + step });
        break;
      case "ArrowRight":
        onViewportChange({ ...effective, x: effective.x - step });
        break;
      case "ArrowUp":
        onViewportChange({ ...effective, y: effective.y + step });
        break;
      case "ArrowDown":
        onViewportChange({ ...effective, y: effective.y - step });
        break;
      case "+":
      case "=":
        zoomAt(ZOOM_STEP, centerX, centerY);
        break;
      case "-":
        zoomAt(1 / ZOOM_STEP, centerX, centerY);
        break;
      case "0":
        onViewportChange(FIT_VIEWPORT);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const markup = useMemo(
    () => standaloneSvg(preview.svg, width, height),
    [height, preview.svg, width],
  );

  return (
    <div
      ref={containerRef}
      role="img"
      aria-label={label}
      tabIndex={0}
      data-rich-search-exclude="true"
      className={cn(
        "relative cursor-grab touch-none overflow-hidden bg-background/40 outline-none focus-visible:ring-2 focus-visible:ring-ring/60 active:cursor-grabbing",
        className,
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
    >
      {width && height ? (
        <div
          className="absolute left-0 top-0 origin-top-left"
          style={{
            width,
            height,
            transform: `translate(${effective.x}px, ${effective.y}px) scale(${effective.scale})`,
          }}
          // Sanitized twice: by the backend renderer and by `sanitizeSvg` here.
          dangerouslySetInnerHTML={{ __html: markup }}
        />
      ) : (
        <div
          className="p-3 [&_svg]:h-auto [&_svg]:max-w-full"
          dangerouslySetInnerHTML={{ __html: preview.svg }}
        />
      )}
    </div>
  );
}

/**
 * A Mermaid fence: the exact source plus, once the fence is complete, a
 * sanitized preview from the supervised renderer. Failures keep the source
 * readable and copyable; nothing here executes diagram content.
 */
export const MermaidBlock = memo(function MermaidBlock({
  source,
  closed,
  blockKey,
  live = false,
  clipped = false,
}: MermaidBlockProps) {
  const theme = useAppAppearance();
  const [view, setView] = useRichViewField(blockKey, "view", "preview");
  const [viewport, setViewport] = useRichViewField(blockKey, "viewport", FIT_VIEWPORT);
  const { revealed, endReveal } = useFindReveal(blockKey);
  // Persisted with the block identity so the expanded dialog survives
  // virtualization (scrolling away and back) like the source/preview choice.
  const [expanded, setExpanded] = useRichViewField(blockKey, "expanded", false);
  const { observe: observeBlock, visibility: blockVisibility } = useRichBlockVisibility();
  const { state, retry } = useMermaidPreview(source, theme, closed, blockVisibility);
  const dialogFocus = useDialogFocusReturn();

  const displayText = useMemo(() => codeDisplayText(source), [source]);
  const lines = useMemo(() => displayText.split("\n"), [displayText]);
  const sourceView = (
    <pre className="m-0 max-h-96 overflow-auto whitespace-pre p-3 font-mono text-xs leading-5 text-foreground">
      <code>
        <CodeLines lines={lines} tokens={null} />
      </code>
    </pre>
  );

  const preview = state.status === "ready" ? state.preview : null;
  // Only an open dialog pins its view state.
  const pin = useRichViewPin(blockKey, expanded && preview !== null, () => setExpanded(false));
  const stale = state.status === "pending" || state.status === "error" ? state.stale : null;
  const shown = preview ?? stale;
  // A closed fence whose first preview is still rendering keeps the preview's
  // own frame, so the diagram replaces it without changing the row's height.
  // The source is the explicit alternative: a fence still streaming, the
  // reader's choice, a find reveal, or a failure.
  const awaitingPreview =
    closed && !shown && state.status === "pending" && view !== "source" && !revealed;
  const showSource = !closed || view === "source" || revealed || (!shown && !awaitingPreview);

  const toggleSource = () => {
    setView(showSource ? "preview" : "source");
    if (revealed) endReveal();
  };

  const exportSvg = () => {
    if (!preview) return;
    downloadText(
      standaloneSvg(preview.svg, preview.width, preview.height),
      artifactFilename("mermaid-diagram", "svg"),
      "image/svg+xml",
    );
  };
  const exportPng = async () => {
    if (!preview) return;
    try {
      if (!preview.width || !preview.height) throw new Error("The diagram has no intrinsic size");
      const blob = await rasterizeSvgToPng(preview.svg, preview.width, preview.height);
      downloadBlob(blob, artifactFilename("mermaid-diagram", "png"));
    } catch {
      toast.error("PNG export is unavailable for this diagram", {
        description: "Download the SVG instead; it contains the same sanitized drawing.",
        action: { label: "Download SVG", onClick: exportSvg },
      });
    }
  };

  const status = !closed
    ? clipped
      ? "Clipped · not rendered"
      : live
        ? "Waiting for the complete diagram…"
        : "Incomplete · not rendered"
    : state.status === "pending" && stale
      ? "Previous version shown · updating…"
      : null;

  const error =
    state.status === "error"
      ? {
          title: failureTitle(state.failure),
          detail: state.deterministic
            ? failureDetail(state.failure)
            : `${failureDetail(state.failure)}. The source is shown instead.`,
          action: state.deterministic ? undefined : (
            <RichToolbarButton label="Retry rendering" onClick={retry}>
              <RotateCcw aria-hidden="true" />
            </RichToolbarButton>
          ),
        }
      : null;

  const previewActions =
    shown && !showSource ? (
      <>
        <RichToolbarButton
          label="Zoom in"
          onClick={() =>
            setViewport({ ...viewport, scale: clampScale((viewport.scale || 1) * ZOOM_STEP) })
          }
        >
          <ZoomIn aria-hidden="true" />
        </RichToolbarButton>
        <RichToolbarButton
          label="Zoom out"
          onClick={() =>
            setViewport({ ...viewport, scale: clampScale((viewport.scale || 1) / ZOOM_STEP) })
          }
        >
          <ZoomOut aria-hidden="true" />
        </RichToolbarButton>
        <RichToolbarButton label="Fit diagram" onClick={() => setViewport(FIT_VIEWPORT)}>
          <Scan aria-hidden="true" />
        </RichToolbarButton>
        <RichToolbarButton label="Reset zoom" onClick={() => setViewport({ x: 0, y: 0, scale: 1 })}>
          <Minimize aria-hidden="true" />
        </RichToolbarButton>
      </>
    ) : null;

  const actions = (
    <>
      {closed ? (
        <RichToolbarButton
          label="Show source"
          pressed={showSource}
          disabled={!shown}
          onClick={toggleSource}
        >
          <Code2 aria-hidden="true" />
        </RichToolbarButton>
      ) : null}
      {previewActions}
      {preview ? (
        <>
          <RichToolbarButton
            label="Expand diagram"
            pressed={expanded}
            onClick={() => setExpanded(true)}
          >
            <Maximize2 aria-hidden="true" />
          </RichToolbarButton>
          <RichToolbarButton label="Download SVG" onClick={exportSvg}>
            <Download aria-hidden="true" />
          </RichToolbarButton>
          <RichToolbarButton label="Download PNG" onClick={() => void exportPng()}>
            <ImageDown aria-hidden="true" />
          </RichToolbarButton>
        </>
      ) : null}
      <RichToolbarButton
        label="Copy source"
        onClick={() => void copyRichText(source, "diagram source")}
      >
        <Copy aria-hidden="true" />
      </RichToolbarButton>
    </>
  );

  return (
    <RichBlockFrame
      kind="mermaid"
      blockKey={blockKey}
      title="Mermaid diagram"
      subtitle={preview?.diagramType}
      status={status}
      actions={actions}
      loading={closed && state.status === "pending"}
      loadingLabel="Rendering diagram…"
      error={error}
      fallback={sourceView}
    >
      {/* Locates this block's frame for the transcript's block observer. */}
      <span ref={observeBlock} hidden />
      {pin.displaced ? (
        <RichPinRecoveryNotice
          what="expanded diagram"
          onReopen={pin.reopen}
          onDismiss={pin.dismiss}
        />
      ) : null}
      {showSource ? (
        sourceView
      ) : awaitingPreview ? (
        <>
          <div aria-hidden="true" data-rich-preview-placeholder="true" className="h-80" />
          <RichSearchMirror text={displayText} revealKey={blockKey} />
        </>
      ) : (
        <>
          {stale && !preview ? (
            <div
              data-rich-chrome="true"
              className="select-none border-b border-border/60 bg-amber-500/10 px-3 py-1 text-[11px] text-foreground"
            >
              Showing the preview of an earlier version of this diagram while the current source
              renders.
            </div>
          ) : null}
          <DiagramCanvas
            preview={shown!}
            viewport={viewport}
            onViewportChange={setViewport}
            className="h-80"
            label={`Mermaid ${shown!.diagramType} diagram. Use Show source for its text.`}
          />
          <RichSearchMirror text={displayText} revealKey={blockKey} />
        </>
      )}
      {expanded && preview ? (
        <Dialog open={expanded} onOpenChange={setExpanded}>
          <DialogContent
            {...dialogFocus}
            size="full"
            className="flex h-[85vh] w-[min(80rem,calc(100vw-2rem))] flex-col gap-2"
          >
            <DialogHeader>
              <DialogTitle>Mermaid diagram</DialogTitle>
              <DialogDescription>
                Drag to pan; Ctrl or ⌘ with the scroll wheel zooms. Press 0 to fit.
              </DialogDescription>
            </DialogHeader>
            <div className="flex justify-end gap-1" role="toolbar" aria-label="Diagram actions">
              <RichToolbarButton label="Fit diagram" onClick={() => setViewport(FIT_VIEWPORT)}>
                <Scan aria-hidden="true" />
              </RichToolbarButton>
              <RichToolbarButton
                label="Reset zoom"
                onClick={() => setViewport({ x: 0, y: 0, scale: 1 })}
              >
                <Minimize aria-hidden="true" />
              </RichToolbarButton>
              <RichToolbarButton label="Download SVG" onClick={exportSvg}>
                <Download aria-hidden="true" />
              </RichToolbarButton>
              <RichToolbarButton label="Download PNG" onClick={() => void exportPng()}>
                <ImageDown aria-hidden="true" />
              </RichToolbarButton>
            </div>
            <DiagramCanvas
              preview={preview}
              viewport={viewport}
              onViewportChange={setViewport}
              className="min-h-0 flex-1 rounded-md border border-border"
              label={`Mermaid ${preview.diagramType} diagram, expanded`}
            />
          </DialogContent>
        </Dialog>
      ) : null}
    </RichBlockFrame>
  );
});
