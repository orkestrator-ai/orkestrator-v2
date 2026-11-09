import { useCallback, useEffect, useState } from "react";

/**
 * Whether an element is at least `minWidth` CSS pixels wide, for layouts that
 * change structure (not just styles) with the space they are given, which a
 * container query cannot do.
 *
 * Attach the returned callback ref to the element to measure. A zero width is
 * ignored: it means the element, or an ancestor, is `display: none` (another
 * tab is showing), and switching layout then would remount content the reader
 * will come back to. Without a ResizeObserver the answer stays `false`.
 */
export function useWidthAtLeast<T extends HTMLElement>(
  minWidth: number,
): [(element: T | null) => void, boolean] {
  const [element, setElement] = useState<T | null>(null);
  const [wide, setWide] = useState(false);

  // Measured as the element attaches, so the first paint already has the
  // right layout: a state update from a ref callback is flushed before paint.
  const ref = useCallback(
    (next: T | null) => {
      setElement(next);
      if (!next) return;
      const width = next.getBoundingClientRect().width;
      if (width > 0) setWide(width >= minWidth);
    },
    [minWidth],
  );

  useEffect(() => {
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const width = element.getBoundingClientRect().width;
      if (width > 0) setWide(width >= minWidth);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, minWidth]);

  return [ref, wide];
}
