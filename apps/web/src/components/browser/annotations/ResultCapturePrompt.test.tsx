import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import type {
  WebAnnotationComparisonMetadata,
  WebAnnotationResult,
} from "@orkestrator/protocol/web-annotations";
import {
  FIXTURE_TIME,
  fixturePage,
  fixtureRequest,
} from "@orkestrator/protocol/testing/web-annotations-fixtures";
import { resetWebAnnotationAssetsForTests } from "@/lib/web-annotations/assets";
import { refreshWebAnnotations, resetWebAnnotationSyncForTests } from "@/lib/web-annotations/sync";
import {
  createFakeCaptureApi,
  FakeWebAnnotationBackend,
  installFakeOrkestrator,
  invokeMock,
} from "@/test/web-annotation-fakes";
import {
  AnnotationHarness,
  navigateToPageMock,
  seedBrowserLayout,
  useAnnotationUiTestBudget,
} from "@/test/web-annotation-harness";
import { currentPageForManualUrl } from "./format";
import {
  dismissResultCapturePrompt,
  hasAfterCapture,
  isResultCapturePromptDismissed,
  resetResultCapturePromptsForTests,
  resultCapturePromptState,
} from "./result-capture-prompt";

let backend: FakeWebAnnotationBackend;
let bus: ReturnType<typeof installFakeOrkestrator>;
let captureApi: ReturnType<typeof createFakeCaptureApi>;

const REQUEST_ID = "request-awaiting-review";
const COMPARISON: WebAnnotationComparisonMetadata = {
  contentRevision: 1,
  captureRevision: 1,
  comparedCaptureId: "capture-element",
  targetMatch: "same-target",
  differences: [],
};

function result(overrides: Partial<WebAnnotationResult> = {}): WebAnnotationResult {
  return {
    id: "result-1",
    requestId: REQUEST_ID,
    bodyHash: "0",
    revision: 1,
    provenance: "agent-reported",
    provisional: false,
    outcomes: [{ annotationId: "annotation-1", outcome: "addressed", note: null }],
    summary: "Increased the padding.",
    files: [],
    checks: [],
    evidenceAssetIds: [],
    captureIds: [],
    limitations: [],
    questions: [],
    supersedes: null,
    createdAt: FIXTURE_TIME,
    evidenceIds: [],
    reportedRevision: 1,
    observations: [],
    fileChecks: [],
    ...overrides,
  };
}

function seed(
  options: {
    result?: WebAnnotationResult | null;
    state?: "awaiting-review" | "running";
    route?: string;
  } = {},
) {
  const state = options.state ?? "awaiting-review";
  const request = fixtureRequest(state, {
    id: REQUEST_ID,
    resultIds: options.result ? [options.result.id] : [],
  });
  backend.requests.set(request.id, request);
  if (options.result) backend.results.set(options.result.id, options.result);
  backend.seed({
    id: "annotation-1",
    title: "Save button",
    currentCaptureId: "capture-element",
    requestIds: [request.id],
    page: { ...fixturePage, route: options.route ?? fixturePage.route },
  });
  seedBrowserLayout({ open: true, selectedAnnotationId: "annotation-1" });
  return request;
}

function captureButton(scope: HTMLElement) {
  return within(scope).getByRole("button", { name: "Capture current result" });
}

describe("turn-end result capture prompt", () => {
  useAnnotationUiTestBudget();
  beforeEach(() => {
    resetWebAnnotationSyncForTests();
    resetWebAnnotationAssetsForTests();
    resetResultCapturePromptsForTests();
    window.localStorage.clear();
    captureApi = createFakeCaptureApi();
    bus = installFakeOrkestrator({ capture: captureApi.api });
    backend = new FakeWebAnnotationBackend("env-1").install();
    navigateToPageMock.mockClear();
  });
  afterEach(() => {
    cleanup();
    resetWebAnnotationSyncForTests();
    resetResultCapturePromptsForTests();
    bus.restore();
    invokeMock.mockImplementation(() => Promise.resolve());
  });

  test("a finished turn on the note's page offers a capture that never navigates", async () => {
    seed({ result: result() });
    renderInAppCommandScope(<AnnotationHarness />);

    const prompt = await screen.findByRole("region", { name: "Capture the result" });
    expect(prompt.dataset.resultCapturePrompt).toBe("same-page");
    expect(within(prompt).getByText("The preview is on this note’s page.")).toBeTruthy();
    expect(within(prompt).getByText(/never navigates or reloads the page/)).toBeTruthy();
    expect(within(prompt).queryByText(/Use Open updated page first/) === null).toBe(true);

    fireEvent.click(captureButton(prompt));
    await waitFor(() => expect(captureApi.mocks.startCapture).toHaveBeenCalledTimes(1));
    const start = captureApi.mocks.startCapture.mock.calls[0]![0] as unknown as Record<
      string,
      unknown
    >;
    // The same result capture as the manual button: page mode, the
    // stability window and masks, and never the note's own capture.
    expect(start.mode).toBe("page");
    expect(start.purpose).toBe("result");
    expect(start.result).toEqual({ requestId: REQUEST_ID, originalCaptureId: "capture-element" });
    expect(start.annotationId).toBeUndefined();
    expect(navigateToPageMock).not.toHaveBeenCalled();
  });

  test("on another page it warns and navigates only when the user asks", async () => {
    seed({ result: result(), route: "/billing" });
    renderInAppCommandScope(<AnnotationHarness />);

    const prompt = await screen.findByRole("region", { name: "Capture the result" });
    expect(prompt.dataset.resultCapturePrompt).toBe("other-page");
    expect(
      within(prompt).getByText(/The preview shows localhost:5173\/settings\?tab=profile, not/),
    ).toBeTruthy();
    expect(within(prompt).getByText(/Use Open updated page first/)).toBeTruthy();
    expect(navigateToPageMock).not.toHaveBeenCalled();

    const article = screen.getByRole("article", { name: /Change request/ });
    fireEvent.click(within(article).getByRole("button", { name: "Open updated page" }));
    expect(navigateToPageMock).toHaveBeenCalledTimes(1);
    const page = (navigateToPageMock.mock.calls[0] as unknown[])[0] as { route: string };
    expect(page.route).toBe("/billing");
    // Opening the page does not capture; the capture is still the user's click.
    expect(captureApi.mocks.startCapture).not.toHaveBeenCalled();
  });

  test("a note that already has an after-capture keeps only the manual button", async () => {
    seed({
      result: result({
        captureIds: ["after-1"],
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
      }),
    });
    renderInAppCommandScope(<AnnotationHarness />);

    const article = await screen.findByRole("article", { name: /Change request/ });
    await waitFor(() => expect(captureButton(article)).toBeTruthy());
    expect(screen.queryByRole("region", { name: "Capture the result" }) === null).toBe(true);
  });

  test("a turn with no structured result still offers the capture", async () => {
    seed({ result: null });
    renderInAppCommandScope(<AnnotationHarness />);
    expect(await screen.findByRole("region", { name: "Capture the result" })).toBeTruthy();
  });

  test("Not now leaves the manual button and survives the thread remounting", async () => {
    seed({ result: result() });
    const view = renderInAppCommandScope(<AnnotationHarness />);

    const prompt = await screen.findByRole("region", { name: "Capture the result" });
    fireEvent.click(within(prompt).getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("region", { name: "Capture the result" }) === null).toBe(true);
    const article = screen.getByRole("article", { name: /Change request/ });
    expect(captureButton(article)).toBeTruthy();

    view.unmount();
    renderInAppCommandScope(<AnnotationHarness />);
    const again = await screen.findByRole("article", { name: /Change request/ });
    await waitFor(() => expect(captureButton(again)).toBeTruthy());
    expect(screen.queryByRole("region", { name: "Capture the result" }) === null).toBe(true);
  });

  test("the request settling into review announces the prompt once", async () => {
    const running = seed({ state: "running" });
    renderInAppCommandScope(<AnnotationHarness />);
    await screen.findByRole("article", { name: /Change request/ });
    expect(screen.queryByRole("region", { name: "Capture the result" }) === null).toBe(true);

    backend.requests.set(running.id, {
      ...fixtureRequest("awaiting-review", { id: running.id }),
      revision: running.revision + 1,
    });
    act(() => {
      refreshWebAnnotations("env-1", { requestIds: [running.id], annotationIds: ["annotation-1"] });
    });

    expect(await screen.findByRole("region", { name: "Capture the result" })).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toMatch(
        /finished\. Capture the current result from the request card/,
      ),
    );
  });
});

describe("result capture prompt state", () => {
  const current = currentPageForManualUrl("http://localhost:5173/settings?tab=profile");

  test("waits for the turn: a provisional result gets no prompt", () => {
    expect(
      resultCapturePromptState({
        result: result({ provisional: true }),
        annotationId: "annotation-1",
        page: fixturePage,
        currentPage: current,
      }),
    ).toEqual({ kind: "not-ready" });
  });

  test("compares the note's page with the preview's current page", () => {
    expect(
      resultCapturePromptState({
        result: null,
        annotationId: "annotation-1",
        page: fixturePage,
        currentPage: current,
      }),
    ).toEqual({ kind: "ready", samePage: true });
    expect(
      resultCapturePromptState({
        result: result(),
        annotationId: "annotation-1",
        page: { ...fixturePage, route: "/billing" },
        currentPage: current,
      }),
    ).toEqual({ kind: "ready", samePage: false });
    expect(
      resultCapturePromptState({
        result: result(),
        annotationId: "annotation-1",
        page: fixturePage,
        currentPage: null,
      }),
    ).toEqual({ kind: "ready", samePage: false });
  });

  test("an after-capture for another note in the batch does not count", () => {
    const batch = result({
      captureIds: ["after-2"],
      observations: [
        {
          captureId: "after-2",
          annotationId: "annotation-2",
          capturedAt: FIXTURE_TIME,
          provenance: "app-observed",
          assetIds: [],
          comparison: COMPARISON,
        },
      ],
    });
    expect(hasAfterCapture(batch, "annotation-1")).toBe(false);
    expect(hasAfterCapture(batch, "annotation-2")).toBe(true);
    // A capture recorded before observations existed is attributed to every note.
    expect(hasAfterCapture(result({ captureIds: ["legacy"] }), "annotation-1")).toBe(true);
    expect(hasAfterCapture(null, "annotation-1")).toBe(false);
  });

  test("dismissals are per environment, request and note", () => {
    resetResultCapturePromptsForTests();
    dismissResultCapturePrompt("env-1", "request-1", "annotation-1");
    expect(isResultCapturePromptDismissed("env-1", "request-1", "annotation-1")).toBe(true);
    expect(isResultCapturePromptDismissed("env-1", "request-1", "annotation-2")).toBe(false);
    expect(isResultCapturePromptDismissed("env-2", "request-1", "annotation-1")).toBe(false);
    resetResultCapturePromptsForTests();
  });
});
