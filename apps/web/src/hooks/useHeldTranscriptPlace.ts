import { useLayoutEffect, useState } from "react";
import { getNativeMessageBoundarySourceId } from "@/lib/chat/native-message-adapters";
import type { TranscriptScrollAnchor } from "./useVirtuosoScrollState";
import type { NativeMessage, NativeMessagePart } from "@/lib/chat/native-message-types";

/** A display row as it can be found again: its own id and its last source row. */
interface RowIdentity {
  id: string;
  lastSourceId: string;
}

function identityOf(row: NativeMessage): RowIdentity {
  return { id: row.id, lastSourceId: getNativeMessageBoundarySourceId(row) };
}

function containsTool(parts: readonly NativeMessagePart[], id: string): boolean {
  return parts.some((part) => {
    if (part.type === "tool-invocation" && (part.toolUseId ?? part.sourcePartId) === id)
      return true;
    if (part.type === "tool-group" || part.type === "agent-group")
      return containsTool(part.parts, id);
    if (part.type === "task-group") return containsTool([part.task, ...part.childTools], id);
    return false;
  });
}

/** Holds a source tool and its viewport offset across history prepends, including
 * pages that grow the first coalesced block without adding a display row. */
export class HeldTranscriptPlace {
  private held: RowIdentity | null = null;
  private first: RowIdentity | null = null;
  private heldHeadId: string | undefined;
  private messages: readonly NativeMessage[] = [];
  private anchor: TranscriptScrollAnchor | undefined;

  get scrollAnchor(): TranscriptScrollAnchor | undefined {
    return this.anchor;
  }

  /** Remember the row now first on screen. */
  hold(scroller?: HTMLElement | null): void {
    this.held = this.first;
    this.heldHeadId = this.first?.id;
    this.anchor = undefined;
    if (!scroller) return;
    const top = scroller.getBoundingClientRect().top;
    const rows = Array.from(scroller.querySelectorAll<HTMLElement>("[data-chat-message-index]"));
    const row = rows.find((element) => element.getBoundingClientRect().bottom > top);
    const message = row && this.messages[Number(row.dataset.chatMessageIndex)];
    if (!row || !message) return;
    this.held = identityOf(message);
    const tool = Array.from(row.querySelectorAll<HTMLElement>("[data-transcript-part-id]")).find(
      (element) => {
        const rect = element.getBoundingClientRect();
        return rect.bottom > top && rect.top < top + scroller.clientHeight;
      },
    );
    this.anchor = {
      partId: tool?.dataset.transcriptPartId,
      offset: (tool ?? row).getBoundingClientRect().top - top,
    };
  }

  /** Forget a held place, e.g. when the history it belongs to is dropped. */
  release(): void {
    this.held = null;
    this.anchor = undefined;
  }

  /** Records this render's first row; answers where to scroll if the held row moved down. */
  resolve(messages: readonly NativeMessage[]): number | undefined {
    const held = this.held;
    this.messages = messages;
    this.first = messages[0] ? identityOf(messages[0]) : null;
    if (!held) return undefined;
    const index = messages.findIndex((message) => {
      const identity = identityOf(message);
      return (
        identity.id === held.id ||
        identity.lastSourceId === held.lastSourceId ||
        (this.anchor?.partId !== undefined && containsTool(message.parts, this.anchor.partId))
      );
    });
    // An unchanged head is still waiting. A renamed head matched through a
    // source id has received history even if its display index stays zero.
    if (index >= 0 && messages[0]?.id === this.heldHeadId) return undefined;
    this.held = null;
    return index >= 0 ? index : undefined;
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
  scrollToIndex: (index: number, anchor?: TranscriptScrollAnchor) => unknown,
): void {
  useLayoutEffect(() => {
    const index = place.resolve(messages);
    if (index !== undefined) {
      if (place.scrollAnchor) scrollToIndex(index, place.scrollAnchor);
      else scrollToIndex(index);
    }
  }, [messages, place, scrollToIndex]);
}
