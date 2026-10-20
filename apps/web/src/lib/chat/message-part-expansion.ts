/**
 * Expansion state for a disclosure inside a transcript message.
 *
 * Transcripts render in a virtualized list, so a message is unmounted as soon
 * as it scrolls out of the viewport window. Local `useState` would silently
 * collapse whatever the reader opened and scrolled past (including when a
 * command's newly visible output changes the virtual row height), so the
 * authoritative flag lives in the shared store and the component rehydrates
 * from it on mount.
 *
 * Callers pass a key tied to the part's identity rather than to a render.
 * Where a part carries a durable provider id (a tool use id, a subagent id)
 * that is the anchor, because a streaming turn can shift a part's index out
 * from under it; the stable `partKey` is the fallback for parts that have no
 * such id.
 */

import { useCallback, useEffect, useMemo } from "react";
import {
  retainExpansionKey,
  useMessagePartExpansionStore,
} from "@/stores/messagePartExpansionStore";

export function useMessagePartExpansion(
  expansionKey: string | readonly string[],
): readonly [boolean, (open: boolean) => void] {
  // A coalescing group can change both endpoints at once. Any surviving member
  // restores it, and a toggle updates all aliases atomically (including close).
  const serializedKeys = JSON.stringify(
    typeof expansionKey === "string" ? [expansionKey] : expansionKey,
  );
  const keys = useMemo(() => JSON.parse(serializedKeys) as string[], [serializedKeys]);
  // Tell the store this disclosure is on screen for as long as the row is
  // mounted. The remembered-key set is capped, and evicting a key the reader
  // can currently see would collapse it under them — the very failure the
  // store exists to prevent. Off-screen keys stay evictable.
  useEffect(() => {
    const releases = keys.map(retainExpansionKey);
    return () => releases.forEach((release) => release());
  }, [keys]);

  const storedIsOpen = useMessagePartExpansionStore((state) =>
    keys.some((key) => state.expandedKeys.has(key)),
  );
  const setStoredExpanded = useMessagePartExpansionStore((state) => state.setExpanded);
  const setExpanded = useCallback(
    (open: boolean) => {
      setStoredExpanded(keys, open);
    },
    [keys, setStoredExpanded],
  );

  useEffect(() => {
    if (storedIsOpen) setStoredExpanded(keys, true);
  }, [keys, storedIsOpen, setStoredExpanded]);

  return [storedIsOpen, setExpanded] as const;
}
