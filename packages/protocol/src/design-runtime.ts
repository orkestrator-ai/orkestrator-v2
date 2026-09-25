import type {
  DesignElement,
  DesignHierarchyPage,
  DesignLayer,
  DesignOperation,
  DesignStyleResult,
  DesignValidationReport,
} from "./design-canvas.js";

/**
 * Self-contained: serialized into an opaque sandbox and the backend renderer.
 * One sanitizer and one DOM budget serve both, so a frame the backend accepts
 * renders the same way in every client.
 */
export function installDesignRuntime() {
  const MAX_HTML_BYTES = 256 * 1024;
  const MAX_ELEMENTS = 5000;
  const forbidden = "script,iframe,frame,object,embed,base,meta,link,portal,applet";
  const externalUrl = /^\s*(?:https?:)?\/\//i;
  const cssExternal = /url\(\s*['"]?\s*(?:https?:)?\/\//gi;
  const cssImport = /@import\s/gi;
  let mode: "inspect" | "preview" = "inspect";
  interface Counts {
    scripts: number;
    handlers: number;
    externalReferences: number;
    forbiddenElements: number;
    executableUrls: number;
  }
  const emptyCounts = (): Counts => ({
    scripts: 0,
    handlers: 0,
    externalReferences: 0,
    forbiddenElements: 0,
    executableUrls: 0,
  });
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
  function depthOf(root: Element | null): number {
    if (!root) return 0;
    let deepest = 0;
    const stack: Array<[Element, number]> = [[root, 1]];
    while (stack.length) {
      const [el, depth] = stack.pop()!;
      if (depth > deepest) deepest = depth;
      for (const child of Array.from(el.children)) stack.push([child, depth + 1]);
    }
    return deepest;
  }
  function byteLength(value: string) {
    return new TextEncoder().encode(value).length;
  }
  function parse(html: string, counts: Counts = emptyCounts()) {
    if (typeof html !== "string") throw new Error("Invalid HTML");
    if (byteLength(html) > MAX_HTML_BYTES) throw new Error("HTML exceeds 256 KiB");
    const doc = new DOMParser().parseFromString(html, "text/html");
    clean(doc, counts);
    if (elementCount(doc) > MAX_ELEMENTS) throw new Error("Frame exceeds 5000 elements");
    return doc;
  }
  function selector(el: Element): string {
    if (el === document.documentElement) return "html";
    if (el === document.body) return "body";
    if (el === document.head) return "head";
    const path: string[] = [];
    let current: Element | null = el;
    while (current && current !== document.body && current !== document.documentElement) {
      const parent: Element | null = current.parentElement;
      if (!parent) break;
      path.unshift(`:nth-child(${Array.from(parent.children).indexOf(current) + 1})`);
      current = parent;
    }
    return `${current === document.body ? "body" : "html"} > ${path.join(" > ")}`;
  }
  function find(value: string) {
    if (typeof value !== "string" || value.length > 2048) throw new Error("Invalid selector");
    let nodes: NodeListOf<Element>;
    try {
      nodes = document.querySelectorAll(value);
    } catch {
      throw new Error("Invalid selector");
    }
    if (
      nodes.length !== 1 ||
      !(nodes[0] instanceof HTMLElement || nodes[0] instanceof SVGElement)
    ) {
      throw new Error("Selector must match exactly one element");
    }
    return nodes[0] as HTMLElement | SVGElement;
  }
  const inspected = [
    "display",
    "position",
    "width",
    "height",
    "min-width",
    "min-height",
    "max-width",
    "max-height",
    "box-sizing",
    "color",
    "background-color",
    "font-size",
    "font-family",
    "font-weight",
    "line-height",
    "letter-spacing",
    "text-align",
    "padding",
    "margin",
    "gap",
    "border-radius",
    "border",
    "border-color",
    "border-width",
    "border-style",
    "opacity",
    "visibility",
    "flex-direction",
    "flex-wrap",
    "align-items",
    "justify-content",
    "top",
    "left",
    "bottom",
    "right",
  ];
  function inspect(el: Element): DesignElement {
    const rect = el.getBoundingClientRect();
    const computed = getComputedStyle(el);
    const styles: Record<string, string> = {};
    for (const name of inspected) styles[name] = computed.getPropertyValue(name);
    const inline: Record<string, string> = {};
    const inlinePriority: Record<string, "important"> = {};
    const style = (el as HTMLElement).style;
    if (style) {
      for (let index = 0; index < style.length && index < 128; index++) {
        const name = style.item(index);
        inline[name] = style.getPropertyValue(name).slice(0, 2048);
        if (style.getPropertyPriority(name) === "important") inlinePriority[name] = "important";
        if (!(name in styles) && Object.keys(styles).length < 160)
          styles[name] = computed.getPropertyValue(name);
      }
    }
    const allAttributes = Array.from(el.attributes);
    const text = el.textContent ?? "";
    const path = selector(el);
    return {
      selector: path,
      key: path,
      tag: el.tagName.toLowerCase(),
      text: text.slice(0, 200),
      textTruncated: text.length > 200,
      attributes: Object.fromEntries(
        allAttributes.slice(0, 64).map((a) => [a.name, a.value.slice(0, 1024)]),
      ),
      attributesTruncated: allAttributes.length > 64,
      styles,
      inline,
      inlinePriority,
      svg: el instanceof SVGElement,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      scroll: { x: window.scrollX, y: window.scrollY },
    };
  }
  function serialize() {
    if (elementCount(document) > MAX_ELEMENTS) throw new Error("Frame exceeds 5000 elements");
    const html = "<!doctype html>\n" + document.documentElement.outerHTML;
    if (byteLength(html) > MAX_HTML_BYTES) throw new Error("HTML exceeds 256 KiB");
    return html;
  }
  function splitPriority(value: string): { value: string; priority: "" | "important" } {
    const match = /^(.*?)\s*!\s*important\s*$/i.exec(value);
    return match ? { value: match[1]!, priority: "important" } : { value, priority: "" };
  }
  /** Validates the complete set first; applies nothing if any value is rejected. */
  function applyStyles(
    target: HTMLElement | SVGElement,
    styles: Record<string, string | null>,
    commit: boolean,
  ): DesignStyleResult {
    const entries = Object.entries(styles ?? {});
    if (entries.length > 64) throw new Error("Too many styles");
    const invalid: string[] = [];
    const unchanged: string[] = [];
    const probe = document.createElement("div");
    const planned: Array<[string, string | null, "" | "important"]> = [];
    for (const [rawKey, rawValue] of entries) {
      const key = rawKey.trim();
      if (
        !/^(--[a-zA-Z0-9_-]+|[a-z-]+)$/.test(key) ||
        key.length > 100 ||
        (rawValue !== null && (typeof rawValue !== "string" || rawValue.length > 2048))
      ) {
        invalid.push(rawKey.slice(0, 100));
        continue;
      }
      const current = target.style.getPropertyValue(key);
      const currentPriority = target.style.getPropertyPriority(key);
      if (rawValue === null || rawValue.trim() === "") {
        if (!current) unchanged.push(key);
        planned.push([key, null, ""]);
        continue;
      }
      const { value, priority } = splitPriority(rawValue.trim());
      probe.style.cssText = "";
      probe.style.setProperty(key, value, priority);
      const accepted = probe.style.getPropertyValue(key);
      if (!accepted && !key.startsWith("--")) {
        invalid.push(key);
        continue;
      }
      if (accepted === current && priority === currentPriority) unchanged.push(key);
      planned.push([key, value, priority]);
    }
    if (invalid.length > 0) return { html: "", invalid, unchanged };
    if (!commit) {
      for (const [key, value, priority] of planned) {
        if (value === null) target.style.removeProperty(key);
        else target.style.setProperty(key, value, priority);
      }
      return { html: "", invalid, unchanged };
    }
    if (unchanged.length === planned.length) return { html: "", invalid, unchanged };
    for (const [key, value, priority] of planned) {
      if (value === null) target.style.removeProperty(key);
      else target.style.setProperty(key, value, priority);
    }
    if (target.getAttribute("style") === "") target.removeAttribute("style");
    return { html: serialize(), invalid, unchanged };
  }
  function structureFingerprint(root: Element): string {
    let hash = 2166136261;
    let count = 0;
    const walk = (el: Element) => {
      count++;
      const tag = el.tagName;
      for (let i = 0; i < tag.length; i++) {
        hash ^= tag.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      hash ^= el.children.length;
      hash = Math.imul(hash, 16777619);
      for (const child of Array.from(el.children)) walk(child);
    };
    walk(root);
    return `${(hash >>> 0).toString(36)}.${count}`;
  }
  function label(el: Element): string {
    return (el.id || el.getAttribute("aria-label") || el.tagName.toLowerCase()).slice(0, 100);
  }
  function hierarchyPage(input: {
    rootSelector?: string;
    cursor?: string;
    maxNodes?: number;
    maxBytes?: number;
    maxDepth?: number;
  }): DesignHierarchyPage {
    const root = input.rootSelector ? find(input.rootSelector) : document.body;
    const maxNodes = Math.max(1, Math.min(200, Math.floor(input.maxNodes ?? 200)));
    const maxBytes = Math.max(1024, Math.min(128 * 1024, Math.floor(input.maxBytes ?? 128 * 1024)));
    const maxDepth = Math.max(1, Math.min(32, Math.floor(input.maxDepth ?? 1)));
    const fingerprint = structureFingerprint(document.body);
    let offset = 0;
    if (input.cursor) {
      const [expected, value] = String(input.cursor).split(":");
      if (expected !== fingerprint) throw new Error("Hierarchy changed; reload this branch");
      offset = Math.max(0, Number.parseInt(value ?? "0", 10) || 0);
    }
    const flat: Array<[Element, number]> = [];
    const walk = (el: Element, depth: number) => {
      for (const child of Array.from(el.children)) {
        if (child.tagName === "HEAD") continue;
        flat.push([child, depth]);
        if (depth < maxDepth) walk(child, depth + 1);
      }
    };
    walk(root, 1);
    const layers: DesignLayer[] = [];
    let bytes = 0;
    let index = offset;
    for (; index < flat.length && layers.length < maxNodes; index++) {
      const [el, depth] = flat[index]!;
      const layer: DesignLayer = {
        selector: selector(el),
        tag: el.tagName.toLowerCase(),
        label: label(el),
        depth,
        childCount: el.children.length,
      };
      const size = layer.selector.length + layer.label.length + 48;
      if (bytes + size > maxBytes && layers.length > 0) break;
      bytes += size;
      layers.push(layer);
    }
    return {
      layers,
      total: flat.length,
      truncated: index < flat.length,
      bytes,
      ...(index < flat.length ? { nextCursor: `${fingerprint}:${index}` } : {}),
    };
  }
  function validate(html: string): DesignValidationReport {
    if (typeof html !== "string") throw new Error("Invalid HTML");
    if (byteLength(html) > MAX_HTML_BYTES) throw new Error("HTML exceeds 256 KiB");
    const counts = emptyCounts();
    const doc = new DOMParser().parseFromString(html, "text/html");
    clean(doc, counts);
    const total = elementCount(doc);
    return {
      elementCount: total,
      maxDepth: depthOf(doc.documentElement),
      removed: counts,
      overElementLimit: total > MAX_ELEMENTS,
    };
  }
  function run(input: DesignOperation): unknown {
    switch (input.op) {
      case "render": {
        const doc = parse(input.html);
        document.documentElement.replaceChildren(
          ...Array.from(doc.documentElement.childNodes).map((node) =>
            document.importNode(node, true),
          ),
        );
        for (const attr of Array.from(document.documentElement.attributes))
          document.documentElement.removeAttribute(attr.name);
        for (const attr of Array.from(doc.documentElement.attributes))
          document.documentElement.setAttribute(attr.name, attr.value);
        return true;
      }
      case "validate":
        return validate(input.html);
      case "hitTest": {
        const el = document.elementFromPoint(input.x, input.y);
        return el ? inspect(el) : null;
      }
      case "inspectElement":
        return inspect(find(input.selector));
      case "setStyles": {
        const result = applyStyles(find(input.selector), input.styles, true);
        if (result.invalid.length) throw new Error(`Invalid style: ${result.invalid.join(", ")}`);
        return result.html || serialize();
      }
      case "applyStyles":
        return applyStyles(find(input.selector), input.styles, true);
      case "previewStyles":
        return applyStyles(find(input.selector), input.styles, false);
      case "replaceElementHtml": {
        const el = find(input.selector);
        if (el === document.body || el === document.documentElement || !document.body.contains(el))
          throw new Error("Select an element inside the body");
        el.replaceWith(...Array.from(parse(input.html).body.childNodes));
        return serialize();
      }
      case "appendHtml": {
        const doc = parse(input.html);
        document.head.append(...Array.from(doc.head.childNodes));
        document.body.append(...Array.from(doc.body.childNodes));
        return serialize();
      }
      case "moveElement": {
        const el = find(input.selector),
          parent = find(input.parentSelector);
        const before = input.beforeSelector ? find(input.beforeSelector) : null;
        const unsafeParents = new Set([
          "AREA",
          "BASE",
          "BR",
          "COL",
          "EMBED",
          "HR",
          "IMG",
          "INPUT",
          "LINK",
          "META",
          "PARAM",
          "SOURCE",
          "TRACK",
          "WBR",
          "TEMPLATE",
          "SCRIPT",
          "STYLE",
          "TEXTAREA",
          "TITLE",
          "XMP",
          "NOSCRIPT",
          "IFRAME",
          "OBJECT",
          "SELECT",
          "OPTION",
          "OPTGROUP",
        ]);
        if (
          !document.body.contains(el) ||
          el === document.body ||
          !document.body.contains(parent) ||
          el.contains(parent) ||
          unsafeParents.has(parent.tagName) ||
          (before && before.parentElement !== parent)
        )
          throw new Error("Invalid element move");
        parent.insertBefore(el, before);
        return serialize();
      }
      case "serialize":
        return serialize();
      case "hierarchy": {
        const result: DesignLayer[] = [];
        const walk = (el: Element, depth: number) => {
          if (result.length >= 1000 || depth > 32) return;
          result.push({
            selector: selector(el),
            tag: el.tagName.toLowerCase(),
            label: label(el),
            depth,
          });
          for (const child of Array.from(el.children)) walk(child, depth + 1);
        };
        walk(document.body, 0);
        return result;
      }
      case "hierarchyPage":
        return hierarchyPage(input);
      case "setMode":
        mode = input.mode === "preview" ? "preview" : "inspect";
        document.documentElement.toggleAttribute("data-ork-preview", mode === "preview");
        if (mode === "inspect") window.scrollTo(0, 0);
        return mode;
      case "scrollOffset":
        return { x: window.scrollX, y: window.scrollY };
    }
  }
  (window as unknown as { orkDesign: typeof run }).orkDesign = run;
  window.addEventListener("message", (event: MessageEvent) => {
    if (
      event.source !== window.parent ||
      !event.data ||
      event.data.channel !== "orkestrator-design" ||
      typeof event.data.requestId !== "string"
    )
      return;
    const { requestId, operation } = event.data;
    try {
      window.parent.postMessage(
        { channel: "orkestrator-design", requestId, result: run(operation) },
        "*",
      );
    } catch (error) {
      window.parent.postMessage(
        {
          channel: "orkestrator-design",
          requestId,
          error: error instanceof Error ? error.message : "Runtime failed",
        },
        "*",
      );
    }
  });
  // Mockup links, buttons and forms never navigate or submit, in either mode.
  document.addEventListener("click", (event) => event.preventDefault(), true);
  document.addEventListener("auxclick", (event) => event.preventDefault(), true);
  document.addEventListener("submit", (event) => event.preventDefault(), true);
  document.addEventListener(
    "keydown",
    (event) => {
      // Escape always returns control to the editor, never to authored markup.
      if (event.key === "Escape")
        window.parent.postMessage({ channel: "orkestrator-design-escape" }, "*");
    },
    true,
  );
}

/** Only our nonce-bearing bootstrap executes. Authored code has no nonce. */
export function designBootstrap(nonce: string): string {
  if (!/^[a-zA-Z0-9-]{16,80}$/.test(nonce)) throw new Error("Invalid runtime nonce");
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"></head><body><script nonce="${nonce}">(${installDesignRuntime.toString()})();</script></body></html>`;
}
