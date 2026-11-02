import { useLayoutEffect, type RefObject } from "react";

function syncToTimelineOrigin(element: Element): void {
  for (const animation of element.getAnimations()) {
    if (animation.startTime !== 0) animation.startTime = 0;
  }
}

/**
 * Pins every CSS animation running on an element to the start of the document
 * timeline, so repeated indicators (the sidebar's working spinners, waiting
 * pulses) turn in step however far apart they started. A CSS animation
 * otherwise starts its own clock when its class is applied, which leaves each
 * row's spinner at a different angle.
 *
 * The layout effect catches the animation `key` brings in before it paints;
 * the `animationstart` listener catches ones that start later without a render
 * (a reduced-motion or forced-colours preference being lifted).
 */
export function useTimelineSyncedAnimations(
  ref: RefObject<Element | null>,
  key: string | undefined,
): void {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof element.getAnimations !== "function") return;
    syncToTimelineOrigin(element);
  }, [ref, key]);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof element.getAnimations !== "function") return;
    const resync = () => syncToTimelineOrigin(element);
    element.addEventListener("animationstart", resync);
    return () => element.removeEventListener("animationstart", resync);
  }, [ref]);
}
