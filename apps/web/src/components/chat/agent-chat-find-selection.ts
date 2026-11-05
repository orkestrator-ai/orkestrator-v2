import { rootAt, type SearchProjection } from "@/lib/chat/rich-markdown/search-segments";
import type { AgentChatFindMatch } from "./AgentChatFind";
import { itemKey } from "./agent-chat-search-index";

/**
 * The selected Find match, by what it is rather than where it is in the list:
 * its row, the source inside the row and the offset inside that source. A body
 * arriving moves every later match along in the count, and moves the matches
 * after it in the same row along in the row's text, but none of these change.
 * It holds no text, so it needs no clearing with protected content.
 */
export interface AgentChatFindSelection {
  key: unknown;
  /** Null when the row's text has one source, so `offset` is into the whole text. */
  root: string | null;
  offset: number;
  /** Where it last was in the list, for when it is gone. */
  index: number;
}

type ProjectionOf<TItem> = ((item: TItem) => SearchProjection) | undefined;

export function selectionOfMatch<TItem>(
  match: AgentChatFindMatch,
  index: number,
  items: readonly TItem[],
  getSearchProjection: ProjectionOf<TItem>,
): AgentChatFindSelection {
  const item = items[match.itemIndex]!;
  const root = rootAt(getSearchProjection?.(item).roots, match.characterIndex);
  return {
    key: itemKey(item, match.itemIndex),
    root: root?.key ?? null,
    offset: root ? match.characterIndex - root.start : match.characterIndex,
    index,
  };
}

/** Where `selection` now starts in `item`'s text; null when its source has gone. */
function selectionCharacterIndex<TItem>(
  selection: AgentChatFindSelection,
  item: TItem,
  getSearchProjection: ProjectionOf<TItem>,
): number | null {
  if (selection.root === null) return selection.offset;
  const root = getSearchProjection?.(item).roots?.find(({ key }) => key === selection.root);
  return root ? root.start + selection.offset : null;
}

/**
 * The selection's place in a recomputed list. With nothing selected yet, the
 * first match is selected and pinned, so later text cannot take it away. A
 * selection whose match has gone falls to whatever now holds its old place.
 */
export function resolveFindSelection<TItem>(
  selection: AgentChatFindSelection | null,
  matches: readonly AgentChatFindMatch[],
  items: readonly TItem[],
  getSearchProjection: ProjectionOf<TItem>,
): { index: number; selection: AgentChatFindSelection | null } {
  if (matches.length === 0) return { index: -1, selection };
  if (!selection) {
    return { index: 0, selection: selectionOfMatch(matches[0]!, 0, items, getSearchProjection) };
  }
  let row = -1;
  let characterIndex: number | null = null;
  const found = matches.findIndex((match) => {
    if (match.itemIndex !== row) {
      row = match.itemIndex;
      const item = items[row]!;
      characterIndex =
        itemKey(item, row) === selection.key
          ? selectionCharacterIndex(selection, item, getSearchProjection)
          : null;
    }
    return match.characterIndex === characterIndex;
  });
  if (found >= 0) {
    return {
      index: found,
      selection: found === selection.index ? selection : { ...selection, index: found },
    };
  }
  const index = Math.min(selection.index, matches.length - 1);
  return { index, selection: selectionOfMatch(matches[index]!, index, items, getSearchProjection) };
}
