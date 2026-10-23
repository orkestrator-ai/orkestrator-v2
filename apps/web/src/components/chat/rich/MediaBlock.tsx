import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { Download, ExternalLink, ImageOff, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { openInBrowser } from "@/lib/backend";
import { artifactFilename, downloadBase64 } from "@/lib/chat/artifact-download";
import {
  checkLoadedImage,
  IMAGE_DECODE_MAX_MEGAPIXELS,
  MEDIA_PLACEHOLDER_ASPECT_RATIO,
  mediaLoadFailure,
  type MediaDimensions,
} from "@/lib/chat/media-presentation";
import { dataUrlBase64, dataUrlMime, fileExtension } from "@/lib/chat/rich-markdown/media-types";
import { useRichTranscriptScope, useRichMessageIdentity } from "@/lib/chat/rich-identity";
import {
  galleryItems,
  useGalleryItem,
  type GalleryItem,
} from "@/lib/chat/rich-markdown/media-gallery-registry";
import {
  canResolveMedia,
  isRemoteMediaUrl,
  resolveMediaUrl,
  type MediaReference,
} from "@/lib/chat/rich-markdown/media-resolver";
import {
  cacheToolDetails,
  cachedToolDetails,
  ToolDetailLoaderContext,
} from "@/components/chat/NativeMessage.shared";
import { cn } from "@/lib/utils";
import { MediaGalleryDialog } from "./MediaGallery";

/** The environment a text part's Markdown images resolve against. */
export const MediaScopeContext = createContext<{ containerId?: string }>({});

type ImageState =
  | { status: "pending" }
  | { status: "ready"; url: string; dimensions: MediaDimensions | null; decoded: boolean }
  | { status: "blocked" }
  | { status: "outside-workspace" }
  | { status: "denied" }
  | { status: "unavailable"; remoteUrl?: string }
  | { status: "too-large" }
  | { status: "unsupported"; url: string; reason: "type" | "pixels" }
  | { status: "decode-failed"; url: string };

type FailedImageState = Exclude<ImageState, { status: "pending" | "ready" }>;

/** Visible text and accessible-name suffix for each failure; never colour alone. */
function failureCopy(state: FailedImageState): { text: string; name: string } {
  switch (state.status) {
    case "blocked":
      return { text: "image source not allowed", name: "image blocked" };
    case "outside-workspace":
      return { text: "image outside of the workspace", name: "image outside of the workspace" };
    case "denied":
      return { text: "access to this image was denied", name: "image access denied" };
    case "unavailable":
      return { text: "image unavailable", name: "image unavailable" };
    case "too-large":
      return { text: "image too large to preview", name: "image too large" };
    case "unsupported":
      return state.reason === "pixels"
        ? {
            text: `image exceeds the ${IMAGE_DECODE_MAX_MEGAPIXELS}-megapixel preview limit`,
            name: "image unsupported",
          }
        : { text: "not a supported image", name: "image unsupported" };
    case "decode-failed":
      return { text: "image could not be decoded", name: "image could not be decoded" };
  }
}

function readyOrUnsupported(url: string): ImageState {
  const check = checkLoadedImage(url);
  return check.ok
    ? { status: "ready", url, dimensions: check.dimensions, decoded: false }
    : { status: "unsupported", url, reason: check.reason };
}

function downloadDataUrl(url: string, label: string): void {
  const base64 = dataUrlBase64(url);
  if (!base64) return;
  const mime = dataUrlMime(url) ?? "application/octet-stream";
  const extension = fileExtension(label) || mime.split("/")[1]?.replace(/[^a-z0-9]/g, "") || "bin";
  downloadBase64(
    base64,
    artifactFilename(label.replace(/\.[^.]+$/, "") || "image", extension),
    mime,
  );
}

function decodePath(src: string): string {
  try {
    return decodeURI(src);
  } catch {
    return src;
  }
}

/** Load once the element is near the viewport (immediately where IntersectionObserver is absent). */
function useNearViewport(ref: RefObject<HTMLElement | null>, enabled: boolean): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (!enabled || near) return;
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { rootMargin: "200px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [enabled, near, ref]);
  return near;
}

/**
 * A Markdown image. Remote `http(s)` images load directly, as transcript
 * Markdown always has, with no referrer and no application credentials. A
 * local path resolves through the environment-scoped media resolver (the
 * backend confines the read) only when the image nears the viewport; a
 * `file://` or otherwise unsafe URL was already removed by the URL policy and
 * shows as blocked.
 *
 * Layout: a bounded aspect-ratio placeholder until bytes arrive, then the
 * intrinsic size from the image header (width/height attributes) so the box
 * is right before the browser decodes. Pending, blocked, denied, unavailable,
 * too large, unsupported and failed decoding each have their own visible
 * text; a failed image keeps its alt text and the file actions that remain
 * permitted (download bytes already held, open a remote original, retry).
 */
export function MarkdownImage(props: { src?: string; alt?: string; title?: string }) {
  const { containerId } = useContext(MediaScopeContext);
  const identity = useRichMessageIdentity();
  const scope = useRichTranscriptScope();
  const key = JSON.stringify([props.src, containerId, identity, scope]);
  return <MarkdownImageSource key={key} {...props} />;
}

function MarkdownImageSource({ src, alt, title }: { src?: string; alt?: string; title?: string }) {
  const { containerId } = useContext(MediaScopeContext);
  const loadToolDetails = useContext(ToolDetailLoaderContext);
  const group = useRichMessageIdentity()?.messageId ?? "detached";
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [galleryOpen, setGalleryOpen] = useState<{ items: GalleryItem[]; index: number } | null>(
    null,
  );

  const rawSource = src ?? "";
  const remote = isRemoteMediaUrl(rawSource);
  const reference = useMemo<MediaReference | null>(
    () =>
      rawSource && !remote && !/^[a-z][a-z0-9+.-]*:/i.test(rawSource)
        ? { path: decodePath(rawSource), containerId }
        : null,
    [containerId, rawSource, remote],
  );
  const resolvable = remote || (reference !== null && canResolveMedia(reference));
  const label = alt?.trim() || title?.trim() || rawSource.split(/[\\/]/).pop() || "image";

  const [state, setState] = useState<ImageState>(() =>
    remote
      ? { status: "ready", url: rawSource, dimensions: null, decoded: false }
      : resolvable
        ? { status: "pending" }
        : reference
          ? // A container path only fails the pre-check by escaping /workspace.
            reference.containerId
            ? { status: "outside-workspace" }
            : { status: "unavailable" }
          : { status: "blocked" },
  );
  const near = useNearViewport(buttonRef, state.status === "pending");

  useEffect(() => {
    if (!near || state.status !== "pending" || !reference) return;
    let cancelled = false;
    resolveMediaUrl(reference, {
      loadToolDetails,
      detailCache: { read: cachedToolDetails, write: cacheToolDetails },
      cacheImage: true,
    }).then(
      (url) => !cancelled && setState(readyOrUnsupported(url)),
      (error: unknown) => {
        if (cancelled) return;
        const failure = mediaLoadFailure(error);
        setState(
          failure === "outside-workspace"
            ? { status: "outside-workspace" }
            : failure === "denied"
              ? { status: "denied" }
              : failure === "too-large"
                ? { status: "too-large" }
                : { status: "unavailable" },
        );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [near, state.status, reference, loadToolDetails]);

  const url = state.status === "ready" ? state.url : null;
  useGalleryItem(group, url !== null, {
    title: label,
    element: () => buttonRef.current,
    load: async () => url,
  });

  if (state.status !== "pending" && state.status !== "ready") {
    const copy = failureCopy(state);
    const heldBytes =
      (state.status === "decode-failed" || state.status === "unsupported") &&
      state.url.startsWith("data:")
        ? state.url
        : null;
    const remoteOriginal = state.status === "unavailable" ? state.remoteUrl : undefined;
    const canRetry = state.status === "unavailable" && !remoteOriginal && resolvable;
    return (
      <span
        data-media-state={state.status}
        className="my-1 inline-flex max-w-full flex-wrap items-center gap-1.5 rounded-md border border-dashed border-border px-2 py-1 align-middle text-xs text-muted-foreground"
      >
        <span
          role="img"
          aria-label={`${label} (${copy.name})`}
          className="inline-flex min-w-0 items-center gap-1.5"
        >
          <ImageOff aria-hidden="true" className="size-3.5 shrink-0" />
          <span data-rich-chrome="true" className="truncate">
            {label} · {copy.text}
          </span>
        </span>
        {heldBytes ? (
          <FailureAction
            label={`Download original: ${label}`}
            onClick={() => downloadDataUrl(heldBytes, label)}
          >
            <Download aria-hidden="true" className="size-3" />
            Download
          </FailureAction>
        ) : null}
        {remoteOriginal ? (
          <FailureAction
            label={`Open original in browser: ${label}`}
            onClick={() =>
              void openInBrowser(remoteOriginal).catch(() =>
                toast.error("Could not open the original image"),
              )
            }
          >
            <ExternalLink aria-hidden="true" className="size-3" />
            Open original
          </FailureAction>
        ) : null}
        {canRetry ? (
          <FailureAction
            label={`Retry loading image: ${label}`}
            onClick={() => setState({ status: "pending" })}
          >
            <RotateCcw aria-hidden="true" className="size-3" />
            Retry
          </FailureAction>
        ) : null}
      </span>
    );
  }

  const dimensions = state.status === "ready" ? state.dimensions : null;
  // Until the browser has the image, an unknown size keeps a bounded box.
  const placeholder = !dimensions && !(state.status === "ready" && state.decoded);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={`Open image: ${label}`}
        disabled={!url}
        aria-busy={!url}
        data-media-state={state.status}
        onClick={() => {
          const items = galleryItems(group);
          const index = items.findIndex((item) => item.element() === buttonRef.current);
          if (index >= 0) setGalleryOpen({ items, index });
        }}
        style={
          placeholder ? { aspectRatio: MEDIA_PLACEHOLDER_ASPECT_RATIO, width: "10rem" } : undefined
        }
        className={cn(
          "relative my-1 inline-block max-w-full cursor-zoom-in overflow-hidden rounded-md border border-border align-top focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          !url && "animate-pulse bg-muted/50 motion-reduce:animate-none",
        )}
      >
        {url ? (
          <img
            src={url}
            alt={alt ?? ""}
            title={title}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            width={dimensions?.width}
            height={dimensions?.height}
            style={
              dimensions ? { aspectRatio: `${dimensions.width} / ${dimensions.height}` } : undefined
            }
            onLoad={() =>
              setState((current) =>
                current.status === "ready" && current.url === url
                  ? { ...current, decoded: true }
                  : current,
              )
            }
            onError={() =>
              setState(
                remote
                  ? { status: "unavailable", remoteUrl: rawSource }
                  : { status: "decode-failed", url },
              )
            }
            className={cn(
              "block max-h-80 max-w-full object-contain",
              dimensions && "h-auto",
              placeholder && "size-full",
            )}
          />
        ) : (
          <span
            data-rich-chrome="true"
            className="absolute inset-0 flex items-center justify-center px-2 text-center text-[11px] text-muted-foreground"
          >
            Loading image…
          </span>
        )}
      </button>
      {galleryOpen ? (
        <MediaGalleryDialog
          open
          items={galleryOpen.items}
          initialIndex={galleryOpen.index}
          initialSource={url}
          onOpenChange={(open) => !open && setGalleryOpen(null)}
        />
      ) : null}
    </>
  );
}

/** A failure-row action: a plain button beside (never inside) the image label. */
function FailureAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      data-rich-chrome="true"
      onClick={onClick}
      className="inline-flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </button>
  );
}
