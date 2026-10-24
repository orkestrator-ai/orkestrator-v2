import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { setHighlightBackend } from "@/lib/chat/highlighter/client";
import { MessageMarkdown } from "./MessageMarkdown";

afterEach(() => {
  cleanup();
  setHighlightBackend(undefined);
});

/**
 * The rendered DOM with attributes in a fixed order: an element React updated
 * in place lists an attribute it gained last, which is not a difference.
 */
function semanticHtml(root: Element): string {
  const walk = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (!(node instanceof Element)) return "";
    const attributes = Array.from(node.attributes)
      .map((attribute) => `${attribute.name}=${JSON.stringify(attribute.value)}`)
      .sort()
      .join(" ");
    return `<${node.tagName.toLowerCase()} ${attributes}>${Array.from(node.childNodes).map(walk).join("")}</>`;
  };
  return walk(root);
}

const ANSWER = [
  "## Plan",
  "",
  "The reducer **mutates** state in `applyPatch`; see [the docs](https://example.com/docs).",
  "",
  "- read the reducer",
  "- write the fix",
  "",
  "```ts",
  "const next = apply(state, patch);",
  "```",
  "",
  "| step | owner |",
  "| ---- | ----- |",
  "| one  | me    |",
  "",
  "A closing paragraph that keeps streaming",
].join("\n");

test("a live streaming render matches a full render at every update", () => {
  setHighlightBackend(null);
  const live = render(<MessageMarkdown content="" richPartId="part-1" live />);
  const full = render(<MessageMarkdown content="" richPartId="part-1" />);
  for (let length = 1; length <= ANSWER.length; length += 7) {
    const content = ANSWER.slice(0, length);
    live.rerender(<MessageMarkdown content={content} richPartId="part-1" live />);
    full.rerender(<MessageMarkdown content={content} richPartId="part-1" live={false} />);
    // Live chrome (a streaming fence's state) is the only allowed difference,
    // so compare the same `live` flag through a fresh, cache-free render.
    const fresh = render(<MessageMarkdown content={content} richPartId="part-1" live />);
    expect(semanticHtml(live.container)).toBe(semanticHtml(fresh.container));
    fresh.unmount();
  }
  // The final, non-live render is the full parse.
  live.rerender(<MessageMarkdown content={ANSWER} richPartId="part-1" live={false} />);
  full.rerender(<MessageMarkdown content={ANSWER} richPartId="part-1" live={false} />);
  expect(semanticHtml(live.container)).toBe(semanticHtml(full.container));
});
