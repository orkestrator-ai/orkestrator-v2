/**
 * Find integration for rich blocks: which DOM text counts, and how a match in
 * hidden content is revealed.
 *
 * Text inside `[data-rich-chrome]` (toolbars, labels, notices) or
 * `[data-rich-search-exclude]` (a rendered diagram's SVG labels, a chart's
 * drawing) is not searchable. Content that is not on screen — a collapsed
 * disclosure body, a diagram's source while the preview shows — is present
 * as a hidden mirror (`[data-rich-search-mirror]`) with exactly the text the
 * revealed view will contain, so occurrence ordinals line up with the
 * message-model projection whether or not it is revealed.
 *
 * Reveal is temporary: find sets the block's `findRevealed` view flag, and
 * clears it again when the selected match moves elsewhere or find closes. A
 * block whose user toggles it during a reveal clears the flag itself, so the
 * user's choice survives.
 */
import { useCallback } from "react";
import { useRichContentViewStore, useRichViewField } from "@/stores/richContentViewStore";

export const SEARCH_EXCLUDE_SELECTOR = "[data-rich-chrome],[data-rich-search-exclude]";
export const SEARCH_MIRROR_SELECTOR = "[data-rich-search-mirror]";

export interface SearchTextRun {
  node: Text;
  start: number;
  end: number;
}

/** Searchable text nodes under `root`, in document order, skipping chrome. */
export function collectSearchTextRuns(root: HTMLElement): { text: string; runs: SearchTextRun[] } {
  const runs: SearchTextRun[] = [];
  let text = "";
  const document = root.ownerDocument;
  const view = document.defaultView;
  const elementType = view?.Node.ELEMENT_NODE ?? 1;
  const walker = document.createTreeWalker(root, 0x1 | 0x4 /* SHOW_ELEMENT | SHOW_TEXT */, {
    acceptNode(node) {
      if (node.nodeType === elementType) {
        // Reject skips the whole subtree; skip descends into it.
        return (node as Element).matches(SEARCH_EXCLUDE_SELECTOR) ? 2 : 3;
      }
      return 1;
    },
  });
  let current = walker.nextNode();
  while (current) {
    if (current.nodeType !== elementType) {
      const data = (current as Text).data;
      if (data.length > 0) {
        const start = text.length;
        text += data;
        runs.push({ node: current as Text, start, end: text.length });
      }
    }
    current = walker.nextNode();
  }
  return { text, runs };
}

/** The searchable text of one search root (what find indexes for it). */
export function searchRootText(root: HTMLElement): string {
  return collectSearchTextRuns(root).text;
}

/** The hidden mirror holding `node`, if the node is not actually on screen. */
export function hiddenMirrorFor(node: Node): HTMLElement | null {
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest<HTMLElement>(SEARCH_MIRROR_SELECTOR) ?? null;
}

/** Block key → the find instance (transcript pane) that revealed it. */
const revealedByFind = new Map<string, string>();

/** Temporarily reveal a block for the find instance `owner`. */
export function revealRichBlockForFind(key: string, owner: string): void {
  revealedByFind.set(key, owner);
  useRichContentViewStore.getState().update(key, { findRevealed: true });
}

/**
 * Undo `owner`'s find reveals, except those in `keep` (the selected match's
 * blocks). Another pane's reveals are left alone.
 */
export function restoreRichFindReveals(owner: string, keep: ReadonlySet<string> = new Set()): void {
  const { update } = useRichContentViewStore.getState();
  for (const [key, revealer] of Array.from(revealedByFind.entries())) {
    if (revealer !== owner || keep.has(key)) continue;
    revealedByFind.delete(key);
    update(key, { findRevealed: false });
  }
}

export function richFindRevealedKeys(): ReadonlySet<string> {
  return new Set(revealedByFind.keys());
}

/**
 * A block's find-reveal flag plus a way for a deliberate user toggle to end
 * the temporary reveal (so restoring after find does not undo the user).
 */
export function useFindReveal(key: string): { revealed: boolean; endReveal: () => void } {
  const [revealed, setRevealed] = useRichViewField(key, "findRevealed", false);
  const endReveal = useCallback(() => {
    revealedByFind.delete(key);
    setRevealed(false);
  }, [key, setRevealed]);
  return { revealed, endReveal };
}
