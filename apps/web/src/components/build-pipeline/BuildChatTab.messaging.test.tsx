import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { useEffect } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  TerminalProvider,
  useTerminalContext,
  type CreateTabOptions,
} from "@/contexts/TerminalContext";
import { useFlowGraphViewStore } from "@/stores/flowGraphViewStore";
import {
  MAX_PIPELINE_USER_MESSAGE_LENGTH,
  REVIEW_PACKAGE_SESSION_LABEL,
  pipelineIndependentReviewLabel,
} from "@orkestrator/protocol/build-pipeline";
import { useBuildPipelineStore, type BuildPipeline } from "@/stores/buildPipelineStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { findPreviousNativeMessage } from "@/lib/chat/native-message-adapters";
import { mockToastError, mockToastInfo, mockToastSuccess } from "../../../../../tests/mocks/sonner";
import {
  BuildChatTab,
  tabData,
  getBuildPipelineConditionalMock,
  getBuildPipelineControlMock,
  graphNode,
  headerText,
  inspector,
  listProps,
  nodeTitles,
  pauseBuildPipelineMock,
  pipeline,
  queryGraphNode,
  renderPipelineTab,
  resetListProps,
  restartCurrentStepMock,
  restoreBuildChatTabMocks,
  retryReviewerMock,
  retryStageMock,
  reviewed,
  selectNode,
  selectedTitle,
  sendMessageMock,
  steerPipelineMock,
  validationRun,
} from "./build-chat-tab-test-support";

/**
 * Transcript wiring, per-step harnesses, rehydration, following and messaging.
 */

afterAll(restoreBuildChatTabMocks);

describe("BuildChatTab transcript wiring", () => {
  beforeEach(() => {
    cleanup();
    resetListProps();
    useBuildPipelineStore.setState({
      pipelines: new Map([[pipeline.id, pipeline]]),
      buildEnvironmentIds: new Set([pipeline.environmentId]),
    });
    useEnvironmentStore.setState({
      environments: [{ id: "env-1", containerId: "container-1" }],
    } as never);
  });

  afterAll(() => {
    useEnvironmentStore.setState({ environments: [] } as never);
  });

  function renderTab(props: { isActive?: boolean; ownsGlobalShortcuts?: boolean } = {}) {
    render(
      <BuildChatTab
        data={{
          pipelineId: pipeline.id,
          environmentId: pipeline.environmentId,
          taskId: pipeline.taskId,
          isLocal: true,
        }}
        {...props}
      />,
    );
  }

  test("keys each row on its message id so a re-render does not remount it", () => {
    renderTab();

    expect(listProps.messages.map((message: { id: string }) => message.id)).toEqual(["answer-2"]);
    expect(listProps.computeItemKey(0, listProps.messages[0])).toBe("answer-2");
  });

  test("resolves each row's predecessor past empty assistant placeholders", () => {
    renderTab();

    // Without this the transcript would anchor attribution and duration on an
    // info-only placeholder instead of the message that produced the content.
    expect(listProps.resolvePreviousMessage).toBe(findPreviousNativeMessage);

    const messages = [
      { id: "u", role: "user", content: "Q", createdAt: "2026-03-21T10:00:00.000Z", parts: [] },
      {
        id: "empty",
        role: "assistant",
        content: "",
        createdAt: "2026-03-21T10:00:10.000Z",
        parts: [],
      },
      {
        id: "answer",
        role: "assistant",
        content: "A",
        createdAt: "2026-03-21T10:00:20.000Z",
        parts: [{ type: "text", content: "A" }],
      },
    ];
    expect(listProps.resolvePreviousMessage(messages, 2)).toBe(messages[0]);
  });

  test("claims the find shortcut only while its pane owns the keyboard", () => {
    // `useAgentChatFind` binds Cmd+F on the document, so a split layout would
    // otherwise open two find bars from one keystroke.
    renderTab({ isActive: true, ownsGlobalShortcuts: false });
    expect(listProps.find.isActive).toBe(false);
    expect(typeof listProps.find.getSearchText).toBe("function");

    cleanup();
    renderTab({ isActive: true, ownsGlobalShortcuts: true });
    expect(listProps.find.isActive).toBe(true);
  });

  test("defaults shortcut ownership to visibility for a caller that omits it", () => {
    renderTab({ isActive: true });
    expect(listProps.find.isActive).toBe(true);
  });

  test("gives every row the agent's label and the environment's container", () => {
    renderTab();

    // Images the agent wrote inside a Dockerised environment are readable only
    // through its container.
    const row = listProps.renderMessage(0, listProps.messages[0], null);
    expect(row.props).toMatchObject({
      assistantLabel: "Codex",
      containerId: "container-1",
    });
  });

  test("renders rows without a container when the environment is not known yet", () => {
    // A local environment has no container, and a Dockerised one is absent from
    // the store until it has been hydrated. Passing `null` through would make
    // the renderer try to read files out of a container called "null".
    useEnvironmentStore.setState({ environments: [] } as never);
    renderTab();

    const row = listProps.renderMessage(0, listProps.messages[0], null);
    expect(row.props.containerId).toBeUndefined();
    expect(row.props.assistantLabel).toBe("Codex");
  });

  test("uses each provider's own name on its rows", () => {
    for (const [agentType, label] of [
      ["claude", "Claude"],
      ["opencode", "OpenCode"],
    ] as const) {
      cleanup();
      useBuildPipelineStore.getState().replacePipeline({
        ...pipeline,
        agentType,
        backendRevision: 44 + label.length,
      });
      renderTab();

      const row = listProps.renderMessage(0, listProps.messages[0], null);
      expect(row.props.assistantLabel).toBe(label);
    }
  });
});

describe("BuildChatTab per-step harnesses", () => {
  /**
   * A Codex turn that delegated to a subagent.
   *
   * `subagent` is one of the part types the Claude adapter drops, so decoding
   * this through the pipeline's build agent rather than the session's own would
   * silently lose the delegation entirely.
   */
  const codexReview: BuildPipeline["sessions"][number] = {
    phase: "review",
    agent: "codex",
    iteration: 0,
    sessionKey: "codex-review-key",
    sdkSessionId: "codex-review-session",
    status: "idle",
    startedAt: "2026-07-29T00:02:00.000Z",
    label: "Codex Review Session",
    messages: [
      {
        id: "codex-review-answer",
        role: "assistant",
        parts: [
          { type: "text", content: "Reviewed the diff" },
          {
            type: "subagent",
            content: "diff-auditor",
            subagentId: "sub-1",
            subagentName: "diff-auditor",
            subagentActions: [],
          },
        ],
      },
    ],
  };

  /**
   * A Claude turn whose child tool is grouped under the Task that spawned it.
   *
   * Only the Claude adapter performs that grouping, so this stage tells the two
   * decoders apart in the opposite direction from the Codex one.
   */
  const claudeBuild: BuildPipeline["sessions"][number] = {
    phase: "build",
    agent: "claude",
    iteration: 0,
    sessionKey: "claude-build-key",
    sdkSessionId: "claude-build-session",
    status: "idle",
    startedAt: "2026-07-29T00:00:00.000Z",
    label: "Claude Build Session",
    messages: [
      {
        id: "claude-build-answer",
        role: "assistant",
        content: "",
        timestamp: "2026-07-29T00:00:10.000Z",
        parts: [
          {
            type: "tool-invocation",
            toolName: "Task",
            toolUseId: "task-1",
            toolArgs: { description: "Audit the diff" },
          },
          {
            type: "tool-invocation",
            toolName: "Bash",
            parentTaskUseId: "task-1",
            toolArgs: { command: "git diff" },
          },
        ],
      },
    ],
  };

  // The build ran on Claude; the launcher configured the review step on Codex,
  // so `agentType` describes only the build stage.
  const mixed: BuildPipeline = {
    ...pipeline,
    id: "mixed",
    agentType: "claude",
    steps: { build: { agent: "claude" }, review: { agent: "codex" } },
    sessions: [claudeBuild, codexReview],
    currentSessionIndex: 1,
    backendRevision: 60,
  };

  function renderTab(next: BuildPipeline) {
    useBuildPipelineStore.setState({
      pipelines: new Map([[next.id, next]]),
      buildEnvironmentIds: new Set([next.environmentId]),
    });
    render(
      <BuildChatTab
        data={{
          pipelineId: next.id,
          environmentId: next.environmentId,
          taskId: next.taskId,
          isLocal: true,
        }}
      />,
    );
  }

  function partTypes(): string[] {
    return (listProps.messages as Array<{ parts: Array<{ type: string }> }>).flatMap((message) =>
      message.parts.map((part) => part.type),
    );
  }

  beforeEach(() => {
    cleanup();
    resetListProps();
  });

  test("decodes a Codex stage with the Codex adapter on a Claude-built pipeline", () => {
    renderTab(mixed);

    // Decoded through the pipeline's `agentType` the subagent part would be
    // filtered out by the Claude adapter, and the delegation would vanish.
    expect(partTypes()).toEqual(["text", "subagent"]);
    expect(screen.getByText("diff-auditor")).toBeTruthy();
    expect(screen.getByText("Reviewed the diff")).toBeTruthy();
  });

  test("names each stage's own harness on its node and rows, and the build agent above", async () => {
    renderTab(mixed);

    // Per-step configuration makes a stage's harness differ from the
    // pipeline's build agent: each node and the transcript's assistant label
    // describe the stage's own, while the header names the build agent.
    expect(headerText("Claude")).toBeTruthy();
    expect(within(graphNode("Review")).getByText(/^codex/)).toBeTruthy();
    expect(within(graphNode("Build")).getByText(/^claude/)).toBeTruthy();
    expect(listProps.renderMessage(0, listProps.messages[0], null).props).toMatchObject({
      assistantLabel: "Codex",
    });

    selectNode("Build");
    await waitFor(() =>
      expect(listProps.renderMessage(0, listProps.messages[0], null).props).toMatchObject({
        assistantLabel: "Claude",
      }),
    );
  });

  test("re-decodes with the right adapter each time the stage changes", async () => {
    renderTab(mixed);
    expect(partTypes()).toEqual(["text", "subagent"]);

    // Only the Claude adapter groups a child tool under its Task.
    selectNode("Build");
    await waitFor(() => expect(partTypes()).toEqual(["task-group"]));

    // And switching back must not leave the Claude decoder in place.
    selectNode("Review");
    await waitFor(() => expect(partTypes()).toEqual(["text", "subagent"]));
  });

  test("falls back to the build agent for a stage recorded before per-step harnesses", () => {
    const { agent: _agent, ...legacySession } = codexReview;
    renderTab({
      ...pipeline,
      id: "legacy",
      agentType: "opencode",
      sessions: [legacySession],
      currentSessionIndex: 0,
      backendRevision: 61,
    });

    // A snapshot written before sessions recorded their harness still renders:
    // `agentType` is the only answer available, and no answer at all would blank
    // the transcript.
    expect(partTypes()).toEqual(["text", "subagent"]);
    expect(screen.getByText("Reviewed the diff")).toBeTruthy();
    expect(within(graphNode("Review")).getByText(/^opencode/)).toBeTruthy();
    expect(listProps.renderMessage(0, listProps.messages[0], null).props).toMatchObject({
      assistantLabel: "OpenCode",
    });
  });
});

describe("BuildChatTab rehydration", () => {
  beforeEach(() => {
    cleanup();
    getBuildPipelineConditionalMock.mockClear();
    getBuildPipelineControlMock.mockClear();
    getBuildPipelineControlMock.mockImplementation(async () => null);
    useBuildPipelineStore.setState({
      pipelines: new Map(),
      buildEnvironmentIds: new Set(),
    });
  });

  test("fetches the authoritative snapshot when the store has none", async () => {
    // App hydrates pipelines once per project. If that never ran for this
    // project or failed, the tab would otherwise sit on its loading state
    // forever with no way back — the rehydrate-on-mount invariant.
    getBuildPipelineControlMock.mockImplementation(async () => ({
      version: 2,
      id: pipeline.id,
      projectId: pipeline.projectId,
      environmentId: pipeline.environmentId,
      snapshot: pipeline,
      revision: 8,
      updatedAt: "2026-07-29T00:00:00.000Z",
    }));

    render(
      <BuildChatTab
        data={{
          environmentId: "env-1",
          pipelineId: pipeline.id,
          taskId: "task-1",
          isLocal: true,
        }}
      />,
    );

    expect(screen.getByText("Loading build pipeline…")).toBeTruthy();
    await waitFor(() => {
      expect(headerText("Backend-owned build")).toBeTruthy();
    });
    // Control state only: the transcript view asks for bodies when shown.
    expect(getBuildPipelineControlMock).toHaveBeenCalledWith(pipeline.id, undefined);
    expect(getBuildPipelineConditionalMock).not.toHaveBeenCalled();
  });

  test("does not refetch in a loop when the pipeline genuinely does not exist", async () => {
    render(
      <BuildChatTab
        data={{
          environmentId: "env-1",
          pipelineId: "missing",
          taskId: "task-1",
          isLocal: true,
        }}
      />,
    );

    await waitFor(() => expect(getBuildPipelineControlMock).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getBuildPipelineControlMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Loading build pipeline…")).toBeTruthy();
  });

  test("warns once when hydration rejects and does not retry on store changes", async () => {
    const hydrationError = new Error("snapshot unavailable");
    const warnMock = mock(() => {});
    const realWarn = console.warn;
    console.warn = warnMock;
    getBuildPipelineControlMock.mockRejectedValueOnce(hydrationError);

    try {
      render(
        <BuildChatTab
          data={{
            environmentId: "env-1",
            pipelineId: pipeline.id,
            taskId: "task-1",
            isLocal: true,
          }}
        />,
      );

      await waitFor(() => {
        expect(warnMock).toHaveBeenCalledWith(
          "[BuildChatTab] Failed to hydrate build pipeline:",
          hydrationError,
        );
      });

      // Make the effect observe both a present and then absent snapshot. The
      // per-pipeline attempt guard must still prevent a second backend read.
      act(() => {
        useBuildPipelineStore.getState().replacePipeline(pipeline);
      });
      act(() => {
        useBuildPipelineStore.setState({
          pipelines: new Map(),
          buildEnvironmentIds: new Set(),
        });
      });

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(getBuildPipelineControlMock).toHaveBeenCalledTimes(1);
      expect(warnMock).toHaveBeenCalledTimes(1);
    } finally {
      console.warn = realWarn;
    }
  });

  test("does not fetch when the store already has the snapshot", async () => {
    useBuildPipelineStore.setState({
      pipelines: new Map([[pipeline.id, pipeline]]),
      buildEnvironmentIds: new Set(["env-1"]),
    });

    render(
      <BuildChatTab
        data={{
          environmentId: "env-1",
          pipelineId: pipeline.id,
          taskId: "task-1",
          isLocal: true,
        }}
      />,
    );

    expect(headerText("Backend-owned build")).toBeTruthy();
    expect(getBuildPipelineControlMock).not.toHaveBeenCalled();
    expect(getBuildPipelineConditionalMock).not.toHaveBeenCalled();
  });
});

describe("BuildChatTab stage following", () => {
  function renderWith(next: BuildPipeline) {
    useBuildPipelineStore.setState({
      pipelines: new Map([[next.id, next]]),
      buildEnvironmentIds: new Set([next.environmentId]),
    });
  }

  beforeEach(() => {
    cleanup();
    renderWith(pipeline);
  });

  test("follows the pipeline to each new stage until the user picks one", async () => {
    const building: BuildPipeline = {
      ...pipeline,
      phase: "building",
      sessions: [pipeline.sessions[0]!],
      currentSessionIndex: 0,
    };
    renderWith(building);
    render(
      <BuildChatTab
        data={{
          environmentId: "env-1",
          pipelineId: pipeline.id,
          taskId: "task-1",
          isLocal: true,
        }}
      />,
    );
    expect(screen.getByText("Implementation complete")).toBeTruthy();

    // The backend advances to the verification stage.
    renderWith({ ...pipeline, phase: "verifying" });

    await waitFor(() => {
      expect(screen.getByText("All criteria pass")).toBeTruthy();
    });
  });

  test("holds a stage the user selected even as the pipeline advances", async () => {
    renderWith({ ...pipeline, phase: "verifying" });
    render(
      <BuildChatTab
        data={{
          environmentId: "env-1",
          pipelineId: pipeline.id,
          taskId: "task-1",
          isLocal: true,
        }}
      />,
    );
    await waitFor(() => expect(screen.getByText("All criteria pass")).toBeTruthy());

    selectNode("Build");
    await waitFor(() => expect(screen.getByText("Implementation complete")).toBeTruthy());

    // A new snapshot arrives; the explicit choice must survive it.
    renderWith({ ...pipeline, phase: "complete", backendRevision: 20 });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.getByText("Implementation complete")).toBeTruthy();
  });

  test("resumes following when the selected stage leaves the snapshot", async () => {
    render(
      <BuildChatTab
        data={{
          environmentId: "env-1",
          pipelineId: pipeline.id,
          taskId: "task-1",
          isLocal: true,
        }}
      />,
    );
    selectNode("Build");
    await waitFor(() => expect(screen.getByText("Implementation complete")).toBeTruthy());

    // A retry replaced the session list; the pinned id no longer exists, so
    // holding it would leave the transcript permanently blank.
    renderWith({
      ...pipeline,
      sessions: [pipeline.sessions[1]!],
      currentSessionIndex: 0,
      backendRevision: 30,
    });

    await waitFor(() => expect(screen.getByText("All criteria pass")).toBeTruthy());
  });
});

describe("BuildChatTab agent messaging", () => {
  const running: BuildPipeline = { ...pipeline, phase: "building" };

  beforeEach(() => {
    cleanup();
    sendMessageMock.mockClear();
    steerPipelineMock.mockClear();
    mockToastInfo.mockClear();
    mockToastSuccess.mockClear();
    restartCurrentStepMock.mockClear();
    retryStageMock.mockClear();
    mockToastError.mockClear();
    useBuildPipelineStore.setState({
      pipelines: new Map([[running.id, running]]),
      buildEnvironmentIds: new Set(["env-1"]),
    });
  });

  function renderTab() {
    render(
      <BuildChatTab
        data={{
          environmentId: "env-1",
          pipelineId: running.id,
          taskId: "task-1",
          isLocal: true,
        }}
      />,
    );
  }

  test("queues a message through the backend and clears the box", async () => {
    renderTab();
    const box = screen.getByLabelText("Send a message to the agent") as HTMLTextAreaElement;

    fireEvent.change(box, { target: { value: "  also update the README  " } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(sendMessageMock).toHaveBeenCalledWith(running.id, "also update the README"),
    );
    await waitFor(() => expect(box.value).toBe(""));
    // The authoritative reply is installed, so the queue depth is visible.
    await waitFor(() => expect(screen.getByText(/1 message queued/)).toBeTruthy());
  });

  test("sends /steer to the live turn instead of the idle queue", async () => {
    renderTab();
    const box = screen.getByLabelText("Send a message to the agent") as HTMLTextAreaElement;

    fireEvent.change(box, { target: { value: "/steer  use the existing helper  " } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(steerPipelineMock).toHaveBeenCalledWith(running.id, "use the existing helper"),
    );
    // Queueing it would hold it until the stage ended and review began.
    expect(sendMessageMock).not.toHaveBeenCalled();
    await waitFor(() => expect(box.value).toBe(""));
    expect(mockToastSuccess).toHaveBeenCalledWith("Sent to the active turn");
    expect(screen.queryByText(/message queued/) === null).toBe(true);
  });

  test("reports queued steering without claiming the running agent is idle", async () => {
    steerPipelineMock.mockImplementationOnce(async (pipelineId: string, text: string) => ({
      pipeline: {
        ...useBuildPipelineStore.getState().pipelines.get(pipelineId)!,
        pendingUserMessages: [{ id: "queued-2", text, createdAt: "2026-07-29T00:02:00.000Z" }],
        backendRevision: 14,
      },
      delivery: "queued" as const,
    }));
    renderTab();
    const box = screen.getByLabelText("Send a message to the agent") as HTMLTextAreaElement;

    fireEvent.change(box, { target: { value: "/steer change course" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(mockToastInfo).toHaveBeenCalledWith(
        "Could not steer the live turn, so the message was queued.",
      ),
    );
    expect(mockToastSuccess).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText(/1 message queued/)).toBeTruthy());
    expect(box.value).toBe("");
  });

  test("keeps the draft when a steer is refused", async () => {
    steerPipelineMock.mockRejectedValueOnce(new Error("The turn is not accepting steering"));
    renderTab();
    const box = screen.getByLabelText("Send a message to the agent") as HTMLTextAreaElement;

    fireEvent.change(box, { target: { value: "/steer try again" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("Failed to send the message", {
        description: "The turn is not accepting steering",
      }),
    );
    expect(box.value).toBe("/steer try again");
  });

  test("asks for instructions when /steer has none", () => {
    renderTab();
    const box = screen.getByLabelText("Send a message to the agent") as HTMLTextAreaElement;

    fireEvent.change(box, { target: { value: "/steer" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(mockToastError).toHaveBeenCalledWith("Add instructions after /steer.");
    expect(steerPipelineMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(box.value).toBe("/steer");
  });

  test("renders a compact ArrowUp send control", () => {
    renderTab();
    const button = screen.getByRole("button", { name: "Send message" });

    expect(button.getAttribute("data-size")).toBe("icon");
    expect(button.className).toContain("h-7");
    expect(button.className).toContain("w-7");
    expect(button.className).toContain("rounded-lg");
    expect(button.querySelector(".lucide-arrow-up")).toBeTruthy();
  });

  test("submits on Enter and inserts a newline on Shift+Enter", async () => {
    renderTab();
    const box = screen.getByLabelText("Send a message to the agent");

    fireEvent.change(box, { target: { value: "ship it" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(sendMessageMock).not.toHaveBeenCalled();

    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledWith(running.id, "ship it"));
  });

  test("does not queue the same text twice from a second Enter", async () => {
    let release: (() => void) | undefined;
    sendMessageMock.mockImplementationOnce(async (pipelineId: string) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        ...useBuildPipelineStore.getState().pipelines.get(pipelineId)!,
        pendingUserMessages: [],
        backendRevision: 53,
      };
    });
    renderTab();
    const box = screen.getByLabelText("Send a message to the agent");

    fireEvent.change(box, { target: { value: "ship it" } });
    fireEvent.keyDown(box, { key: "Enter" });
    // The send button disables itself, but the textarea stays focusable and
    // enabled — Enter is the path with no visible guard on it.
    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.keyDown(box, { key: "Enter" });

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      release?.();
    });
    expect((box as HTMLTextAreaElement).value).toBe("");
  });

  test("caps the draft at the length the backend will accept", () => {
    renderTab();
    const box = screen.getByLabelText("Send a message to the agent");

    // Truncating in the browser beats a rejected round trip that loses the text.
    expect(box.getAttribute("maxlength")).toBe(String(MAX_PIPELINE_USER_MESSAGE_LENGTH));
  });

  test("keeps the draft when the backend refuses the message", async () => {
    sendMessageMock.mockImplementationOnce(async () => {
      throw new Error("queue is full");
    });
    renderTab();
    const box = screen.getByLabelText("Send a message to the agent") as HTMLTextAreaElement;

    fireEvent.change(box, { target: { value: "do not lose me" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(sendMessageMock).toHaveBeenCalled());
    expect(mockToastError).toHaveBeenCalledWith("Failed to send the message", {
      description: "queue is full",
    });
    // Losing the user's typing on a transient failure is worse than the failure.
    expect(box.value).toBe("do not lose me");
  });

  test("formats a non-Error message rejection in the failure toast", async () => {
    sendMessageMock.mockRejectedValueOnce("queue disconnected");
    renderTab();
    const box = screen.getByLabelText("Send a message to the agent") as HTMLTextAreaElement;

    fireEvent.change(box, { target: { value: "keep this draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith("Failed to send the message", {
        description: "queue disconnected",
      });
    });
    expect(box.value).toBe("keep this draft");
  });

  test("refuses to send an empty or whitespace-only message", () => {
    renderTab();
    const button = screen.getByRole("button", {
      name: "Send message",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Send a message to the agent"), {
      target: { value: "   " },
    });
    expect(button.disabled).toBe(true);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  test("hides the compose box while the validation run is shown", () => {
    useBuildPipelineStore.getState().replacePipeline({
      ...running,
      validationRun: validationRun({ id: "validation-composer" }),
      backendRevision: 9,
    });
    renderTab();

    selectNode("Verify");
    expect(screen.getByLabelText("Send a message to the agent")).toBeTruthy();
    selectNode("Prepare");
    expect(screen.queryByLabelText("Send a message to the agent") === null).toBe(true);
    expect(screen.getByLabelText("Review validation")).toBeTruthy();
  });

  test("hides the compose box once the build has finished", () => {
    useBuildPipelineStore.setState({
      pipelines: new Map([[pipeline.id, pipeline]]),
      buildEnvironmentIds: new Set(["env-1"]),
    });
    renderTab();

    expect(screen.queryByLabelText("Send a message to the agent") === null).toBe(true);
  });

  test("hides the compose box while multi-model review owns the phase", () => {
    useBuildPipelineStore.setState({
      pipelines: new Map([
        [
          running.id,
          {
            ...running,
            phase: "reviewing",
            reviewers: [
              { agent: "claude", model: "opus" },
              { agent: "codex", model: "gpt-5.6" },
            ],
          },
        ],
      ]),
      buildEnvironmentIds: new Set(["env-1"]),
    });
    renderTab();

    expect(screen.queryByLabelText("Send a message to the agent") === null).toBe(true);
  });

  test("keeps the compose box hidden when multi-model review is paused", () => {
    useBuildPipelineStore.setState({
      pipelines: new Map([
        [
          running.id,
          {
            ...running,
            phase: "paused",
            pausedFromPhase: "reviewing",
            reviewers: [
              { agent: "claude", model: "opus" },
              { agent: "codex", model: "gpt-5.6" },
            ],
          },
        ],
      ]),
      buildEnvironmentIds: new Set(["env-1"]),
    });
    renderTab();

    expect(screen.queryByLabelText("Send a message to the agent") === null).toBe(true);
  });

  test("restarts the current stage through the backend", async () => {
    renderTab();

    fireEvent.click(screen.getByRole("button", { name: "Restart Build Stage" }));

    await waitFor(() => expect(restartCurrentStepMock).toHaveBeenCalledWith(running.id));
    await waitFor(() =>
      expect(useBuildPipelineStore.getState().pipelines.get(running.id)?.backendRevision).toBe(13),
    );
    expect(mockToastSuccess).toHaveBeenCalledWith("Build Stage restarted");
  });

  test("names the stage the pipeline is on rather than the review", async () => {
    useBuildPipelineStore.getState().replacePipeline({
      ...running,
      phase: "verifying",
      backendRevision: 60,
    });
    renderTab();

    expect(screen.queryByRole("button", { name: /^(Retry|Restart) Review/ }) === null).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Restart Verification Stage" }));

    await waitFor(() => expect(restartCurrentStepMock).toHaveBeenCalledWith(running.id));
  });

  test("restarts the stage a paused pipeline paused in", () => {
    useBuildPipelineStore.getState().replacePipeline({
      ...running,
      phase: "paused",
      pausedFromPhase: "verifying",
      backendRevision: 61,
    });
    renderTab();

    expect(screen.getByRole("button", { name: "Restart Verification Stage" })).toBeTruthy();
  });

  test.each([
    ["reviewing", "Restart Review Stage"],
    ["addressing", "Restart Address Stage"],
    ["fixing", "Restart Fix Stage"],
    ["creating-pr", "Restart PR Stage"],
    ["resolving-conflicts", "Restart Conflict Resolution"],
  ] as const)("names the %s header restart", (phase, label) => {
    useBuildPipelineStore.getState().replacePipeline({ ...running, phase });
    renderTab();

    expect(screen.getByRole("button", { name: label })).toBeTruthy();
  });

  test.each(["building", "fixing"] as const)("names validation during the %s phase", (phase) => {
    useBuildPipelineStore.getState().replacePipeline({
      ...running,
      phase,
      validationRun: validationRun({ status: "running" }),
    });
    renderTab();

    expect(screen.getByRole("button", { name: "Restart Validation" })).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: `Restart ${phase === "building" ? "Build" : "Fix"} Stage`,
      }) === null,
    ).toBe(true);
  });

  test.each(["cancelled", "retry"] as const)(
    "names review preparation after a %s validation run",
    (reason) => {
      useBuildPipelineStore.getState().replacePipeline({
        ...running,
        phase: "fixing",
        validationRun: validationRun({ status: reason === "cancelled" ? "cancelled" : "running" }),
        ...(reason === "retry" ? { reviewRetryRequested: true } : {}),
      });
      renderTab();

      expect(screen.getByRole("button", { name: "Restart Review Preparation" })).toBeTruthy();
    },
  );

  test("names the dedicated preparation session during a fix", () => {
    useBuildPipelineStore.getState().replacePipeline({
      ...running,
      phase: "fixing",
      sessions: [
        ...running.sessions,
        {
          ...running.sessions[0]!,
          phase: "fix",
          sessionKey: "preparation-key",
          sdkSessionId: "preparation-session",
          status: "running",
          label: REVIEW_PACKAGE_SESSION_LABEL,
        },
      ],
      currentSessionIndex: 2,
    });
    renderTab();

    expect(screen.getByRole("button", { name: "Restart Review Preparation" })).toBeTruthy();
  });

  test("offers review restart when a multi-review pipeline is paused", () => {
    useBuildPipelineStore.getState().replacePipeline({
      ...running,
      phase: "paused",
      pausedFromPhase: "reviewing",
      reviewers: [{ agent: "claude" }, { agent: "codex" }],
    });
    renderTab();

    expect(screen.getByRole("button", { name: "Restart Review Stage" })).toBeTruthy();
  });

  test("reports a queue of more than one message as a queue", () => {
    useBuildPipelineStore.getState().replacePipeline({
      ...running,
      pendingUserMessages: [
        { id: "q1", text: "one", createdAt: "2026-07-29T00:02:00.000Z" },
        { id: "q2", text: "two", createdAt: "2026-07-29T00:03:00.000Z" },
      ],
      backendRevision: 50,
    });
    renderTab();

    expect(screen.getByText(/2 messages queued/)).toBeTruthy();
    expect(screen.queryByText(/1 message queued/) === null).toBe(true);
  });

  test("disables the send button and shows progress while a send is in flight", async () => {
    let release: (() => void) | undefined;
    sendMessageMock.mockImplementationOnce(async (pipelineId: string) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        ...useBuildPipelineStore.getState().pipelines.get(pipelineId)!,
        pendingUserMessages: [],
        backendRevision: 51,
      };
    });
    renderTab();
    fireEvent.change(screen.getByLabelText("Send a message to the agent"), {
      target: { value: "hold on" },
    });

    const button = screen.getByRole("button", {
      name: "Send message",
    }) as HTMLButtonElement;
    fireEvent.click(button);

    // A second click would queue the same text twice.
    expect(button.disabled).toBe(true);
    const spinner = button.querySelector(".lucide-loader-circle");
    expect(spinner).toBeTruthy();
    expect(spinner?.classList.contains("h-3.5")).toBe(true);
    expect(spinner?.classList.contains("w-3.5")).toBe(true);
    expect(spinner?.classList.contains("animate-spin")).toBe(true);
    expect(button.querySelector(".lucide-arrow-up") === null).toBe(true);

    await act(async () => {
      release?.();
      await Promise.resolve();
    });
    expect(button.querySelector(".animate-spin") === null).toBe(true);
    expect(button.querySelector(".lucide-arrow-up")).toBeTruthy();
  });

  test("re-enables the restart control when the backend refuses a stage restart", async () => {
    restartCurrentStepMock.mockRejectedValueOnce(new Error("no running stage"));
    renderTab();

    const retry = screen.getByRole("button", {
      name: "Restart Build Stage",
    }) as HTMLButtonElement;
    fireEvent.click(retry);

    await waitFor(() => expect(restartCurrentStepMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(retry.disabled).toBe(false));
    expect(mockToastError).toHaveBeenCalledWith("Failed to restart the stage", {
      description: "no running stage",
    });
    expect(useBuildPipelineStore.getState().pipelines.get(running.id)?.phase).toBe("building");
  });

  test("formats a non-Error stage restart rejection", async () => {
    restartCurrentStepMock.mockRejectedValueOnce("provider offline");
    renderTab();

    fireEvent.click(screen.getByRole("button", { name: "Restart Build Stage" }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith("Failed to restart the stage", {
        description: "provider offline",
      });
    });
    expect(useBuildPipelineStore.getState().pipelines.get(running.id)?.phase).toBe("building");
  });

  test("follows the restarted stage instead of the stage the user was reading", async () => {
    renderTab();
    selectNode("Build");
    await waitFor(() => expect(screen.getByText("Implementation complete")).toBeTruthy());

    // A retry appends a new stage. Holding the pinned one would leave the user
    // watching a transcript that has stopped moving.
    restartCurrentStepMock.mockImplementationOnce(async (pipelineId: string) => {
      const current = useBuildPipelineStore.getState().pipelines.get(pipelineId)!;
      return {
        ...current,
        phase: "reviewing" as const,
        sessions: [
          ...current.sessions,
          {
            phase: "review" as const,
            iteration: 1,
            sessionKey: "retry-key",
            sdkSessionId: "retry-session",
            status: "idle" as const,
            startedAt: "2026-07-29T00:05:00.000Z",
            label: "Retry Review Session",
            messages: [
              {
                id: "retry-answer",
                role: "assistant",
                content: "Reviewing again",
              },
            ],
          },
        ],
        currentSessionIndex: current.sessions.length,
        backendRevision: 52,
      };
    });

    fireEvent.click(screen.getByRole("button", { name: "Restart Build Stage" }));

    await waitFor(() => expect(screen.getByText("Reviewing again")).toBeTruthy());
  });

  test("does not offer a stage restart before the first stage exists", () => {
    useBuildPipelineStore.setState({
      pipelines: new Map([
        [
          running.id,
          {
            ...running,
            sessions: [],
            currentSessionIndex: -1,
          },
        ],
      ]),
      buildEnvironmentIds: new Set(["env-1"]),
    });
    renderTab();

    expect(screen.queryByRole("button", { name: /^Restart/ }) === null).toBe(true);
  });
});

describe("BuildChatTab graph", () => {
  const createTab = mock((_type: string, _options?: CreateTabOptions) => true);

  /** Registers `createTab` the way the terminal container does. */
  function TabOpener() {
    const { setCreateTab } = useTerminalContext();
    useEffect(() => {
      setCreateTab(createTab);
      return () => setCreateTab(null);
    }, [setCreateTab]);
    return null;
  }

  function renderWithTabs(next: BuildPipeline) {
    useBuildPipelineStore.setState({
      pipelines: new Map([[next.id, next]]),
      buildEnvironmentIds: new Set([next.environmentId]),
      viewedSessionIds: new Map(),
    });
    return render(
      <TerminalProvider>
        <TabOpener />
        <BuildChatTab data={tabData} />
      </TerminalProvider>,
    );
  }

  const reviewingPanel: BuildPipeline = {
    ...pipeline,
    phase: "reviewing",
    reviewers: [
      { agent: "codex", model: "gpt-5.4" },
      { agent: "claude", model: "opus" },
    ],
    reviewFanout: {
      reviewers: [
        { id: "r1", agent: "codex", model: "gpt-5.4", status: "running", sessionKey: "rev-1" },
        {
          id: "r2",
          agent: "claude",
          model: "opus",
          status: "failed",
          error: "Reviewer exited\nwith a trace",
          sessionKey: "rev-2",
        },
      ],
    },
    sessions: [
      pipeline.sessions[0]!,
      {
        ...pipeline.sessions[0]!,
        phase: "review",
        sessionKey: "rev-1",
        sdkSessionId: "rev-1-session",
        label: pipelineIndependentReviewLabel(0),
        status: "running",
      },
      {
        ...pipeline.sessions[0]!,
        phase: "review",
        sessionKey: "rev-2",
        sdkSessionId: "rev-2-session",
        label: pipelineIndependentReviewLabel(1),
        reviewerOutcome: "failed",
        error: "Reviewer exited\nwith a trace",
      },
    ],
    currentSessionIndex: 2,
    backendRevision: 80,
  };

  beforeEach(() => {
    cleanup();
    createTab.mockClear();
    retryReviewerMock.mockClear();
    pauseBuildPipelineMock.mockClear();
    useFlowGraphViewStore.setState({ views: new Map(), collapsed: new Set() });
  });

  test("previews the steps a new pipeline definitely has ahead of it", () => {
    renderPipelineTab({
      ...pipeline,
      phase: "creating-environment",
      sessions: [],
      currentSessionIndex: 0,
    });

    expect(selectedTitle()).toBe("Setup");
    expect(graphNode("Setup").getAttribute("data-flow-state")).toBe("running");
    expect(nodeTitles()).toEqual(["Ticket", "Setup", "Build", "Review", "Verify", "Ship", "PR"]);
    for (const title of ["Build", "Review", "Verify", "Ship", "PR"]) {
      expect(graphNode(title).hasAttribute("data-flow-placeholder")).toBe(true);
    }
    // Address, Fix and conflict resolution only appear once they start.
    expect(queryGraphNode("Address") === null).toBe(true);
    expect(queryGraphNode("Fix") === null).toBe(true);
  });

  test("shows only the pull request ahead while the pipeline ships", () => {
    renderPipelineTab({
      ...pipeline,
      phase: "creating-pr",
      verificationResult: "pass",
      sessions: [
        ...pipeline.sessions,
        {
          ...pipeline.sessions[1]!,
          phase: "pr",
          sessionKey: "pr-key",
          sdkSessionId: "pr-session",
          label: "PR Creation Session",
          status: "running",
          startedAt: "2026-07-29T00:02:00.000Z",
        },
      ],
      currentSessionIndex: 2,
    });

    expect(selectedTitle()).toBe("Ship");
    expect(nodeTitles().slice(-2)).toEqual(["Ship", "PR"]);
    expect(graphNode("PR").hasAttribute("data-flow-placeholder")).toBe(true);
    expect(queryGraphNode("Resolve conflicts") === null).toBe(true);
  });

  test("says the newest verification's verdict", () => {
    renderPipelineTab({
      ...reviewed,
      verificationResult: "pass",
      verificationFeedback: "Every criterion holds.",
    });

    expect(selectedTitle()).toBe("Verify");
    expect(within(inspector()).getByText("Verdict: passed")).toBeTruthy();
  });

  test("ticks a running node's runtime and stops its clock when paused", () => {
    let now = Date.parse("2026-07-29T00:02:00.000Z");
    const dateNow = spyOn(Date, "now").mockImplementation(() => now);
    const setIntervalSpy = spyOn(window, "setInterval");
    const clearIntervalSpy = spyOn(window, "clearInterval");
    try {
      const running = {
        ...pipeline,
        phase: "building" as const,
        sessions: [{ ...pipeline.sessions[0]!, status: "running" as const }],
        currentSessionIndex: 0,
        backendRevision: 70,
      };
      renderPipelineTab(running, { isActive: true });
      const runtime = () => screen.getByLabelText("Build runtime and token usage").textContent;
      expect(runtime()).toBe("2m 0s · —");
      const tick = setIntervalSpy.mock.calls.find(([, timeout]) => timeout === 1_000)?.[0];
      expect(typeof tick).toBe("function");

      now += 5_000;
      act(() => {
        if (typeof tick === "function") tick();
      });
      expect(runtime()).toBe("2m 5s · —");

      act(() => {
        useBuildPipelineStore.getState().replacePipeline({
          ...running,
          phase: "paused",
          pausedFromPhase: "building",
          sessions: [
            { ...running.sessions[0]!, status: "idle", completedAt: new Date(now).toISOString() },
          ],
          backendRevision: 71,
        });
      });
      expect(clearIntervalSpy).toHaveBeenCalled();
      expect(graphNode("Build").getAttribute("data-flow-state")).toBe("paused");
      now += 5_000;
      act(() => {
        if (typeof tick === "function") tick();
      });
      expect(runtime()).toBe("2m 5s");
    } finally {
      clearIntervalSpy.mockRestore();
      setIntervalSpy.mockRestore();
      dateNow.mockRestore();
    }
  });

  test("double-clicking a node opens its session in a tab of its own", () => {
    renderWithTabs(pipeline);

    fireEvent.doubleClick(graphNode("Build"));

    expect(createTab).toHaveBeenCalledTimes(1);
    const [type, options] = createTab.mock.calls[0]!;
    expect(type).toBe("codex");
    expect(options).toMatchObject({
      resumeSessionId: "build-session",
      requireExistingResumeSession: true,
      activateExistingTab: true,
    });
  });

  test("opens a session from the node's context menu", async () => {
    renderWithTabs(pipeline);

    fireEvent.contextMenu(graphNode("Verify"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Open session" }));

    expect(createTab.mock.calls[0]?.[1]).toMatchObject({ resumeSessionId: "verify-session" });
  });

  test("shows a failed reviewer's error and retries it from its context menu", async () => {
    renderPipelineTab(reviewingPanel);

    const failed = graphNode("Reviewer 2");
    expect(failed.getAttribute("data-flow-state")).toBe("failed");
    // The face shows the first line; the description keeps the rest.
    expect(failed.querySelector("[data-flow-node-error]")?.textContent).toBe("Reviewer exited");
    expect(document.getElementById(failed.getAttribute("aria-describedby")!)?.textContent).toBe(
      "Reviewer exited\nwith a trace",
    );
    fireEvent.contextMenu(failed);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Retry reviewer" }));

    await waitFor(() => expect(retryReviewerMock).toHaveBeenCalledWith(pipeline.id, "r2"));
  });

  test("opens a review pass as a Multi Review tab from the inspector", () => {
    renderWithTabs(reviewingPanel);

    selectNode("Reviewer 1");
    fireEvent.click(
      within(inspector()).getByRole("button", { name: "Open review as Multi Review" }),
    );

    expect(createTab).toHaveBeenCalledWith(
      "multi-review",
      expect.objectContaining({
        multiReviewId: pipeline.id,
        multiReviewPipelinePass: expect.any(String),
      }),
    );
  });

  test("pauses the pipeline from a node's context menu", async () => {
    renderPipelineTab({ ...pipeline, phase: "building", backendRevision: 81 });

    fireEvent.contextMenu(graphNode("Build"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Pause pipeline" }));

    await waitFor(() => expect(pauseBuildPipelineMock).toHaveBeenCalledWith(pipeline.id));
  });

  test("collapses the graph and remembers it for the pipeline", () => {
    const view = renderPipelineTab(reviewed);
    const toggle = screen.getByRole("button", { name: "Pipeline" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("tablist", { name: "Build pipeline" }) === null).toBe(true);
    // The inspector keeps showing the selected step.
    expect(screen.getByText("All criteria pass")).toBeTruthy();

    view.unmount();
    renderPipelineTab(reviewed);
    expect(screen.getByRole("button", { name: "Pipeline" }).getAttribute("aria-expanded")).toBe(
      "false",
    );
    fireEvent.click(screen.getByRole("button", { name: "Pipeline" }));
    expect(graphNode("Build")).toBeTruthy();
  });

  test("the Ticket node shows the ticket the build started with", () => {
    renderPipelineTab({
      ...pipeline,
      taskSnapshot: {
        title: "Backend-owned build",
        description: "Move the **pipeline** into the backend.",
        acceptanceCriteria: "",
        comments: [],
        images: [],
      },
    });

    selectNode("Ticket");
    const ticket = screen.getByTestId("pipeline-ticket");
    expect(within(ticket).getByRole("heading", { name: "Backend-owned build" })).toBeTruthy();
    expect(within(ticket).getByRole("region", { name: "Description" })).toBeTruthy();
    expect(within(ticket).queryByRole("region", { name: "Acceptance criteria" }) === null).toBe(
      true,
    );
    expect(screen.queryByText(/You are building a feature/) === null).toBe(true);
  });

  test("the PR node shows the environment's pull request once the pipeline shipped", () => {
    useEnvironmentStore.setState({
      environments: [
        { id: "env-1", prUrl: "https://github.com/acme/widget/pull/7", prState: "open" },
      ],
    } as never);
    try {
      renderPipelineTab({
        ...pipeline,
        sessions: [
          ...pipeline.sessions,
          {
            ...pipeline.sessions[1]!,
            phase: "pr",
            sessionKey: "pr-key",
            sdkSessionId: "pr-session",
          },
        ],
        currentSessionIndex: 2,
      });

      expect(graphNode("PR").getAttribute("data-flow-state")).toBe("complete");
      expect(within(graphNode("PR")).getByText("acme/widget/pull/7")).toBeTruthy();
      selectNode("PR");
      expect(screen.getByTestId("pipeline-pr-state").textContent).toBe("Open");
    } finally {
      useEnvironmentStore.setState({ environments: [] } as never);
    }
  });
});
