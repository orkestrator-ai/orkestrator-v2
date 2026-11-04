import { sameTranscriptJson } from "@/lib/chat/same-transcript-json";

function itemKey(item: unknown, index: number): unknown {
  const id = (item as { id?: unknown } | null | undefined)?.id;
  return typeof id === "string" ? id : index;
}

/**
 * Each transcript row's search text while find is open, reused until the row
 * changes, so an update re-indexes only the rows it touched. Holds one entry per
 * current row; the rows it drops go with the next pass.
 *
 * The text cache behind `getSearchText` cannot do this alone: it is bounded for
 * the whole window, so a transcript with more text parts than it holds evicts
 * its own entries and re-parses all of its Markdown on every pass. A reparsed
 * row is a new object with the same content, hence the comparison.
 */
export class AgentChatSearchIndex<TItem> {
  private entries = new Map<unknown, { item: TItem; text: string }>();
  private getSearchText: ((item: TItem) => string) | null = null;

  texts(items: readonly TItem[], getSearchText: (item: TItem) => string): string[] {
    if (getSearchText !== this.getSearchText) {
      this.entries.clear();
      this.getSearchText = getSearchText;
    }
    const next = new Map<unknown, { item: TItem; text: string }>();
    const texts = items.map((item, index) => {
      const key = itemKey(item, index);
      const held = this.entries.get(key);
      const text =
        held && (held.item === item || sameTranscriptJson(held.item, item))
          ? held.text
          : getSearchText(item);
      next.set(key, { item, text });
      return text;
    });
    this.entries = next;
    return texts;
  }

  clear(): void {
    this.entries.clear();
    this.getSearchText = null;
  }
}
