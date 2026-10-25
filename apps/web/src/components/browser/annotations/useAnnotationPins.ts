/**
 * Live pins and "Show on page" for one browser tab (see "Anchors and pins" in
 * docs/architecture/web-page-annotations.md).
 *
 * Pins are drawn for at most `visiblePins` open notes of the current logical
 * page. Main clears them for every new document and emits
 * `pins-invalidated`, so they are re-sent after a reload (including a
 * same-URL reload); `pins-changed` means mutation-driven re-resolution moved
 * results, which are read back with `getPinResults`. Show on page uses the
 * desktop's bounded navigate → wait → resolve → scroll flow when available.
 * Every result carries the document generation it was resolved against, and
 * only results of the tab's newest document are kept.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  BROWSER_PREVIEW_CAPTURE_EVENT,
  type BrowserPreviewAnchorQuery,
  type BrowserPreviewAnchorResult,
  type BrowserPreviewCaptureEvent,
} from "@orkestrator/protocol/browser-preview";
import {
  WEB_ANNOTATION_LIMITS,
  type WebAnnotation,
  type WebAnnotationAnchorResolution,
  type WebAnnotationCapture,
  type WebAnnotationSummary,
} from "@orkestrator/protocol/web-annotations";
import { getBrowserPreviewCaptureApi } from "@/lib/native/browser-preview";
import { loadWebAnnotationCapture } from "@/lib/web-annotations/assets";
import { describeWebAnnotationError } from "@/lib/web-annotations/client";
import { anchorStateLabel, samePage, sameService, type CurrentAnnotationPage } from "./format";
import type { ShowOnPageResult } from "./panel-context";

const PIN_CAPTURE_CONCURRENCY = 4;
const SHOW_ON_PAGE_TIMEOUT_MS = 10_000;

async function mapBounded<T, R>(items: T[], limit: number, map: (item: T) => Promise<R>) {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await map(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/** One pin query, carrying the capture geometry region notes need. */
export function pinQuery(
  annotation: Pick<WebAnnotation, "id" | "page">,
  number: number,
  capture: WebAnnotationCapture,
): BrowserPreviewAnchorQuery | null {
  if (capture.target.kind === "legacy-unresolved") return null;
  return {
    annotationId: annotation.id,
    number,
    target: capture.target,
    route: annotation.page.route,
    ...(capture.geometry
      ? {
          capture: {
            documentGeneration: capture.documentGeneration,
            viewport: {
              width: capture.geometry.viewport.width,
              height: capture.geometry.viewport.height,
            },
          },
        }
      : {}),
  };
}

function resultMap(results: readonly BrowserPreviewAnchorResult[]) {
  return new Map(results.map((result) => [result.annotationId, result.resolution] as const));
}

/** Newest document generation among `results`, or null when none carries one. */
export function newestGeneration(results: Iterable<WebAnnotationAnchorResolution>): number | null {
  let newest: number | null = null;
  for (const resolution of results) {
    const generation = resolution.documentGeneration;
    if (typeof generation === "number" && (newest === null || generation > newest)) {
      newest = generation;
    }
  }
  return newest;
}

/**
 * Only the results resolved against the tab's current document. Main counts
 * documents per preview view, so a result from an older generation describes
 * a page that is no longer shown (Show on page navigated, the page reloaded);
 * it is dropped rather than left on screen. A result without a generation
 * (older desktop builds) is kept, and so is everything while the current
 * generation is unknown.
 */
export function currentDocumentResults(
  results: ReadonlyMap<string, WebAnnotationAnchorResolution>,
  generation: number | null,
): ReadonlyMap<string, WebAnnotationAnchorResolution> {
  if (generation === null) return results;
  let stale = false;
  for (const resolution of results.values()) {
    if (resolution.documentGeneration !== null && resolution.documentGeneration !== generation) {
      stale = true;
      break;
    }
  }
  if (!stale) return results;
  return new Map(
    Array.from(results).filter(
      ([, resolution]) =>
        resolution.documentGeneration === null || resolution.documentGeneration === generation,
    ),
  );
}

export function useAnnotationPins({
  tabId,
  environmentId,
  items,
  wanted,
  selectedId,
  currentPage,
  previewAttached,
}: {
  tabId: string;
  environmentId: string;
  items: WebAnnotationSummary[];
  wanted: boolean;
  selectedId: string | null;
  currentPage: CurrentAnnotationPage | null;
  previewAttached: boolean;
}) {
  const [pinResults, setPinResults] = useState<ReadonlyMap<string, WebAnnotationAnchorResolution>>(
    new Map(),
  );
  // Newest document generation main reported for this tab's view. It only
  // moves forward within one view (events and replies can arrive in either
  // order), and starts again when the tab or its attached view changes.
  const generationRef = useRef<number | null>(null);
  const viewRef = useRef({});
  useEffect(() => {
    const view = {};
    viewRef.current = view;
    return () => {
      if (viewRef.current === view) viewRef.current = {};
    };
  }, [tabId, previewAttached, wanted]);
  useEffect(() => {
    generationRef.current = null;
  }, [tabId, previewAttached]);
  const noteGeneration = useCallback((generation: number | null | undefined) => {
    if (typeof generation !== "number") return;
    if (generationRef.current === null || generation > generationRef.current) {
      generationRef.current = generation;
    }
  }, []);
  /** Apply results, keeping only those of the current document. */
  const applyResults = useCallback(
    (
      update: (
        current: ReadonlyMap<string, WebAnnotationAnchorResolution>,
      ) => ReadonlyMap<string, WebAnnotationAnchorResolution>,
      view = viewRef.current,
      snapshotGeneration?: number | null,
    ) => {
      setPinResults((current) => {
        if (view !== viewRef.current) return current;
        const next = update(current);
        const generation = snapshotGeneration ?? newestGeneration(next.values());
        if (
          generation !== null &&
          generationRef.current !== null &&
          generation < generationRef.current
        )
          return current;
        noteGeneration(generation);
        return currentDocumentResults(next, generationRef.current);
      });
    },
    [noteGeneration],
  );
  const lastPinsRef = useRef<BrowserPreviewAnchorQuery[]>([]);
  const wantedRef = useRef(wanted);
  const selectedRef = useRef(selectedId);
  const itemsRef = useRef(items);
  useLayoutEffect(() => {
    wantedRef.current = wanted;
    selectedRef.current = selectedId;
    itemsRef.current = items;
  });
  const pinKey = items
    .map((item) => `${item.id}:${item.currentCaptureId}:${item.state}:${item.hidden ? 1 : 0}`)
    .join("|");
  // While pins are not wanted the effect below clears them from the page each
  // time it reruns; their results are dropped at the same points, while
  // rendering.
  const unwantedKey = wanted
    ? null
    : JSON.stringify([tabId, environmentId, currentPage?.pageKey ?? null, pinKey, selectedId]);
  const [clearedFor, setClearedFor] = useState(unwantedKey);
  if (unwantedKey !== clearedFor) {
    setClearedFor(unwantedKey);
    if (unwantedKey !== null) setPinResults(new Map());
  }

  const buildPins = useCallback(async () => {
    const visible = itemsRef.current
      .filter((item) => item.state === "open" && !item.hidden)
      .slice(0, WEB_ANNOTATION_LIMITS.visiblePins);
    const captures = await mapBounded(visible, PIN_CAPTURE_CONCURRENCY, (item) =>
      loadWebAnnotationCapture(environmentId, item.currentCaptureId),
    );
    const pins: BrowserPreviewAnchorQuery[] = [];
    visible.forEach((item, index) => {
      const capture = captures[index];
      const pin = capture ? pinQuery(item, index + 1, capture) : null;
      if (pin) pins.push(pin);
    });
    return pins;
  }, [environmentId]);

  const send = useCallback(
    async (pins: BrowserPreviewAnchorQuery[]) => {
      const api = getBrowserPreviewCaptureApi();
      if (!api) return;
      const view = viewRef.current;
      const generation = generationRef.current;
      lastPinsRef.current = pins;
      const results = await api.showPins({
        tabId,
        pins,
        focusedAnnotationId: selectedRef.current,
      });
      if (wantedRef.current)
        applyResults(
          () => resultMap(results ?? []),
          view,
          newestGeneration((results ?? []).map((entry) => entry.resolution)) ?? generation,
        );
    },
    [applyResults, tabId],
  );

  useEffect(() => {
    const api = getBrowserPreviewCaptureApi();
    if (!api) return;
    if (!wanted) {
      lastPinsRef.current = [];
      void api.clearPins(tabId).catch(() => undefined);
      return;
    }
    let cancelled = false;
    void buildPins()
      .then((pins) => {
        if (!cancelled) return send(pins);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // `pinKey` and the page key rerun this after navigation or list changes.
  }, [buildPins, currentPage?.pageKey, pinKey, selectedId, send, tabId, wanted]);

  // Main clears pins for every new document (reload, navigation, hot reload)
  // and says so; results that move afterwards are read back on request.
  useEffect(() => {
    const listen = window.orkestrator?.listen;
    if (typeof listen !== "function") return;
    return listen<BrowserPreviewCaptureEvent>(BROWSER_PREVIEW_CAPTURE_EVENT, (event) => {
      if (!event || event.tabId !== tabId || !wantedRef.current) return;
      const api = getBrowserPreviewCaptureApi();
      if (!api) return;
      if (event.status === "pins-invalidated") {
        // A new document: the previous page's results go now, not when the
        // re-sent pins come back.
        noteGeneration(event.documentGeneration);
        applyResults((current) => currentDocumentResults(current, generationRef.current));
        void send(lastPinsRef.current).catch(() => undefined);
      } else if (event.status === "pins-changed" && api.getPinResults) {
        noteGeneration(event.documentGeneration);
        const view = viewRef.current;
        void api
          .getPinResults(tabId)
          .then((snapshot) => {
            if (!snapshot || !wantedRef.current) return;
            applyResults(() => resultMap(snapshot.results), view, snapshot.documentGeneration);
          })
          .catch(() => undefined);
      }
    });
  }, [applyResults, noteGeneration, send, tabId]);

  useEffect(
    () => () => {
      void getBrowserPreviewCaptureApi()
        ?.clearPins(tabId)
        .catch(() => undefined);
    },
    [tabId],
  );

  const showOnPage = useCallback(
    async (
      annotation: WebAnnotation,
      options: { navigate?: boolean } = {},
    ): Promise<ShowOnPageResult> => {
      const api = getBrowserPreviewCaptureApi();
      const onThisPage = samePage(annotation.page, currentPage);
      const canNavigate =
        Boolean(api?.showOnPage) && previewAttached && sameService(annotation.page, currentPage);
      // Another page: offer explicit navigation (works without pins too).
      if (!onThisPage && !(options.navigate && canNavigate)) {
        return { status: "off-page", route: annotation.page.route };
      }
      if (!api || !previewAttached) {
        return {
          status: "unavailable",
          reason: "Showing notes on the page needs the Orkestrator desktop preview.",
        };
      }
      const view = viewRef.current;
      const record = await loadWebAnnotationCapture(environmentId, annotation.currentCaptureId);
      const pin = record ? pinQuery(annotation, 1, record) : null;
      if (!record || !pin) {
        return { status: "not-found", reason: "this imported note has no live target" };
      }
      const others = lastPinsRef.current
        .filter((candidate) => candidate.annotationId !== annotation.id)
        .slice(0, WEB_ANNOTATION_LIMITS.visiblePins - 1);
      const number =
        lastPinsRef.current.find((candidate) => candidate.annotationId === annotation.id)?.number ??
        others.length + 1;
      try {
        if (api.showOnPage) {
          if (annotation.page.requiresNavigation && !onThisPage) {
            return {
              status: "navigation-required",
              reason: "Private parts of this page's address were removed when it was saved.",
            };
          }
          const result = await api.showOnPage({
            tabId,
            pin: { ...pin, number },
            pins: others,
            timeoutMs: SHOW_ON_PAGE_TIMEOUT_MS,
          });
          // After a navigation this is the destination document: results
          // for the page that was left are dropped with it.
          applyResults(
            (current) => new Map(current).set(annotation.id, result.resolution),
            view,
            result.documentGeneration,
          );
          switch (result.outcome) {
            case "shown":
              return { status: "shown", navigated: result.navigated };
            case "not-found":
              return {
                status: "not-found",
                reason: anchorStateLabel(result.resolution),
                resolution: result.resolution,
              };
            case "navigation-required":
              return {
                status: "navigation-required",
                reason: "The preview cannot open this page's saved address.",
              };
            case "timeout":
              return { status: "timeout" };
            case "navigation-failed":
              return {
                status: "navigation-failed",
                reason: "The page could not be opened in this preview.",
              };
          }
        }
        const pins = [...others, { ...pin, number }];
        lastPinsRef.current = pins;
        const results = await api.showPins({
          tabId,
          pins,
          focusedAnnotationId: annotation.id,
          scrollIntoView: true,
        });
        const resolution = results.find((item) => item.annotationId === annotation.id)?.resolution;
        if (!resolution) return { status: "not-found", reason: "no match" };
        applyResults(() => resultMap(results), view);
        if (resolution.offPage) return { status: "off-page", route: annotation.page.route };
        if (resolution.state === "matched" && !resolution.historical) return { status: "shown" };
        return { status: "not-found", reason: anchorStateLabel(resolution), resolution };
      } catch (error) {
        return {
          status: "unavailable",
          reason: `The preview could not show this note (${describeWebAnnotationError(error)}).`,
        };
      }
    },
    [applyResults, currentPage, environmentId, previewAttached, tabId],
  );

  return { pinResults, showOnPage };
}
