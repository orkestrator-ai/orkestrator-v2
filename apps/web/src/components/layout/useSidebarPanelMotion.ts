import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePanelRef } from "react-resizable-panels";
import {
  rememberedSidebarWidth,
  shouldAnimateSidebarWidth,
  sidebarMotionPins,
  sidebarPanelWidth,
  SIDEBAR_WIDTH_TRANSITION_MS,
  type SidebarPanelMode,
} from "@/lib/sidebar-width";
import { useUIChromeStore } from "@/stores/uiChromeStore";

/**
 * A little past the transition, so its last frame has landed before content
 * is released. Exported for tests.
 */
export const SIDEBAR_SETTLE_MS = SIDEBAR_WIDTH_TRANSITION_MS + 40;

/**
 * The sidebar panel's width transitions that have not finished. The settle
 * timer starts when the mode changes, but a loaded renderer can start the
 * transition itself a frame or more later; releasing the pins while it still
 * runs lays the content out at an intermediate width (flake 4290).
 */
function unfinishedWidthTransitions(element: HTMLElement | null): Animation[] {
  if (!element || typeof element.getAnimations !== "function") return [];
  return element
    .getAnimations()
    .filter(
      (animation) =>
        (animation as Animation & { transitionProperty?: string }).transitionProperty ===
          "flex-grow" && animation.playState !== "finished",
    );
}

export interface SidebarMotionPins {
  sidebar: number;
  main: number;
}

/**
 * Moves the desktop sidebar panel between its full, compact and hidden widths.
 *
 * `index.css` animates the panels' `flex-grow` while the group carries
 * `data-sidebar-width-animating`, so a drag (which never sets it) follows the
 * pointer. Content is held at a fixed width for the duration (see
 * `sidebarMotionPins`), and a frame after releasing it one `resize` fires: a
 * native preview follows its host only on a resize, and its host moved without
 * changing size.
 *
 * The full sidebar's width is kept in `uiChromeStore.sidebarWidth` while it is
 * compact or hidden, so leaving either restores it, across reloads too.
 */
export function useSidebarPanelMotion(input: {
  mode: SidebarPanelMode;
  reducedMotion: boolean;
  sidebarElement: HTMLElement | null;
  mainElement: HTMLElement | null;
}) {
  const { mode, reducedMotion, sidebarElement, mainElement } = input;
  const panelRef = usePanelRef();
  const [pins, setPins] = useState<SidebarMotionPins | null>(null);
  // A hidden sidebar's content stays until the panel has finished closing.
  const [contentShown, setContentShown] = useState(mode !== "hidden");
  if (mode !== "hidden" && !contentShown) setContentShown(true);
  const previousMode = useRef(mode);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restoreFrame = useRef(0);
  const releaseFrame = useRef(0);
  /** Bumped by every width change, so a deferred release cannot settle a later one. */
  const motionGeneration = useRef(0);
  /** The `full` width is applied a frame after the change; the motion starts then. */
  const restorePending = useRef(false);
  /** The settle timer fired before that frame; arm it again once the width is applied. */
  const settleAfterRestore = useRef<(() => void) | null>(null);

  const settle = useCallback(() => {
    if (settleTimer.current === null) return;
    clearTimeout(settleTimer.current);
    settleTimer.current = null;
    settleAfterRestore.current = null;
    setPins(null);
    if (previousMode.current === "hidden") setContentShown(false);
    // A frame on, once the release is laid out: a terminal's fit from this event
    // and from its own ResizeObserver are then one fit, and one PTY resize.
    cancelAnimationFrame(releaseFrame.current);
    releaseFrame.current = requestAnimationFrame(() => {
      window.dispatchEvent(new Event("resize"));
    });
  }, []);

  useLayoutEffect(() => {
    const previous = previousMode.current;
    if (previous === mode) return;
    previousMode.current = mode;

    const chrome = useUIChromeStore.getState();
    const panel = panelRef.current;
    let remembered = chrome.sidebarWidth;
    // Reversals can revisit logical full while the visible width is still in
    // flight. Only a settled full panel represents the user's chosen width.
    if (previous === "full" && panel && settleTimer.current === null) {
      // A panel that mounts with this change (a window widening out of the
      // phone layout) registers with its group after this effect, and reading
      // its size before then throws. It has no width of the user's to keep yet.
      let measured: number | null = null;
      try {
        measured = panel.getSize().inPixels;
      } catch {
        // Not laid out yet.
      }
      remembered = rememberedSidebarWidth(remembered, measured);
      if (remembered !== chrome.sidebarWidth) chrome.setSidebarWidth(remembered);
    }
    const target = sidebarPanelWidth(mode, remembered);

    if (settleTimer.current !== null) clearTimeout(settleTimer.current);
    settleTimer.current = null;
    settleAfterRestore.current = null;
    const generation = ++motionGeneration.current;
    // Release the pins once the transition has run: a fixed time after it
    // starts, and never while the panel is still moving.
    const armSettle = () => {
      settleTimer.current = setTimeout(() => {
        if (motionGeneration.current !== generation) return;
        if (restorePending.current) {
          settleAfterRestore.current = armSettle;
          return;
        }
        const running = unfinishedWidthTransitions(sidebarElement);
        if (running.length === 0) {
          settle();
          return;
        }
        void Promise.all(running.map((animation) => animation.finished.catch(() => null))).then(
          () => {
            if (motionGeneration.current === generation) settle();
          },
        );
      }, SIDEBAR_SETTLE_MS);
    };
    const dragging =
      sidebarElement?.parentElement?.querySelector('[data-separator="active"]') != null;
    if (sidebarElement && mainElement && shouldAnimateSidebarWidth({ reducedMotion, dragging })) {
      setPins(
        sidebarMotionPins({
          sidebarFrom: sidebarElement.getBoundingClientRect().width,
          zoom: (() => {
            const value = getComputedStyle(document.documentElement).zoom;
            const parsed = Number.parseFloat(value);
            return Number.isFinite(parsed) && parsed > 0
              ? parsed / (value.endsWith("%") ? 100 : 1)
              : 1;
          })(),
          sidebarTo: target,
          // The content may still be pinned by an interrupted transition.
          // Its panel is the authoritative available width.
          mainFrom: (mainElement.parentElement ?? mainElement).getBoundingClientRect().width,
          // A hidden sidebar has no handle: it has just mounted, or goes on release.
          separator:
            previous === "hidden" || mode === "hidden"
              ? sidebarElement.nextElementSibling?.matches("[data-separator]")
                ? sidebarElement.nextElementSibling.getBoundingClientRect().width
                : 0
              : 0,
        }),
      );
      armSettle();
    } else {
      setPins(null);
      if (mode === "hidden") setContentShown(false);
    }

    // The new limits reach the group on its next render; restore after them.
    cancelAnimationFrame(restoreFrame.current);
    restorePending.current = false;
    if (mode === "full") {
      restorePending.current = true;
      restoreFrame.current = requestAnimationFrame(() => {
        restorePending.current = false;
        try {
          panelRef.current?.resize(`${target}px`);
        } catch {
          // Not laid out yet; it opens at its default size instead.
        }
        const rearm = settleAfterRestore.current;
        settleAfterRestore.current = null;
        if (rearm && motionGeneration.current === generation) rearm();
      });
    }
  }, [mainElement, mode, panelRef, reducedMotion, settle, sidebarElement]);

  useEffect(
    () => () => {
      cancelAnimationFrame(restoreFrame.current);
      cancelAnimationFrame(releaseFrame.current);
      if (settleTimer.current !== null) clearTimeout(settleTimer.current);
      settleTimer.current = null;
      settleAfterRestore.current = null;
      motionGeneration.current += 1;
    },
    [],
  );

  return {
    panelRef,
    pins,
    animating: pins !== null,
    contentShown,
    /** Grabbing a resize handle mid-animation hands the width to the pointer. */
    settleNow: settle,
  };
}
