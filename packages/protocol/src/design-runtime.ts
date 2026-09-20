import type { DesignElement, DesignLayer, DesignOperation } from "./design-canvas.js";

/** Self-contained: serialized into an opaque sandbox and the backend renderer. */
export function installDesignRuntime() {
  const forbidden = "script,iframe,object,embed,base,meta,link,portal,applet";
  function clean(doc: Document | DocumentFragment) {
    doc.querySelectorAll(forbidden).forEach((node) => node.remove());
    for (const node of Array.from(doc.querySelectorAll("*"))) {
      for (const attr of Array.from(node.attributes)) {
        if (
          /^on/i.test(attr.name) ||
          ["srcdoc", "nonce", "http-equiv", "action", "formaction"].includes(attr.name)
        ) {
          node.removeAttribute(attr.name);
        }
      }
    }
  }
  function parse(html: string) {
    if (new TextEncoder().encode(html).length > 256 * 1024) throw new Error("HTML exceeds 256 KiB");
    const doc = new DOMParser().parseFromString(html, "text/html");
    clean(doc);
    if (doc.querySelectorAll("*").length > 5000) throw new Error("Frame exceeds 5000 elements");
    return doc;
  }
  function selector(el: Element): string {
    if (el === document.documentElement) return "html";
    if (el === document.body) return "body";
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
    const nodes = document.querySelectorAll(value);
    if (
      nodes.length !== 1 ||
      !(nodes[0] instanceof HTMLElement || nodes[0] instanceof SVGElement)
    ) {
      throw new Error("Selector must match exactly one element");
    }
    return nodes[0];
  }
  function inspect(el: Element): DesignElement {
    const rect = el.getBoundingClientRect();
    const computed = getComputedStyle(el);
    const styles: Record<string, string> = {};
    for (const name of [
      "display",
      "position",
      "width",
      "height",
      "color",
      "background-color",
      "font-size",
      "font-family",
      "font-weight",
      "padding",
      "margin",
      "gap",
      "border-radius",
      "border",
      "opacity",
      "flex-direction",
      "align-items",
      "justify-content",
      "top",
      "left",
    ]) {
      styles[name] = computed.getPropertyValue(name);
    }
    return {
      selector: selector(el),
      tag: el.tagName.toLowerCase(),
      text: (el.textContent ?? "").slice(0, 200),
      attributes: Object.fromEntries(
        Array.from(el.attributes)
          .slice(0, 64)
          .map((a) => [a.name, a.value.slice(0, 1024)]),
      ),
      styles,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  }
  function serialize() {
    if (document.querySelectorAll("*").length > 5000)
      throw new Error("Frame exceeds 5000 elements");
    const html = "<!doctype html>\n" + document.documentElement.outerHTML;
    if (new TextEncoder().encode(html).length > 256 * 1024) throw new Error("HTML exceeds 256 KiB");
    return html;
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
      case "hitTest": {
        const el = document.elementFromPoint(input.x, input.y);
        return el ? inspect(el) : null;
      }
      case "inspectElement":
        return inspect(find(input.selector));
      case "setStyles": {
        const el = find(input.selector);
        if (Object.keys(input.styles).length > 64) throw new Error("Too many styles");
        for (const [key, value] of Object.entries(input.styles)) {
          if (
            !/^(--[a-zA-Z0-9_-]+|[a-z-]+)$/.test(key) ||
            key.length > 100 ||
            (value !== null && (typeof value !== "string" || value.length > 2048))
          )
            throw new Error("Invalid style");
          if (value === null || value === "") el.style.removeProperty(key);
          else el.style.setProperty(key, value);
        }
        return serialize();
      }
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
        if (
          !document.body.contains(el) ||
          el === document.body ||
          !document.body.contains(parent) ||
          el.contains(parent) ||
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
            label: (el.id || el.getAttribute("aria-label") || el.tagName.toLowerCase()).slice(
              0,
              100,
            ),
            depth,
          });
          for (const child of Array.from(el.children)) walk(child, depth + 1);
        };
        walk(document.body, 0);
        return result;
      }
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
  document.addEventListener("click", (event) => event.preventDefault(), true);
  document.addEventListener("submit", (event) => event.preventDefault(), true);
}

/** Only our nonce-bearing bootstrap executes. Authored code has no nonce. */
export function designBootstrap(nonce: string): string {
  if (!/^[a-zA-Z0-9-]{16,80}$/.test(nonce)) throw new Error("Invalid runtime nonce");
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"></head><body><script nonce="${nonce}">(${installDesignRuntime.toString()})();</script></body></html>`;
}
