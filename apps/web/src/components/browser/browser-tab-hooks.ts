import { useCallback, useEffect, useState, type RefObject } from "react";

import { usePaneLayoutStore } from "@/stores/paneLayoutStore";

export const BLOCKING_OVERLAY_SELECTOR = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
].join(",");

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

export function isBlockingOverlay(element: Element): boolean {
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

/**
 * Cmd/Ctrl+L focuses and selects a browser tab's address field: from the app
 * window, and from inside the tab's native preview, where main intercepts the
 * key (`browser-preview-focus-address`) because the view has keyboard focus.
 */
export function useAddressBarShortcut({
  tabId,
  environmentId,
  isActive,
  enabled,
  inputRef,
}: {
  tabId: string;
  environmentId: string;
  isActive: boolean;
  enabled: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
}): () => void {
  const setActivePane = usePaneLayoutStore((state) => state.setActivePane);
  const activePaneId = usePaneLayoutStore(
    (state) => state.environments.get(environmentId)?.activePaneId,
  );
  const owningPaneId = usePaneLayoutStore(
    (state) => state.findPaneWithTab(tabId, environmentId)?.id,
  );
  const focusAddressBar = useCallback(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [inputRef]);

  useEffect(() => {
    if (!isActive || !enabled) return;

    return window.orkestrator?.listen<string>("browser-preview-focus-address", (requestedTabId) => {
      if (requestedTabId !== tabId) return;
      if (owningPaneId) {
        setActivePane(owningPaneId, environmentId);
      }
      focusAddressBar();
    });
  }, [enabled, environmentId, focusAddressBar, isActive, owningPaneId, setActivePane, tabId]);

  useEffect(() => {
    if (!enabled || !isActive || activePaneId !== owningPaneId) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const isAddressShortcut =
        event.key.toLowerCase() === "l" &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey;
      if (!isAddressShortcut) return;

      event.preventDefault();
      focusAddressBar();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [activePaneId, enabled, focusAddressBar, isActive, owningPaneId]);

  return focusAddressBar;
}
