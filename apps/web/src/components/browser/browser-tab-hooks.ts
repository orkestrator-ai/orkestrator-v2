import { useCallback, useEffect, useRef, useState } from "react";
import {
  BROWSER_PREVIEW_ANNOTATION_EVENT,
  isBrowserPreviewAnnotationEvent,
  type BrowserPreviewAnnotationStatus,
} from "@orkestrator/protocol/browser-preview";
import { toast } from "sonner";

import { writeContainerFile, writeLocalFile } from "@/lib/backend";
import {
  addBrowserAnnotationToOpenNativeSessions,
  formatBrowserElementAnnotation,
} from "@/lib/chat/browser-annotations";
import {
  cancelBrowserPreviewAnnotation,
  getBrowserPreviewAnnotationStatus,
  startBrowserPreviewAnnotation,
} from "@/lib/native/browser-preview";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";

export const BLOCKING_OVERLAY_SELECTOR = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
].join(",");

/** Status poll while annotating on a desktop that reports no terminal events. */
export const ANNOTATION_POLL_INTERVAL_MS = 150;
/**
 * Temporary safety net when terminal events are available: catches a missed
 * event, a page reload (no event is emitted) and an older page runtime. Kept
 * until native event delivery is proven across supported desktop builds.
 */
export const ANNOTATION_FALLBACK_POLL_INTERVAL_MS = 1_000;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isVisuallyPresent(element: Element): boolean {
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (current instanceof HTMLElement && current.hidden) return false;
    const style = window.getComputedStyle(current);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      Number.parseFloat(style.opacity) === 0
    ) {
      return false;
    }
  }
  return true;
}

function isBlockingOverlay(element: Element): boolean {
  const isClosing =
    element.getAttribute("aria-hidden") === "true" ||
    element.getAttribute("data-state") === "closed";
  return !isClosing || isVisuallyPresent(element);
}

function hasVisuallyBlockingOverlay(): boolean {
  return Array.from(document.querySelectorAll(BLOCKING_OVERLAY_SELECTOR)).some(isBlockingOverlay);
}

const OVERLAY_MOTION_EVENTS = [
  "animationcancel",
  "animationend",
  "animationstart",
  "transitioncancel",
  "transitionend",
  "transitionrun",
];

/**
 * A native preview view is composited above the renderer, so it must hide while
 * a dialog or menu is open over it.
 */
export function useBlockingOverlay(enabled: boolean): boolean {
  const [hasBlockingOverlay, setHasBlockingOverlay] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const update = () => setHasBlockingOverlay(hasVisuallyBlockingOverlay());
    const updateAfterOverlayMotion = (event: Event) => {
      if (event.target instanceof Element && event.target.matches(BLOCKING_OVERLAY_SELECTOR)) {
        update();
      }
    };
    const observer = new MutationObserver(update);
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["aria-hidden", "data-state", "hidden", "role"],
      childList: true,
      subtree: true,
    });
    for (const eventName of OVERLAY_MOTION_EVENTS) {
      document.addEventListener(eventName, updateAfterOverlayMotion, true);
    }
    update();
    return () => {
      observer.disconnect();
      for (const eventName of OVERLAY_MOTION_EVENTS) {
        document.removeEventListener(eventName, updateAfterOverlayMotion, true);
      }
    };
  }, [enabled]);
  return hasBlockingOverlay;
}

function pngBase64FromDataUrl(dataUrl: string): string {
  const prefix = "data:image/png;base64,";
  if (!dataUrl.startsWith(prefix)) throw new Error("The browser frame did not return a PNG image");
  const base64 = dataUrl.slice(prefix.length);
  if (!base64) throw new Error("The browser frame screenshot was empty");
  return base64;
}

/** Element annotation for native previews, shared by manual and service tabs. */
export function useBrowserPreviewAnnotation({
  tabId,
  environmentId,
  isActive,
  nativeBrowserPreview,
}: {
  tabId: string;
  environmentId: string;
  isActive: boolean;
  nativeBrowserPreview: boolean;
}) {
  const [annotationMode, setAnnotationMode] = useState(false);
  const [annotationSaving, setAnnotationSaving] = useState(false);
  const mountedRef = useRef(true);
  /** Operation id of the running annotation; null for a desktop without events. */
  const operationRef = useRef<string | null>(null);
  /** Last terminal event's operation id for this tab (may precede the start answer). */
  const lastEventRef = useRef<string | null>(null);
  /** Status read for the running operation, triggered by its terminal event. */
  const eventReadRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const stopAnnotationForPageChange = useCallback(() => {
    if (!annotationMode) return;
    setAnnotationMode(false);
    void cancelBrowserPreviewAnnotation(tabId).catch(() => undefined);
  }, [annotationMode, tabId]);

  const addSubmittedAnnotation = useCallback(
    async (submission: Extract<BrowserPreviewAnnotationStatus, { status: "submitted" }>) => {
      const openNativeTabs = usePaneLayoutStore
        .getState()
        .getAllTabs(environmentId)
        .filter((tab) => tab.type === "agent-native");
      if (openNativeTabs.length === 0) {
        throw new Error("Open a native agent session before adding a browser annotation");
      }
      const currentEnvironment = useEnvironmentStore.getState().getEnvironmentById(environmentId);
      if (!currentEnvironment) throw new Error("The environment is not available");

      const annotationId = crypto.randomUUID();
      const filename = `browser-annotation-${Date.now()}-${annotationId.slice(0, 8)}.png`;
      const relativePath = `.orkestrator/annotations/${filename}`;
      const base64Data = pngBase64FromDataUrl(submission.screenshotDataUrl);
      let screenshotPath: string;
      if (currentEnvironment.containerId) {
        await writeContainerFile(currentEnvironment.containerId, relativePath, base64Data);
        screenshotPath = `/workspace/${relativePath}`;
      } else if (currentEnvironment.worktreePath) {
        screenshotPath = await writeLocalFile(
          currentEnvironment.worktreePath,
          relativePath,
          base64Data,
        );
      } else {
        throw new Error("The environment has no workspace for the browser screenshot");
      }

      const result = addBrowserAnnotationToOpenNativeSessions({
        environmentId,
        annotation: {
          id: annotationId,
          source: "browser",
          screenshotPath,
          text: formatBrowserElementAnnotation(submission.element, screenshotPath),
          comment: submission.comment,
        },
        screenshot: {
          id: crypto.randomUUID(),
          annotationId,
          type: "image",
          path: screenshotPath,
          previewUrl: submission.screenshotDataUrl,
          name: filename,
        },
      });
      if (result.sessionCount === 0) {
        throw new Error("Every open native session has reached its 20-annotation limit");
      }
      toast.success(
        `Annotation added to ${result.sessionCount} native session${result.sessionCount === 1 ? "" : "s"}`,
        result.annotationSkippedCount > 0 || result.screenshotSkippedCount > 0
          ? {
              description: [
                result.annotationSkippedCount > 0
                  ? `${result.annotationSkippedCount} full annotation composer${result.annotationSkippedCount === 1 ? " was" : "s were"} skipped.`
                  : null,
                result.screenshotSkippedCount > 0
                  ? `${result.screenshotSkippedCount} full attachment composer${result.screenshotSkippedCount === 1 ? " received" : "s received"} the screenshot path without an image attachment.`
                  : null,
              ]
                .filter(Boolean)
                .join(" "),
            }
          : undefined,
      );
    },
    [environmentId],
  );

  const toggleAnnotationMode = useCallback(() => {
    if (annotationSaving) return;
    if (annotationMode) {
      setAnnotationMode(false);
      void cancelBrowserPreviewAnnotation(tabId).catch((annotationError) => {
        toast.error("Could not stop annotation mode", {
          description: errorMessage(annotationError),
        });
      });
      return;
    }
    setAnnotationSaving(true);
    // The event subscription below is already live: a terminal event that
    // races this start is kept and matched once the operation id is known.
    operationRef.current = null;
    void startBrowserPreviewAnnotation(tabId)
      .then((started) => {
        operationRef.current = started.operationId ?? null;
        setAnnotationMode(true);
      })
      .catch((annotationError) => {
        toast.error("Could not start annotation mode", {
          description: errorMessage(annotationError),
        });
      })
      .finally(() => setAnnotationSaving(false));
  }, [annotationMode, annotationSaving, tabId]);

  // Terminal annotation events (desktop builds that report an operation id).
  // Subscribed for the hook's lifetime, so nothing emitted between start and
  // the status loop below is lost; each event is only a hint to read status.
  useEffect(
    () =>
      window.orkestrator?.listen?.<unknown>(BROWSER_PREVIEW_ANNOTATION_EVENT, (payload) => {
        if (!isBrowserPreviewAnnotationEvent(payload) || payload.tabId !== tabId) return;
        lastEventRef.current = payload.operationId;
        eventReadRef.current?.();
      }),
    [tabId],
  );

  useEffect(() => {
    if (!annotationMode) return;
    let disposed = false;
    let polling = false;
    let again = false;
    const operationId = operationRef.current;
    // With native events the status loop is only a slower safety net
    // (missed event, page reload, older page runtime); without them it keeps
    // the original rapid poll.
    const intervalMs = operationId
      ? ANNOTATION_FALLBACK_POLL_INTERVAL_MS
      : ANNOTATION_POLL_INTERVAL_MS;
    const poll = async () => {
      if (disposed) return;
      if (polling) {
        again = true;
        return;
      }
      polling = true;
      try {
        const status = await getBrowserPreviewAnnotationStatus(tabId);
        if (!mountedRef.current || disposed) return;
        // A status for another operation (an older start) is not ours.
        if (operationId && status.operationId && status.operationId !== operationId) return;
        if (status.status === "active") return;
        // Handled once: the event and the fallback read may both see the end,
        // but only the first terminal answer for this operation acts.
        disposed = true;
        setAnnotationMode(false);
        if (status.status === "cancelled") return;
        if (status.status === "inactive") {
          toast.error("Annotation mode stopped", {
            description: "The preview changed or reloaded. Start annotation mode and try again.",
          });
          return;
        }
        if (status.status === "error") {
          toast.error("Could not capture browser annotation", { description: status.message });
          return;
        }
        if (!("screenshotDataUrl" in status)) return;
        setAnnotationSaving(true);
        try {
          await addSubmittedAnnotation(status);
        } catch (annotationError) {
          toast.error("Could not add browser annotation", {
            description: errorMessage(annotationError),
          });
        } finally {
          if (mountedRef.current) setAnnotationSaving(false);
        }
      } catch (annotationError) {
        if (!disposed) {
          disposed = true;
          setAnnotationMode(false);
          toast.error("Annotation mode stopped", { description: errorMessage(annotationError) });
        }
        void cancelBrowserPreviewAnnotation(tabId).catch(() => undefined);
      } finally {
        polling = false;
        if (again && !disposed) {
          again = false;
          void poll();
        }
      }
    };
    const onEvent = () => {
      if (operationId && lastEventRef.current === operationId) void poll();
    };
    eventReadRef.current = onEvent;
    const timer = window.setInterval(() => void poll(), intervalMs);
    void poll();
    // An event that arrived before the operation id was known.
    onEvent();
    return () => {
      disposed = true;
      if (eventReadRef.current === onEvent) eventReadRef.current = null;
      window.clearInterval(timer);
    };
  }, [addSubmittedAnnotation, annotationMode, tabId]);

  useEffect(() => {
    if (isActive || !annotationMode) return;
    setAnnotationMode(false);
    void cancelBrowserPreviewAnnotation(tabId).catch(() => undefined);
  }, [annotationMode, isActive, tabId]);

  useEffect(
    () => () => {
      if (!nativeBrowserPreview) return;
      void cancelBrowserPreviewAnnotation(tabId).catch(() => undefined);
    },
    [nativeBrowserPreview, tabId],
  );

  return {
    annotationMode,
    annotationSaving,
    toggleAnnotationMode,
    stopAnnotationForPageChange,
    mountedRef,
  };
}
