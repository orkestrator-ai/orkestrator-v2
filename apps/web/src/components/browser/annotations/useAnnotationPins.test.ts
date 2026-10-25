import { afterEach, beforeEach, describe, expect, test, mock } from "bun:test";
import {
  webAnnotationPageKey,
  type WebAnnotationAnchorResolution,
} from "@orkestrator/protocol/web-annotations";
import { act, cleanup, renderHook } from "@testing-library/react";
import { resetWebAnnotationAssetsForTests } from "@/lib/web-annotations/assets";
import {
  createFakeCaptureApi,
  FakeWebAnnotationBackend,
  installFakeOrkestrator,
  invokeMock,
} from "@/test/web-annotation-fakes";
import { currentDocumentResults, newestGeneration, useAnnotationPins } from "./useAnnotationPins";

function resolution(documentGeneration: number | null): WebAnnotationAnchorResolution {
  return { state: "matched", rule: "stable-id", candidateCount: 1, documentGeneration, rect: null };
}

describe("pin results by document generation", () => {
  test("results of an older document are dropped once a newer one is known", () => {
    const results = new Map([
      ["left-page", resolution(4)],
      ["current", resolution(5)],
      ["older-desktop", resolution(null)],
    ]);
    const current = currentDocumentResults(results, 5);
    expect(Array.from(current.keys())).toEqual(["current", "older-desktop"]);
  });

  test("nothing is dropped while the generation is unknown or every result is current", () => {
    const results = new Map([["a", resolution(2)]]);
    expect(currentDocumentResults(results, null)).toBe(results);
    expect(currentDocumentResults(results, 2)).toBe(results);
  });

  test("the newest generation is read from the results themselves", () => {
    expect(newestGeneration([resolution(3), resolution(null), resolution(7)])).toBe(7);
    expect(newestGeneration([resolution(null)])).toBeNull();
  });
});

describe("Show on page hook", () => {
  let backend: FakeWebAnnotationBackend;
  let capture: ReturnType<typeof createFakeCaptureApi>;
  let bus: ReturnType<typeof installFakeOrkestrator>;
  beforeEach(() => {
    resetWebAnnotationAssetsForTests();
    backend = new FakeWebAnnotationBackend("env-1").install();
    capture = createFakeCaptureApi();
    bus = installFakeOrkestrator({ capture: capture.api });
  });
  afterEach(() => {
    cleanup();
    bus.restore();
    resetWebAnnotationAssetsForTests();
    invokeMock.mockImplementation(() => Promise.resolve());
  });
  function setup() {
    const annotation = backend.seed();
    const hook = renderHook(() =>
      useAnnotationPins({
        tabId: "browser-1",
        environmentId: "env-1",
        items: [],
        wanted: false,
        selectedId: null,
        currentPage: {
          ...annotation.page,
          pageKey: webAnnotationPageKey(annotation.page),
          label: "Settings",
        },
        previewAttached: true,
      }),
    );
    return { annotation, ...hook };
  }
  test("the desktop hidden outcome reaches the panel and records its resolution", async () => {
    const hidden = { ...resolution(2), rect: null };
    capture.api.showOnPage = async () => ({
      outcome: "hidden",
      navigated: false,
      documentGeneration: 2,
      resolution: hidden,
    });
    const { result, annotation } = setup();
    await act(async () =>
      expect(await result.current.showOnPage(annotation)).toEqual({ status: "hidden" }),
    );
    expect(result.current.pinResults.get(annotation.id)).toEqual(hidden);
  });
  for (const [name, resolved, status] of [
    ["visible", { ...resolution(1), rect: { x: 1, y: 2, width: 30, height: 20 } }, "shown"],
    ["null rect", resolution(1), "hidden"],
    ["zero rect", { ...resolution(1), rect: { x: 0, y: 0, width: 0, height: 0 } }, "hidden"],
    ["historical", { ...resolution(1), historical: true }, "not-found"],
    ["missing", { ...resolution(1), state: "missing" }, "not-found"],
    ["off page", { ...resolution(1), offPage: true }, "off-page"],
  ] as const) {
    test(`showPins fallback maps ${name} to ${status}`, async () => {
      const { result, annotation } = setup();
      capture.api.showPins = mock(async () => [
        { annotationId: annotation.id, resolution: resolved as WebAnnotationAnchorResolution },
      ]);
      await act(async () =>
        expect(await result.current.showOnPage(annotation)).toMatchObject({ status }),
      );
      expect(capture.api.showPins).toHaveBeenCalledTimes(1);
    });
  }
});
