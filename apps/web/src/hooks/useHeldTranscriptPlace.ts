import { useLayoutEffect, useState } from "react";
import { getNativeMessageBoundarySourceId } from "@/lib/chat/native-message-adapters";
import type { NavigationOwner } from "@/lib/transcript-scroll/scroll-intent";
import type {
  SemanticAnchor,
  TranscriptScrollController,
} from "@/lib/transcript-scroll/transcript-scroll-controller";
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

/** Where each identity lives in one display projection; built once per array. */
interface SourceIndex {
  /** Source part (tool call id, or source part id) → display row. */
  part: Map<string, number>;
  /** Display row id → display row. */
  row: Map<string, number>;
  /** Boundary source message id → its first display row. */
  boundary: Map<string, number>;
}

const sourceIndexes = new WeakMap<readonly NativeMessage[], SourceIndex>();

function indexParts(parts: readonly NativeMessagePart[], row: number, into: Map<string, number>) {
  for (const part of parts) {
    const id =
      part.type === "tool-invocation" ? (part.toolUseId ?? part.sourcePartId) : part.sourcePartId;
    if (id && !into.has(id)) into.set(id, row);
    if (part.type === "tool-group" || part.type === "agent-group")
      indexParts(part.parts, row, into);
    if (part.type === "task-group") indexParts([part.task, ...part.childTools], row, into);
  }
}

/**
 * The identity maps for a display projection. Only built while a place is
 * held, so ordinary streaming renders never pay for it.
 */
export function sourceIndexOf(messages: readonly NativeMessage[]): SourceIndex {
  let index = sourceIndexes.get(messages);
  if (index) return index;
  index = { part: new Map(), row: new Map(), boundary: new Map() };
  messages.forEach((message, row) => {
    index!.row.set(message.id, row);
    const boundary = getNativeMessageBoundarySourceId(message);
    if (!index!.boundary.has(boundary)) index!.boundary.set(boundary, row);
    indexParts(message.parts, row, index!.part);
  });
  sourceIndexes.set(messages, index);
  return index;
}

function toScrollAnchor(anchor: SemanticAnchor): TranscriptScrollAnchor {
  return { partId: anchor.partId, rowKey: anchor.rowKey, offset: anchor.offsetPx };
}

/** Legacy capture for a view without a scroll controller: first visible source part, else row. */
function captureFrom(scroller: HTMLElement): SemanticAnchor | null {
  const top = scroller.getBoundingClientRect().top;
  const part = Array.from(scroller.querySelectorAll<HTMLElement>("[data-transcript-part-id]")).find(
    (element) => {
      const rect = element.getBoundingClientRect();
      return rect.bottom > top && rect.top < top + scroller.clientHeight;
    },
  );
  const rows = Array.from(scroller.querySelectorAll<HTMLElement>("[data-chat-message-index]"));
  // Earlier context can remove the head prose row's author header. Holding
  // that row's outer box would then shift the visible tool below it, even
  // with a perfect index jump. Prefer the source part anywhere in view.
  const row =
    part?.closest<HTMLElement>("[data-chat-message-index]") ??
    rows.find((element) => element.getBoundingClientRect().bottom > top);
  if (!row) return null;
  return {
    rowKey: row.dataset.chatMessageKey,
    index: Number(row.dataset.chatMessageIndex),
    partId: part?.dataset.transcriptPartId,
    offsetPx: (part ?? row).getBoundingClientRect().top - top,
  };
}

/**
 * Holds the reader's place across one history page: a source part (or row)
 * and its viewport offset, found again by identity even when the page merged
 * into, split or renamed the rows around it.
 *
 * Resolution order: the exact source part; the row by id; the row holding
 * the same boundary source message. When none survives, nothing moves — the
 * list keeps its offset — rather than jumping anywhere else, never to the
 * latest message.
 */
export class HeldTranscriptPlace {
  private held: RowIdentity | null = null;
  private first: RowIdentity | null = null;
  private heldHeadId: string | undefined;
  private messages: readonly NativeMessage[] = [];
  private anchor: TranscriptScrollAnchor | undefined;
  private controller: TranscriptScrollController | null = null;

  get scrollAnchor(): TranscriptScrollAnchor | undefined {
    return this.anchor;
  }

  /**
   * Remember the place now on screen. With the view's scroll controller, the
   * place is re-captured immediately before the page commits, so a reader who
   * moved while it loaded is held where they are, not where they clicked.
   */
  hold(scroller?: HTMLElement | null, controller?: TranscriptScrollController): void {
    this.held = this.first;
    this.heldHeadId = this.first?.id;
    this.anchor = undefined;
    this.controller?.endStructuralHold();
    this.controller = controller ?? null;
    const captured = controller?.captureAnchor() ?? (scroller ? captureFrom(scroller) : null);
    if (!captured) return;
    const row = captured.index !== undefined ? this.messages[captured.index] : undefined;
    if (row) this.held = identityOf(row);
    this.anchor = toScrollAnchor(captured);
    controller?.beginStructuralHold();
  }

  /** Forget a held place, e.g. when the history it belongs to is dropped. */
  release(): void {
    this.held = null;
    this.anchor = undefined;
    this.controller?.endStructuralHold();
    this.controller = null;
  }

  /** Records this render's first row; answers where to scroll if the held row moved down. */
  resolve(messages: readonly NativeMessage[]): number | undefined {
    const held = this.held;
    const previous = this.messages;
    this.messages = messages;
    this.first = messages[0] ? identityOf(messages[0]) : null;
    if (!held) return undefined;
    // An unchanged head is still waiting. A renamed head matched through a
    // source id has received history even if its display index stays zero.
    if (messages[0]?.id === this.heldHeadId && previous !== messages) {
      this.refreshFromPreCommit(previous);
      return undefined;
    }
    if (messages[0]?.id === this.heldHeadId) return undefined;
    this.refreshFromPreCommit(previous);
    const place = this.held ?? held;
    const index = sourceIndexOf(messages);
    const partId = this.anchor?.partId;
    // A response split into prose/tool display rows shares one boundary id.
    // Find the exact source part before falling back to those broader ids.
    const found =
      (partId !== undefined ? index.part.get(partId) : undefined) ??
      index.row.get(place.id) ??
      index.boundary.get(place.lastSourceId);
    this.held = null;
    this.controller?.endStructuralHold();
    if (found !== undefined && this.anchor) {
      // The row's key in this projection: identity resolves before the index.
      this.anchor = { ...this.anchor, rowKey: messages[found]!.id };
    }
    return found;
  }

  /** Adopt the place captured just before this commit (the reader may have moved). */
  private refreshFromPreCommit(previous: readonly NativeMessage[]): void {
    const fresh = this.controller?.takePreCommitAnchor();
    if (!fresh) return;
    const row = fresh.index !== undefined ? previous[fresh.index] : undefined;
    if (row) this.held = identityOf(row);
    this.anchor = toScrollAnchor(fresh);
    this.controller?.beginStructuralHold();
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
  scrollToIndex: (
    index: number,
    anchor?: TranscriptScrollAnchor,
    owner?: NavigationOwner,
  ) => unknown,
): void {
  useLayoutEffect(() => {
    const index = place.resolve(messages);
    if (index !== undefined) {
      if (place.scrollAnchor) scrollToIndex(index, place.scrollAnchor, "history");
      else scrollToIndex(index);
    }
  }, [messages, place, scrollToIndex]);
}
