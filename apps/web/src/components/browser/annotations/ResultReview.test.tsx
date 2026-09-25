import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import type {
  WebAnnotationComparisonMetadata,
  WebAnnotationResult,
} from "@orkestrator/protocol/web-annotations";
import {
  FIXTURE_TIME,
  fixtureCapture,
  fixtureRequest,
} from "@orkestrator/protocol/web-annotations-fixtures";
import { resetWebAnnotationAssetsForTests } from "@/lib/web-annotations/assets";
import { resetWebAnnotationSyncForTests } from "@/lib/web-annotations/sync";
import {
  createFakeCaptureApi,
  FakeWebAnnotationBackend,
  installFakeOrkestrator,
  invokeMock,
} from "@/test/web-annotation-fakes";
import {
  AnnotationHarness,
  seedBrowserLayout,
  useAnnotationUiTestBudget,
} from "@/test/web-annotation-harness";
import {
  captureConditionsLabel,
  citedEvidenceLabel,
  comparisonLabels,
  hasAgentReport,
} from "./result-labels";

let backend: FakeWebAnnotationBackend;
let bus: ReturnType<typeof installFakeOrkestrator>;

const COMPARISON: WebAnnotationComparisonMetadata = {
  contentRevision: 1,
  captureRevision: 1,
  comparedCaptureId: "capture-element",
  targetMatch: "different-target",
  differences: ["zoom", "unstable"],
  zoomFactor: 1.1,
  deviceScaleFactor: 2,
  scroll: { x: 0, y: 480 },
  stability: "unstable",
  masks: [{ source: "sensitive-field", rect: { x: 0, y: 0, width: 10, height: 10 } }],
};

function result(overrides: Partial<WebAnnotationResult> = {}): WebAnnotationResult {
  return {
    id: "result-1",
    requestId: "request-awaiting-review",
    bodyHash: "0",
    revision: 2,
    provenance: "user-capture",
    provisional: false,
    outcomes: [{ annotationId: "annotation-1", outcome: "addressed", note: "Padding is 16px" }],
    summary: "Increased the padding.",
    files: ["src/Button.tsx", "../outside.ts"],
    checks: [{ description: "Unit tests", outcome: "passed", provenance: "agent-reported" }],
    evidenceAssetIds: [],
    captureIds: ["after-1"],
    limitations: [],
    questions: [],
    supersedes: null,
    createdAt: FIXTURE_TIME,
    evidenceIds: ["capture-element"],
    reportedRevision: 1,
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
    fileChecks: [
      { path: "src/Button.tsx", status: "exists" },
      { path: "../outside.ts", status: "outside-workspace" },
    ],
    ...overrides,
  };
}

describe("result review", () => {
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

  test("agent-reported and app-observed evidence are shown in separate sections", async () => {
    const request = fixtureRequest("awaiting-review", { resultIds: ["result-1"] });
    backend.requests.set(request.id, request);
    backend.results.set("result-1", result());
    backend.seed({
      id: "annotation-1",
      currentCaptureId: "capture-element",
      requestIds: [request.id],
    });
    backend.captures.set(
      "after-1",
      fixtureCapture("page", { id: "after-1", annotationId: "annotation-1" }),
    );
    seedBrowserLayout({ open: true, selectedAnnotationId: "annotation-1" });
    render(<AnnotationHarness />);

    const report = await screen.findByRole("region", { name: "Agent report" });
    expect(within(report).getByText(/Reported by the agent \(report revision 1\)/)).toBeTruthy();
    expect(within(report).getByText("Agent reports: addressed")).toBeTruthy();
    expect(within(report).getByText("src/Button.tsx")).toBeTruthy();
    expect(within(report).getByText("The agent cites this note's capture.")).toBeTruthy();
    // Orkestrator's own file checks never appear inside the agent's report.
    expect(within(report).queryByText(/outside the workspace/) === null).toBe(true);

    const observed = screen.getByRole("region", { name: "Observed by Orkestrator" });
    const checks = within(observed).getByRole("list", { name: "File checks" });
    expect(within(checks).getByText(/outside the workspace/)).toBeTruthy();
    expect(within(checks).getByText(/found in the workspace/)).toBeTruthy();
    await waitFor(() =>
      expect(within(observed).getByText(/Different preview zoom\. Compare with care/)).toBeTruthy(),
    );
    expect(within(observed).getByText(/Zoom 110% · 2× device scale · scrolled 0,480/)).toBeTruthy();
    expect(within(observed).getByText("A different target than the original capture")).toBeTruthy();
  });

  test("a result with no agent report does not invent one", async () => {
    const request = fixtureRequest("awaiting-review", { resultIds: ["result-1"] });
    backend.requests.set(request.id, request);
    backend.results.set(
      "result-1",
      result({ reportedRevision: null, outcomes: [], summary: "", files: [], checks: [] }),
    );
    backend.seed({
      id: "annotation-1",
      currentCaptureId: "capture-element",
      requestIds: [request.id],
    });
    seedBrowserLayout({ open: true, selectedAnnotationId: "annotation-1" });
    render(<AnnotationHarness />);
    expect(await screen.findByText(/No structured result was reported/)).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Agent report" }) === null).toBe(true);
    expect(screen.getByRole("region", { name: "Observed by Orkestrator" })).toBeTruthy();
  });
});

describe("result labels", () => {
  test("recorded comparison differences win over record-derived guesses", () => {
    const before = fixtureCapture("element", { id: "b" });
    const after = fixtureCapture("page", {
      id: "a",
      comparison: { ...COMPARISON, differences: [] },
    });
    expect(comparisonLabels(before, after)).toEqual([]);
    expect(comparisonLabels(before, after, COMPARISON)).toEqual([
      "Different preview zoom",
      "Unstable capture: fonts or layout were still changing when it was taken",
    ]);
  });

  test("capture conditions list only what the desktop reported", () => {
    expect(captureConditionsLabel({})).toBeNull();
    expect(captureConditionsLabel({ stability: "stable", zoomFactor: 1 })).toBe(
      "Zoom 100% · stable",
    );
  });

  test("agent report presence follows reportedRevision, with a fallback for older records", () => {
    expect(hasAgentReport(result({ reportedRevision: null }))).toBe(false);
    expect(hasAgentReport(result({ reportedRevision: 3 }))).toBe(true);
    expect(
      hasAgentReport(result({ reportedRevision: undefined, provenance: "agent-reported" })),
    ).toBe(true);
    expect(hasAgentReport(result({ reportedRevision: undefined }))).toBe(false);
  });

  test("cited evidence is described relative to the note's capture", () => {
    expect(citedEvidenceLabel(result({ evidenceIds: [] }), "capture-element")).toBeNull();
    expect(citedEvidenceLabel(result({ evidenceIds: ["x", "y"] }), "capture-element")).toBe(
      "The agent cites 2 other evidence items.",
    );
  });
});
