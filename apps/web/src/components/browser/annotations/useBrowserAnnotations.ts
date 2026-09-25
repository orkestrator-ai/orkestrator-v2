/**
 * Browser-tab controller for web annotations. BrowserTab/ServiceBrowserTab
 * supply the logical page and a navigation callback; this hook owns sync,
 * capture coordination, panel view state (pane layout: visibility, selected
 * id, filter, width only), pins, and the narrow-width surface switch.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BrowserPreviewCaptureMode } from "@orkestrator/protocol/browser-preview";
import {
  WEB_ANNOTATION_LIMITS,
  type WebAnnotationPageIdentity,
} from "@orkestrator/protocol/web-annotations";
import {
  useWebAnnotationCache,
  useWebAnnotationFeatures,
  useWebAnnotationList,
  useWebAnnotationSync,
} from "@/hooks/useWebAnnotations";
import {
  getBrowserPreviewCaptureApi,
  hasBrowserPreviewCapture,
} from "@/lib/native/browser-preview";
import { CAPTURE_MODE_TARGET } from "@/lib/web-annotations/capture-intents";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import {
  BROWSER_ANNOTATION_PANEL_WIDTH,
  type BrowserAnnotationPanelState,
  type BrowserTabData,
} from "@/types/paneLayout";
import type { AnnotationPanelProps } from "./AnnotationPanel";
import type { CurrentAnnotationPage } from "./format";
import type { PreviewNavigationResult } from "./panel-context";
import { useAnnotationCapture, type AnnotationCaptureController } from "./useAnnotationCapture";
import { useAnnotationPins } from "./useAnnotationPins";

/** Below this container width the preview and notes share one surface. */
export const NARROW_ANNOTATION_LAYOUT_PX = 720;
const ALL_MODES: BrowserPreviewCaptureMode[] = ["element", "text", "region", "page"];
const CLOSED: BrowserAnnotationPanelState = Object.freeze({ open: false });

/**
 * Capture modes offered: backend targets intersected with what this desktop
 * can capture (contract version 2 reports its modes; version 1 is assumed to
 * support all four).
 */
export function offeredCaptureModes(
  backendTargets: readonly string[] | undefined,
  desktopModes: readonly BrowserPreviewCaptureMode[] | undefined,
): BrowserPreviewCaptureMode[] {
  const targets = new Set(backendTargets ?? ["element"]);
  const desktop = new Set(desktopModes ?? ALL_MODES);
  const modes = ALL_MODES.filter(
    (mode) => targets.has(CAPTURE_MODE_TARGET[mode]) && desktop.has(mode),
  );
  if (modes.length > 0) return modes;
  return desktop.has("element") && targets.has("element") ? ["element"] : [];
}

export function useBrowserAnnotations({
  tabId,
  environmentId,
  isActive,
  data,
  currentPage,
  previewAttached,
  navigateToPage,
}: {
  tabId: string;
  environmentId: string;
  isActive: boolean;
  data: BrowserTabData;
  currentPage: CurrentAnnotationPage | null;
  /** A native preview is attached and can take capture/pin requests. */
  previewAttached: boolean;
  navigateToPage: (page: WebAnnotationPageIdentity) => PreviewNavigationResult;
}) {
  const desktopCapture = hasBrowserPreviewCapture();
  useWebAnnotationSync(environmentId, isActive);
  const cache = useWebAnnotationCache(environmentId);
  const features = useWebAnnotationFeatures(environmentId, desktopCapture && previewAttached);
  const persisted = data.annotationPanel ?? CLOSED;
  const updatePanel = usePaneLayoutStore((state) => state.updateTabBrowserAnnotationPanel);
  const onViewChange = useCallback(
    (patch: Partial<BrowserAnnotationPanelState>) => updatePanel(tabId, patch, environmentId),
    [environmentId, tabId, updatePanel],
  );
  const view = persisted;
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  // Open-note count for the current logical page; the same page (≤ 50)
  // supplies the visible pins.
  const countQuery =
    currentPage && features.read
      ? {
          filter: { pageKey: currentPage.pageKey, state: "open" as const },
          cursor: null,
          limit: WEB_ANNOTATION_LIMITS.visiblePins,
        }
      : null;
  const pageList = useWebAnnotationList(environmentId, countQuery);
  const openCount = pageList.state ? (pageList.state.openOnPage ?? pageList.state.total) : 0;

  const rawCapture = useAnnotationCapture({
    tabId,
    environmentId,
    isActive,
    enabled: features.capture,
  });

  // ---- layout -------------------------------------------------------------
  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const containerRef = useCallback((element: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (typeof width === "number") setContainerWidth(width);
    });
    observer.observe(element);
    observerRef.current = observer;
  }, []);
  const narrow = containerWidth !== null && containerWidth < NARROW_ANNOTATION_LAYOUT_PX;
  const [chosenSurface, setChosenSurface] = useState<"preview" | "notes">("notes");
  const narrowRef = useRef(narrow);
  narrowRef.current = narrow;
  // Selecting needs the page visible: while a selection runs the narrow
  // layout shows the preview, whatever tab was chosen. Choosing Notes during
  // a selection is remembered for when it ends instead of cancelling it.
  const surface = rawCapture.selecting ? "preview" : chosenSurface;
  // Only a panel that can actually render may cover the preview; otherwise a
  // persisted open state would hide it with no way to reopen the notes.
  const previewHidden = view.open && features.read && narrow && surface === "notes";
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const width = dragWidth ?? view.width ?? BROWSER_ANNOTATION_PANEL_WIDTH.initial;

  // Starting a selection from the notes surface shows the preview first, so
  // the native view is visible when main starts listening for the target.
  // Ending the selection (captured or cancelled) returns to the notes.
  const chosenRef = useRef(chosenSurface);
  chosenRef.current = chosenSurface;
  const returnToNotesRef = useRef(false);
  const showPreviewForSelection = useCallback(() => {
    if (!narrowRef.current) return;
    if (chosenRef.current === "notes") returnToNotesRef.current = true;
    setChosenSurface("preview");
  }, []);
  const wasSelectingRef = useRef(false);
  useEffect(() => {
    const selecting = rawCapture.selecting;
    if (wasSelectingRef.current && !selecting && returnToNotesRef.current) {
      returnToNotesRef.current = false;
      setChosenSurface("notes");
    }
    wasSelectingRef.current = selecting;
  }, [rawCapture.selecting]);
  const capture = useMemo<AnnotationCaptureController>(() => {
    const restoreIfFailed = (started: boolean) => {
      if (!started && returnToNotesRef.current) {
        returnToNotesRef.current = false;
        setChosenSurface("notes");
      }
      return started;
    };
    return {
      ...rawCapture,
      start: (mode, options) => {
        showPreviewForSelection();
        return rawCapture.start(mode, options).then(restoreIfFailed);
      },
      recapture: (captureId) => {
        showPreviewForSelection();
        return rawCapture.recapture(captureId).then(restoreIfFailed);
      },
    };
  }, [rawCapture, showPreviewForSelection]);

  const selectionRef = useRef({ selecting: capture.selecting, cancel: capture.cancel });
  selectionRef.current = { selecting: capture.selecting, cancel: capture.cancel };
  /** Page changes end transient selection (never pending captures or drafts). */
  const stopSelection = useCallback(() => {
    if (selectionRef.current.selecting) void selectionRef.current.cancel();
  }, []);
  // A fresh capture always has a visible editor: open the panel and, when
  // narrow, return to the notes surface. Once per newly active capture only,
  // so an explicit close is not undone while it stays pending.
  const openedForCaptureRef = useRef<string | null>(null);
  useEffect(() => {
    const captureId = capture.activeCaptureId;
    if (captureId === openedForCaptureRef.current) return;
    openedForCaptureRef.current = captureId;
    if (!captureId) return;
    setChosenSurface("notes");
    if (!view.open) onViewChange({ open: true });
  }, [capture.activeCaptureId, onViewChange, view.open]);

  const supportedModes = useMemo(
    () => offeredCaptureModes(cache.capabilities?.targets, capture.desktopCapabilities?.modes),
    [cache.capabilities?.targets, capture.desktopCapabilities?.modes],
  );

  // ---- pins -------------------------------------------------------------
  const selectedId = view.selectedAnnotationId ?? null;
  const pins = useAnnotationPins({
    tabId,
    environmentId,
    items: pageList.items,
    wanted:
      Boolean(getBrowserPreviewCaptureApi()) &&
      features.read &&
      isActive &&
      view.open &&
      previewAttached &&
      !previewHidden &&
      Boolean(currentPage),
    selectedId,
    currentPage,
    previewAttached,
  });

  const open = useCallback(() => {
    setChosenSurface("notes");
    onViewChange({ open: true });
  }, [onViewChange]);
  const close = useCallback(() => {
    onViewChange({ open: false });
    // Focus flow: closing the panel returns to the annotations control.
    queueMicrotask(() => buttonRef.current?.focus());
  }, [onViewChange]);
  const toggle = useCallback(() => (view.open ? close() : open()), [close, open, view.open]);

  const panelProps: AnnotationPanelProps = {
    environmentId,
    tabId,
    features,
    capture,
    desktopCapture,
    supportedModes,
    currentPage,
    view,
    onViewChange,
    onClose: close,
    navigateToPage,
    showOnPage: pins.showOnPage,
    pinResults: pins.pinResults,
  };

  return {
    // A backend that turned annotations off still opens the panel, so the
    // rollout notice is visible instead of only a disabled button.
    available: features.read || features.mode === "disabled",
    /** Unsaved desktop captures (kept locally until saved or expired). */
    unsavedCaptures: capture.pending.length,
    capabilityStatus: cache.capabilityStatus,
    capabilityReason: cache.capabilityReason,
    mode: features.mode,
    openCount,
    view,
    toggle,
    close,
    stopSelection,
    buttonRef,
    panelProps,
    containerRef,
    narrow,
    surface,
    /** The surface chosen by the user (applies after a running selection). */
    chosenSurface,
    selecting: capture.selecting,
    setSurface: setChosenSurface,
    previewHidden,
    width,
    setDragWidth,
    commitWidth: (next: number) => {
      setDragWidth(null);
      onViewChange({ width: next });
    },
  };
}

export type BrowserAnnotationsController = ReturnType<typeof useBrowserAnnotations>;
