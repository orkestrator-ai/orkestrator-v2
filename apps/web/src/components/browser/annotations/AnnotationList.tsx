import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import {
  WEB_ANNOTATION_REQUEST_STATE_LABELS,
  type WebAnnotationSummary,
} from "@orkestrator/protocol/web-annotations";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useWebAnnotationCache, useWebAnnotationList } from "@/hooks/useWebAnnotations";
import { loadWebAnnotationCapture } from "@/lib/web-annotations/assets";
import { cn } from "@/lib/utils";
import type { ListQuery } from "@/stores/webAnnotationStore";
import type { BrowserAnnotationPanelFilter } from "@/types/paneLayout";
import {
  anchorStateLabel,
  annotationStateLabel,
  annotationTitle,
  lastActivity,
  pageLabel,
  TARGET_KIND_LABELS,
  viewportLabel,
  type CurrentAnnotationPage,
} from "./format";
import { useAnnotationPanel } from "./panel-context";

export const ANNOTATION_PAGE_SIZE = 20;

export const DEFAULT_ANNOTATION_FILTER: BrowserAnnotationPanelFilter = Object.freeze({
  scope: "page",
  state: "open",
});

/** Selection persists across pagination and filters by id. */
export type AnnotationSelection = ReadonlyMap<string, WebAnnotationSummary>;

export function listQueryFor(
  filter: BrowserAnnotationPanelFilter,
  currentPage: CurrentAnnotationPage | null,
  cursor: string | null,
): ListQuery | null {
  if (filter.scope === "page" && !currentPage) return null;
  return {
    filter: {
      ...(filter.scope === "page" && currentPage ? { pageKey: currentPage.pageKey } : {}),
      state: filter.state,
      ...(filter.destinationTabId ? { destinationTabId: filter.destinationTabId } : {}),
      ...(filter.importedOnly ? { importedOnly: true } : {}),
      ...(filter.includeArchived ? { includeArchived: true } : {}),
    },
    cursor,
    limit: ANNOTATION_PAGE_SIZE,
  };
}

function destinationLabel(summary: WebAnnotationSummary): string | null {
  const destination = summary.activeRequest?.destination ?? summary.defaultDestination;
  if (!destination) return null;
  return destination.label ?? destination.agent;
}

export function AnnotationList({
  environmentId,
  currentPage,
  filter,
  onFilterChange,
  selection,
  onToggleSelection,
  selectionLimit,
  onOpen,
  canSelect,
}: {
  environmentId: string;
  currentPage: CurrentAnnotationPage | null;
  filter: BrowserAnnotationPanelFilter;
  onFilterChange: (filter: BrowserAnnotationPanelFilter) => void;
  selection: AnnotationSelection;
  onToggleSelection: (summary: WebAnnotationSummary, selected: boolean) => void;
  selectionLimit: number;
  onOpen: (annotationId: string) => void;
  canSelect: boolean;
}) {
  // Cursor stack: index 0 is the first page.
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const filterKey = JSON.stringify(filter);
  const pageKey = currentPage?.pageKey ?? null;
  useEffect(() => setCursors([null]), [filterKey, pageKey]);
  const cursor = cursors[cursors.length - 1] ?? null;
  // Registration is keyed by the query's value, so a new object per render is fine.
  const query = listQueryFor(filter, currentPage, cursor);
  const { state, items } = useWebAnnotationList(environmentId, query);
  const cache = useWebAnnotationCache(environmentId);
  const { pinResults } = useAnnotationPanel();

  // A cursor from an older snapshot can be rejected: sync has already
  // refetched page one, so restart there.
  useEffect(() => {
    if (state?.status === "error" && state.error === "stale-cursor") setCursors([null]);
  }, [state?.error, state?.status]);

  // Viewport labels come from the small capture records (never images),
  // loaded for the visible page only; rows render without waiting for them.
  const captureKey = items.map((item) => item.currentCaptureId).join("|");
  const itemsRef = useRef(items);
  itemsRef.current = items;
  useEffect(() => {
    // Keyed by the visible capture ids, not the (per-render) item array.
    for (const item of itemsRef.current) {
      void loadWebAnnotationCapture(environmentId, item.currentCaptureId);
    }
  }, [captureKey, environmentId]);

  const destinations = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of items) {
      const destination = item.activeRequest?.destination ?? item.defaultDestination;
      if (destination) map.set(destination.tabId, destination.label ?? destination.agent);
    }
    if (filter.destinationTabId && !map.has(filter.destinationTabId)) {
      map.set(filter.destinationTabId, "Selected session");
    }
    return Array.from(map);
  }, [filter.destinationTabId, items]);

  const visibleIds = new Set(items.map((item) => item.id));
  const hiddenSelected = Array.from(selection.keys()).filter((id) => !visibleIds.has(id)).length;
  const pageNumber = cursors.length;
  const total = state?.total ?? 0;
  const firstIndex = (pageNumber - 1) * ANNOTATION_PAGE_SIZE;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border/70 px-3 py-2 text-[11px]">
        <label className="flex items-center gap-1">
          <span className="sr-only">Pages</span>
          <select
            aria-label="Pages"
            className="h-6 rounded border border-border/70 bg-input-surface px-1"
            value={filter.scope}
            onChange={(event) =>
              onFilterChange({ ...filter, scope: event.target.value === "all" ? "all" : "page" })
            }
          >
            <option value="page">This page</option>
            <option value="all">All pages</option>
          </select>
        </label>
        <select
          aria-label="Status"
          className="h-6 rounded border border-border/70 bg-input-surface px-1"
          value={filter.state}
          onChange={(event) =>
            onFilterChange({
              ...filter,
              state: event.target.value as BrowserAnnotationPanelFilter["state"],
            })
          }
        >
          <option value="open">Open</option>
          <option value="resolved">Resolved</option>
          <option value="all">All states</option>
        </select>
        <select
          aria-label="Destination"
          className="h-6 max-w-32 rounded border border-border/70 bg-input-surface px-1"
          value={filter.destinationTabId ?? ""}
          onChange={(event) =>
            onFilterChange({
              ...filter,
              ...(event.target.value
                ? { destinationTabId: event.target.value }
                : { destinationTabId: undefined }),
            })
          }
        >
          <option value="">Any session</option>
          {destinations.map(([tabId, label]) => (
            <option key={tabId} value={tabId}>
              {label}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1 text-muted-foreground">
          <input
            type="checkbox"
            checked={Boolean(filter.importedOnly)}
            onChange={(event) =>
              onFilterChange({ ...filter, importedOnly: event.target.checked || undefined })
            }
          />
          Imported browser notes
        </label>
        <label className="flex items-center gap-1 text-muted-foreground">
          <input
            type="checkbox"
            checked={Boolean(filter.includeArchived)}
            onChange={(event) =>
              onFilterChange({ ...filter, includeArchived: event.target.checked || undefined })
            }
          />
          Include archived
        </label>
      </div>

      {selection.size > 0 && (
        <div
          className="shrink-0 border-b border-border/70 bg-primary/5 px-3 py-1 text-[11px]"
          data-selection-summary
        >
          {selection.size} selected
          {hiddenSelected > 0 ? ` (${hiddenSelected} not shown by the current filter or page)` : ""}
          {selection.size >= selectionLimit ? ` · limit of ${selectionLimit} reached` : ""}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {filter.scope === "page" && !currentPage ? (
          <p className="p-3 text-xs text-muted-foreground">
            Open a page in this preview, or choose “All pages”.
          </p>
        ) : !state || state.status === "loading" ? (
          <p className="flex items-center gap-1.5 p-3 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden /> Loading notes…
          </p>
        ) : items.length === 0 ? (
          <p className="p-3 text-xs text-muted-foreground">
            {filter.state === "open" && filter.scope === "page"
              ? "No open notes on this page."
              : "No notes match these filters."}
          </p>
        ) : (
          <ul aria-label="Annotations" className="divide-y divide-border/60">
            {items.map((item, index) => {
              const selected = selection.has(item.id);
              const title = annotationTitle(item);
              const destination = destinationLabel(item);
              const atLimit = !selected && selection.size >= selectionLimit;
              const viewport = viewportLabel(
                cache.captures.get(item.currentCaptureId)?.geometry?.viewport,
              );
              const pin = pinResults.get(item.id);
              const archived = Boolean(item.archivedAt);
              return (
                <li
                  key={item.id}
                  className="flex items-start gap-2 px-3 py-2"
                  data-annotation-row={item.id}
                >
                  {canSelect && !archived && (
                    <Checkbox
                      className="mt-0.5"
                      checked={selected}
                      aria-disabled={atLimit || undefined}
                      aria-label={`Select note ${firstIndex + index + 1}: ${title}`}
                      onCheckedChange={(checked) => onToggleSelection(item, checked === true)}
                    />
                  )}
                  <button
                    type="button"
                    className="min-w-0 flex-1 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => onOpen(item.id)}
                    aria-label={`Open note: ${title}`}
                  >
                    <div className="truncate text-xs font-medium text-foreground">{title}</div>
                    <div className="truncate text-[11px] text-muted-foreground">
                      {TARGET_KIND_LABELS[item.targetKind]} · {pageLabel(item.page)}
                      {viewport ? ` · ${viewport}` : ""}
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-muted-foreground">
                      <span
                        className={cn(
                          item.state === "resolved" && "text-emerald-300",
                          item.state === "open" && "text-foreground/80",
                        )}
                      >
                        {item.activeRequest
                          ? WEB_ANNOTATION_REQUEST_STATE_LABELS[item.activeRequest.state]
                          : annotationStateLabel(item)}
                      </span>
                      <span>{lastActivity(item.lastActivityAt)}</span>
                      {destination && <span>→ {destination}</span>}
                      {item.imported && <span>Imported</span>}
                      {archived && <span>Archived</span>}
                      {pin && (pin.state !== "matched" || pin.historical) && (
                        <span className="text-amber-200" data-pin-state={pin.state}>
                          {anchorStateLabel(pin)}
                        </span>
                      )}
                      {item.unavailable && (
                        <span className="text-amber-200">Partly unavailable</span>
                      )}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-between border-t border-border/70 px-3 py-1 text-[11px] text-muted-foreground">
        <span>
          {total > 0 ? `${firstIndex + 1}–${firstIndex + items.length} of ${total}` : "0 notes"}
        </span>
        <div className="flex gap-1">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-6 w-6"
            aria-label="Previous page of notes"
            disabled={cursors.length <= 1}
            onClick={() => setCursors((current) => current.slice(0, -1))}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-6 w-6"
            aria-label="Next page of notes"
            disabled={!state?.nextCursor}
            onClick={() => {
              const next = state?.nextCursor;
              if (next) setCursors((current) => [...current, next]);
            }}
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
