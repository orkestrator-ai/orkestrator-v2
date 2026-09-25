import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { webAnnotationRequestMarker } from "@orkestrator/protocol/web-annotations";
import { fixtureRequest } from "@orkestrator/protocol/web-annotations-fixtures";
import { buildPromptWithTranscriptAnnotations } from "@/lib/chat/transcript-annotations";
import { normalizeNativeMessage } from "@/lib/chat/native-message-adapters";
import { useNativeComposeStore } from "@/stores/nativeComposeStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { FakeWebAnnotationBackend, invokeMock } from "@/test/web-annotation-fakes";
import { NativeMessage } from "./NativeMessage";

function userMessage(content: string) {
  return {
    id: "user-1",
    role: "user" as const,
    content,
    createdAt: "2026-09-21T12:00:00.000Z",
    parts: [{ type: "text" as const, content }],
  };
}

describe("web annotation request chip", () => {
  let backend: FakeWebAnnotationBackend;
  beforeEach(() => {
    backend = new FakeWebAnnotationBackend("env-1").install();
    const request = fixtureRequest("running", { id: "req-abc" });
    backend.requests.set(request.id, request);
    usePaneLayoutStore.setState({
      activeEnvironmentId: "env-1",
      environments: new Map([
        [
          "env-1",
          {
            root: {
              kind: "leaf",
              id: "pane-1",
              tabs: [
                {
                  id: "agent-1",
                  type: "agent-native",
                  nativeAgentData: { environmentId: "env-1", platform: "claude" },
                },
              ],
              activeTabId: "agent-1",
            },
            activePaneId: "pane-1",
            containerId: null,
          },
        ],
      ]),
    });
    useNativeComposeStore.setState({ drafts: new Map() });
  });
  afterEach(() => {
    cleanup();
    invokeMock.mockImplementation(() => Promise.resolve());
  });

  test("links a browser-originated turn to its thread without copying text into a draft", async () => {
    const content = `${webAnnotationRequestMarker("req-abc", "implement", 1)}\n\nBrief body`;
    render(<NativeMessage message={userMessage(content)} assistantLabel="Claude" />);
    expect(screen.getByText(/Web annotation request · change request · 1 note/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open annotation" }));
    await waitFor(() => {
      const tabs = usePaneLayoutStore.getState().getAllTabs("env-1");
      const browser = tabs.find((tab) => tab.type === "browser");
      expect(browser?.browserData?.annotationPanel).toMatchObject({
        open: true,
        selectedAnnotationId: "annotation-1",
      });
    });
    const layout = usePaneLayoutStore.getState().environments.get("env-1")!;
    expect((layout.root as { activeTabId: string }).activeTabId).toMatch(/^browser-/);
    expect(useNativeComposeStore.getState().drafts.size).toBe(0);
  });

  test("ordinary and legacy transcript annotation messages render unchanged, without a chip", () => {
    const legacy = buildPromptWithTranscriptAnnotations("Please fix", [
      { id: "a", text: "button#save", comment: "Too cramped", source: "browser" },
    ]);
    const message = normalizeNativeMessage(userMessage(legacy));
    render(<NativeMessage message={message} assistantLabel="Claude" />);
    expect(screen.queryByRole("button", { name: "Open annotation" }) === null).toBe(true);
    const card = screen.getByTestId("transcript-reference-part");
    expect(card.textContent).toContain("button#save");
    expect(card.textContent).not.toContain("orkestrator_transcript_annotations");
  });

  test("a marker-like line that is not the first line is not a request link", () => {
    const content = `Hello\n${webAnnotationRequestMarker("req-abc", "discuss", 1)}`;
    render(<NativeMessage message={userMessage(content)} assistantLabel="Claude" />);
    expect(screen.queryByRole("button", { name: "Open annotation" }) === null).toBe(true);
  });
});
