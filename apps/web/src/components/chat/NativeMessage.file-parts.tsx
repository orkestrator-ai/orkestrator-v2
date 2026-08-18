import { createPortal } from "react-dom";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FileText, Image as ImageIcon, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { readContainerFileBase64, readFileBase64 } from "@/lib/backend";
import { MessageMarkdown } from "@/components/chat/MessageMarkdown";
import { JsonPayloadPart } from "@/components/chat/JsonPayloadPart";
import { MessageCopyButton } from "@/components/chat/MessageCopyButton";
import { parseJsonPayload } from "@/lib/chat/json-payload";
import { parseLocalFilePathFromUrl } from "@/lib/chat/file-url";
import {
  imagePreviewCacheKey,
  readImagePreviewCache,
  writeImagePreviewCache,
} from "@/lib/chat/image-preview-cache";
import { markdownComponents, USER_PROMPT_COLLAPSED_LINE_COUNT } from "./NativeMessage.shared";

function ImagePreviewOverlay({
  imageSrc,
  filename,
  onClose,
}: {
  imageSrc: string;
  filename: string;
  onClose: () => void;
}) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose],
  );

  useLayoutEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-8"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Image preview: ${filename}`}
    >
      <div className="relative max-w-full max-h-full" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={onClose}
          className="absolute -top-10 right-0 p-2 text-white/70 hover:text-white transition-colors"
          aria-label="Close image preview"
          autoFocus
        >
          <X className="w-6 h-6" />
        </button>
        <div className="text-white/70 text-sm mb-2 text-center">{filename}</div>
        <img
          src={imageSrc}
          alt={filename}
          className="max-w-full max-h-[80vh] object-contain rounded-lg shadow-2xl"
        />
      </div>
    </div>,
    document.body,
  );
}

function getMimeType(path: string): string {
  const ext = path.split("?")[0]?.split("#")[0]?.split(".").pop()?.toLowerCase();
  const mimeTypes: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    bmp: "image/bmp",
    ico: "image/x-icon",
    tiff: "image/tiff",
    tif: "image/tiff",
  };
  return mimeTypes[ext || ""] || "image/png";
}

function isImageReference(pathOrUrl?: string): boolean {
  if (!pathOrUrl) return false;
  if (pathOrUrl.startsWith("data:image/")) return true;
  const lower = pathOrUrl.toLowerCase();
  return [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico", ".tif", ".tiff"].some(
    (ext) => lower.includes(ext),
  );
}

function isRemoteImageUrl(fileUrl?: string): boolean {
  return typeof fileUrl === "string" && /^https?:\/\//i.test(fileUrl);
}

function getSafeContainerRelativePath(path: string): string | null {
  if (!path || path.includes("\0") || path.includes("\n") || path.includes("\r")) {
    return null;
  }
  if (path.split(/[\\/]+/).some((segment) => segment === "..")) {
    return null;
  }
  if (/^[a-z]:[\\/]/i.test(path) || path.startsWith("\\")) {
    return null;
  }
  if (path.startsWith("/workspace/")) {
    const relativePath = path.slice("/workspace/".length);
    if (
      !relativePath ||
      relativePath.startsWith("/") ||
      relativePath.startsWith("\\") ||
      /^[a-z]:[\\/]/i.test(relativePath)
    ) {
      return null;
    }
    return relativePath;
  }
  if (path.startsWith("/")) {
    return null;
  }
  return path;
}

export function FilePart({
  path,
  fileUrl,
  filename,
  containerId,
  eagerPreview = false,
}: {
  path: string;
  fileUrl?: string;
  filename?: string;
  containerId?: string;
  eagerPreview?: boolean;
}) {
  const cacheKey = imagePreviewCacheKey(containerId, path, fileUrl);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [imageSrc, setImageSrc] = useState<string | null>(() => readImagePreviewCache(cacheKey));
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const imageLoadRef = useRef<Promise<string | null> | null>(null);

  const displayName = filename || path.split(/[\\/]/).pop() || path || "file";
  const isImage = isImageReference(fileUrl) || isImageReference(path);
  // Only the thumbnail-bearing surface gets the tile chrome. A part that is
  // never eagerly loaded would otherwise sit as an empty card until clicked.
  const showThumbnailTile = isImage && eagerPreview;

  const loadImage = useCallback((): Promise<string | null> => {
    if (!isImage) return Promise.resolve(null);
    if (imageLoadRef.current) return imageLoadRef.current;

    const cached = readImagePreviewCache(cacheKey);
    if (cached) return Promise.resolve(cached);

    setLoading(true);
    setLoadError(false);
    const request = (async () => {
      try {
        if (fileUrl?.startsWith("data:image/")) {
          return fileUrl;
        }

        if (isRemoteImageUrl(fileUrl)) {
          return fileUrl ?? null;
        }

        const localFilePath = fileUrl?.startsWith("file://")
          ? parseLocalFilePathFromUrl(fileUrl)
          : null;

        if (containerId) {
          const containerPath = localFilePath ?? path;
          const relativePath = getSafeContainerRelativePath(containerPath);
          if (!relativePath) {
            throw new Error("Unsafe container image path");
          }

          const base64 = await readContainerFileBase64(containerId, relativePath);
          const mimeType = getMimeType(containerPath);
          const dataUrl = `data:${mimeType};base64,${base64}`;
          writeImagePreviewCache(cacheKey, dataUrl);
          return dataUrl;
        }

        const filePath = localFilePath ?? (path.startsWith("/") ? path : null);

        if (!filePath) {
          throw new Error("No readable local image path available");
        }

        const base64 = await readFileBase64(filePath);
        const mimeType = getMimeType(filePath);
        const dataUrl = `data:${mimeType};base64,${base64}`;
        writeImagePreviewCache(cacheKey, dataUrl);
        return dataUrl;
      } catch (err) {
        console.error("[NativeMessage] Failed to load image preview:", err, {
          path,
          fileUrl,
        });
        setLoadError(true);
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
  }, [cacheKey, isImage, path, fileUrl, containerId]);

  useEffect(() => {
    if (!eagerPreview || !isImage || imageSrc || isRemoteImageUrl(fileUrl)) return;
    let cancelled = false;

    void loadImage().then((source) => {
      if (!cancelled && source) setImageSrc(source);
    });

    return () => {
      cancelled = true;
    };
  }, [eagerPreview, fileUrl, imageSrc, isImage, loadImage]);

  const handleClick = useCallback(async () => {
    if (!isImage) return;
    if (imageSrc) {
      setPreviewOpen(true);
      return;
    }

    const source = await loadImage();
    if (!source) return;
    setImageSrc(source);
    setPreviewOpen(true);
  }, [imageSrc, isImage, loadImage]);

  const closePreview = useCallback(() => setPreviewOpen(false), []);

  return (
    <>
      <button
        onClick={handleClick}
        disabled={!isImage}
        aria-label={isImage ? `Open full image: ${displayName}` : undefined}
        aria-busy={isImage ? loading : undefined}
        className={cn(
          "text-xs my-0 rounded-md border transition-colors",
          showThumbnailTile
            ? "group relative block w-40 max-w-full shrink-0 overflow-hidden bg-muted/50 border-border hover:border-foreground/25 cursor-zoom-in"
            : "inline-flex items-center gap-1.5 py-1.5 px-2.5",
          !showThumbnailTile &&
            (isImage
              ? "bg-muted/50 border-border hover:bg-muted hover:border-border/80 cursor-zoom-in"
              : "bg-muted/30 border-border/50 cursor-default"),
          isImage &&
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          loading && "opacity-50",
        )}
      >
        {showThumbnailTile && imageSrc ? (
          <img
            src={imageSrc}
            alt={`Thumbnail: ${displayName}`}
            className="h-24 w-full bg-black/10 object-cover transition-transform duration-200 group-hover:scale-[1.02]"
          />
        ) : showThumbnailTile ? (
          <span className="flex h-24 w-full items-center justify-center bg-muted/40">
            <ImageIcon className="size-5 text-muted-foreground" />
          </span>
        ) : isImage ? (
          <ImageIcon className="w-3.5 h-3.5 text-muted-foreground" />
        ) : (
          <FileText className="w-3.5 h-3.5 text-muted-foreground" />
        )}
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
        {loading && !isImage && <span className="text-muted-foreground">(loading...)</span>}
        {loadError && (
          <span
            className={cn(
              "text-destructive text-[10px]",
              showThumbnailTile &&
                "absolute right-1.5 top-1.5 rounded bg-background/90 px-1.5 py-0.5",
            )}
          >
            preview unavailable
          </span>
        )}
      </button>

      {previewOpen && imageSrc && (
        <ImagePreviewOverlay imageSrc={imageSrc} filename={displayName} onClose={closePreview} />
      )}
    </>
  );
}

/** Render a text content part with markdown support */
export function TextPart({
  content,
  showCopy = true,
  truncateUserPrompt = false,
  renderJsonPayload = true,
  expansionKey,
}: {
  content: string;
  showCopy?: boolean;
  truncateUserPrompt?: boolean;
  /**
   * Fold a block that is nothing but JSON into a structured view. Off for the
   * user's own messages, which are shown back as written.
   */
  renderJsonPayload?: boolean;
  /** Stable identity used to persist the folded payload's expansion state. */
  expansionKey: string;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const lineCount = useMemo(() => content.split(/\r\n|\r|\n/).length, [content]);
  const shouldTruncate = truncateUserPrompt && lineCount > USER_PROMPT_COLLAPSED_LINE_COUNT;
  const jsonPayload = useMemo(
    () => (renderJsonPayload ? parseJsonPayload(content) : null),
    [content, renderJsonPayload],
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
        <MessageMarkdown content={content} components={markdownComponents} />
      </div>
      {shouldTruncate ? (
        <button
          type="button"
          className="mt-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          aria-expanded={isExpanded}
          onClick={() => setIsExpanded((current) => !current)}
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
