/**
 * Raw HTML in GitHub-authored Markdown (PR descriptions, comments, review
 * comments).
 *
 * react-markdown never renders raw HTML: without this plugin every tag a bot
 * writes (Vercel, Codecov, CodeRabbit, …) shows up as literal text. Rendering
 * the HTML for real would mean sanitising arbitrary markup, so instead this
 * plugin translates the handful of tags that carry meaning into ordinary
 * Markdown nodes and drops the rest, keeping their text:
 *
 *  - `<a href>` becomes a link. A link whose only content is an image (a badge
 *    or button) is labelled with the image's `alt`; one with no label at all
 *    (a decorative avatar) is dropped.
 *  - `<relative-time datetime>` becomes a `time` element, which the PR view
 *    renders as a relative age. Its text is kept as the fallback.
 *  - `<b>`/`<strong>`, `<i>`/`<em>`, `<del>`/`<s>`, `<code>` and `<br>` map to
 *    their Markdown equivalents.
 *  - Everything else — images, `<picture>`, `<sup>`, comments, `<script>`
 *    bodies — is removed.
 *
 * Inline HTML arrives from the parser one tag per `html` node, interleaved
 * with the Markdown between the tags, so tags are paired across siblings.
 * Block HTML arrives as one `html` node holding the whole block; it is
 * tokenised the same way and rendered as a paragraph.
 */

interface MdNode {
  type: string;
  children?: MdNode[];
  value?: string;
  url?: string;
  title?: string | null;
  data?: {
    hName?: string;
    hProperties?: Record<string, unknown>;
  };
}

type HtmlToken =
  | { kind: "text"; value: string }
  | { kind: "open"; name: string; attributes: Record<string, string>; selfClosing: boolean }
  | { kind: "close"; name: string };

/** A tag whose content is being collected until its closing tag. */
interface Frame {
  /** The tag name that closes this frame; empty for the root. */
  name: string;
  build: ((children: MdNode[], frame: Frame) => MdNode | null) | null;
  children: MdNode[];
  /** Image `alt` text seen inside a link, used when the link has no text. */
  fallbackLabel?: string;
}

/** Containers whose children are block content rather than phrasing. */
const FLOW_PARENTS = new Set(["root", "blockquote", "listItem", "footnoteDefinition"]);
/** Markdown nodes that are links already; an `<a>` inside them is unwrapped. */
const LINK_NODES = new Set(["link", "linkReference"]);
/** Tags whose text content is never shown. */
const HIDDEN_CONTENT_TAGS = new Set(["script", "style", "template"]);
/** Block tags whose end separates lines when HTML is flattened to a paragraph. */
const BLOCK_BOUNDARY_TAGS = new Set([
  "p",
  "div",
  "li",
  "tr",
  "table",
  "summary",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "pre",
]);
const PHRASING_TAGS: Record<string, string> = {
  b: "strong",
  strong: "strong",
  i: "emphasis",
  em: "emphasis",
  del: "delete",
  s: "delete",
  strike: "delete",
};

const TOKEN_PATTERN =
  /<!--[\s\S]*?(?:-->|$)|<![^>]*>|<\?[^>]*>|<\/?[A-Za-z][A-Za-z0-9-]*(?:"[^"]*"|'[^']*'|[^'">])*>/g;
const ATTRIBUTE_PATTERN = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function remarkGitHubHtml() {
  return (tree: MdNode) => {
    rewrite(tree, false);
  };
}

function rewrite(node: MdNode, insideLink: boolean): void {
  if (!node.children) return;
  const childInsideLink = insideLink || LINK_NODES.has(node.type);
  for (const child of node.children) rewrite(child, childInsideLink);
  if (!node.children.some((child) => child.type === "html")) return;

  if (FLOW_PARENTS.has(node.type)) {
    node.children = node.children.flatMap((child) => {
      if (child.type !== "html") return [child];
      const phrasing = trimBoundaryBreaks(convertPhrasing([child], false).children);
      return hasVisibleContent(phrasing) ? [{ type: "paragraph", children: phrasing }] : [];
    });
    return;
  }

  const converted = convertPhrasing(node.children, childInsideLink);
  node.children = converted.children;
  // `[<img alt="Docs">](url)`: a Markdown link around an HTML image badge.
  if (LINK_NODES.has(node.type) && !hasVisibleContent(node.children) && converted.fallbackLabel) {
    node.children = [{ type: "text", value: converted.fallbackLabel }];
  }
}

/**
 * Replaces the `html` nodes among phrasing siblings with Markdown nodes. The
 * fallback label is the first image `alt` seen directly inside an enclosing
 * Markdown link.
 */
function convertPhrasing(children: MdNode[], insideLink: boolean): Frame {
  const root: Frame = { name: "", build: null, children: [] };
  const stack: Frame[] = [root];
  let hiddenDepth = 0;
  const top = () => stack[stack.length - 1]!;
  const linkOpen = () => insideLink || stack.some((frame) => frame.name === "a");

  for (const child of children) {
    if (child.type !== "html") {
      top().children.push(child);
      continue;
    }
    for (const token of tokenizeHtml(child.value ?? "")) {
      if (token.kind === "text") {
        if (hiddenDepth > 0) continue;
        const value = decodeEntities(token.value).replace(/\s+/g, " ");
        if (value) top().children.push({ type: "text", value });
        continue;
      }

      if (HIDDEN_CONTENT_TAGS.has(token.name)) {
        if (token.kind === "close") hiddenDepth = Math.max(0, hiddenDepth - 1);
        else if (!token.selfClosing) hiddenDepth++;
        continue;
      }

      if (token.kind === "close") {
        const index = stack.findLastIndex((frame) => frame.name === token.name);
        if (index > 0) {
          // Tags opened inside this one and never closed are unwrapped.
          while (stack.length - 1 > index) unwrapFrame(stack.pop()!, top());
          const frame = stack.pop()!;
          const built = frame.build?.(frame.children, frame);
          if (built) top().children.push(built);
        } else if (BLOCK_BOUNDARY_TAGS.has(token.name)) {
          pushBoundaryBreak(top());
        } else if (token.name === "td" || token.name === "th") {
          top().children.push({ type: "text", value: " " });
        }
        continue;
      }

      if (BLOCK_BOUNDARY_TAGS.has(token.name)) pushBoundaryBreak(top());

      if (token.name === "br") {
        top().children.push({ type: "break" });
      } else if (token.name === "hr") {
        pushBoundaryBreak(top());
      } else if (token.name === "img") {
        const link = stack.findLast((frame) => frame.name === "a") ?? (insideLink ? root : null);
        const alt = token.attributes.alt?.trim();
        if (link && alt && !link.fallbackLabel) link.fallbackLabel = alt;
      } else if (!token.selfClosing) {
        const frame = openFrame(token.name, token.attributes, linkOpen());
        if (frame) stack.push(frame);
      }
    }
  }

  while (stack.length > 1) unwrapFrame(stack.pop()!, top());
  return root;
}

function openFrame(
  name: string,
  attributes: Record<string, string>,
  insideLink: boolean,
): Frame | null {
  if (name === "a") {
    const url = attributes.href?.trim();
    // A nested anchor, or one without a destination, keeps only its content.
    if (!url || insideLink) return null;
    return {
      name,
      children: [],
      build: (children, frame) => {
        if (hasVisibleContent(children)) return { type: "link", url, title: null, children };
        if (!frame.fallbackLabel) return null;
        return {
          type: "link",
          url,
          title: null,
          children: [{ type: "text", value: frame.fallbackLabel }],
        };
      },
    };
  }

  if (name === "relative-time") {
    const dateTime = attributes.datetime?.trim();
    if (!dateTime) return null;
    return {
      name,
      children: [],
      build: (children) => ({
        type: "githubRelativeTime",
        data: { hName: "time", hProperties: { dateTime } },
        children: hasVisibleContent(children) ? children : [{ type: "text", value: dateTime }],
      }),
    };
  }

  if (name === "code") {
    return {
      name,
      children: [],
      build: (children) => {
        const value = plainText(children);
        return value ? { type: "inlineCode", value } : null;
      },
    };
  }

  const type = PHRASING_TAGS[name];
  if (type) {
    return {
      name,
      children: [],
      build: (children) => (hasVisibleContent(children) ? { type, children } : null),
    };
  }

  return null;
}

function unwrapFrame(frame: Frame, parent: Frame): void {
  parent.children.push(...frame.children);
}

function pushBoundaryBreak(frame: Frame): void {
  // Whitespace between block tags is formatting, not content.
  while (frame.children.at(-1)?.type === "text" && !frame.children.at(-1)!.value?.trim()) {
    frame.children.pop();
  }
  const last = frame.children.at(-1);
  if (last && last.type !== "break") frame.children.push({ type: "break" });
}

/** Drops the line breaks and spaces block tags leave at a paragraph's edges. */
function trimBoundaryBreaks(children: MdNode[]): MdNode[] {
  const result = [...children];
  const isBlank = (node: MdNode | undefined) =>
    node !== undefined && (node.type === "break" || (node.type === "text" && !node.value?.trim()));
  while (isBlank(result[0])) result.shift();
  while (isBlank(result.at(-1))) result.pop();
  const first = result[0];
  if (first?.type === "text") result[0] = { ...first, value: first.value!.trimStart() };
  const last = result.at(-1);
  if (last?.type === "text") result[result.length - 1] = { ...last, value: last.value!.trimEnd() };
  return result;
}

function hasVisibleContent(nodes: MdNode[]): boolean {
  return nodes.some((node) => {
    if (node.type === "text") return Boolean(node.value?.trim());
    if (node.type === "break") return false;
    if (node.children) return hasVisibleContent(node.children);
    return true;
  });
}

function plainText(nodes: MdNode[]): string {
  return nodes
    .map((node) => (node.children ? plainText(node.children) : (node.value ?? "")))
    .join("");
}

export function tokenizeHtml(html: string): HtmlToken[] {
  const tokens: HtmlToken[] = [];
  let cursor = 0;
  for (const match of html.matchAll(TOKEN_PATTERN)) {
    if (match.index > cursor) tokens.push({ kind: "text", value: html.slice(cursor, match.index) });
    cursor = match.index + match[0].length;
    const tag = match[0];
    // Comments, doctypes and processing instructions carry nothing to show.
    if (tag.startsWith("<!") || tag.startsWith("<?")) continue;
    const name = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(tag)![1]!.toLowerCase();
    if (tag.startsWith("</")) {
      tokens.push({ kind: "close", name });
      continue;
    }
    const body = tag.slice(name.length + 1, -1);
    tokens.push({
      kind: "open",
      name,
      attributes: parseAttributes(body),
      selfClosing: body.trimEnd().endsWith("/"),
    });
  }
  if (cursor < html.length) tokens.push({ kind: "text", value: html.slice(cursor) });
  return tokens;
}

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of source.matchAll(ATTRIBUTE_PATTERN)) {
    const name = match[1]!.toLowerCase();
    if (name in attributes) continue;
    attributes[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (entity, body: string) => {
    if (body[0] === "#") {
      const codePoint =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
  });
}
