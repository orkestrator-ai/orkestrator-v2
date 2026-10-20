/**
 * Small pieces shared by rich Markdown blocks. Kept apart from
 * `RichMarkdownBlocks.tsx` so individual blocks can use them without an
 * import cycle through the component map.
 */

/**
 * Hidden copy of content that is not currently shown (a collapsed body, a
 * diagram's source behind its preview). It holds exactly the text the revealed
 * view will show, so find can count and locate matches in it; `revealKey`
 * names the block view whose `findRevealed` flag shows the real content.
 * `hidden` keeps it out of layout, selection, copy and the accessibility tree.
 */
export function RichSearchMirror({ text, revealKey }: { text: string; revealKey?: string }) {
  return (
    <div hidden data-rich-search-mirror="true" data-rich-reveal-key={revealKey}>
      {text}
    </div>
  );
}
