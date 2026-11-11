/**
 * Keeps the window's layout roots from being scrolled.
 *
 * `html`, `body`, `#root` and the shell's frame are `overflow: hidden`. That
 * removes their scrollbars and wheel scrolling, but not programmatic scrolling:
 * `scrollIntoView` and `focus()` without `preventScroll` scroll every ancestor
 * that has any overflow, and nothing ever scrolls these back. One stray call
 * while a descendant overflows shifts the whole window up and leaves the
 * bottom of it blank until the app restarts.
 *
 * These elements have no reason to be scrolled, so any scroll of one is undone
 * at once. The listener is a capturing one on the document, because `scroll`
 * does not bubble; it sees every element's scroll and ignores all but the
 * pinned ones.
 */

/** Marks an element whose scroll offset must stay at zero. */
export const PINNED_SCROLL_ATTRIBUTE = "data-pinned-scroll";

/** Spread onto an element to pin it: `<div {...pinnedScroll}>`. */
export const pinnedScroll = { [PINNED_SCROLL_ATTRIBUTE]: "" } as const;

function isPinned(element: Element, document: Document): boolean {
  return (
    element === document.documentElement ||
    element === document.body ||
    element.id === "root" ||
    element.hasAttribute(PINNED_SCROLL_ATTRIBUTE)
  );
}

/** Pins the layout roots of `document`. Returns the stop its owner calls. */
export function pinLayoutRootScroll(document: Document): () => void {
  const onScroll = (event: Event) => {
    // The viewport's scroll is reported on the document itself.
    const target =
      event.target === document ? document.scrollingElement : (event.target as Element | null);
    if (!target || !isPinned(target, document)) return;
    if (target.scrollTop !== 0) target.scrollTop = 0;
    if (target.scrollLeft !== 0) target.scrollLeft = 0;
  };
  document.addEventListener("scroll", onScroll, { capture: true, passive: true });
  return () => document.removeEventListener("scroll", onScroll, { capture: true });
}
