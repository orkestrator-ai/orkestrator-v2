/**
 * Selection-only capture runtime installed in the preview page.
 *
 * The runtime owns its overlays inside the preview because a WebContentsView is
 * composited above the React renderer. It never collects comments: its only
 * output is a selected target and bounded, untrusted page evidence, reported
 * with the host-assigned capture id and a per-install nonce. Electron main
 * polls the bounded status, prepares a coherent screenshot, and spools it.
 *
 * Every function passed to the page is serialized with `toString`, so the
 * installer must not reference module-level bindings.
 */
import type { BrowserPreviewCaptureMode } from "@orkestrator/protocol/browser-preview";
import { browserPreviewAnchorKit } from "./browser-preview-anchor-script.js";

export const BROWSER_PREVIEW_CAPTURE_RUNTIME_KEY = "__orkestratorCaptureRuntime__";
/** Upper bound on any JSON string the runtime returns to main. */
export const BROWSER_PREVIEW_CAPTURE_STATUS_MAX_CHARS = 65_536;
export const BROWSER_PREVIEW_CAPTURE_PROBE_MAX_CHARS = 16_384;

export interface BrowserPreviewCaptureRuntimeConfig {
  captureId: string;
  nonce: string;
  mode: BrowserPreviewCaptureMode;
  /**
   * Recapture: start on the previous target. Element and text targets are
   * resolved with the anchor kit (only a match is used); a region starts as
   * the previous rectangle. The user still confirms with Enter or a click.
   */
  initialTarget?: Record<string, unknown> | null;
}

function installBrowserPreviewCaptureRuntime(
  kitFactory: typeof browserPreviewAnchorKit,
  config: {
    key: string;
    maxChars: number;
    captureId: string;
    nonce: string;
    mode: "element" | "text" | "region" | "page";
    initialTarget: Record<string, unknown> | null;
  },
): string {
  const host = window as unknown as Record<string, unknown>;
  const previous = host[config.key] as { destroy?: () => void } | undefined;
  previous?.destroy?.();

  const kit = kitFactory();
  const UI = kit.UI_ATTRIBUTE;
  const MIN_REGION = 8;
  type Rect = { x: number; y: number; width: number; height: number };
  type Status = "selecting" | "selected" | "cancelled" | "error";

  let status: Status = "selecting";
  let errorCode: string | null = null;
  let selection: Record<string, unknown> | null = null;
  let selectedElement: Element | null = null;
  let selectedRange: Range | null = null;
  let regionRect: Rect | null = null;
  let candidate: Element | null = null;
  const downStack: Element[] = [];
  let frame: number | null = null;
  const cleanups: Array<() => void> = [];
  const hiddenPins: Array<{ element: HTMLElement; visibility: string }> = [];

  const makeNode = (): HTMLDivElement => {
    const node = document.createElement("div");
    node.setAttribute(UI, "");
    return node;
  };
  const font =
    "500 12px/1.45 ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  const highlight = makeNode();
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
  const tooltip = makeNode();
  Object.assign(tooltip.style, {
    position: "fixed",
    zIndex: "2147483646",
    pointerEvents: "none",
    maxWidth: "360px",
    padding: "6px 9px",
    color: "#f8fbff",
    background: "rgba(9, 20, 43, 0.96)",
    border: "1px solid rgba(92, 154, 255, 0.45)",
    borderRadius: "7px",
    boxShadow: "0 10px 26px rgba(0,0,0,0.35)",
    font,
    display: "none",
    boxSizing: "border-box",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  });
  const hint = makeNode();
  Object.assign(hint.style, {
    position: "fixed",
    zIndex: "2147483647",
    pointerEvents: "none",
    left: "50%",
    bottom: "14px",
    transform: "translateX(-50%)",
    padding: "6px 12px",
    color: "#f8fbff",
    background: "rgba(9, 20, 43, 0.92)",
    borderRadius: "999px",
    font,
    boxSizing: "border-box",
    whiteSpace: "nowrap",
  });
  const regionOverlay = makeNode();
  Object.assign(regionOverlay.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483644",
    cursor: "crosshair",
    background: "rgba(9, 20, 43, 0.12)",
    touchAction: "none",
    display: "none",
  });
  // Element mode: a transparent, inspector-owned layer takes every pointer
  // event, so the page's own listeners (even window capture-phase ones that
  // were registered before this runtime) see the overlay as the target rather
  // than the element under the pointer.
  const pickOverlay = makeNode();
  Object.assign(pickOverlay.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483643",
    cursor: "default",
    background: "transparent",
    touchAction: "none",
    display: "none",
  });
  // Screen-reader announcement of the keyboard candidate; visually hidden.
  const announcer = makeNode();
  announcer.setAttribute("role", "status");
  announcer.setAttribute("aria-live", "polite");
  Object.assign(announcer.style, {
    position: "fixed",
    width: "1px",
    height: "1px",
    overflow: "hidden",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
    pointerEvents: "none",
  });
  const regionBox = makeNode();
  Object.assign(regionBox.style, {
    position: "fixed",
    zIndex: "2147483645",
    pointerEvents: "none",
    border: "2px dashed #2684ff",
    background: "rgba(38, 132, 255, 0.08)",
    boxSizing: "border-box",
    display: "none",
  });
  const masks: HTMLElement[] = [];

  const hints: Record<string, string> = {
    element:
      "Click an element or use the keyboard · ↑ parent · ↓ child · ←/→ siblings · Enter select · Esc cancel",
    text: "Select text, then release or press Enter · Esc cancel",
    region:
      "Drag a region, or press Enter for one · arrows move · Shift+arrows resize · Enter capture · Esc cancel",
    page: "Capturing page…",
  };
  hint.textContent = hints[config.mode] ?? "";
  document.documentElement.append(
    pickOverlay,
    highlight,
    tooltip,
    regionOverlay,
    regionBox,
    hint,
    announcer,
  );
  const announce = (text: string): void => {
    announcer.textContent = text.slice(0, 300);
  };

  const place = (node: HTMLElement, rect: Rect): void => {
    Object.assign(node.style, {
      display: "block",
      left: `${rect.x}px`,
      top: `${rect.y}px`,
      width: `${Math.max(0, rect.width)}px`,
      height: `${Math.max(0, rect.height)}px`,
    });
  };
  // Only the user may drive selection. The page shares this DOM and can
  // dispatch synthetic clicks and keys, but it cannot forge `isTrusted`, so
  // every selection listener ignores events the browser did not generate.
  const listen = (
    target: EventTarget,
    type: string,
    listener: (event: Event) => void,
    capture = true,
  ): void => {
    const trusted = (event: Event): void => {
      if (event.isTrusted !== true) return;
      listener(event);
    };
    target.addEventListener(type, trusted, capture);
    cleanups.push(() => target.removeEventListener(type, trusted, capture));
  };
  const stopInteraction = (): void => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    if (frame !== null) window.cancelAnimationFrame?.(frame);
    frame = null;
  };
  const viewportState = () => ({
    viewport: { width: window.innerWidth, height: window.innerHeight },
    scroll: { x: window.scrollX, y: window.scrollY },
    devicePixelRatio: window.devicePixelRatio,
  });
  const complete = (payload: Record<string, unknown>): void => {
    selection = {
      ...payload,
      title: (document.title ?? "").slice(0, 500),
      ...viewportState(),
    };
    status = "selected";
    tooltip.style.display = "none";
    hint.textContent = "Capturing…";
    stopInteraction();
  };
  const fail = (code: string): void => {
    status = "error";
    errorCode = code;
    stopInteraction();
    hint.remove();
  };

  // -- Element mode ---------------------------------------------------------
  /** The page element under a point, skipping inspector-owned overlays. */
  const elementAt = (x: number, y: number): Element | null => {
    try {
      const stack = document.elementsFromPoint?.(x, y) ?? [];
      for (let index = 0; index < Math.min(stack.length, 32); index += 1) {
        const element = stack[index]!;
        if (!kit.isInspectorNode(element)) return element;
      }
    } catch {
      // Fall back to a single hit test below.
    }
    const previous = pickOverlay.style.pointerEvents;
    pickOverlay.style.pointerEvents = "none";
    try {
      const element = document.elementFromPoint(x, y);
      return element && !kit.isInspectorNode(element) ? element : null;
    } catch {
      return null;
    } finally {
      pickOverlay.style.pointerEvents = previous;
    }
  };
  const selectable = (element: Element | null): element is Element =>
    Boolean(element) &&
    element !== document.documentElement &&
    element !== document.body &&
    !kit.isInspectorNode(element);
  const initialTargetElement = (): Element | null => {
    const initial = config.initialTarget;
    if (!initial || initial.kind !== "element") return null;
    try {
      const resolution = kit.resolveTarget(initial, kit.createBudget(20_000, 60));
      return resolution.state === "matched" ? resolution.element : null;
    } catch {
      return null;
    }
  };
  /** Keyboard start: the previous target, the focused element, or the element at the centre. */
  const startingCandidate = (): Element | null => {
    const resolved = initialTargetElement();
    if (selectable(resolved)) return resolved;
    const active = document.activeElement;
    if (selectable(active)) return active;
    const centre = elementAt(window.innerWidth / 2, window.innerHeight / 2);
    if (selectable(centre)) return centre;
    const first = document.body?.firstElementChild ?? null;
    return selectable(first) ? first : null;
  };
  const siblingOf = (element: Element, direction: -1 | 1): Element | null => {
    let current: Element | null =
      direction === 1 ? element.nextElementSibling : element.previousElementSibling;
    for (let step = 0; current && step < 200; step += 1) {
      if (!kit.isInspectorNode(current)) return current;
      current = direction === 1 ? current.nextElementSibling : current.previousElementSibling;
    }
    return null;
  };
  const showCandidate = (): void => {
    frame = null;
    if (!candidate || !candidate.isConnected || status !== "selecting") return;
    const rect = kit.rectOf(candidate);
    place(highlight, rect);
    const width = Math.round(rect.width);
    const heightValue = Math.round(rect.height);
    tooltip.textContent = `${kit.hoverLabel(candidate)} · ${width}×${heightValue}`;
    tooltip.style.display = "block";
    const left = Math.min(Math.max(8, rect.x), Math.max(8, window.innerWidth - 368));
    const above = rect.y - 34;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${above >= 8 ? above : Math.min(window.innerHeight - 34, rect.y + rect.height + 8)}px`;
  };
  const scheduleCandidate = (): void => {
    if (frame !== null) return;
    if (typeof window.requestAnimationFrame !== "function") {
      showCandidate();
      return;
    }
    frame = window.requestAnimationFrame(showCandidate);
  };
  const selectElement = (element: Element): void => {
    if (kit.isInspectorNode(element)) return;
    let described: ReturnType<typeof kit.describeElement>;
    try {
      described = kit.describeElement(element);
    } catch {
      fail("capture-failed");
      return;
    }
    selectedElement = element;
    place(highlight, kit.rectOf(element));
    highlight.style.borderColor = "#f59e0b";
    complete(described as unknown as Record<string, unknown>);
  };
  const suppress = (event: Event): void => {
    if (kit.isInspectorNode(event.target as Node | null)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  /** Stop the page from seeing the event at all: window capture is the earliest listener point. */
  const swallow = (event: Event): void => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const moveTo = (next: Element | null, fromKeyboard: boolean): void => {
    if (!next || next === candidate) return;
    candidate = next;
    scheduleCandidate();
    if (fromKeyboard) announce(kit.hoverLabel(next));
  };
  const installElementMode = (): void => {
    pickOverlay.style.display = "block";
    listen(window, "pointermove", (event) => {
      const pointer = event as PointerEvent;
      const target = elementAt(pointer.clientX, pointer.clientY);
      if (!target || target === candidate) return;
      downStack.length = 0;
      moveTo(target, false);
    });
    for (const type of [
      "pointerdown",
      "mousedown",
      "pointerup",
      "mouseup",
      "touchstart",
      "touchend",
      "dblclick",
      "auxclick",
      "contextmenu",
    ]) {
      listen(window, type, swallow);
    }
    listen(window, "click", (event) => {
      swallow(event);
      const mouse = event as MouseEvent;
      const pointTarget = elementAt(mouse.clientX, mouse.clientY);
      const chosen =
        candidate && pointTarget && (candidate === pointTarget || candidate.contains(pointTarget))
          ? candidate
          : (pointTarget ?? candidate);
      if (chosen) selectElement(chosen);
    });
    listen(window, "keydown", (event) => {
      const key = (event as KeyboardEvent).key;
      if (key === "Escape") {
        swallow(event);
        cancel();
        return;
      }
      const navigation = [
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "[",
        "]",
        "Enter",
      ].includes(key);
      if (!navigation) return;
      swallow(event);
      if (!candidate || !candidate.isConnected) {
        downStack.length = 0;
        moveTo(startingCandidate(), true);
        if (key !== "Enter") return;
      }
      if (!candidate) return;
      if (key === "ArrowUp" || key === "[") {
        const parent: Element | null = candidate.parentElement;
        if (selectable(parent)) {
          downStack.push(candidate);
          moveTo(parent, true);
        }
      } else if (key === "ArrowDown" || key === "]") {
        let next = downStack.pop() ?? null;
        if (!next || !candidate.contains(next)) {
          next = null;
          const children = candidate.children;
          for (let index = 0; index < Math.min(children.length, 200); index += 1) {
            const child = children[index]!;
            if (!kit.isInspectorNode(child)) {
              next = child;
              break;
            }
          }
        }
        moveTo(next, true);
      } else if (key === "ArrowLeft" || key === "ArrowRight") {
        downStack.length = 0;
        moveTo(siblingOf(candidate, key === "ArrowRight" ? 1 : -1), true);
      } else if (key === "Enter") {
        selectElement(candidate);
      }
    });
    listen(window, "scroll", scheduleCandidate);
    listen(window, "resize", scheduleCandidate);
    // Keyboard users start with a visible candidate; no hover is needed.
    const first = startingCandidate();
    if (first) moveTo(first, true);
  };

  // -- Text mode ------------------------------------------------------------
  const checkTextSelection = (): void => {
    if (status !== "selecting") return;
    const active = document.activeElement;
    if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) {
      if (kit.isSensitiveElement(active))
        hint.textContent = "Sensitive fields can't be captured · Esc cancel";
      return;
    }
    const current = window.getSelection?.();
    if (!current || current.rangeCount === 0 || current.isCollapsed) return;
    const range = current.getRangeAt(0).cloneRange();
    let described: ReturnType<typeof kit.describeRange>;
    try {
      described = kit.describeRange(range);
    } catch {
      fail("capture-failed");
      return;
    }
    if ("error" in described) {
      if (described.error === "sensitive") {
        hint.textContent = "Sensitive fields can't be captured · Esc cancel";
      } else if (described.error === "unsupported") {
        hint.textContent = "This text can't be captured; try Region · Esc cancel";
      }
      return;
    }
    selectedRange = range;
    place(highlight, kit.rectOf(range));
    highlight.style.borderColor = "#f59e0b";
    complete(described as unknown as Record<string, unknown>);
  };
  const installTextMode = (): void => {
    listen(window, "mouseup", () => {
      window.setTimeout(checkTextSelection, 0);
    });
    // Selection gestures stay native; activating links and buttons does not.
    listen(window, "click", suppress);
    const initial = config.initialTarget;
    if (initial && initial.kind === "text-range") {
      // Recapture: preselect the previous quote when it still resolves uniquely.
      try {
        const resolution = kit.resolveTarget(initial, kit.createBudget(20_000, 60));
        const current = window.getSelection?.();
        if (resolution.state === "matched" && resolution.range && current) {
          current.removeAllRanges();
          current.addRange(resolution.range);
          place(highlight, kit.rectOf(resolution.range));
          announce("Previous text selected. Press Enter to capture it.");
        }
      } catch {
        // The user selects again.
      }
    }
    listen(window, "keydown", (event) => {
      const key = (event as KeyboardEvent).key;
      if (key === "Escape") {
        suppress(event);
        cancel();
      } else if (key === "Enter") {
        suppress(event);
        checkTextSelection();
      }
    });
  };

  // -- Region mode ----------------------------------------------------------
  const normalizedRect = (x1: number, y1: number, x2: number, y2: number): Rect => {
    const left = Math.max(0, Math.min(x1, x2));
    const top = Math.max(0, Math.min(y1, y2));
    const right = Math.min(window.innerWidth, Math.max(x1, x2));
    const bottom = Math.min(window.innerHeight, Math.max(y1, y2));
    return {
      x: Math.round(left),
      y: Math.round(top),
      width: Math.round(Math.max(0, right - left)),
      height: Math.round(Math.max(0, bottom - top)),
    };
  };
  let dragStart: { x: number; y: number } | null = null;
  let drafted: Rect | null = null;
  const confirmRegion = (): void => {
    if (!drafted || drafted.width < MIN_REGION || drafted.height < MIN_REGION) return;
    regionRect = { ...drafted };
    regionOverlay.style.background = "transparent";
    regionOverlay.style.pointerEvents = "none";
    regionBox.style.borderStyle = "solid";
    regionBox.style.borderColor = "#f59e0b";
    complete({
      target: {
        kind: "region",
        label: `Region ${regionRect.width}×${regionRect.height}`,
        rect: regionRect,
        imageRect: null,
      },
      evidence: null,
      redaction: { attributesRemoved: 0, valuesMasked: 0, urlParametersRemoved: 0 },
    });
  };
  /** A keyboard-created region: centred, a third of the viewport, at least the minimum. */
  const defaultRegion = (): Rect => {
    const width = Math.max(MIN_REGION, Math.round(Math.min(360, window.innerWidth / 3)));
    const height = Math.max(MIN_REGION, Math.round(Math.min(240, window.innerHeight / 3)));
    const x = Math.round((window.innerWidth - width) / 2);
    const y = Math.round((window.innerHeight - height) / 2);
    return normalizedRect(x, y, x + width, y + height);
  };
  const installRegionMode = (): void => {
    regionOverlay.style.display = "block";
    const initial = config.initialTarget;
    const initialRect = initial && initial.kind === "region" ? (initial.rect as Rect | null) : null;
    if (
      initialRect &&
      [initialRect.x, initialRect.y, initialRect.width, initialRect.height].every(Number.isFinite)
    ) {
      const next = normalizedRect(
        initialRect.x,
        initialRect.y,
        initialRect.x + initialRect.width,
        initialRect.y + initialRect.height,
      );
      if (next.width >= MIN_REGION && next.height >= MIN_REGION) {
        drafted = next;
        place(regionBox, drafted);
      }
    }
    listen(regionOverlay, "pointerdown", (event) => {
      const pointer = event as PointerEvent;
      event.preventDefault();
      dragStart = { x: pointer.clientX, y: pointer.clientY };
      drafted = normalizedRect(dragStart.x, dragStart.y, dragStart.x, dragStart.y);
      place(regionBox, drafted);
      try {
        regionOverlay.setPointerCapture?.(pointer.pointerId);
      } catch {
        // Capture is best effort; the overlay still covers the viewport.
      }
    });
    listen(regionOverlay, "pointermove", (event) => {
      if (!dragStart) return;
      const pointer = event as PointerEvent;
      drafted = normalizedRect(dragStart.x, dragStart.y, pointer.clientX, pointer.clientY);
      place(regionBox, drafted);
    });
    listen(regionOverlay, "pointerup", (event) => {
      if (!dragStart) return;
      const pointer = event as PointerEvent;
      drafted = normalizedRect(dragStart.x, dragStart.y, pointer.clientX, pointer.clientY);
      dragStart = null;
      if (drafted.width < MIN_REGION || drafted.height < MIN_REGION) {
        drafted = null;
        regionBox.style.display = "none";
        return;
      }
      place(regionBox, drafted);
    });
    listen(regionOverlay, "dblclick", (event) => {
      event.preventDefault();
      confirmRegion();
    });
    for (const type of ["click", "wheel", "contextmenu"]) {
      listen(regionOverlay, type, (event) => event.preventDefault());
    }
    listen(window, "keydown", (event) => {
      const keyboard = event as KeyboardEvent;
      const key = keyboard.key;
      if (key === "Escape") {
        suppress(event);
        cancel();
        return;
      }
      if (key === "Enter") {
        suppress(event);
        if (!drafted) {
          // Keyboard-only: the first Enter proposes a region, the next confirms it.
          drafted = defaultRegion();
          place(regionBox, drafted);
          announce(
            `Region ${drafted.width} by ${drafted.height}. Arrows move, Shift+arrows resize, Enter captures.`,
          );
          return;
        }
        confirmRegion();
        return;
      }
      if (!key.startsWith("Arrow")) return;
      suppress(event);
      if (!drafted) {
        drafted = defaultRegion();
        place(regionBox, drafted);
      }
      const step = keyboard.altKey ? 1 : 10;
      const dx = key === "ArrowLeft" ? -step : key === "ArrowRight" ? step : 0;
      const dy = key === "ArrowUp" ? -step : key === "ArrowDown" ? step : 0;
      const next = keyboard.shiftKey
        ? normalizedRect(
            drafted.x,
            drafted.y,
            drafted.x + drafted.width + dx,
            drafted.y + drafted.height + dy,
          )
        : normalizedRect(
            drafted.x + dx,
            drafted.y + dy,
            drafted.x + dx + drafted.width,
            drafted.y + dy + drafted.height,
          );
      if (next.width >= MIN_REGION && next.height >= MIN_REGION) {
        drafted = next;
        place(regionBox, drafted);
        announce(`Region ${next.width} by ${next.height} at ${next.x}, ${next.y}.`);
      }
    });
  };

  // -- Lifecycle ------------------------------------------------------------
  const restorePins = (): void => {
    for (const { element, visibility } of hiddenPins.splice(0))
      element.style.visibility = visibility;
  };
  const removeMasks = (): void => {
    for (const mask of masks.splice(0)) mask.remove();
  };
  const teardown = (): void => {
    stopInteraction();
    restorePins();
    removeMasks();
    for (const node of [
      pickOverlay,
      highlight,
      tooltip,
      hint,
      regionOverlay,
      regionBox,
      announcer,
    ]) {
      node.remove();
    }
  };
  const destroy = (): void => {
    teardown();
    if (host[config.key] === runtime) delete host[config.key];
  };
  /** Restore the page at once but stay registered so main reads `cancelled`, then destroys. */
  function cancel(): void {
    status = "cancelled";
    teardown();
  }

  const probe = () => {
    let connected = true;
    let rect: Rect | null = null;
    if (selectedElement) {
      connected = selectedElement.isConnected;
      rect = kit.rectOf(selectedElement);
    } else if (selectedRange) {
      connected =
        selectedRange.startContainer.isConnected && selectedRange.endContainer.isConnected;
      rect = kit.rectOf(selectedRange);
    } else if (regionRect) {
      rect = { ...regionRect };
    }
    return {
      captureId: config.captureId,
      nonce: config.nonce,
      connected,
      rect,
      ...viewportState(),
      sensitive: kit.sensitiveRects(),
    };
  };
  const waitForPaint = (): Promise<void> =>
    new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      const request = window.requestAnimationFrame?.bind(window);
      if (request) request(() => request(finish));
      window.setTimeout(finish, 150);
    });
  /** Leave only the selected-target highlight, mask sensitive fields, and wait for paint. */
  const prepare = async (captureId: string) => {
    if (captureId !== config.captureId || status !== "selected") return null;
    tooltip.style.display = "none";
    hint.style.display = "none";
    regionOverlay.style.background = "transparent";
    announcer.textContent = "";
    if (hiddenPins.length === 0) {
      const layers = document.querySelectorAll<HTMLElement>("[data-orkestrator-pins]");
      for (let index = 0; index < Math.min(layers.length, 8); index += 1) {
        const layer = layers[index]!;
        hiddenPins.push({ element: layer, visibility: layer.style.visibility });
        layer.style.visibility = "hidden";
      }
    }
    if (selectedElement?.isConnected) place(highlight, kit.rectOf(selectedElement));
    else if (selectedRange) place(highlight, kit.rectOf(selectedRange));
    else if (!regionRect) highlight.style.display = "none";
    removeMasks();
    const current = probe();
    for (const rect of current.sensitive) {
      const mask = makeNode();
      Object.assign(mask.style, {
        position: "fixed",
        zIndex: "2147483647",
        pointerEvents: "none",
        background: "#1f2328",
        boxSizing: "border-box",
      });
      place(mask, rect);
      masks.push(mask);
      document.documentElement.append(mask);
    }
    await waitForPaint();
    return current;
  };
  const statusValue = () => ({
    v: 1,
    captureId: config.captureId,
    nonce: config.nonce,
    mode: config.mode,
    status,
    ...(status === "selected" && selection ? { selection } : {}),
    ...(status === "error" ? { error: { code: errorCode ?? "capture-failed" } } : {}),
  });

  /**
   * Bounded stability window for result captures: wait for web fonts and for
   * layout to stay quiet (no page mutations, no change in the target rect or
   * document size) for `quietMs`, at most `deadlineMs` in total.
   */
  const settle = async (captureId: string, deadlineMs: number, quietMs: number) => {
    if (captureId !== config.captureId || status !== "selected") return null;
    const started = Date.now();
    const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
    let fontsReady = true;
    const fonts = (document as Document & { fonts?: { ready?: Promise<unknown> } }).fonts;
    if (fonts?.ready && typeof fonts.ready.then === "function") {
      fontsReady = await Promise.race([
        fonts.ready.then(
          () => true,
          () => false,
        ),
        sleep(deadlineMs).then(() => false),
      ]);
    }
    let mutated = false;
    let observer: MutationObserver | null = null;
    const Observer = (window as unknown as { MutationObserver?: typeof MutationObserver })
      .MutationObserver;
    if (typeof Observer === "function") {
      observer = new Observer((records) => {
        if (records.length > 16 || records.some((record) => !kit.isInspectorNode(record.target))) {
          mutated = true;
        }
      });
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
    }
    const layoutKey = (): string => {
      const current = probe();
      const root = document.documentElement;
      return JSON.stringify([
        current.rect,
        current.viewport,
        current.scroll,
        root.scrollWidth,
        root.scrollHeight,
      ]);
    };
    let last = layoutKey();
    let quietSince = Date.now();
    let quiet = false;
    try {
      while (Date.now() - started < deadlineMs) {
        await sleep(Math.min(50, quietMs));
        const key = layoutKey();
        if (key !== last || mutated) {
          last = key;
          mutated = false;
          quietSince = Date.now();
        } else if (Date.now() - quietSince >= quietMs) {
          quiet = true;
          break;
        }
      }
    } finally {
      observer?.disconnect();
    }
    return {
      captureId: config.captureId,
      nonce: config.nonce,
      stable: quiet && fontsReady,
      fontsReady,
      waitedMs: Math.round(Date.now() - started),
    };
  };

  const runtime = {
    status: statusValue,
    prepare,
    settle,
    probe: (captureId: string) =>
      captureId === config.captureId && status === "selected" ? probe() : null,
    destroy,
  };
  host[config.key] = runtime;

  try {
    if (config.mode === "element") installElementMode();
    else if (config.mode === "text") installTextMode();
    else if (config.mode === "region") installRegionMode();
    else {
      complete({
        target: { kind: "page", label: "Whole page" },
        evidence: null,
        redaction: { attributesRemoved: 0, valuesMasked: 0, urlParametersRemoved: 0 },
      });
      hint.style.display = "none";
    }
  } catch {
    fail("capture-failed");
  }
  const encoded = JSON.stringify(statusValue());
  return encoded.length <= config.maxChars
    ? encoded
    : JSON.stringify({
        ...statusValue(),
        selection: undefined,
        status: "error",
        error: { code: "too-large" },
      });
}

const KEY = BROWSER_PREVIEW_CAPTURE_RUNTIME_KEY;

export function browserPreviewCaptureStartScript(
  config: BrowserPreviewCaptureRuntimeConfig,
): string {
  const payload = {
    key: KEY,
    maxChars: BROWSER_PREVIEW_CAPTURE_STATUS_MAX_CHARS,
    captureId: config.captureId,
    nonce: config.nonce,
    mode: config.mode,
    initialTarget: config.initialTarget ?? null,
  };
  return `/*orkestrator:capture-start*/(${installBrowserPreviewCaptureRuntime.toString()})(${browserPreviewAnchorKit.toString()}, ${JSON.stringify(payload)});`;
}

export const BROWSER_PREVIEW_CAPTURE_STATUS_SCRIPT = `/*orkestrator:capture-status*/(() => {
  try {
    const runtime = window.${KEY};
    if (!runtime || typeof runtime.status !== "function") return JSON.stringify({ status: "inactive" });
    const value = runtime.status();
    const encoded = JSON.stringify(value);
    if (typeof encoded === "string" && encoded.length <= ${BROWSER_PREVIEW_CAPTURE_STATUS_MAX_CHARS}) return encoded;
    return JSON.stringify({
      v: 1,
      captureId: String(value && value.captureId).slice(0, 200),
      nonce: String(value && value.nonce).slice(0, 200),
      mode: String(value && value.mode).slice(0, 20),
      status: "error",
      error: { code: "too-large" },
    });
  } catch {
    return JSON.stringify({ status: "inactive" });
  }
})();`;

export function browserPreviewCapturePrepareScript(captureId: string): string {
  return `/*orkestrator:capture-prepare*/(async () => {
  try {
    const runtime = window.${KEY};
    if (!runtime || typeof runtime.prepare !== "function") return null;
    const encoded = JSON.stringify(await runtime.prepare(${JSON.stringify(captureId)}));
    return typeof encoded === "string" && encoded.length <= ${BROWSER_PREVIEW_CAPTURE_PROBE_MAX_CHARS} ? encoded : null;
  } catch {
    return null;
  }
})();`;
}

/** Result captures: bounded font/layout stability window before the screenshot. */
export function browserPreviewCaptureSettleScript(
  captureId: string,
  options: { deadlineMs: number; quietMs: number },
): string {
  return `/*orkestrator:capture-settle*/(async () => {
  try {
    const runtime = window.${KEY};
    if (!runtime || typeof runtime.settle !== "function") return null;
    const encoded = JSON.stringify(await runtime.settle(${JSON.stringify(captureId)}, ${Number(options.deadlineMs)}, ${Number(options.quietMs)}));
    return typeof encoded === "string" && encoded.length <= 1024 ? encoded : null;
  } catch {
    return null;
  }
})();`;
}

export function browserPreviewCaptureProbeScript(captureId: string): string {
  return `/*orkestrator:capture-probe*/(() => {
  try {
    const runtime = window.${KEY};
    if (!runtime || typeof runtime.probe !== "function") return null;
    const encoded = JSON.stringify(runtime.probe(${JSON.stringify(captureId)}));
    return typeof encoded === "string" && encoded.length <= ${BROWSER_PREVIEW_CAPTURE_PROBE_MAX_CHARS} ? encoded : null;
  } catch {
    return null;
  }
})();`;
}

export const BROWSER_PREVIEW_CAPTURE_CANCEL_SCRIPT = `/*orkestrator:capture-cancel*/(() => {
  try {
    window.${KEY}?.destroy?.();
  } catch {}
})();`;
