import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import {
  WEB_ANNOTATION_LIMITS,
  WEB_ANNOTATION_REQUEST_STATE_LABELS,
  webAnnotationUtf8Bytes,
  type WebAnnotationCapture,
  type WebAnnotationRequestOperation,
  type WebAnnotationSummary,
} from "@orkestrator/protocol/web-annotations";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useWebAnnotationCache } from "@/hooks/useWebAnnotations";
import { loadWebAnnotationCapture } from "@/lib/web-annotations/assets";
import { annotationTitle, formatBytes, pageLabel, viewportLabel } from "./format";
import { useAnnotationPanel } from "./panel-context";
import { RequestComposer } from "./RequestComposer";

function viewportText(capture: WebAnnotationCapture | undefined): string {
  const label = viewportLabel(capture?.geometry?.viewport);
  return label ? ` · ${label}` : "";
}

/** Evidence state of one tray item, from its capture record (never its image). */
export function evidenceState(
  item: Pick<WebAnnotationSummary, "targetKind" | "unavailable">,
  capture: WebAnnotationCapture | undefined,
): string {
  if (item.targetKind === "legacy-unresolved") return "Evidence: imported (not current)";
  if (item.unavailable) return "Evidence: partly unavailable";
  if (!capture) return "Evidence: loading…";
  const image = capture.redaction.imageExcluded
    ? "image excluded"
    : capture.assetIds.length > 0
      ? `${capture.assetIds.length} image${capture.assetIds.length === 1 ? "" : "s"}`
      : "no image";
  if (capture.state === "stale") return `Evidence: stale capture, ${image}`;
  if (capture.state === "missing") return "Evidence: missing";
  return `Evidence: current, ${image}`;
}

/**
 * Remaining capacity of the batch, in stable order: the first item whose
 * images would exceed the attachment limit is named. Image bytes are known
 * only for assets already read (the tray never fetches images) and note text
 * is estimated from the latest intent and desired outcome; the backend checks
 * both exactly on preparation.
 */
export function batchEvidenceBudget(
  items: Array<{
    id: string;
    capture: WebAnnotationCapture | undefined;
    /** UTF-8 bytes of this item's host text (latest intent + desired outcome). */
    textBytes?: number;
  }>,
  assetBytes: (assetId: string) => number | undefined = () => undefined,
) {
  let images = 0;
  let unknown = 0;
  let imageBytes = 0;
  let unknownImageBytes = 0;
  let textBytes = 0;
  let overflowId: string | null = null;
  for (const item of items) {
    textBytes += item.textBytes ?? 0;
    if (!item.capture) {
      unknown += 1;
      continue;
    }
    const assets = item.capture.redaction.imageExcluded ? [] : item.capture.assetIds;
    if (!overflowId && images + assets.length > WEB_ANNOTATION_LIMITS.briefAttachments)
      overflowId = item.id;
    images += assets.length;
    for (const assetId of assets) {
      const bytes = assetBytes(assetId);
      if (typeof bytes === "number") imageBytes += bytes;
      else unknownImageBytes += 1;
    }
  }
  return { images, unknown, overflowId, imageBytes, unknownImageBytes, textBytes };
}

/**
 * Review tray for a batch request. Excluding an item only changes this unsent
 * batch; it never deletes the note, its thread, or its evidence.
 */
export function BatchReviewTray({
  selection,
  limit,
  onDeselect,
  onClear,
  overflow,
}: {
  selection: ReadonlyMap<string, WebAnnotationSummary>;
  limit: number;
  onDeselect: (annotationId: string) => void;
  onClear: () => void;
  /** Title of the item that could not be added because the batch is full. */
  overflow: string | null;
}) {
  const { environmentId, features } = useAnnotationPanel();
  const cache = useWebAnnotationCache(environmentId);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [outcomes, setOutcomes] = useState<Map<string, string>>(new Map());
  const [composer, setComposer] = useState<WebAnnotationRequestOperation | null>(null);

  // Use the freshest summary when the list has refetched since selection.
  const items = Array.from(selection.values()).map((item) => cache.summaries.get(item.id) ?? item);
  const included = items.filter((item) => !excluded.has(item.id));
  const remaining = Math.max(0, limit - included.length);
  const captureKey = items.map((item) => item.currentCaptureId).join("|");
  const itemsRef = useRef(items);
  itemsRef.current = items;
  useEffect(() => {
    // Small capture records only; images are never fetched for the tray.
    for (const item of itemsRef.current) {
      void loadWebAnnotationCapture(environmentId, item.currentCaptureId);
    }
  }, [captureKey, environmentId]);
  const budget = batchEvidenceBudget(
    included.map((item) => ({
      id: item.id,
      capture: cache.captures.get(item.currentCaptureId),
      textBytes:
        webAnnotationUtf8Bytes(item.latestIntent ?? "") +
        webAnnotationUtf8Bytes(outcomes.get(item.id) ?? ""),
    })),
    (assetId) => cache.assets.get(assetId)?.bytes,
  );
  const imageBytesLeft = Math.max(
    0,
    WEB_ANNOTATION_LIMITS.briefAttachmentBytes - budget.imageBytes,
  );
  const textBytesLeft = Math.max(0, WEB_ANNOTATION_LIMITS.briefBytes - budget.textBytes);

  return (
    <section
      aria-label="Batch review"
      className="space-y-1.5 border-t border-border/70 p-3 text-[11px]"
    >
      <div className="flex items-center justify-between">
        <span className="font-medium">
          {included.length} of {items.length} selected note{items.length === 1 ? "" : "s"} included
          · {remaining} more allowed (max {limit})
        </span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-[11px]"
          onClick={onClear}
        >
          Clear selection
        </Button>
      </div>
      <p className="text-muted-foreground" data-batch-capacity>
        Images: {budget.images} of {WEB_ANNOTATION_LIMITS.briefAttachments} (
        {Math.max(0, WEB_ANNOTATION_LIMITS.briefAttachments - budget.images)} left)
        {budget.unknown > 0 ? ` · ${budget.unknown} still loading` : ""}
      </p>
      <p className="text-muted-foreground" data-batch-bytes>
        Image data: {formatBytes(budget.imageBytes)} of{" "}
        {formatBytes(WEB_ANNOTATION_LIMITS.briefAttachmentBytes)} ({formatBytes(imageBytesLeft)}{" "}
        left
        {budget.unknownImageBytes > 0
          ? `; ${budget.unknownImageBytes} image${budget.unknownImageBytes === 1 ? "" : "s"} not measured yet`
          : ""}
        ) · note text about {formatBytes(budget.textBytes)} of{" "}
        {formatBytes(WEB_ANNOTATION_LIMITS.briefBytes)} ({formatBytes(textBytesLeft)} left). The
        exact brief size is checked when the request is prepared.
      </p>
      {budget.overflowId && (
        <p role="alert" className="text-amber-200">
          “{annotationTitle(items.find((item) => item.id === budget.overflowId) ?? items[0]!)}”
          would exceed the {WEB_ANNOTATION_LIMITS.briefAttachments}-image limit. Exclude it or send
          it separately, or send text only.
        </p>
      )}
      {overflow && (
        <p role="alert" className="text-amber-200">
          “{overflow}” was not added: a request can include at most {limit} notes.
        </p>
      )}
      <ul className="max-h-60 space-y-1 overflow-y-auto">
        {items.map((item, index) => {
          const isExcluded = excluded.has(item.id);
          return (
            <li
              key={item.id}
              className="space-y-1 rounded border border-border/60 p-1.5"
              data-tray-item={item.id}
            >
              <div className="flex items-start gap-1.5">
                <span className="text-muted-foreground">#{index + 1}</span>
                <div className="min-w-0 flex-1">
                  <div
                    className={
                      isExcluded ? "truncate line-through opacity-60" : "truncate font-medium"
                    }
                  >
                    {annotationTitle(item)}
                  </div>
                  <div className="truncate text-muted-foreground">
                    {pageLabel(item.page)}
                    {viewportText(cache.captures.get(item.currentCaptureId))}
                  </div>
                  <div className="text-muted-foreground" data-evidence-state={item.id}>
                    {evidenceState(item, cache.captures.get(item.currentCaptureId))}
                  </div>
                  {item.latestIntent && (
                    <div className="line-clamp-2 text-muted-foreground">“{item.latestIntent}”</div>
                  )}
                  {item.targetKind === "legacy-unresolved" && (
                    <div className="text-amber-200">Imported evidence (not current)</div>
                  )}
                  {item.activeRequest && (
                    <div className="text-amber-200">
                      Active request:{" "}
                      {WEB_ANNOTATION_REQUEST_STATE_LABELS[item.activeRequest.state]}
                    </div>
                  )}
                </div>
                <label className="flex items-center gap-1 whitespace-nowrap">
                  <input
                    type="checkbox"
                    checked={!isExcluded}
                    onChange={(event) => {
                      const next = new Set(excluded);
                      if (event.target.checked) next.delete(item.id);
                      else next.add(item.id);
                      setExcluded(next);
                    }}
                    aria-label={`Include “${annotationTitle(item)}” in this request`}
                  />
                  Include
                </label>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-5 w-5"
                  aria-label={`Remove “${annotationTitle(item)}” from the selection`}
                  onClick={() => onDeselect(item.id)}
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
              {!isExcluded && (
                <Textarea
                  value={outcomes.get(item.id) ?? ""}
                  onChange={(event) => {
                    const next = new Map(outcomes);
                    next.set(
                      item.id,
                      event.target.value.slice(0, WEB_ANNOTATION_LIMITS.desiredOutcomeChars),
                    );
                    setOutcomes(next);
                  }}
                  rows={1}
                  aria-label={`Desired outcome for “${annotationTitle(item)}”`}
                  placeholder="Desired outcome (optional)"
                  className="min-h-7 text-[11px]"
                />
              )}
            </li>
          );
        })}
      </ul>
      {composer ? (
        <RequestComposer
          items={included.map((item) => ({
            annotation: item,
            desiredOutcome: outcomes.get(item.id),
          }))}
          initialOperation={composer}
          onClose={() => setComposer(null)}
          onSent={() => {
            setComposer(null);
            onClear();
          }}
        />
      ) : (
        features.dispatch && (
          <div className="flex flex-wrap gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              disabled={included.length === 0 || included.length > limit}
              onClick={() => setComposer("discuss")}
            >
              Discuss selected…
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              disabled={included.length === 0 || included.length > limit}
              onClick={() => setComposer("implement")}
            >
              Request changes for selected…
            </Button>
          </div>
        )
      )}
    </section>
  );
}
