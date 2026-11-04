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
import { useUIStore } from "@/stores/uiStore";

/** A little past the transition, so its last frame has landed before content is released. */
const SETTLE_MS = SIDEBAR_WIDTH_TRANSITION_MS + 40;

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
 * `sidebarMotionPins`), and releasing it fires one `resize`: a native preview
 * follows its host only on a resize, and its host moved without changing size.
 *
 * The full sidebar's width is kept in `uiStore.sidebarWidth` while it is
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

  const settle = useCallback(() => {
    if (settleTimer.current === null) return;
    clearTimeout(settleTimer.current);
    settleTimer.current = null;
    setPins(null);
    if (previousMode.current === "hidden") setContentShown(false);
    window.dispatchEvent(new Event("resize"));
  }, []);

  useLayoutEffect(() => {
    const previous = previousMode.current;
    if (previous === mode) return;
    previousMode.current = mode;

    const ui = useUIStore.getState();
    const panel = panelRef.current;
    let remembered = ui.sidebarWidth;
    if (previous === "full" && panel) {
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
      if (remembered !== ui.sidebarWidth) ui.setSidebarWidth(remembered);
    }
    const target = sidebarPanelWidth(mode, remembered);

    if (settleTimer.current !== null) clearTimeout(settleTimer.current);
    settleTimer.current = null;
    const dragging =
      sidebarElement?.parentElement?.querySelector('[data-separator="active"]') != null;
    if (sidebarElement && mainElement && shouldAnimateSidebarWidth({ reducedMotion, dragging })) {
      setPins(
        sidebarMotionPins({
          sidebarFrom: sidebarElement.getBoundingClientRect().width,
          sidebarTo: target,
          // The content may still be pinned by an interrupted transition.
          // Its panel is the authoritative available width.
          mainFrom: (mainElement.parentElement ?? mainElement).getBoundingClientRect().width,
        }),
      );
      settleTimer.current = setTimeout(settle, SETTLE_MS);
    } else {
      setPins(null);
      if (mode === "hidden") setContentShown(false);
    }

    // The new limits reach the group on its next render; restore after them.
    cancelAnimationFrame(restoreFrame.current);
    if (mode === "full") {
      restoreFrame.current = requestAnimationFrame(() => {
        try {
          panelRef.current?.resize(`${target}px`);
        } catch {
          // Not laid out yet; it opens at its default size instead.
        }
      });
    }
  }, [mainElement, mode, panelRef, reducedMotion, settle, sidebarElement]);

  useEffect(
    () => () => {
      cancelAnimationFrame(restoreFrame.current);
      if (settleTimer.current !== null) clearTimeout(settleTimer.current);
      settleTimer.current = null;
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
