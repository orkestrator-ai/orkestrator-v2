/**
 * Presentation of a published `html-static` artifact as a real document in
 * the transcript: a trusted runtime that runs inside an opaque sandboxed frame
 * (`sandbox="allow-scripts"`, never `allow-same-origin`), and the narrow,
 * versioned channel between it and the host card.
 *
 * The frame only ever displays the verified effective HTML the host hands it.
 * It sanitizes it again with the design runtime's static rules (scripts,
 * frames, event handlers and executable URLs removed; inline SVG and CSS
 * kept), applies the application theme, reports its content height, a few
 * interaction booleans and the document's bounded text for Find, and asks the
 * host to open a link only after a real click. Nothing here can reach a tool,
 * the composer, a backend command, the clipboard, application shortcuts or
 * model context.
 *
 * Messages, frame to host: `ready` (carries the per-mount nonce), `rendered`,
 * `text`, `size`, `error`, `interaction`, `link-request`, `escape`, `find-match`.
 * Host to frame: `render` (once per mount), `theme` and `find`. Every message
 * after `ready` carries the mount's generation; the host also checks the sender
 * window.
 */
import { normalizeArtifactLink } from "./artifact-frame-channel.js";
import { FRAME_CHANNEL_POLICY, STATIC_PRESENTATION_POLICY } from "./rich-content-policy.js";

export const STATIC_HTML_FRAME_CHANNEL = "orkestrator-static-html";
export const STATIC_HTML_FRAME_PROTOCOL_VERSION = 1;
/**
 * Version of the transcript presentation runtime. It is part of the cache
 * identity of a displayed document; it is not part of any verification
 * receipt, so changing it never re-verifies or rewrites a publication.
 */
export const STATIC_HTML_PRESENTATION_RUNTIME_VERSION = "static-html-presentation:v3";

/**
 * The longest Find query a frame is asked about. Three-byte characters this many
 * still fit `FRAME_CHANNEL_POLICY.maxMessageBytes`. It lives here, not in
 * `STATIC_PRESENTATION_POLICY`, because that table is part of the preview worker's
 * bundle: a new value there would change the worker's context digest, and so ask
 * every install to rebuild its image, for a limit the worker never reads.
 */
export const STATIC_HTML_MAX_FIND_QUERY_CHARACTERS = 1_024;

/** Per-mount readiness nonce and render generation. */
export const STATIC_HTML_MOUNT_ID = /^[A-Za-z0-9_-]{16,64}$/;

export const STATIC_HTML_FRAME_ERROR_CODES = [
  "too-large",
  "too-many-elements",
  "invalid-render",
  "render-failed",
] as const;
export type StaticHtmlFrameErrorCode = (typeof STATIC_HTML_FRAME_ERROR_CODES)[number];

export interface StaticHtmlFrameTheme {
  appearance: "light" | "dark";
  reducedMotion: boolean;
  /** `--ork-*` custom properties, already sanitized by the host. */
  tokens: Record<string, string>;
}

interface Envelope {
  channel: typeof STATIC_HTML_FRAME_CHANNEL;
  v: 1;
}

export type StaticHtmlFrameMessage =
  | (Envelope & { type: "ready"; nonce: string })
  | (Envelope & {
      type: "rendered";
      generation: string;
      height: number;
      elementCount: number;
      /** The document uses `--ork-*` tokens, so it follows the application theme. */
      themed: boolean;
    })
  | (Envelope & {
      type: "text";
      generation: string;
      /** This chunk's position among the `count` chunks of the document's text. */
      index: number;
      count: number;
      text: string;
    })
  | (Envelope & { type: "size"; generation: string; height: number })
  | (Envelope & { type: "error"; generation: string; code: StaticHtmlFrameErrorCode })
  | (Envelope & {
      type: "interaction";
      generation: string;
      focused: boolean;
      hasSelection: boolean;
      pointerSelecting: boolean;
    })
  | (Envelope & { type: "link-request"; generation: string; url: string; label: string })
  | (Envelope & { type: "escape"; generation: string })
  | (Envelope & {
      type: "find-match";
      generation: string;
      /** The active match's box in the frame's viewport; a height of 0 means it is not laid out. */
      top: number;
      height: number;
    });

export type StaticHtmlHostMessage =
  | (Envelope & {
      type: "render";
      generation: string;
      html: string;
      theme: StaticHtmlFrameTheme;
      /** The receipt's profile: the appearance a document without tokens was verified under. */
      verifiedAppearance: "light" | "dark";
    })
  | (Envelope & { type: "theme"; generation: string; theme: StaticHtmlFrameTheme })
  | (Envelope & {
      type: "find";
      generation: string;
      /** Empty clears Find from the document. Goes no further than the frame. */
      query: string;
      /** The active match, counted as Find counts this document's text; null when it is elsewhere. */
      occurrence: number | null;
    });

export type StaticHtmlFrameRejection =
  | "not-object"
  | "too-large"
  | "wrong-channel"
  | "wrong-version"
  | "unknown-type"
  | "bad-shape"
  | "generation-mismatch";

const MESSAGE_KEYS: Record<StaticHtmlFrameMessage["type"], readonly string[]> = {
  ready: ["nonce"],
  rendered: ["generation", "height", "elementCount", "themed"],
  text: ["generation", "index", "count", "text"],
  size: ["generation", "height"],
  error: ["generation", "code"],
  interaction: ["generation", "focused", "hasSelection", "pointerSelecting"],
  "link-request": ["generation", "url", "label"],
  escape: ["generation"],
  "find-match": ["generation", "top", "height"],
};

const MAX_REPORTED_HEIGHT = 100_000;
/** The most chunks one document's text can take. */
export const STATIC_HTML_MAX_TEXT_CHUNKS = Math.ceil(
  STATIC_PRESENTATION_POLICY.maxSearchTextCharacters /
    STATIC_PRESENTATION_POLICY.searchTextChunkCharacters,
);

function validHeight(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_REPORTED_HEIGHT
  );
}

/**
 * Validate one frame-to-host message: exact keys, bounded size, known type,
 * and (after `ready`) the mount's generation. The caller checks the sender
 * window and the nonce.
 */
export function parseStaticHtmlFrameMessage(
  data: unknown,
  generation: string | null,
): { ok: true; message: StaticHtmlFrameMessage } | { ok: false; reason: StaticHtmlFrameRejection } {
  if (typeof data !== "object" || data === null || Array.isArray(data))
    return { ok: false, reason: "not-object" };
  const record = data as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length > 8) return { ok: false, reason: "too-large" };
  let bytes = 0;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") bytes += value.length + key.length;
    else if (typeof value === "object" && value !== null) return { ok: false, reason: "bad-shape" };
    else bytes += key.length + 8;
  }
  if (bytes > FRAME_CHANNEL_POLICY.maxMessageBytes) return { ok: false, reason: "too-large" };
  if (record.channel !== STATIC_HTML_FRAME_CHANNEL) return { ok: false, reason: "wrong-channel" };
  if (record.v !== STATIC_HTML_FRAME_PROTOCOL_VERSION)
    return { ok: false, reason: "wrong-version" };
  const type = record.type;
  if (typeof type !== "string" || !Object.hasOwn(MESSAGE_KEYS, type))
    return { ok: false, reason: "unknown-type" };
  const allowed = ["channel", "v", "type", ...MESSAGE_KEYS[type as StaticHtmlFrameMessage["type"]]];
  if (keys.some((key) => !allowed.includes(key)) || keys.length !== allowed.length)
    return { ok: false, reason: "bad-shape" };
  if (type === "ready") {
    return typeof record.nonce === "string" && STATIC_HTML_MOUNT_ID.test(record.nonce)
      ? { ok: true, message: record as unknown as StaticHtmlFrameMessage }
      : { ok: false, reason: "bad-shape" };
  }
  if (generation === null || record.generation !== generation)
    return { ok: false, reason: "generation-mismatch" };
  switch (type) {
    case "rendered":
      if (
        !validHeight(record.height) ||
        typeof record.themed !== "boolean" ||
        typeof record.elementCount !== "number" ||
        !Number.isInteger(record.elementCount) ||
        record.elementCount < 0 ||
        record.elementCount > STATIC_PRESENTATION_POLICY.maxElements
      )
        return { ok: false, reason: "bad-shape" };
      break;
    case "text":
      if (
        typeof record.text !== "string" ||
        record.text.length === 0 ||
        record.text.length > STATIC_PRESENTATION_POLICY.searchTextChunkCharacters ||
        typeof record.index !== "number" ||
        typeof record.count !== "number" ||
        !Number.isInteger(record.index) ||
        !Number.isInteger(record.count) ||
        record.index < 0 ||
        record.index >= record.count ||
        record.count > STATIC_HTML_MAX_TEXT_CHUNKS
      )
        return { ok: false, reason: "bad-shape" };
      break;
    case "size":
      if (!validHeight(record.height)) return { ok: false, reason: "bad-shape" };
      break;
    case "find-match":
      if (!validHeight(record.top) || !validHeight(record.height))
        return { ok: false, reason: "bad-shape" };
      break;
    case "error":
      if (
        typeof record.code !== "string" ||
        !(STATIC_HTML_FRAME_ERROR_CODES as readonly string[]).includes(record.code)
      )
        return { ok: false, reason: "bad-shape" };
      break;
    case "interaction":
      if (
        typeof record.focused !== "boolean" ||
        typeof record.hasSelection !== "boolean" ||
        typeof record.pointerSelecting !== "boolean"
      )
        return { ok: false, reason: "bad-shape" };
      break;
    case "link-request":
      if (
        typeof record.url !== "string" ||
        typeof record.label !== "string" ||
        record.label.length > FRAME_CHANNEL_POLICY.maxLinkLabelCharacters ||
        normalizeArtifactLink(record.url) === null
      )
        return { ok: false, reason: "bad-shape" };
      break;
  }
  return { ok: true, message: record as unknown as StaticHtmlFrameMessage };
}

/**
 * The trusted runtime of the presentation frame. Self-contained: it is
 * serialized with `toString()` into the frame document, so it may not refer
 * to anything outside its own body (limits arrive as `config`).
 *
 * The sanitizer (`clean`, `elementCount`) is the design runtime's static rule
 * set, kept line-for-line equivalent to `installDesignRuntime` and pinned by
 * a parity test; see `docs/architecture/rich-transcripts.md` for why it is
 * not shared by reference.
 */
export function installStaticHtmlPresentationRuntime(config: {
  nonce: string | null;
  maxHtmlBytes: number;
  maxElements: number;
  maxLinkCharacters: number;
  maxReportedHeight: number;
  maxTextCharacters: number;
  textChunkCharacters: number;
  maxFindQueryCharacters: number;
}) {
  const CHANNEL = "orkestrator-static-html";
  const MOUNT_ID = /^[A-Za-z0-9_-]{16,64}$/;
  const fromHash = /^#([A-Za-z0-9_-]{16,64})$/.exec(window.location.hash)?.[1] ?? null;
  const nonce = config.nonce ?? fromHash;
  let generation: string | null = null;

  const forbidden = "script,iframe,frame,object,embed,base,meta,link,portal,applet";
  const externalUrl = /^\s*(?:https?:)?\/\//i;
  const cssExternal = /url\(\s*['"]?\s*(?:https?:)?\/\//gi;
  const cssImport = /@import\s/gi;
  interface Counts {
    scripts: number;
    handlers: number;
    externalReferences: number;
    forbiddenElements: number;
    executableUrls: number;
  }
  function countCss(text: string | null, counts: Counts) {
    if (!text) return;
    counts.externalReferences += (text.match(cssExternal) ?? []).length;
    counts.externalReferences += (text.match(cssImport) ?? []).length;
  }
  function clean(doc: Document | DocumentFragment, counts: Counts) {
    doc.querySelectorAll(forbidden).forEach((node) => {
      if (node.tagName.toLowerCase() === "script") counts.scripts++;
      else counts.forbiddenElements++;
      node.remove();
    });
    for (const node of Array.from(doc.querySelectorAll("*"))) {
      if (node.tagName.toLowerCase() === "style") countCss(node.textContent, counts);
      for (const attr of Array.from(node.attributes)) {
        const lower = attr.name.toLowerCase();
        if (/^on/i.test(attr.name)) {
          counts.handlers++;
          node.removeAttribute(attr.name);
        } else if (["srcdoc", "nonce", "http-equiv", "action", "formaction"].includes(lower)) {
          counts.forbiddenElements++;
          node.removeAttribute(attr.name);
        } else if (["href", "src", "xlink:href", "srcset", "poster"].includes(lower)) {
          if (/^(?:javascript|vbscript):/i.test(attr.value.trim())) {
            counts.executableUrls++;
            node.removeAttribute(attr.name);
          } else if (externalUrl.test(attr.value) && lower !== "href") {
            counts.externalReferences++;
          }
        } else if (lower === "style") {
          countCss(attr.value, counts);
        }
      }
      if (node instanceof HTMLTemplateElement) clean(node.content, counts);
    }
  }
  function elementCount(root: Document | DocumentFragment): number {
    let total = 0;
    for (const node of Array.from(root.querySelectorAll("*"))) {
      total++;
      if (node instanceof HTMLTemplateElement) total += elementCount(node.content);
    }
    return total;
  }

  const post = (message: Record<string, unknown>) => {
    try {
      window.parent.postMessage({ channel: CHANNEL, v: 1, ...message }, "*");
    } catch {
      // A detached frame has no parent to report to.
    }
  };

  interface Theme {
    appearance: "light" | "dark";
    reducedMotion: boolean;
    tokens: Record<string, string>;
  }
  // A document that names no token was authored against its verified profile,
  // often with hard-coded colours. It keeps that profile on an opaque canvas,
  // because inheriting a dark theme's pale text could make it unreadable.
  let themed = false;
  const appliedTokens = new Set<string>();
  function applyTheme(theme: unknown) {
    const value = (theme ?? {}) as Partial<Theme>;
    const appearance = value.appearance === "dark" ? "dark" : "light";
    const root = document.documentElement;
    for (const key of Array.from(appliedTokens)) root.style.removeProperty(key);
    appliedTokens.clear();
    if (value.tokens && typeof value.tokens === "object") {
      for (const [key, token] of Object.entries(value.tokens).slice(0, 64)) {
        if (
          /^--ork-[a-z0-9-]{1,40}$/.test(key) &&
          typeof token === "string" &&
          token.length < 200
        ) {
          root.style.setProperty(key, token);
          appliedTokens.add(key);
        }
      }
    }
    root.dataset.orkTheme = appearance;
    root.dataset.orkReducedMotion = value.reducedMotion === true ? "true" : "false";
    root.style.colorScheme = appearance;
  }

  // Zero-specificity defaults: authored CSS always wins over them.
  const HOST_STYLE =
    ":where(html){-webkit-text-size-adjust:100%;overflow-wrap:break-word}" +
    ":where(img,video){max-width:100%;height:auto}" +
    ":where(svg){max-width:100%}" +
    ":where(summary){cursor:pointer}" +
    "::highlight(ork-find-match){color:inherit;background-color:rgb(250 204 21/.32)}" +
    "::highlight(ork-find-active){color:inherit;background-color:rgb(251 146 60/.78)}" +
    "[data-ork-reduced-motion=true] *{animation-duration:0s!important;transition-duration:0s!important}";
  const THEMED_STYLE =
    ":where(html){color:var(--ork-foreground,CanvasText);font-family:var(--ork-font-sans,system-ui,sans-serif)}" +
    ":where(body){margin:12px}" +
    ":where(a){color:var(--ork-primary,LinkText)}";
  const VERIFIED_STYLE =
    ":where(html){background:Canvas;color:CanvasText;font-family:system-ui,-apple-system,sans-serif}";

  function measure(): number {
    const root = document.documentElement.getBoundingClientRect().height;
    const body = document.body ? document.body.scrollHeight : 0;
    return Math.min(config.maxReportedHeight, Math.ceil(Math.max(root, body)));
  }
  let lastHeight = -1;
  let sizeTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleSize() {
    if (!generation || sizeTimer) return;
    // At most one report per 300 ms; the latest height always arrives.
    sizeTimer = setTimeout(() => {
      sizeTimer = null;
      const height = measure();
      // A frame in a hidden tab has no layout; its last real height stands.
      if (height === 0 || height === lastHeight || !generation) return;
      lastHeight = height;
      post({ type: "size", generation, height });
    }, 300);
  }

  let interaction = { focused: false, hasSelection: false, pointerSelecting: false };
  let interactionTimer: ReturnType<typeof setTimeout> | null = null;
  function noteInteraction(patch: Partial<typeof interaction>) {
    const next = { ...interaction, ...patch };
    if (
      next.focused === interaction.focused &&
      next.hasSelection === interaction.hasSelection &&
      next.pointerSelecting === interaction.pointerSelecting
    )
      return;
    interaction = next;
    if (!generation || interactionTimer) return;
    interactionTimer = setTimeout(() => {
      interactionTimer = null;
      if (generation) post({ type: "interaction", generation, ...interaction });
    }, 100);
  }

  // Elements whose text sits on one line with its neighbours; anything else is
  // a boundary a search must not match across.
  const INLINE_TEXT =
    /^(?:a|abbr|b|bdi|bdo|cite|code|data|del|dfn|em|font|i|ins|kbd|label|mark|q|rp|rt|ruby|s|samp|small|span|strike|strong|sub|sup|time|tspan|tt|u|var|wbr)$/;
  // Read from the sanitized tree, not layout: a closed disclosure's text counts,
  // and a frame in a hidden tab reports the same text as a visible one. Runs of
  // whitespace become one space, boundaries become one line break, and neither
  // starts or ends the text. Each character remembers where it came from, so the
  // text Find searches and the ranges drawn here are one walk.
  interface DocumentText {
    text: string;
    /** The text node of each character; null for a boundary's line break. */
    nodes: Array<Node | null>;
    offsets: number[];
  }
  function documentText(): DocumentText {
    const result: DocumentText = { text: "", nodes: [], offsets: [] };
    let space: { node: Node; offset: number } | null = null;
    let boundary = false;
    const emit = (character: string, node: Node | null, offset: number) => {
      if (result.text.length >= config.maxTextCharacters) return;
      result.text += character;
      result.nodes.push(node);
      result.offsets.push(offset);
    };
    const visit = (node: Node) => {
      if (node.nodeType === 3) {
        const value = node.nodeValue ?? "";
        for (let offset = 0; offset < value.length; offset++) {
          const character = value[offset]!;
          if (/\s/.test(character)) {
            space ??= { node, offset };
            continue;
          }
          if (result.text.length > 0) {
            if (boundary) emit("\n", null, 0);
            else if (space) emit(" ", space.node, space.offset);
          }
          boundary = false;
          space = null;
          emit(character, node, offset);
        }
      }
      if (node.nodeType !== 1) return;
      const element = node as Element;
      if (/^(?:style|noscript)$/.test(element.localName) || element.hasAttribute("hidden")) return;
      const isBoundary = !INLINE_TEXT.test(element.localName);
      if (isBoundary) boundary = true;
      for (const child of Array.from(element.childNodes)) visit(child);
      if (isBoundary) boundary = true;
    };
    if (document.body) visit(document.body);
    return result;
  }
  function reportText() {
    try {
      const { text } = documentText();
      const size = config.textChunkCharacters;
      const count = Math.ceil(text.length / size);
      for (let index = 0; index < count; index++)
        post({
          type: "text",
          generation,
          index,
          count,
          text: text.slice(index * size, (index + 1) * size),
        });
    } catch {
      // Find only loses this document's body; the document itself stays on screen.
    }
  }

  // Find inside the document. Highlights are drawn over the text, not written
  // into it, so the query never reaches the DOM, the height does not change and
  // the walk above still reads the same text. The n-th match is the n-th match
  // of `findAgentChatTextMatches` over the text this frame reported, which the
  // matching below repeats and a test pins.
  let findText: DocumentText | null = null;
  let activeMatch: Range | null = null;
  const revealed = new Set<HTMLDetailsElement>();

  let findReportTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleFindReport() {
    if (!activeMatch || findReportTimer) return;
    // Paced under the frame channel's rate however fast the reader steps. Only
    // numbers leave the frame.
    findReportTimer = setTimeout(() => {
      findReportTimer = null;
      if (!activeMatch || !generation) return;
      const box = activeMatch.getBoundingClientRect();
      const bound = (value: number) => Math.min(config.maxReportedHeight, Math.max(0, value));
      post({ type: "find-match", generation, top: bound(box.top), height: bound(box.height) });
    }, 100);
  }

  function findRanges(
    query: string,
    occurrence: number | null,
  ): { ranges: Range[]; active: Range | null } {
    findText ??= documentText();
    const { text, nodes, offsets } = findText;
    const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
    const ranges: Range[] = [];
    let active: Range | null = null;
    let ordinal = 0;
    for (const match of text.matchAll(expression)) {
      if (match.index === undefined || match[0].length === 0) continue;
      const last = match.index + match[0].length - 1;
      const startNode = nodes[match.index];
      const endNode = nodes[last];
      if (startNode && endNode) {
        const range = document.createRange();
        range.setStart(startNode, offsets[match.index]!);
        range.setEnd(endNode, offsets[last]! + 1);
        ranges.push(range);
        if (ordinal === occurrence) active = range;
      }
      ordinal++;
    }
    return { ranges, active };
  }

  // Temporary, like Find's reveals in the transcript: a disclosure opened for one
  // match closes when the match moves on, unless the reader has since toggled it.
  function revealActiveMatch() {
    const needed = new Set<HTMLDetailsElement>();
    const start = activeMatch?.startContainer;
    let holder = start instanceof Element ? start : (start?.parentElement ?? null);
    while (holder) {
      const details: HTMLDetailsElement | null = holder.closest("details");
      if (!details) break;
      needed.add(details);
      holder = details.parentElement;
    }
    for (const details of Array.from(revealed)) {
      if (needed.has(details)) continue;
      details.open = false;
      revealed.delete(details);
    }
    for (const details of Array.from(needed)) {
      if (details.open) continue;
      details.open = true;
      revealed.add(details);
    }
  }

  function applyFind(query: string, occurrence: number | null) {
    const searching = query.trim().length > 0;
    const { ranges, active } = searching
      ? findRanges(query, occurrence)
      : { ranges: [], active: null };
    if (!searching) findText = null;
    activeMatch = active;
    if (typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined") {
      const matchHighlight = new Highlight();
      for (const range of ranges) matchHighlight.add(range);
      const activeHighlight = new Highlight();
      if (active) activeHighlight.add(active);
      activeHighlight.priority = 1;
      CSS.highlights.set("ork-find-match", matchHighlight);
      CSS.highlights.set("ork-find-active", activeHighlight);
    }
    revealActiveMatch();
    if (!active) return;
    // A document taller than its frame scrolls inside it; the host brings the
    // frame's part of the transcript on screen from the report below.
    const box = active.getBoundingClientRect();
    const scroller = document.scrollingElement;
    if (scroller && box.height > 0 && (box.top < 0 || box.bottom > window.innerHeight))
      scroller.scrollTop += box.top - (window.innerHeight - box.height) / 2;
    scheduleFindReport();
  }

  function render(html: unknown, theme: unknown, verifiedAppearance: unknown): void {
    const fail = (code: string) => post({ type: "error", generation, code });
    if (typeof html !== "string") return fail("invalid-render");
    if (new TextEncoder().encode(html).length > config.maxHtmlBytes) return fail("too-large");
    const doc = new DOMParser().parseFromString(html, "text/html");
    clean(doc, {
      scripts: 0,
      handlers: 0,
      externalReferences: 0,
      forbiddenElements: 0,
      executableUrls: 0,
    });
    const total = elementCount(doc);
    if (total > config.maxElements) return fail("too-many-elements");
    document.documentElement.replaceChildren(
      ...Array.from(doc.documentElement.childNodes).map((node) => document.importNode(node, true)),
    );
    for (const attr of Array.from(document.documentElement.attributes))
      document.documentElement.removeAttribute(attr.name);
    for (const attr of Array.from(doc.documentElement.attributes))
      document.documentElement.setAttribute(attr.name, attr.value);
    const style = document.createElement("style");
    style.setAttribute("data-ork-presentation", "");
    themed = /--ork-/.test(html);
    style.textContent = HOST_STYLE + (themed ? THEMED_STYLE : VERIFIED_STYLE);
    document.head.prepend(style);
    applyTheme(
      themed
        ? theme
        : {
            appearance: verifiedAppearance,
            reducedMotion: (theme as Partial<Theme> | null)?.reducedMotion,
            tokens: {},
          },
    );
    const observer = new ResizeObserver(scheduleSize);
    observer.observe(document.documentElement);
    if (document.body) observer.observe(document.body);
    lastHeight = measure();
    post({ type: "rendered", generation, height: lastHeight, elementCount: total, themed });
    reportText();
  }

  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window.parent) return;
    const data = event.data as Record<string, unknown> | null;
    if (!data || typeof data !== "object" || data.channel !== CHANNEL || data.v !== 1) return;
    if (data.type === "render") {
      // One document per mount: a second render is ignored, never merged.
      if (generation !== null || typeof data.generation !== "string") return;
      if (!MOUNT_ID.test(data.generation)) return;
      generation = data.generation;
      try {
        render(data.html, data.theme, data.verifiedAppearance);
      } catch {
        post({ type: "error", generation, code: "render-failed" });
      }
    } else if (
      data.type === "theme" &&
      themed &&
      generation !== null &&
      data.generation === generation
    ) {
      applyTheme(data.theme);
      scheduleSize();
    } else if (data.type === "find" && generation !== null && data.generation === generation) {
      // Exactly the host's six keys, bounded like the host's own limit.
      const { query, occurrence } = data;
      if (
        Object.keys(data).length !== 6 ||
        typeof query !== "string" ||
        query.length > config.maxFindQueryCharacters ||
        (occurrence !== null &&
          (typeof occurrence !== "number" ||
            !Number.isInteger(occurrence) ||
            occurrence < 0 ||
            occurrence > config.maxTextCharacters))
      )
        return;
      try {
        applyFind(query, occurrence as number | null);
      } catch {
        // Find only loses its highlight; the document itself stays on screen.
      }
    }
  });

  // Navigation never happens inside the frame. A real primary click on an
  // http(s) link becomes a request the host shows as its own control;
  // in-document fragments scroll the frame itself.
  const linkOf = (target: EventTarget | null): Element | null =>
    target instanceof Element ? target.closest("a, area") : null;
  document.addEventListener(
    "click",
    (event) => {
      const anchor = linkOf(event.target);
      if (!anchor) return;
      event.preventDefault();
      if (!event.isTrusted || event.button !== 0 || !generation) return;
      const href = (
        anchor.getAttribute("href") ??
        anchor.getAttributeNS("http://www.w3.org/1999/xlink", "href") ??
        ""
      ).trim();
      if (href.startsWith("#")) {
        let id = href.slice(1);
        try {
          id = decodeURIComponent(id);
        } catch {
          // A malformed escape names no element.
        }
        const destination = id ? document.getElementById(id) : null;
        const scroller = document.scrollingElement;
        if (destination && scroller) scroller.scrollTop += destination.getBoundingClientRect().top;
        return;
      }
      if (!/^https?:\/\//i.test(href) || href.length > config.maxLinkCharacters) return;
      const label = (anchor.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
      post({ type: "link-request", generation, url: href, label });
    },
    true,
  );
  document.addEventListener(
    "auxclick",
    (event) => {
      if (linkOf(event.target)) event.preventDefault();
    },
    true,
  );
  document.addEventListener("submit", (event) => event.preventDefault(), true);
  document.addEventListener(
    "click",
    (event) => {
      // The reader's own toggle ends a temporary reveal, so their choice stands.
      const summary = event.target instanceof Element ? event.target.closest("summary") : null;
      if (summary?.parentElement) revealed.delete(summary.parentElement as HTMLDetailsElement);
    },
    true,
  );
  // The host resizing the frame moves the match inside it.
  window.addEventListener("resize", scheduleFindReport);
  document.addEventListener(
    "keydown",
    (event) => {
      // Escape returns focus to the transcript; no other key leaves the frame.
      if (event.key === "Escape" && generation) post({ type: "escape", generation });
    },
    true,
  );
  document.addEventListener("toggle", scheduleSize, true);
  document.addEventListener("selectionchange", () => {
    const selection = document.getSelection();
    noteInteraction({ hasSelection: Boolean(selection && !selection.isCollapsed) });
  });
  window.addEventListener("focus", () => noteInteraction({ focused: true }));
  window.addEventListener("blur", () => noteInteraction({ focused: false }));
  document.addEventListener("pointerdown", () => noteInteraction({ pointerSelecting: true }), true);
  for (const name of ["pointerup", "pointercancel"])
    document.addEventListener(name, () => noteInteraction({ pointerSelecting: false }), true);

  const start = () => {
    if (nonce && MOUNT_ID.test(nonce)) post({ type: "ready", nonce });
  };
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
}

function runtimeScript(nonce: string | null): string {
  const config = {
    nonce,
    maxHtmlBytes: STATIC_PRESENTATION_POLICY.maxDocumentBytes,
    maxElements: STATIC_PRESENTATION_POLICY.maxElements,
    maxLinkCharacters: FRAME_CHANNEL_POLICY.maxLinkCharacters,
    maxReportedHeight: MAX_REPORTED_HEIGHT,
    maxTextCharacters: STATIC_PRESENTATION_POLICY.maxSearchTextCharacters,
    textChunkCharacters: STATIC_PRESENTATION_POLICY.searchTextChunkCharacters,
    maxFindQueryCharacters: STATIC_HTML_MAX_FIND_QUERY_CHARACTERS,
  };
  return `(${installStaticHtmlPresentationRuntime.toString()})(${JSON.stringify(config)});`;
}

function frameDocument(scriptSource: string, scriptAttributes: string, script: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${scriptSource}; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"></head><body><script${scriptAttributes}>${script}</script></body></html>`;
}

/**
 * Development form, for a `srcdoc` frame: only the nonce-bearing bootstrap
 * runs. `mountNonce` is also the readiness nonce the frame reports.
 */
export function staticHtmlFrameBootstrap(mountNonce: string): string {
  if (!STATIC_HTML_MOUNT_ID.test(mountNonce)) throw new Error("Invalid mount nonce");
  return frameDocument(
    `'nonce-${mountNonce}'`,
    ` nonce="${mountNonce}"`,
    runtimeScript(mountNonce),
  );
}

/**
 * Production form, emitted as a file beside `index.html`. Its policy pins the
 * script's hash, and the frame reads its readiness nonce from the URL
 * fragment the host appends per mount. The hash function is a parameter
 * because this module also runs in the browser.
 */
export function staticHtmlFrameDocument(sha256Base64: (script: string) => string): string {
  const script = runtimeScript(null);
  return frameDocument(`'sha256-${sha256Base64(script)}'`, "", script);
}
