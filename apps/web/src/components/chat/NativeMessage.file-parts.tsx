import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Image as ImageIcon, Quote } from "lucide-react";
import { FRONTEND_RENDER_POLICY } from "@orkestrator/protocol/rich-content-policy";
import { cn } from "@/lib/utils";
import { MessageMarkdown } from "@/components/chat/MessageMarkdown";
import { richMarkdownComponents } from "@/components/chat/rich/RichMarkdownBlocks";
import { MediaScopeContext } from "@/components/chat/rich/MediaBlock";
import { useStreamingDisplayText } from "@/lib/chat/rich-markdown/streaming-text";
import { JsonPayloadPart } from "@/components/chat/JsonPayloadPart";
import { userPromptPresentation } from "@/lib/chat/user-prompt-display";
import type { UserPromptPresentationKind } from "@orkestrator/protocol/review-evidence-frames";
import { MessageCopyButton } from "@/components/chat/MessageCopyButton";
import { parseJsonPayload } from "@/lib/chat/json-payload";
import { parseLocalFilePathFromUrl } from "@/lib/chat/file-url";
import { useMessagePartExpansion } from "@/lib/chat/message-part-expansion";
import {
  imagePreviewCacheKey,
  isImagePreviewUnavailable,
  markImagePreviewUnavailable,
  readImagePreviewCache,
  readImagePreviewDimensions,
  writeImagePreviewDimensions,
} from "@/lib/chat/image-preview-cache";
import { useRichMessageIdentity } from "@/lib/chat/rich-identity";
import { useTranscriptArtifactCapabilities } from "@/hooks/useTranscriptArtifactCapabilities";
import {
  galleryItems,
  useGalleryItem,
  type GalleryItem,
} from "@/lib/chat/rich-markdown/media-gallery-registry";
import {
  getSafeContainerRelativePath,
  isAbsoluteHostPath,
  isRemoteMediaUrl,
  resolveMediaUrl,
} from "@/lib/chat/rich-markdown/media-resolver";
import {
  base64Prefix,
  dataUrlBase64,
  imageDimensionsFromBytes,
} from "@/lib/chat/rich-markdown/media-types";
import { MediaGalleryDialog } from "@/components/chat/rich/MediaGallery";
import { FilePreview } from "@/components/chat/rich/FilePreview";
import {
  cacheToolDetails,
  cachedToolDetails,
  markdownComponents,
  ToolDetailLoaderContext,
  USER_PROMPT_COLLAPSED_LINE_COUNT,
  UserPromptEvidenceContext,
} from "./NativeMessage.shared";
import type { NativeMessagePart } from "@/lib/chat/native-message-types";

function isImageReference(pathOrUrl?: string): boolean {
  if (!pathOrUrl) return false;
  if (pathOrUrl.startsWith("data:image/")) return true;
  const lower = pathOrUrl.toLowerCase();
  return [
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".avif",
    ".svg",
    ".bmp",
    ".ico",
    ".tif",
    ".tiff",
  ].some((ext) => lower.includes(ext));
}

/** The decoded image would exceed the viewer's pixel ceiling. */
class ImageTooLargeError extends Error {
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    super("Image exceeds the preview decode limit");
    this.name = "ImageTooLargeError";
  }
}

/** Refuse to decode an image whose header declares more pixels than the ceiling. */
function assertDecodableImage(url: string): void {
  const base64 = dataUrlBase64(url);
  if (!base64) return;
  let dimensions: { width: number; height: number } | null = null;
  try {
    dimensions = imageDimensionsFromBytes(base64Prefix(base64, 64 * 1024));
  } catch {
    // Undecodable here; the <img> reports its own decode failure.
    return;
  }
  if (
    dimensions &&
    dimensions.width * dimensions.height > FRONTEND_RENDER_POLICY.imageDecodeMaxPixels
  ) {
    throw new ImageTooLargeError(dimensions.width, dimensions.height);
  }
}

/**
 * Whether a reference is worth mounting a synthesized preview for at all.
 *
 * A cheap pre-filter, not a guarantee. Inside a container it is exact, because
 * it runs the same containment the loader will. On the host it can only see
 * that the path is absolute: the renderer does not know the worktree root, and
 * the backend confines `read_file_base64` to workspace storage. A normalized
 * agent event can additionally carry a session-scoped exact-image reference;
 * either path can still turn out to be unreadable if it disappears or becomes
 * a symbolic link. The authoritative answer arrives with the load, which is
 * why the caller also passes `onLoadUnavailable` and drops the preview when it
 * fires.
 */
export function canLoadImagePreview(
  path: string,
  fileUrl: string | undefined,
  containerId: string | undefined,
): boolean {
  if (fileUrl?.startsWith("data:image/") || isRemoteMediaUrl(fileUrl)) return true;

  const localFilePath = fileUrl?.startsWith("file://") ? parseLocalFilePathFromUrl(fileUrl) : null;

  if (containerId) {
    return getSafeContainerRelativePath(localFilePath ?? path) !== null;
  }

  return Boolean(localFilePath ?? (isAbsoluteHostPath(path) ? path : null));
}

export function FilePart({
  path,
  fileUrl,
  filename,
  containerId,
  eagerPreview = false,
  detailRef,
  alwaysImage = false,
  hideThumbnailCaption = false,
  onLoadUnavailable,
}: {
  path: string;
  fileUrl?: string;
  filename?: string;
  containerId?: string;
  eagerPreview?: boolean;
  /**
   * Backend reference for an inline image with no readable path.
   *
   * OpenCode persists a pasted attachment as a data URL and a bare filename, so
   * `projectionPart` moves the bytes behind this reference; the image itself is
   * fetched on demand and never inflates the live transcript.
   */
  detailRef?: string;
  /**
   * The caller already knows this is an image (a first-class image part), so
   * the filename-extension heuristic must not decide for it.
   */
  alwaysImage?: boolean;
  /**
   * Show a thumbnail tile as the image alone. A user's own attachment needs no
   * filename caption; the name stays available to assistive technology.
   */
  hideThumbnailCaption?: boolean;
  /**
   * The bytes could not be resolved, so the owner should stop showing this row.
   *
   * Supplied only by a preview the renderer synthesized rather than one the
   * transcript reported. A first-class file row still names a real reference
   * when its bytes are out of reach and keeps its "preview unavailable" badge;
   * a recovered one has nothing left to say, so the badge is suppressed and the
   * owner unmounts the row instead.
   */
  onLoadUnavailable?: () => void;
}) {
  const loadToolDetails = useContext(ToolDetailLoaderContext);
  const cacheKey = imagePreviewCacheKey(containerId, path, fileUrl, detailRef);
  const [gallery, setGallery] = useState<{ items: GalleryItem[]; index: number } | null>(null);
  const [imageSrc, setImageSrc] = useState<string | null>(() => readImagePreviewCache(cacheKey));
  const [loading, setLoading] = useState(false);
  const [decodedImage, setDecodedImage] = useState(() => {
    const dimensions = readImagePreviewDimensions(cacheKey, imageSrc);
    return dimensions && imageSrc ? { source: imageSrc, ...dimensions } : null;
  });
  const loadedImageSrc = decodedImage?.source ?? null;
  const imageDimensions = decodedImage?.source === imageSrc ? decodedImage : null;
  const [loadError, setLoadError] = useState<"unavailable" | "too-large" | null>(null);
  const imageLoadRef = useRef<Promise<string | null> | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const galleryGroup = useRichMessageIdentity()?.messageId ?? "detached";
  // Held in a ref rather than closed over: putting the callback in `loadImage`'s
  // dependencies would rebuild it whenever the owner re-rendered, and the eager
  // effect keyed on that identity would then retry a read that has already
  // failed, on every render.
  const onLoadUnavailableRef = useRef(onLoadUnavailable);
  useEffect(() => {
    onLoadUnavailableRef.current = onLoadUnavailable;
  }, [onLoadUnavailable]);
  // A primitive so the eager effect's dependencies stay stable even when the
  // owner hands over a fresh callback.
  const ownerDropsUnreadable = Boolean(onLoadUnavailable);

  const displayName = filename || path.split(/[\\/]/).pop() || path || "file";
  const isImage = alwaysImage || isImageReference(fileUrl) || isImageReference(path);
  // Only the thumbnail-bearing surface gets the tile chrome. A part that is
  // never eagerly loaded would otherwise sit as an empty card until clicked.
  const showThumbnailTile = isImage && eagerPreview;

  const loadImage = useCallback((): Promise<string | null> => {
    if (!isImage) return Promise.resolve(null);
    if (imageLoadRef.current) return imageLoadRef.current;

    const cached = readImagePreviewCache(cacheKey);
    if (cached) return Promise.resolve(cached);

    setLoading(true);
    setLoadError(null);
    const request = (async () => {
      try {
        // The shared, environment-scoped resolver: deferred detail, inline
        // data, remote URL, or a backend-confined workspace/host read.
        const url = await resolveMediaUrl(
          { path, fileUrl, detailRef, containerId },
          {
            loadToolDetails,
            detailCache: { read: cachedToolDetails, write: cacheToolDetails },
            cacheImage: true,
          },
        );
        assertDecodableImage(url);
        return url;
      } catch (err) {
        console.error("[NativeMessage] Failed to load image preview:", err, {
          path,
          fileUrl,
        });
        setLoadError(err instanceof ImageTooLargeError ? "too-large" : "unavailable");
        if (onLoadUnavailableRef.current) {
          // Remembered only for an owner that drops the row. A first-class file
          // row keeps its badge and stays retryable, which is the behaviour a
          // user clicking it again expects.
          markImagePreviewUnavailable(cacheKey);
          onLoadUnavailableRef.current();
        }
        return null;
      }
    })();
    imageLoadRef.current = request;
    void request.finally(() => {
      if (imageLoadRef.current === request) {
        imageLoadRef.current = null;
        setLoading(false);
      }
    });
    return request;
  }, [cacheKey, isImage, path, fileUrl, containerId, detailRef, loadToolDetails]);

  useEffect(() => {
    if (!eagerPreview || !isImage || imageSrc || isRemoteMediaUrl(fileUrl)) return;
    // This exact reference already failed while the transcript was scrolled
    // past. Report it straight back rather than re-issuing the read.
    if (ownerDropsUnreadable && isImagePreviewUnavailable(cacheKey)) {
      onLoadUnavailableRef.current?.();
      return;
    }
    let cancelled = false;

    // Start the asynchronous read after effect setup, and skip it if the row
    // unmounts before then. Loading state belongs to the read, not setup.
    void Promise.resolve()
      .then(() => (cancelled ? null : loadImage()))
      .then((source) => {
        if (!cancelled && source) setImageSrc(source);
      });

    return () => {
      cancelled = true;
    };
  }, [cacheKey, eagerPreview, fileUrl, imageSrc, isImage, loadImage, ownerDropsUnreadable]);

  // Every image of the message shares one gallery, in document order.
  useGalleryItem(galleryGroup, isImage, {
    title: displayName,
    element: () => buttonRef.current,
    load: loadImage,
  });

  const handleClick = useCallback(async () => {
    if (!isImage) return;
    let source = imageSrc;
    if (!source) {
      source = await loadImage();
      if (!source) return;
      setImageSrc(source);
    }
    const items = galleryItems(galleryGroup);
    const index = items.findIndex((item) => item.element() === buttonRef.current);
    const self: GalleryItem = {
      title: displayName,
      element: () => buttonRef.current,
      load: loadImage,
    };
    setGallery(index >= 0 ? { items, index } : { items: [self], index: 0 });
  }, [displayName, galleryGroup, imageSrc, isImage, loadImage]);

  const closeGallery = useCallback((open: boolean) => {
    if (!open) setGallery(null);
  }, []);

  if (!isImage) {
    // Not an image: a MIME-aware preview that reads nothing until opened.
    return <FilePreview reference={{ path, fileUrl, detailRef, containerId }} name={displayName} />;
  }

  return (
    <>
      <button
        ref={buttonRef}
        onClick={handleClick}
        aria-label={`Open full image: ${displayName}`}
        aria-busy={loading}
        data-image-presentation={showThumbnailTile ? "thumbnail" : "chip"}
        className={cn(
          "text-xs my-0 rounded-md border transition-colors",
          showThumbnailTile
            ? "group relative block w-80 max-w-full shrink-0 overflow-hidden bg-muted/50 border-border hover:border-foreground/25 cursor-zoom-in"
            : "inline-flex items-center gap-1.5 py-1.5 px-2.5 bg-muted/50 border-border hover:bg-muted hover:border-border/80 cursor-zoom-in",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          loading && "opacity-50",
        )}
      >
        {showThumbnailTile && imageSrc && !loadError ? (
          <img
            src={imageSrc}
            alt={`Thumbnail: ${displayName}`}
            referrerPolicy="no-referrer"
            width={imageDimensions?.width}
            height={imageDimensions?.height}
            onLoad={(event) => {
              const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
              writeImagePreviewDimensions(cacheKey, imageSrc, { width, height });
              setDecodedImage({ source: imageSrc, width, height });
              setLoadError(null);
            }}
            onError={() => {
              setDecodedImage(null);
              setLoadError("unavailable");
            }}
            // Reserve the placeholder height until decode. Cached dimensions
            // reserve the final aspect ratio immediately on transcript remounts.
            className={cn(
              "block max-h-96 w-full bg-black/10 object-contain",
              imageDimensions ? "h-auto" : "h-48",
            )}
          />
        ) : showThumbnailTile ? (
          <span className="flex h-48 w-full items-center justify-center bg-muted/40">
            <ImageIcon className="size-5 text-muted-foreground" />
          </span>
        ) : (
          <ImageIcon className="w-3.5 h-3.5 text-muted-foreground" />
        )}
        {showThumbnailTile &&
        hideThumbnailCaption &&
        loadedImageSrc === imageSrc &&
        imageSrc &&
        !loadError ? null : (
          <span
            className={cn(
              "font-mono truncate text-muted-foreground",
              showThumbnailTile
                ? "block border-t border-border/60 px-2 py-1.5 text-left"
                : "max-w-[240px]",
            )}
          >
            {displayName}
          </span>
        )}
        {loadError && !onLoadUnavailable && (
          <span
            className={cn(
              "text-destructive text-[10px]",
              showThumbnailTile &&
                "absolute right-1.5 top-1.5 rounded bg-background/90 px-1.5 py-0.5",
            )}
          >
            {loadError === "too-large" ? "image too large to preview" : "preview unavailable"}
          </span>
        )}
      </button>

      {gallery && (
        <MediaGalleryDialog
          open
          items={gallery.items}
          initialIndex={gallery.index}
          initialSource={imageSrc}
          onOpenChange={closeGallery}
        />
      )}
    </>
  );
}

/** A quoted transcript excerpt attached to a user prompt. */
export function TranscriptReferencePart({
  part,
}: {
  part: Extract<NativeMessagePart, { type: "transcript-reference" }>;
}) {
  return (
    <div
      data-testid="transcript-reference-part"
      className="my-2 overflow-hidden rounded-md border border-border/70 bg-muted/30"
    >
      <div className="flex items-center gap-1.5 border-b border-border/60 px-3 py-2 text-xs font-medium text-muted-foreground">
        <Quote className="size-3.5" aria-hidden="true" />
        <span>Reference {part.reference}</span>
      </div>
      <blockquote
        data-agent-chat-search-content="true"
        className="max-h-56 overflow-y-auto border-l-2 border-primary/30 px-3 py-2 text-sm text-foreground/90"
      >
        <MessageMarkdown content={part.content} components={markdownComponents} />
      </blockquote>
      {part.comment ? (
        <div className="border-t border-border/60 px-3 py-2 text-sm">
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Your comment
          </div>
          <div data-agent-chat-search-content="true">
            <MessageMarkdown content={part.comment} components={markdownComponents} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Render a text content part with markdown support */
export function TextPart({
  content,
  showCopy = true,
  truncateUserPrompt = false,
  promptPresentation,
  renderJsonPayload = true,
  expansionKey,
  richPartId,
  containerId,
}: {
  content: string;
  showCopy?: boolean;
  truncateUserPrompt?: boolean;
  promptPresentation?: UserPromptPresentationKind;
  /**
   * Fold a block that is nothing but JSON into a structured view. Off for the
   * user's own messages, which are shown back as written.
   */
  renderJsonPayload?: boolean;
  /** Stable identity used to persist the folded payload's and prompt's expansion state. */
  expansionKey: string;
  /**
   * Stable source-part identity for rich block view state (code wrap,
   * disclosure, diagram viewport). Defaults to `expansionKey`.
   */
  richPartId?: string;
  /** Environment that Markdown images with local paths resolve against. */
  containerId?: string;
}) {
  // Expanding a long prompt grows its virtualized row, which can remount it;
  // local state would reset and snap the prompt shut again.
  const [isExpanded, setIsExpanded] = useMessagePartExpansion(`${expansionKey}/prompt-truncation`);
  const promptEvidence = useContext(UserPromptEvidenceContext);
  // Display-only coalescing: at most one parse per frame and 20 per second
  // while streaming; copy actions below still use the canonical `content`.
  const streaming = useStreamingDisplayText(content);
  // Rollout switch: off renders the plain Markdown path (find follows it).
  const richEnabled = useTranscriptArtifactCapabilities()?.rolloutFlags?.richMarkdown !== false;
  const displaySource = streaming.text;
  const presentedPrompt = useMemo(
    () =>
      truncateUserPrompt
        ? userPromptPresentation(displaySource, promptPresentation)
        : { displayText: displaySource, evidencePayload: null },
    [displaySource, promptPresentation, truncateUserPrompt],
  );
  const mediaScope = useMemo(() => ({ containerId }), [containerId]);
  const evidencePayload = promptEvidence ? null : presentedPrompt.evidencePayload;
  const displayContent = presentedPrompt.displayText;
  const lineCount = useMemo(() => displayContent.split(/\r\n|\r|\n/).length, [displayContent]);
  const shouldTruncate = truncateUserPrompt && lineCount > USER_PROMPT_COLLAPSED_LINE_COUNT;
  const jsonPayload = useMemo(
    () => (renderJsonPayload ? parseJsonPayload(displayContent) : null),
    [displayContent, renderJsonPayload],
  );

  if (jsonPayload) {
    return (
      <div className="group py-1.5">
        {/*
          Find draws its highlights from mounted DOM text, and a closed
          disclosure has unmounted everything below its trigger. So the find
          index is fed `jsonPayloadSearchText` — the collapsed row's own text —
          rather than the raw document, which would count matches that could
          never be highlighted and shift every sibling part's occurrence
          numbering. See `getNativeMessageSearchText`.
        */}
        <div>
          <JsonPayloadPart payload={jsonPayload} expansionKey={expansionKey} />
        </div>
        {showCopy ? (
          <MessageCopyButton
            content={content}
            wrapperClassName="opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100"
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className={cn("group", !truncateUserPrompt && "py-1.5")}>
      {evidencePayload ? (
        <div className="pb-2">
          <JsonPayloadPart
            payload={evidencePayload}
            expansionKey={`${expansionKey}/prompt-evidence`}
          />
        </div>
      ) : null}
      <div
        data-agent-chat-search-content="true"
        className={cn(
          "[&_.prose>:first-child]:mt-0 [&_.prose>:last-child]:mb-0",
          shouldTruncate && !isExpanded && "overflow-hidden",
        )}
        style={
          shouldTruncate && !isExpanded
            ? {
                maxHeight: `calc(${USER_PROMPT_COLLAPSED_LINE_COUNT} * 1.625rem)`,
              }
            : undefined
        }
      >
        <MediaScopeContext value={mediaScope}>
          <MessageMarkdown
            content={displayContent}
            components={richEnabled ? richMarkdownComponents : markdownComponents}
            richPartId={richEnabled ? (richPartId ?? expansionKey) : undefined}
            live={streaming.live}
          />
        </MediaScopeContext>
      </div>
      {shouldTruncate ? (
        <button
          type="button"
          className="mt-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          aria-expanded={isExpanded}
          onClick={() => setIsExpanded(!isExpanded)}
        >
          {isExpanded ? "show less" : "show more"}
        </button>
      ) : null}
      {showCopy ? (
        <MessageCopyButton
          content={content}
          wrapperClassName="opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100"
        />
      ) : null}
    </div>
  );
}
