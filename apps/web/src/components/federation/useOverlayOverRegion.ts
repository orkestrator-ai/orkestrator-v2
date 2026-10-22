import { useEffect, useState } from "react";
import {
  BLOCKING_OVERLAY_SELECTOR,
  isBlockingOverlay,
} from "@/components/browser/browser-tab-hooks";

export type RegionRect = { x: number; y: number; width: number; height: number };

let nextEpisode = 1;

function overlaps(element: Element, rect: RegionRect): boolean {
  const box = element.getBoundingClientRect();
  return (
    box.width > 0 &&
    box.height > 0 &&
    box.left < rect.x + rect.width &&
    box.right > rect.x &&
    box.top < rect.y + rect.height &&
    box.bottom > rect.y
  );
}

/**
 * This window's own dialogs and menus that reach over `rect`.
 *
 * A native view paints above the page, so it has to step aside for an
 * overlay drawn where it is — but only for one that actually reaches it: a
 * sidebar menu that stays clear of the region leaves it alone. Overlays are
 * positioned after they mount and can move, so they are followed every frame
 * while one is open.
 *
 * Returns a number that changes each time an overlap starts, or `null` while
 * nothing overlaps (and while `rect` is `null`).
 */
export function useOverlayOverRegion(rect: RegionRect | null): number | null {
  const [episode, setEpisode] = useState<number | null>(null);
  useEffect(() => {
    if (!rect) return;
    let frame = 0;
    let overlapping = false;
    const check = () => {
      frame = 0;
      const overlays = Array.from(document.querySelectorAll(BLOCKING_OVERLAY_SELECTOR)).filter(
        isBlockingOverlay,
      );
      const now = overlays.some((element) => overlaps(element, rect));
      if (now !== overlapping) {
        overlapping = now;
        setEpisode(now ? nextEpisode++ : null);
      }
      if (overlays.length > 0) frame = requestAnimationFrame(check);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(check);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["aria-hidden", "data-state", "hidden", "role"],
      childList: true,
      subtree: true,
    });
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      if (overlapping) setEpisode(null);
    };
  }, [rect]);
  return rect ? episode : null;
}
