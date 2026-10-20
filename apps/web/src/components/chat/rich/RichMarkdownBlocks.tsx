/**
 * react-markdown component map for the rich transcript pipeline
 * (`MessageMarkdown` with `richPartId`). Each adapter reads the element's
 * parsed properties, derives the block's scoped view identity and hands
 * primitive props to a memoized block component.
 *
 * Fence routing is explicit and lives only here:
 *  - `mermaid` → `MermaidBlock` (renders only once the fence is closed);
 *  - `chart`   → `ChartFenceBlock` (the native chart workstream validates it);
 *  - anything else, including `json`, `html`, `svg` and JavaScript, is inert
 *    source in `CodeBlock` — never executed, never promoted to an artifact.
 */
import {
  createContext,
  useContext,
  type AnchorHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import type { Components, ExtraProps } from "react-markdown";
import { MarkdownLink } from "@/components/chat/MessageMarkdown";
import { inlineCodeFileReference } from "@/lib/chat/inline-file-reference";
import { useRichBlockViewKey } from "@/lib/chat/rich-identity";
import {
  chartFenceSearchText,
  hastChildrenSearchText,
  type HastNode,
} from "@/lib/chat/rich-markdown/markdown-search";
import { useRichMarkdownRender } from "@/lib/chat/rich-markdown/render-context";
import { RICH_ELEMENTS } from "@/lib/chat/rich-markdown/remark-rich-markdown";
import { ChartFenceBlock } from "@/components/chat/rich/ChartFenceBlock";
import { CodeBlock } from "./CodeBlock";
import { MarkdownImage } from "./MediaBlock";
import { MermaidBlock } from "./MermaidBlock";
import { isRichCalloutKind, RichCallout } from "./RichCallout";
import { RichDetails } from "./RichDetails";
import { RichSearchMirror } from "./RichMarkdownBlocks.shared";
import { richTablePropsFromHast, RichTable } from "./RichTable";

interface ElementProps {
  node?: HastNode;
  children?: ReactNode;
}

function stringProp(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function RichCodeElement(
  props: ElementProps & {
    source?: string;
    language?: string;
    title?: string;
    fileHint?: string;
    closed?: boolean;
    blockId?: string;
  },
) {
  const render = useRichMarkdownRender();
  const blockKey = useRichBlockViewKey(render.partId, props.blockId ?? "code");
  const source = props.source ?? "";
  const language = stringProp(props.language);
  const closed = props.closed === true;

  if (language === "mermaid") {
    return (
      <MermaidBlock
        source={source}
        closed={closed}
        blockKey={blockKey}
        live={render.live}
        clipped={render.clipped}
      />
    );
  }
  if (language === "chart") {
    return (
      <div data-rich-mirror-host="true">
        {/* The chart owns its drawing; find indexes its labels through the mirror. */}
        <div data-rich-search-exclude="true">
          <ChartFenceBlock source={source} closed={closed} blockKey={blockKey} />
        </div>
        <RichSearchMirror text={chartFenceSearchText(source, closed)} />
      </div>
    );
  }
  return (
    <CodeBlock
      source={source}
      language={language}
      title={stringProp(props.title)}
      fileHint={stringProp(props.fileHint)}
      closed={closed}
      blockKey={blockKey}
      live={render.live}
      clipped={render.clipped}
    />
  );
}

function RichDetailsElement(props: ElementProps & { summary?: string; blockId?: string }) {
  const render = useRichMarkdownRender();
  const blockKey = useRichBlockViewKey(render.partId, props.blockId ?? "details");
  const node = props.node;
  return (
    <RichDetails
      summary={props.summary ?? ""}
      blockKey={blockKey}
      bodySearchText={() => (node ? hastChildrenSearchText(node) : "")}
    >
      {props.children}
    </RichDetails>
  );
}

function RichCalloutElement(props: ElementProps & { calloutKind?: string }) {
  if (!isRichCalloutKind(props.calloutKind)) return <blockquote>{props.children}</blockquote>;
  return <RichCallout kind={props.calloutKind}>{props.children}</RichCallout>;
}

function RichTableElement(props: ElementProps & { blockId?: string }) {
  const render = useRichMarkdownRender();
  const blockKey = useRichBlockViewKey(render.partId, props.blockId ?? "table");
  if (!props.node) return <table>{props.children}</table>;
  return (
    <RichTable
      {...richTablePropsFromHast(props.node, render.renderedSource, render.clipped)}
      omittedCharacters={render.omittedCharacters}
      blockKey={blockKey}
    >
      {props.children}
    </RichTable>
  );
}

function RichImageElement(props: ElementProps & { src?: string; alt?: string; title?: string }) {
  return <MarkdownImage src={props.src} alt={props.alt} title={props.title} />;
}

/** True below a Markdown link, where a nested file link would be invalid. */
const InsideLinkContext = createContext(false);

function RichLinkElement(props: AnchorHTMLAttributes<HTMLAnchorElement> & ExtraProps) {
  return (
    <InsideLinkContext value={true}>
      <MarkdownLink {...props} />
    </InsideLinkContext>
  );
}

function plainChildrenText(children: ReactNode): string | null {
  if (typeof children === "string") return children;
  if (Array.isArray(children) && children.every((child) => typeof child === "string")) {
    return children.join("");
  }
  return null;
}

function fileReferenceTitle(target: {
  filePath: string;
  lineNumber?: number;
  columnNumber?: number;
}) {
  const column = target.columnNumber !== undefined ? `, column ${target.columnNumber}` : "";
  return `Open ${target.filePath} at line ${target.lineNumber}${column}`;
}

/**
 * Inline code. Fences never reach this component (they are `rich-code`
 * elements), so only inline spans are considered. A span that is a file
 * reference (`inlineCodeFileReference`) becomes the same environment-aware
 * `MarkdownLink` prose file links use; the visible text stays exactly the
 * code text inside the `<code>` element, so find and copy are unchanged. Code
 * already inside a link stays plain to avoid nested links.
 */
function RichInlineCodeElement({
  node: _node,
  children,
  ...props
}: HTMLAttributes<HTMLElement> & ExtraProps) {
  const insideLink = useContext(InsideLinkContext);
  const text = plainChildrenText(children);
  const target = !insideLink && text !== null ? inlineCodeFileReference(text) : null;
  if (!target || text === null) return <code {...props}>{children}</code>;
  return (
    <code {...props} data-inline-file-reference="true">
      <MarkdownLink
        href={text}
        title={fileReferenceTitle(target)}
        className="underline decoration-dotted underline-offset-2"
      >
        {text}
      </MarkdownLink>
    </code>
  );
}

/**
 * Hoisted: `MessageMarkdown` is memoized on content, which only holds while
 * this map keeps its identity.
 */
export const richMarkdownComponents = {
  a: RichLinkElement,
  code: RichInlineCodeElement,
  table: RichTableElement,
  img: RichImageElement,
  [RICH_ELEMENTS.code]: RichCodeElement,
  [RICH_ELEMENTS.details]: RichDetailsElement,
  [RICH_ELEMENTS.callout]: RichCalloutElement,
} as Components;
