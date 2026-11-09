/**
 * The glow a transcript item gets when the reader jumps to it (an Actions
 * panel card, a message link). It wraps the item's own box (its card, tile or
 * the transcript content column), never the full-width row, and fades out over
 * {@link CONVERSATION_TARGET_HIGHLIGHT_MS}. The look lives in `index.css`
 * (`[data-conversation-target-glow]`).
 */

/** How long the jumped-to item stays highlighted, and how long its glow fades. */
export const CONVERSATION_TARGET_HIGHLIGHT_MS = 2_500;

/**
 * Marks an item renderer's own box: the element the glow wraps. Put it on the
 * card or tile, or on the content column for a plain message. The outermost
 * one in a row wins, so a tile nested inside another item is not picked.
 */
export const TRANSCRIPT_ITEM_ATTRIBUTE = "data-transcript-item";

/** Set on the glowing item element; its value alternates per jump. */
export const CONVERSATION_TARGET_GLOW_ATTRIBUTE = "data-conversation-target-glow";

const GLOW_DELAY_PROPERTY = "--conversation-target-glow-delay";

const GLOW_DURATION_PROPERTY = "--conversation-target-glow-duration";

/** One jump: the row to highlight, and which jump it was. */
export interface ConversationTargetHighlight {
  messageId: string;
  /** Increases with every jump, so a repeat jump to the same row restarts the glow. */
  generation: number;
  /** The highlight period: the glow fades over it and is removed at its end. */
  durationMs: number;
  /** Monotonic jump time, shared by cleanup and virtualized row mounts. */
  startedAt: number;
}

/**
 * The glow's attribute value for a jump. Consecutive jumps alternate between
 * two identical keyframe names, because only a change of `animation-name`
 * restarts a CSS animation on an element that keeps the attribute.
 */
export function conversationTargetGlowPhase(generation: number): "a" | "b" {
  return generation % 2 === 0 ? "a" : "b";
}

/** The element the glow wraps: the row's outermost marked item, else `fallback`. */
export function findTranscriptItemElement(row: HTMLElement, fallback: HTMLElement): HTMLElement {
  return row.querySelector<HTMLElement>(`[${TRANSCRIPT_ITEM_ATTRIBUTE}]`) ?? fallback;
}

/**
 * Starts the glow on `item` and returns its removal. The attribute is set on
 * the DOM node directly because the item is rendered by whichever message
 * renderer the list was given; React leaves attributes it does not own alone.
 * The animation's duration is the highlight period itself, so the fade ends as
 * the attribute is removed. A negative delay resumes elapsed progress on remount.
 */
export function startConversationTargetGlow(
  item: HTMLElement,
  generation: number,
  durationMs: number = CONVERSATION_TARGET_HIGHLIGHT_MS,
  startedAt: number = performance.now(),
): () => void {
  const elapsed = Math.max(0, performance.now() - startedAt);
  if (elapsed >= durationMs) return () => {};
  item.style.setProperty(GLOW_DELAY_PROPERTY, `-${elapsed}ms`);
  item.style.setProperty(GLOW_DURATION_PROPERTY, `${durationMs}ms`);
  item.setAttribute(CONVERSATION_TARGET_GLOW_ATTRIBUTE, conversationTargetGlowPhase(generation));
  return () => {
    item.removeAttribute(CONVERSATION_TARGET_GLOW_ATTRIBUTE);
    item.style.removeProperty(GLOW_DURATION_PROPERTY);
    item.style.removeProperty(GLOW_DELAY_PROPERTY);
  };
}
