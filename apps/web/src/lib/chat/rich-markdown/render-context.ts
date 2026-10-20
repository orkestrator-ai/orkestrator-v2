import { createContext, useContext } from "react";

/**
 * What a rich Markdown block needs from the render that produced it, supplied
 * by `MessageMarkdown` when the rich pipeline is enabled. The heavy block
 * components are memoized on their own props and do not read this context,
 * so a streaming update re-renders only the thin element adapters.
 */
export interface RichMarkdownRenderState {
  /** Stable source-part identity for block view keys (`useRichBlockViewKey`). */
  partId: string;
  /** The rendered slice stops at the parser cap; the boundary is not an end. */
  clipped: boolean;
  omittedCharacters: number;
  /** The part's text is still arriving (display hint, see `useStreamingDisplayText`). */
  live: boolean;
  /** The bounded slice the parser saw; hast offsets index into it. */
  renderedSource: string;
  /** The complete original source, never the bounded slice. */
  fullSource: string;
}

export const RichMarkdownRenderContext = createContext<RichMarkdownRenderState | null>(null);

const DETACHED: RichMarkdownRenderState = {
  partId: "detached",
  clipped: false,
  omittedCharacters: 0,
  live: false,
  renderedSource: "",
  fullSource: "",
};

export function useRichMarkdownRender(): RichMarkdownRenderState {
  return useContext(RichMarkdownRenderContext) ?? DETACHED;
}
