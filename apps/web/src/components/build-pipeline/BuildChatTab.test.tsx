import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MAX_PIPELINE_USER_MESSAGE_LENGTH } from "@orkestrator/protocol/build-pipeline";
import { useBuildPipelineStore, type BuildPipeline } from "@/stores/buildPipelineStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import * as realBackend from "@/lib/backend";
import * as realVirtualizedMessageList from "@/components/chat/VirtualizedMessageList";
import { TEST_STRUCTURED_REVIEW_REPORT } from "./structured-review-test-fixture";

const realBackendSnapshot = { ...realBackend };
const realVirtualizedMessageListSnapshot = { ...realVirtualizedMessageList };

/**
 * The props the tab handed the transcript list on its last render.
 *
 * `computeItemKey`, `find` and the scroll wiring are the list's contract with
 * the tab and never reach the DOM, so the stub records them rather than letting
 * them go unasserted.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let listProps: any = null;

/*
 * react-virtuoso measures a real viewport, so its rows never render under
 * happy-dom. Every native chat tab's suite stubs it the same way to assert on
 * the transcript the shared renderer produced.
 */
mock.module("@/components/chat/VirtualizedMessageList", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  VirtualizedMessageList: (props: any) => {
    listProps = props;
    const { messages, renderMessage, emptyState, footer } = props;
    return (
      <div>
        {messages.length === 0 ? emptyState : null}
        {messages.map((message: unknown, index: number) => (
          <div key={index}>
            {renderMessage(index, message, index > 0 ? messages[index - 1] : null)}
          </div>
        ))}
        {footer}
      </div>
    );
  },
}));
const pauseBuildPipelineMock = mock(async (pipelineId: string) => ({
  ...useBuildPipelineStore.getState().pipelines.get(pipelineId)!,
  phase: "paused" as const,
  backendRevision: 9,
}));
const resumeBuildPipelineMock = mock(async (pipelineId: string) => ({
  ...useBuildPipelineStore.getState().pipelines.get(pipelineId)!,
  phase: "building" as const,
  backendRevision: 10,
}));
const cancelBuildPipelineMock = mock(async (pipelineId: string) => ({
  ...useBuildPipelineStore.getState().pipelines.get(pipelineId)!,
  phase: "failed" as const,
  error: "Build cancelled",
  backendRevision: 11,
}));
const sendMessageMock = mock(async (pipelineId: string, text: string) => ({
  ...useBuildPipelineStore.getState().pipelines.get(pipelineId)!,
  pendingUserMessages: [
    { id: "queued-1", text, createdAt: "2026-07-29T00:02:00.000Z" },
  ],
  backendRevision: 12,
}));
const retryReviewMock = mock(async (pipelineId: string) => ({
  ...useBuildPipelineStore.getState().pipelines.get(pipelineId)!,
  phase: "reviewing" as const,
  backendRevision: 13,
}));
const getBuildPipelineConditionalMock = mock(
  async (_pipelineId: string) => null as unknown,
);

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  pauseBuildPipeline: pauseBuildPipelineMock,
  resumeBuildPipeline: resumeBuildPipelineMock,
  cancelBuildPipeline: cancelBuildPipelineMock,
  sendBuildPipelineMessage: sendMessageMock,
  retryBuildPipelineReview: retryReviewMock,
  getBuildPipelineConditional: getBuildPipelineConditionalMock,
}));

const { BuildChatTab } = await import("./BuildChatTab");

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
  mock.module(
    "@/components/chat/VirtualizedMessageList",
    () => realVirtualizedMessageListSnapshot,
  );
});

const pipeline: BuildPipeline = {
  id: "pipeline-1",
  taskId: "task-1",
  projectId: "project-1",
  environmentId: "env-1",
  environmentType: "local",
  agentType: "codex",
  phase: "complete",
  sessions: [
    {
      phase: "build",
      iteration: 0,
      sessionKey: "build-key",
      sdkSessionId: "build-session",
      status: "idle",
      startedAt: "2026-07-29T00:00:00.000Z",
      label: "Build Session",
      messages: [{
        id: "answer-1",
        role: "assistant",
        parts: [{ type: "text", content: "Implementation complete" }],
      }],
    },
    {
      phase: "verify",
      iteration: 0,
      sessionKey: "verify-key",
      sdkSessionId: "verify-session",
      status: "idle",
      startedAt: "2026-07-29T00:01:00.000Z",
      label: "Verification Session",
      messages: [{
        info: { id: "answer-2", role: "assistant" },
        parts: [{ type: "text", text: "All criteria pass" }],
      }],
    },
  ],
  currentSessionIndex: 1,
  iteration: 0,
  maxIterations: 3,
  createdAt: "2026-07-29T00:00:00.000Z",
  taskTitle: "Backend-owned build",
  taskSnapshot: {
    title: "Backend-owned build",
    description: "",
    acceptanceCriteria: "",
    comments: [],
    images: [],
  },
  backendRevision: 8,
  controller: "backend",
};

describe("BuildChatTab backend projection", () => {
  beforeEach(() => {
    cleanup();
    pauseBuildPipelineMock.mockClear();
    resumeBuildPipelineMock.mockClear();
    cancelBuildPipelineMock.mockClear();
    sendMessageMock.mockClear();
    retryReviewMock.mockClear();
    getBuildPipelineConditionalMock.mockClear();
    getBuildPipelineConditionalMock.mockImplementation(async () => null);
    useBuildPipelineStore.setState({
      pipelines: new Map([[pipeline.id, pipeline]]),
      buildEnvironmentIds: new Set([pipeline.environmentId]),
    });
  });

  test("renders the same backend sessions and transcripts for every client", () => {
    render(<BuildChatTab data={{
      pipelineId: pipeline.id,
      environmentId: pipeline.environmentId,
      taskId: pipeline.taskId,
      isLocal: true,
    }} />);

    expect(screen.getByText("Backend-owned build")).toBeTruthy();
    expect(screen.getByText("All criteria pass")).toBeTruthy();
    fireEvent.click(screen.getByText("Build Session"));
    expect(screen.getByText("Implementation complete")).toBeTruthy();
  });

  test("renders loading and empty-stage states from incomplete snapshots", () => {
    useBuildPipelineStore.setState({
      pipelines: new Map(),
      buildEnvironmentIds: new Set(),
    });
    const { rerender } = render(<BuildChatTab data={{
      pipelineId: "missing",
      environmentId: "env-1",
      taskId: "task-1",
      isLocal: true,
    }} />);
    expect(screen.getByText("Loading build pipeline…")).toBeTruthy();

    useBuildPipelineStore.getState().replacePipeline({
      ...pipeline,
      id: "empty",
      phase: "building",
      sessions: [],
      currentSessionIndex: -1,
      backendRevision: 9,
    });
    rerender(<BuildChatTab data={{
      pipelineId: "empty",
      environmentId: "env-1",
      taskId: "task-1",
      isLocal: true,
    }} />);
    expect(screen.getByText("The backend is preparing the first stage.")).toBeTruthy();
    expect(screen.getByText("Waiting for the backend to start a build stage.")).toBeTruthy();
  });

  test("ignores malformed transcript entries and renders terminal errors", () => {
    useBuildPipelineStore.getState().replacePipeline({
      ...pipeline,
      id: "malformed",
      phase: "failed",
      error: "Verification crashed",
      sessions: [{
        ...pipeline.sessions[0]!,
        status: "error",
        messages: [null, 42, {}, { content: [] }] as unknown[],
      }],
      currentSessionIndex: 0,
      backendRevision: 9,
    });
    render(<BuildChatTab data={{
      pipelineId: "malformed",
      environmentId: "env-1",
      taskId: "task-1",
      isLocal: true,
    }} />);

    expect(screen.getByText("Verification crashed")).toBeTruthy();
    expect(screen.getByText("No text transcript was produced for this stage.")).toBeTruthy();
  });

  test("runs pause, resume, and cancel controls against authoritative backend snapshots", async () => {
    useBuildPipelineStore.getState().replacePipeline({
      ...pipeline,
      phase: "building",
      backendRevision: 9,
    });
    const data = {
      pipelineId: pipeline.id,
      environmentId: pipeline.environmentId,
      taskId: pipeline.taskId,
      isLocal: true,
    };
    render(<BuildChatTab data={data} />);

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(pauseBuildPipelineMock).toHaveBeenCalledWith(pipeline.id));
    await waitFor(() => expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(resumeBuildPipelineMock).toHaveBeenCalledWith(pipeline.id));
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(cancelBuildPipelineMock).toHaveBeenCalledWith(pipeline.id));
    await waitFor(() => expect(screen.getByText("Build cancelled")).toBeTruthy());
  });

  test("re-enables a control when the backend rejects it", async () => {
    useBuildPipelineStore.getState().replacePipeline({
      ...pipeline,
      phase: "building",
      backendRevision: 9,
    });
    pauseBuildPipelineMock.mockRejectedValueOnce(new Error("pause unavailable"));
    render(<BuildChatTab data={{
      pipelineId: pipeline.id,
      environmentId: pipeline.environmentId,
      taskId: pipeline.taskId,
      isLocal: true,
    }} />);

    const pause = screen.getByRole("button", { name: "Pause" }) as HTMLButtonElement;
    fireEvent.click(pause);
    await waitFor(() => expect(pauseBuildPipelineMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(pause.disabled).toBe(false));
    expect(useBuildPipelineStore.getState().pipelines.get(pipeline.id)?.phase).toBe(
      "building",
    );
  });

  test("sends one control request however fast the button is clicked", async () => {
    let release: (() => void) | undefined;
    pauseBuildPipelineMock.mockImplementationOnce(async (pipelineId: string) => {
      await new Promise<void>((resolve) => { release = resolve; });
      return {
        ...useBuildPipelineStore.getState().pipelines.get(pipelineId)!,
        phase: "paused" as const,
        backendRevision: 14,
      };
    });
    useBuildPipelineStore.getState().replacePipeline({
      ...pipeline,
      phase: "building",
      backendRevision: 9,
    });
    render(<BuildChatTab data={{
      pipelineId: pipeline.id,
      environmentId: pipeline.environmentId,
      taskId: pipeline.taskId,
      isLocal: true,
    }} />);

    const pause = screen.getByRole("button", { name: "Pause" }) as HTMLButtonElement;
    fireEvent.click(pause);
    // The disabled attribute alone is not the guard — a click dispatched before
    // React commits it would still reach the handler and pause twice.
    fireEvent.click(pause);
    await waitFor(() => expect(pause.disabled).toBe(true));
    fireEvent.click(pause);

    expect(pauseBuildPipelineMock).toHaveBeenCalledTimes(1);
    await act(async () => { release?.(); });
    expect(useBuildPipelineStore.getState().pipelines.get(pipeline.id)?.phase)
      .toBe("paused");
  });

  test("surfaces persisted GitHub completion-comment recovery in the build tab", () => {
    useBuildPipelineStore.getState().replacePipeline({
      ...pipeline,
      source: {
        type: "github",
        repositoryOwner: "acme",
        repositoryName: "widget",
        issueNumber: 42,
        issueUrl: "https://github.com/acme/widget/issues/42",
        status: "closed",
      },
      completionCommentStatus: "failed",
      completionCommentError: "GitHub unavailable",
      backendRevision: 9,
    });
    render(<BuildChatTab data={{
      pipelineId: pipeline.id,
      environmentId: pipeline.environmentId,
      taskId: pipeline.taskId,
      isLocal: true,
    }} />);

    expect(screen.getByText(/GitHub completion comment failed/)).toBeTruthy();
    expect(screen.getByRole("button", {
      name: "Retry GitHub completion comment",
    })).toBeTruthy();
  });
});

describe("BuildChatTab presentation", () => {
  const reviewSession: BuildPipeline["sessions"][number] = {
    phase: "review",
    iteration: 0,
    sessionKey: "review-key",
    sdkSessionId: "review-session",
    status: "idle",
    startedAt: "2026-07-29T00:00:30.000Z",
    label: "Review Session",
    structuredRequestId: "review-request",
    messages: [{
      id: "review-answer",
      role: "assistant",
      content: "The review is complete",
      parts: [
        { type: "text", content: "The review is complete" },
        {
          type: "tool-invocation",
          content: "shell",
          toolName: "shell",
          toolArgs: { command: "git diff --stat" },
          toolState: "success",
          toolOutput: "1 file changed",
        },
      ],
    }],
  };
  const reviewed: BuildPipeline = {
    ...pipeline,
    sessions: [pipeline.sessions[0]!, reviewSession, pipeline.sessions[1]!],
    currentSessionIndex: 2,
    structuredReview: TEST_STRUCTURED_REVIEW_REPORT,
    structuredReviewRequestId: "review-request",
    backendRevision: 40,
  };

  function renderTab(next: BuildPipeline) {
    useBuildPipelineStore.setState({
      pipelines: new Map([[next.id, next]]),
      buildEnvironmentIds: new Set([next.environmentId]),
    });
    render(<BuildChatTab data={{
      pipelineId: next.id,
      environmentId: next.environmentId,
      taskId: next.taskId,
      isLocal: true,
    }} />);
  }

  beforeEach(cleanup);

  test("marks the shown stage as selected in the stage list", async () => {
    renderTab(reviewed);

    const selected = () =>
      screen.getAllByRole("tab")
        .filter((tab) => tab.getAttribute("aria-selected") === "true")
        .map((tab) => tab.textContent);

    // The pipeline is followed to its current stage until the user picks one.
    expect(selected()).toEqual([expect.stringContaining("Verification Session")]);

    fireEvent.click(screen.getByText("Build Session"));
    await waitFor(() =>
      expect(selected()).toEqual([expect.stringContaining("Build Session")]));
  });

  test("renders tool activity through the shared transcript components", () => {
    renderTab(reviewed);
    fireEvent.click(screen.getByText("Review Session"));

    // The tool row, not a flattened dump of every part's text.
    expect(screen.getByText("Shell")).toBeTruthy();
    expect(screen.getByText("git diff --stat")).toBeTruthy();
    expect(screen.getByText("The review is complete")).toBeTruthy();
    expect(screen.queryByText(/"toolArgs"/)).toBeNull();
  });

  test("shows the structured review report only on the stage that produced it", async () => {
    renderTab(reviewed);
    const reportLabel = "Structured review report";

    // The pipeline is following its verification stage, which did not review.
    expect(screen.queryByLabelText(reportLabel)).toBeNull();

    fireEvent.click(screen.getByText("Review Session"));
    await waitFor(() => expect(screen.getByLabelText(reportLabel)).toBeTruthy());

    fireEvent.click(screen.getByText("Build Session"));
    await waitFor(() => expect(screen.queryByLabelText(reportLabel)).toBeNull());
  });

  test("keeps the report's sections collapsed and its JSON out of the transcript", async () => {
    renderTab(reviewed);
    fireEvent.click(screen.getByText("Review Session"));
    await waitFor(() =>
      expect(screen.getByLabelText("Structured review report")).toBeTruthy());

    expect(screen.queryByRole("button", { name: /Inspect raw JSON/ })).toBeNull();
    expect(screen.queryByLabelText("Raw structured review JSON")).toBeNull();
    expect(screen.queryByText("Updates the review workflow.")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /What Changed/ }));
    await waitFor(() =>
      expect(screen.getByText("Updates the review workflow.")).toBeTruthy());
  });

  test("falls back to the newest review stage for a report with no request id", async () => {
    renderTab({
      ...reviewed,
      structuredReviewRequestId: undefined,
      sessions: reviewed.sessions.map((session) =>
        session.sessionKey === "review-key"
          ? { ...session, structuredRequestId: undefined }
          : session
      ),
      backendRevision: 41,
    });

    fireEvent.click(screen.getByText("Review Session"));
    await waitFor(() =>
      expect(screen.getByLabelText("Structured review report")).toBeTruthy());
  });

  test("falls back to the newest review stage when the request id matches none", async () => {
    // A pipeline can outlive the session its report was requested from. The
    // report is still real, so it must land somewhere rather than vanish.
    renderTab({
      ...reviewed,
      structuredReviewRequestId: "a-request-no-session-claims",
      backendRevision: 46,
    });

    const hint = screen.getByRole("button", { name: /The review reported/ });
    expect(hint.textContent).toContain("Review Session");

    fireEvent.click(hint);
    await waitFor(() =>
      expect(screen.getByLabelText("Structured review report")).toBeTruthy());
  });

  test("moves between stages with the arrow keys, as a tablist promises", async () => {
    renderTab(reviewed);
    const tablist = screen.getByRole("tablist");
    const selected = () =>
      screen.getAllByRole("tab")
        .find((tab) => tab.getAttribute("aria-selected") === "true")
        ?.textContent ?? null;

    expect(selected()).toContain("Verification Session");

    // `aria-orientation="vertical"` advertises Up/Down specifically.
    fireEvent.keyDown(tablist, { key: "ArrowUp" });
    await waitFor(() => expect(selected()).toContain("Review Session"));
    expect(screen.getByText("The review is complete")).toBeTruthy();

    fireEvent.keyDown(tablist, { key: "ArrowDown" });
    await waitFor(() => expect(selected()).toContain("Verification Session"));

    fireEvent.keyDown(tablist, { key: "Home" });
    await waitFor(() => expect(selected()).toContain("Build Session"));

    fireEvent.keyDown(tablist, { key: "End" });
    await waitFor(() => expect(selected()).toContain("Verification Session"));

    // A tablist wraps rather than stopping at its ends.
    fireEvent.keyDown(tablist, { key: "ArrowDown" });
    await waitFor(() => expect(selected()).toContain("Build Session"));
  });

  test("holds the arrow-key stage the same way it holds a clicked one", async () => {
    renderTab(reviewed);
    const tablist = screen.getByRole("tablist");

    fireEvent.keyDown(tablist, { key: "Home" });
    await waitFor(() =>
      expect(screen.getByText("Implementation complete")).toBeTruthy());

    // Selecting from the keyboard is a choice, not an auto-follow, so a later
    // backend push must not drag the user off the stage they picked.
    act(() => {
      useBuildPipelineStore.getState().replacePipeline({
        ...reviewed,
        currentSessionIndex: 1,
        backendRevision: 47,
      });
    });

    expect(screen.getByText("Implementation complete")).toBeTruthy();
    expect(screen.queryByText("The review is complete")).toBeNull();
  });

  test("keeps one stage in the page tab sequence, not all of them", async () => {
    renderTab(reviewed);
    const tabStops = () =>
      screen.getAllByRole("tab")
        .filter((tab) => tab.getAttribute("tabindex") === "0")
        .map((tab) => tab.textContent);

    // Otherwise Tab walks every stage before reaching the transcript.
    expect(tabStops()).toEqual([expect.stringContaining("Verification Session")]);

    fireEvent.click(screen.getByText("Build Session"));
    await waitFor(() =>
      expect(tabStops()).toEqual([expect.stringContaining("Build Session")]));
  });

  test("ignores keys that mean nothing to a tablist", () => {
    renderTab(reviewed);
    const tablist = screen.getByRole("tablist");
    const selected = () =>
      screen.getAllByRole("tab")
        .find((tab) => tab.getAttribute("aria-selected") === "true")
        ?.textContent ?? null;

    fireEvent.keyDown(tablist, { key: "a" });
    fireEvent.keyDown(tablist, { key: "PageDown" });
    fireEvent.keyDown(tablist, { key: "Enter" });

    expect(selected()).toContain("Verification Session");
  });

  test("points at the stage holding the report while showing another", async () => {
    renderTab(reviewed);

    // The tab follows the pipeline past review, so without this nothing on
    // screen would say a review had happened at all.
    const hint = screen.getByRole("button", { name: /The review reported/ });
    expect(hint.textContent).toContain("1 issue");
    expect(hint.textContent).toContain("Review Session");

    fireEvent.click(hint);
    await waitFor(() =>
      expect(screen.getByLabelText("Structured review report")).toBeTruthy());
    // Once the report is on screen the pointer to it is redundant.
    expect(screen.queryByRole("button", { name: /The review reported/ })).toBeNull();
  });

  test("badges the stage that holds the report, and only that stage", () => {
    renderTab(reviewed);

    const badged = screen.getAllByRole("tab")
      .filter((tab) => tab.textContent?.includes("Report · 1 issue"))
      .map((tab) => tab.textContent);
    expect(badged).toEqual([expect.stringContaining("Review Session")]);
  });

  test("says nothing about a review for a pipeline that has not had one", () => {
    renderTab({ ...pipeline, backendRevision: 42 });

    expect(screen.queryByRole("button", { name: /The review reported/ })).toBeNull();
    expect(screen.queryByText(/Report ·/)).toBeNull();
  });

  test("names the transcript panel after the stage whose tab is selected", async () => {
    renderTab(reviewed);
    const panel = screen.getByRole("tabpanel");
    const selectedTabId = () =>
      screen.getAllByRole("tab")
        .find((tab) => tab.getAttribute("aria-selected") === "true")?.id ?? null;

    expect(panel.getAttribute("aria-labelledby")).toBe(selectedTabId());

    fireEvent.click(screen.getByText("Review Session"));
    await waitFor(() =>
      expect(panel.getAttribute("aria-labelledby")).toBe(selectedTabId()));
    // Two build tabs can be mounted at once, so the ids cannot be constants.
    expect(panel.id).not.toBe("build-stage-transcript");
    expect(screen.getAllByRole("tab").every((tab) => tab.id.length > 0)).toBe(true);
  });

  test("distinguishes a running stage from a failed one in the stage list", () => {
    renderTab({
      ...reviewed,
      sessions: [
        { ...reviewed.sessions[0]!, status: "error" },
        { ...reviewed.sessions[1]!, status: "running", messages: [] },
      ],
      currentSessionIndex: 1,
      backendRevision: 43,
    });

    const [failed, running] = screen.getAllByRole("tab");
    expect(failed!.querySelector(".text-destructive")).toBeTruthy();
    expect(running!.querySelector(".animate-spin")).toBeTruthy();
    // A running stage with nothing synchronized yet says so.
    expect(screen.getByText(/This stage is running/)).toBeTruthy();
  });
});

describe("BuildChatTab transcript wiring", () => {
  beforeEach(() => {
    cleanup();
    listProps = null;
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
    render(<BuildChatTab
      data={{
        pipelineId: pipeline.id,
        environmentId: pipeline.environmentId,
        taskId: pipeline.taskId,
        isLocal: true,
      }}
      {...props}
    />);
  }

  test("keys each row on its message id so a re-render does not remount it", () => {
    renderTab();

    expect(listProps.messages.map((message: { id: string }) => message.id))
      .toEqual(["answer-2"]);
    expect(listProps.computeItemKey(0, listProps.messages[0])).toBe("answer-2");
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

describe("BuildChatTab rehydration", () => {
  beforeEach(() => {
    cleanup();
    getBuildPipelineConditionalMock.mockClear();
    getBuildPipelineConditionalMock.mockImplementation(async () => null);
    useBuildPipelineStore.setState({
      pipelines: new Map(),
      buildEnvironmentIds: new Set(),
    });
  });

  test("fetches the authoritative snapshot when the store has none", async () => {
    // App hydrates pipelines once per project. If that never ran for this
    // project or failed, the tab would otherwise sit on its loading state
    // forever with no way back — the rehydrate-on-mount invariant.
    getBuildPipelineConditionalMock.mockImplementation(async () => ({
      version: 2,
      id: pipeline.id,
      projectId: pipeline.projectId,
      environmentId: pipeline.environmentId,
      snapshot: pipeline,
      revision: 8,
      updatedAt: "2026-07-29T00:00:00.000Z",
    }));

    render(<BuildChatTab data={{
      environmentId: "env-1",
      pipelineId: pipeline.id,
      taskId: "task-1",
      isLocal: true,
    }} />);

    expect(screen.getByText("Loading build pipeline…")).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText("Backend-owned build")).toBeTruthy();
    });
    expect(getBuildPipelineConditionalMock).toHaveBeenCalledWith(
      pipeline.id,
      undefined,
      undefined,
    );
  });

  test("does not refetch in a loop when the pipeline genuinely does not exist", async () => {
    render(<BuildChatTab data={{
      environmentId: "env-1",
      pipelineId: "missing",
      taskId: "task-1",
      isLocal: true,
    }} />);

    await waitFor(() =>
      expect(getBuildPipelineConditionalMock).toHaveBeenCalledTimes(1)
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getBuildPipelineConditionalMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Loading build pipeline…")).toBeTruthy();
  });

  test("does not fetch when the store already has the snapshot", async () => {
    useBuildPipelineStore.setState({
      pipelines: new Map([[pipeline.id, pipeline]]),
      buildEnvironmentIds: new Set(["env-1"]),
    });

    render(<BuildChatTab data={{
      environmentId: "env-1",
      pipelineId: pipeline.id,
      taskId: "task-1",
      isLocal: true,
    }} />);

    expect(screen.getByText("Backend-owned build")).toBeTruthy();
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
    render(<BuildChatTab data={{
      environmentId: "env-1",
      pipelineId: pipeline.id,
      taskId: "task-1",
      isLocal: true,
    }} />);
    expect(screen.getByText("Implementation complete")).toBeTruthy();

    // The backend advances to the verification stage.
    renderWith({ ...pipeline, phase: "verifying" });

    await waitFor(() => {
      expect(screen.getByText("All criteria pass")).toBeTruthy();
    });
  });

  test("holds a stage the user selected even as the pipeline advances", async () => {
    renderWith({ ...pipeline, phase: "verifying" });
    render(<BuildChatTab data={{
      environmentId: "env-1",
      pipelineId: pipeline.id,
      taskId: "task-1",
      isLocal: true,
    }} />);
    await waitFor(() => expect(screen.getByText("All criteria pass")).toBeTruthy());

    fireEvent.click(screen.getByText("Build Session"));
    await waitFor(() =>
      expect(screen.getByText("Implementation complete")).toBeTruthy());

    // A new snapshot arrives; the explicit choice must survive it.
    renderWith({ ...pipeline, phase: "complete", backendRevision: 20 });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.getByText("Implementation complete")).toBeTruthy();
  });

  test("resumes following when the selected stage leaves the snapshot", async () => {
    render(<BuildChatTab data={{
      environmentId: "env-1",
      pipelineId: pipeline.id,
      taskId: "task-1",
      isLocal: true,
    }} />);
    fireEvent.click(screen.getByText("Build Session"));
    await waitFor(() =>
      expect(screen.getByText("Implementation complete")).toBeTruthy());

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
    retryReviewMock.mockClear();
    useBuildPipelineStore.setState({
      pipelines: new Map([[running.id, running]]),
      buildEnvironmentIds: new Set(["env-1"]),
    });
  });

  function renderTab() {
    render(<BuildChatTab data={{
      environmentId: "env-1",
      pipelineId: running.id,
      taskId: "task-1",
      isLocal: true,
    }} />);
  }

  test("queues a message through the backend and clears the box", async () => {
    renderTab();
    const box = screen.getByLabelText("Send a message to the agent") as HTMLTextAreaElement;

    fireEvent.change(box, { target: { value: "  also update the README  " } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(sendMessageMock).toHaveBeenCalledWith(
        running.id,
        "also update the README",
      ));
    await waitFor(() => expect(box.value).toBe(""));
    // The authoritative reply is installed, so the queue depth is visible.
    await waitFor(() =>
      expect(screen.getByText(/1 message queued/)).toBeTruthy());
  });

  test("submits on Enter and inserts a newline on Shift+Enter", async () => {
    renderTab();
    const box = screen.getByLabelText("Send a message to the agent");

    fireEvent.change(box, { target: { value: "ship it" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(sendMessageMock).not.toHaveBeenCalled();

    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() =>
      expect(sendMessageMock).toHaveBeenCalledWith(running.id, "ship it"));
  });

  test("does not queue the same text twice from a second Enter", async () => {
    let release: (() => void) | undefined;
    sendMessageMock.mockImplementationOnce(async (pipelineId: string) => {
      await new Promise<void>((resolve) => { release = resolve; });
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
    await act(async () => { release?.(); });
    expect((box as HTMLTextAreaElement).value).toBe("");
  });

  test("caps the draft at the length the backend will accept", () => {
    renderTab();
    const box = screen.getByLabelText("Send a message to the agent");

    // Truncating in the browser beats a rejected round trip that loses the text.
    expect(box.getAttribute("maxlength"))
      .toBe(String(MAX_PIPELINE_USER_MESSAGE_LENGTH));
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
    // Losing the user's typing on a transient failure is worse than the failure.
    expect(box.value).toBe("do not lose me");
  });

  test("refuses to send an empty or whitespace-only message", () => {
    renderTab();
    const button = screen.getByRole("button", {
      name: "Send message",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    fireEvent.change(
      screen.getByLabelText("Send a message to the agent"),
      { target: { value: "   " } },
    );
    expect(button.disabled).toBe(true);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  test("hides the compose box once the build has finished", () => {
    useBuildPipelineStore.setState({
      pipelines: new Map([[pipeline.id, pipeline]]),
      buildEnvironmentIds: new Set(["env-1"]),
    });
    renderTab();

    expect(screen.queryByLabelText("Send a message to the agent")).toBeNull();
  });

  test("restarts the review through the backend", async () => {
    renderTab();

    fireEvent.click(screen.getByRole("button", { name: /Retry Review/ }));

    await waitFor(() => expect(retryReviewMock).toHaveBeenCalledWith(running.id));
    await waitFor(() =>
      expect(useBuildPipelineStore.getState().pipelines.get(running.id)?.phase)
        .toBe("reviewing"));
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
    expect(screen.queryByText(/1 message queued/)).toBeNull();
  });

  test("disables the send button and shows progress while a send is in flight", async () => {
    let release: (() => void) | undefined;
    sendMessageMock.mockImplementationOnce(async (pipelineId: string) => {
      await new Promise<void>((resolve) => { release = resolve; });
      return {
        ...useBuildPipelineStore.getState().pipelines.get(pipelineId)!,
        pendingUserMessages: [],
        backendRevision: 51,
      };
    });
    renderTab();
    fireEvent.change(
      screen.getByLabelText("Send a message to the agent"),
      { target: { value: "hold on" } },
    );

    const button = screen.getByRole("button", {
      name: "Send message",
    }) as HTMLButtonElement;
    fireEvent.click(button);

    // A second click would queue the same text twice.
    await waitFor(() => expect(button.disabled).toBe(true));
    expect(button.querySelector(".animate-spin")).toBeTruthy();

    release?.();
    await waitFor(() => expect(button.querySelector(".animate-spin")).toBeNull());
  });

  test("re-enables the retry control when the backend refuses a review restart", async () => {
    retryReviewMock.mockRejectedValueOnce(new Error("no review stage"));
    renderTab();

    const retry = screen.getByRole("button", {
      name: /Retry Review/,
    }) as HTMLButtonElement;
    fireEvent.click(retry);

    await waitFor(() => expect(retryReviewMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(retry.disabled).toBe(false));
    expect(useBuildPipelineStore.getState().pipelines.get(running.id)?.phase)
      .toBe("building");
  });

  test("follows the restarted review instead of the stage the user was reading", async () => {
    renderTab();
    fireEvent.click(screen.getByText("Build Session"));
    await waitFor(() =>
      expect(screen.getByText("Implementation complete")).toBeTruthy());

    // A retry appends a new stage. Holding the pinned one would leave the user
    // watching a transcript that has stopped moving.
    retryReviewMock.mockImplementationOnce(async (pipelineId: string) => {
      const current = useBuildPipelineStore.getState().pipelines.get(pipelineId)!;
      return {
        ...current,
        phase: "reviewing" as const,
        sessions: [...current.sessions, {
          phase: "review" as const,
          iteration: 1,
          sessionKey: "retry-key",
          sdkSessionId: "retry-session",
          status: "idle" as const,
          startedAt: "2026-07-29T00:05:00.000Z",
          label: "Retry Review Session",
          messages: [{
            id: "retry-answer",
            role: "assistant",
            content: "Reviewing again",
          }],
        }],
        currentSessionIndex: current.sessions.length,
        backendRevision: 52,
      };
    });

    fireEvent.click(screen.getByRole("button", { name: /Retry Review/ }));

    await waitFor(() =>
      expect(screen.getByText("Reviewing again")).toBeTruthy());
  });

  test("does not offer a review retry before the first stage exists", () => {
    useBuildPipelineStore.setState({
      pipelines: new Map([[running.id, {
        ...running,
        sessions: [],
        currentSessionIndex: -1,
      }]]),
      buildEnvironmentIds: new Set(["env-1"]),
    });
    renderTab();

    expect(screen.queryByRole("button", { name: /Retry Review/ })).toBeNull();
  });
});
