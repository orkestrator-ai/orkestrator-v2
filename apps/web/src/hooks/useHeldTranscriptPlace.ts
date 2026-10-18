import { useLayoutEffect, useState } from "react";
import { getNativeMessageBoundarySourceId } from "@/lib/chat/native-message-adapters";
import type { NativeMessage } from "@/lib/chat/native-message-types";

/** A display row as it can be found again: its own id and its last source row. */
interface RowIdentity {
  id: string;
  lastSourceId: string;
}

function identityOf(row: NativeMessage): RowIdentity {
  return { id: row.id, lastSourceId: getNativeMessageBoundarySourceId(row) };
}

/**
 * The reader's place in a transcript, held while earlier history loads above it.
 *
 * The transcript list keeps its scroll offset when rows are prepended, so a
 * loaded page pushes the row the reader was on down by the page's height; with
 * tall rows it leaves the viewport and the reader has to find their place
 * again. `hold` records the first rendered row when a load starts, and the
 * first render that shows that row below the top scrolls back to it
 * ({@link useRestoreHeldPlace}).
 *
 * The row is found by its id or by its last source row. Display rows coalesce
 * same-minute tool calls into one block named after its first row, so a page
 * that ends in the same minute merges into the head block and renames it; the
 * block still ends with the row it ended with.
 *
 * A held place waits while its row is still first (the page is in flight, or
 * it brought nothing new) and is dropped when the row leaves the transcript (a
 * reset replaced the history). Nothing else prepends rows, so a place left
 * waiting after an empty load is either replaced by the next load or unused.
 */
export class HeldTranscriptPlace {
  private held: RowIdentity | null = null;
  private first: RowIdentity | null = null;

  /** Remember the row now first on screen. */
  hold(): void {
    this.held = this.first;
  }

  /** Forget a held place, e.g. when the history it belongs to is dropped. */
  release(): void {
    this.held = null;
  }

  /** Records this render's first row; answers where to scroll if the held row moved down. */
  resolve(messages: readonly NativeMessage[]): number | undefined {
    const held = this.held;
    this.first = messages[0] ? identityOf(messages[0]) : null;
    if (!held) return undefined;
    const index = messages.findIndex((message) => {
      const identity = identityOf(message);
      return identity.id === held.id || identity.lastSourceId === held.lastSourceId;
    });
    if (index === 0) return undefined;
    this.held = null;
    return index > 0 ? index : undefined;
  }
}

/** One stable place per mounted transcript view. */
export function useHeldTranscriptPlace(): HeldTranscriptPlace {
  return useState(() => new HeldTranscriptPlace())[0];
}

/** Scrolls back to a held place once the rows above it have rendered. */
export function useRestoreHeldPlace(
  place: HeldTranscriptPlace,
  messages: readonly NativeMessage[],
  scrollToIndex: (index: number) => unknown,
): void {
  useLayoutEffect(() => {
    const index = place.resolve(messages);
    if (index !== undefined) scrollToIndex(index);
  }, [messages, place, scrollToIndex]);
}
