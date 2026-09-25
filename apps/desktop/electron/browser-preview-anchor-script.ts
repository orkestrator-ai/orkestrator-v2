/**
 * Page-side helpers shared by the capture runtime and the pin resolver.
 *
 * `browserPreviewAnchorKit` is serialized with `Function.prototype.toString`
 * and evaluated inside the preview page, so it must stay self-contained: no
 * imports, no module-level references. Everything it returns is untrusted by
 * Electron main, which revalidates every field.
 *
 * All DOM work is bounded before serialization: visited nodes, children per
 * element, characters, attributes, and wall-clock time. Structural HTML is
 * rebuilt from whitelisted tags and attributes instead of reading `outerHTML`.
 */
export function browserPreviewAnchorKit() {
  const UI_ATTRIBUTE = "data-orkestrator-annotation-ui";
  const ANCHOR_TEXT_CHARS = 300;
  const QUOTE_CHARS = 1_200;
  const CONTEXT_CHARS = 64;
  const NAME_CHARS = 120;
  const LABEL_NAME_CHARS = 48;
  const MAX_ANCESTORS = 8;
  const MAX_CHILDREN = 400;
  const HTML_CHARS = 6_000;
  const HTML_DEPTH = 8;
  const HTML_NODES = 160;
  const EVIDENCE_TEXT_CHARS = 2_000;
  const ATTRIBUTE_VALUE_CHARS = 300;
  const MAX_EVIDENCE_ATTRIBUTES = 24;
  const MAX_SENSITIVE_RECTS = 32;
  const SKIP_TAGS = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "TEMPLATE",
    "HEAD",
    "META",
    "LINK",
    "TITLE",
    "BASE",
  ]);
  const BLOCK_TAGS = new Set([
    "ADDRESS",
    "ARTICLE",
    "ASIDE",
    "BLOCKQUOTE",
    "BR",
    "DD",
    "DETAILS",
    "DIALOG",
    "DIV",
    "DL",
    "DT",
    "FIELDSET",
    "FIGCAPTION",
    "FIGURE",
    "FOOTER",
    "FORM",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "HEADER",
    "HR",
    "LI",
    "MAIN",
    "NAV",
    "OL",
    "P",
    "PRE",
    "SECTION",
    "SUMMARY",
    "TABLE",
    "TD",
    "TH",
    "TR",
    "UL",
  ]);
  const HTML_DROP_TAGS = new Set([
    "script",
    "style",
    "noscript",
    "template",
    "object",
    "embed",
    "frame",
    "frameset",
    "link",
    "meta",
    "base",
  ]);
  const VOID_TAGS = new Set([
    "area",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "source",
    "track",
    "wbr",
  ]);
  const KNOWN_TAG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
  const TOKEN_PARAMETER =
    /(token|secret|password|passwd|pwd|auth|session|sid|sig|signature|key|credential|jwt|bearer|code|otp|nonce|state|cookie)/i;
  const OPAQUE_VALUE = /^[A-Za-z0-9+/_=.-]{32,}$/;
  const UNSAFE_URL = /^\s*(?:javascript|vbscript|data|file|blob):/i;
  const GENERATED_ID =
    /^:|:$|^(?:radix|headlessui|react-aria|mui|ember|rc-|__)|[0-9a-f]{8,}|\d{4,}/i;
  const SENSITIVE_SELECTOR = [
    'input[type="password" i]',
    'input[autocomplete*="cc-" i]',
    'input[autocomplete*="one-time-code" i]',
    'input[autocomplete*="password" i]',
    "[data-sensitive]",
  ].join(",");
  const STYLE_PROPERTIES = [
    "color",
    "background-color",
    "font-family",
    "font-size",
    "font-weight",
    "line-height",
    "letter-spacing",
    "text-align",
    "text-decoration",
    "display",
    "position",
    "z-index",
    "box-sizing",
    "width",
    "height",
    "margin",
    "padding",
    "border",
    "border-radius",
    "opacity",
    "visibility",
    "overflow",
    "flex",
    "gap",
    "grid-template-columns",
    "align-items",
    "justify-content",
  ];

  type Rect = { x: number; y: number; width: number; height: number };
  type Budget = { visits: number; deadline: number; exhausted: boolean };
  type Counters = { attributesRemoved: number; valuesMasked: number; urlParametersRemoved: number };
  type Ancestor = {
    tagName: string;
    id: string | null;
    role: string | null;
    testId: string | null;
    name: string | null;
  };
  type Quote = { exact: string; prefix: string; suffix: string };
  type Anchor = {
    stableId?: { kind: "id" | "test-id"; value: string };
    semantic: { tagName: string; role: string | null; name: string | null };
    text: Quote | null;
    ancestors: Ancestor[];
    cssPath: string;
    scope:
      | { kind: "document" }
      | { kind: "unsupported"; reason: "iframe" | "shadow-root" | "closed-root" | "cross-origin" };
  };
  /** A boundary between nodes: before a node, after a node, or inside a text node. */
  type Marker =
    | { kind: "enter"; node: Node }
    | { kind: "exit"; node: Node }
    | { kind: "text"; node: Node; offset: number };
  type Resolution = {
    state: "matched" | "missing" | "ambiguous" | "stale" | "unsupported" | "too-complex";
    rule: "stable-id" | "semantic-context" | "structural-path" | "text-quote" | "none";
    candidateCount: number;
    rect: Rect | null;
    element: Element | null;
    range: Range | null;
  };

  const now = (): number =>
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();
  const createBudget = (visits: number, milliseconds: number): Budget => ({
    visits,
    deadline: now() + milliseconds,
    exhausted: false,
  });
  const spend = (budget: Budget): boolean => {
    if (budget.exhausted) return false;
    budget.visits -= 1;
    if (budget.visits < 0 || ((budget.visits & 31) === 0 && now() > budget.deadline)) {
      budget.exhausted = true;
      return false;
    }
    return true;
  };
  /** `slice(0, end)` that never leaves half of a UTF-16 surrogate pair. */
  const safeSlice = (value: string, end: number): string => {
    if (end >= value.length) return value;
    const code = value.charCodeAt(end - 1);
    return value.slice(0, code >= 0xd800 && code <= 0xdbff ? end - 1 : end);
  };
  const normalize = (value: string | null | undefined, max: number): string =>
    safeSlice(
      safeSlice(value ?? "", max * 4)
        .replace(/\s+/g, " ")
        .trim(),
      max,
    );
  const sameText = (left: string | null | undefined, right: string | null | undefined): boolean => {
    const a = normalize(left, ANCHOR_TEXT_CHARS).toLowerCase();
    const b = normalize(right, ANCHOR_TEXT_CHARS).toLowerCase();
    return a === b;
  };
  /** Equal, or one contains most of the other: a trailing count or icon text still matches. */
  const similarText = (
    left: string | null | undefined,
    right: string | null | undefined,
  ): boolean => {
    const a = normalize(left, ANCHOR_TEXT_CHARS).toLowerCase();
    const b = normalize(right, ANCHOR_TEXT_CHARS).toLowerCase();
    if (a === b) return true;
    if (!a || !b) return false;
    const shorter = a.length <= b.length ? a : b;
    const longer = a.length <= b.length ? b : a;
    return longer.includes(shorter) && shorter.length / longer.length >= 0.6;
  };
  const roundRect = (rect: { x: number; y: number; width: number; height: number }): Rect => {
    const round = (value: number) => (Number.isFinite(value) ? Math.round(value * 100) / 100 : 0);
    return {
      x: round(rect.x),
      y: round(rect.y),
      width: Math.max(0, round(rect.width)),
      height: Math.max(0, round(rect.height)),
    };
  };
  const rectOf = (target: Element | Range): Rect => {
    try {
      const rect = target.getBoundingClientRect();
      return roundRect({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
    } catch {
      return { x: 0, y: 0, width: 0, height: 0 };
    }
  };
  const isElement = (node: unknown): node is Element =>
    Boolean(node) && (node as Node).nodeType === 1;
  const isInspectorNode = (node: Node | null | undefined): boolean => {
    const element = isElement(node) ? node : (node?.parentElement ?? null);
    return Boolean(element?.closest?.(`[${UI_ATTRIBUTE}]`));
  };
  const escapeAttributeValue = (value: string): string =>
    value.replace(/[\\"]/g, "\\$&").replace(/\n/g, "\\a ").replace(/\r/g, "\\d ");
  const escapeIdentifier = (value: string): string => {
    const css = (globalThis as { CSS?: { escape?: (value: string) => string } }).CSS;
    if (css && typeof css.escape === "function") return css.escape(value);
    return value
      .replace(/^(\d)/, "\\3$1 ")
      .replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
  };
  const countMatches = (selector: string, limit = 2): number => {
    try {
      const matches = document.querySelectorAll(selector);
      return Math.min(matches.length, limit);
    } catch {
      return limit;
    }
  };
  const escapeHtml = (value: string): string =>
    value.replace(/[&<>"']/g, (character) =>
      character === "&"
        ? "&amp;"
        : character === "<"
          ? "&lt;"
          : character === ">"
            ? "&gt;"
            : character === '"'
              ? "&quot;"
              : "&#39;",
    );

  const inputType = (element: Element): string =>
    (element.getAttribute("type") ?? "text").trim().toLowerCase();

  const isSensitiveElement = (element: Element): boolean => {
    if (element.hasAttribute("data-sensitive")) return true;
    if (element.tagName !== "INPUT") return false;
    if (inputType(element) === "password") return true;
    const autocomplete = (element.getAttribute("autocomplete") ?? "").toLowerCase();
    return (
      autocomplete.includes("cc-") ||
      autocomplete.includes("one-time-code") ||
      autocomplete.includes("password")
    );
  };
  const insideSensitive = (node: Node | null): boolean => {
    let current: Element | null = isElement(node) ? node : (node?.parentElement ?? null);
    for (let depth = 0; current && depth < 64; depth += 1) {
      if (isSensitiveElement(current)) return true;
      current = current.parentElement;
    }
    return false;
  };
  const isHiddenCheaply = (element: Element): boolean =>
    element.hasAttribute("hidden") ||
    (element as HTMLElement).style?.display === "none" ||
    (element.tagName === "INPUT" && inputType(element) === "hidden");
  /** Elements whose descendants never contribute readable page text. */
  const skipsText = (element: Element): boolean =>
    SKIP_TAGS.has(element.tagName) ||
    element.hasAttribute(UI_ATTRIBUTE) ||
    element.tagName === "TEXTAREA" ||
    element.tagName === "INPUT" ||
    element.tagName === "SELECT" ||
    isSensitiveElement(element) ||
    isHiddenCheaply(element);

  /**
   * Walk `root` in document order, splitting text into before/inside/after
   * around two markers. Stops once enough trailing context was read.
   */
  const splitText = (
    root: Node,
    start: Marker | null,
    end: Marker | null,
    limits: { inside: number; context: number },
    budget: Budget,
  ): { before: string; inside: string; after: string; complete: boolean } => {
    const parts = { before: "", inside: "", after: "" };
    let phase: "before" | "inside" | "after" = start ? "before" : "inside";
    const append = (text: string) => {
      if (!text) return;
      if (phase === "before") {
        parts.before += text;
        if (parts.before.length > limits.context * 8) {
          parts.before = parts.before.slice(-limits.context * 4);
        }
      } else if (phase === "inside") {
        if (parts.inside.length < limits.inside * 2)
          parts.inside += text.slice(0, limits.inside * 2);
      } else {
        parts.after += text.slice(0, limits.context * 4);
      }
    };
    const markerIs = (marker: Marker | null, kind: Marker["kind"], node: Node) =>
      Boolean(marker && marker.kind === kind && marker.node === node);
    const advance = (kind: Marker["kind"], node: Node) => {
      if (phase === "before" && markerIs(start, kind, node)) phase = "inside";
      if (phase === "inside" && markerIs(end, kind, node)) phase = "after";
    };
    const stack: Array<{ node: Node; exit: boolean }> = [{ node: root, exit: false }];
    let complete = true;
    while (stack.length > 0) {
      if (phase === "after" && parts.after.length >= limits.context * 2) break;
      if (!end && phase === "inside" && parts.inside.length >= limits.inside * 2) break;
      if (!spend(budget)) {
        complete = false;
        break;
      }
      const item = stack.pop()!;
      const node = item.node;
      if (item.exit) {
        advance("exit", node);
        if (BLOCK_TAGS.has((node as Element).tagName)) append(" ");
        continue;
      }
      advance("enter", node);
      if (node.nodeType === 3) {
        const value = (node.nodeValue ?? "").slice(0, 20_000);
        const startOffset =
          start?.kind === "text" && start.node === node && phase === "before" ? start.offset : -1;
        const endOffset = end?.kind === "text" && end.node === node ? end.offset : -1;
        if (startOffset >= 0) {
          append(value.slice(0, startOffset));
          phase = "inside";
          if (endOffset >= 0) {
            append(value.slice(startOffset, endOffset));
            phase = "after";
            append(value.slice(endOffset));
          } else {
            append(value.slice(startOffset));
          }
        } else if (endOffset >= 0 && phase === "inside") {
          append(value.slice(0, endOffset));
          phase = "after";
          append(value.slice(endOffset));
        } else {
          append(value);
        }
        continue;
      }
      if (!isElement(node)) {
        if (node.nodeType === 9 || node.nodeType === 11) {
          const children = node.childNodes;
          for (let index = Math.min(children.length, MAX_CHILDREN) - 1; index >= 0; index -= 1) {
            stack.push({ node: children[index]!, exit: false });
          }
        }
        continue;
      }
      stack.push({ node, exit: true });
      if (node !== root && skipsText(node)) continue;
      if (node === root && (SKIP_TAGS.has(node.tagName) || isSensitiveElement(node))) continue;
      if (BLOCK_TAGS.has(node.tagName)) append(" ");
      const children = node.childNodes;
      for (let index = Math.min(children.length, MAX_CHILDREN) - 1; index >= 0; index -= 1) {
        stack.push({ node: children[index]!, exit: false });
      }
    }
    return { ...parts, complete };
  };

  const visibleText = (root: Node, max: number, budget: Budget): string =>
    normalize(splitText(root, null, null, { inside: max, context: 0 }, budget).inside, max);

  /**
   * The nearest ancestor that adds text around `node` (at most `levels` up).
   * Keeping context local means a repeated card is described by its own
   * heading, not by its neighbours.
   */
  const contextRoot = (node: Node, levels: number): Node => {
    let current: Element | null = isElement(node) ? node : node.parentElement;
    if (!current) return document.body ?? document.documentElement;
    const own = visibleText(current, 200, createBudget(600, 5));
    for (let level = 0; level < levels; level += 1) {
      const parent: Element | null = current.parentElement;
      if (!parent || parent === document.documentElement) break;
      current = parent;
      if (visibleText(current, 200, createBudget(600, 5)) !== own) break;
    }
    return current;
  };

  const surrounding = (
    start: Marker,
    end: Marker,
    anchorNode: Node,
    insideMax: number,
    budget: Budget,
  ): Quote & { complete: boolean } => {
    const root = contextRoot(anchorNode, 3);
    const parts = splitText(
      root,
      start,
      end,
      { inside: insideMax, context: CONTEXT_CHARS },
      budget,
    );
    const before = normalize(parts.before.slice(-CONTEXT_CHARS * 4), CONTEXT_CHARS * 4);
    return {
      exact: normalize(parts.inside, insideMax),
      prefix: before.slice(-CONTEXT_CHARS).trimStart(),
      suffix: normalize(parts.after, CONTEXT_CHARS),
      complete: parts.complete,
    };
  };

  const implicitRole = (element: Element): string | null => {
    const explicit = element.getAttribute("role");
    if (explicit && explicit.trim()) return normalize(explicit.trim().split(/\s+/)[0], 100) || null;
    switch (element.tagName) {
      case "A":
      case "AREA":
        return element.hasAttribute("href") ? "link" : null;
      case "BUTTON":
      case "SUMMARY":
        return "button";
      case "INPUT": {
        const type = inputType(element);
        if (["button", "submit", "reset", "image"].includes(type)) return "button";
        if (type === "checkbox" || type === "radio") return type;
        if (type === "range") return "slider";
        if (type === "number") return "spinbutton";
        if (type === "search") return "searchbox";
        if (type === "hidden") return null;
        return element.hasAttribute("list") ? "combobox" : "textbox";
      }
      case "SELECT":
        return element.hasAttribute("multiple") || Number(element.getAttribute("size")) > 1
          ? "listbox"
          : "combobox";
      case "TEXTAREA":
        return "textbox";
      case "IMG":
        return element.getAttribute("alt") === "" ? "presentation" : "img";
      case "H1":
      case "H2":
      case "H3":
      case "H4":
      case "H5":
      case "H6":
        return "heading";
      case "NAV":
        return "navigation";
      case "MAIN":
        return "main";
      case "HEADER":
        return "banner";
      case "FOOTER":
        return "contentinfo";
      case "ASIDE":
        return "complementary";
      case "FORM":
        return "form";
      case "UL":
      case "OL":
        return "list";
      case "LI":
        return "listitem";
      case "TABLE":
        return "table";
      case "TR":
        return "row";
      case "TD":
        return "cell";
      case "TH":
        return "columnheader";
      case "DIALOG":
        return "dialog";
      case "ARTICLE":
        return "article";
      case "SECTION":
        return "region";
      case "OPTION":
        return "option";
      case "PROGRESS":
        return "progressbar";
      case "HR":
        return "separator";
      case "FIELDSET":
      case "DETAILS":
        return "group";
      default:
        return null;
    }
  };

  const LABELABLE = new Set([
    "INPUT",
    "SELECT",
    "TEXTAREA",
    "METER",
    "PROGRESS",
    "OUTPUT",
    "BUTTON",
  ]);
  /** Accessible name from attributes only: cheap, used for ancestors. */
  const attributeName = (element: Element, budget: Budget): string | null => {
    const aria = normalize(element.getAttribute("aria-label"), NAME_CHARS);
    if (aria) return aria;
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const names: string[] = [];
      for (const id of labelledBy.trim().split(/\s+/).slice(0, 5)) {
        const labelElement = document.getElementById(id);
        if (labelElement && !isInspectorNode(labelElement)) {
          names.push(visibleText(labelElement, NAME_CHARS, budget));
        }
      }
      const joined = normalize(names.join(" "), NAME_CHARS);
      if (joined) return joined;
    }
    return null;
  };
  const accessibleName = (element: Element, budget: Budget): string | null => {
    const fromAttributes = attributeName(element, budget);
    if (fromAttributes) return fromAttributes;
    if (isSensitiveElement(element))
      return normalize(element.getAttribute("title"), NAME_CHARS) || null;
    if (LABELABLE.has(element.tagName)) {
      let label: Element | null = null;
      const id = element.getAttribute("id");
      if (id) {
        try {
          label = document.querySelector(`label[for="${escapeAttributeValue(id)}"]`);
        } catch {
          label = null;
        }
      }
      label ??= element.closest("label");
      if (label && !isInspectorNode(label)) {
        const text = visibleText(label, NAME_CHARS, budget);
        if (text) return text;
      }
    }
    if (
      element.tagName === "IMG" ||
      element.tagName === "AREA" ||
      (element.tagName === "INPUT" && inputType(element) === "image")
    ) {
      const alt = normalize(element.getAttribute("alt"), NAME_CHARS);
      if (alt) return alt;
    }
    if (element.tagName === "INPUT" && ["button", "submit", "reset"].includes(inputType(element))) {
      // The caption of a button-like input is its value; other input values are never read.
      const caption = normalize(element.getAttribute("value"), NAME_CHARS);
      if (caption) return caption;
    }
    const title = normalize(element.getAttribute("title"), NAME_CHARS);
    if (title) return title;
    if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
      return normalize(element.getAttribute("placeholder"), NAME_CHARS) || null;
    }
    if (element.tagName === "SELECT") return null;
    return visibleText(element, NAME_CHARS, budget) || null;
  };

  const looksGenerated = (value: string): boolean => GENERATED_ID.test(value);
  const stableIdFor = (element: Element): Anchor["stableId"] | undefined => {
    const testId = element.getAttribute("data-testid");
    if (
      testId &&
      testId.length <= 200 &&
      testId.trim() &&
      countMatches(`[data-testid="${escapeAttributeValue(testId)}"]`) === 1
    ) {
      return { kind: "test-id", value: testId };
    }
    const id = element.getAttribute("id");
    if (
      id &&
      id.length <= 200 &&
      id.trim() &&
      !looksGenerated(id) &&
      countMatches(`[id="${escapeAttributeValue(id)}"]`) === 1
    ) {
      return { kind: "id", value: id };
    }
    return undefined;
  };

  const cssPathFor = (element: Element): string => {
    const parts: string[] = [];
    let current: Element | null = element;
    while (current && parts.length < 24) {
      const tag = current.tagName.toLowerCase();
      if (current === document.documentElement) {
        parts.unshift(tag);
        break;
      }
      const id = current.getAttribute("id");
      if (
        id &&
        id.length <= 100 &&
        !looksGenerated(id) &&
        countMatches(`[id="${escapeAttributeValue(id)}"]`) === 1
      ) {
        parts.unshift(`${tag}#${escapeIdentifier(id)}`);
        break;
      }
      const parent: Element | null = current.parentElement;
      let segment = tag;
      if (parent) {
        let count = 0;
        let position = 0;
        const siblings = parent.children;
        for (let index = 0; index < Math.min(siblings.length, 1_000); index += 1) {
          const sibling = siblings[index]!;
          if (sibling.tagName === current.tagName) {
            count += 1;
            if (sibling === current) position = count;
          }
        }
        if (count > 1 && position > 0) segment += `:nth-of-type(${position})`;
      }
      parts.unshift(segment);
      current = parent;
    }
    return parts.join(" > ").slice(0, 4_000);
  };

  const ancestorDescriptor = (element: Element, budget: Budget): Ancestor => {
    const id = element.getAttribute("id");
    const testId = element.getAttribute("data-testid");
    return {
      tagName: element.tagName.toLowerCase().slice(0, 64),
      id: id && id.length <= 200 && !looksGenerated(id) ? id : null,
      role: implicitRole(element),
      testId: testId && testId.length <= 200 ? testId : null,
      name:
        attributeName(element, budget) ??
        (normalize(element.getAttribute("title"), NAME_CHARS) || null),
    };
  };
  const ancestorsFor = (element: Element, budget: Budget): Ancestor[] => {
    const ancestors: Ancestor[] = [];
    let current = element.parentElement;
    while (current && ancestors.length < MAX_ANCESTORS) {
      if (current === document.body || current === document.documentElement) break;
      ancestors.push(ancestorDescriptor(current, budget));
      current = current.parentElement;
    }
    return ancestors.reverse();
  };

  const scopeFor = (element: Element): Anchor["scope"] => {
    if (element.tagName === "IFRAME" || element.tagName === "FRAME") {
      return { kind: "unsupported", reason: "iframe" };
    }
    if ((element as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot) {
      return { kind: "unsupported", reason: "shadow-root" };
    }
    try {
      if (element.getRootNode() !== document) return { kind: "unsupported", reason: "shadow-root" };
    } catch {
      return { kind: "unsupported", reason: "closed-root" };
    }
    return { kind: "document" };
  };

  const elementQuote = (element: Element, budget: Budget): Quote & { complete: boolean } =>
    surrounding(
      { kind: "enter", node: element },
      { kind: "exit", node: element },
      element,
      ANCHOR_TEXT_CHARS,
      budget,
    );

  /** Each part gets its own small budget so one huge subtree cannot starve the rest. */
  const anchorFor = (element: Element): Anchor => {
    const quote = elementQuote(element, createBudget(3_000, 25));
    const stableId = stableIdFor(element);
    const hasText = Boolean(quote.exact || quote.prefix || quote.suffix);
    return {
      ...(stableId ? { stableId } : {}),
      semantic: {
        tagName: element.tagName.toLowerCase().slice(0, 64),
        role: implicitRole(element),
        name: accessibleName(element, createBudget(1_500, 15)),
      },
      text: hasText ? { exact: quote.exact, prefix: quote.prefix, suffix: quote.suffix } : null,
      ancestors: ancestorsFor(element, createBudget(1_000, 10)),
      cssPath: cssPathFor(element),
      scope: scopeFor(element),
    };
  };

  const shorten = (value: string, max: number): string =>
    value.length > max ? `${safeSlice(value, max - 1).trimEnd()}…` : value;
  const labelFor = (anchor: Anchor): string => {
    const kind = anchor.semantic.role ?? anchor.semantic.tagName;
    const name = anchor.semantic.name ?? (anchor.text?.exact || null);
    return shorten(name ? `${kind} “${shorten(name, LABEL_NAME_CHARS)}”` : kind, 200);
  };

  const sanitizeUrl = (value: string, counters: Counters | null): string | null => {
    const trimmed = value.trim().slice(0, 4_000);
    if (!trimmed || UNSAFE_URL.test(trimmed)) {
      if (counters) counters.attributesRemoved += 1;
      return null;
    }
    let url: URL;
    try {
      url = new URL(trimmed, document.baseURI);
    } catch {
      if (counters) counters.attributesRemoved += 1;
      return null;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      if (counters) counters.attributesRemoved += 1;
      return null;
    }
    let removed = 0;
    if (url.username || url.password) {
      url.username = "";
      url.password = "";
      removed += 1;
    }
    const kept = new URLSearchParams();
    for (const [name, parameter] of Array.from(url.searchParams.entries()).slice(0, 50)) {
      if (TOKEN_PARAMETER.test(name) || OPAQUE_VALUE.test(parameter)) {
        removed += 1;
        continue;
      }
      kept.append(name.slice(0, 100), parameter.slice(0, 200));
    }
    const search = kept.toString();
    url.search = search ? `?${search}` : "";
    if (url.hash.includes("=")) {
      url.hash = "";
      removed += 1;
    }
    if (counters) counters.urlParametersRemoved += removed;
    return url.toString().slice(0, ATTRIBUTE_VALUE_CHARS);
  };

  /** Whitelisted, bounded attributes. Never `value`, event handlers, or `srcdoc`. */
  const sanitizedAttributes = (
    element: Element,
    counters: Counters | null,
  ): Array<[string, string]> => {
    const kept: Array<[string, string]> = [];
    const attributes = element.attributes;
    const total = attributes.length;
    for (let index = 0; index < Math.min(total, 64); index += 1) {
      const attribute = attributes[index]!;
      const name = attribute.name.toLowerCase();
      const raw = attribute.value;
      if (name === "value") {
        if (counters) counters.valuesMasked += 1;
        continue;
      }
      const allowed =
        name === "id" ||
        name === "class" ||
        name === "role" ||
        name === "data-testid" ||
        name === "name" ||
        name === "type" ||
        name === "href" ||
        name === "src" ||
        name === "alt" ||
        name === "title" ||
        name === "placeholder" ||
        name === "for" ||
        (name.startsWith("aria-") && name.length <= 40 && /^[a-z-]+$/.test(name));
      if (!allowed || kept.length >= MAX_EVIDENCE_ATTRIBUTES) {
        if (counters) counters.attributesRemoved += 1;
        continue;
      }
      if (name === "href" || name === "src") {
        const url = sanitizeUrl(raw, counters);
        if (url !== null) kept.push([name, url]);
        continue;
      }
      if (name === "class") {
        kept.push([name, normalize(raw, 200)]);
        continue;
      }
      if (name === "placeholder" && isSensitiveElement(element)) {
        kept.push([name, normalize(raw, 80)]);
        continue;
      }
      kept.push([name, raw.slice(0, ATTRIBUTE_VALUE_CHARS)]);
    }
    if (counters && total > 64) counters.attributesRemoved += total - 64;
    return kept;
  };

  const sanitizedHtml = (root: Element, counters: Counters, budget: Budget): string => {
    const output: string[] = [];
    let length = 0;
    let nodes = 0;
    let truncated = false;
    const push = (value: string) => {
      if (length + value.length > HTML_CHARS) {
        truncated = true;
        return false;
      }
      output.push(value);
      length += value.length;
      return true;
    };
    const emit = (node: Node, depth: number): void => {
      if (truncated) return;
      if (!spend(budget) || nodes >= HTML_NODES) {
        truncated = true;
        return;
      }
      nodes += 1;
      if (node.nodeType === 3) {
        const text = (node.nodeValue ?? "").slice(0, 800).replace(/\s+/g, " ");
        if (text.trim() || text === " ") push(escapeHtml(text.slice(0, 200)));
        return;
      }
      if (!isElement(node) || node.hasAttribute(UI_ATTRIBUTE)) return;
      const tag = node.tagName.toLowerCase();
      if (HTML_DROP_TAGS.has(tag) || !KNOWN_TAG.test(tag) || tag.length > 40) return;
      if (tag === "iframe" && node.hasAttribute("srcdoc")) counters.attributesRemoved += 1;
      const attributes = sanitizedAttributes(node, node === root ? null : counters)
        .map(([name, value]) => ` ${name}="${escapeHtml(value)}"`)
        .join("");
      if (!push(`<${tag}${attributes}>`)) return;
      if (VOID_TAGS.has(tag) || tag === "iframe") {
        if (tag === "iframe") push("</iframe>");
        return;
      }
      if (isSensitiveElement(node)) {
        if (node.firstChild) counters.valuesMasked += 1;
        push("[masked]");
      } else if (tag === "textarea") {
        if (node.firstChild) counters.valuesMasked += 1;
      } else if (depth >= HTML_DEPTH) {
        if (node.firstChild) push("…");
      } else {
        const children = node.childNodes;
        const count = Math.min(children.length, 40);
        for (let index = 0; index < count && !truncated; index += 1) {
          emit(children[index]!, depth + 1);
        }
        if (children.length > count) push("…");
      }
      push(`</${tag}>`);
    };
    emit(root, 0);
    if (truncated) {
      const suffix = "<!-- truncated -->";
      if (length + suffix.length <= HTML_CHARS) output.push(suffix);
    }
    return output.join("").slice(0, HTML_CHARS);
  };

  const computedStyles = (element: Element): Record<string, string> => {
    const styles: Record<string, string> = {};
    try {
      const computed = getComputedStyle(element);
      for (const property of STYLE_PROPERTIES) {
        const value = computed.getPropertyValue(property);
        if (typeof value === "string" && value) styles[property] = value.slice(0, 200);
      }
    } catch {
      // Styles are optional evidence.
    }
    return styles;
  };

  const newCounters = (): Counters => ({
    attributesRemoved: 0,
    valuesMasked: 0,
    urlParametersRemoved: 0,
  });

  /** Everything a selected element contributes to a capture, bounded. */
  const describeElement = (element: Element) => {
    const counters = newCounters();
    const anchor = anchorFor(element);
    const attributes: Record<string, string> = {};
    for (const [name, value] of sanitizedAttributes(element, counters)) attributes[name] = value;
    if (isSensitiveElement(element) || element.tagName === "TEXTAREA") counters.valuesMasked += 1;
    const evidence = {
      text: isSensitiveElement(element)
        ? ""
        : visibleText(element, EVIDENCE_TEXT_CHARS, createBudget(3_000, 20)),
      attributes,
      styles: computedStyles(element),
      hierarchy: anchor.ancestors,
      html: sanitizedHtml(element, counters, createBudget(3_000, 25)),
    };
    return {
      target: { kind: "element", label: labelFor(anchor), anchor, rect: rectOf(element) },
      evidence,
      redaction: counters,
    };
  };

  const markerFor = (container: Node, offset: number): Marker => {
    if (container.nodeType === 3) return { kind: "text", node: container, offset };
    const child = container.childNodes[offset];
    return child ? { kind: "enter", node: child } : { kind: "exit", node: container };
  };

  /** A text selection's quote, containing anchor, and geometry; null when unsupported. */
  const describeRange = (
    range: Range,
  ):
    | { error: "unsupported" | "sensitive" | "empty" }
    | {
        target: Record<string, unknown>;
        evidence: Record<string, unknown>;
        redaction: Counters;
      } => {
    const common = range.commonAncestorContainer;
    const container = isElement(common) ? common : common.parentElement;
    if (!container) return { error: "unsupported" };
    try {
      if (container.getRootNode() !== document) return { error: "unsupported" };
    } catch {
      return { error: "unsupported" };
    }
    if (isInspectorNode(container)) return { error: "unsupported" };
    if (insideSensitive(range.startContainer) || insideSensitive(range.endContainer)) {
      return { error: "sensitive" };
    }
    try {
      if (container.querySelector(SENSITIVE_SELECTOR) && range.intersectsNode) {
        const sensitive = container.querySelectorAll(SENSITIVE_SELECTOR);
        for (let index = 0; index < Math.min(sensitive.length, 64); index += 1) {
          if (range.intersectsNode(sensitive[index]!)) return { error: "sensitive" };
        }
      }
    } catch {
      return { error: "unsupported" };
    }
    const quote = surrounding(
      markerFor(range.startContainer, range.startOffset),
      markerFor(range.endContainer, range.endOffset),
      container,
      QUOTE_CHARS,
      createBudget(8_000, 40),
    );
    if (!quote.exact) return { error: "empty" };
    const containerAnchor = anchorFor(container);
    const rects: Rect[] = [];
    try {
      const clientRects = range.getClientRects();
      for (let index = 0; index < Math.min(clientRects.length, 64); index += 1) {
        const rect = clientRects[index]!;
        if (rect.width > 0 || rect.height > 0) {
          rects.push(
            roundRect({ x: rect.left, y: rect.top, width: rect.width, height: rect.height }),
          );
        }
      }
    } catch {
      // Geometry is supporting context only.
    }
    const counters = newCounters();
    return {
      target: {
        kind: "text-range",
        label: shorten(`“${shorten(quote.exact, 60)}”`, 200),
        quote: { exact: quote.exact, prefix: quote.prefix, suffix: quote.suffix },
        container: containerAnchor,
        rect: rectOf(range),
        rects,
      },
      evidence: {
        text: quote.exact.slice(0, EVIDENCE_TEXT_CHARS),
        attributes: {},
        styles: computedStyles(container),
        hierarchy: containerAnchor.ancestors,
        html: sanitizedHtml(container, counters, createBudget(3_000, 25)),
      },
      redaction: counters,
    };
  };

  /** Viewport rectangles of detectable sensitive fields, for opaque masks. */
  const sensitiveRects = (): Rect[] => {
    const rects: Rect[] = [];
    let candidates: NodeListOf<Element>;
    try {
      candidates = document.querySelectorAll(SENSITIVE_SELECTOR);
    } catch {
      return rects;
    }
    const width = window.innerWidth;
    const height = window.innerHeight;
    for (let index = 0; index < Math.min(candidates.length, 128); index += 1) {
      const element = candidates[index]!;
      if (
        isInspectorNode(element) ||
        (element.tagName === "INPUT" && inputType(element) === "hidden")
      ) {
        continue;
      }
      const rect = rectOf(element);
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (
        rect.x + rect.width <= 0 ||
        rect.y + rect.height <= 0 ||
        rect.x >= width ||
        rect.y >= height
      ) {
        continue;
      }
      rects.push(rect);
      if (rects.length >= MAX_SENSITIVE_RECTS) break;
    }
    return rects;
  };

  // -------------------------------------------------------------------------
  // Resolver: ordered, deterministic rules. Geometry never establishes identity.

  type Verdict = boolean | null;
  const contextVerdict = (candidate: Element, anchor: Anchor, budget: Budget): Verdict => {
    const stored = anchor.text;
    const prefix = normalize(stored?.prefix, CONTEXT_CHARS).slice(-24).toLowerCase();
    const suffix = normalize(stored?.suffix, CONTEXT_CHARS).slice(0, 24).toLowerCase();
    if (!prefix && !suffix) return null;
    const current = elementQuote(candidate, budget);
    const before = current.prefix.toLowerCase();
    const after = current.suffix.toLowerCase();
    const prefixOk = Boolean(prefix) && before.includes(prefix);
    const suffixOk = Boolean(suffix) && after.includes(suffix);
    // An inserted sibling changes one side; both sides changing contradicts identity.
    return prefixOk || suffixOk;
  };
  const ancestorVerdict = (candidate: Element, anchor: Anchor, budget: Budget): Verdict => {
    const identifying = anchor.ancestors.filter(
      (ancestor) => ancestor.id || ancestor.testId || ancestor.name,
    );
    if (identifying.length === 0) return null;
    const current = ancestorsFor(candidate, budget);
    return identifying.every((expected) =>
      current.some(
        (actual) =>
          actual.tagName === expected.tagName &&
          (!expected.id || actual.id === expected.id) &&
          (!expected.testId || actual.testId === expected.testId) &&
          (!expected.name || sameText(actual.name, expected.name)),
      ),
    );
  };
  const corroboration = (
    candidate: Element,
    anchor: Anchor,
    budget: Budget,
  ): "corroborated" | "neutral" | "contradicted" => {
    const verdicts = [
      ancestorVerdict(candidate, anchor, budget),
      contextVerdict(candidate, anchor, budget),
    ];
    if (verdicts.includes(false)) return "contradicted";
    return verdicts.includes(true) ? "corroborated" : "neutral";
  };
  const identityMatches = (candidate: Element, anchor: Anchor, budget: Budget): boolean => {
    if (candidate.tagName.toLowerCase() !== anchor.semantic.tagName) return false;
    if ((implicitRole(candidate) ?? null) !== anchor.semantic.role) return false;
    if (anchor.semantic.name !== null) {
      return similarText(accessibleName(candidate, budget), anchor.semantic.name);
    }
    if (anchor.text?.exact)
      return similarText(visibleText(candidate, ANCHOR_TEXT_CHARS, budget), anchor.text.exact);
    return true;
  };

  const result = (
    state: Resolution["state"],
    rule: Resolution["rule"],
    candidateCount: number,
    element: Element | null = null,
    range: Range | null = null,
  ): Resolution => ({
    state,
    rule,
    candidateCount,
    rect: element ? rectOf(element) : range ? rectOf(range) : null,
    element,
    range,
  });
  /** Budget or deadline exhausted: distinct from an unsupported scope. */
  const tooComplex = (): Resolution => result("too-complex", "none", 0);

  const resolveElement = (anchor: Anchor, budget: Budget): Resolution => {
    if (anchor.scope.kind !== "document") return result("unsupported", "none", 0);
    let ambiguousCount = 0;
    let staleCandidate = false;
    // One semantic candidate with no corroborating evidence either way: it
    // may be the target, but nothing proves it. Rule 4 may still confirm it.
    let unverifiedCandidate = false;

    // Rule 2: unique stable id with compatible identity.
    if (anchor.stableId) {
      const selector =
        anchor.stableId.kind === "test-id"
          ? `[data-testid="${escapeAttributeValue(anchor.stableId.value)}"]`
          : `[id="${escapeAttributeValue(anchor.stableId.value)}"]`;
      let matches: Element[] = [];
      try {
        matches = Array.from(document.querySelectorAll(selector))
          .slice(0, 20)
          .filter((element) => !isInspectorNode(element));
      } catch {
        matches = [];
      }
      if (matches.length === 1) {
        const candidate = matches[0]!;
        if (identityMatches(candidate, anchor, budget))
          return result("matched", "stable-id", 1, candidate);
        if (budget.exhausted) return tooComplex();
        return result("stale", "stable-id", 1);
      }
      if (matches.length > 1) ambiguousCount = matches.length;
    }

    // Rule 3: scoped semantic identity corroborated by ancestors or surrounding text.
    if (anchor.semantic.name) {
      const all = document.getElementsByTagName(anchor.semantic.tagName);
      if (all.length > 5_000) return tooComplex();
      const candidates: Element[] = [];
      for (let index = 0; index < all.length; index += 1) {
        if (!spend(budget)) return tooComplex();
        const element = all[index]!;
        if (isInspectorNode(element)) continue;
        if ((implicitRole(element) ?? null) !== anchor.semantic.role) continue;
        if (!sameText(accessibleName(element, budget), anchor.semantic.name)) continue;
        candidates.push(element);
        if (candidates.length > 50) break;
      }
      if (budget.exhausted) return tooComplex();
      if (candidates.length > 0) {
        const verdicts = candidates.map((candidate) => corroboration(candidate, anchor, budget));
        if (budget.exhausted) return tooComplex();
        const corroborated = candidates.filter(
          (_candidate, index) => verdicts[index] === "corroborated",
        );
        if (corroborated.length === 1) {
          return result("matched", "semantic-context", candidates.length, corroborated[0]!);
        }
        if (corroborated.length > 1)
          return result("ambiguous", "semantic-context", corroborated.length);
        if (candidates.length === 1 && verdicts[0] === "neutral") unverifiedCandidate = true;
        else if (candidates.length > 1) {
          ambiguousCount = Math.max(ambiguousCount, candidates.length);
        } else staleCandidate = true;
      }
    }

    // Rule 4: the structural path, only with supporting identity and context.
    if (anchor.cssPath) {
      let matches: Element[] = [];
      try {
        matches = Array.from(document.querySelectorAll(anchor.cssPath))
          .slice(0, 20)
          .filter((element) => !isInspectorNode(element));
      } catch {
        matches = [];
      }
      if (matches.length === 1) {
        const candidate = matches[0]!;
        const hasSupport = Boolean(anchor.semantic.name || anchor.text?.exact);
        if (
          hasSupport &&
          identityMatches(candidate, anchor, budget) &&
          corroboration(candidate, anchor, budget) !== "contradicted"
        ) {
          return result("matched", "structural-path", 1, candidate);
        }
        if (budget.exhausted) return tooComplex();
        if (candidate.tagName.toLowerCase() === anchor.semantic.tagName) staleCandidate = true;
      }
    }
    if (budget.exhausted) return tooComplex();
    if (ambiguousCount > 1) return result("ambiguous", "none", ambiguousCount);
    // Only exactly one corroborated candidate may match (plan step 10, rule 3).
    if (unverifiedCandidate) return result("ambiguous", "semantic-context", 1);
    if (staleCandidate) return result("stale", "none", 1);
    return result("missing", "none", 0);
  };

  type TextMap = { text: string; nodes: Node[]; offsets: number[] };
  let cachedTextMap: TextMap | null | undefined;
  /** Whitespace-normalized document text with a map back to text nodes, bounded. */
  const documentTextMap = (budget: Budget): TextMap | null => {
    if (cachedTextMap !== undefined) return cachedTextMap;
    const limit = 400_000;
    const characters: string[] = [];
    const nodes: Node[] = [];
    const offsets: number[] = [];
    let last: { node: Node; offset: number } | null = null;
    let previousSpace = true;
    const appendSpace = () => {
      if (previousSpace || !last) return;
      characters.push(" ");
      nodes.push(last.node);
      offsets.push(last.offset);
      previousSpace = true;
    };
    const root = document.body ?? document.documentElement;
    const stack: Array<{ node: Node; exit: boolean }> = [{ node: root, exit: false }];
    while (stack.length > 0) {
      if (!spend(budget) || characters.length > limit) {
        cachedTextMap = null;
        return null;
      }
      const { node, exit } = stack.pop()!;
      if (exit) {
        if (BLOCK_TAGS.has((node as Element).tagName)) appendSpace();
        continue;
      }
      if (node.nodeType === 3) {
        const value = node.nodeValue ?? "";
        for (let index = 0; index < value.length; index += 1) {
          const character = value[index]!;
          if (/\s/.test(character)) {
            last = { node, offset: index };
            appendSpace();
            continue;
          }
          characters.push(character);
          nodes.push(node);
          offsets.push(index);
          last = { node, offset: index };
          previousSpace = false;
        }
        continue;
      }
      if (!isElement(node)) continue;
      if (node !== root && skipsText(node)) continue;
      if (BLOCK_TAGS.has(node.tagName)) appendSpace();
      stack.push({ node, exit: true });
      const children = node.childNodes;
      for (let index = Math.min(children.length, MAX_CHILDREN * 5) - 1; index >= 0; index -= 1) {
        stack.push({ node: children[index]!, exit: false });
      }
    }
    cachedTextMap = { text: characters.join(""), nodes, offsets };
    return cachedTextMap;
  };

  const resolveText = (quote: Quote, container: Anchor, budget: Budget): Resolution => {
    if (container.scope.kind !== "document") return result("unsupported", "none", 0);
    const exact = normalize(quote.exact, QUOTE_CHARS);
    if (!exact) return result("missing", "none", 0);
    const map = documentTextMap(budget);
    if (!map) return tooComplex();
    const occurrences: number[] = [];
    for (let from = 0; occurrences.length <= 20;) {
      const found = map.text.indexOf(exact, from);
      if (found < 0) break;
      occurrences.push(found);
      from = found + 1;
    }
    if (occurrences.length === 0) return result("missing", "none", 0);
    const prefix = normalize(quote.prefix, CONTEXT_CHARS).slice(-24);
    const suffix = normalize(quote.suffix, CONTEXT_CHARS).slice(0, 24);
    // Document-wide text: compare only the characters adjacent to each occurrence.
    const verdictAt = (index: number): Verdict => {
      if (!prefix && !suffix) return null;
      const before = map.text.slice(Math.max(0, index - prefix.length - 16), index);
      const after = map.text.slice(index + exact.length, index + exact.length + suffix.length + 16);
      return (
        (Boolean(prefix) && before.includes(prefix)) || (Boolean(suffix) && after.includes(suffix))
      );
    };
    const verdicts = occurrences.map(verdictAt);
    const corroborated = occurrences.filter((_index, position) => verdicts[position] === true);
    const rangeAt = (index: number): Range | null => {
      try {
        const range = document.createRange();
        const end = index + exact.length - 1;
        range.setStart(map.nodes[index]!, map.offsets[index]!);
        range.setEnd(map.nodes[end]!, map.offsets[end]! + 1);
        return range;
      } catch {
        return null;
      }
    };
    let chosen: number | null = null;
    if (corroborated.length === 1) chosen = corroborated[0]!;
    else if (corroborated.length > 1) return result("ambiguous", "text-quote", corroborated.length);
    else if (occurrences.length === 1 && verdicts[0] === null) chosen = occurrences[0]!;
    else if (occurrences.length > 1) return result("ambiguous", "text-quote", occurrences.length);
    else return result("stale", "text-quote", 1);
    const range = rangeAt(chosen);
    if (!range) return result("missing", "none", 0);
    return result("matched", "text-quote", occurrences.length, null, range);
  };

  const resolveTarget = (target: Record<string, unknown>, budget: Budget): Resolution => {
    try {
      if (target.kind === "element" && target.anchor) {
        return resolveElement(target.anchor as Anchor, budget);
      }
      if (target.kind === "text-range" && target.quote && target.container) {
        return resolveText(target.quote as Quote, target.container as Anchor, budget);
      }
    } catch {
      return tooComplex();
    }
    return result("unsupported", "none", 0);
  };

  /** Cheap summary for the hover tooltip: role or tag plus a bounded name. */
  const hoverLabel = (element: Element): string =>
    labelFor({
      semantic: {
        tagName: element.tagName.toLowerCase().slice(0, 64),
        role: implicitRole(element),
        name: accessibleName(element, createBudget(400, 4)),
      },
      text: null,
      ancestors: [],
      cssPath: "",
      scope: { kind: "document" },
    });

  return {
    UI_ATTRIBUTE,
    createBudget,
    hoverLabel,
    rectOf,
    isInspectorNode,
    isSensitiveElement,
    insideSensitive,
    anchorFor,
    labelFor,
    describeElement,
    describeRange,
    sensitiveRects,
    sanitizeUrl,
    sanitizedHtml,
    visibleText,
    resolveTarget,
    resetResolverCache: () => {
      cachedTextMap = undefined;
    },
  };
}

export type BrowserPreviewAnchorKit = ReturnType<typeof browserPreviewAnchorKit>;
