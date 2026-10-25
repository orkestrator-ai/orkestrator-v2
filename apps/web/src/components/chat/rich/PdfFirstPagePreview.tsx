import { useEffect, useState } from "react";
import { PDF_POLICY } from "@orkestrator/protocol/rich-content-policy";
import type {
  TranscriptMediaPdfPreviewRequest,
  TranscriptMediaPdfPreviewResponse,
} from "@orkestrator/protocol/transcript-artifact-commands";
import { getTranscriptMediaPdfPreview } from "@/lib/backend/transcript-artifacts";
import { artifactErrorInfo } from "@/lib/chat/artifact-requests";
import { mediaStreamTarget, type MediaReference } from "@/lib/chat/rich-markdown/media-resolver";

/**
 * Where the backend may read a PDF attachment from: the same confined host or
 * container path the attachment row reads, or this conversation's deferred
 * tool detail. Inline-only bytes have no backend source (metadata only).
 */
export function pdfPreviewSource(
  reference: MediaReference,
  scope: { environmentId: string; logicalSessionKey: string; agent?: string } | null,
): TranscriptMediaPdfPreviewRequest | null {
  if (!scope) return null;
  const target = mediaStreamTarget(reference);
  if (target) return { environmentId: scope.environmentId, source: target };
  if (reference.detailRef && scope.agent)
    return {
      environmentId: scope.environmentId,
      source: {
        detailRef: reference.detailRef,
        agent: scope.agent,
        logicalSessionKey: scope.logicalSessionKey,
      },
    };
  return null;
}

type State =
  | { status: "loading" }
  | { status: "done"; response: TranscriptMediaPdfPreviewResponse }
  | { status: "error"; message: string };

const MIB = 1024 * 1024;

function refusalText(response: TranscriptMediaPdfPreviewResponse): string {
  switch (response.reason) {
    case "page-limit":
      return `This PDF has ${response.pageCount ?? "more than " + PDF_POLICY.maxPages} pages; first-page previews stop at ${PDF_POLICY.maxPages}.`;
    case "byte-limit":
      return `This PDF is larger than the ${PDF_POLICY.maxBytes / MIB} MiB preview limit.`;
    case "encrypted":
      return "This PDF is password protected, so no page is previewed.";
    case "not-pdf":
      return "The file's contents are not a PDF document.";
    default:
      return "This PDF could not be opened for a preview.";
  }
}

/**
 * First page of a PDF attachment as a static image, rendered by the backend's
 * isolated, network-denied preview worker (pinned pdf.js; no PDF scripts, no
 * forms, no browser PDF plugin). Shows the page count; anything over the page
 * or byte ceiling, or a host without the worker, gets metadata only. The
 * dialog's "Download original" stays the way to open the full document.
 */
export function PdfFirstPagePreview({
  source,
  name,
}: {
  source: TranscriptMediaPdfPreviewRequest | null;
  name: string;
}) {
  const key = source ? JSON.stringify(source) : null;
  // Results are tagged with the request they answer; another request reads as loading.
  const [settled, setSettled] = useState<{ key: string; state: State } | null>(null);
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    getTranscriptMediaPdfPreview(JSON.parse(key) as TranscriptMediaPdfPreviewRequest).then(
      (response) => {
        if (!cancelled) setSettled({ key, state: { status: "done", response } });
      },
      (error: unknown) => {
        if (!cancelled)
          setSettled({
            key,
            state: { status: "error", message: artifactErrorInfo(error).message },
          });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key]);
  const state: State = settled && settled.key === key ? settled.state : { status: "loading" };

  const fallback = "Download the original to open the full document in your PDF viewer.";
  if (!source) {
    return (
      <p className="text-sm text-muted-foreground" data-pdf-preview="no-source">
        No first-page preview is available for this attachment. {fallback}
      </p>
    );
  }
  if (state.status === "loading") {
    return (
      <p role="status" className="text-sm text-muted-foreground" data-pdf-preview="loading">
        Rendering the first page in the isolated preview worker…
      </p>
    );
  }
  if (state.status === "error") {
    return (
      <p role="status" className="text-sm text-muted-foreground" data-pdf-preview="error">
        The first page could not be previewed ({state.message}). {fallback}
      </p>
    );
  }
  const { response } = state;
  const pages =
    response.pageCount !== null
      ? `${response.pageCount} page${response.pageCount === 1 ? "" : "s"}`
      : null;
  if (response.status === "ready" && response.thumbnail) {
    const { thumbnail } = response;
    return (
      <figure className="flex flex-col items-center gap-2" data-pdf-preview="ready">
        <img
          src={`data:image/png;base64,${thumbnail.dataBase64}`}
          alt={`First page of ${name}`}
          width={thumbnail.width}
          height={thumbnail.height}
          style={{ aspectRatio: `${thumbnail.width} / ${thumbnail.height}` }}
          className="h-auto max-h-[60vh] max-w-full rounded border border-border bg-white object-contain"
        />
        <figcaption className="text-xs text-muted-foreground">
          Page 1{response.pageCount !== null ? ` of ${response.pageCount}` : ""} · static preview
          rendered in isolation. {fallback}
        </figcaption>
      </figure>
    );
  }
  return (
    <p
      role="status"
      className="text-sm text-muted-foreground"
      data-pdf-preview={response.status}
      data-pdf-preview-reason={response.reason}
    >
      {response.status === "refused"
        ? refusalText(response)
        : `No first-page preview: ${response.message ?? "the preview worker is unavailable on this host"}.`}
      {pages && response.reason !== "page-limit" ? ` (${pages})` : ""} {fallback}
    </p>
  );
}
