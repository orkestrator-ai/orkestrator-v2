import { useEffect, useState } from "react";

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
