/**
 * Which images the gallery can step through: every mounted image of one
 * message (attachments, provider images, viewed-image previews and Markdown
 * images), in document order. Items register while mounted and resolve their
 * bytes only when the gallery shows them. Bounded by what is mounted.
 */
import { useEffect, useRef } from "react";

export interface GalleryItem {
  title: string;
  element: () => HTMLElement | null;
  load: () => Promise<string | null>;
}

const groups = new Map<string, Set<GalleryItem>>();

export function registerGalleryItem(group: string, item: GalleryItem): () => void {
  let members = groups.get(group);
  if (!members) {
    members = new Set();
    groups.set(group, members);
  }
  members.add(item);
  return () => {
    const current = groups.get(group);
    current?.delete(item);
    if (current && current.size === 0) groups.delete(group);
  };
}

/** Mounted items of `group` in document order. */
export function galleryItems(group: string): GalleryItem[] {
  const members = Array.from(groups.get(group) ?? []).filter((item) => item.element()?.isConnected);
  return members.sort((a, b) => {
    const left = a.element();
    const right = b.element();
    if (!left || !right || left === right) return 0;
    // DOCUMENT_POSITION_FOLLOWING = 4: `right` comes after `left`.
    return left.compareDocumentPosition(right) & 4 ? -1 : 1;
  });
}

/** Register a mounted image with its message's gallery. */
export function useGalleryItem(
  group: string,
  enabled: boolean,
  item: { title: string; element: () => HTMLElement | null; load: () => Promise<string | null> },
): void {
  const latest = useRef(item);
  useEffect(() => {
    latest.current = item;
  });
  useEffect(() => {
    if (!enabled) return;
    return registerGalleryItem(group, {
      get title() {
        return latest.current.title;
      },
      element: () => latest.current.element(),
      load: () => latest.current.load(),
    });
  }, [enabled, group]);
}
