import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useAnnotationUiTestBudget } from "@/test/web-annotation-harness";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  WEB_ANNOTATION_BLOCKED_REASON_LABELS,
  WEB_ANNOTATION_REQUEST_STATE_LABELS,
  type WebAnnotationRequestState,
} from "@orkestrator/protocol/web-annotations";
import { fixtureRequest } from "@orkestrator/protocol/web-annotations-fixtures";
import { resetWebAnnotationAssetsForTests } from "@/lib/web-annotations/assets";
import { resetWebAnnotationSyncForTests } from "@/lib/web-annotations/sync";
import { useFilesPanelStore } from "@/stores/filesPanelStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
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
} from "@/test/web-annotation-harness";

let backend: FakeWebAnnotationBackend;
let bus: ReturnType<typeof installFakeOrkestrator>;

function seedWithRequest(state: WebAnnotationRequestState, overrides = {}) {
  const request = fixtureRequest(state, { id: `request-${state}`, ...overrides });
  backend.requests.set(request.id, request);
  backend.seed({
    id: "annotation-1",
    title: "Save button",
    currentCaptureId: "capture-element",
    requestIds: [request.id],
    activeRequestId: request.reservation ? request.id : null,
  });
  seedBrowserLayout({ open: true, selectedAnnotationId: "annotation-1" }, [
    {
      id: "tab-agent-1",
      type: "agent-native",
      nativeAgentData: { environmentId: "env-1", platform: "claude" },
    },
  ]);
  return request;
}

async function card() {
  return screen.findByRole("article", { name: /with Claude Code/ });
}

describe("request cards", () => {
  useAnnotationUiTestBudget();
  beforeEach(() => {
    resetWebAnnotationSyncForTests();
    resetWebAnnotationAssetsForTests();
    window.localStorage.clear();
    bus = installFakeOrkestrator({ capture: createFakeCaptureApi().api });
    backend = new FakeWebAnnotationBackend("env-1").install();
    navigateToPageMock.mockClear();
  });
  afterEach(() => {
    cleanup();
    resetWebAnnotationSyncForTests();
    bus.restore();
    invokeMock.mockImplementation(() => Promise.resolve());
  });

  test("a queued hold explains the draft and offers Open chat / Choose another session", async () => {
    seedWithRequest("queued");
    render(<AnnotationHarness />);
    const article = await card();
    expect(
      within(article).getByText(WEB_ANNOTATION_BLOCKED_REASON_LABELS["compose-draft"]),
    ).toBeTruthy();
    fireEvent.click(within(article).getByRole("button", { name: "Open chat" }));
    const layout = usePaneLayoutStore.getState().environments.get("env-1")!;
    expect((layout.root as { activeTabId: string }).activeTabId).toBe("tab-agent-1");

    fireEvent.click(within(article).getByRole("button", { name: "Choose another session" }));
    // Retargeting withdraws the old request only when the new one is sent.
    const composer = await screen.findByRole("region", { name: "Ask an agent" });
    expect(backend.callsOf("web_annotation_request_cancel")).toHaveLength(0);
    expect(composer.querySelector('[data-composer-reference="retarget"]')).toBeTruthy();
  });

  test("unconfirmed delivery retries with the same id and warns before discarding", async () => {
    seedWithRequest("unconfirmed");
    render(<AnnotationHarness />);
    const article = await card();
    expect(within(article).getByText(WEB_ANNOTATION_REQUEST_STATE_LABELS.unconfirmed)).toBeTruthy();
    fireEvent.click(within(article).getByRole("button", { name: "Retry delivery" }));
    await waitFor(() =>
      expect(backend.callsOf("web_annotation_request_recover")[0]?.args).toMatchObject({
        requestId: "request-unconfirmed",
        action: "retry",
      }),
    );
  });

  test("discarding unconfirmed delivery requires acknowledging that work may have run", async () => {
    seedWithRequest("unconfirmed");
    render(<AnnotationHarness />);
    const article = await card();
    fireEvent.click(within(article).getByRole("button", { name: "Discard" }));
    expect(within(article).getByText(/may already have run this request/)).toBeTruthy();
    expect(backend.callsOf("web_annotation_request_recover")).toHaveLength(0);
    fireEvent.click(within(article).getByRole("button", { name: "Discard anyway" }));
    await waitFor(() =>
      expect(backend.callsOf("web_annotation_request_recover")[0]?.args).toMatchObject({
        action: "discard",
      }),
    );
  });

  test("Stop is explicit and sends the expected request revision; closing the panel does not stop", async () => {
    const request = seedWithRequest("running");
    const revision = request.revision;
    render(<AnnotationHarness />);
    await card();
    fireEvent.click(screen.getByRole("button", { name: "Close annotations" }));
    expect(backend.callsOf("web_annotation_request_cancel")).toHaveLength(0);
    cleanup();
    seedBrowserLayout({ open: true, selectedAnnotationId: "annotation-1" });
    render(<AnnotationHarness />);
    const reopened = await card();
    fireEvent.click(within(reopened).getByRole("button", { name: "Stop" }));
    await waitFor(() =>
      expect(backend.callsOf("web_annotation_request_cancel")[0]?.args).toMatchObject({
        requestId: request.id,
        expectedRevision: revision,
      }),
    );
    expect(
      await within(reopened).findByText(/Stopping\. The current turn may still finish/),
    ).toBeTruthy();
  });

  test("needs-input deep-links to the chat to answer", async () => {
    seedWithRequest("needs-input");
    render(<AnnotationHarness />);
    const article = await card();
    fireEvent.click(within(article).getByRole("button", { name: "Answer in chat" }));
    const layout = usePaneLayoutStore.getState().environments.get("env-1")!;
    expect((layout.root as { activeTabId: string }).activeTabId).toBe("tab-agent-1");
  });

  test("review shows the response and actions; accept resolves the reviewed revision", async () => {
    seedWithRequest("awaiting-review", {
      response: {
        text: "Added 8px padding to the Save button.",
        capturedAt: "2026-09-21T12:00:00.000Z",
        provenance: "agent-reference",
        truncated: false,
      },
    });
    render(<AnnotationHarness />);
    const article = await card();
    expect(await within(article).findByText("Added 8px padding to the Save button.")).toBeTruthy();
    expect(within(article).getByRole("button", { name: "Open full conversation" })).toBeTruthy();

    fireEvent.click(within(article).getByRole("button", { name: "Open updated page" }));
    expect(navigateToPageMock).toHaveBeenCalledTimes(1);
    fireEvent.click(
      within(article).getByRole("button", { name: "Open changes (current workspace diff)" }),
    );
    expect(useFilesPanelStore.getState()).toMatchObject({ isOpen: true, activeTab: "changes" });

    fireEvent.click(within(article).getByRole("button", { name: "Accept and resolve" }));
    await waitFor(() => expect(backend.annotations.get("annotation-1")!.state).toBe("resolved"));
    expect(backend.callsOf("web_annotation_resolve")[0]!.args).toMatchObject({
      annotationId: "annotation-1",
      expectedContentRevision: 1,
      expectedCaptureId: "capture-element",
      requestId: "request-awaiting-review",
    });
    expect(await screen.findByRole("button", { name: "Reopen" })).toBeTruthy();
  });

  test("accepting a result for older content explains the newer requirement", async () => {
    seedWithRequest("awaiting-review");
    // A new note was added after dispatch.
    backend.annotations.get("annotation-1")!.contentRevision = 2;
    render(<AnnotationHarness />);
    const article = await card();
    expect(within(article).getByText(/used an older version of the note/)).toBeTruthy();
    fireEvent.click(within(article).getByRole("button", { name: "Accept and resolve" }));
    expect(await within(article).findByText(/would hide those newer requirements/)).toBeTruthy();
    expect(backend.annotations.get("annotation-1")!.state).toBe("open");
    fireEvent.click(within(article).getByRole("button", { name: "Review older result" }));
    expect(within(article).getByText(/Historical result/)).toBeTruthy();
  });

  test("failed requests keep their reason and offer another attempt", async () => {
    seedWithRequest("failed");
    render(<AnnotationHarness />);
    const article = await card();
    expect(within(article).getByText("The provider rejected the prompt.")).toBeTruthy();
    fireEvent.click(within(article).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("region", { name: "Ask an agent" })).toBeTruthy();
  });
});
