/**
 * Installs the browser-preview inspector in the preview's page world.
 *
 * The runtime owns its overlays inside the preview because a WebContentsView is
 * composited above the React renderer. The host polls the small, bounded result
 * through executeJavaScript and captures the preview only after submission, so
 * the screenshot contains the selected-element highlight.
 */
function installBrowserPreviewAnnotationRuntime(): void {
  const runtimeKey = "__orkestratorBrowserAnnotationRuntime__";
  const rootAttribute = "data-orkestrator-annotation-ui";
  const runtimeWindow = window as unknown as Window & Record<string, unknown>;
  const previous = runtimeWindow[runtimeKey] as { destroy?: () => void } | undefined;
  previous?.destroy?.();

  const clampText = (value: string | null | undefined, length: number): string =>
    (value ?? "").replace(/\s+/g, " ").trim().slice(0, length);
  const escapeCss = (value: string): string => {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
    return value.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
  };
  const selectorFor = (element: Element): string => {
    const tag = element.tagName.toLowerCase();
    if (element.id) return `${tag}#${escapeCss(element.id)}`;
    const testId = element.getAttribute("data-testid");
    if (testId) return `${tag}[data-testid="${escapeCss(testId)}"]`;
    const parent = element.parentElement;
    if (!parent) return tag;
    const siblings = Array.from(parent.children).filter(
      (candidate) => candidate.tagName === element.tagName,
    );
    return siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(element) + 1})` : tag;
  };
  const cssPathFor = (element: Element): string => {
    const parts: string[] = [];
    let current: Element | null = element;
    while (current && parts.length < 32) {
      const selector = selectorFor(current);
      parts.unshift(selector);
      if (current.id || current === document.documentElement) break;
      current = current.parentElement;
    }
    return parts.join(" > ");
  };
  const xpathFor = (element: Element): string => {
    const parts: string[] = [];
    let current: Element | null = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 32) {
      const tag = current.tagName.toLowerCase();
      const parent: Element | null = current.parentElement;
      const sameTag = parent
        ? Array.from(parent.children).filter((candidate) => candidate.tagName === current!.tagName)
        : [];
      const index = sameTag.length > 1 ? `[${sameTag.indexOf(current) + 1}]` : "";
      parts.unshift(`${tag}${index}`);
      current = parent;
    }
    return `/${parts.join("/")}`;
  };
  const isInspectorNode = (target: EventTarget | null): boolean =>
    target instanceof Element && Boolean(target.closest(`[${rootAttribute}]`));

  const makeNode = <T extends keyof HTMLElementTagNameMap>(tag: T): HTMLElementTagNameMap[T] => {
    const node = document.createElement(tag);
    node.setAttribute(rootAttribute, "");
    return node;
  };

  const highlight = makeNode("div");
  Object.assign(highlight.style, {
    position: "fixed",
    zIndex: "2147483645",
    pointerEvents: "none",
    border: "2px solid #2684ff",
    background: "rgba(38, 132, 255, 0.10)",
    boxShadow: "0 0 0 1px rgba(255,255,255,0.75), 0 0 0 3px rgba(38,132,255,0.22)",
    borderRadius: "3px",
    display: "none",
    boxSizing: "border-box",
  });

  const tooltip = makeNode("div");
  Object.assign(tooltip.style, {
    position: "fixed",
    zIndex: "2147483646",
    pointerEvents: "none",
    minWidth: "230px",
    maxWidth: "360px",
    padding: "10px 12px",
    color: "#f8fbff",
    background: "rgba(9, 20, 43, 0.96)",
    border: "1px solid rgba(92, 154, 255, 0.45)",
    borderRadius: "9px",
    boxShadow: "0 14px 34px rgba(0,0,0,0.35)",
    font: "500 12px/1.45 ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    display: "none",
    boxSizing: "border-box",
  });

  const panel = makeNode("form");
  Object.assign(panel.style, {
    position: "fixed",
    zIndex: "2147483647",
    width: "min(360px, calc(100vw - 24px))",
    padding: "14px",
    color: "#f8fbff",
    background: "rgba(8, 17, 36, 0.98)",
    border: "1px solid rgba(92, 154, 255, 0.55)",
    borderRadius: "12px",
    boxShadow: "0 20px 48px rgba(0,0,0,0.45)",
    font: "500 13px/1.45 ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    display: "none",
    boxSizing: "border-box",
  });
  panel.innerHTML = [
    '<div data-title style="font-weight:650;font-size:13px;margin-bottom:8px"></div>',
    '<textarea data-comment rows="4" maxlength="2000" placeholder="What should the agent change or investigate?" style="display:block;width:100%;resize:vertical;min-height:84px;max-height:180px;box-sizing:border-box;border-radius:8px;border:1px solid rgba(148,163,184,.38);background:#0f1b31;color:#fff;padding:9px 10px;font:400 13px/1.45 ui-sans-serif,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;outline:none"></textarea>',
    '<div data-error style="min-height:18px;padding-top:4px;color:#fda4af;font-size:11px"></div>',
    '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:6px"><button data-cancel type="button" style="border:1px solid rgba(148,163,184,.35);background:transparent;color:#dbeafe;border-radius:7px;padding:7px 10px;font:600 12px ui-sans-serif,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;cursor:pointer">Cancel</button><button data-submit type="submit" style="border:1px solid #5ca0ff;background:#2684ff;color:white;border-radius:7px;padding:7px 11px;font:650 12px ui-sans-serif,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;cursor:pointer">Add annotation</button></div>',
  ].join("");

  const commentInput = panel.querySelector<HTMLTextAreaElement>("[data-comment]")!;
  const title = panel.querySelector<HTMLElement>("[data-title]")!;
  const error = panel.querySelector<HTMLElement>("[data-error]")!;
  const cancelButton = panel.querySelector<HTMLButtonElement>("[data-cancel]")!;
  document.documentElement.append(highlight, tooltip, panel);

  let hovered: Element | null = null;
  let selected: Element | null = null;
  let status: "active" | "cancelled" | "submitted" = "active";
  let submitted: { comment: string; element: Record<string, unknown> } | null = null;

  const describe = (element: Element): Record<string, unknown> => {
    const computed = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const attributes: Record<string, string> = {};
    for (const attribute of Array.from(element.attributes).slice(0, 100)) {
      attributes[attribute.name.slice(0, 200)] = attribute.value.slice(0, 1000);
    }
    const hierarchy: Array<Record<string, unknown>> = [];
    let ancestor: Element | null = element;
    while (ancestor && hierarchy.length < 32) {
      hierarchy.unshift({
        tagName: ancestor.tagName.toLowerCase(),
        selector: selectorFor(ancestor),
        id: ancestor.id || null,
        classNames: Array.from(ancestor.classList).slice(0, 30),
        role: ancestor.getAttribute("role"),
        ariaLabel: ancestor.getAttribute("aria-label"),
        testId: ancestor.getAttribute("data-testid"),
      });
      ancestor = ancestor.parentElement;
    }
    const styleProperties = [
      "color",
      "background-color",
      "font-family",
      "font-size",
      "font-weight",
      "font-style",
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
      "grid-template-columns",
      "align-items",
      "justify-content",
    ];
    const styles: Record<string, string> = {};
    for (const property of styleProperties) styles[property] = computed.getPropertyValue(property);
    return {
      pageUrl: location.href.slice(0, 4000),
      pageTitle: document.title.slice(0, 1000),
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
      },
      tagName: element.tagName.toLowerCase(),
      selector: selectorFor(element),
      cssPath: cssPathFor(element),
      xpath: xpathFor(element),
      id: element.id || null,
      classNames: Array.from(element.classList).slice(0, 50),
      role: element.getAttribute("role"),
      ariaLabel: element.getAttribute("aria-label"),
      testId: element.getAttribute("data-testid"),
      text: clampText(element.textContent, 4000),
      outerHtml: element.outerHTML.slice(0, 12000),
      attributes,
      rect: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
      },
      styles,
      hierarchy,
    };
  };

  const positionFor = (element: Element): void => {
    const rect = element.getBoundingClientRect();
    Object.assign(highlight.style, {
      display: "block",
      left: `${Math.max(0, rect.left)}px`,
      top: `${Math.max(0, rect.top)}px`,
      width: `${Math.max(0, rect.width)}px`,
      height: `${Math.max(0, rect.height)}px`,
    });
    const computed = getComputedStyle(element);
    const tag = element.tagName.toLowerCase();
    tooltip.innerHTML = [
      `<div style="display:flex;justify-content:space-between;gap:18px"><strong style="font-weight:700">${tag.replaceAll("<", "&lt;")}</strong><span style="color:#dbeafe">${Math.round(rect.width)}×${Math.round(rect.height)}</span></div>`,
      `<div style="display:grid;grid-template-columns:48px minmax(0,1fr);gap:3px 10px;margin-top:5px;color:#a9b7d0"><span>color</span><span style="color:#f8fbff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${computed.color}</span><span>font</span><span style="color:#f8fbff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${computed.fontSize} ${computed.fontFamily}</span></div>`,
    ].join("");
    tooltip.style.display = selected ? "none" : "block";
    const tooltipWidth = 300;
    const left = Math.min(Math.max(8, rect.left), Math.max(8, innerWidth - tooltipWidth - 8));
    const preferredTop = rect.top - 82;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${preferredTop >= 8 ? preferredTop : Math.min(innerHeight - 90, rect.bottom + 8)}px`;
  };

  const placePanel = (element: Element): void => {
    const rect = element.getBoundingClientRect();
    const width = Math.min(360, innerWidth - 24);
    const left = Math.min(Math.max(12, rect.left), innerWidth - width - 12);
    const preferredTop = rect.bottom + 10;
    const top = preferredTop + 190 <= innerHeight ? preferredTop : Math.max(12, rect.top - 200);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (selected || isInspectorNode(event.target)) return;
    const target = document.elementFromPoint(event.clientX, event.clientY);
    if (!target || isInspectorNode(target)) return;
    hovered = target;
    positionFor(target);
  };
  const onClick = (event: MouseEvent): void => {
    if (isInspectorNode(event.target)) return;
    const target = hovered ?? document.elementFromPoint(event.clientX, event.clientY);
    if (!target || isInspectorNode(target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    selected = target;
    positionFor(target);
    title.textContent = `Annotate <${target.tagName.toLowerCase()}>`;
    error.textContent = "";
    panel.style.display = "block";
    placePanel(target);
    commentInput.focus();
  };
  const cancel = (): void => {
    status = "cancelled";
    highlight.style.display = "none";
    tooltip.style.display = "none";
    panel.style.display = "none";
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (selected) {
      selected = null;
      panel.style.display = "none";
      commentInput.value = "";
      error.textContent = "";
      tooltip.style.display = hovered ? "block" : "none";
      return;
    }
    cancel();
  };
  const onViewportChange = (): void => {
    const target = selected ?? hovered;
    if (!target || !target.isConnected) return;
    positionFor(target);
    if (selected) placePanel(selected);
  };

  panel.addEventListener("submit", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const comment = commentInput.value.trim();
    if (!selected || !comment) {
      error.textContent = "Write a short note before adding the annotation.";
      commentInput.focus();
      return;
    }
    submitted = { comment: comment.slice(0, 2000), element: describe(selected) };
    status = "submitted";
    panel.style.display = "none";
    tooltip.style.display = "none";
    positionFor(selected);
  });
  cancelButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    selected = null;
    panel.style.display = "none";
    commentInput.value = "";
    error.textContent = "";
    tooltip.style.display = hovered ? "block" : "none";
  });
  document.addEventListener("pointermove", onPointerMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("scroll", onViewportChange, true);
  window.addEventListener("resize", onViewportChange);

  const destroy = (): void => {
    document.removeEventListener("pointermove", onPointerMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("scroll", onViewportChange, true);
    window.removeEventListener("resize", onViewportChange);
    highlight.remove();
    tooltip.remove();
    panel.remove();
    if (runtimeWindow[runtimeKey] === runtime) delete runtimeWindow[runtimeKey];
  };
  const runtime = {
    getStatus: () => (submitted ? { status, ...submitted } : { status }),
    destroy,
  };
  runtimeWindow[runtimeKey] = runtime;
}

export const BROWSER_PREVIEW_ANNOTATION_START_SCRIPT = `(${installBrowserPreviewAnnotationRuntime.toString()})();`;

export const BROWSER_PREVIEW_ANNOTATION_STATUS_SCRIPT = `(() => {
  try {
    const runtime = window.__orkestratorBrowserAnnotationRuntime__;
    const value = runtime && typeof runtime.getStatus === "function"
      ? runtime.getStatus()
      : { status: "inactive" };
    const encoded = JSON.stringify(value);
    return encoded.length <= 65536 ? encoded : JSON.stringify({ status: "cancelled" });
  } catch {
    return JSON.stringify({ status: "inactive" });
  }
})();`;

export const BROWSER_PREVIEW_ANNOTATION_CANCEL_SCRIPT = `(() => {
  try {
    window.__orkestratorBrowserAnnotationRuntime__?.destroy?.();
  } catch {}
})();`;
