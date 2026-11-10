import { useCallback, useEffect, useId, useRef, useState, type RefObject } from "react";

/** How far below the scroller's top a section heading lands after a jump. */
const JUMP_OFFSET_PX = 12;
/** Releases a jump's highlight where the browser fires no `scrollend`. Exported for tests. */
export const JUMP_SETTLE_FALLBACK_MS = 1000;

/**
 * Jumping to and tracking the sections of a key information view that scrolls
 * inside its own container (the header panel and the tab both do).
 *
 * `jumpTo` scrolls the container, not the page, so a panel floating over the
 * graph never moves the graph; the scroll is smooth unless the user asked for
 * reduced motion. `activeKey` is the section whose heading was last scrolled
 * past the container's top, or the last section once the container reaches
 * its end, so a short final section can still be the highlighted one. A jump
 * highlights its destination for the whole animation and keeps it once the
 * scroll settles, even when the container ran out of room before the heading
 * reached the top; the next scroll the user makes measures again.
 */
export function useKeyInformationSectionNav(
  scrollRef: RefObject<HTMLElement | null>,
  keys: readonly string[],
) {
  const idPrefix = useId();
  const sectionId = useCallback((key: string) => `${idPrefix}-${key}`, [idPrefix]);
  const [scrolledKey, setScrolledKey] = useState<string | undefined>(undefined);
  const keyList = keys.join("\u0000");
  // Set while a jump animates, holding the timer that releases it if the
  // browser never reports the scroll settling.
  const jumping = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => settleJump(jumping), []);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const sectionKeys = keyList ? keyList.split("\u0000") : [];
    let frame = 0;
    const measure = () => {
      frame = 0;
      if (jumping.current !== null) return;
      setScrolledKey((previous) => currentSection(scroller, sectionKeys, sectionId, previous));
    };
    const onScroll = () => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };
    const onScrollEnd = () => {
      if (jumping.current === null) return;
      settleJump(jumping);
      // The jump's last scroll frame must not replace its highlight.
      if (frame !== 0) cancelAnimationFrame(frame);
      frame = 0;
    };
    measure();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    scroller.addEventListener("scrollend", onScrollEnd);
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      scroller.removeEventListener("scrollend", onScrollEnd);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [scrollRef, keyList, sectionId]);

  const jumpTo = useCallback(
    (key: string) => {
      const scroller = scrollRef.current;
      const target = document.getElementById(sectionId(key));
      if (!scroller || !target) return;
      const top =
        scroller.scrollTop +
        target.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top -
        JUMP_OFFSET_PX;
      const destination = Math.min(
        Math.max(0, top),
        Math.max(0, scroller.scrollHeight - scroller.clientHeight),
      );
      // Highlight the destination at once rather than each section the
      // animation passes on the way.
      settleJump(jumping);
      setScrolledKey(key);
      if (Math.abs(destination - scroller.scrollTop) < 1) return;
      jumping.current = setTimeout(() => settleJump(jumping), JUMP_SETTLE_FALLBACK_MS);
      scroller.scrollTo?.({
        top: destination,
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
    },
    [scrollRef, sectionId],
  );

  const activeKey = scrolledKey !== undefined && keys.includes(scrolledKey) ? scrolledKey : keys[0];
  return { activeKey, jumpTo, sectionId };
}

function settleJump(jumping: RefObject<ReturnType<typeof setTimeout> | null>) {
  if (jumping.current === null) return;
  clearTimeout(jumping.current);
  jumping.current = null;
}

function currentSection(
  scroller: HTMLElement,
  keys: string[],
  sectionId: (key: string) => string,
  previous: string | undefined,
): string | undefined {
  if (keys.length === 0) return undefined;
  // Unscrolled, the reader is at the first section whatever the layout says;
  // this also covers a column not laid out yet, where every top reads as 0.
  if (scroller.scrollTop <= 0) return keys[0];
  if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) {
    return keys[keys.length - 1];
  }
  const line = scroller.getBoundingClientRect().top + JUMP_OFFSET_PX * 2;
  let row: string[] = [keys[0]!];
  let rowTop = -Infinity;
  for (const key of keys) {
    const element = document.getElementById(sectionId(key));
    if (!element) continue;
    const top = element.getBoundingClientRect().top;
    if (top > line) break;
    // Paired columns share a heading row. Keep its selected member until
    // another row takes over; entering a row defaults to its first heading.
    if (Math.abs(top - rowTop) <= 1) row.push(key);
    else {
      row = [key];
      rowTop = top;
    }
  }
  return previous !== undefined && row.includes(previous) ? previous : row[0];
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Scrolls a heading list just far enough to show its highlighted entry. Only
 * the list itself moves: `scrollIntoView` would also scroll every ancestor,
 * the page under a floating panel included.
 */
export function useKeepActiveEntryInView(
  listRef: RefObject<HTMLElement | null>,
  activeKey: string | undefined,
) {
  useEffect(() => {
    const list = listRef.current;
    const entry = list?.querySelector<HTMLElement>('[aria-current="location"]');
    if (!list || !entry) return;
    const listBox = list.getBoundingClientRect();
    const entryBox = entry.getBoundingClientRect();
    const left =
      entryBox.left < listBox.left
        ? entryBox.left - listBox.left
        : entryBox.right > listBox.right
          ? entryBox.right - listBox.right
          : 0;
    const top =
      entryBox.top < listBox.top
        ? entryBox.top - listBox.top
        : entryBox.bottom > listBox.bottom
          ? entryBox.bottom - listBox.bottom
          : 0;
    if (left !== 0 || top !== 0) list.scrollBy?.({ left, top });
  }, [listRef, activeKey]);
}
