import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, MessageSquarePlus, X } from "lucide-react";
import type { BrowserPreviewCaptureMode } from "@orkestrator/protocol/browser-preview";
import type { WebAnnotationSummary } from "@orkestrator/protocol/web-annotations";
import { Button } from "@/components/ui/button";
import { useWebAnnotationCache } from "@/hooks/useWebAnnotations";
import { sessionCaptureMode, setSessionCaptureMode } from "@/lib/web-annotations/capture-intents";
import type { WebAnnotationFeatureFlags } from "@/lib/web-annotations/client";
import type { BrowserAnnotationPanelState } from "@/types/paneLayout";
import { AnnotationEditor } from "./AnnotationEditor";
import { AnnotationList, DEFAULT_ANNOTATION_FILTER } from "./AnnotationList";
import { AnnotationStatus } from "./AnnotationStatus";
import { AnnotationThread } from "./AnnotationThread";
import { BatchReviewTray } from "./BatchReviewTray";
import { CaptureModePicker } from "./CaptureModePicker";
import { ExpiredCaptureNotices, OtherPendingCaptures } from "./CaptureNotices";
import { annotationTitle, type CurrentAnnotationPage } from "./format";
import { AnnotationPanelContext, type AnnotationPanelContextValue } from "./panel-context";
import { ResponsiveCaptureControl } from "./ResponsiveCaptureControl";
import type { AnnotationCaptureController } from "./useAnnotationCapture";

export interface AnnotationPanelProps {
  environmentId: string;
  tabId: string;
  features: WebAnnotationFeatureFlags;
  capture: AnnotationCaptureController;
  /** The desktop preload exposes trusted capture (independent of backend support). */
  desktopCapture: boolean;
  supportedModes: BrowserPreviewCaptureMode[];
  currentPage: CurrentAnnotationPage | null;
  view: BrowserAnnotationPanelState;
  onViewChange: (patch: Partial<BrowserAnnotationPanelState>) => void;
  onClose: () => void;
  navigateToPage: AnnotationPanelContextValue["navigateToPage"];
  showOnPage: AnnotationPanelContextValue["showOnPage"];
  pinResults?: AnnotationPanelContextValue["pinResults"];
}

const NO_PIN_RESULTS: AnnotationPanelContextValue["pinResults"] = new Map();

/**
 * The trusted, app-owned home for page feedback: list, threads, authoring,
 * and review. It never navigates or reloads the preview except on an explicit
 * user action, and closing it never stops agent work.
 */
export function AnnotationPanel({
  environmentId,
  tabId,
  features,
  capture,
  desktopCapture,
  supportedModes,
  currentPage,
  view,
  onViewChange,
  onClose,
  navigateToPage,
  showOnPage,
  pinResults = NO_PIN_RESULTS,
}: AnnotationPanelProps) {
  const cache = useWebAnnotationCache(environmentId);
  const [announcement, setAnnouncement] = useState("");
  const [captureMode, setCaptureModeState] = useState<BrowserPreviewCaptureMode>(() =>
    sessionCaptureMode(tabId),
  );
  const [selection, setSelection] = useState<Map<string, WebAnnotationSummary>>(new Map());
  const [overflow, setOverflow] = useState<string | null>(null);
  const addNoteRef = useRef<HTMLButtonElement | null>(null);
  // No mode both this desktop and the backend support: nothing can be captured.
  const canCapture = features.capture && supportedModes.length > 0;
  const mode = supportedModes.includes(captureMode)
    ? captureMode
    : (supportedModes[0] ?? "element");
  const filter = view.filter ?? DEFAULT_ANNOTATION_FILTER;
  const selectedAnnotationId = view.selectedAnnotationId ?? null;
  const selectionLimit = features.batch ? features.maxRequestAnnotations : 1;
  const responsiveLimits = capture.desktopCapabilities?.features.responsiveSets ?? null;

  const announce = useCallback((message: string) => {
    // Re-announce identical messages by clearing first.
    setAnnouncement("");
    queueMicrotask(() => setAnnouncement(message));
  }, []);
  const setCaptureMode = useCallback(
    (next: BrowserPreviewCaptureMode) => {
      setSessionCaptureMode(tabId, next);
      setCaptureModeState(next);
    },
    [tabId],
  );
  const selectAnnotation = useCallback(
    (annotationId: string | null) => onViewChange({ selectedAnnotationId: annotationId }),
    [onViewChange],
  );

  // A save finished in the background (reconnect, reload) lands on its note.
  const committed = capture.lastCommitted;
  const handledCommitRef = useRef(committed?.sequence ?? 0);
  useEffect(() => {
    if (!committed || committed.sequence <= handledCommitRef.current) return;
    handledCommitRef.current = committed.sequence;
    if (!committed.automatic) return;
    announce("A note that was waiting for the connection is now saved");
    if (!selectedAnnotationId && !capture.activeCaptureId) selectAnnotation(committed.annotationId);
  }, [announce, capture.activeCaptureId, committed, selectAnnotation, selectedAnnotationId]);

  const context = useMemo<AnnotationPanelContextValue>(
    () => ({
      environmentId,
      tabId,
      features,
      capture,
      captureMode: mode,
      setCaptureMode,
      supportedModes,
      currentPage,
      announce,
      selectAnnotation,
      navigateToPage,
      showOnPage,
      pinResults,
    }),
    [
      announce,
      capture,
      currentPage,
      environmentId,
      features,
      mode,
      navigateToPage,
      pinResults,
      selectAnnotation,
      setCaptureMode,
      showOnPage,
      supportedModes,
      tabId,
    ],
  );

  const toggleSelection = (summary: WebAnnotationSummary, selected: boolean) => {
    const next = new Map(selection);
    if (!selected) {
      next.delete(summary.id);
      setOverflow(null);
    } else if (next.size >= selectionLimit) {
      setOverflow(annotationTitle(summary));
      return;
    } else {
      next.set(summary.id, summary);
    }
    setSelection(next);
  };

  const activeDescriptor = capture.activeDescriptor;
  const otherPending = capture.pending.filter(
    (descriptor) =>
      descriptor.captureId !== capture.activeCaptureId &&
      // Other widths of the open responsive set are shown in its editor.
      !(
        activeDescriptor?.responsive &&
        descriptor.responsive?.setId === activeDescriptor.responsive.setId
      ),
  );

  return (
    <AnnotationPanelContext.Provider value={context}>
      <aside
        aria-label="Page annotations"
        className="flex h-full min-h-0 w-full min-w-0 flex-col bg-background"
        data-annotation-panel={tabId}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || event.defaultPrevented) return;
          event.stopPropagation();
          // Escape closes the nearest transient UI; it never stops agent work.
          if (capture.selecting) {
            void capture.cancel();
            addNoteRef.current?.focus();
          } else if (selectedAnnotationId) selectAnnotation(null);
          else onClose();
        }}
      >
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border/80 px-3 py-1.5">
          <h2 className="text-xs font-semibold">Notes</h2>
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            {canCapture && (
              <CaptureModePicker
                modes={supportedModes}
                value={mode}
                onChange={setCaptureMode}
                disabled={capture.selecting}
              />
            )}
            {canCapture && responsiveLimits && currentPage && (
              <ResponsiveCaptureControl
                limits={responsiveLimits}
                disabled={capture.selecting}
                onCapture={async (widths) => {
                  const result = await capture.captureResponsive(widths);
                  if (result) {
                    announce(
                      `Captured ${result.captures.length} of ${widths.length} widths${
                        result.failures.length ? `; ${result.failures.length} failed` : ""
                      }`,
                    );
                  }
                }}
              />
            )}
            {canCapture &&
              (capture.selecting ? (
                <Button
                  ref={addNoteRef}
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="h-7 gap-1 px-2 text-xs"
                  onClick={() => void capture.cancel()}
                >
                  <Loader2 className="h-3 w-3 motion-safe:animate-spin" aria-hidden />
                  Cancel selection
                </Button>
              ) : (
                <Button
                  ref={addNoteRef}
                  type="button"
                  size="sm"
                  className="h-7 gap-1 px-2 text-xs"
                  onClick={() => void capture.start(mode)}
                >
                  <MessageSquarePlus className="h-3 w-3" aria-hidden />
                  Add note
                </Button>
              ))}
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              aria-label="Close annotations"
              onClick={onClose}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
        <AnnotationStatus
          environmentId={environmentId}
          cache={cache}
          features={features}
          desktopCapture={desktopCapture}
          announcement={announcement}
        />
        {capture.selecting && (
          <p className="shrink-0 border-b border-border/70 bg-primary/5 px-3 py-1.5 text-[11px]">
            Select a target in the preview. Press Escape or Cancel selection to stop.
          </p>
        )}
        {capture.error && (
          <div
            role="alert"
            className="flex shrink-0 items-start gap-2 border-b border-destructive/20 bg-destructive/10 px-3 py-1.5 text-[11px] text-destructive"
          >
            <span className="min-w-0 flex-1">{capture.error}</span>
            <button type="button" className="underline" onClick={capture.clearError}>
              Dismiss
            </button>
          </div>
        )}
        <ExpiredCaptureNotices notices={capture.expired} onDismiss={capture.dismissExpired} />
        {activeDescriptor && (
          <div className="max-h-[70%] shrink-0 overflow-y-auto">
            <AnnotationEditor
              key={activeDescriptor.captureId}
              descriptor={activeDescriptor}
              onClose={(reason, annotationId) => {
                capture.openPending(null);
                if (reason === "saved" && annotationId) selectAnnotation(annotationId);
                else queueMicrotask(() => addNoteRef.current?.focus());
              }}
            />
          </div>
        )}
        <OtherPendingCaptures
          pending={otherPending}
          onOpen={(captureId) => capture.openPending(captureId)}
        />
        {!features.read ? (
          // Turned off on this backend: only the notice above is shown; the
          // saved notes stay on the backend until the feature is re-enabled.
          <div className="p-3 text-xs text-muted-foreground" data-annotations-disabled>
            Notes are hidden while web annotations are turned off.
          </div>
        ) : selectedAnnotationId ? (
          <AnnotationThread
            key={selectedAnnotationId}
            annotationId={selectedAnnotationId}
            onBack={() => selectAnnotation(null)}
          />
        ) : (
          <>
            <AnnotationList
              environmentId={environmentId}
              currentPage={currentPage}
              filter={filter}
              onFilterChange={(next) => onViewChange({ filter: next })}
              selection={selection}
              onToggleSelection={toggleSelection}
              selectionLimit={selectionLimit}
              onOpen={(annotationId) => selectAnnotation(annotationId)}
              canSelect={features.dispatch}
            />
            {selection.size > 0 && (
              <BatchReviewTray
                selection={selection}
                limit={selectionLimit}
                overflow={overflow}
                onDeselect={(annotationId) =>
                  setSelection((current) => {
                    const next = new Map(current);
                    next.delete(annotationId);
                    return next;
                  })
                }
                onClear={() => {
                  setSelection(new Map());
                  setOverflow(null);
                }}
              />
            )}
          </>
        )}
      </aside>
    </AnnotationPanelContext.Provider>
  );
}
