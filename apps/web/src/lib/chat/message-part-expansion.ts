/**
 * Expansion state for a disclosure inside a transcript message.
 *
 * Transcripts render in a virtualized list, so a message is unmounted as soon
 * as it scrolls out of the viewport window. Local `useState` would silently
 * collapse whatever the reader opened and scrolled past, so the authoritative
 * flag lives in the shared store and the component rehydrates from it on mount.
 *
 * Callers pass a key derived from the stable `partKey` their part was given,
 * which keeps the identity tied to the part's position rather than to a render.
 */

import { useCallback } from "react";
import { useMessagePartExpansionStore } from "@/stores/messagePartExpansionStore";

export function useMessagePartExpansion(
  expansionKey: string,
): readonly [boolean, (open: boolean) => void] {
  const storedIsOpen = useMessagePartExpansionStore((state) =>
    state.expandedKeys.has(expansionKey),
  );
  const setStoredExpanded = useMessagePartExpansionStore(
    (state) => state.setExpanded,
  );
  const setExpanded = useCallback(
    (open: boolean) => {
      setStoredExpanded(expansionKey, open);
    },
    [expansionKey, setStoredExpanded],
  );

  return [storedIsOpen, setExpanded] as const;
}
