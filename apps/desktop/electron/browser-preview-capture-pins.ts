/**
 * Live annotation pins in Electron main.
 *
 * Main decides what may be resolved at all (route, scope, target kind), runs
 * the bounded page resolver, and revalidates every result. While pins are
 * shown, a low-frequency poll of visible previews reads the page layer's
 * change revision (the layer itself re-resolves after DOM mutations on a
 * throttled schedule) and forwards a content-free `pins-changed` hint. A new
 * document clears pins and emits `pins-invalidated` once the document is ready,
 * so the renderer re-sends them. `showOnPage` navigates, waits for the
 * document, resolves, and scrolls the target into view, all bounded.
 */
import type {
  BrowserPreviewAnchorQuery,
  BrowserPreviewAnchorResult,
  BrowserPreviewCaptureEvent,
  BrowserPreviewPinDiagnostics,
  BrowserPreviewPinSnapshot,
  BrowserPreviewPinsInput,
  BrowserPreviewShowOnPageInput,
  BrowserPreviewShowOnPageResult,
} from "@orkestrator/protocol/browser-preview";
import type {
  WebAnnotationAnchorResolution,
  WebAnnotationRect,
} from "@orkestrator/protocol/web-annotations";
import { isWebAnnotationRect } from "@orkestrator/protocol/web-annotations-validation";
import {
  browserPreviewPageIdentity,
  browserPreviewRouteUrl,
  isRecord,
  parseJson,
  runInPage,
  sameBrowserPreviewRoute,
  type CapturePreviewHandle,
} from "./browser-preview-capture-page.js";
import { pickRect } from "./browser-preview-capture-parse.js";
import { captureTabId, pinsInput, showOnPageInput } from "./browser-preview-capture-validation.js";
import {
  BROWSER_PREVIEW_PINS_CLEAR_SCRIPT,
  BROWSER_PREVIEW_PINS_MAX_CHARS,
  BROWSER_PREVIEW_PINS_SNAPSHOT_SCRIPT,
  browserPreviewPinsShowScript,
  type BrowserPreviewPinsScriptLimits,
} from "./browser-preview-pins-script.js";

const PAGE_RULES = new Set([
  "stable-id",
  "semantic-context",
  "structural-path",
  "text-quote",
  "none",
]);
const PAGE_STATES = new Set([
  "matched",
  "missing",
  "ambiguous",
  "stale",
  "unsupported",
  "too-complex",
]);
const DEFAULT_LIVE_POLL_MS = 1_000;
const SHOW_ON_PAGE_DEFAULT_TIMEOUT_MS = 10_000;
const SHOW_ON_PAGE_RETRY_MS = 300;

export interface BrowserPreviewPinSessionsOptions {
  preview: (tabId: string) => CapturePreviewHandle | null;
  emit?: (event: BrowserPreviewCaptureEvent) => void;
  /** Live result polling for visible pinned previews; 0 disables the timer. */
  livePollIntervalMs?: number;
  /** Page-side throttle and budgets (tests shorten them). */
  pageLimits?: Partial<BrowserPreviewPinsScriptLimits>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface PinnedTab {
  generation: number;
  queries: BrowserPreviewAnchorQuery[];
  /** Host-decided results (route mismatch, unsupported kinds); never sent to the page. */
  hostResults: Map<string, WebAnnotationAnchorResolution>;
  pageResults: Map<string, WebAnnotationAnchorResolution>;
  pageRevision: number;
  revision: number;
  diagnostics: BrowserPreviewPinDiagnostics | null;
  polling: boolean;
}

function counts(value: unknown, keys: Set<string>): Record<string, number> | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > keys.size) return null;
  const result: Record<string, number> = {};
  for (const [key, entry] of entries) {
    if (!keys.has(key) || typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 0) {
      return null;
    }
    result[key] = Math.min(entry, 1_000_000);
  }
  return result;
}

function parseDiagnostics(value: unknown): BrowserPreviewPinDiagnostics | null {
  if (!isRecord(value)) return null;
  const numbers = ["pins", "passes", "mutationBatches", "throttledBatches", "budgetExhausted"];
  if (
    !numbers.every(
      (key) =>
        typeof value[key] === "number" && Number.isSafeInteger(value[key]) && value[key] >= 0,
    ) ||
    typeof value.paused !== "boolean"
  ) {
    return null;
  }
  const byState = counts(value.byState, PAGE_STATES);
  const byRule = counts(value.byRule, PAGE_RULES);
  if (!byState || !byRule) return null;
  const bounded = (key: string) => Math.min(value[key] as number, 1_000_000_000);
  return {
    pins: bounded("pins"),
    byState,
    byRule,
    passes: bounded("passes"),
    mutationBatches: bounded("mutationBatches"),
    throttledBatches: bounded("throttledBatches"),
    budgetExhausted: bounded("budgetExhausted"),
    paused: value.paused,
  };
}

/** Parse the page layer's JSON; accepts the legacy bare-array form too. */
export function parsePinsOutput(
  encoded: unknown,
  ids: ReadonlySet<string>,
  generation: number,
): {
  revision: number;
  results: Map<string, WebAnnotationAnchorResolution>;
  diagnostics: BrowserPreviewPinDiagnostics | null;
} | null {
  const parsed = parseJson(encoded, BROWSER_PREVIEW_PINS_MAX_CHARS);
  const list = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.results)
      ? parsed.results
      : null;
  if (!list) return null;
  const revision =
    isRecord(parsed) && typeof parsed.revision === "number" && Number.isSafeInteger(parsed.revision)
      ? parsed.revision
      : 0;
  const results = new Map<string, WebAnnotationAnchorResolution>();
  for (const entry of list.slice(0, ids.size)) {
    if (!isRecord(entry) || typeof entry.annotationId !== "string" || !ids.has(entry.annotationId))
      continue;
    if (results.has(entry.annotationId)) continue;
    const { state, rule, candidateCount } = entry;
    const rect = entry.rect === null ? null : pickRect(entry.rect);
    if (
      typeof state !== "string" ||
      !PAGE_STATES.has(state) ||
      typeof rule !== "string" ||
      !PAGE_RULES.has(rule) ||
      typeof candidateCount !== "number" ||
      !Number.isSafeInteger(candidateCount) ||
      candidateCount < 0 ||
      candidateCount > 1_000_000 ||
      (state === "matched") !== (rect !== null) ||
      (rect !== null && !isWebAnnotationRect(rect))
    ) {
      continue;
    }
    results.set(entry.annotationId, {
      state: state as WebAnnotationAnchorResolution["state"],
      rule: rule as WebAnnotationAnchorResolution["rule"],
      candidateCount,
      documentGeneration: generation,
      rect: rect as WebAnnotationRect | null,
    });
  }
  return {
    revision,
    results,
    diagnostics: isRecord(parsed) ? parseDiagnostics(parsed.diagnostics) : null,
  };
}

function targetLabel(query: BrowserPreviewAnchorQuery): string {
  return query.target.label.slice(0, 200);
}

export class BrowserPreviewPinSessions {
  private readonly tabs = new Map<string, PinnedTab>();
  /** Tabs whose pins were cleared by a document change and not yet re-requested. */
  private readonly invalidated = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly options: BrowserPreviewPinSessionsOptions) {
    this.sleep =
      options.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          const timer = setTimeout(resolve, ms);
          (timer as { unref?: () => void }).unref?.();
        }));
    this.now = options.now ?? Date.now;
  }

  private emit(event: BrowserPreviewCaptureEvent): void {
    try {
      this.options.emit?.(event);
    } catch {
      // Hints only; snapshots stay authoritative.
    }
  }

  private handle(tabId: string): CapturePreviewHandle {
    const handle = this.options.preview(tabId);
    if (!handle) throw new Error(`Browser preview ${tabId} is not attached`);
    return handle;
  }

  private resolution(
    generation: number,
    state: WebAnnotationAnchorResolution["state"],
    rule: WebAnnotationAnchorResolution["rule"],
    extra: Partial<WebAnnotationAnchorResolution> = {},
  ): WebAnnotationAnchorResolution {
    return { state, rule, candidateCount: 0, documentGeneration: generation, rect: null, ...extra };
  }

  /** Current view width in CSS pixels, when the host can tell. */
  private viewportWidth(handle: CapturePreviewHandle): number | null {
    const size = handle.viewSize?.();
    if (!size || !(size.width > 0)) return null;
    const zoom = handle.contents.getZoomFactor?.() ?? 1;
    return size.width / (Number.isFinite(zoom) && zoom > 0 ? zoom : 1);
  }

  async showPins(value: BrowserPreviewPinsInput): Promise<BrowserPreviewAnchorResult[]> {
    const input = pinsInput(value);
    const handle = this.handle(input.tabId);
    const generation = handle.generation;
    const contents = handle.contents;
    const title = typeof contents.getTitle === "function" ? contents.getTitle() : "";
    const current = browserPreviewPageIdentity(
      contents.getURL(),
      title,
      handle.describeService,
    ).page;
    const hostResults = new Map<string, WebAnnotationAnchorResolution>();
    const queries: Array<{ annotationId: string; number: number; label: string; target: unknown }> =
      [];
    const width = this.viewportWidth(handle);
    for (const pin of input.pins) {
      const target = pin.target;
      const unaddressable =
        current.requiresNavigation && current.route === "/" && !current.displayUrl;
      if (target.kind === "region") {
        if (unaddressable) {
          hostResults.set(pin.annotationId, this.resolution(generation, "unsupported", "none"));
        } else if (!sameBrowserPreviewRoute(pin.route, current.route)) {
          hostResults.set(
            pin.annotationId,
            this.resolution(generation, "missing", "route-mismatch", { offPage: true }),
          );
        } else {
          // A region names captured pixels. Only the same document at the same
          // viewport width is still that layout; otherwise it is historical.
          const sameDocument = pin.capture?.documentGeneration === generation;
          const sameWidth =
            width !== null &&
            pin.capture !== undefined &&
            Math.abs(pin.capture.viewport.width - width) <= 1;
          const historical = !(sameDocument && sameWidth);
          hostResults.set(
            pin.annotationId,
            this.resolution(generation, historical ? "stale" : "unsupported", "none", {
              historical,
            }),
          );
        }
      } else if (target.kind !== "element" && target.kind !== "text-range") {
        // Page notes and legacy notes have no DOM identity to pin.
        hostResults.set(pin.annotationId, this.resolution(generation, "unsupported", "none"));
      } else if (unaddressable) {
        hostResults.set(pin.annotationId, this.resolution(generation, "unsupported", "none"));
      } else if (!sameBrowserPreviewRoute(pin.route, current.route)) {
        hostResults.set(
          pin.annotationId,
          this.resolution(generation, "missing", "route-mismatch", { offPage: true }),
        );
      } else {
        queries.push({
          annotationId: pin.annotationId,
          number: pin.number,
          label: targetLabel(pin),
          target:
            target.kind === "element"
              ? { kind: "element", anchor: target.anchor }
              : { kind: "text-range", quote: target.quote, container: target.container },
        });
      }
    }
    const tab: PinnedTab = {
      generation,
      queries: input.pins,
      hostResults,
      pageResults: new Map(),
      pageRevision: 0,
      revision: (this.tabs.get(input.tabId)?.revision ?? 0) + 1,
      diagnostics: null,
      polling: false,
    };
    this.invalidated.delete(input.tabId);
    if (queries.length === 0) {
      this.tabs.delete(input.tabId);
      await runInPage(contents, BROWSER_PREVIEW_PINS_CLEAR_SCRIPT).catch(() => undefined);
    } else {
      this.tabs.set(input.tabId, tab);
      const encoded = await runInPage(
        contents,
        browserPreviewPinsShowScript({
          queries,
          focusedAnnotationId: input.focusedAnnotationId ?? null,
          scrollIntoView: input.scrollIntoView === true,
          ...(this.options.pageLimits ? { limits: this.options.pageLimits } : {}),
        }),
      ).catch(() => null);
      const parsed = parsePinsOutput(
        encoded,
        new Set(queries.map((query) => query.annotationId)),
        generation,
      );
      if (parsed) {
        tab.pageResults = parsed.results;
        tab.pageRevision = parsed.revision;
        tab.diagnostics = parsed.diagnostics;
      }
      if (this.options.preview(input.tabId)?.generation !== generation) {
        // The document changed while resolving: nothing drawn can be trusted.
        if (this.tabs.get(input.tabId) === tab) this.tabs.delete(input.tabId);
        await runInPage(contents, BROWSER_PREVIEW_PINS_CLEAR_SCRIPT).catch(() => undefined);
        tab.pageResults.clear();
      } else {
        this.ensureTimer();
      }
    }
    return this.results(tab);
  }

  private results(tab: PinnedTab): BrowserPreviewAnchorResult[] {
    return tab.queries.map((pin) => ({
      annotationId: pin.annotationId,
      resolution:
        tab.hostResults.get(pin.annotationId) ??
        tab.pageResults.get(pin.annotationId) ??
        this.resolution(tab.generation, "unsupported", "none"),
    }));
  }

  /** Current live results, after reading the page layer's latest pass. */
  async getPinResults(tabId: string): Promise<BrowserPreviewPinSnapshot | null> {
    captureTabId(tabId);
    const tab = this.tabs.get(tabId);
    if (!tab) return null;
    await this.refresh(tabId, tab, false);
    if (this.tabs.get(tabId) !== tab) return null;
    return {
      tabId,
      documentGeneration: tab.generation,
      revision: tab.revision,
      results: this.results(tab),
      diagnostics: tab.diagnostics ? structuredClone(tab.diagnostics) : null,
    };
  }

  /** Read the page layer; emit `pins-changed` when its results moved on. */
  private async refresh(tabId: string, tab: PinnedTab, emit: boolean): Promise<void> {
    const handle = this.options.preview(tabId);
    if (!handle || handle.contents.isDestroyed() || handle.generation !== tab.generation) return;
    const encoded = await runInPage(handle.contents, BROWSER_PREVIEW_PINS_SNAPSHOT_SCRIPT).catch(
      () => null,
    );
    if (this.tabs.get(tabId) !== tab || this.options.preview(tabId)?.generation !== tab.generation)
      return;
    const ids = new Set(tab.pageResults.keys());
    for (const query of tab.queries)
      if (!tab.hostResults.has(query.annotationId)) ids.add(query.annotationId);
    const parsed = parsePinsOutput(encoded, ids, tab.generation);
    if (!parsed) return;
    tab.diagnostics = parsed.diagnostics ?? tab.diagnostics;
    if (parsed.revision === tab.pageRevision) return;
    tab.pageRevision = parsed.revision;
    tab.pageResults = parsed.results;
    tab.revision += 1;
    if (emit) {
      this.emit({
        tabId,
        captureId: null,
        status: "pins-changed",
        documentGeneration: tab.generation,
      });
    }
  }

  /** One live-poll round over visible pinned previews (exposed for tests). */
  async pollOnce(): Promise<void> {
    for (const [tabId, tab] of Array.from(this.tabs)) {
      if (tab.polling) continue;
      const handle = this.options.preview(tabId);
      // Hidden previews do no work; they refresh when shown or re-requested.
      if (!handle || !handle.visible) continue;
      tab.polling = true;
      try {
        await this.refresh(tabId, tab, true);
      } finally {
        tab.polling = false;
      }
    }
  }

  private ensureTimer(): void {
    const interval = this.options.livePollIntervalMs ?? DEFAULT_LIVE_POLL_MS;
    if (this.timer || interval <= 0) return;
    this.timer = setInterval(() => {
      if (this.tabs.size === 0) {
        this.stopTimer();
        return;
      }
      void this.pollOnce().catch(() => undefined);
    }, interval);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async clearPins(tabId: string): Promise<void> {
    captureTabId(tabId);
    this.tabs.delete(tabId);
    this.invalidated.delete(tabId);
    const handle = this.options.preview(tabId);
    if (!handle || handle.contents.isDestroyed()) return;
    await runInPage(handle.contents, BROWSER_PREVIEW_PINS_CLEAR_SCRIPT).catch(() => undefined);
  }

  /**
   * A new document (navigation, reload, in-page route change). Pins drawn for
   * the old document are cleared; the renderer is asked to re-send them once
   * the document is usable (immediately for in-page navigations).
   */
  onDocumentChanged(tabId: string, options: { loading: boolean }): void {
    if (!this.tabs.delete(tabId) && !this.invalidated.has(tabId)) return;
    const handle = this.options.preview(tabId);
    if (handle && !handle.contents.isDestroyed()) {
      void runInPage(handle.contents, BROWSER_PREVIEW_PINS_CLEAR_SCRIPT).catch(() => undefined);
    }
    const generation = handle?.generation ?? 0;
    if (options.loading) {
      this.invalidated.set(tabId, generation);
      return;
    }
    this.invalidated.delete(tabId);
    this.emit({
      tabId,
      captureId: null,
      status: "pins-invalidated",
      documentGeneration: generation,
    });
  }

  /** The main frame finished loading: ask for pins cleared by that navigation. */
  onDocumentReady(tabId: string): void {
    if (!this.invalidated.has(tabId)) return;
    this.invalidated.delete(tabId);
    const generation = this.options.preview(tabId)?.generation ?? 0;
    this.emit({
      tabId,
      captureId: null,
      status: "pins-invalidated",
      documentGeneration: generation,
    });
  }

  onRemoved(tabId: string): void {
    this.tabs.delete(tabId);
    this.invalidated.delete(tabId);
    if (this.tabs.size === 0) this.stopTimer();
  }

  dispose(): void {
    this.tabs.clear();
    this.invalidated.clear();
    this.stopTimer();
  }

  // -- Show on page -----------------------------------------------------------

  private async withDeadline<T>(work: Promise<T>, deadline: number): Promise<T | "timeout"> {
    const remaining = deadline - this.now();
    if (remaining <= 0) return "timeout";
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), remaining);
      (timer as { unref?: () => void }).unref?.();
    });
    const guarded = work.then(
      (value) => value,
      (error: unknown) => Promise.reject(error),
    );
    guarded.catch(() => undefined);
    try {
      return await Promise.race([guarded, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Navigate to the annotation's route when it differs, wait (bounded) for the
   * document, resolve the anchor, and scroll/highlight it. Never replays form
   * submissions or interactions; a route that main cannot address safely asks
   * the user to navigate instead.
   */
  async showOnPage(value: BrowserPreviewShowOnPageInput): Promise<BrowserPreviewShowOnPageResult> {
    const input = showOnPageInput(value);
    const started = this.now();
    const deadline = started + (input.timeoutMs ?? SHOW_ON_PAGE_DEFAULT_TIMEOUT_MS);
    let handle = this.handle(input.tabId);
    const outcome = (
      result: BrowserPreviewShowOnPageResult["outcome"],
      navigated: boolean,
      resolution?: WebAnnotationAnchorResolution,
    ): BrowserPreviewShowOnPageResult => {
      const generation = this.options.preview(input.tabId)?.generation ?? handle.generation;
      return {
        outcome: result,
        navigated,
        resolution: resolution ?? this.resolution(generation, "missing", "none"),
        documentGeneration: generation,
      };
    };
    const identity = () =>
      browserPreviewPageIdentity(
        handle.contents.getURL(),
        typeof handle.contents.getTitle === "function" ? handle.contents.getTitle() : "",
        handle.describeService,
      ).page;

    let navigated = false;
    if (!sameBrowserPreviewRoute(input.pin.route, identity().route)) {
      const url = browserPreviewRouteUrl(handle.contents.getURL(), input.pin.route);
      if (!url || !handle.navigate) return outcome("navigation-required", false);
      navigated = true;
      let result: unknown;
      try {
        result = await this.withDeadline(handle.navigate(url), deadline);
      } catch {
        return outcome("navigation-failed", true);
      }
      if (result === "timeout") return outcome("timeout", true);
      const next = this.options.preview(input.tabId);
      if (!next) return outcome("navigation-failed", true);
      handle = next;
      // A redirect elsewhere (for example an expired login) is not this page.
      if (!sameBrowserPreviewRoute(input.pin.route, identity().route)) {
        return outcome("navigation-required", true);
      }
    }
    // Wait for the main frame to finish loading, bounded.
    while (this.options.preview(input.tabId)?.loading) {
      if (this.now() >= deadline) return outcome("timeout", navigated);
      await this.sleep(SHOW_ON_PAGE_RETRY_MS);
    }

    let last: WebAnnotationAnchorResolution | null = null;
    for (;;) {
      const results = await this.showPins({
        tabId: input.tabId,
        pins: [input.pin, ...(input.pins ?? [])],
        focusedAnnotationId: input.pin.annotationId,
        scrollIntoView: true,
      });
      last =
        results.find((entry) => entry.annotationId === input.pin.annotationId)?.resolution ?? null;
      if (last?.state === "matched") return outcome("shown", navigated, last);
      // Late-rendering pages: only a missing target is worth waiting for.
      if (last && last.state !== "missing") return outcome("not-found", navigated, last);
      if (last?.rule === "route-mismatch") return outcome("navigation-required", navigated, last);
      if (this.now() + SHOW_ON_PAGE_RETRY_MS >= deadline) break;
      await this.sleep(SHOW_ON_PAGE_RETRY_MS);
    }
    return outcome("not-found", navigated, last ?? undefined);
  }
}
