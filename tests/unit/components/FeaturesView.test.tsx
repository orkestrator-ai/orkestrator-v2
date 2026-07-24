import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import * as realVirtualizedMessageList from "@/components/chat/VirtualizedMessageList";
import * as realNativeComposeDock from "@/components/chat/NativeComposeDock";
import * as realNativeMessage from "@/components/chat/NativeMessage";
import * as realUseBuildPipeline from "@/hooks/useBuildPipeline";
import * as realUseEnvironments from "@/hooks/useEnvironments";
import * as realCodexClient from "@/lib/codex-client";
import * as realBackend from "@/lib/backend";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useFeaturePlanStore } from "@/stores/featurePlanStore";
import { useKanbanStore } from "@/stores/kanbanStore";
import { useProjectStore } from "@/stores/projectStore";
import type { FeaturePlan, FeatureStoryCard } from "@/lib/backend";
import type { KanbanTask } from "@/stores/kanbanStore";
import type { Environment } from "@/types";
import { mockToastError, mockToastWarning } from "../../mocks/sonner";

const realVirtualizedMessageListSnapshot = { ...realVirtualizedMessageList };
const realNativeComposeDockSnapshot = { ...realNativeComposeDock };
const realNativeMessageSnapshot = { ...realNativeMessage };
const realUseBuildPipelineSnapshot = { ...realUseBuildPipeline };
const realUseEnvironmentsSnapshot = { ...realUseEnvironments };
const realCodexClientSnapshot = { ...realCodexClient };
const realBackendSnapshot = { ...realBackend };

const startBuildMock = mock(async () => undefined);
const addTaskMock = mock(async (
  _projectId: string,
  _title: string,
  _description: string,
): Promise<string | undefined> => "task-1");
const updateTaskMock = mock(async () => undefined);
const updateFeatureMock = mock(async (_id: string, updates: Partial<FeaturePlan>) => ({
  ...featureWithStories(),
  ...updates,
}));
const loadFeaturesMock = mock(async () => undefined);
const createFeatureMock = mock(async (_projectId: string) => "feature-new");
const appendMessageMock = mock(async (_featureId: string, _role: "user" | "assistant" | "system", _content: string) => undefined);
const appendStoryMessageMock = mock(async (
  _featureId: string,
  _storyId: string,
  _role: "user" | "assistant" | "system",
  _content: string,
) => undefined);
const createEnvironmentMock = mock(async () => makeEnvironment());
const startEnvironmentMock = mock(async () => ({}));
const createClientMock = mock((baseUrl: string) => ({ baseUrl }));
const createSessionMock = mock(async () => ({ sessionId: "session-new", title: "Feature planning" }));
const getSessionMessagesMock = mock(async () => [codexMessage("assistant", "Assistant reply")]);
const getSessionStatusMock = mock(async () => ({ status: "idle" as const }));
const sendPromptMock = mock(async () => true);
const getEnvironmentMock = mock(async (_id: string) => makeEnvironment());
const updateEnvironmentAgentSettingsMock = mock(async (_id: string) => makeEnvironment());
const getLocalCodexServerStatusMock = mock(async () => ({ running: true, port: 4100, pid: 12 }));
const startLocalCodexServerMock = mock(async () => ({ port: 4101, pid: 13 }));
const getCodexServerStatusMock = mock(async () => ({ running: true, hostPort: 4200 }));
const startCodexServerMock = mock(async () => ({ hostPort: 4201 }));
const scrollToIndexMock = mock(() => undefined);
const scrollToMock = mock(() => undefined);

type StubMessage = { id: string; content?: string };
type StubVirtualizedMessageListProps = {
  messages: StubMessage[];
  renderMessage: (index: number, message: StubMessage, previousMessage?: StubMessage) => ReactNode;
  footer?: ReactNode;
  scrollProps?: {
    atBottomStateChange?: (isAtBottom: boolean) => void;
  };
  virtuosoRef?: {
    current: {
      scrollToIndex: typeof scrollToIndexMock;
      scrollTo: typeof scrollToMock;
    } | null;
  };
};

// Stub the heavy chat children so the (briefly-rendered) chat tab is cheap to mount.
mock.module("@/components/chat/VirtualizedMessageList", () => ({
  VirtualizedMessageList: ({
    messages,
    renderMessage,
    footer,
    scrollProps,
    virtuosoRef,
  }: StubVirtualizedMessageListProps) => {
    if (virtuosoRef) {
      virtuosoRef.current = {
        scrollToIndex: scrollToIndexMock,
        scrollTo: scrollToMock,
      };
    }
    return (
      <div data-testid="virtualized-list">
        <button
          type="button"
          data-testid="simulate-scroll-up"
          aria-label="Simulate scrolling up"
          onClick={() => scrollProps?.atBottomStateChange?.(false)}
        />
        {messages.map((message, index) => (
          <div key={message.id}>{renderMessage(index, message, messages[index - 1])}</div>
        ))}
        {footer}
      </div>
    );
  },
}));
mock.module("@/components/chat/NativeComposeDock", () => ({
  NativeComposeDock: ({ children, topAccessory }: { children?: ReactNode; topAccessory?: ReactNode }) => (
    <div>{topAccessory}{children}</div>
  ),
}));
mock.module("@/components/chat/NativeMessage", () => ({
  NativeMessage: ({ message }: { message: StubMessage }) => (
    <div data-testid={`message-${message.id}`}>{message.content}</div>
  ),
}));

mock.module("@/hooks/useBuildPipeline", () => ({
  useBuildPipeline: () => ({ startBuild: startBuildMock }),
}));
mock.module("@/hooks/useEnvironments", () => ({
  useEnvironments: () => ({
    createEnvironment: createEnvironmentMock,
    startEnvironment: startEnvironmentMock,
  }),
}));
mock.module("@/lib/codex-client", () => ({
  ...realCodexClientSnapshot,
  createClient: createClientMock,
  createSession: createSessionMock,
  getSessionMessages: getSessionMessagesMock,
  getSessionStatus: getSessionStatusMock,
  sendPrompt: sendPromptMock,
}));
mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getEnvironment: getEnvironmentMock,
  updateEnvironmentAgentSettings: updateEnvironmentAgentSettingsMock,
  getLocalCodexServerStatus: getLocalCodexServerStatusMock,
  startLocalCodexServer: startLocalCodexServerMock,
  getCodexServerStatus: getCodexServerStatusMock,
  startCodexServer: startCodexServerMock,
}));

const { FeaturesView } = await import("@/components/kanban/FeaturesView");

afterAll(() => {
  mock.module("@/components/chat/VirtualizedMessageList", () => realVirtualizedMessageListSnapshot);
  mock.module("@/components/chat/NativeComposeDock", () => realNativeComposeDockSnapshot);
  mock.module("@/components/chat/NativeMessage", () => realNativeMessageSnapshot);
  mock.module("@/hooks/useBuildPipeline", () => realUseBuildPipelineSnapshot);
  mock.module("@/hooks/useEnvironments", () => realUseEnvironmentsSnapshot);
  mock.module("@/lib/codex-client", () => realCodexClientSnapshot);
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

const NOW = "2026-01-01T00:00:00.000Z";

function codexMessage(role: "user" | "assistant", content: string, id = `${role}-1`) {
  return { id, role, content, parts: [{ type: "text" as const, content }], createdAt: NOW };
}

function planMessage(role: "user" | "assistant" | "system", content: string, id = `${role}-plan`) {
  return { id, role, content, createdAt: NOW };
}

function makeEnvironment(overrides: Partial<Environment> = {}): Environment {
  return {
    id: "env-1",
    projectId: "project-1",
    name: "Feature environment",
    branch: "feature",
    containerId: "container-1",
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: NOW,
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "containerized",
    ...overrides,
  };
}

function makeStory(overrides: Partial<FeatureStoryCard> = {}): FeatureStoryCard {
  return {
    id: "story-1",
    title: "Story 1",
    description: "Story description",
    acceptanceCriteria: ["criterion one"],
    messages: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function featureWithStories(overrides: Partial<FeaturePlan> = {}): FeaturePlan {
  return {
    id: "feature-1",
    projectId: "project-1",
    title: "My Feature",
    status: "stories",
    summary: "",
    messages: [],
    stories: [makeStory()],
    createdAt: NOW,
    updatedAt: NOW,
    order: 0,
    ...overrides,
  };
}

function makeTask(overrides: Partial<KanbanTask> = {}): KanbanTask {
  return {
    id: "task-1",
    projectId: "project-1",
    title: "Task",
    description: "",
    acceptanceCriteria: "",
    status: "backlog",
    comments: [],
    images: [],
    createdAt: NOW,
    order: 0,
    ...overrides,
  };
}

function seedStores(feature: FeaturePlan) {
  useProjectStore.setState({
    projects: [{
      id: "project-1",
      name: "Project",
      gitUrl: "https://github.com/acme/repo.git",
      localPath: null,
      addedAt: NOW,
      order: 0,
    }],
    isLoading: false,
    error: null,
  });
  useFeaturePlanStore.setState({
    features: [feature],
    loadFeatures: loadFeaturesMock as unknown as ReturnType<typeof useFeaturePlanStore.getState>["loadFeatures"],
    createFeature: createFeatureMock as unknown as ReturnType<typeof useFeaturePlanStore.getState>["createFeature"],
    updateFeature: updateFeatureMock as unknown as ReturnType<typeof useFeaturePlanStore.getState>["updateFeature"],
    appendMessage: appendMessageMock as unknown as ReturnType<typeof useFeaturePlanStore.getState>["appendMessage"],
    appendStoryMessage: appendStoryMessageMock as unknown as ReturnType<typeof useFeaturePlanStore.getState>["appendStoryMessage"],
  });
  useKanbanStore.setState({
    tasks: [makeTask()],
    addTask: addTaskMock as unknown as ReturnType<typeof useKanbanStore.getState>["addTask"],
    updateTask: updateTaskMock as unknown as ReturnType<typeof useKanbanStore.getState>["updateTask"],
  });
}

function seedPipeline(
  { taskId = "task-1", environmentId, failed = false }: { taskId?: string; environmentId?: string; failed?: boolean } = {},
): string {
  const store = useBuildPipelineStore.getState();
  const id = store.createPipeline({
    taskId,
    projectId: "project-1",
    environmentType: "containerized",
    agentType: "codex",
    taskTitle: "Task",
    taskSnapshot: { title: "Task", description: "", acceptanceCriteria: "", comments: [], images: [] },
    source: { type: "kanban", taskId },
  });
  if (environmentId) store.setPipelineEnvironment(id, environmentId);
  if (failed) store.setPipelineError(id, "failed to start environment");
  return id;
}

beforeEach(() => {
  cleanup();
  startBuildMock.mockClear();
  addTaskMock.mockClear();
  updateTaskMock.mockClear();
  updateFeatureMock.mockClear();
  loadFeaturesMock.mockClear();
  createFeatureMock.mockClear();
  appendMessageMock.mockClear();
  appendStoryMessageMock.mockClear();
  createEnvironmentMock.mockClear();
  startEnvironmentMock.mockClear();
  createClientMock.mockClear();
  createSessionMock.mockClear();
  getSessionMessagesMock.mockClear();
  getSessionStatusMock.mockClear();
  sendPromptMock.mockClear();
  getEnvironmentMock.mockClear();
  updateEnvironmentAgentSettingsMock.mockClear();
  getLocalCodexServerStatusMock.mockClear();
  startLocalCodexServerMock.mockClear();
  getCodexServerStatusMock.mockClear();
  startCodexServerMock.mockClear();
  scrollToIndexMock.mockClear();
  scrollToMock.mockClear();
  createFeatureMock.mockImplementation(async () => "feature-new");
  appendMessageMock.mockImplementation(async () => undefined);
  appendStoryMessageMock.mockImplementation(async () => undefined);
  createEnvironmentMock.mockImplementation(async () => makeEnvironment());
  createSessionMock.mockImplementation(async () => ({ sessionId: "session-new", title: "Feature planning" }));
  getSessionMessagesMock.mockImplementation(async () => [codexMessage("assistant", "Assistant reply")]);
  getSessionStatusMock.mockImplementation(async () => ({ status: "idle" as const }));
  sendPromptMock.mockImplementation(async () => true);
  getEnvironmentMock.mockImplementation(async () => makeEnvironment());
  updateEnvironmentAgentSettingsMock.mockImplementation(async () => makeEnvironment());
  getLocalCodexServerStatusMock.mockImplementation(async () => ({ running: true, port: 4100, pid: 12 }));
  startLocalCodexServerMock.mockImplementation(async () => ({ port: 4101, pid: 13 }));
  getCodexServerStatusMock.mockImplementation(async () => ({ running: true, hostPort: 4200 }));
  startCodexServerMock.mockImplementation(async () => ({ hostPort: 4201 }));
  useFeaturePlanStore.setState({ chatDrafts: new Map() });
  useEnvironmentStore.setState({ environments: [] });
  useBuildPipelineStore.setState({ pipelines: new Map(), buildEnvironmentIds: new Set() });
});

describe("FeaturesView message drafts", () => {
  test("restores an unfinished feature message after the view is unmounted and reopened", () => {
    seedStores(featureWithStories({ status: "collecting", stories: [] }));
    const view = render(<FeaturesView projectId="project-1" />);
    const composer = screen.getByPlaceholderText("Describe the feature or answer Codex...");

    fireEvent.change(composer, { target: { value: "A half-finished feature message" } });
    expect((composer as HTMLTextAreaElement).value).toBe("A half-finished feature message");

    view.unmount();
    render(<FeaturesView projectId="project-1" />);

    expect(
      (screen.getByPlaceholderText("Describe the feature or answer Codex...") as HTMLTextAreaElement).value,
    ).toBe("A half-finished feature message");
  });

  test("restores a story draft after its tab and the view are reopened", () => {
    seedStores(featureWithStories());
    const view = render(<FeaturesView projectId="project-1" />);

    fireEvent.click(screen.getByRole("button", { name: /Story 1/ }));
    const composer = screen.getByPlaceholderText("Refine the story, description, or acceptance criteria...");
    fireEvent.change(composer, { target: { value: "Keep this story thought" } });

    view.unmount();
    render(<FeaturesView projectId="project-1" />);
    fireEvent.click(screen.getByRole("button", { name: /Story 1/ }));

    expect(
      (screen.getByPlaceholderText("Refine the story, description, or acceptance criteria...") as HTMLTextAreaElement).value,
    ).toBe("Keep this story thought");
  });

  test("keeps feature and story drafts isolated across features and stories", async () => {
    const first = featureWithStories({
      title: "First Feature",
      status: "collecting",
      stories: [],
    });
    const second = featureWithStories({
      id: "feature-2",
      title: "Second Feature",
      status: "collecting",
      stories: [],
    });
    seedStores(first);
    useFeaturePlanStore.setState({
      features: [first, second],
      chatDrafts: new Map([
        ["feature:feature-1", "first feature draft"],
        ["feature:feature-2", "second feature draft"],
      ]),
    });
    render(<FeaturesView projectId="project-1" />);

    expect((screen.getByPlaceholderText("Describe the feature or answer Codex...") as HTMLTextAreaElement).value)
      .toBe("first feature draft");
    fireEvent.click(screen.getByRole("button", { name: /Second Feature/ }));
    await waitFor(() => expect(screen.getByText("Second Feature").closest("button")?.className).toContain("border-primary"));
    expect((screen.getByPlaceholderText("Describe the feature or answer Codex...") as HTMLTextAreaElement).value)
      .toBe("second feature draft");
    fireEvent.click(screen.getByRole("button", { name: /First Feature/ }));
    await waitFor(() => expect(screen.getByText("First Feature").closest("button")?.className).toContain("border-primary"));
    expect((screen.getByPlaceholderText("Describe the feature or answer Codex...") as HTMLTextAreaElement).value)
      .toBe("first feature draft");

    cleanup();
    const withStories = featureWithStories({
      stories: [makeStory(), makeStory({ id: "story-2", title: "Story 2" })],
    });
    seedStores(withStories);
    useFeaturePlanStore.setState({
      chatDrafts: new Map([
        ["feature:feature-1:story:story-1", "first story draft"],
        ["feature:feature-1:story:story-2", "second story draft"],
      ]),
    });
    render(<FeaturesView projectId="project-1" />);
    fireEvent.click(screen.getByRole("button", { name: /Story 1/ }));
    expect((screen.getByPlaceholderText("Refine the story, description, or acceptance criteria...") as HTMLTextAreaElement).value)
      .toBe("first story draft");
    fireEvent.click(screen.getByRole("button", { name: "" }));
    fireEvent.click(screen.getByRole("button", { name: /Story 2/ }));
    expect((screen.getByPlaceholderText("Refine the story, description, or acceptance criteria...") as HTMLTextAreaElement).value)
      .toBe("second story draft");
  });

  test("clears only the submitted feature draft", async () => {
    const feature = featureWithStories({ status: "collecting", stories: [], codexEnvironmentId: "env-1", codexSessionId: "session-1" });
    seedStores(feature);
    useEnvironmentStore.setState({ environments: [makeEnvironment()] });
    useFeaturePlanStore.getState().setChatDraft("feature:other", "leave me");
    render(<FeaturesView projectId="project-1" />);

    const composer = screen.getByPlaceholderText("Describe the feature or answer Codex...");
    fireEvent.change(composer, { target: { value: "  send this  " } });
    fireEvent.click(screen.getByTitle("Send message"));

    await waitFor(() => expect(appendMessageMock).toHaveBeenCalledWith("feature-1", "user", "send this"));
    expect(useFeaturePlanStore.getState().getChatDraft("feature:feature-1")).toBe("");
    expect(useFeaturePlanStore.getState().getChatDraft("feature:other")).toBe("leave me");
  });

  test("clears only the submitted story draft", async () => {
    const feature = featureWithStories({ codexEnvironmentId: "env-1", codexSessionId: "session-1" });
    seedStores(feature);
    useEnvironmentStore.setState({ environments: [makeEnvironment()] });
    useFeaturePlanStore.getState().setChatDraft("feature:feature-1", "feature remains");
    render(<FeaturesView projectId="project-1" />);
    fireEvent.click(screen.getByRole("button", { name: /Story 1/ }));

    fireEvent.change(screen.getByPlaceholderText("Refine the story, description, or acceptance criteria..."), {
      target: { value: "  refine this  " },
    });
    fireEvent.click(screen.getByTitle("Send message"));

    await waitFor(() => {
      expect(appendStoryMessageMock).toHaveBeenCalledWith("feature-1", "story-1", "user", "refine this");
    });
    expect(useFeaturePlanStore.getState().getChatDraft("feature:feature-1:story:story-1")).toBe("");
    expect(useFeaturePlanStore.getState().getChatDraft("feature:feature-1")).toBe("feature remains");
  });
});

describe("FeaturesView list, tabs, and chat controls", () => {
  test("loads the project, filters foreign features, selects features, and shows the empty state", async () => {
    const current = featureWithStories({ title: "Current project" });
    const foreign = featureWithStories({ id: "foreign", projectId: "project-2", title: "Foreign project" });
    seedStores(current);
    useFeaturePlanStore.setState({ features: [current, foreign] });
    const view = render(<FeaturesView projectId="project-1" />);

    await waitFor(() => expect(loadFeaturesMock).toHaveBeenCalledWith("project-1"));
    expect(screen.getByText("Current project")).toBeTruthy();
    expect(screen.queryByText("Foreign project")).toBeNull();

    act(() => useFeaturePlanStore.setState({ features: [] }));
    await waitFor(() => expect(screen.getByText("Create a feature to start discovery.")).toBeTruthy());
    expect(screen.getByText("Select or create a feature.")).toBeTruthy();
    view.unmount();
  });

  test("creates and selects a new feature when creation succeeds and ignores an empty result", async () => {
    const oldFeature = featureWithStories({ title: "Old feature" });
    const newFeature = featureWithStories({ id: "feature-new", title: "New feature", stories: [] });
    seedStores(oldFeature);
    createFeatureMock.mockImplementationOnce(async () => {
      useFeaturePlanStore.setState({ features: [oldFeature, newFeature] });
      return "feature-new";
    });
    render(<FeaturesView projectId="project-1" />);

    fireEvent.click(screen.getByTitle("New feature"));
    await waitFor(() => {
      expect(screen.getByText("New feature").closest("button")?.className).toContain("border-primary");
    });
    expect(screen.getByRole("tab", { name: "Chat" }).getAttribute("data-state")).toBe("active");

    createFeatureMock.mockImplementationOnce(async () => undefined);
    fireEvent.click(screen.getByTitle("New feature"));
    await waitFor(() => expect(createFeatureMock).toHaveBeenCalledTimes(2));
    expect(screen.getByText("New feature").closest("button")?.className).toContain("border-primary");
  });

  test("opens, truncates, and closes story tabs", () => {
    const longTitle = "A story title that is definitely longer than twenty four characters";
    seedStores(featureWithStories({ stories: [makeStory({ title: longTitle })] }));
    render(<FeaturesView projectId="project-1" />);

    fireEvent.click(screen.getByRole("button", { name: new RegExp(longTitle) }));
    expect(screen.getByRole("tab", { name: /A story title that is de/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "" }));
    expect(screen.queryByRole("tab", { name: /A story title that is de/ })).toBeNull();
    expect(screen.getByRole("tab", { name: "Stories" }).getAttribute("data-state")).toBe("active");
  });

  test("renders stripped chat messages, scrolls to the bottom, preserves Shift+Enter, and submits Enter", async () => {
    const stateOnly = `<feature_planner_state>\n{"phase":"collecting"}\n</feature_planner_state>`;
    const feature = featureWithStories({
      status: "collecting",
      stories: [],
      codexEnvironmentId: "env-1",
      codexSessionId: "session-1",
      messages: [
        planMessage("assistant", `Visible reply\n${stateOnly}`, "visible"),
        planMessage("assistant", stateOnly, "hidden"),
      ],
    });
    seedStores(feature);
    useEnvironmentStore.setState({ environments: [makeEnvironment()] });
    let resolveMessages!: (messages: ReturnType<typeof codexMessage>[]) => void;
    getSessionMessagesMock.mockImplementationOnce(async () => new Promise((resolve) => { resolveMessages = resolve; }));
    render(<FeaturesView projectId="project-1" />);

    expect(screen.getByTestId("message-visible").textContent).toBe("Visible reply");
    expect(screen.queryByTestId("message-hidden")).toBeNull();
    fireEvent.click(screen.getByTestId("simulate-scroll-up"));
    await waitFor(() => expect(screen.getByRole("button", {
      name: "Scroll to bottom of conversation",
    })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Scroll to bottom of conversation" }));
    expect(scrollToIndexMock).toHaveBeenCalledTimes(1);

    const composer = screen.getByPlaceholderText("Describe the feature or answer Codex...");
    expect((screen.getByTitle("Send message") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(composer, { target: { value: "keyboard message" } });
    fireEvent.keyDown(composer, { key: "Enter", shiftKey: true });
    expect(appendMessageMock).not.toHaveBeenCalled();
    fireEvent.keyDown(composer, { key: "Enter", shiftKey: false });
    await waitFor(() => expect(appendMessageMock).toHaveBeenCalledWith("feature-1", "user", "keyboard message"));
    expect((screen.getByTitle("Refresh Codex status") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Codex is working...")).toBeTruthy();
    resolveMessages([codexMessage("assistant", "done")]);
    await waitFor(() => expect((screen.getByTitle("Refresh Codex status") as HTMLButtonElement).disabled).toBe(false));
  });
});

describe("FeaturesView Codex planning", () => {
  function seedRunnableFeature(overrides: Partial<FeaturePlan> = {}) {
    const feature = featureWithStories({
      status: "collecting",
      stories: [],
      codexEnvironmentId: "env-1",
      codexSessionId: "session-1",
      ...overrides,
    });
    seedStores(feature);
    useEnvironmentStore.setState({ environments: [makeEnvironment()] });
    return feature;
  }

  async function sendFeature(text = "plan it") {
    const composer = screen.getByPlaceholderText("Describe the feature or answer Codex...");
    fireEvent.change(composer, { target: { value: text } });
    fireEvent.click(screen.getByTitle("Send message"));
    await waitFor(() => expect(sendPromptMock).toHaveBeenCalled());
  }

  test("reuses a running container environment and existing session", async () => {
    seedRunnableFeature();
    render(<FeaturesView projectId="project-1" />);
    await sendFeature();

    expect(createEnvironmentMock).not.toHaveBeenCalled();
    expect(startEnvironmentMock).not.toHaveBeenCalled();
    expect(getCodexServerStatusMock).toHaveBeenCalledWith("container-1");
    expect(createClientMock).toHaveBeenCalledWith("http://127.0.0.1:4200");
    expect(createSessionMock).not.toHaveBeenCalled();
    expect(sendPromptMock).toHaveBeenCalledWith(expect.anything(), "session-1", expect.stringContaining("plan it"));
  });

  test("creates and configures an environment and a plan-mode session", async () => {
    const feature = featureWithStories({ status: "collecting", stories: [], codexEnvironmentId: undefined, codexSessionId: undefined });
    seedStores(feature);
    updateEnvironmentAgentSettingsMock.mockImplementationOnce(async () => makeEnvironment());
    render(<FeaturesView projectId="project-1" />);
    await sendFeature();

    expect(createEnvironmentMock).toHaveBeenCalledWith(
      "project-1",
      "feature-plan-My Feature",
      "restricted",
      undefined,
      undefined,
      "containerized",
      "My Feature",
    );
    expect(updateEnvironmentAgentSettingsMock).toHaveBeenCalledWith("env-1", "codex", null, null, null, "native");
    expect(updateFeatureMock).toHaveBeenCalledWith("feature-1", { codexEnvironmentId: "env-1" });
    expect(createSessionMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      title: "My Feature",
      mode: "plan",
      modelReasoningEffort: "medium",
    }));
    expect(updateFeatureMock).toHaveBeenCalledWith("feature-1", { codexSessionId: "session-new" });
  });

  test("starts a stopped environment and starts a missing local Codex bridge", async () => {
    seedRunnableFeature();
    useProjectStore.setState((state) => ({
      projects: state.projects.map((project) => ({ ...project, localPath: "/repo" })),
    }));
    useEnvironmentStore.setState({ environments: [makeEnvironment({
      status: "stopped",
      environmentType: "local",
      containerId: null,
      worktreePath: "/worktree",
    })] });
    getEnvironmentMock.mockImplementation(async () => makeEnvironment({
      status: "running",
      environmentType: "local",
      containerId: null,
      worktreePath: "/worktree",
    }));
    getLocalCodexServerStatusMock.mockImplementationOnce(async () => ({ running: false }));
    render(<FeaturesView projectId="project-1" />);
    await sendFeature();

    expect(startEnvironmentMock).toHaveBeenCalledWith("env-1", undefined, { silent: true });
    expect(startLocalCodexServerMock).toHaveBeenCalledWith("env-1");
    expect(createClientMock).toHaveBeenCalledWith("http://127.0.0.1:4101");
  });

  test("starts a missing container Codex bridge", async () => {
    seedRunnableFeature();
    getCodexServerStatusMock.mockImplementationOnce(async () => ({ running: false }));
    render(<FeaturesView projectId="project-1" />);
    await sendFeature();

    expect(startCodexServerMock).toHaveBeenCalledWith("container-1");
    expect(createClientMock).toHaveBeenCalledWith("http://127.0.0.1:4201");
  });

  test("creates a replacement session when the saved session no longer exists", async () => {
    seedRunnableFeature();
    getSessionStatusMock
      .mockImplementationOnce(async () => null)
      .mockImplementation(async () => ({ status: "idle" as const }));
    render(<FeaturesView projectId="project-1" />);
    await sendFeature();

    expect(createSessionMock).toHaveBeenCalledTimes(1);
    expect(sendPromptMock).toHaveBeenCalledWith(expect.anything(), "session-new", expect.any(String));
  });

  test("reports missing container IDs and unresolved bridge ports", async () => {
    seedRunnableFeature();
    useEnvironmentStore.setState({ environments: [makeEnvironment({ containerId: null })] });
    render(<FeaturesView projectId="project-1" />);
    const composer = screen.getByPlaceholderText("Describe the feature or answer Codex...");
    fireEvent.change(composer, { target: { value: "first failure" } });
    fireEvent.click(screen.getByTitle("Send message"));
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(
      "Feature planning failed",
      expect.objectContaining({ description: "Container ID is required for feature planning in a container" }),
    ));
    cleanup();

    seedRunnableFeature();
    getCodexServerStatusMock.mockImplementationOnce(async () => ({ running: true }));
    render(<FeaturesView projectId="project-1" />);
    fireEvent.change(screen.getByPlaceholderText("Describe the feature or answer Codex..."), {
      target: { value: "second failure" },
    });
    fireEvent.click(screen.getByTitle("Send message"));
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(
      "Feature planning failed",
      expect.objectContaining({ description: "Failed to resolve Codex bridge port" }),
    ));
  });

  test("handles prompt rejection, an errored session, and an idle reply with no assistant text", async () => {
    seedRunnableFeature();
    sendPromptMock.mockImplementationOnce(async () => false);
    render(<FeaturesView projectId="project-1" />);
    await sendFeature("rejected");
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(
      "Feature planning failed",
      expect.objectContaining({ description: "Failed to send feature planning prompt" }),
    ));
    cleanup();

    seedRunnableFeature();
    getSessionStatusMock
      .mockImplementationOnce(async () => ({ status: "idle" as const }))
      .mockImplementationOnce(async () => ({ status: "error" as const, error: "agent failed" }));
    render(<FeaturesView projectId="project-1" />);
    await sendFeature("errored");
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(
      "Feature planning failed",
      expect.objectContaining({ description: "agent failed" }),
    ));
    cleanup();

    seedRunnableFeature();
    getSessionMessagesMock.mockImplementationOnce(async () => [codexMessage("user", "only user")]);
    render(<FeaturesView projectId="project-1" />);
    await sendFeature("no assistant");
    await waitFor(() => expect(mockToastWarning).toHaveBeenCalledWith(
      "Codex is still working",
      expect.any(Object),
    ));
  });

  test("warns when Codex polling reaches its timeout", async () => {
    seedRunnableFeature();
    const realDateNow = Date.now;
    let clockRead = 0;
    Date.now = () => {
      clockRead += 1;
      if (clockRead === 1) return 0;
      if (clockRead === 2) return 600_001;
      return realDateNow();
    };
    try {
      render(<FeaturesView projectId="project-1" />);
      const composer = screen.getByPlaceholderText("Describe the feature or answer Codex...");
      await act(async () => {
        fireEvent.change(composer, { target: { value: "long running plan" } });
        fireEvent.click(screen.getByTitle("Send message"));
        for (let index = 0; index < 12; index += 1) await Promise.resolve();
      });
    } finally {
      Date.now = realDateNow;
    }

    await waitFor(() => expect(mockToastWarning).toHaveBeenCalledWith(
      "Codex is still working",
      expect.objectContaining({ description: expect.stringContaining("Use refresh") }),
    ));
    expect(getSessionMessagesMock).not.toHaveBeenCalled();
  });

  test("reports session creation failures", async () => {
    seedRunnableFeature({ codexSessionId: undefined });
    createSessionMock.mockImplementationOnce(async () => { throw new Error("cannot create session"); });
    render(<FeaturesView projectId="project-1" />);
    const composer = screen.getByPlaceholderText("Describe the feature or answer Codex...");
    fireEvent.change(composer, { target: { value: "new session" } });
    fireEvent.click(screen.getByTitle("Send message"));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(
      "Feature planning failed",
      expect.objectContaining({ description: "cannot create session" }),
    ));
    expect(sendPromptMock).not.toHaveBeenCalled();
  });

  test.each([
    ["collecting", "collecting"],
    ["confirming", "confirming"],
  ] as const)("applies the %s planner phase", async (phase, expectedStatus) => {
    seedRunnableFeature();
    getSessionMessagesMock.mockImplementationOnce(async () => [codexMessage(
      "assistant",
      `Reply\n<feature_planner_state>\n{"phase":"${phase}","title":" Updated title ","summary":"Updated summary"}\n</feature_planner_state>`,
    )]);
    render(<FeaturesView projectId="project-1" />);
    await sendFeature();

    await waitFor(() => expect(updateFeatureMock).toHaveBeenCalledWith("feature-1", expect.objectContaining({
      status: expectedStatus,
      title: "Updated title",
      summary: "Updated summary",
    })));
  });

  test("applies generated stories and switches to the stories tab", async () => {
    const feature = seedRunnableFeature();
    appendMessageMock.mockImplementation(async (_id, role) => role === "assistant"
      ? { ...feature, messages: [planMessage("assistant", "reply")] }
      : feature);
    getSessionMessagesMock.mockImplementationOnce(async () => [codexMessage(
      "assistant",
      `Ready\n<feature_planner_state>\n{"phase":"stories","stories":[{"id":"generated","title":"Generated story","description":"desc","acceptanceCriteria":["works"]}]}\n</feature_planner_state>`,
    )]);
    render(<FeaturesView projectId="project-1" />);
    await sendFeature();

    await waitFor(() => expect(updateFeatureMock).toHaveBeenCalledWith("feature-1", expect.objectContaining({
      status: "stories",
      stories: [expect.objectContaining({ id: "generated", title: "Generated story" })],
    })));
  });

  test("refresh ignores incomplete sessions and duplicate replies, but persists a new reply", async () => {
    seedStores(featureWithStories({ status: "collecting", stories: [] }));
    render(<FeaturesView projectId="project-1" />);
    fireEvent.click(screen.getByTitle("Refresh Codex status"));
    expect(getSessionMessagesMock).not.toHaveBeenCalled();
    cleanup();

    const persisted = planMessage("assistant", "Same reply");
    seedRunnableFeature({ messages: [persisted] });
    getSessionMessagesMock.mockImplementationOnce(async () => [codexMessage("assistant", "Same reply")]);
    render(<FeaturesView projectId="project-1" />);
    fireEvent.click(screen.getByTitle("Refresh Codex status"));
    await waitFor(() => expect(getSessionMessagesMock).toHaveBeenCalled());
    expect(appendMessageMock).not.toHaveBeenCalled();
    cleanup();

    seedRunnableFeature({ messages: [persisted] });
    getSessionMessagesMock.mockImplementationOnce(async () => [{
      ...codexMessage("assistant", "", "new"),
      content: "",
      parts: [{ type: "text" as const, content: "New reply" }],
    }]);
    render(<FeaturesView projectId="project-1" />);
    fireEvent.click(screen.getByTitle("Refresh Codex status"));
    await waitFor(() => expect(appendMessageMock).toHaveBeenCalledWith("feature-1", "assistant", "New reply"));
  });

  test("reports refresh failures and re-enables the control", async () => {
    seedRunnableFeature();
    getSessionMessagesMock.mockImplementationOnce(async () => { throw new Error("refresh unavailable"); });
    render(<FeaturesView projectId="project-1" />);
    fireEvent.click(screen.getByTitle("Refresh Codex status"));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(
      "Failed to refresh feature chat",
      expect.objectContaining({ description: "refresh unavailable" }),
    ));
    await waitFor(() => expect((screen.getByTitle("Refresh Codex status") as HTMLButtonElement).disabled).toBe(false));
  });
});

describe("FeaturesView story refinement", () => {
  async function openAndSendStory(text = "refine") {
    fireEvent.click(screen.getByRole("button", { name: /Story 1/ }));
    const composer = screen.getByPlaceholderText("Refine the story, description, or acceptance criteria...");
    fireEvent.change(composer, { target: { value: text } });
    fireEvent.click(screen.getByTitle("Send message"));
    await waitFor(() => expect(sendPromptMock).toHaveBeenCalled());
  }

  test("persists assistant refinement and applies parsed fields while retaining fallbacks", async () => {
    const feature = featureWithStories({ codexEnvironmentId: "env-1", codexSessionId: "session-1" });
    seedStores(feature);
    useEnvironmentStore.setState({ environments: [makeEnvironment()] });
    appendStoryMessageMock.mockImplementation(async () => feature);
    getSessionMessagesMock.mockImplementationOnce(async () => [codexMessage(
      "assistant",
      `Updated\n<story_refinement>\n{"storyId":"story-1","title":"New title","description":"","acceptanceCriteria":[]}\n</story_refinement>`,
    )]);
    render(<FeaturesView projectId="project-1" />);
    await openAndSendStory();

    await waitFor(() => expect(appendStoryMessageMock).toHaveBeenCalledWith(
      "feature-1",
      "story-1",
      "assistant",
      expect.stringContaining("<story_refinement>"),
    ));
    expect(updateFeatureMock).toHaveBeenCalledWith("feature-1", {
      stories: [expect.objectContaining({
        title: "New title",
        description: "Story description",
        acceptanceCriteria: ["criterion one"],
      })],
    });
  });

  test("leaves the story unchanged for an unparseable reply and reports prompt errors", async () => {
    const feature = featureWithStories({ codexEnvironmentId: "env-1", codexSessionId: "session-1" });
    seedStores(feature);
    useEnvironmentStore.setState({ environments: [makeEnvironment()] });
    getSessionMessagesMock.mockImplementationOnce(async () => [codexMessage("assistant", "No state block")]);
    render(<FeaturesView projectId="project-1" />);
    await openAndSendStory();
    await waitFor(() => expect(appendStoryMessageMock).toHaveBeenCalledWith(
      "feature-1",
      "story-1",
      "assistant",
      "No state block",
    ));
    expect(updateFeatureMock).not.toHaveBeenCalled();
    cleanup();

    seedStores(feature);
    useEnvironmentStore.setState({ environments: [makeEnvironment()] });
    sendPromptMock.mockImplementationOnce(async () => false);
    render(<FeaturesView projectId="project-1" />);
    await openAndSendStory("fail");
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(
      "Story refinement failed",
      expect.objectContaining({ description: "Failed to send story refinement prompt" }),
    ));
  });

  test("warns when refinement remains in progress and blocks a second send while running", async () => {
    const feature = featureWithStories({ codexEnvironmentId: "env-1", codexSessionId: "session-1" });
    seedStores(feature);
    useEnvironmentStore.setState({ environments: [makeEnvironment()] });
    let resolveMessages!: (messages: ReturnType<typeof codexMessage>[]) => void;
    getSessionMessagesMock.mockImplementationOnce(async () => new Promise((resolve) => { resolveMessages = resolve; }));
    render(<FeaturesView projectId="project-1" />);
    fireEvent.click(screen.getByRole("button", { name: /Story 1/ }));
    const composer = screen.getByPlaceholderText("Refine the story, description, or acceptance criteria...");
    fireEvent.change(composer, { target: { value: "first" } });
    fireEvent.click(screen.getByTitle("Send message"));
    await waitFor(() => expect(screen.getByText("Codex is refining...")).toBeTruthy());
    expect((screen.getByTitle("Send message") as HTMLButtonElement).disabled).toBe(true);
    resolveMessages([codexMessage("user", "no assistant")]);
    await waitFor(() => expect(mockToastWarning).toHaveBeenCalledWith(
      "Codex is still refining the story",
      expect.any(Object),
    ));
  });
});

describe("FeaturesView build action", () => {
  test("renders the Build button in the tab header when the feature has stories", () => {
    seedStores(featureWithStories());

    render(<FeaturesView projectId="project-1" />);

    expect(screen.getByRole("button", { name: "Build" })).toBeTruthy();
  });

  test("hides the Build button when the feature has no stories", () => {
    seedStores(featureWithStories({ status: "collecting", stories: [] }));

    render(<FeaturesView projectId="project-1" />);

    expect(screen.queryByRole("button", { name: "Build" })).toBeNull();
  });

  test("clicking Build creates a Kanban task and starts the build pipeline", async () => {
    seedStores(featureWithStories({ codexEnvironmentId: "env-feature" }));
    const pipelineId = seedPipeline({ taskId: "task-1", environmentId: "env-feature" });

    render(<FeaturesView projectId="project-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Build" }));

    await waitFor(() => {
      expect(addTaskMock).toHaveBeenCalledWith(
        "project-1",
        expect.any(String),
        expect.any(String),
      );
    });
    await waitFor(() => {
      expect(startBuildMock).toHaveBeenCalledTimes(1);
    });
    expect(startBuildMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-1" }),
      "containerized",
      "codex",
      { existingEnvironmentId: "env-feature" },
    );
    await waitFor(() => {
      expect(updateFeatureMock).toHaveBeenCalledWith(
        "feature-1",
        expect.objectContaining({
          status: "building",
          buildTaskId: "task-1",
          buildPipelineId: pipelineId,
          codexEnvironmentId: "env-feature",
        }),
      );
    });
  });

  test("does not mark the feature as building when the build pipeline fails to start", async () => {
    seedStores(featureWithStories({ codexEnvironmentId: "env-feature" }));
    seedPipeline({ taskId: "task-1", environmentId: "env-feature", failed: true });

    render(<FeaturesView projectId="project-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Build" }));

    await waitFor(() => {
      expect(startBuildMock).toHaveBeenCalledTimes(1);
    });
    // The pipeline ended in a failed state, so the feature must not be flipped
    // to "building" (startBuild already surfaced the error to the user).
    expect(updateFeatureMock).not.toHaveBeenCalledWith(
      "feature-1",
      expect.objectContaining({ status: "building" }),
    );
  });

  test("reports a task creation failure and does not start a build", async () => {
    seedStores(featureWithStories());
    addTaskMock.mockImplementationOnce(async () => undefined);
    render(<FeaturesView projectId="project-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Build" }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(
      "Failed to start feature build",
      expect.objectContaining({ description: "Failed to create Kanban task for feature build" }),
    ));
    expect(startBuildMock).not.toHaveBeenCalled();
  });

  test("reports when the created task is absent from the Kanban store", async () => {
    seedStores(featureWithStories());
    useKanbanStore.setState({ tasks: [] });
    render(<FeaturesView projectId="project-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Build" }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(
      "Failed to start feature build",
      expect.objectContaining({ description: "Created build task was not found in the Kanban store" }),
    ));
    expect(startBuildMock).not.toHaveBeenCalled();
  });

  test("reports a thrown build-start error and restores the Build control", async () => {
    seedStores(featureWithStories());
    startBuildMock.mockImplementationOnce(async () => { throw new Error("build unavailable"); });
    render(<FeaturesView projectId="project-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Build" }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(
      "Failed to start feature build",
      expect.objectContaining({ description: "build unavailable" }),
    ));
    await waitFor(() => expect((screen.getByRole("button", { name: "Build" }) as HTMLButtonElement).disabled).toBe(false));
    expect(updateFeatureMock).not.toHaveBeenCalledWith("feature-1", expect.objectContaining({ status: "building" }));
  });

  test("does not mark the feature building when startBuild leaves no pipeline", async () => {
    seedStores(featureWithStories());
    render(<FeaturesView projectId="project-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Build" }));

    await waitFor(() => expect(startBuildMock).toHaveBeenCalledTimes(1));
    expect(updateFeatureMock).not.toHaveBeenCalledWith("feature-1", expect.objectContaining({ status: "building" }));
  });

  test("marks a successful pipeline without adding an absent environment ID", async () => {
    seedStores(featureWithStories());
    const pipelineId = seedPipeline();
    render(<FeaturesView projectId="project-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Build" }));

    await waitFor(() => expect(updateFeatureMock).toHaveBeenCalledWith("feature-1", {
      status: "building",
      buildTaskId: "task-1",
      buildPipelineId: pipelineId,
    }));
  });

  test("blocks rapid duplicate build attempts while the first is running", async () => {
    seedStores(featureWithStories());
    seedPipeline();
    let resolveBuild!: () => void;
    startBuildMock.mockImplementationOnce(async () => new Promise<void>((resolve) => { resolveBuild = resolve; }));
    render(<FeaturesView projectId="project-1" />);
    const buildButton = screen.getByRole("button", { name: "Build" });

    fireEvent.click(buildButton);
    await waitFor(() => expect(startBuildMock).toHaveBeenCalledTimes(1));
    expect((buildButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(buildButton);
    expect(startBuildMock).toHaveBeenCalledTimes(1);
    resolveBuild();
    await waitFor(() => expect(updateFeatureMock).toHaveBeenCalledWith(
      "feature-1",
      expect.objectContaining({ status: "building" }),
    ));
  });
});
