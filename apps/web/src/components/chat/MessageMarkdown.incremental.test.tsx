import { afterEach, expect, test } from "bun:test";
import { useEffect, type HTMLAttributes } from "react";
import { cleanup } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import Markdown, { type Components } from "react-markdown";
import { setHighlightBackend } from "@/lib/chat/highlighter/client";
import {
  blockMarkdownPlugins,
  markdownUrlTransform,
} from "@/lib/chat/rich-markdown/markdown-plugins";
import { RichMarkdownRenderContext } from "@/lib/chat/rich-markdown/render-context";
import { DEFAULT_COMPONENTS, MessageMarkdown } from "./MessageMarkdown";
import { richMarkdownComponents } from "./rich/RichMarkdownBlocks";

afterEach(() => {
  cleanup();
  setHighlightBackend(undefined);
});

/**
 * The rendered DOM with attributes in a fixed order: an element React updated
 * in place lists an attribute it gained last, which is not a difference.
 */
function semanticHtml(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (!(node instanceof Element)) return "";
  const attributes = Array.from(node.attributes)
    .map((attribute) => `${attribute.name}=${JSON.stringify(attribute.value)}`)
    .sort()
    .join(" ");
  return `<${node.tagName.toLowerCase()} ${attributes}>${semanticChildren(node)}</>`;
}

function semanticChildren(element: Element): string {
  return Array.from(element.childNodes).map(semanticHtml).join("");
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

const RICH_COMPONENTS = richMarkdownComponents as unknown as Components;
const RICH_FULL_COMPONENTS: Components = { ...DEFAULT_COMPONENTS, ...RICH_COMPONENTS };
const RICH_PLUGINS = blockMarkdownPlugins({ rich: true, enableBreaks: true, clipped: false });

/** One whole pass of the pipeline at `live`, sharing no cache with anything. */
function FullRender({ content }: { content: string }) {
  return (
    <RichMarkdownRenderContext
      value={{
        partId: "part-1",
        clipped: false,
        omittedCharacters: 0,
        live: true,
        renderedSource: content,
        fullSource: content,
      }}
    >
      <Markdown
        remarkPlugins={RICH_PLUGINS}
        components={RICH_FULL_COMPONENTS}
        urlTransform={markdownUrlTransform}
      >
        {content}
      </Markdown>
    </RichMarkdownRenderContext>
  );
}

// This case is synchronous, CPU-bound work with nothing to wait for: about a
// hundred streamed prefixes, each rendered three times (live, non-live and a
// fresh uncached reference), roughly 300 complete Markdown passes. Alone it
// takes about three seconds, so Bun's five-second default leaves too little
// headroom for a host running the aggregate (case 6194); budget the work.
const STREAMING_EQUIVALENCE_BUDGET_MS = 30_000;

test(
  "a live streaming render matches a full render at every update",
  () => {
    setHighlightBackend(null);
    const live = renderInAppCommandScope(
      <MessageMarkdown content="" richPartId="part-1" live components={RICH_COMPONENTS} />,
    );
    const full = renderInAppCommandScope(
      <MessageMarkdown content="" richPartId="part-1" components={RICH_COMPONENTS} />,
    );
    // The fence is open, then closed, part-way through; the table is partial.
    for (let length = 1; length <= ANSWER.length; length += 3) {
      const content = ANSWER.slice(0, length);
      live.rerender(
        <MessageMarkdown content={content} richPartId="part-1" live components={RICH_COMPONENTS} />,
      );
      full.rerender(
        <MessageMarkdown
          content={content}
          richPartId="part-1"
          live={false}
          components={RICH_COMPONENTS}
        />,
      );
      // Live chrome (a streaming fence's state) is the only allowed difference,
      // so compare the same `live` flag through one pass over the whole text.
      const fresh = renderInAppCommandScope(<FullRender content={content} />);
      // `MessageMarkdown`'s own wrapper is the one element the reference lacks.
      expect(semanticChildren(live.container.firstElementChild!)).toBe(
        semanticChildren(fresh.container),
      );
      fresh.unmount();
    }
    // The final, non-live render is the full parse.
    live.rerender(
      <MessageMarkdown
        content={ANSWER}
        richPartId="part-1"
        live={false}
        components={RICH_COMPONENTS}
      />,
    );
    full.rerender(
      <MessageMarkdown
        content={ANSWER}
        richPartId="part-1"
        live={false}
        components={RICH_COMPONENTS}
      />,
    );
    expect(semanticHtml(live.container)).toBe(semanticHtml(full.container));
  },
  STREAMING_EQUIVALENCE_BUDGET_MS,
);

/** A paragraph that counts its renders and mounts, by its first words. */
function countingParagraphs() {
  const renders = new Map<string, number>();
  let mounts = 0;
  function P({ children }: HTMLAttributes<HTMLParagraphElement>) {
    const label = String(Array.isArray(children) ? children[0] : children).slice(0, 6);
    renders.set(label, (renders.get(label) ?? 0) + 1);
    useEffect(() => {
      mounts += 1;
    }, []);
    return <p>{children}</p>;
  }
  return { components: { p: P } as Components, renders, mounts: () => mounts };
}

test("finished blocks do not render again while the message streams", () => {
  const { components, renders } = countingParagraphs();
  // The last boundary is only safe once the line after it has ended, so the
  // block before the one still arriving is not yet known to be finished.
  const prefix = "Keep one.\n\nKeep two.\n\nAlmost.\n\n";
  const view = renderInAppCommandScope(
    <MessageMarkdown content={`${prefix}Still`} live components={components} />,
  );
  const finished = view.container.querySelector("p");
  for (const tail of ["Still a", "Still arriving", "Still arriving now"]) {
    view.rerender(<MessageMarkdown content={`${prefix}${tail}`} live components={components} />);
  }
  expect(renders.get("Keep o")).toBe(1);
  expect(renders.get("Keep t")).toBe(1);
  // What is left renders once per update, as all of it did before.
  expect(renders.get("Almost")).toBe(4);
  expect(view.container.querySelector("p")).toBe(finished);
  expect(view.container.querySelectorAll("p")[3]!.textContent).toBe("Still arriving now");
});

test("the final render updates the streamed blocks in place, without remounting", () => {
  const { components, mounts } = countingParagraphs();
  const streamed = "One.\n\nTwo.\n\nThree.\n\nFour";
  const view = renderInAppCommandScope(
    <MessageMarkdown content={streamed} live components={components} />,
  );
  const paragraphs = Array.from(view.container.querySelectorAll("p"));
  expect(paragraphs).toHaveLength(4);
  const mounted = mounts();

  view.rerender(<MessageMarkdown content={`${streamed}.`} live={false} components={components} />);

  expect(mounts()).toBe(mounted);
  expect(Array.from(view.container.querySelectorAll("p"))).toEqual(paragraphs);
  expect(paragraphs.at(-1)!.textContent).toBe("Four.");
});

test("a new component map renders every block with it", () => {
  const first = countingParagraphs();
  const second = countingParagraphs();
  const content = "One.\n\nTwo.\n\nThree";
  const view = renderInAppCommandScope(
    <MessageMarkdown content={content} live components={first.components} />,
  );
  view.rerender(<MessageMarkdown content={content} live components={second.components} />);
  expect(second.renders.get("One.")).toBe(1);
});
