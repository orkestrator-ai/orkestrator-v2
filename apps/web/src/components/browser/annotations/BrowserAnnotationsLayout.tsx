import { useRef, type ReactNode } from "react";
import { MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { BROWSER_ANNOTATION_PANEL_WIDTH } from "@/types/paneLayout";
import { AnnotationPanel } from "./AnnotationPanel";
import type { BrowserAnnotationsController } from "./useBrowserAnnotations";

/** Toolbar control: open-note count for the current logical page. */
export function AnnotationsButton({ annotations }: { annotations: BrowserAnnotationsController }) {
  const count = annotations.openCount;
  const unsaved = annotations.unsavedCaptures;
  const unavailable = !annotations.available;
  const label = unavailable
    ? "Annotations unavailable"
    : `Annotations, ${count} open on this page${
        unsaved > 0 ? `, ${unsaved} unsaved capture${unsaved === 1 ? "" : "s"}` : ""
      }`;
  return (
    <Button
      ref={annotations.buttonRef}
      type="button"
      variant={annotations.view.open ? "secondary" : "ghost"}
      size="sm"
      className="h-8 shrink-0 gap-1.5 px-2.5"
      aria-label={label}
      aria-expanded={annotations.view.open}
      title={
        unavailable
          ? annotations.mode === "disabled"
            ? "Web annotations are turned off on this backend"
            : (annotations.capabilityReason ??
              (annotations.capabilityStatus === "loading" ||
              annotations.capabilityStatus === "unknown"
                ? "Checking annotation support…"
                : "Web annotations are unavailable for this backend"))
          : annotations.mode === "read-only"
            ? "Notes for this page (read-only recovery mode)"
            : "Notes for this page"
      }
      disabled={unavailable}
      onClick={annotations.toggle}
    >
      <MessageSquare className="h-4 w-4" />
      <span className="hidden @lg/browser:inline">Notes</span>
      {count > 0 && (
        <span
          className="rounded-full bg-primary/20 px-1.5 text-[10px] font-semibold tabular-nums"
          aria-hidden
        >
          {count > 99 ? "99+" : count}
        </span>
      )}
      {unsaved > 0 && (
        <span
          className="rounded-full bg-amber-500/20 px-1.5 text-[10px] font-semibold tabular-nums text-amber-200"
          aria-hidden
          data-unsaved-captures={unsaved}
        >
          {unsaved} unsaved
        </span>
      )}
    </Button>
  );
}

function ResizeHandle({ annotations }: { annotations: BrowserAnnotationsController }) {
  const start = useRef<{ x: number; width: number } | null>(null);
  const clamp = (value: number) =>
    Math.round(
      Math.min(
        BROWSER_ANNOTATION_PANEL_WIDTH.max,
        Math.max(BROWSER_ANNOTATION_PANEL_WIDTH.min, value),
      ),
    );
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize annotations panel"
      aria-valuemin={BROWSER_ANNOTATION_PANEL_WIDTH.min}
      aria-valuemax={BROWSER_ANNOTATION_PANEL_WIDTH.max}
      aria-valuenow={annotations.width}
      tabIndex={0}
      className="w-1 shrink-0 cursor-col-resize bg-border/60 outline-none hover:bg-primary/40 focus-visible:bg-primary/60"
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        annotations.commitWidth(clamp(annotations.width + (event.key === "ArrowLeft" ? 16 : -16)));
      }}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture?.(event.pointerId);
        start.current = { x: event.clientX, width: annotations.width };
      }}
      onPointerMove={(event) => {
        if (!start.current) return;
        annotations.setDragWidth(clamp(start.current.width + (start.current.x - event.clientX)));
      }}
      onPointerUp={(event) => {
        if (!start.current) return;
        const next = clamp(start.current.width + (start.current.x - event.clientX));
        start.current = null;
        annotations.commitWidth(next);
      }}
    />
  );
}

/**
 * Preview area plus an app-owned annotations column. The native preview
 * cannot be overlaid by renderer UI, so the panel takes real width and the
 * preview host shrinks (its ResizeObserver re-syncs the native bounds). At
 * narrow widths the two share one surface with an explicit switch.
 */
export function AnnotatedPreviewArea({
  annotations,
  children,
}: {
  annotations: BrowserAnnotationsController;
  children: ReactNode;
}) {
  const open = annotations.view.open && annotations.available;
  const narrow = annotations.narrow;
  const showNotes = !narrow || annotations.surface === "notes";
  return (
    <div
      ref={annotations.containerRef}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      {open && narrow && (
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border/70 px-2 py-1">
          <div role="tablist" aria-label="Preview or notes" className="flex gap-1">
            {(["preview", "notes"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={annotations.surface === value}
                className={cn(
                  "rounded px-2 py-0.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  annotations.surface === value
                    ? "bg-primary/15 text-foreground"
                    : "text-muted-foreground",
                )}
                onClick={() => annotations.setSurface(value)}
              >
                {value === "preview" ? "Preview" : "Notes"}
              </button>
            ))}
          </div>
          {annotations.selecting && (
            <span
              className="flex items-center gap-1 text-[11px] text-muted-foreground"
              role="status"
            >
              Select a target in the preview
              {annotations.chosenSurface === "notes" ? "; notes open when you finish" : ""}.
              <button
                type="button"
                className="rounded px-1 underline outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={annotations.stopSelection}
              >
                Cancel selection
              </button>
            </span>
          )}
        </div>
      )}
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <div
          className={cn(
            "relative min-h-0 min-w-0 flex-1 overflow-hidden bg-background",
            open && annotations.previewHidden && "hidden",
          )}
        >
          {children}
        </div>
        {open && !narrow && <ResizeHandle annotations={annotations} />}
        {open && (
          <div
            className={cn(
              "min-h-0 min-w-0 shrink-0 border-l border-border/80",
              narrow && (showNotes ? "flex-1 border-l-0" : "hidden"),
            )}
            style={narrow ? undefined : { width: annotations.width }}
          >
            <AnnotationPanel {...annotations.panelProps} />
          </div>
        )}
      </div>
    </div>
  );
}
