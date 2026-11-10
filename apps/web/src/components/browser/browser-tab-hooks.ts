import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { commandClient } from "@/lib/node-scope/app-window-scope";

export const BLOCKING_OVERLAY_SELECTOR = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
].join(",");

/*
 * Toolbar layout shared by service and manual browser tabs, sized against the
 * pane (`@container/browser`), not the window. Below `@2xl` (42rem, 672 px)
 * the address form takes a full-width second row and the buttons share the
 * first; the narrowest window (800×600) gives a 519 px pane. From `@2xl` it
 * is one row with at least 10rem for the address, and the service picker
 * shrinks before the address does.
 */
export const BROWSER_TOOLBAR_CLASS =
  "flex min-w-0 shrink-0 flex-wrap items-center gap-1.5 border-b border-border/80 bg-muted/25 px-2 py-1.5 @2xl/browser:flex-nowrap";
export const BROWSER_ADDRESS_FORM_CLASS =
  "order-last flex w-full min-w-0 basis-full items-center @2xl/browser:order-none @2xl/browser:w-auto @2xl/browser:basis-0 @2xl/browser:flex-1";
export const BROWSER_ADDRESS_INPUT_CLASS =
  "h-full min-w-[min(10rem,60%)] flex-1 bg-transparent px-2.5 font-mono text-xs text-foreground outline-none placeholder:font-sans placeholder:text-muted-foreground";
export const BROWSER_TOOLBAR_ACTIONS_CLASS = "ml-auto flex shrink-0 items-center gap-1.5";

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

function hasLayout(rect: DOMRect): boolean {
  return rect.width > 0 && rect.height > 0;
}

/**
 * Whether an overlay covers any of the native view's area. Only a measurable
 * overlay that provably misses a measurable host is let through: an element
 * without layout yet (or a host that is not laid out) counts as covering, so
 * an unknown geometry still hides the view rather than painting over the UI.
 */
export function overlayCoversHost(overlay: Element, host: Element | null | undefined): boolean {
  if (!host) return true;
  const hostRect = host.getBoundingClientRect();
  const overlayRect = overlay.getBoundingClientRect();
  if (!hasLayout(hostRect) || !hasLayout(overlayRect)) return true;
  return (
    overlayRect.left < hostRect.right &&
    hostRect.left < overlayRect.right &&
    overlayRect.top < hostRect.bottom &&
    hostRect.top < overlayRect.bottom
  );
}

function hasVisuallyBlockingOverlay(host: Element | null | undefined): boolean {
  return Array.from(document.querySelectorAll(BLOCKING_OVERLAY_SELECTOR)).some(
    (overlay) => isBlockingOverlay(overlay) && overlayCoversHost(overlay, host),
  );
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
 *
 * With `hostRef`, only an overlay that overlaps the host (the area the native
 * view occupies) counts: a slash-command or mention listbox open in the chat
 * pane beside the preview leaves it showing. Geometry is rechecked as overlays
 * move (Floating UI positions them through `style`), and as the host resizes
 * or anything scrolls. Without `hostRef`, any open overlay in the document
 * blocks.
 */
export function useBlockingOverlay(enabled: boolean, hostRef?: RefObject<Element | null>): boolean {
  const [hasBlockingOverlay, setHasBlockingOverlay] = useState(false);
  const tracksGeometry = hostRef !== undefined;
  useEffect(() => {
    if (!enabled) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      setHasBlockingOverlay(hasVisuallyBlockingOverlay(hostRef?.current));
    };
    // Geometry changes arrive in bursts (scrolling, streaming layout); one
    // document scan per frame is enough for them.
    const scheduleUpdate = () => {
      if (frame === 0) frame = requestAnimationFrame(update);
    };
    const updateAfterOverlayMotion = (event: Event) => {
      if (event.target instanceof Element && event.target.matches(BLOCKING_OVERLAY_SELECTOR)) {
        update();
      }
    };
    const observer = new MutationObserver((records) => {
      const onlyStyle =
        records.length > 0 &&
        records.every((record) => record.type === "attributes" && record.attributeName === "style");
      if (onlyStyle) scheduleUpdate();
      else update();
    });
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: tracksGeometry
        ? ["aria-hidden", "data-state", "hidden", "role", "style"]
        : ["aria-hidden", "data-state", "hidden", "role"],
      childList: true,
      subtree: true,
    });
    for (const eventName of OVERLAY_MOTION_EVENTS) {
      document.addEventListener(eventName, updateAfterOverlayMotion, true);
    }
    const host = hostRef?.current;
    const resizeObserver =
      tracksGeometry && host && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(scheduleUpdate)
        : null;
    if (host) resizeObserver?.observe(host);
    if (tracksGeometry) {
      window.addEventListener("resize", scheduleUpdate);
      window.addEventListener("scroll", scheduleUpdate, true);
    }
    update();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      resizeObserver?.disconnect();
      for (const eventName of OVERLAY_MOTION_EVENTS) {
        document.removeEventListener(eventName, updateAfterOverlayMotion, true);
      }
      if (tracksGeometry) {
        window.removeEventListener("resize", scheduleUpdate);
        window.removeEventListener("scroll", scheduleUpdate, true);
      }
    };
  }, [enabled, hostRef, tracksGeometry]);
  return hasBlockingOverlay;
}

/**
 * Hides a native view when the effect that attached it is torn down for good,
 * but not when that effect merely re-runs.
 *
 * React runs a re-render's cleanup and the next setup in the same commit. If
 * the cleanup hid the view straight away, it stayed hidden until the next
 * setup's attach came back from main, one animation frame plus a round trip
 * later (longer for a service preview, whose attach waits on the tunnel), so
 * every dependency change flashed the page away. It also ended any
 * annotation selection, which a hide does. The cleanup calls `release`, which
 * hides on a microtask; the next setup's `claim` for the same tab cancels it,
 * and that setup's own attach then applies the visibility it wants.
 */
export function useDeferredPreviewHide(): {
  claim: (tabId: string) => void;
  release: (tabId: string, hide: () => void) => void;
} {
  const pendingRef = useRef<string | null>(null);
  const claim = useCallback((tabId: string) => {
    if (pendingRef.current === tabId) pendingRef.current = null;
  }, []);
  const release = useCallback((tabId: string, hide: () => void) => {
    pendingRef.current = tabId;
    queueMicrotask(() => {
      if (pendingRef.current !== tabId) return;
      pendingRef.current = null;
      hide();
    });
  }, []);
  return { claim, release };
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

    return commandClient().listenRaw<string>("browser-preview-focus-address", (requestedTabId) => {
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
