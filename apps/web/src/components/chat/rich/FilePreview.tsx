import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Download, FileSymlink, FileText, Play, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useOptionalTerminalContext } from "@/contexts/TerminalContext";
import { useTranscriptArtifactCapabilities } from "@/hooks/useTranscriptArtifactCapabilities";
import {
  closeTranscriptMediaStream,
  openTranscriptMediaStream,
} from "@/lib/backend/transcript-artifacts";
import { useRichTranscriptScope } from "@/lib/chat/rich-identity";
import { artifactFilename, base64ToBytes, downloadBase64 } from "@/lib/chat/artifact-download";
import {
  dataUrlByteLength,
  imageDimensionsFromDataUrl,
  INLINE_MEDIA_PLAYBACK_MAX_BYTES,
  MEDIA_PLACEHOLDER_ASPECT_RATIO,
  mediaLoadFailure,
  mediaStreamFailure,
  mediaStreamingAvailable,
  type MediaDimensions,
} from "@/lib/chat/media-presentation";
import {
  canResolveMedia,
  mediaStreamTarget,
  resolveMediaUrl,
  type MediaReference,
} from "@/lib/chat/rich-markdown/media-resolver";
import {
  base64ByteLength,
  base64Prefix,
  bytesMatchPreviewKind,
  dataUrlBase64,
  declaredMime,
  fileExtension,
  formatBytes,
  previewKindForMime,
  type FilePreviewKind,
} from "@/lib/chat/rich-markdown/media-types";
import {
  cacheToolDetails,
  cachedToolDetails,
  ToolDetailLoaderContext,
} from "@/components/chat/NativeMessage.shared";
import { cn } from "@/lib/utils";
import type { TranscriptMediaPdfPreviewRequest } from "@orkestrator/protocol/transcript-artifact-commands";
import { AgentPlatformContext } from "@/components/chat/NativeMessage.shared";
import { PdfFirstPagePreview, pdfPreviewSource } from "./PdfFirstPagePreview";

/** Text shown inline before a preview says "first N of M". */
const MAX_TEXT_PREVIEW_BYTES = 256 * 1024;
/** Rows shown in a CSV/TSV preview. */
const MAX_TABLE_PREVIEW_ROWS = 200;

const KIND_LABELS: Record<FilePreviewKind, string> = {
  image: "Image",
  svg: "SVG image",
  video: "Video",
  audio: "Audio",
  pdf: "PDF document",
  markdown: "Markdown",
  json: "JSON",
  csv: "CSV",
  tsv: "TSV",
  html: "HTML source",
  text: "Text",
  other: "File",
};

/** RFC 4180-style CSV (or TSV) rows, bounded. Never evaluates anything. */
export function parseDelimitedRows(
  text: string,
  delimiter: "," | "\t",
  maxRows: number,
): { rows: string[][]; totalRows: number } {
  const rows: string[][] = [];
  let totalRows = 0;
  let field = "";
  let row: string[] = [];
  let quoted = false;
  const pushRow = () => {
    row.push(field);
    field = "";
    if (!(row.length === 1 && row[0] === "")) {
      totalRows++;
      if (rows.length < maxRows) rows.push(row);
    }
    row = [];
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index++;
        } else quoted = false;
      } else field += char;
    } else if (char === '"' && field === "" && delimiter === ",") {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index++;
      pushRow();
    } else field += char;
  }
  if (field !== "" || row.length > 0) pushRow();
  return { rows, totalRows };
}

function decodeText(
  base64: string,
  limit: number,
): { text: string; truncated: boolean; total: number } {
  const total = base64ByteLength(base64);
  const bytes = base64Prefix(base64, Math.min(total, limit));
  return {
    text: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
    truncated: total > limit,
    total,
  };
}

type LoadFailure =
  | "no-bytes"
  | "unavailable"
  | "outside-workspace"
  | "denied"
  | "too-large"
  | "decode-failed"
  | "unsupported";

type Loaded =
  /** Audio/video: nothing is read until the user asks to load it. */
  | { status: "awaiting-activation" }
  | { status: "loading" }
  | { status: "failed"; failure: LoadFailure }
  | {
      status: "ready";
      url: string;
      base64: string | null;
      mime: string;
      size: number | null;
      /** The leading bytes contradict the declared type: download only. */
      mismatch: boolean;
      /** Audio/video above the inline playback bound: download only. */
      refused: boolean;
      /**
       * Audio/video source: a revocable blob URL for base64 bytes, or a
       * range-capable stream capability on the content origin.
       */
      mediaUrl: string | null;
      /** Set when `mediaUrl` is a stream capability (closed with the viewer). */
      streamId: string | null;
      /** Intrinsic image size from the header, reserved before decoding. */
      dimensions: MediaDimensions | null;
    };

const FAILURE_TEXT: Record<LoadFailure, string> = {
  "no-bytes": "This transcript does not carry the file's bytes.",
  unavailable:
    "The file is unavailable. It may have been moved or deleted, or its environment is not running.",
  "outside-workspace":
    "The file is outside previewable workspace storage. Local file previews are limited to Orkestrator-managed workspace storage or the container's /workspace. Project-home checkouts are excluded from host preview reads, even when they are the working directory.",
  denied: "Access to this file was denied. Orkestrator is not permitted to read it.",
  "too-large": "The file is larger than the backend's read limit, so it cannot be previewed.",
  "decode-failed": "The file's bytes could not be decoded.",
  unsupported:
    "The file's contents are not a playable audio or video type, so it is not previewed.",
};

function isPlayable(kind: FilePreviewKind): kind is "video" | "audio" {
  return kind === "video" || kind === "audio";
}

function playbackRefusal(kind: "video" | "audio", size: number): string {
  return `This ${kind === "video" ? "video" : "audio file"} is ${formatBytes(size)}, above the ${formatBytes(
    INLINE_MEDIA_PLAYBACK_MAX_BYTES,
  )} inline playback limit. Download the original to play it.`;
}

function PreviewBody({
  kind,
  loaded,
  name,
  onStreamUnreachable,
  onReload,
  pdfSource,
}: {
  kind: FilePreviewKind;
  loaded: Extract<Loaded, { status: "ready" }>;
  name: string;
  /** A stream that fails before its metadata loads: use the base64 path instead. */
  onStreamUnreachable?: () => void;
  /** Open a fresh stream after playback stopped (expiry, revocation). */
  onReload?: () => void;
  /** PDF only: where the backend may read the bytes for a first-page preview. */
  pdfSource?: TranscriptMediaPdfPreviewRequest | null;
}) {
  const base64 = loaded.base64;
  const mediaUrl = loaded.mediaUrl;
  const streamed = loaded.streamId !== null;
  const [elementFailed, setElementFailed] = useState(false);
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const metadataLoaded = useRef(false);
  // Destroying the viewer pauses playback; nothing else is cancelled.
  useEffect(() => {
    const element = mediaRef.current;
    metadataLoaded.current = false;
    return () => element?.pause();
  }, [mediaUrl]);
  const onMediaError = () => {
    if (streamed && !metadataLoaded.current && onStreamUnreachable) onStreamUnreachable();
    else setElementFailed(true);
  };

  const text = useMemo(() => {
    try {
      return base64 &&
        !isPlayable(kind) &&
        kind !== "image" &&
        kind !== "svg" &&
        kind !== "pdf" &&
        kind !== "other"
        ? decodeText(base64, MAX_TEXT_PREVIEW_BYTES)
        : null;
    } catch {
      // Undecodable bytes: fall through to the no-preview message.
      return null;
    }
  }, [base64, kind]);

  if (elementFailed && streamed && isPlayable(kind)) {
    return (
      <div
        role="status"
        className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground"
      >
        <span>
          Playback stopped: the {kind === "video" ? "video" : "audio"} could not be played or its
          stream is no longer available.
        </span>
        {onReload ? (
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-foreground hover:bg-muted"
            onClick={onReload}
          >
            <RotateCcw className="size-3.5" aria-hidden="true" />
            Load again
          </button>
        ) : null}
      </div>
    );
  }
  if (elementFailed) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {kind === "video"
          ? "This video could not be decoded or played."
          : kind === "audio"
            ? "This audio could not be decoded or played."
            : "This image could not be decoded."}{" "}
        Download the original to open it.
      </p>
    );
  }
  if (isPlayable(kind) && loaded.refused && loaded.size !== null) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {playbackRefusal(kind, loaded.size)}
      </p>
    );
  }
  if (kind === "video") {
    if (!mediaUrl) return null;
    return (
      <video
        ref={(element) => {
          mediaRef.current = element;
        }}
        controls
        preload="metadata"
        className="max-h-[60vh] w-full rounded-md bg-black"
        src={mediaUrl}
        aria-label={name}
        data-media-source={streamed ? "stream" : "inline"}
        onLoadedMetadata={() => (metadataLoaded.current = true)}
        onError={onMediaError}
      >
        <track kind="captions" />
      </video>
    );
  }
  if (kind === "audio") {
    return mediaUrl ? (
      <audio
        ref={(element) => {
          mediaRef.current = element;
        }}
        controls
        preload="metadata"
        className="w-full"
        src={mediaUrl}
        aria-label={name}
        data-media-source={streamed ? "stream" : "inline"}
        onLoadedMetadata={() => (metadataLoaded.current = true)}
        onError={onMediaError}
      />
    ) : null;
  }
  if (kind === "image" || kind === "svg") {
    // An SVG file stays an image resource: <img> never runs its scripts.
    const dimensions = loaded.dimensions;
    return (
      <img
        src={loaded.url}
        alt={name}
        referrerPolicy="no-referrer"
        width={dimensions?.width}
        height={dimensions?.height}
        style={{
          aspectRatio: dimensions
            ? `${dimensions.width} / ${dimensions.height}`
            : `auto ${MEDIA_PLACEHOLDER_ASPECT_RATIO}`,
        }}
        onError={() => setElementFailed(true)}
        className="mx-auto block h-auto max-h-[60vh] max-w-full object-contain"
      />
    );
  }
  if (kind === "pdf") return <PdfFirstPagePreview source={pdfSource ?? null} name={name} />;
  if (kind === "other" || !text) {
    return (
      <p className="text-sm text-muted-foreground">
        No inline preview is available for this file type. Download the original to open it.
      </p>
    );
  }
  const truncation = text.truncated ? (
    <p className="text-xs italic text-muted-foreground">
      Showing the first {formatBytes(MAX_TEXT_PREVIEW_BYTES)} of {formatBytes(text.total)}.
    </p>
  ) : null;
  if (kind === "json") {
    let shown = text.text;
    if (!text.truncated) {
      try {
        shown = JSON.stringify(JSON.parse(text.text), null, 2);
      } catch {
        // Not a single JSON document (or JSON Lines): show it as written.
      }
    }
    return (
      <>
        {truncation}
        <pre className="max-h-[60vh] overflow-auto whitespace-pre rounded-md bg-muted/40 p-3 font-mono text-xs">
          {shown}
        </pre>
      </>
    );
  }
  if (kind === "csv" || kind === "tsv") {
    const { rows, totalRows } = parseDelimitedRows(
      text.text,
      kind === "csv" ? "," : "\t",
      MAX_TABLE_PREVIEW_ROWS,
    );
    const [header, ...body] = rows;
    return (
      <>
        <p className="text-xs text-muted-foreground">
          {text.truncated ? "At least " : ""}
          {totalRows} {totalRows === 1 ? "row" : "rows"}
          {rows.length < totalRows ? ` · showing the first ${rows.length}` : ""}
        </p>
        {truncation}
        <div className="max-h-[60vh] overflow-auto rounded-md border border-border">
          <table className="w-max min-w-full border-collapse text-xs">
            {header ? (
              <thead>
                <tr>
                  {header.map((cell, index) => (
                    <th
                      key={index}
                      className="sticky top-0 bg-background px-2 py-1 text-left font-semibold"
                    >
                      {cell}
                    </th>
                  ))}
                </tr>
              </thead>
            ) : null}
            <tbody>
              {body.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, index) => (
                    <td
                      key={index}
                      className="border-t border-border/60 px-2 py-1 align-top whitespace-pre"
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>
    );
  }
  return (
    <>
      {kind === "html" ? (
        <p className="text-xs text-muted-foreground">
          HTML attachments are shown as source only. Opening a file never runs it.
        </p>
      ) : null}
      {truncation}
      <pre
        aria-label={`${name} contents`}
        className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 font-mono text-xs"
      >
        {text.text}
      </pre>
    </>
  );
}

/**
 * A non-image file attachment: a compact row that opens a MIME-aware preview.
 * Nothing is read until the preview opens. Video/audio are not read even
 * then: the dialog shows metadata and a Load video/Load audio action, and only
 * that explicit activation reads the bytes. When the backend offers a
 * reachable content origin, an environment file then plays from a short-lived
 * range-capable stream capability (`transcript_media_open_stream`; no 8 MiB
 * bound, the backend's own maximum applies), revoked when the viewer closes;
 * otherwise, or when the stream cannot be opened or reached, the bounded
 * base64 read is used. On that path assets above
 * `INLINE_MEDIA_PLAYBACK_MAX_BYTES` are refused for playback (never decoded
 * into a blob) and offered as a download. Players use native controls with
 * metadata-only preload, never autoplay, and pause when destroyed. Images (SVG included) render
 * as `<img>` with the header's dimensions reserved; PDF, office and unknown
 * binaries get metadata and the original download; HTML is source only. Read
 * failures say whether the file is unavailable, access was denied, it is too
 * large, or its bytes could not be decoded.
 */
export function FilePreview({
  reference,
  name,
  icon,
}: {
  reference: MediaReference;
  name: string;
  icon?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const mime = declaredMime(reference.path, reference.fileUrl);
  const kind = previewKindForMime(mime);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Preview file: ${name} (${KIND_LABELS[kind]})`}
        className="my-0 inline-flex items-center gap-1.5 rounded-md border border-border/50 bg-muted/30 px-2.5 py-1.5 text-xs transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {icon ?? <FileText className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />}
        <span className="max-w-[240px] truncate font-mono text-muted-foreground">{name}</span>
      </button>
      {open ? (
        <FilePreviewDialog
          reference={reference}
          name={name}
          kind={kind}
          mime={mime}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function FilePreviewDialog({
  reference,
  name,
  kind,
  mime,
  onClose,
}: {
  reference: MediaReference;
  name: string;
  kind: FilePreviewKind;
  mime: string;
  onClose: () => void;
}) {
  const loadToolDetails = useContext(ToolDetailLoaderContext);
  const createFileTab = useOptionalTerminalContext()?.createFileTab ?? null;
  const playable = isPlayable(kind);
  // Bytes the transcript already holds inline (a data URL): known size, and a
  // download needs no read.
  const inlineBase64 = reference.fileUrl?.startsWith("data:")
    ? dataUrlBase64(reference.fileUrl)
    : null;
  const inlineSize = dataUrlByteLength(reference.fileUrl);
  const [loaded, setLoaded] = useState<Loaded>(() =>
    !(canResolveMedia(reference) || (reference.detailRef && loadToolDetails))
      ? { status: "failed", failure: reference.containerId ? "outside-workspace" : "no-bytes" }
      : playable
        ? { status: "awaiting-activation" }
        : { status: "loading" },
  );
  // Audio/video stream from the content origin with ranged reads when the
  // backend offers one this renderer can reach; otherwise (or when the stream
  // cannot be opened or reached) the bounded base64 read below is used.
  const contentOrigin = useTranscriptArtifactCapabilities()?.contentOrigin ?? null;
  const richScope = useRichTranscriptScope();
  const scopeEnvironmentId = richScope?.environmentId;
  const agentPlatform = useContext(AgentPlatformContext);
  const pdfSource = useMemo(
    () =>
      kind === "pdf" && richScope && richScope.environmentId !== "detached"
        ? pdfPreviewSource(reference, {
            environmentId: richScope.environmentId,
            logicalSessionKey: richScope.logicalSessionKey,
            ...(agentPlatform ? { agent: agentPlatform } : {}),
          })
        : null,
    [agentPlatform, kind, reference, richScope],
  );
  const environmentId =
    scopeEnvironmentId && scopeEnvironmentId !== "detached" ? scopeEnvironmentId : null;
  const { path: referencePath, fileUrl, containerId, detailRef } = reference;
  const streamTarget = useMemo(
    () =>
      playable ? mediaStreamTarget({ path: referencePath, fileUrl, containerId, detailRef }) : null,
    [containerId, detailRef, fileUrl, playable, referencePath],
  );
  const [streamFallback, setStreamFallback] = useState(false);
  const streamable =
    !streamFallback &&
    streamTarget !== null &&
    environmentId !== null &&
    typeof window !== "undefined" &&
    mediaStreamingAvailable(contentOrigin, window.location);

  useEffect(() => {
    if (loaded.status !== "loading" || !streamable) return;
    let cancelled = false;
    openTranscriptMediaStream({ environmentId: environmentId!, ...streamTarget! }).then(
      (stream) => {
        const streamedKind = previewKindForMime(stream.mimeType);
        const playableBytes = streamedKind === "video" || streamedKind === "audio";
        if (cancelled || !playableBytes) {
          void closeTranscriptMediaStream({ streamId: stream.streamId }).catch(() => undefined);
        }
        if (cancelled) return;
        setLoaded({
          status: "ready",
          url: stream.url,
          base64: null,
          mime: stream.mimeType,
          size: stream.byteLength,
          mismatch: !playableBytes,
          refused: false,
          mediaUrl: playableBytes ? stream.url : null,
          streamId: playableBytes ? stream.streamId : null,
          dimensions: null,
        });
      },
      (error: unknown) => {
        if (cancelled) return;
        const outcome = mediaStreamFailure(error);
        // No reachable content origin (or an older backend): read the bounded base64 copy.
        if (outcome === "fallback") setStreamFallback(true);
        else setLoaded({ status: "failed", failure: outcome });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [environmentId, loaded.status, streamTarget, streamable]);

  useEffect(() => {
    if (loaded.status !== "loading" || streamable) return;
    let cancelled = false;
    resolveMediaUrl(reference, {
      loadToolDetails,
      detailCache: { read: cachedToolDetails, write: cacheToolDetails },
    }).then(
      (url) => {
        if (cancelled) return;
        if (!url) {
          setLoaded({ status: "failed", failure: "unavailable" });
          return;
        }
        const base64 = url.startsWith("data:") ? dataUrlBase64(url) : null;
        const size = base64 ? base64ByteLength(base64) : null;
        const refused = playable && size !== null && size > INLINE_MEDIA_PLAYBACK_MAX_BYTES;
        let mismatch: boolean;
        let mediaUrl: string | null;
        try {
          mismatch = base64 !== null && !bytesMatchPreviewKind(kind, base64Prefix(base64, 8192));
          // Above the playback bound the bytes are never decoded into a blob.
          mediaUrl =
            base64 && !mismatch && !refused && playable
              ? URL.createObjectURL(
                  new Blob([base64ToBytes(base64).buffer as ArrayBuffer], { type: mime }),
                )
              : null;
        } catch {
          setLoaded({ status: "failed", failure: "decode-failed" });
          return;
        }
        setLoaded({
          status: "ready",
          url,
          base64,
          mime,
          size,
          mismatch,
          refused,
          mediaUrl,
          streamId: null,
          dimensions: kind === "image" ? imageDimensionsFromDataUrl(url) : null,
        });
      },
      (error: unknown) => {
        if (!cancelled) setLoaded({ status: "failed", failure: mediaLoadFailure(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [kind, loadToolDetails, loaded.status, mime, playable, reference, streamable]);

  const mismatch = loaded.status === "ready" && loaded.mismatch;
  const mediaUrl = loaded.status === "ready" ? loaded.mediaUrl : null;
  const streamId = loaded.status === "ready" ? loaded.streamId : null;
  // Closing the preview releases the media bytes (and stops playback).
  useEffect(() => {
    if (!mediaUrl?.startsWith("blob:")) return;
    return () => URL.revokeObjectURL(mediaUrl);
  }, [mediaUrl]);
  // Closing the preview (or replacing the stream) revokes its capability; the
  // file, the environment and any agent work are untouched.
  useEffect(() => {
    if (!streamId) return;
    return () => {
      void closeTranscriptMediaStream({ streamId }).catch(() => undefined);
    };
  }, [streamId]);
  // A streamed asset small enough for the inline bound can still be
  // downloaded: the bytes are read only when asked for.
  const lazyDownload =
    streamId !== null &&
    loaded.status === "ready" &&
    loaded.size !== null &&
    loaded.size <= INLINE_MEDIA_PLAYBACK_MAX_BYTES;
  const workspacePath =
    !reference.fileUrl?.startsWith("data:") && !/^https?:/i.test(reference.fileUrl ?? "")
      ? reference.path
      : null;
  const downloadable = loaded.status === "ready" && loaded.base64 ? loaded.base64 : inlineBase64;
  const knownSize = loaded.status === "ready" && loaded.size !== null ? loaded.size : inlineSize;
  // Inline bytes already over the bound: refuse before anything is decoded.
  const refusedBeforeLoad =
    playable &&
    loaded.status === "awaiting-activation" &&
    inlineSize !== null &&
    inlineSize > INLINE_MEDIA_PLAYBACK_MAX_BYTES;
  const mediaNoun = kind === "video" ? "video" : "audio";

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent
        size="full"
        className="flex max-h-[85vh] w-[min(64rem,calc(100vw-2rem))] flex-col gap-3"
      >
        <DialogHeader>
          <DialogTitle className="truncate font-mono text-sm">{name}</DialogTitle>
          <DialogDescription>
            {KIND_LABELS[kind]} · {mime}
            {knownSize !== null ? ` · ${formatBytes(knownSize)}` : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2" role="toolbar" aria-label="File actions">
          {playable && loaded.status === "awaiting-activation" && !refusedBeforeLoad ? (
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
              onClick={() => setLoaded({ status: "loading" })}
            >
              <Play className="size-3.5" aria-hidden="true" />
              {kind === "video" ? "Load video" : "Load audio"}
            </button>
          ) : null}
          {downloadable || lazyDownload ? (
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
              onClick={async () => {
                const extension = fileExtension(name) || "bin";
                let bytes = downloadable;
                if (!bytes) {
                  try {
                    bytes = dataUrlBase64(await resolveMediaUrl(reference, { loadToolDetails }));
                  } catch {
                    bytes = null;
                  }
                }
                if (!bytes) {
                  toast.error("Could not read the original file");
                  return;
                }
                downloadBase64(
                  bytes,
                  artifactFilename(name.replace(/\.[^.]+$/, ""), extension),
                  mime,
                );
              }}
            >
              <Download className="size-3.5" aria-hidden="true" />
              Download original
            </button>
          ) : null}
          {workspacePath && createFileTab && !playable ? (
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
              onClick={() => {
                createFileTab(workspacePath);
                onClose();
              }}
              title="Opens the current workspace file, which may differ from this attachment"
            >
              <FileSymlink className="size-3.5" aria-hidden="true" />
              Open current workspace file
            </button>
          ) : null}
        </div>
        <div className={cn("min-h-0 flex-1 overflow-auto")}>
          {refusedBeforeLoad && inlineSize !== null ? (
            <p role="status" className="text-sm text-muted-foreground">
              {playbackRefusal(kind as "video" | "audio", inlineSize)}
            </p>
          ) : loaded.status === "awaiting-activation" ? (
            <p className="text-sm text-muted-foreground">
              The {mediaNoun} is not loaded until you choose Load {mediaNoun}. It never plays
              automatically.
            </p>
          ) : loaded.status === "loading" ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading preview…
            </p>
          ) : loaded.status === "failed" ? (
            <p
              role="status"
              data-media-state={loaded.failure}
              className="text-sm text-muted-foreground"
            >
              {FAILURE_TEXT[loaded.failure]}
            </p>
          ) : mismatch ? (
            <p
              role="status"
              data-media-state="unsupported"
              className="text-sm text-muted-foreground"
            >
              The file's contents do not match its {KIND_LABELS[kind]} type, so it is not previewed.
              Download the original to inspect it.
            </p>
          ) : (
            <PreviewBody
              kind={kind}
              loaded={loaded}
              name={name}
              onStreamUnreachable={() => {
                // The content origin is not reachable from this renderer.
                setStreamFallback(true);
                setLoaded({ status: "loading" });
              }}
              onReload={() => setLoaded({ status: "loading" })}
              pdfSource={pdfSource}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
