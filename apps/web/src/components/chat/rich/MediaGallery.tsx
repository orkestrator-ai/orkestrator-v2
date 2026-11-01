import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  Scan,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { openInBrowser } from "@/lib/backend";
import { artifactFilename, downloadBase64 } from "@/lib/chat/artifact-download";
import { useDialogFocusReturn } from "@/lib/dialog-focus";
import type { GalleryItem } from "@/lib/chat/rich-markdown/media-gallery-registry";
import { dataUrlBase64, dataUrlMime, fileExtension } from "@/lib/chat/rich-markdown/media-types";
import { cn } from "@/lib/utils";

const MIN_SCALE = 0.05;
const MAX_SCALE = 16;
const STEP = 1.25;

type Zoom = { mode: "fit" } | { mode: "free"; scale: number; x: number; y: number };

function clamp(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

function canCopyImages(): boolean {
  if (typeof window === "undefined") return false;
  if (window.orkestrator?.clipboard?.writeImage) return true;
  return typeof ClipboardItem !== "undefined" && typeof navigator.clipboard?.write === "function";
}

async function copyImage(src: string): Promise<void> {
  if (window.orkestrator?.clipboard?.writeImage) {
    await window.orkestrator.clipboard.writeImage(src);
    return;
  }
  const response = await fetch(src);
  const blob = await response.blob();
  await navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })]);
}

/**
 * The transcript image viewer: one dialog for attachments, provider images,
 * viewed-image previews and Markdown images. Keyboard: ←/→ previous/next,
 * +/− zoom, 0 fit, 1 original size, Escape closes (focus returns to the
 * thumbnail that opened it). Controls are plain buttons, never nested inside
 * another clickable element; the image itself is a drag-to-pan surface.
 */
export function MediaGalleryDialog({
  items,
  initialIndex,
  initialSource,
  open,
  onOpenChange,
}: {
  items: readonly GalleryItem[];
  initialIndex: number;
  /** Already-loaded source of the initial item, shown without another read. */
  initialSource?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const focusReturn = useDialogFocusReturn();
  const [index, setIndex] = useState(() =>
    Math.min(Math.max(0, initialIndex), Math.max(0, items.length - 1)),
  );
  const item = items[index];
  const [sources, setSources] = useState<ReadonlyMap<GalleryItem, string | null>>(() => {
    const initial = items[initialIndex];
    return initial && initialSource ? new Map([[initial, initialSource]]) : new Map();
  });
  const [zoom, setZoom] = useState<Zoom>({ mode: "fit" });
  const [natural, setNatural] = useState<{ width: number; height: number; fit: number } | null>(
    null,
  );
  const [failed, setFailed] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);

  const src = item ? sources.get(item) : undefined;

  // Escape closes even when the key event is delivered at the window rather
  // than through the dialog's own document listener.
  useEffect(() => {
    if (!open) return;
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [onOpenChange, open]);

  useEffect(() => {
    if (!item || sources.has(item)) return;
    let cancelled = false;
    void item.load().then(
      (loaded) => {
        if (!cancelled) setSources((current) => new Map(current).set(item, loaded));
      },
      () => {
        if (!cancelled) setSources((current) => new Map(current).set(item, null));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [item, sources]);

  const go = useCallback(
    (delta: number) => {
      if (items.length < 2) return;
      setIndex((current) => (current + delta + items.length) % items.length);
      setZoom({ mode: "fit" });
      setNatural(null);
      setFailed(false);
    },
    [items.length],
  );

  // Measured when the image loads (an event, not render), relative to the stage.
  const fitScale = natural?.fit ?? 1;

  const currentScale = zoom.mode === "fit" ? fitScale : zoom.scale;
  const setScale = (scale: number) => {
    const stage = stageRef.current;
    if (!natural || !stage) return;
    const next = clamp(scale);
    setZoom({
      mode: "free",
      scale: next,
      x: (stage.clientWidth - natural.width * next) / 2,
      y: (stage.clientHeight - natural.height * next) / 2,
    });
  };

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.target instanceof HTMLButtonElement && (event.key === " " || event.key === "Enter"))
      return;
    switch (event.key) {
      case "ArrowLeft":
        go(-1);
        break;
      case "ArrowRight":
        go(1);
        break;
      case "+":
      case "=":
        setScale(currentScale * STEP);
        break;
      case "-":
        setScale(currentScale / STEP);
        break;
      case "0":
        setZoom({ mode: "fit" });
        break;
      case "1":
        setScale(1);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const drag = useRef<{
    id: number;
    x: number;
    y: number;
    origin: { x: number; y: number };
  } | null>(null);
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (zoom.mode !== "free" || event.button !== 0) return;
    drag.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      origin: { x: zoom.x, y: zoom.y },
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    if (!active || active.id !== event.pointerId || zoom.mode !== "free") return;
    setZoom({
      ...zoom,
      x: active.origin.x + event.clientX - active.x,
      y: active.origin.y + event.clientY - active.y,
    });
  };

  const title = item?.title ?? "image";
  const remote = typeof src === "string" && /^https?:/i.test(src);
  const download = () => {
    if (!src) return;
    if (remote) {
      void openInBrowser(src).catch(() => toast.error("Could not open the original image"));
      return;
    }
    const base64 = dataUrlBase64(src);
    if (!base64) return;
    const mime = dataUrlMime(src) ?? "application/octet-stream";
    const extension =
      fileExtension(title) || mime.split("/")[1]?.replace(/[^a-z0-9]/g, "") || "bin";
    const base = title.replace(/\.[^.]+$/, "");
    downloadBase64(base64, artifactFilename(base || "image", extension), mime);
  };
  const copy = () => {
    if (!src) return;
    void copyImage(src).then(
      () => toast.success("Copied image"),
      () =>
        toast.error("Could not copy the image", { description: "Download the original instead." }),
    );
  };

  const stageImageStyle =
    zoom.mode === "free" && natural
      ? {
          width: natural.width * zoom.scale,
          height: natural.height * zoom.scale,
          transform: `translate(${zoom.x}px, ${zoom.y}px)`,
        }
      : undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        {...focusReturn}
        showCloseButton={false}
        aria-label={`Image preview: ${title}`}
        onKeyDown={onKeyDown}
        size="full"
        className="flex h-[90vh] w-[min(96rem,calc(100vw-2rem))] flex-col gap-2 p-3"
      >
        <DialogTitle className="sr-only">Image preview: {title}</DialogTitle>
        <DialogDescription className="sr-only">
          Use the arrow keys for previous and next, plus and minus to zoom, 0 to fit and 1 for
          original size.
        </DialogDescription>
        <div
          className="flex min-w-0 items-center gap-1"
          role="toolbar"
          aria-label="Image viewer controls"
        >
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
            {title}
            {items.length > 1 ? ` · ${index + 1} of ${items.length}` : ""}
            {natural
              ? ` · ${natural.width} × ${natural.height} px · ${Math.round(currentScale * 100)}%${
                  Math.abs(currentScale - 1) < 0.005 ? " (original size)" : ""
                }`
              : ""}
          </span>
          {items.length > 1 ? (
            <>
              <GalleryButton label="Previous image" onClick={() => go(-1)}>
                <ChevronLeft />
              </GalleryButton>
              <GalleryButton label="Next image" onClick={() => go(1)}>
                <ChevronRight />
              </GalleryButton>
            </>
          ) : null}
          <GalleryButton
            label="Zoom out"
            disabled={!natural}
            onClick={() => setScale(currentScale / STEP)}
          >
            <ZoomOut />
          </GalleryButton>
          <GalleryButton
            label="Zoom in"
            disabled={!natural}
            onClick={() => setScale(currentScale * STEP)}
          >
            <ZoomIn />
          </GalleryButton>
          <GalleryButton
            label="Fit to window"
            pressed={zoom.mode === "fit"}
            onClick={() => setZoom({ mode: "fit" })}
          >
            <Scan />
          </GalleryButton>
          <GalleryButton label="Original size" disabled={!natural} onClick={() => setScale(1)}>
            <span className="text-[11px] font-semibold">1:1</span>
          </GalleryButton>
          {src && !remote && canCopyImages() ? (
            <GalleryButton label="Copy image" onClick={copy}>
              <Copy />
            </GalleryButton>
          ) : null}
          {src ? (
            <GalleryButton
              label={remote ? "Open original in browser" : "Download original"}
              onClick={download}
            >
              {remote ? <ExternalLink /> : <Download />}
            </GalleryButton>
          ) : null}
          <GalleryButton label="Close image preview" onClick={() => onOpenChange(false)}>
            <X />
          </GalleryButton>
        </div>
        <div
          ref={stageRef}
          className={cn(
            "relative min-h-0 flex-1 overflow-hidden rounded-md bg-black/40",
            zoom.mode === "fit"
              ? "flex items-center justify-center"
              : "cursor-grab active:cursor-grabbing",
          )}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={() => (drag.current = null)}
          onPointerCancel={() => (drag.current = null)}
        >
          {src === undefined ? (
            <span className="m-auto text-sm text-muted-foreground" role="status">
              Loading image…
            </span>
          ) : src === null ? (
            <span
              className="m-auto text-sm text-muted-foreground"
              role="status"
              data-media-state="unavailable"
            >
              {title}: the image is unavailable. It may have been moved, deleted or access was
              revoked.
            </span>
          ) : failed ? (
            <span
              className="m-auto text-sm text-muted-foreground"
              role="status"
              data-media-state="decode-failed"
            >
              {title}: the image could not be decoded.
            </span>
          ) : (
            <img
              src={src}
              alt={title}
              draggable={false}
              referrerPolicy="no-referrer"
              onLoad={(event) => {
                const width = event.currentTarget.naturalWidth;
                const height = event.currentTarget.naturalHeight;
                const stage = stageRef.current;
                const fit =
                  stage && width > 0 && height > 0
                    ? Math.min(1, stage.clientWidth / width, stage.clientHeight / height) || 1
                    : 1;
                setNatural({ width, height, fit });
              }}
              onError={() => setFailed(true)}
              className={cn(
                "select-none",
                zoom.mode === "fit"
                  ? "max-h-full max-w-full object-contain"
                  : "absolute left-0 top-0 max-w-none",
              )}
              style={stageImageStyle}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function GalleryButton({
  label,
  onClick,
  disabled,
  pressed,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex h-8 min-w-8 items-center justify-center rounded px-1.5 text-muted-foreground outline-none hover:bg-elevated hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-40 [&_svg]:size-4",
        pressed && "bg-elevated text-foreground",
      )}
    >
      {children}
    </button>
  );
}
