import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import type {
  WebAnnotationComparisonMetadata,
  WebAnnotationResult,
} from "@orkestrator/protocol/web-annotations";
import type {
  WebAnnotationResultDiff,
  WebAnnotationResultDiffCompared,
} from "@orkestrator/protocol/web-annotations-diff";
import {
  FIXTURE_TIME,
  fixtureCapture,
  fixtureRequest,
} from "@orkestrator/protocol/testing/web-annotations-fixtures";
import { resetWebAnnotationAssetsForTests } from "@/lib/web-annotations/assets";
import { resetWebAnnotationSyncForTests } from "@/lib/web-annotations/sync";
import {
  createFakeCaptureApi,
  FakeWebAnnotationBackend,
  fixtureCapabilities,
  installFakeOrkestrator,
  invokeMock,
} from "@/test/web-annotation-fakes";
import {
  AnnotationHarness,
  seedBrowserLayout,
  useAnnotationUiTestBudget,
} from "@/test/web-annotation-harness";
import { resultDiffSummary } from "./ResultDiff";

let backend: FakeWebAnnotationBackend;
let bus: ReturnType<typeof installFakeOrkestrator>;

const COMPARISON: WebAnnotationComparisonMetadata = {
  contentRevision: 1,
  captureRevision: 1,
  comparedCaptureId: "capture-element",
  targetMatch: "same-target",
  differences: [],
  zoomFactor: 1,
  deviceScaleFactor: 2,
  scroll: { x: 0, y: 120 },
  stability: "stable",
  masks: [],
  unstableRegions: [],
};

const COMPARED: WebAnnotationResultDiffCompared = {
  status: "compared",
  advisory: true,
  beforeCaptureId: "capture-element",
  afterCaptureId: "after-1",
  image: { width: 1280, height: 800 },
  scale: 1,
  changedPixels: 2_048,
  comparedPixels: 1_000_000,
  excludedPixels: 24_000,
  changedRatio: 0.002,
  regions: [
    {
      rect: { x: 640, y: 480, width: 64, height: 32 },
      cssRect: { x: 640, y: 480, width: 64, height: 32 },
      changedPixels: 2_048,
    },
  ],
  truncatedRegions: false,
  excluded: { masks: 1, unstableRegions: 2 },
  tolerance: 24,
};

function result(): WebAnnotationResult {
  return {
    id: "result-1",
    requestId: "request-awaiting-review",
    bodyHash: "0",
    revision: 1,
    provenance: "user-capture",
    provisional: false,
    outcomes: [],
    summary: "No agent report yet; the page was captured by the user.",
    files: [],
    checks: [],
    evidenceAssetIds: [],
    captureIds: ["after-1"],
    limitations: [],
    questions: [],
    supersedes: null,
    createdAt: FIXTURE_TIME,
    reportedRevision: null,
    observations: [
      {
        captureId: "after-1",
        annotationId: "annotation-1",
        capturedAt: FIXTURE_TIME,
        provenance: "app-observed",
        assetIds: [],
        comparison: COMPARISON,
      },
    ],
  };
}

function seed() {
  const request = fixtureRequest("awaiting-review", { resultIds: ["result-1"] });
  backend.requests.set(request.id, request);
  backend.results.set("result-1", result());
  backend.seed({
    id: "annotation-1",
    currentCaptureId: "capture-element",
    requestIds: [request.id],
  });
  backend.assets.set("after-image", "iVBORw0KGgo=");
  backend.captures.set(
    "after-1",
    fixtureCapture("page", {
      id: "after-1",
      annotationId: "annotation-1",
      comparison: COMPARISON,
      assetIds: ["after-image"],
    }),
  );
  seedBrowserLayout({ open: true, selectedAnnotationId: "annotation-1" });
}

const diffCalls = () =>
  backend.calls.filter((call) => call.command === "web_annotation_result_diff");

describe("advisory result diff", () => {
  useAnnotationUiTestBudget();
  beforeEach(() => {
    resetWebAnnotationSyncForTests();
    resetWebAnnotationAssetsForTests();
    window.localStorage.clear();
    bus = installFakeOrkestrator({ capture: createFakeCaptureApi().api });
    backend = new FakeWebAnnotationBackend("env-1").install();
  });
  afterEach(() => {
    cleanup();
    resetWebAnnotationSyncForTests();
    bus.restore();
    invokeMock.mockImplementation(() => Promise.resolve());
  });

  test("is not offered by a backend that does not advertise it", async () => {
    seed();
    renderInAppCommandScope(<AnnotationHarness />);
    const observed = await screen.findByRole("region", { name: "Observed by Orkestrator" });
    await waitFor(() =>
      expect(observed.querySelector('[data-comparison="after-1"]')).not.toBeNull(),
    );
    expect(within(observed).queryByRole("button", { name: /Show what changed/ }) === null).toBe(
      true,
    );
    expect(diffCalls()).toEqual([]);
  });

  test("shows the changed regions on request, labelled advisory", async () => {
    backend.capabilities = fixtureCapabilities({ resultDiffs: true });
    backend.overrides.set("web_annotation_result_diff", () => ({ diff: COMPARED }));
    seed();
    renderInAppCommandScope(<AnnotationHarness />);
    const button = await screen.findByRole("button", { name: "Show what changed (advisory)" });
    // Nothing is computed until the user asks.
    expect(diffCalls()).toEqual([]);
    fireEvent.click(button);
    const panel = await screen.findByRole("region", { name: "Advisory diff" });
    expect(diffCalls().map((call) => call.args)).toEqual([
      { environmentId: "env-1", captureId: "after-1" },
    ]);
    expect(panel.dataset.diffState).toBe("compared");
    expect(within(panel).getByText("Advisory diff — evidence, not a pass or fail")).toBeTruthy();
    expect(within(panel).getByText("1 changed region, 0.2% of the compared area.")).toBeTruthy();
    expect(within(panel).getByText("Left out: 1 redaction and 2 moving regions.")).toBeTruthy();
    expect(within(panel).getByText(/only you resolve the note/)).toBeTruthy();
    const overlay = await within(panel).findByRole("img", { name: /1 changed region outlined/ });
    expect(overlay.getAttribute("viewBox")).toBe("0 0 1280 800");
    expect(overlay.querySelector("image")?.getAttribute("href")).toBeTruthy();
    const region = overlay.querySelector("[data-diff-region]")!;
    expect(["x", "y", "width", "height"].map((key) => region.getAttribute(key))).toEqual([
      "640",
      "480",
      "64",
      "32",
    ]);
  });

  test("explains why captures cannot be compared instead of showing a diff", async () => {
    backend.capabilities = fixtureCapabilities({ resultDiffs: true });
    const refused: WebAnnotationResultDiff = {
      status: "incomparable",
      advisory: true,
      beforeCaptureId: "capture-element",
      afterCaptureId: "after-1",
      reasons: [
        { code: "viewport", message: "The captures were taken at different viewport sizes." },
        {
          code: "no-unstable-mask",
          message:
            "The after-capture has no unstable-region mask (it was taken without sampling for animation).",
        },
      ],
    };
    backend.overrides.set("web_annotation_result_diff", () => ({ diff: refused }));
    seed();
    renderInAppCommandScope(<AnnotationHarness />);
    fireEvent.click(await screen.findByRole("button", { name: "Show what changed (advisory)" }));
    const panel = await screen.findByRole("region", { name: "Advisory diff" });
    expect(panel.dataset.diffState).toBe("incomparable");
    expect(within(panel).getByText("Advisory diff — not available")).toBeTruthy();
    expect(
      within(panel).getByText("The captures were taken at different viewport sizes."),
    ).toBeTruthy();
    expect(within(panel).getByText(/no unstable-region mask/)).toBeTruthy();
    expect(within(panel).queryByText(/changed region/) === null).toBe(true);
  });

  test.each(["busy", "timeout"] as const)("retries a %s result on the same card", async (code) => {
    backend.capabilities = fixtureCapabilities({ resultDiffs: true });
    let calls = 0;
    const refusal: WebAnnotationResultDiff = {
      status: "incomparable",
      advisory: true,
      beforeCaptureId: "capture-element",
      afterCaptureId: "after-1",
      reasons: [{ code, message: "Try again shortly." }],
    };
    backend.overrides.set("web_annotation_result_diff", () => ({
      diff: ++calls === 1 ? refusal : COMPARED,
    }));
    seed();
    renderInAppCommandScope(<AnnotationHarness />);
    fireEvent.click(await screen.findByRole("button", { name: "Show what changed (advisory)" }));
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("1 changed region, 0.2% of the compared area.")).toBeTruthy();
    expect(diffCalls()).toHaveLength(2);
  });

  test("a failed request can be retried", async () => {
    backend.capabilities = fixtureCapabilities({ resultDiffs: true });
    backend.fail("web_annotation_result_diff", new Error("Backend went away"));
    backend.overrides.set("web_annotation_result_diff", () => ({ diff: COMPARED }));
    seed();
    renderInAppCommandScope(<AnnotationHarness />);
    fireEvent.click(await screen.findByRole("button", { name: "Show what changed (advisory)" }));
    expect(await screen.findByText(/The advisory diff could not be computed/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("region", { name: "Advisory diff" })).toBeTruthy();
  });
});

describe("resultDiffSummary", () => {
  test("never phrases the measurement as a pass or a fail", () => {
    expect(resultDiffSummary({ ...COMPARED, changedPixels: 0, changedRatio: 0, regions: [] })).toBe(
      "No pixel changes were found in the compared area. That does not show the request was met.",
    );
    expect(resultDiffSummary({ ...COMPARED, changedRatio: 0.00001 })).toBe(
      "1 changed region, less than 0.1% of the compared area.",
    );
    expect(
      resultDiffSummary({
        ...COMPARED,
        changedRatio: 0.25,
        truncatedRegions: true,
        regions: [COMPARED.regions[0]!, COMPARED.regions[0]!],
      }),
    ).toBe("2+ changed regions, 25% of the compared area.");
  });
});
