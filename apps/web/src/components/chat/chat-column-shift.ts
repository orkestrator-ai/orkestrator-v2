import { useEffect, useState, type CSSProperties } from "react";
import { useFloatingNoticeColumnShift } from "@/components/ui/floating-notice";

/**
 * Moving the chat column left, to make room for a panel docked beside it.
 *
 * The chat shell publishes the shift as CSS variables; the transcript's
 * scroller and the composer dock reserve twice the shift on their right, so
 * their centred content moves left by exactly the shift while the scroller
 * keeps its scrollbar at the pane's edge. Padding rather than a transform,
 * because a transform would carry the scrollbar under the docked panel.
 */

/** How long the column takes to slide across. */
export const CHAT_COLUMN_SHIFT_DURATION_MS = 300;

/**
 * A freshly mounted shell takes its first shift without sliding: the pane is
 * measured and the panel claims its room a few renders after mount, and the
 * column should simply start where it belongs.
 */
export const CHAT_COLUMN_SHIFT_SETTLE_MS = 400;

/** Applied by every element whose centred content follows the column. */
export const CHAT_COLUMN_SHIFT_CLASS =
  "pr-[calc(var(--chat-column-shift,0rem)*2)] transition-[padding-right] duration-[var(--chat-column-shift-duration,0ms)] ease-out motion-reduce:transition-none";

/** The variables `CHAT_COLUMN_SHIFT_CLASS` reads, for the shell's root. */
export function useChatColumnShiftStyle(): CSSProperties {
  const shiftRem = useFloatingNoticeColumnShift();
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(true), CHAT_COLUMN_SHIFT_SETTLE_MS);
    return () => clearTimeout(timer);
  }, []);
  return {
    "--chat-column-shift": `${shiftRem}rem`,
    "--chat-column-shift-duration": settled ? `${CHAT_COLUMN_SHIFT_DURATION_MS}ms` : "0ms",
  } as CSSProperties;
}
