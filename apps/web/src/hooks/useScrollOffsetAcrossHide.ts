import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";

/**
 * Keeps a scroller's offset while it, or an ancestor, is `display: none`.
 *
 * WebKit forgets the offset of a scroller that is, or holds, a container query
 * container: the layout that shows it again resets it to 0 and fires `scroll`
 * before any ResizeObserver runs, with the element already measurable. The
 * offset is put back from the observer, so nothing paints at the top.
 *
 * Returns whether the scroller is hidden. A scroll handler must ignore events
 * while it is: that scroll is the browser's, not the reader's. A later observer
 * on the same element runs after the offset is back, so call this hook first to
 * move the scroller somewhere else on show.
 */
export function useScrollOffsetAcrossHide(scrollRef: RefObject<HTMLElement | null>): () => boolean {
  const hidden = useRef(false);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    let offset = element.scrollTop;
    hidden.current = element.clientHeight === 0;
    const onScroll = () => {
      if (element.clientHeight === 0) hidden.current = true;
      if (!hidden.current) offset = element.scrollTop;
    };
    const observer = new ResizeObserver(() => {
      if (element.clientHeight === 0) {
        hidden.current = true;
      } else if (hidden.current) {
        hidden.current = false;
        element.scrollTop = offset;
      }
    });
    element.addEventListener("scroll", onScroll, { passive: true });
    observer.observe(element);
    return () => {
      element.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, [scrollRef]);

  return useCallback(() => hidden.current || scrollRef.current?.clientHeight === 0, [scrollRef]);
}
