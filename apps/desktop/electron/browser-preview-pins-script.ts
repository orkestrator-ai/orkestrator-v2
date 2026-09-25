/**
 * Live pin layer installed in the preview page.
 *
 * Resolves saved anchors with the shared anchor kit and draws numbered pins
 * only for matched targets, in an inspector-owned, pointer-transparent layer.
 * A MutationObserver re-resolves pins after DOM replacement (hot reload,
 * client-side re-render) on a bounded, coalesced schedule:
 *
 * - mutation records are never inspected beyond a small sample used to skip
 *   batches caused only by inspector-owned nodes;
 * - at most one resolution pass per throttle window, trailing;
 * - a fixed allowance of passes per installed layer, after which the layer
 *   pauses (reported in diagnostics) until the host re-sends pins;
 * - no work while the document is hidden;
 * - every pass shares one traversal budget and deadline.
 *
 * Main reads `snapshot()` (results, a change revision, and content-free
 * counters) and forwards a content-free "pins changed" hint to the renderer.
 *
 * Serialized with `toString`: no module-level references inside the installer.
 */
import { browserPreviewAnchorKit } from "./browser-preview-anchor-script.js";

export const BROWSER_PREVIEW_PINS_KEY = "__orkestratorPreviewPins__";
export const BROWSER_PREVIEW_PINS_MAX_CHARS = 131_072;

export interface BrowserPreviewPinsScriptLimits {
  /** Minimum time between mutation-driven passes. */
  throttleMs: number;
  /** Mutation-driven passes allowed before the layer pauses. */
  maxPasses: number;
  /** Shared traversal budget per pass. */
  budgetVisits: number;
  budgetMs: number;
}

export const BROWSER_PREVIEW_PINS_DEFAULT_LIMITS: BrowserPreviewPinsScriptLimits = Object.freeze({
  throttleMs: 750,
  maxPasses: 120,
  budgetVisits: 60_000,
  budgetMs: 120,
});

export interface BrowserPreviewPinsScriptQuery {
  annotationId: string;
  number: number;
  /** Short target label for the pin's accessible name. */
  label: string;
  target: unknown;
}

function installBrowserPreviewPins(
  kitFactory: typeof browserPreviewAnchorKit,
  config: {
    key: string;
    maxChars: number;
    queries: Array<{
      annotationId: string;
      number: number;
      label: string;
      target: Record<string, unknown>;
    }>;
    focusedAnnotationId: string | null;
    scrollIntoView: boolean;
    limits: { throttleMs: number; maxPasses: number; budgetVisits: number; budgetMs: number };
  },
): string {
  const host = window as unknown as Record<string, unknown>;
  const previous = host[config.key] as { destroy?: () => void } | undefined;
  previous?.destroy?.();
  const kit = kitFactory();
  const layer = document.createElement("div");
  layer.setAttribute(kit.UI_ATTRIBUTE, "");
  layer.setAttribute("data-orkestrator-pins", "");
  layer.setAttribute("role", "group");
  layer.setAttribute("aria-label", "Orkestrator annotation pins");
  Object.assign(layer.style, {
    position: "fixed",
    inset: "0",
    pointerEvents: "none",
    zIndex: "2147483640",
    overflow: "hidden",
  });

  type Result = {
    annotationId: string;
    state: string;
    rule: string;
    candidateCount: number;
    rect: { x: number; y: number; width: number; height: number } | null;
  };
  type Pin = {
    query: (typeof config.queries)[number];
    result: Result;
    element: Element | null;
    range: Range | null;
    node: HTMLElement;
    outline: HTMLElement;
  };
  const diagnostics = {
    pins: 0,
    byState: {} as Record<string, number>,
    byRule: {} as Record<string, number>,
    passes: 0,
    mutationBatches: 0,
    throttledBatches: 0,
    budgetExhausted: 0,
    paused: false,
  };
  let revision = 0;
  let destroyed = false;
  const pins: Pin[] = [];

  const makePin = (query: (typeof config.queries)[number]): Pin => {
    const isFocused = query.annotationId === config.focusedAnnotationId;
    const outline = document.createElement("div");
    outline.setAttribute(kit.UI_ATTRIBUTE, "");
    outline.setAttribute("aria-hidden", "true");
    Object.assign(outline.style, {
      position: "absolute",
      border: isFocused ? "2px solid #f59e0b" : "1px solid rgba(38,132,255,0.7)",
      borderRadius: "3px",
      boxSizing: "border-box",
      pointerEvents: "none",
      display: "none",
    });
    const node = document.createElement("div");
    node.setAttribute(kit.UI_ATTRIBUTE, "");
    // Pins are labels, not controls: they stay out of the page's tab order and
    // the trusted panel is the keyboard path to each note.
    node.setAttribute("role", "img");
    const label = String(query.label ?? "").slice(0, 200);
    node.setAttribute(
      "aria-label",
      label ? `Annotation ${query.number}: ${label}` : `Annotation ${query.number}`,
    );
    node.setAttribute("title", label ? `Note ${query.number} · ${label}` : `Note ${query.number}`);
    node.textContent = String(query.number);
    Object.assign(node.style, {
      position: "absolute",
      minWidth: "20px",
      height: "20px",
      padding: "0 5px",
      borderRadius: "10px",
      background: isFocused ? "#f59e0b" : "#2684ff",
      color: "#fff",
      font: "700 11px/20px ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      textAlign: "center",
      boxSizing: "border-box",
      boxShadow: "0 1px 4px rgba(0,0,0,0.35)",
      pointerEvents: "none",
      display: "none",
    });
    layer.append(outline, node);
    return {
      query,
      result: {
        annotationId: query.annotationId,
        state: "missing",
        rule: "none",
        candidateCount: 0,
        rect: null,
      },
      element: null,
      range: null,
      node,
      outline,
    };
  };

  const place = (): void => {
    for (const pin of pins) {
      const connected = pin.element
        ? pin.element.isConnected
        : Boolean(pin.range?.startContainer.isConnected);
      const rect = pin.element ? kit.rectOf(pin.element) : pin.range ? kit.rectOf(pin.range) : null;
      if (pin.result.state !== "matched" || !connected || !rect) {
        pin.node.style.display = "none";
        pin.outline.style.display = "none";
        continue;
      }
      pin.node.style.display = "block";
      pin.outline.style.display = "block";
      Object.assign(pin.outline.style, {
        left: `${rect.x}px`,
        top: `${rect.y}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      });
      pin.node.style.left = `${Math.max(0, rect.x - 10)}px`;
      pin.node.style.top = `${Math.max(0, rect.y - 10)}px`;
    }
  };

  /** One bounded pass over every pin; returns whether any result changed. */
  const resolveAll = (): boolean => {
    kit.resetResolverCache();
    const budget = kit.createBudget(config.limits.budgetVisits, config.limits.budgetMs);
    diagnostics.passes += 1;
    diagnostics.byState = {};
    diagnostics.byRule = {};
    let changed = false;
    for (const pin of pins) {
      const resolution = kit.resolveTarget(pin.query.target, budget);
      const next: Result = {
        annotationId: pin.query.annotationId,
        state: resolution.state,
        rule: resolution.rule,
        candidateCount: resolution.candidateCount,
        rect: resolution.state === "matched" ? resolution.rect : null,
      };
      const previousResult = pin.result;
      const previousTarget = pin.element ?? pin.range?.startContainer ?? null;
      pin.result = next;
      pin.element = resolution.state === "matched" ? resolution.element : null;
      pin.range = resolution.state === "matched" ? resolution.range : null;
      const nextTarget = pin.element ?? pin.range?.startContainer ?? null;
      if (
        previousResult.state !== next.state ||
        previousResult.rule !== next.rule ||
        previousResult.candidateCount !== next.candidateCount ||
        previousTarget !== nextTarget
      ) {
        changed = true;
      }
      diagnostics.byState[next.state] = (diagnostics.byState[next.state] ?? 0) + 1;
      diagnostics.byRule[next.rule] = (diagnostics.byRule[next.rule] ?? 0) + 1;
    }
    if (budget.exhausted) diagnostics.budgetExhausted += 1;
    if (changed) revision += 1;
    place();
    return changed;
  };

  for (const query of config.queries.slice(0, 50)) pins.push(makePin(query));
  diagnostics.pins = pins.length;
  document.documentElement.append(layer);
  resolveAll();
  const focused = pins.find(
    (pin) =>
      pin.query.annotationId === config.focusedAnnotationId && pin.result.state === "matched",
  );
  if (config.scrollIntoView && focused) {
    try {
      const target = focused.element ?? focused.range?.startContainer.parentElement ?? null;
      target?.scrollIntoView?.({ block: "center", inline: "nearest" });
      place();
    } catch {
      // Scrolling is a convenience.
    }
  }

  let frame: number | null = null;
  const schedulePlace = (): void => {
    if (frame !== null || destroyed) return;
    const request = window.requestAnimationFrame?.bind(window);
    if (!request) {
      place();
      return;
    }
    frame = request(() => {
      frame = null;
      place();
    });
  };

  // -- Mutation-driven re-resolution -----------------------------------------
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dirty = false;
  let lastPass = Date.now();
  let mutationPasses = 0;
  const hidden = (): boolean => document.visibilityState === "hidden";
  const runPass = (): void => {
    timer = null;
    if (destroyed || !dirty) return;
    if (hidden()) return; // Resumed by visibilitychange.
    if (mutationPasses >= config.limits.maxPasses) {
      diagnostics.paused = true;
      dirty = false;
      return;
    }
    dirty = false;
    mutationPasses += 1;
    lastPass = Date.now();
    resolveAll();
  };
  const schedulePass = (): void => {
    if (timer !== null || destroyed) {
      diagnostics.throttledBatches += 1;
      return;
    }
    const wait = Math.max(0, config.limits.throttleMs - (Date.now() - lastPass));
    timer = setTimeout(runPass, Math.max(wait, 16));
  };
  /**
   * A small batch made only of inspector-owned nodes (our own overlays) is
   * ignored. Larger batches are never walked: they always count as page work.
   */
  const onlyInspector = (records: MutationRecord[]): boolean => {
    if (records.length > 16) return false;
    for (const record of records) {
      if (kit.isInspectorNode(record.target)) continue;
      const nodes = [
        ...Array.from(record.addedNodes).slice(0, 8),
        ...Array.from(record.removedNodes).slice(0, 8),
      ];
      if (nodes.length > 0 && nodes.every((node) => kit.isInspectorNode(node))) continue;
      return false;
    }
    return true;
  };
  let observer: MutationObserver | null = null;
  const Observer = (window as unknown as { MutationObserver?: typeof MutationObserver })
    .MutationObserver;
  if (typeof Observer === "function" && pins.length > 0) {
    observer = new Observer((records) => {
      if (destroyed || onlyInspector(records)) return;
      diagnostics.mutationBatches += 1;
      if (diagnostics.paused) return;
      dirty = true;
      if (hidden()) {
        diagnostics.throttledBatches += 1;
        return;
      }
      schedulePass();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }
  const onVisibility = (): void => {
    if (!hidden() && dirty) schedulePass();
  };

  if (pins.length > 0) {
    window.addEventListener("scroll", schedulePlace, true);
    window.addEventListener("resize", schedulePlace);
    document.addEventListener("visibilitychange", onVisibility);
  }
  const snapshotValue = () => ({
    revision,
    results: pins.map((pin) => pin.result),
    diagnostics: {
      ...diagnostics,
      byState: { ...diagnostics.byState },
      byRule: { ...diagnostics.byRule },
    },
  });
  const destroy = (): void => {
    destroyed = true;
    observer?.disconnect();
    if (timer !== null) clearTimeout(timer);
    window.removeEventListener("scroll", schedulePlace, true);
    window.removeEventListener("resize", schedulePlace);
    document.removeEventListener("visibilitychange", onVisibility);
    if (frame !== null) window.cancelAnimationFrame?.(frame);
    layer.remove();
    if (host[config.key] === runtime) delete host[config.key];
  };
  const encode = (): string => {
    const encoded = JSON.stringify(snapshotValue());
    return encoded.length <= config.maxChars
      ? encoded
      : JSON.stringify({ revision, results: [], diagnostics: snapshotValue().diagnostics });
  };
  const runtime = { destroy, snapshot: encode };
  host[config.key] = runtime;
  if (pins.length === 0) layer.remove();
  return encode();
}

export function browserPreviewPinsShowScript(config: {
  queries: BrowserPreviewPinsScriptQuery[];
  focusedAnnotationId: string | null;
  scrollIntoView: boolean;
  limits?: Partial<BrowserPreviewPinsScriptLimits>;
}): string {
  const payload = {
    key: BROWSER_PREVIEW_PINS_KEY,
    maxChars: BROWSER_PREVIEW_PINS_MAX_CHARS,
    queries: config.queries,
    focusedAnnotationId: config.focusedAnnotationId,
    scrollIntoView: config.scrollIntoView,
    limits: { ...BROWSER_PREVIEW_PINS_DEFAULT_LIMITS, ...config.limits },
  };
  return `/*orkestrator:pins-show*/(${installBrowserPreviewPins.toString()})(${browserPreviewAnchorKit.toString()}, ${JSON.stringify(payload)});`;
}

/** Current results and counters of the installed layer, or null. */
export const BROWSER_PREVIEW_PINS_SNAPSHOT_SCRIPT = `/*orkestrator:pins-snapshot*/(() => {
  try {
    const runtime = window.${BROWSER_PREVIEW_PINS_KEY};
    return runtime && typeof runtime.snapshot === "function" ? runtime.snapshot() : null;
  } catch {
    return null;
  }
})();`;

export const BROWSER_PREVIEW_PINS_CLEAR_SCRIPT = `/*orkestrator:pins-clear*/(() => {
  try {
    window.${BROWSER_PREVIEW_PINS_KEY}?.destroy?.();
  } catch {}
})();`;
