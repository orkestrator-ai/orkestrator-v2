import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useAnnotationUiTestBudget } from "@/test/web-annotation-harness";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { WEB_ANNOTATION_CONFLICT } from "@orkestrator/protocol/web-annotations";
import { resetWebAnnotationAssetsForTests } from "@/lib/web-annotations/assets";
import { resetWebAnnotationSyncForTests } from "@/lib/web-annotations/sync";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useNativeComposeStore } from "@/stores/nativeComposeStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import {
  createFakeCaptureApi,
  FakeWebAnnotationBackend,
  installFakeOrkestrator,
  invokeMock,
} from "@/test/web-annotation-fakes";
import { AnnotationHarness, flush, seedBrowserLayout } from "@/test/web-annotation-harness";

let backend: FakeWebAnnotationBackend;
let bus: ReturnType<typeof installFakeOrkestrator>;

async function openComposer(operation: "Discuss…" | "Request changes…" = "Request changes…") {
  fireEvent.click(await screen.findByRole("button", { name: operation }));
  const composer = await screen.findByRole("region", { name: "Ask an agent" });
  const option = await within(composer).findByRole("radio", { name: /Claude Code/ });
  fireEvent.click(option);
  return composer;
}

describe("request composer", () => {
  useAnnotationUiTestBudget();
  beforeEach(() => {
    resetWebAnnotationSyncForTests();
    resetWebAnnotationAssetsForTests();
    window.localStorage.clear();
    bus = installFakeOrkestrator({ capture: createFakeCaptureApi().api });
    backend = new FakeWebAnnotationBackend("env-1").install();
    backend.seed({ id: "annotation-1", title: "Save button" });
    seedBrowserLayout({ open: true, selectedAnnotationId: "annotation-1" });
    useNativeComposeStore.setState({ drafts: new Map() });
    useEnvironmentStore.setState({
      environments: [
        {
          id: "env-1",
          projectId: "project-1",
          name: "Annotations",
          order: 0,
          environmentType: "local",
          containerId: null,
        } as never,
      ],
    });
  });
  afterEach(() => {
    cleanup();
    resetWebAnnotationSyncForTests();
    bus.restore();
    invokeMock.mockImplementation(() => Promise.resolve());
  });

  test("previews exactly which agent receives which instruction and evidence", async () => {
    backend.destinations = [{ ...backend.destinations[0]!, holds: ["compose-draft"] }];
    const composer = await (async () => {
      render(<AnnotationHarness />);
      return openComposer("Discuss…");
    })();
    expect(
      within(composer).getByText("An unsent draft in this chat will hold the queue"),
    ).toBeTruthy();
    fireEvent.change(within(composer).getByRole("textbox", { name: "Overall instruction" }), {
      target: { value: "Is 8px enough?" },
    });
    fireEvent.click(within(composer).getByRole("button", { name: "Discuss with Claude Code" }));
    const preview = await waitFor(() => {
      const element = composer.querySelector("[data-preparation]");
      if (!element) throw new Error("no preview yet");
      return element as HTMLElement;
    });
    expect(within(preview).getByText(/sends to/)).toBeTruthy();
    expect(within(preview).getByText("Is 8px enough?")).toBeTruthy();
    expect(within(preview).getByText(/read-only plan mode/)).toBeTruthy();
    const manifest = within(preview).getByRole("list", { name: "Evidence manifest" });
    expect(manifest.textContent).toContain("included your note, target, page, visible text");
    expect(manifest.textContent).toContain("omitted HTML");
    expect(backend.callsOf("web_annotation_request_prepare")[0]!.args).toMatchObject({
      operation: "discuss",
      instruction: "Is 8px enough?",
      annotations: [{ annotationId: "annotation-1", expectedContentRevision: 1 }],
    });
    // Nothing was sent, and no native draft was touched by preparing.
    expect(backend.callsOf("web_annotation_request_send")).toHaveLength(0);
    expect(useNativeComposeStore.getState().drafts.size).toBe(0);
  });

  test("the remembered destination is shown but never sends by itself", async () => {
    render(<AnnotationHarness />);
    const composer = await openComposer();
    await waitFor(() => expect(backend.callsOf("web_annotation_update")).toHaveLength(1));
    expect(backend.callsOf("web_annotation_update")[0]!.args).toMatchObject({
      annotationId: "annotation-1",
      defaultDestination: { tabId: "tab-agent-1" },
    });
    fireEvent.click(within(composer).getByRole("button", { name: "Cancel" }));
    cleanup();
    render(<AnnotationHarness />);
    fireEvent.click(await screen.findByRole("button", { name: "Discuss…" }));
    expect(await screen.findByRole("button", { name: "Discuss with Claude Code" })).toBeTruthy();
    expect(backend.callsOf("web_annotation_request_prepare")).toHaveLength(0);
    expect(backend.callsOf("web_annotation_request_send")).toHaveLength(0);
  });

  test("send retry after a lost response reuses the same request id", async () => {
    render(<AnnotationHarness />);
    const composer = await openComposer();
    fireEvent.click(
      within(composer).getByRole("button", { name: "Request changes from Claude Code" }),
    );
    const send = await within(composer).findByRole("button", { name: "Send" });
    backend.fail("web_annotation_request_send", new Error("Gateway timeout"), {
      afterCommit: true,
    });
    fireEvent.click(send);
    const retry = await within(composer).findByRole("button", { name: "Retry send" });
    fireEvent.click(retry);
    await flush(10);
    expect(composer.isConnected).toBe(false);
    const sends = backend.callsOf("web_annotation_request_send");
    expect(sends).toHaveLength(2);
    expect(sends[0]!.args.requestId).toBe(sends[1]!.args.requestId);
    expect(backend.requests.size).toBe(1);
    expect(
      document.querySelector(`[data-request="${String(sends[0]!.args.requestId)}"]`),
    ).not.toBeNull();
  });

  test("an invalidated preparation names the mismatch and keeps the draft", async () => {
    render(<AnnotationHarness />);
    const composer = await openComposer();
    const instruction = within(composer).getByRole("textbox", { name: "Overall instruction" });
    fireEvent.change(instruction, { target: { value: "Make it 12px" } });
    fireEvent.click(
      within(composer).getByRole("button", { name: "Request changes from Claude Code" }),
    );
    const send = await within(composer).findByRole("button", { name: "Send" });
    backend.fail(
      "web_annotation_request_send",
      new Error(`${WEB_ANNOTATION_CONFLICT} the selected session changed its model`),
    );
    fireEvent.click(send);
    expect(
      await within(composer).findByText(
        /changed after the preview: .*selected session changed its model/,
      ),
    ).toBeTruthy();
    expect(
      (
        within(composer).getByRole("textbox", {
          name: "Overall instruction",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("Make it 12px");
    fireEvent.click(within(composer).getByRole("button", { name: "Prepare again" }));
    await waitFor(() => expect(backend.callsOf("web_annotation_request_prepare")).toHaveLength(2));
  });

  test("New agent session opens an agent tab without dispatching", async () => {
    render(<AnnotationHarness />);
    const composer = await openComposer();
    fireEvent.click(within(composer).getByRole("button", { name: "New agent session" }));
    const tabs = usePaneLayoutStore.getState().getAllTabs("env-1");
    expect(tabs.some((tab) => tab.type === "agent-native")).toBe(true);
    expect(within(composer).getByText(/Nothing was sent/)).toBeTruthy();
    expect(backend.callsOf("web_annotation_request_send")).toHaveLength(0);
  });
});
