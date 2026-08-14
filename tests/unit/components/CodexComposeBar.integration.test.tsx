import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as realBackend from "@/lib/backend";

const mockGetLocalFileTree = mock(async () => [{
  name: "architecture.md",
  path: "docs/architecture.md",
  isDirectory: false,
  extension: ".md",
}]);

const realBackendSnapshot = { ...realBackend };

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getLocalFileTree: mockGetLocalFileTree,
}));

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
});
import { useCodexNativeComposer, type CodexNativeComposerOptions } from "@/components/codex/useCodexNativeComposer";

function CodexNativeComposerHarness(props: CodexNativeComposerOptions) {
  return useCodexNativeComposer(props);
}
import { useCodexStore } from "@/stores/codexStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import type { CodexModel } from "@/lib/codex-client";

const ENVIRONMENT_ID = "env-codex-real-picker";
const SESSION_KEY = `env-${ENVIRONMENT_ID}:default`;
const MODELS: CodexModel[] = [{
  id: "gpt-5.3-codex",
  name: "gpt-5.3-codex",
  reasoningEfforts: ["high"],
  defaultReasoningEffort: "high",
}];

describe("CodexNativeComposerHarness real workspace picker integration", () => {
  beforeEach(() => {
    mockGetLocalFileTree.mockReset();
    mockGetLocalFileTree.mockResolvedValue([{
      name: "architecture.md",
      path: "docs/architecture.md",
      isDirectory: false,
      extension: ".md",
    }]);
    useCodexStore.setState({
      attachments: new Map(),
      draftText: new Map([[SESSION_KEY, "Review please"]]),
      draftMentions: new Map(),
      messageQueue: new Map(),
    });
    useEnvironmentStore.setState({
      environments: [{
        id: ENVIRONMENT_ID,
        projectId: "project-1",
        name: "Local environment",
        branch: "main",
        containerId: null,
        status: "running",
        prUrl: null,
        prState: null,
        hasMergeConflicts: null,
        createdAt: "2026-07-26T00:00:00.000Z",
        networkAccessMode: "restricted",
        order: 0,
        environmentType: "local",
        worktreePath: "/tmp/codex-real-picker",
      }],
    });
  });

  afterEach(() => {
    cleanup();
    window.getSelection()?.removeAllRanges();
  });

  test("inserts the selected file at the saved caret and rehydrates the controlled editor", async () => {
    render(
      <CodexNativeComposerHarness
        environmentId={ENVIRONMENT_ID}
        sessionKey={SESSION_KEY}
        models={MODELS}
        selectedMode="build"
        selectedModel="gpt-5.3-codex"
        selectedReasoningEffort="high"
        fastModeEnabled={false}
        onSend={async () => {}}
        onStop={async () => {}}
        onModeChange={() => {}}
        onModelChange={() => {}}
        onReasoningEffortChange={() => {}}
        onFastModeChange={() => {}}
      />,
    );

    const editor = document.querySelector<HTMLElement>("[contenteditable='true']");
    expect(editor).not.toBeNull();
    await waitFor(() => expect(editor?.textContent).toBe("Review please"));

    const initialTextNode = editor?.firstChild;
    expect(initialTextNode).not.toBeNull();
    act(() => {
      editor?.focus();
      const range = document.createRange();
      range.setStart(initialTextNode!, "Review ".length);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });

    fireEvent.pointerDown(screen.getByRole("button", { name: "Add attachment" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Mention file from workspace" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: /architecture\.md/ }));

    await waitFor(() => {
      expect(useCodexStore.getState().getDraftText(SESSION_KEY)).toBe(
        "Review @architecture.md please",
      );
      expect(useCodexStore.getState().getDraftMentions(SESSION_KEY)).toEqual([
        expect.objectContaining({
          filename: "architecture.md",
          relativePath: "docs/architecture.md",
        }),
      ]);
      expect(editor?.textContent).toBe("Review @architecture.md please");
    });
  });
});
