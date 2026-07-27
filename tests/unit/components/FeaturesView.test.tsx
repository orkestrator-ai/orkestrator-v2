import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import * as realVirtualizedMessageList from "@/components/chat/VirtualizedMessageList";
import * as realNativeComposeDock from "@/components/chat/NativeComposeDock";
import * as realNativeMessage from "@/components/chat/NativeMessage";
import * as realHooks from "@/hooks";
import * as realUseBuildPipeline from "@/hooks/useBuildPipeline";
import * as realUseEnvironments from "@/hooks/useEnvironments";
import * as realCodexClient from "@/lib/codex-client";
import * as realBackend from "@/lib/backend";
import {
  stripFeaturePlannerStateBlocks,
  stripStoryRefinementStateBlocks,
} from "@/lib/feature-planner";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { useConfigStore } from "@/stores/configStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import {
  useFeaturePlanStore,
  type ActiveFeatureConversation,
} from "@/stores/featurePlanStore";
import { useKanbanStore } from "@/stores/kanbanStore";
import { useProjectStore } from "@/stores/projectStore";
import type { FeaturePlan, FeaturePlanMessage, FeatureStoryCard } from "@/lib/backend";
import type { CodexClient, CodexMessage } from "@/lib/codex-client";
import type { KanbanTask } from "@/stores/kanbanStore";
import type { Environment } from "@/types";
import { mockToastError, mockToastWarning } from "../../mocks/sonner";

const realVirtualizedMessageListSnapshot = { ...realVirtualizedMessageList };
const realNativeComposeDockSnapshot = { ...realNativeComposeDock };
const realNativeMessageSnapshot = { ...realNativeMessage };
const realHooksSnapshot = { ...realHooks };
const realUseBuildPipelineSnapshot = { ...realUseBuildPipeline };
const realUseEnvironmentsSnapshot = { ...realUseEnvironments };
const realCodexClientSnapshot = { ...realCodexClient };
const realBackendSnapshot = { ...realBackend };
const defaultConfigSnapshot = structuredClone(useConfigStore.getState().config);

const startBuildMock = mock(async () => undefined);
const addTaskMock = mock(async (_projectId: string, _title: string, _description: string) => "task-1");
const updateTaskMock = mock(async () => undefined);
const createFeatureMock = mock(async (_projectId: string) => undefined as string | undefined);
const appendMessageMock = mock(async (
  _featureId: string,
  _role: FeaturePlanMessage["role"],
  _content: string,
  _stateApplication?: FeaturePlanMessage["stateApplication"],
) => undefined as FeaturePlan | undefined);
const appendStoryMessageMock = mock(async (
  _featureId: string,
  _storyId: string,
  _role: FeaturePlanMessage["role"],
  _content: string,
  _stateApplication?: FeaturePlanMessage["stateApplication"],
) => undefined as FeaturePlan | undefined);
const updateFeatureMock = mock(async (
  _id: string,
  _updates: Partial<FeaturePlan>,
) => undefined as FeaturePlan | undefined);
const loadFeaturesMock = mock(async () => undefined);
const createEnvironmentMock = mock(async () => makeEnvironment());
const startEnvironmentMock = mock(async () => undefined);
const createClientMock = mock((baseUrl: string, authToken?: string): CodexClient => ({
  baseUrl,
  authToken,
}));
const checkHealthMock = mock(async () => true);
const createSessionMock = mock(async () => ({ sessionId: "session-new" }));
const getSessionStatusMock = mock(async () => ({ status: "idle" as const }));
const getSessionMessagesMock = mock(async () => [] as CodexMessage[]);
const sendPromptMock = mock(async () => true);
const getEnvironmentMock = mock(async () => null as Environment | null);
const updateEnvironmentAgentSettingsMock = mock(async (environmentId: string) =>
  makeEnvironment({ id: environmentId })
);
const getLocalCodexServerStatusMock = mock(async () => ({
  running: true,
  port: 4100,
  pid: 10,
  authToken: "local-token",
}));
const startLocalCodexServerMock = mock(async () => ({
  port: 4100,
  pid: 10,
  authToken: "local-token",
}));
const getCodexServerStatusMock = mock(async () => ({
  running: true,
  hostPort: 4200,
  authToken: "container-token",
}));
const startCodexServerMock = mock(async () => ({
  hostPort: 4200,
  authToken: "container-token",
}));
const scrollToBottomMock = mock(() => undefined);
const useVirtuosoScrollStateMock = mock((_options: unknown) => ({
  isAtBottom: true,
  isAtBottomRef: { current: true },
  scrollToBottom: scrollToBottomMock,
  virtuosoRef: { current: null },
  scrollProps: {},
}));

// Stub the heavy chat children so the (briefly-rendered) chat tab is cheap to mount.
mock.module("@/components/chat/VirtualizedMessageList", () => ({
  VirtualizedMessageList: ({
    messages,
    renderMessage,
    computeItemKey,
    footer,
  }: {
    messages: Array<{ id: string }>;
    renderMessage: (index: number, message: never, previousMessage: never) => ReactNode;
    computeItemKey: (index: number, message: { id: string }) => string;
    footer?: ReactNode;
  }) => (
    <div data-testid="virtualized-list">
      {messages.map((message, index) => (
        <div key={message.id} data-item-key={computeItemKey(index, message)}>
          {renderMessage(index, message as never, messages[index - 1] as never)}
        </div>
      ))}
      {footer}
    </div>
  ),
}));
mock.module("@/components/chat/NativeComposeDock", () => ({
  NativeComposeDock: ({
    children,
    topAccessory,
  }: {
    children?: ReactNode;
    topAccessory?: ReactNode;
  }) => <div>{topAccessory}{children}</div>,
}));
mock.module("@/components/chat/NativeMessage", () => ({
  NativeMessage: ({
    message,
    previousMessage,
  }: {
    message: { id: string; content: string };
    previousMessage?: { id: string };
  }) => (
    <div
      data-testid={`native-message-${message.id}`}
      data-previous-id={previousMessage?.id ?? ""}
    >
      {message.content}
    </div>
  ),
}));

mock.module("@/hooks", () => ({
  ...realHooksSnapshot,
  useVirtuosoScrollState: useVirtuosoScrollStateMock,
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
  checkHealth: checkHealthMock,
  createClient: createClientMock,
  createSession: createSessionMock,
  getSessionStatus: getSessionStatusMock,
  getSessionMessages: getSessionMessagesMock,
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

const { FeaturesView, NativeStyleChatPanel } = await import("@/components/kanban/FeaturesView");

afterAll(() => {
  mock.module("@/components/chat/VirtualizedMessageList", () => realVirtualizedMessageListSnapshot);
  mock.module("@/components/chat/NativeComposeDock", () => realNativeComposeDockSnapshot);
  mock.module("@/components/chat/NativeMessage", () => realNativeMessageSnapshot);
  mock.module("@/hooks", () => realHooksSnapshot);
  mock.module("@/hooks/useBuildPipeline", () => realUseBuildPipelineSnapshot);
  mock.module("@/hooks/useEnvironments", () => realUseEnvironmentsSnapshot);
  mock.module("@/lib/codex-client", () => realCodexClientSnapshot);
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

const NOW = "2026-01-01T00:00:00.000Z";

function pendingUser(createdAt = NOW, id = "pending-user"): FeaturePlanMessage {
  return {
    id,
    role: "user",
    content: id,
    createdAt,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushReconcileStart(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
  });
}

async function waitForConversationToSettle(featureId = "feature-1"): Promise<void> {
  await waitFor(() => expect(
    useFeaturePlanStore.getState().activeConversations.has(featureId),
  ).toBe(false));
}

/**
 * Transcript reads recorded for one session id.
 *
 * `getSessionMessagesMock` is module level and live feature sends deliberately
 * survive unmounts (see AGENTS.md), so a bare `not.toHaveBeenCalled()` also sees
 * work leaked from earlier tests and fails at random under `--parallel`. Seeding
 * a unique `codexSessionId` and filtering on it keeps the "this conversation was
 * never hydrated" assertion exact without that coupling.
 */
function messageReadsFor(sessionId: string): unknown[][] {
  return getSessionMessagesMock.mock.calls.filter(
    (call) => (call as unknown as unknown[])[1] === sessionId,
  );
}

/** Status reads recorded for one session id. See {@link messageReadsFor}. */
function statusReadsFor(sessionId: string): unknown[][] {
  return getSessionStatusMock.mock.calls.filter(
    (call) => (call as unknown as unknown[])[1] === sessionId,
  );
}

async function waitForConversationPhase(
  phase: ActiveFeatureConversation["phase"],
  featureId = "feature-1",
): Promise<void> {
  await waitFor(() => expect(
    useFeaturePlanStore.getState().activeConversations.get(featureId)?.phase,
  ).toBe(phase));
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

function makeEnvironment(overrides: Partial<Environment> = {}): Environment {
  return {
    id: "env-feature",
    projectId: "project-1",
    name: "feature-env",
    branch: "main",
    containerId: "container-feature",
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

function makeCodexMessage(overrides: Partial<CodexMessage> = {}): CodexMessage {
  return {
    id: "codex-message-1",
    role: "assistant",
    content: "Codex response",
    parts: [],
    createdAt: NOW,
    ...overrides,
  };
}

function featurePlannerReply(text: string): string {
  return `${text}
<feature_planner_state>{"phase":"collecting","title":"My Feature","summary":""}</feature_planner_state>`;
}

function seedExistingCodexEnvironment(environment: Environment = makeEnvironment()) {
  useEnvironmentStore.setState({ environments: [environment] });
}

function chatFeature(overrides: Partial<FeaturePlan> = {}): FeaturePlan {
  return featureWithStories({
    status: "collecting",
    stories: [],
    codexEnvironmentId: "env-feature",
    codexSessionId: "session-existing",
    ...overrides,
  });
}

function openStory(title = "Story 1") {
  fireEvent.click(screen.getByRole("button", {
    name: `${title} Story description 1 acceptance criteria`,
  }));
}

function updateFeatureInStore(featureId: string, updates: Partial<FeaturePlan>): FeaturePlan | undefined {
  const feature = useFeaturePlanStore.getState().features.find((candidate) => candidate.id === featureId);
  if (!feature) return undefined;
  const updated = { ...feature, ...updates };
  useFeaturePlanStore.setState((state) => ({
    features: state.features.map((candidate) => candidate.id === featureId ? updated : candidate),
  }));
  return updated;
}

function appendFeatureMessageInStore(
  featureId: string,
  role: FeaturePlanMessage["role"],
  content: string,
  stateApplication?: FeaturePlanMessage["stateApplication"],
): FeaturePlan | undefined {
  const feature = useFeaturePlanStore.getState().features.find((candidate) => candidate.id === featureId);
  if (!feature) return undefined;
  return updateFeatureInStore(featureId, {
    messages: [...feature.messages, {
      id: `${role}-${feature.messages.length + 1}`,
      role,
      content,
      createdAt: NOW,
      ...(stateApplication ? { stateApplication } : {}),
    }],
  });
}

function appendStoryMessageInStore(
  featureId: string,
  storyId: string,
  role: FeaturePlanMessage["role"],
  content: string,
  stateApplication?: FeaturePlanMessage["stateApplication"],
): FeaturePlan | undefined {
  const feature = useFeaturePlanStore.getState().features.find((candidate) => candidate.id === featureId);
  if (!feature) return undefined;
  return updateFeatureInStore(featureId, {
    stories: feature.stories.map((story) => story.id === storyId
      ? {
          ...story,
          messages: [...story.messages, {
            id: `${role}-${story.messages.length + 1}`,
            role,
            content,
            createdAt: NOW,
            ...(stateApplication ? { stateApplication } : {}),
          }],
        }
      : story),
  });
}

function seedStores(featureOrFeatures: FeaturePlan | FeaturePlan[]) {
  const features = Array.isArray(featureOrFeatures) ? featureOrFeatures : [featureOrFeatures];
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
    features,
    isLoading: false,
    currentProjectId: "project-1",
    activeConversations: new Map(),
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
  mockToastError.mockClear();
  mockToastWarning.mockClear();
  startBuildMock.mockClear();
  startBuildMock.mockImplementation(async () => undefined);
  addTaskMock.mockClear();
  addTaskMock.mockImplementation(async () => "task-1");
  updateTaskMock.mockClear();
  createFeatureMock.mockClear();
  createFeatureMock.mockImplementation(async (projectId) => {
    const created = featureWithStories({
      id: "feature-new",
      projectId,
      title: "",
      status: "collecting",
      stories: [],
      order: useFeaturePlanStore.getState().features.length,
    });
    useFeaturePlanStore.setState((state) => ({ features: [...state.features, created] }));
    return created.id;
  });
  appendMessageMock.mockClear();
  appendMessageMock.mockImplementation(async (featureId, role, content, stateApplication) =>
    appendFeatureMessageInStore(featureId, role, content, stateApplication)
  );
  appendStoryMessageMock.mockClear();
  appendStoryMessageMock.mockImplementation(async (
    featureId,
    storyId,
    role,
    content,
    stateApplication,
  ) =>
    appendStoryMessageInStore(
      featureId,
      storyId,
      role,
      content,
      stateApplication,
    )
  );
  updateFeatureMock.mockClear();
  updateFeatureMock.mockImplementation(async (featureId, updates) =>
    updateFeatureInStore(featureId, updates)
  );
  loadFeaturesMock.mockClear();
  createEnvironmentMock.mockClear();
  createEnvironmentMock.mockImplementation(async () => makeEnvironment());
  startEnvironmentMock.mockClear();
  startEnvironmentMock.mockImplementation(async () => undefined);
  createClientMock.mockClear();
  createClientMock.mockImplementation((baseUrl, authToken) => ({ baseUrl, authToken }));
  checkHealthMock.mockClear();
  checkHealthMock.mockResolvedValue(true);
  createSessionMock.mockClear();
  createSessionMock.mockImplementation(async () => ({ sessionId: "session-new" }));
  getSessionStatusMock.mockClear();
  getSessionStatusMock.mockImplementation(async () => ({ status: "idle" }));
  getSessionMessagesMock.mockClear();
  getSessionMessagesMock.mockImplementation(async () => []);
  sendPromptMock.mockClear();
  sendPromptMock.mockImplementation(async () => true);
  getEnvironmentMock.mockClear();
  getEnvironmentMock.mockImplementation(async () => null);
  updateEnvironmentAgentSettingsMock.mockClear();
  updateEnvironmentAgentSettingsMock.mockImplementation(async (environmentId) =>
    makeEnvironment({ id: environmentId })
  );
  getLocalCodexServerStatusMock.mockClear();
  getLocalCodexServerStatusMock.mockImplementation(async () => ({
    running: true,
    port: 4100,
    pid: 10,
    authToken: "local-token",
  }));
  startLocalCodexServerMock.mockClear();
  startLocalCodexServerMock.mockImplementation(async () => ({
    port: 4100,
    pid: 10,
    authToken: "local-token",
  }));
  getCodexServerStatusMock.mockClear();
  getCodexServerStatusMock.mockImplementation(async () => ({
    running: true,
    hostPort: 4200,
    authToken: "container-token",
  }));
  startCodexServerMock.mockClear();
  startCodexServerMock.mockImplementation(async () => ({
    hostPort: 4200,
    authToken: "container-token",
  }));
  scrollToBottomMock.mockClear();
  useVirtuosoScrollStateMock.mockClear();
  useVirtuosoScrollStateMock.mockImplementation(() => ({
    isAtBottom: true,
    isAtBottomRef: { current: true },
    scrollToBottom: scrollToBottomMock,
    virtuosoRef: { current: null },
    scrollProps: {},
  }));
  useConfigStore.setState({
    config: structuredClone(defaultConfigSnapshot),
    isLoading: false,
    error: null,
  });
  useEnvironmentStore.setState({
    environments: [],
    isLoading: false,
    error: null,
    workspaceReadyEnvironments: new Set(),
    deletingEnvironments: new Set(),
    pendingSetupCommands: new Map(),
    setupCommandsResolved: new Set(),
    setupScriptsRunning: new Set(),
    sessionActivated: new Set(),
  });
  useFeaturePlanStore.setState({
    chatDrafts: new Map(),
    activeConversations: new Map(),
  });
  useBuildPipelineStore.setState({ pipelines: new Map(), buildEnvironmentIds: new Set() });
});

describe("FeaturesView message drafts", () => {
  test("restores an unfinished feature message after remounting", () => {
    seedStores(chatFeature());
    const view = render(<FeaturesView projectId="project-1" />);
    const composer = screen.getByPlaceholderText("Describe the feature or answer Codex...");

    fireEvent.change(composer, { target: { value: "A half-finished feature message" } });
    view.unmount();
    render(<FeaturesView projectId="project-1" />);

    expect((screen.getByPlaceholderText(
      "Describe the feature or answer Codex..."
    ) as HTMLTextAreaElement).value).toBe("A half-finished feature message");
  });

  test("restores an unfinished story message after remounting and reopening the story", () => {
    seedStores(featureWithStories());
    const view = render(<FeaturesView projectId="project-1" />);
    openStory();
    const composer = screen.getByPlaceholderText("Refine the story, description, or acceptance criteria...");

    fireEvent.change(composer, { target: { value: "Keep this story thought" } });
    view.unmount();
    render(<FeaturesView projectId="project-1" />);
    openStory();

    expect((screen.getByPlaceholderText(
      "Refine the story, description, or acceptance criteria..."
    ) as HTMLTextAreaElement).value).toBe("Keep this story thought");
  });

  test("keeps feature drafts isolated while switching conversations", async () => {
    seedStores([
      chatFeature({ id: "feature-1", title: "First Feature", order: 0 }),
      chatFeature({ id: "feature-2", title: "Second Feature", order: 1 }),
    ]);
    useFeaturePlanStore.setState({
      chatDrafts: new Map([
        ["feature:feature-1", "first feature draft"],
        ["feature:feature-2", "second feature draft"],
      ]),
    });
    render(<FeaturesView projectId="project-1" />);

    expect((screen.getByPlaceholderText(
      "Describe the feature or answer Codex..."
    ) as HTMLTextAreaElement).value).toBe("first feature draft");
    fireEvent.click(screen.getByText("Second Feature").closest("button")!);
    await waitFor(() => expect((screen.getByPlaceholderText(
      "Describe the feature or answer Codex..."
    ) as HTMLTextAreaElement).value).toBe("second feature draft"));
    fireEvent.click(screen.getByText("First Feature").closest("button")!);
    await waitFor(() => expect((screen.getByPlaceholderText(
      "Describe the feature or answer Codex..."
    ) as HTMLTextAreaElement).value).toBe("first feature draft"));
  });

  test("clears only the submitted feature and story drafts", async () => {
    seedStores(chatFeature());
    seedExistingCodexEnvironment();
    useFeaturePlanStore.setState({
      chatDrafts: new Map([
        ["feature:feature-1", "send feature"],
        ["feature:other", "leave feature"],
      ]),
    });
    render(<FeaturesView projectId="project-1" />);

    fireEvent.click(screen.getByTitle("Send message"));
    await waitFor(() => expect(appendMessageMock).toHaveBeenCalledWith(
      "feature-1",
      "user",
      "send feature",
    ));
    expect(useFeaturePlanStore.getState().getChatDraft("feature:feature-1")).toBe("");
    expect(useFeaturePlanStore.getState().getChatDraft("feature:other")).toBe("leave feature");

    cleanup();
    seedStores(featureWithStories({
      codexEnvironmentId: "env-feature",
      codexSessionId: "session-existing",
    }));
    seedExistingCodexEnvironment();
    useFeaturePlanStore.setState({
      chatDrafts: new Map([
        ["feature:feature-1:story:story-1", "send story"],
        ["feature:feature-1", "leave chat"],
      ]),
    });
    render(<FeaturesView projectId="project-1" />);
    openStory();
    fireEvent.click(screen.getByTitle("Send message"));

    await waitFor(() => expect(appendStoryMessageMock).toHaveBeenCalledWith(
      "feature-1",
      "story-1",
      "user",
      "send story",
    ));
    expect(useFeaturePlanStore.getState().getChatDraft("feature:feature-1:story:story-1")).toBe("");
    expect(useFeaturePlanStore.getState().getChatDraft("feature:feature-1")).toBe("leave chat");
  });
});

describe("FeaturesView conversation ordering", () => {
  test("shows the feature with the most recent user message first", () => {
    seedStores([
      featureWithStories({
        id: "feature-old",
        title: "Older user message",
        order: 0,
        messages: [
          {
            id: "old-user",
            role: "user",
            content: "An older request",
            createdAt: "2026-01-02T00:00:00.000Z",
          },
          {
            id: "new-assistant",
            role: "assistant",
            content: "A newer assistant reply",
            createdAt: "2026-01-04T00:00:00.000Z",
          },
        ],
      }),
      featureWithStories({
        id: "feature-recent",
        title: "Recent user message",
        order: 1,
        messages: [{
          id: "recent-user",
          role: "user",
          content: "The latest request",
          createdAt: "2026-01-03T00:00:00.000Z",
        }],
      }),
    ]);

    render(<FeaturesView projectId="project-1" />);

    const featureButtons = screen.getAllByRole("button").filter((button) =>
      button.textContent?.includes("user message")
    );
    expect(featureButtons.map((button) => button.textContent)).toEqual([
      expect.stringContaining("Recent user message"),
      expect.stringContaining("Older user message"),
    ]);
  });

  test("uses the latest valid user timestamp across multiple messages", () => {
    seedStores([
      featureWithStories({
        id: "feature-a",
        title: "Feature A",
        order: 5,
        messages: [
          { id: "a-1", role: "user", content: "old", createdAt: "2026-01-02T00:00:00.000Z" },
          { id: "a-bad", role: "user", content: "bad", createdAt: "not-a-date" },
          { id: "a-2", role: "user", content: "new", createdAt: "2026-01-05T00:00:00.000Z" },
        ],
      }),
      featureWithStories({
        id: "feature-b",
        title: "Feature B",
        order: 0,
        messages: [
          { id: "b-1", role: "user", content: "middle", createdAt: "2026-01-04T00:00:00.000Z" },
        ],
      }),
    ]);

    render(<FeaturesView projectId="project-1" />);

    const buttons = screen.getAllByRole("button").filter((button) =>
      button.textContent?.startsWith("Feature ")
    );
    expect(buttons.map((button) => button.textContent?.slice(0, 9))).toEqual([
      "Feature A",
      "Feature B",
    ]);
  });

  test("falls back to persisted order for tied, missing, and invalid user timestamps", () => {
    seedStores([
      featureWithStories({
        id: "valid-later-order",
        title: "Valid later order",
        order: 5,
        messages: [{ id: "v1", role: "user", content: "same", createdAt: "2026-01-03T00:00:00.000Z" }],
      }),
      featureWithStories({
        id: "valid-earlier-order",
        title: "Valid earlier order",
        order: 1,
        messages: [{ id: "v2", role: "user", content: "same", createdAt: "2026-01-03T00:00:00.000Z" }],
      }),
      featureWithStories({
        id: "invalid-later-order",
        title: "Invalid later order",
        order: 2,
        messages: [{ id: "i1", role: "user", content: "bad", createdAt: "invalid" }],
      }),
      featureWithStories({
        id: "missing-earlier-order",
        title: "Missing earlier order",
        order: 0,
        messages: [{ id: "assistant", role: "assistant", content: "reply", createdAt: NOW }],
      }),
    ]);

    render(<FeaturesView projectId="project-1" />);

    const titles = [
      "Valid earlier order",
      "Valid later order",
      "Missing earlier order",
      "Invalid later order",
    ];
    const ordered = screen.getAllByRole("button")
      .map((button) => titles.find((title) => button.textContent?.includes(title)))
      .filter(Boolean);
    expect(ordered).toEqual(titles);
  });

  test("filters other projects and does not let nested story activity change feature order", () => {
    seedStores([
      featureWithStories({
        id: "feature-first",
        title: "First project feature",
        order: 0,
        stories: [makeStory({
          messages: [{
            id: "story-new",
            role: "user",
            content: "nested activity",
            createdAt: "2026-01-09T00:00:00.000Z",
          }],
        })],
      }),
      featureWithStories({
        id: "feature-second",
        title: "Second project feature",
        order: 1,
      }),
      featureWithStories({
        id: "other-project",
        projectId: "project-2",
        title: "Other project feature",
        order: 0,
        messages: [{
          id: "other-new",
          role: "user",
          content: "newest",
          createdAt: "2026-01-10T00:00:00.000Z",
        }],
      }),
    ]);

    render(<FeaturesView projectId="project-1" />);

    expect(screen.queryByText("Other project feature")).toBeNull();
    const buttons = screen.getAllByRole("button").filter((button) =>
      button.textContent?.includes("project feature")
    );
    expect(buttons.map((button) => button.textContent)).toEqual([
      expect.stringContaining("First project feature"),
      expect.stringContaining("Second project feature"),
    ]);
  });

  test("retains the selected feature when message activity reorders the list", async () => {
    const featureA = featureWithStories({
      id: "feature-a",
      title: "Feature A",
      stories: [],
      status: "collecting",
      order: 0,
    });
    const featureB = featureWithStories({
      id: "feature-b",
      title: "Feature B",
      order: 1,
      messages: [{ id: "b-old", role: "user", content: "old", createdAt: "2026-01-02T00:00:00.000Z" }],
    });
    seedStores([featureA, featureB]);
    render(<FeaturesView projectId="project-1" />);

    fireEvent.click(screen.getByText("Feature B").closest("button")!);
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Stories" }).getAttribute("aria-selected")).toBe("true");
    });

    act(() => {
      useFeaturePlanStore.setState({
        features: [
          {
            ...featureA,
            messages: [{
              id: "a-new",
              role: "user",
              content: "new",
              createdAt: "2026-01-05T00:00:00.000Z",
            }],
          },
          featureB,
        ],
      });
    });

    const buttons = screen.getAllByRole("button").filter((button) =>
      button.textContent?.startsWith("Feature ")
    );
    expect(buttons[0]?.textContent).toContain("Feature A");
    expect(screen.getByRole("tab", { name: "Stories" }).getAttribute("aria-selected")).toBe("true");
  });
});

describe("FeaturesView lifecycle and navigation", () => {
  test("keeps the working state when the view is unmounted and mounted again", async () => {
    sendPromptMock.mockImplementationOnce(() => new Promise(() => undefined));
    seedStores(chatFeature());
    seedExistingCodexEnvironment();
    const view = render(<FeaturesView projectId="project-1" />);
    await flushReconcileStart();

    fireEvent.change(screen.getByPlaceholderText("Describe the feature or answer Codex..."), {
      target: { value: "Keep working in the background" },
    });
    fireEvent.click(screen.getByTitle("Send message"));
    await screen.findByText("Codex is working...");

    view.unmount();
    getSessionStatusMock.mockImplementation(async () => ({ status: "running" }));
    render(<FeaturesView projectId="project-1" />);

    expect(screen.getByText("Codex is working...")).toBeTruthy();
    expect(screen.getByTitle("Send message").hasAttribute("disabled")).toBe(true);
    await waitFor(() => expect(getSessionStatusMock).toHaveBeenCalledWith(
      { baseUrl: "http://127.0.0.1:4200", authToken: "container-token" },
      "session-existing",
      { throwOnError: true },
    ));
    await waitForConversationPhase("running");
  });

  test("does not cancel dispatch when remounting before the user message append resolves", async () => {
    const pendingAppend = deferred<FeaturePlan | undefined>();
    appendMessageMock.mockImplementationOnce(async () => pendingAppend.promise);
    sendPromptMock.mockImplementationOnce(() => new Promise(() => undefined));
    seedStores(chatFeature());
    seedExistingCodexEnvironment();
    const view = render(<FeaturesView projectId="project-1" />);

    fireEvent.change(screen.getByPlaceholderText("Describe the feature or answer Codex..."), {
      target: { value: "Persist before dispatch" },
    });
    fireEvent.click(screen.getByTitle("Send message"));
    await waitFor(() => expect(appendMessageMock).toHaveBeenCalledWith(
      "feature-1",
      "user",
      "Persist before dispatch",
    ));
    const operationId = useFeaturePlanStore.getState()
      .activeConversations.get("feature-1")?.operationId;
    expect(operationId).toBeTruthy();

    view.unmount();
    render(<FeaturesView projectId="project-1" />);
    await flushReconcileStart();

    expect(useFeaturePlanStore.getState().activeConversations.get("feature-1")).toMatchObject({
      operationId,
      phase: "dispatching",
    });
    expect(sendPromptMock).not.toHaveBeenCalled();

    await act(async () => {
      pendingAppend.resolve(
        appendFeatureMessageInStore("feature-1", "user", "Persist before dispatch"),
      );
    });

    await waitFor(() => expect(sendPromptMock).toHaveBeenCalledTimes(1));
    expect(sendPromptMock).toHaveBeenCalledWith(
      { baseUrl: "http://127.0.0.1:4200", authToken: "container-token" },
      "session-existing",
      "Persist before dispatch",
    );
    expect(useFeaturePlanStore.getState().activeConversations.get("feature-1")).toMatchObject({
      operationId,
      userMessageId: "user-1",
      phase: "dispatching",
    });
  });

  test("rehydrates working state from the Codex session after renderer state is lost", async () => {
    seedStores(chatFeature({
      messages: [{
        id: "pending-user",
        role: "user",
        content: "Continue even while this view is inactive",
        createdAt: NOW,
      }],
    }));
    seedExistingCodexEnvironment();
    useFeaturePlanStore.setState({ activeConversations: new Map() });
    getSessionStatusMock.mockImplementation(async () => ({ status: "running" }));

    render(<FeaturesView projectId="project-1" />);

    await screen.findByText("Codex is working...");
    await waitFor(() => expect(getSessionStatusMock).toHaveBeenCalledWith(
      { baseUrl: "http://127.0.0.1:4200", authToken: "container-token" },
      "session-existing",
      { throwOnError: true },
    ));
    expect(useFeaturePlanStore.getState().activeConversations.get("feature-1")).toMatchObject({
      operationId: expect.any(String),
      featureId: "feature-1",
      userMessageId: "pending-user",
      startedAt: NOW,
      phase: "running",
    });
    expect(screen.getByTitle("Send message").hasAttribute("disabled")).toBe(true);
  });

  test("hydrates and applies a restored feature response before settling an idle session", async () => {
    const realSetTimeout = globalThis.setTimeout;
    const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: TimerHandler,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (typeof callback === "function" && delay === 1_500) {
        return realSetTimeout(callback, 0, ...args);
      }
      return realSetTimeout(callback, delay, ...args);
    }) as typeof setTimeout);
    const response = makeCodexMessage({
      content: `Recovered response
<feature_planner_state>{"phase":"confirming","title":"Recovered Feature","summary":"restored"}</feature_planner_state>`,
    });
    seedStores(chatFeature({
      messages: [{
        id: "pending-user",
        role: "user",
        content: "This turn finished while the view was inactive",
        createdAt: NOW,
      }],
    }));
    seedExistingCodexEnvironment();
    getSessionStatusMock
      .mockImplementationOnce(async () => ({ status: "running" }))
      .mockImplementationOnce(async () => ({ status: "idle" }));
    getSessionMessagesMock.mockImplementation(async () => [response]);

    try {
      render(<FeaturesView projectId="project-1" />);
      await act(async () => {
        await new Promise<void>((resolve) => realSetTimeout(resolve, 10));
      });
    } finally {
      timeoutSpy.mockRestore();
    }
    await waitFor(() => {
      expect(useFeaturePlanStore.getState().activeConversations.has("feature-1")).toBe(false);
      expect(appendMessageMock).toHaveBeenCalledWith(
        "feature-1",
        "assistant",
        response.content,
        "pending",
      );
    });
    expect(updateFeatureMock).toHaveBeenCalledWith("feature-1", expect.objectContaining({
      title: "Recovered Feature",
      summary: "restored",
      status: "confirming",
    }));
    expect(getSessionStatusMock).toHaveBeenCalledTimes(2);
    expect(createClientMock).toHaveBeenCalledTimes(1);
    expect(getCodexServerStatusMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Recovered response")).toBeTruthy();
  });

  test("selects the newest valid unanswered feature or story conversation", async () => {
    const stories = [
      makeStory({ id: "invalid", messages: [pendingUser("not-a-date", "invalid")] }),
      makeStory({ id: "old", messages: [pendingUser("2026-01-02T00:00:00.000Z", "old")] }),
      makeStory({ id: "latest", messages: [pendingUser("2026-01-03T00:00:00.000Z", "latest")] }),
    ];
    seedStores(chatFeature({
      messages: [pendingUser("2026-01-01T00:00:00.000Z", "feature-old")],
      stories,
    }));
    seedExistingCodexEnvironment();
    getSessionStatusMock.mockImplementation(async () => ({ status: "running" }));

    render(<FeaturesView projectId="project-1" />);
    await waitFor(() => expect(
      useFeaturePlanStore.getState().activeConversations.get("feature-1"),
    ).toMatchObject({
      storyId: "latest",
      startedAt: "2026-01-03T00:00:00.000Z",
    }));

    cleanup();
    useFeaturePlanStore.setState({ activeConversations: new Map() });
    seedStores(chatFeature({
      messages: [pendingUser("2026-01-04T00:00:00.000Z", "feature-latest")],
      stories,
    }));
    render(<FeaturesView projectId="project-1" />);
    await waitFor(() => expect(
      useFeaturePlanStore.getState().activeConversations.get("feature-1")?.startedAt,
    ).toBe("2026-01-04T00:00:00.000Z"));
    expect(
      useFeaturePlanStore.getState().activeConversations.get("feature-1")?.storyId,
    ).toBeUndefined();
  });

  test("replaces a stale cached actor and monitors the newest pending message", async () => {
    seedStores(chatFeature({
      messages: [pendingUser("2026-01-03T00:00:00.000Z", "newest-user")],
    }));
    seedExistingCodexEnvironment();
    useFeaturePlanStore.getState().startConversation({
      operationId: "stale-operation",
      featureId: "feature-1",
      startedAt: "2026-01-01T00:00:00.000Z",
      phase: "running",
    });
    getSessionStatusMock.mockImplementation(async () => ({ status: "running" }));

    render(<FeaturesView projectId="project-1" />);

    await waitFor(() => expect(getSessionStatusMock).toHaveBeenCalledWith(
      { baseUrl: "http://127.0.0.1:4200", authToken: "container-token" },
      "session-existing",
      { throwOnError: true },
    ));
    const activeConversation = useFeaturePlanStore.getState().activeConversations.get("feature-1");
    expect(activeConversation).toMatchObject({
      featureId: "feature-1",
      startedAt: "2026-01-03T00:00:00.000Z",
      phase: "running",
    });
    expect(activeConversation?.operationId).not.toBe("stale-operation");
    expect(screen.getByTitle("Send message").hasAttribute("disabled")).toBe(true);
  });

  test("does not reconcile answered conversations or malformed timestamps", async () => {
    const answeredSessionId = "session-answered-or-malformed";
    seedStores(chatFeature({
      codexSessionId: answeredSessionId,
      messages: [{
        id: "answered",
        role: "assistant",
        content: "Done",
        createdAt: NOW,
      }],
      stories: [makeStory({ messages: [pendingUser("not-a-date")] })],
    }));
    seedExistingCodexEnvironment();

    render(<FeaturesView projectId="project-1" />);
    await flushReconcileStart();

    expect(statusReadsFor(answeredSessionId)).toHaveLength(0);
    expect(useFeaturePlanStore.getState().activeConversations.size).toBe(0);
  });

  test("keeps stale and invalid-timestamp restored feature replies blocked", async () => {
    const staleReply = makeCodexMessage({
      id: "stale-reply",
      content: featurePlannerReply("Do not restore this stale reply"),
      createdAt: "2025-12-31T23:59:59.000Z",
    });
    const invalidTimestampReply = makeCodexMessage({
      id: "invalid-timestamp-reply",
      content: featurePlannerReply("Do not restore this invalid reply"),
      createdAt: "not-a-date",
    });
    seedStores(chatFeature({ messages: [pendingUser()] }));
    seedExistingCodexEnvironment();
    getSessionStatusMock.mockImplementation(async () => ({ status: "idle" }));
    getSessionMessagesMock.mockImplementation(async () => [
      staleReply,
      invalidTimestampReply,
    ]);

    render(<FeaturesView projectId="project-1" />);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "no matching response was found",
    );
    expect(useFeaturePlanStore.getState().activeConversations.get("feature-1")).toMatchObject({
      featureId: "feature-1",
      phase: "unavailable",
    });
    expect(appendMessageMock).not.toHaveBeenCalled();
    expect(updateFeatureMock).not.toHaveBeenCalled();
    expect(useFeaturePlanStore.getState().features[0]?.title).toBe("My Feature");
    expect(screen.getByTitle("Send message").hasAttribute("disabled")).toBe(true);
  });

  test("hydrates a restored story refinement before settling", async () => {
    const refinement = `Recovered story.
<story_refinement>{"storyId":"story-1","title":"Recovered Story","description":"Recovered description","acceptanceCriteria":["Recovered criterion"]}</story_refinement>`;
    seedStores(featureWithStories({
      codexEnvironmentId: "env-feature",
      codexSessionId: "session-existing",
      stories: [makeStory({ messages: [pendingUser()] })],
    }));
    seedExistingCodexEnvironment();
    getSessionStatusMock.mockImplementation(async () => ({ status: "idle" }));
    getSessionMessagesMock.mockImplementation(async () => [
      makeCodexMessage({ id: "story-reply", content: refinement }),
    ]);

    render(<FeaturesView projectId="project-1" />);

    await waitFor(() => expect(appendStoryMessageMock).toHaveBeenCalledWith(
      "feature-1",
      "story-1",
      "assistant",
      refinement,
      "pending",
    ));
    expect(updateFeatureMock).toHaveBeenCalledWith("feature-1", expect.objectContaining({
      stories: [expect.objectContaining({
        id: "story-1",
        title: "Recovered Story",
        description: "Recovered description",
        acceptanceCriteria: ["Recovered criterion"],
      })],
    }));
    expect(useFeaturePlanStore.getState().activeConversations.has("feature-1")).toBe(false);
  });

  test("keeps restored feature append failures unavailable without applying state", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => undefined);
    const response = makeCodexMessage({
      content: `Recovered response
<feature_planner_state>{"phase":"confirming","title":"Must Not Apply","summary":"must not apply"}</feature_planner_state>`,
    });
    seedStores(chatFeature({ messages: [pendingUser()] }));
    seedExistingCodexEnvironment();
    appendMessageMock.mockImplementationOnce(async () => undefined);
    getSessionStatusMock.mockImplementation(async () => ({ status: "idle" }));
    getSessionMessagesMock.mockImplementation(async () => [response]);

    try {
      render(<FeaturesView projectId="project-1" />);

      expect((await screen.findByRole("alert")).textContent).toContain(
        "Failed to persist the feature planning response",
      );
      expect(useFeaturePlanStore.getState().activeConversations.get("feature-1")).toMatchObject({
        featureId: "feature-1",
        phase: "unavailable",
        error: "Failed to persist the feature planning response",
      });
      expect(updateFeatureMock).not.toHaveBeenCalled();
      expect(useFeaturePlanStore.getState().features[0]?.title).toBe("My Feature");
      expect(screen.getByTitle("Send message").hasAttribute("disabled")).toBe(true);
    } finally {
      consoleError.mockRestore();
    }
  });

  test("keeps restored story append failures unavailable without applying state", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => undefined);
    const refinement = `Recovered story.
<story_refinement>{"storyId":"story-1","title":"Must Not Apply","description":"must not apply"}</story_refinement>`;
    seedStores(featureWithStories({
      codexEnvironmentId: "env-feature",
      codexSessionId: "session-existing",
      stories: [makeStory({ messages: [pendingUser()] })],
    }));
    seedExistingCodexEnvironment();
    appendStoryMessageMock.mockImplementationOnce(async () => undefined);
    getSessionStatusMock.mockImplementation(async () => ({ status: "idle" }));
    getSessionMessagesMock.mockImplementation(async () => [
      makeCodexMessage({ id: "story-reply", content: refinement }),
    ]);

    try {
      render(<FeaturesView projectId="project-1" />);

      await waitFor(() => expect(
        useFeaturePlanStore.getState().activeConversations.get("feature-1"),
      ).toMatchObject({
        featureId: "feature-1",
        storyId: "story-1",
        phase: "unavailable",
        error: "Failed to persist the story refinement response",
      }));
      openStory();
      expect((await screen.findByRole("alert")).textContent).toContain(
        "Failed to persist the story refinement response",
      );
      expect(updateFeatureMock).not.toHaveBeenCalled();
      expect(useFeaturePlanStore.getState().features[0]?.stories[0]?.title).toBe("Story 1");
      expect(screen.getByTitle("Send message").hasAttribute("disabled")).toBe(true);
    } finally {
      consoleError.mockRestore();
    }
  });

  test("surfaces terminal status errors and retries recovery without redispatching", async () => {
    const recovered = makeCodexMessage({
      content: `Recovered after retry.
<feature_planner_state>{"phase":"collecting","title":"Retry Recovered","summary":""}</feature_planner_state>`,
    });
    seedStores(chatFeature({ messages: [pendingUser()] }));
    seedExistingCodexEnvironment();
    getSessionStatusMock.mockImplementationOnce(async () => ({
      status: "error",
      error: "model failed",
    }));

    render(<FeaturesView projectId="project-1" />);

    expect((await screen.findByRole("alert")).textContent).toContain("model failed");
    expect(screen.getByTitle("Send message").hasAttribute("disabled")).toBe(true);

    getSessionStatusMock.mockImplementation(async () => ({ status: "idle" }));
    getSessionMessagesMock.mockImplementation(async () => [recovered]);
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));

    await waitFor(() => expect(appendMessageMock).toHaveBeenCalledWith(
      "feature-1",
      "assistant",
      recovered.content,
      "pending",
    ));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(sendPromptMock).not.toHaveBeenCalled();
  });

  test("bounds status retries and requires an explicit stop before unlocking", async () => {
    const realSetTimeout = globalThis.setTimeout;
    // The reconcile poll and its failure backoff are the only timers this view
    // schedules at or above POLL_INTERVAL_MS (every other one is 0ms), so
    // collapsing that whole band both keeps the test fast and records the backoff
    // schedule. Recording rather than hardcoding the delays means a changed
    // schedule fails on the assertion below instead of silently timing out.
    const scheduledBackoffs: number[] = [];
    const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: TimerHandler,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (typeof callback === "function" && typeof delay === "number" && delay >= 1_500) {
        scheduledBackoffs.push(delay);
        return realSetTimeout(callback, 0, ...args);
      }
      return realSetTimeout(callback, delay, ...args);
    }) as typeof setTimeout);
    // Every identifier this test asserts on is unique to it. The spies are module
    // level and live feature sends deliberately survive unmounts, so a raw call
    // count would also see work leaked from earlier tests; filtering by these
    // identifiers keeps the assertions exact without reintroducing that coupling.
    const boundedSessionId = "session-bounded-status-retries";
    const boundedContainerId = "container-bounded-status-retries";
    const boundedBaseUrl = "http://127.0.0.1:4321";
    seedStores(chatFeature({
      codexSessionId: boundedSessionId,
      messages: [pendingUser()],
    }));
    seedExistingCodexEnvironment(makeEnvironment({ containerId: boundedContainerId }));
    getCodexServerStatusMock.mockImplementation(async () => ({ running: true, hostPort: 4321 }));
    getSessionStatusMock.mockImplementation(async () => {
      throw new Error("bridge unavailable");
    });

    let recoveryAlert: HTMLElement | null = null;
    try {
      render(<FeaturesView projectId="project-1" />);
      const deadline = Date.now() + 3_000;
      while (!recoveryAlert && Date.now() < deadline) {
        await act(async () => {
          await new Promise<void>((resolve) => realSetTimeout(resolve, 10));
        });
        recoveryAlert = screen.queryByRole("alert");
      }
    } finally {
      timeoutSpy.mockRestore();
    }
    expect(recoveryAlert).not.toBeNull();
    expect(recoveryAlert?.textContent).toContain("Codex status is unavailable");
    expect(
      getSessionStatusMock.mock.calls.filter(([, sessionId]) => sessionId === boundedSessionId),
    ).toHaveLength(4);
    // Each failure evicts the cached client, so a failed bridge is re-resolved
    // rather than reused. Without these the eviction can be deleted silently.
    expect(
      getCodexServerStatusMock.mock.calls.filter(([containerId]) => containerId === boundedContainerId),
    ).toHaveLength(4);
    expect(
      createClientMock.mock.calls.filter(([baseUrl]) => baseUrl === boundedBaseUrl),
    ).toHaveLength(4);
    // Doubling backoff, one gap per retry, all under the 12s clamp: the fourth
    // failure gives up instead of sleeping again.
    expect(scheduledBackoffs).toEqual([1_500, 3_000, 6_000]);
    expect(sendPromptMock).not.toHaveBeenCalled();
    expect(screen.getByTitle("Send message").hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByPlaceholderText("Describe the feature or answer Codex..."), {
      target: { value: "A new prompt" },
    });
    expect(screen.getByTitle("Send message").hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Stop waiting" }));

    await waitFor(() => {
      expect(useFeaturePlanStore.getState().activeConversations.has("feature-1")).toBe(false);
      expect(screen.getByTitle("Send message").hasAttribute("disabled")).toBe(false);
    });
  });

  test("honors dispatch grace before recovering an idle cached turn", async () => {
    let now = 0;
    const dateNowSpy = spyOn(Date, "now").mockImplementation(() => now);
    const realSetTimeout = globalThis.setTimeout;
    const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: TimerHandler,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (typeof callback === "function" && delay === 1_500) {
        now += 1_500;
        return realSetTimeout(callback, 0, ...args);
      }
      return realSetTimeout(callback, delay, ...args);
    }) as typeof setTimeout);
    seedStores(chatFeature({ messages: [pendingUser()] }));
    seedExistingCodexEnvironment();
    useFeaturePlanStore.getState().startConversation({
      operationId: "cached-dispatch",
      featureId: "feature-1",
      startedAt: NOW,
      phase: "dispatching",
    });
    getSessionStatusMock.mockImplementation(async () => ({ status: "idle" }));

    try {
      render(<FeaturesView projectId="project-1" />);
      // Drain the poll chain until it reaches its terminal state rather than
      // waiting a fixed slice of wall-clock time. Every poll is rescheduled
      // with a zero delay, so yielding repeatedly advances the loop
      // deterministically however loaded the machine is, whereas a real-time
      // window makes the poll count below load-sensitive. waitFor is not an
      // option here: the setTimeout spy makes it take its fake-timer path.
      await act(async () => {
        for (let tick = 0; tick < 500; tick += 1) {
          if (document.querySelector('[role="alert"]')) break;
          await new Promise<void>((resolve) => realSetTimeout(resolve, 0));
        }
      });
    } finally {
      timeoutSpy.mockRestore();
      dateNowSpy.mockRestore();
    }
    expect(screen.getByRole("alert").textContent).toContain("no matching response");
    // The grace is 8s and each poll advances the faked clock by the 1.5s poll
    // interval, so the loop hydrates on the first poll at or past the deadline.
    expect(getSessionStatusMock).toHaveBeenCalledTimes(
      Math.ceil(8_000 / 1_500) + 1,
    );
    expect(getSessionMessagesMock).toHaveBeenCalledTimes(1);
    expect(sendPromptMock).not.toHaveBeenCalled();
  });

  test("reconciles multiple features independently", async () => {
    const recovered = makeCodexMessage({
      content: `Recovered A.
<feature_planner_state>{"phase":"collecting","title":"Recovered A","summary":""}</feature_planner_state>`,
    });
    seedStores([
      chatFeature({
        id: "feature-a",
        codexEnvironmentId: "env-a",
        codexSessionId: "session-a",
        messages: [pendingUser(NOW, "user-a")],
        order: 0,
      }),
      chatFeature({
        id: "feature-b",
        codexEnvironmentId: "env-b",
        codexSessionId: "session-b",
        messages: [pendingUser(NOW, "user-b")],
        order: 1,
      }),
    ]);
    useEnvironmentStore.setState({
      environments: [
        makeEnvironment({ id: "env-a", containerId: "container-a" }),
        makeEnvironment({ id: "env-b", containerId: "container-b" }),
      ],
    });
    getSessionStatusMock.mockImplementation(async (_client, sessionId) => (
      sessionId === "session-a"
        ? { status: "idle" as const }
        : { status: "running" as const }
    ));
    getSessionMessagesMock.mockImplementation(async (_client, sessionId) => (
      sessionId === "session-a" ? [recovered] : []
    ));

    render(<FeaturesView projectId="project-1" />);

    await waitFor(() => expect(appendMessageMock).toHaveBeenCalledWith(
      "feature-a",
      "assistant",
      recovered.content,
      "pending",
    ));
    expect(useFeaturePlanStore.getState().activeConversations.has("feature-a")).toBe(false);
    expect(useFeaturePlanStore.getState().activeConversations.get("feature-b")).toMatchObject({
      featureId: "feature-b",
      phase: "running",
    });
    expect(getSessionStatusMock.mock.calls.map((call) => call[1])).toEqual(
      expect.arrayContaining(["session-a", "session-b"]),
    );
  });

  test("resolves local and backend-only environments during reconciliation", async () => {
    seedStores(chatFeature({ messages: [pendingUser()] }));
    seedExistingCodexEnvironment(makeEnvironment({
      environmentType: "local",
      containerId: null,
    }));
    getSessionStatusMock.mockImplementation(async () => ({ status: "running" }));

    render(<FeaturesView projectId="project-1" />);
    await waitFor(() => expect(getSessionStatusMock).toHaveBeenCalled());
    expect(getLocalCodexServerStatusMock).toHaveBeenCalledWith("env-feature");
    expect(createClientMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4100",
      "local-token",
    );
    expect(getCodexServerStatusMock).not.toHaveBeenCalled();

    cleanup();
    getSessionStatusMock.mockClear();
    createClientMock.mockClear();
    getLocalCodexServerStatusMock.mockClear();
    getCodexServerStatusMock.mockClear();
    useEnvironmentStore.setState({ environments: [] });
    seedStores(chatFeature({ messages: [pendingUser()] }));
    getEnvironmentMock.mockImplementation(async () => makeEnvironment());
    render(<FeaturesView projectId="project-1" />);

    await waitFor(() => expect(getSessionStatusMock).toHaveBeenCalled());
    expect(getEnvironmentMock).toHaveBeenCalledWith("env-feature");
    expect(getCodexServerStatusMock).toHaveBeenCalledWith("container-feature");
    expect(createClientMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4200",
      "container-token",
    );
  });

  test("moves every unreachable existing-session shape to bounded recovery", async () => {
    const realSetTimeout = globalThis.setTimeout;
    const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: TimerHandler,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (
        typeof callback === "function"
        && (delay === 1_500 || delay === 3_000 || delay === 6_000)
      ) {
        return realSetTimeout(callback, 0, ...args);
      }
      return realSetTimeout(callback, delay, ...args);
    }) as typeof setTimeout);
    const cases: Array<{
      name: string;
      environment?: Environment;
      backendEnvironment?: Environment | null;
      bridge?: { running: boolean; hostPort?: number };
    }> = [
      { name: "missing environment", backendEnvironment: null },
      { name: "stopped environment", environment: makeEnvironment({ status: "stopped" }) },
      { name: "missing container", environment: makeEnvironment({ containerId: null }) },
      { name: "stopped bridge", environment: makeEnvironment(), bridge: { running: false } },
      { name: "missing port", environment: makeEnvironment(), bridge: { running: true } },
    ];

    try {
      for (const scenario of cases) {
        cleanup();
        useEnvironmentStore.setState({ environments: scenario.environment ? [scenario.environment] : [] });
        seedStores(chatFeature({ messages: [pendingUser()] }));
        getEnvironmentMock.mockClear();
        getEnvironmentMock.mockImplementation(async () => scenario.backendEnvironment ?? null);
        getCodexServerStatusMock.mockClear();
        getCodexServerStatusMock.mockImplementation(async () => (
          scenario.bridge ?? {
            running: true,
            hostPort: 4200,
            authToken: "container-token",
          }
        ));
        getSessionStatusMock.mockClear();
        createClientMock.mockClear();

        render(<FeaturesView projectId="project-1" />);
        await act(async () => {
          await new Promise<void>((resolve) => realSetTimeout(resolve, 50));
        });
        expect(
          useFeaturePlanStore.getState().activeConversations.get("feature-1"),
        ).toMatchObject({
          featureId: "feature-1",
          phase: "unavailable",
        });
        // Safe as an absolute count: both spies are cleared inside this loop
        // iteration, immediately before the render above, so nothing an earlier
        // test leaked can reach these assertions.
        expect(getSessionStatusMock).not.toHaveBeenCalled();
        expect(createClientMock).not.toHaveBeenCalled();
      }
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  test("cancels stale reconciliation on project switch and unmount", async () => {
    const firstStatus = deferred<{ status: "idle" }>();
    seedStores(chatFeature({
      id: "feature-a",
      codexEnvironmentId: "env-a",
      codexSessionId: "session-a",
      messages: [pendingUser(NOW, "user-a")],
    }));
    seedExistingCodexEnvironment(makeEnvironment({
      id: "env-a",
      containerId: "container-a",
    }));
    getSessionStatusMock.mockImplementation(async (_client, sessionId) => (
      sessionId === "session-a"
        ? firstStatus.promise
        : { status: "running" as const }
    ));
    const view = render(<FeaturesView projectId="project-1" />);
    await waitFor(() => expect(
      getSessionStatusMock.mock.calls.some((call) => call[1] === "session-a"),
    ).toBe(true));

    act(() => {
      useProjectStore.setState({
        projects: [{
          id: "project-2",
          name: "Project 2",
          gitUrl: "https://github.com/acme/repo-2.git",
          localPath: null,
          addedAt: NOW,
          order: 0,
        }],
      });
      useEnvironmentStore.setState({
        environments: [makeEnvironment({
          id: "env-b",
          projectId: "project-2",
          containerId: "container-b",
        })],
      });
      useFeaturePlanStore.setState({
        currentProjectId: "project-2",
        features: [chatFeature({
          id: "feature-b",
          projectId: "project-2",
          codexEnvironmentId: "env-b",
          codexSessionId: "session-b",
          messages: [pendingUser(NOW, "user-b")],
        })],
      });
    });
    view.rerender(<FeaturesView projectId="project-2" />);
    await waitFor(() => expect(
      getSessionStatusMock.mock.calls.some((call) => call[1] === "session-b"),
    ).toBe(true));

    await act(async () => firstStatus.resolve({ status: "idle" }));
    expect(getSessionMessagesMock.mock.calls.some((call) => call[1] === "session-a")).toBe(false);
    expect(appendMessageMock).not.toHaveBeenCalledWith(
      "feature-a",
      "assistant",
      expect.anything(),
      "pending",
    );

    const secondStatus = deferred<{ status: "idle" }>();
    cleanup();
    getSessionStatusMock.mockClear();
    getSessionStatusMock.mockImplementation(async () => secondStatus.promise);
    getSessionMessagesMock.mockClear();
    const unmountedSessionId = "session-unmounted-during-status";
    seedStores(chatFeature({
      codexSessionId: unmountedSessionId,
      messages: [pendingUser()],
    }));
    seedExistingCodexEnvironment();
    const unmounted = render(<FeaturesView projectId="project-1" />);
    await waitFor(() => expect(getSessionStatusMock).toHaveBeenCalled());
    unmounted.unmount();
    await act(async () => secondStatus.resolve({ status: "idle" }));
    expect(messageReadsFor(unmountedSessionId)).toHaveLength(0);
  });

  test("settles without hydrating when the pending turn is answered during a status read", async () => {
    const answeredDuringReadSessionId = "session-answered-during-read";
    const status = deferred<{ status: "idle" }>();
    seedStores(chatFeature({
      codexSessionId: answeredDuringReadSessionId,
      messages: [pendingUser()],
    }));
    seedExistingCodexEnvironment();
    getSessionStatusMock.mockImplementation(async () => status.promise);

    render(<FeaturesView projectId="project-1" />);
    await waitFor(() => expect(getSessionStatusMock).toHaveBeenCalled());

    act(() => {
      updateFeatureInStore("feature-1", {
        messages: [
          pendingUser(),
          {
            id: "already-persisted-reply",
            role: "assistant",
            content: "The live worker already saved this reply.",
            createdAt: "2026-01-01T00:00:01.000Z",
          },
        ],
      });
    });
    await act(async () => status.resolve({ status: "idle" }));

    await waitFor(() => expect(
      useFeaturePlanStore.getState().activeConversations.has("feature-1"),
    ).toBe(false));
    expect(messageReadsFor(answeredDuringReadSessionId)).toHaveLength(0);
    expect(appendMessageMock).not.toHaveBeenCalled();
  });

  test("keeps recovery blocked when restored transcript hydration throws", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => undefined);
    seedStores(chatFeature({ messages: [pendingUser()] }));
    seedExistingCodexEnvironment();
    getSessionStatusMock.mockImplementation(async () => ({ status: "idle" }));
    getSessionMessagesMock.mockImplementation(async () => {
      throw "malformed transcript response";
    });

    try {
      render(<FeaturesView projectId="project-1" />);

      expect((await screen.findByRole("alert")).textContent).toContain(
        "Failed to restore the Codex response.",
      );
      expect(useFeaturePlanStore.getState().activeConversations.get("feature-1")).toMatchObject({
        featureId: "feature-1",
        phase: "unavailable",
        error: "Failed to restore the Codex response.",
      });
      expect(screen.getByTitle("Send message").hasAttribute("disabled")).toBe(true);
      expect(appendMessageMock).not.toHaveBeenCalled();
      expect(updateFeatureMock).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  test("settles a recovery retry when the pending turn was already answered", async () => {
    const answeredTurnSessionId = "session-answered-turn";
    seedStores(chatFeature({
      codexSessionId: answeredTurnSessionId,
      messages: [pendingUser()],
    }));
    seedExistingCodexEnvironment();
    useFeaturePlanStore.getState().startConversation({
      operationId: "unavailable-turn",
      featureId: "feature-1",
      startedAt: NOW,
      phase: "unavailable",
      error: "Codex status is unavailable.",
    });

    render(<FeaturesView projectId="project-1" />);
    expect(await screen.findByRole("alert")).toBeTruthy();

    act(() => {
      updateFeatureInStore("feature-1", {
        messages: [
          pendingUser(),
          {
            id: "already-answered",
            role: "assistant",
            content: "The response was persisted elsewhere.",
            createdAt: "2026-01-01T00:00:01.000Z",
          },
        ],
      });
    });
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));

    await waitFor(() => expect(
      useFeaturePlanStore.getState().activeConversations.has("feature-1"),
    ).toBe(false));
    expect(statusReadsFor(answeredTurnSessionId)).toHaveLength(0);
    expect(messageReadsFor(answeredTurnSessionId)).toHaveLength(0);
  });

  test("reapplies valid feature and story state from already-persisted local replies", async () => {
    const featureResponse = `Local feature reply.
<feature_planner_state>{"phase":"confirming","title":"Local recovery","summary":"saved"}</feature_planner_state>`;
    seedStores(chatFeature({
      messages: [
        pendingUser(NOW, "feature-user"),
        {
          id: "feature-local-reply",
          role: "assistant",
          content: featureResponse,
          createdAt: "2026-01-01T00:00:01.000Z",
          stateApplication: "pending",
        },
      ],
    }));
    seedExistingCodexEnvironment();

    render(<FeaturesView projectId="project-1" />);
    await waitFor(() => expect(updateFeatureMock).toHaveBeenCalledWith(
      "feature-1",
      expect.objectContaining({
        title: "Local recovery",
        summary: "saved",
        status: "confirming",
      }),
    ));
    expect(appendMessageMock).not.toHaveBeenCalled();
    await waitForConversationToSettle();

    cleanup();
    updateFeatureMock.mockClear();
    const storyResponse = `Local story reply.
<story_refinement>{"storyId":"story-1","title":"Local story recovery"}</story_refinement>`;
    seedStores(featureWithStories({
      codexEnvironmentId: "env-feature",
      codexSessionId: "session-existing",
      stories: [makeStory({
        messages: [
          pendingUser(NOW, "story-user"),
          {
            id: "story-local-reply",
            role: "assistant",
            content: storyResponse,
            createdAt: "2026-01-01T00:00:01.000Z",
            stateApplication: "pending",
          },
        ],
      })],
    }));
    seedExistingCodexEnvironment();

    render(<FeaturesView projectId="project-1" />);
    await waitFor(() => expect(updateFeatureMock).toHaveBeenCalledWith(
      "feature-1",
      expect.objectContaining({
        stories: [expect.objectContaining({ title: "Local story recovery" })],
      }),
    ));
    expect(appendStoryMessageMock).not.toHaveBeenCalled();
    await waitForConversationToSettle();
  });

  test("does not replay an old planner response over a later build state", async () => {
    const oldPlannerResponse = `Old planner response.
<feature_planner_state>{"phase":"stories","title":"Old title","summary":"old","stories":[]}</feature_planner_state>`;
    seedStores(chatFeature({
      status: "building",
      messages: [
        pendingUser(NOW, "old-feature-user"),
        {
          id: "old-planner-reply",
          role: "assistant",
          content: oldPlannerResponse,
          createdAt: "2026-01-01T00:00:01.000Z",
          stateApplication: "pending",
        },
      ],
    }));
    seedExistingCodexEnvironment();

    render(<FeaturesView projectId="project-1" />);
    await flushReconcileStart();

    expect(updateFeatureMock).toHaveBeenCalledWith("feature-1", {
      messages: [
        pendingUser(NOW, "old-feature-user"),
        expect.objectContaining({
          id: "old-planner-reply",
          stateApplication: "superseded",
        }),
      ],
    });
    expect(useFeaturePlanStore.getState().activeConversations.size).toBe(0);
    expect(useFeaturePlanStore.getState().features[0]?.status).toBe("building");
  });

  test("does not replay applied planner state over a newer story refinement", async () => {
    const plannerResponse = `Initial planner state.
<feature_planner_state>{"phase":"stories","title":"Planned title","summary":"planned","stories":[{"id":"story-1","title":"Planner story","description":"planner description","acceptanceCriteria":["planner criterion"]}]}</feature_planner_state>`;
    const refinementResponse = `Later refinement.
<story_refinement>{"storyId":"story-1","title":"Refined story","description":"refined description","acceptanceCriteria":["refined criterion"]}</story_refinement>`;
    seedStores(featureWithStories({
      title: "Planned title",
      summary: "planned",
      messages: [
        pendingUser(NOW, "planner-user"),
        {
          id: "applied-planner-reply",
          role: "assistant",
          content: plannerResponse,
          createdAt: "2026-01-01T00:00:01.000Z",
          stateApplication: "applied",
        },
      ],
      stories: [makeStory({
        title: "Refined story",
        description: "refined description",
        acceptanceCriteria: ["refined criterion"],
        messages: [
          pendingUser("2026-01-01T00:00:02.000Z", "refinement-user"),
          {
            id: "applied-refinement-reply",
            role: "assistant",
            content: refinementResponse,
            createdAt: "2026-01-01T00:00:03.000Z",
            stateApplication: "applied",
          },
        ],
      })],
    }));

    render(<FeaturesView projectId="project-1" />);
    await flushReconcileStart();

    expect(updateFeatureMock).not.toHaveBeenCalled();
    expect(useFeaturePlanStore.getState().features[0]?.stories[0]).toMatchObject({
      title: "Refined story",
      description: "refined description",
      acceptanceCriteria: ["refined criterion"],
    });
  });

  test("does not replay applied story refinement over newer planner state", async () => {
    const oldRefinement = `Old refinement.
<story_refinement>{"storyId":"story-1","title":"Old refined story","description":"old description"}</story_refinement>`;
    const newPlannerResponse = `New planner state.
<feature_planner_state>{"phase":"stories","title":"New plan","summary":"new","stories":[{"id":"story-1","title":"Planner replaced story","description":"planner replacement","acceptanceCriteria":["new criterion"]}]}</feature_planner_state>`;
    seedStores(featureWithStories({
      title: "New plan",
      summary: "new",
      messages: [
        pendingUser("2026-01-01T00:00:02.000Z", "new-planner-user"),
        {
          id: "new-applied-planner-reply",
          role: "assistant",
          content: newPlannerResponse,
          createdAt: "2026-01-01T00:00:03.000Z",
          stateApplication: "applied",
        },
      ],
      stories: [makeStory({
        title: "Planner replaced story",
        description: "planner replacement",
        acceptanceCriteria: ["new criterion"],
        messages: [
          pendingUser(NOW, "old-refinement-user"),
          {
            id: "old-applied-refinement-reply",
            role: "assistant",
            content: oldRefinement,
            createdAt: "2026-01-01T00:00:01.000Z",
            stateApplication: "applied",
          },
        ],
      })],
    }));

    render(<FeaturesView projectId="project-1" />);
    await flushReconcileStart();

    expect(updateFeatureMock).not.toHaveBeenCalled();
    expect(useFeaturePlanStore.getState().features[0]?.stories[0]).toMatchObject({
      title: "Planner replaced story",
      description: "planner replacement",
      acceptanceCriteria: ["new criterion"],
    });
  });

  test("atomically applies the newest response and supersedes older pending state", async () => {
    const olderRefinement = `Older pending refinement.
<story_refinement>{"storyId":"story-1","title":"Do not restore this"}</story_refinement>`;
    const newestPlanner = `Newest planner state.
<feature_planner_state>{"phase":"confirming","title":"Newest state","summary":"current"}</feature_planner_state>`;
    seedStores(chatFeature({
      messages: [
        pendingUser("2026-01-01T00:00:02.000Z", "newest-planner-user"),
        {
          id: "newest-pending-planner",
          role: "assistant",
          content: newestPlanner,
          createdAt: "2026-01-01T00:00:03.000Z",
          stateApplication: "pending",
        },
      ],
      stories: [makeStory({
        messages: [
          pendingUser(NOW, "older-story-user"),
          {
            id: "older-pending-refinement",
            role: "assistant",
            content: olderRefinement,
            createdAt: "2026-01-01T00:00:01.000Z",
            stateApplication: "pending",
          },
        ],
      })],
    }));

    render(<FeaturesView projectId="project-1" />);
    await waitForConversationToSettle();

    const feature = useFeaturePlanStore.getState().features[0]!;
    expect(feature).toMatchObject({
      title: "Newest state",
      summary: "current",
      status: "confirming",
    });
    expect(feature.messages.at(-1)).toMatchObject({
      id: "newest-pending-planner",
      stateApplication: "applied",
    });
    expect(feature.stories[0]?.messages.at(-1)).toMatchObject({
      id: "older-pending-refinement",
      stateApplication: "superseded",
    });

    cleanup();
    updateFeatureMock.mockClear();
    seedStores(feature);
    render(<FeaturesView projectId="project-1" />);
    await flushReconcileStart();
    expect(updateFeatureMock).not.toHaveBeenCalled();
  });

  test("a newer story response supersedes older pending feature state", async () => {
    const olderPlanner = `Older pending planner.
<feature_planner_state>{"phase":"stories","title":"Do not restore this plan","summary":"old","stories":[]}</feature_planner_state>`;
    const newestRefinement = `Newest story refinement.
<story_refinement>{"storyId":"story-1","title":"Newest story state","description":"current"}</story_refinement>`;
    seedStores(featureWithStories({
      messages: [
        pendingUser(NOW, "older-planner-user"),
        {
          id: "older-pending-planner",
          role: "assistant",
          content: olderPlanner,
          createdAt: "2026-01-01T00:00:01.000Z",
          stateApplication: "pending",
        },
      ],
      stories: [makeStory({
        messages: [
          pendingUser("2026-01-01T00:00:02.000Z", "newest-story-user"),
          {
            id: "newest-pending-refinement",
            role: "assistant",
            content: newestRefinement,
            createdAt: "2026-01-01T00:00:03.000Z",
            stateApplication: "pending",
          },
        ],
      })],
    }));

    render(<FeaturesView projectId="project-1" />);
    await waitForConversationToSettle();

    const feature = useFeaturePlanStore.getState().features[0]!;
    expect(feature.messages.at(-1)).toMatchObject({
      id: "older-pending-planner",
      stateApplication: "superseded",
    });
    expect(feature.stories[0]).toMatchObject({
      title: "Newest story state",
      description: "current",
    });
    expect(feature.stories[0]?.messages.at(-1)).toMatchObject({
      id: "newest-pending-refinement",
      stateApplication: "applied",
    });

    cleanup();
    updateFeatureMock.mockClear();
    seedStores(feature);
    render(<FeaturesView projectId="project-1" />);
    await flushReconcileStart();
    expect(updateFeatureMock).not.toHaveBeenCalled();
  });

  test("settles an explicit retry whose persisted target no longer exists", async () => {
    const missingTargetSessionId = "session-missing-target";
    seedStores(chatFeature({ codexSessionId: missingTargetSessionId, messages: [] }));
    seedExistingCodexEnvironment();
    useFeaturePlanStore.getState().startConversation({
      operationId: "missing-target",
      featureId: "feature-1",
      userMessageId: "deleted-user",
      startedAt: NOW,
      phase: "unavailable",
      error: "The message may have been removed.",
    });

    render(<FeaturesView projectId="project-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Check again" }));

    await waitForConversationToSettle();
    expect(statusReadsFor(missingTargetSessionId)).toHaveLength(0);
    expect(messageReadsFor(missingTargetSessionId)).toHaveLength(0);
  });

  test("settles safely when the feature or target disappears during a status read", async () => {
    const removedFeatureSessionId = "session-removed-feature";
    const removedFeatureStatus = deferred<{ status: "idle" }>();
    seedStores(chatFeature({
      codexSessionId: removedFeatureSessionId,
      messages: [pendingUser()],
    }));
    seedExistingCodexEnvironment();
    getSessionStatusMock.mockImplementation(async () => removedFeatureStatus.promise);
    render(<FeaturesView projectId="project-1" />);
    await waitFor(() => expect(getSessionStatusMock).toHaveBeenCalled());

    act(() => useFeaturePlanStore.setState({ features: [] }));
    await act(async () => removedFeatureStatus.resolve({ status: "idle" }));
    await waitForConversationToSettle();
    expect(messageReadsFor(removedFeatureSessionId)).toHaveLength(0);

    cleanup();
    getSessionStatusMock.mockClear();
    const removedTargetSessionId = "session-removed-target";
    const removedTargetStatus = deferred<{ status: "idle" }>();
    seedStores(chatFeature({
      codexSessionId: removedTargetSessionId,
      messages: [pendingUser()],
    }));
    seedExistingCodexEnvironment();
    getSessionStatusMock.mockImplementation(async () => removedTargetStatus.promise);
    render(<FeaturesView projectId="project-1" />);
    await waitFor(() => expect(getSessionStatusMock).toHaveBeenCalled());

    act(() => updateFeatureInStore("feature-1", { messages: [] }));
    await act(async () => removedTargetStatus.resolve({ status: "idle" }));
    await waitForConversationToSettle();
    expect(messageReadsFor(removedTargetSessionId)).toHaveLength(0);
  });

  test("does not clear an unavailable recovery state when stale status returns running", async () => {
    const staleSessionId = "session-stale-running-guard";
    const status = deferred<{ status: "running" }>();
    seedStores(chatFeature({
      codexSessionId: staleSessionId,
      messages: [pendingUser()],
    }));
    seedExistingCodexEnvironment();
    getSessionStatusMock.mockImplementation(async () => status.promise);
    render(<FeaturesView projectId="project-1" />);
    await waitFor(() => expect(getSessionStatusMock).toHaveBeenCalled());

    const conversation = useFeaturePlanStore.getState()
      .activeConversations.get("feature-1")!;
    act(() => {
      useFeaturePlanStore.getState().updateConversation(
        {
          featureId: conversation.featureId,
          operationId: conversation.operationId,
        },
        {
          phase: "unavailable",
          error: "Keep this recovery visible.",
        },
      );
    });
    await act(async () => status.resolve({ status: "running" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Keep this recovery visible.",
    );
    expect(useFeaturePlanStore.getState().activeConversations.get("feature-1")).toMatchObject({
      operationId: conversation.operationId,
      phase: "unavailable",
      error: "Keep this recovery visible.",
    });
    expect(messageReadsFor(staleSessionId)).toHaveLength(0);
  });

  test("settles successful reconciliation persistence even after the view unmounts", async () => {
    const response = featurePlannerReply("Persist after unmount");
    const assistantAppend = deferred<FeaturePlan | undefined>();
    appendMessageMock.mockImplementation(async (
      featureId,
      role,
      content,
      stateApplication,
    ) => (
      role === "assistant"
        ? assistantAppend.promise
        : appendFeatureMessageInStore(featureId, role, content, stateApplication)
    ));
    seedStores(chatFeature({ messages: [pendingUser()] }));
    seedExistingCodexEnvironment();
    getSessionStatusMock.mockImplementation(async () => ({ status: "idle" }));
    getSessionMessagesMock.mockImplementation(async () => [
      makeCodexMessage({ id: "unmounted-reply", content: response }),
    ]);

    const view = render(<FeaturesView projectId="project-1" />);
    await waitFor(() => expect(appendMessageMock).toHaveBeenCalledWith(
      "feature-1",
      "assistant",
      response,
      "pending",
    ));
    await waitForConversationPhase("persisting");
    view.unmount();

    await act(async () => assistantAppend.resolve(
      appendFeatureMessageInStore(
        "feature-1",
        "assistant",
        response,
        "pending",
      ),
    ));

    await waitForConversationToSettle();
    expect(updateFeatureMock).toHaveBeenCalledWith(
      "feature-1",
      expect.objectContaining({ status: "collecting" }),
    );
    expect(useFeaturePlanStore.getState().features[0]?.messages.at(-1))
      .toMatchObject({
        content: response,
        stateApplication: "applied",
      });
  });

  test("exposes recovery when reconciliation persistence fails after unmount", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => undefined);
    const response = featurePlannerReply("Fail after unmount");
    const assistantAppend = deferred<FeaturePlan | undefined>();
    appendMessageMock.mockImplementation(async (
      featureId,
      role,
      content,
      stateApplication,
    ) => (
      role === "assistant"
        ? assistantAppend.promise
        : appendFeatureMessageInStore(
            featureId,
            role,
            content,
            stateApplication,
          )
    ));
    seedStores(chatFeature({ messages: [pendingUser()] }));
    seedExistingCodexEnvironment();
    getSessionStatusMock.mockImplementation(async () => ({ status: "idle" }));
    getSessionMessagesMock.mockImplementation(async () => [
      makeCodexMessage({ id: "failed-unmounted-reply", content: response }),
    ]);

    try {
      const view = render(<FeaturesView projectId="project-1" />);
      await waitForConversationPhase("persisting");
      view.unmount();

      await act(async () => assistantAppend.reject(
        new Error("Assistant append failed after unmount"),
      ));
      await waitForConversationPhase("unavailable");

      render(<FeaturesView projectId="project-1" />);
      expect((await screen.findByRole("alert")).textContent).toContain(
        "Assistant append failed after unmount",
      );
      expect(useFeaturePlanStore.getState().activeConversations.get("feature-1"))
        .toMatchObject({
          phase: "unavailable",
          error: "Assistant append failed after unmount",
        });
    } finally {
      consoleError.mockRestore();
    }
  });

  test("keeps a live feature send recoverable when persistence fails after unmount", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => undefined);
    const response = featurePlannerReply("Live failure after unmount");
    const assistantAppend = deferred<FeaturePlan | undefined>();
    appendMessageMock.mockImplementation(async (
      featureId,
      role,
      content,
      stateApplication,
    ) => (
      role === "assistant"
        ? assistantAppend.promise
        : appendFeatureMessageInStore(
            featureId,
            role,
            content,
            stateApplication,
          )
    ));
    seedStores(chatFeature());
    seedExistingCodexEnvironment();
    getSessionMessagesMock
      .mockImplementationOnce(async () => [])
      .mockImplementationOnce(async () => [
        makeCodexMessage({ id: "live-unmounted-reply", content: response }),
      ]);

    try {
      const view = render(<FeaturesView projectId="project-1" />);
      fireEvent.change(
        screen.getByPlaceholderText("Describe the feature or answer Codex..."),
        { target: { value: "Fail after this view closes" } },
      );
      fireEvent.click(screen.getByTitle("Send message"));
      await waitForConversationPhase("persisting");
      view.unmount();

      await act(async () => assistantAppend.reject(
        new Error("Live assistant append failed after unmount"),
      ));
      await waitForConversationPhase("unavailable");

      render(<FeaturesView projectId="project-1" />);
      expect((await screen.findByRole("alert")).textContent).toContain(
        "Live assistant append failed after unmount",
      );
      expect(useFeaturePlanStore.getState().activeConversations.get("feature-1"))
        .toMatchObject({
          phase: "unavailable",
          responseContent: response,
        });
    } finally {
      consoleError.mockRestore();
    }
  });

  test("retries a pending feature state write that fails after unmount", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => undefined);
    const response = `Pending feature state.
<feature_planner_state>{"phase":"confirming","title":"Applied after remount","summary":"recovered"}</feature_planner_state>`;
    const stateUpdate = deferred<FeaturePlan | undefined>();
    updateFeatureMock.mockImplementationOnce(async () => stateUpdate.promise);
    seedStores(chatFeature());
    seedExistingCodexEnvironment();
    getSessionMessagesMock
      .mockImplementationOnce(async () => [])
      .mockImplementationOnce(async () => [
        makeCodexMessage({ id: "pending-feature-state", content: response }),
      ]);

    try {
      const view = render(<FeaturesView projectId="project-1" />);
      fireEvent.change(
        screen.getByPlaceholderText("Describe the feature or answer Codex..."),
        { target: { value: "Persist state after remount" } },
      );
      fireEvent.click(screen.getByTitle("Send message"));
      await waitFor(() => expect(
        useFeaturePlanStore.getState().features[0]?.messages.at(-1),
      ).toMatchObject({
        role: "assistant",
        content: response,
        stateApplication: "pending",
      }));
      await waitForConversationPhase("persisting");
      view.unmount();

      await act(async () => stateUpdate.resolve(undefined));
      await waitForConversationPhase("unavailable");

      render(<FeaturesView projectId="project-1" />);
      fireEvent.click(await screen.findByRole("button", { name: "Check again" }));
      await waitForConversationToSettle();

      expect(appendMessageMock.mock.calls.filter((call) => (
        call[1] === "assistant" && call[2] === response
      ))).toHaveLength(1);
      expect(useFeaturePlanStore.getState().features[0]).toMatchObject({
        title: "Applied after remount",
        summary: "recovered",
        status: "confirming",
      });
      expect(useFeaturePlanStore.getState().features[0]?.messages.at(-1))
        .toMatchObject({
          content: response,
          stateApplication: "applied",
        });
    } finally {
      consoleError.mockRestore();
    }
  });

  test("retries feature state application after the assistant append already succeeded", async () => {
    const response = `Persisted before state failure.
<feature_planner_state>{"phase":"confirming","title":"Recovered after partial write","summary":"complete"}</feature_planner_state>`;
    updateFeatureMock.mockImplementationOnce(async () => undefined);
    getSessionMessagesMock
      .mockImplementationOnce(async () => [])
      .mockImplementationOnce(async () => [
        makeCodexMessage({ id: "partial-feature-reply", content: response }),
      ]);
    seedStores(chatFeature());
    seedExistingCodexEnvironment();
    render(<FeaturesView projectId="project-1" />);

    fireEvent.change(screen.getByPlaceholderText("Describe the feature or answer Codex..."), {
      target: { value: "Write transcript then state" },
    });
    fireEvent.click(screen.getByTitle("Send message"));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Failed to persist the feature planning state",
    );
    expect(appendMessageMock.mock.calls.filter((call) => (
      call[1] === "assistant" && call[2] === response
    ))).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));

    await waitFor(() => expect(
      useFeaturePlanStore.getState().features[0],
    ).toMatchObject({
      title: "Recovered after partial write",
      summary: "complete",
      status: "confirming",
    }));
    expect(appendMessageMock.mock.calls.filter((call) => (
      call[1] === "assistant" && call[2] === response
    ))).toHaveLength(1);
    expect(useFeaturePlanStore.getState().activeConversations.has("feature-1")).toBe(false);
  });

  test("does not treat identical historical feature content as the current reply", async () => {
    const repeated = `Same answer again.
<feature_planner_state>{"phase":"confirming","title":"Repeated answer","summary":""}</feature_planner_state>`;
    seedStores(chatFeature({
      messages: [
        {
          id: "historical-assistant",
          role: "assistant",
          content: repeated,
          createdAt: "2025-12-31T23:59:59.000Z",
        },
        pendingUser(NOW, "target-user"),
      ],
    }));
    seedExistingCodexEnvironment();
    getSessionStatusMock.mockImplementation(async () => ({ status: "idle" }));
    getSessionMessagesMock.mockImplementation(async () => [
      makeCodexMessage({ id: "new-identical-reply", content: repeated }),
    ]);

    render(<FeaturesView projectId="project-1" />);

    await waitFor(() => expect(appendMessageMock).toHaveBeenCalledWith(
      "feature-1",
      "assistant",
      repeated,
      "pending",
    ));
    expect(useFeaturePlanStore.getState().features[0]?.messages.map(
      (message) => message.role,
    )).toEqual(["assistant", "user", "assistant"]);
    expect(useFeaturePlanStore.getState().activeConversations.has("feature-1")).toBe(false);
  });

  test("lets only one worker persist when live polling races explicit recovery", async () => {
    const liveStatus = deferred<{ status: "idle" }>();
    const transcript = deferred<CodexMessage[]>();
    const response = featurePlannerReply("Claimed once");
    let messageCalls = 0;
    let liveWorkerWaiting = false;
    getSessionStatusMock.mockImplementation(async () => {
      const active = useFeaturePlanStore.getState()
        .activeConversations.get("feature-1");
      if (!liveWorkerWaiting && active?.phase === "running") {
        liveWorkerWaiting = true;
        return liveStatus.promise;
      }
      return { status: "idle" as const };
    });
    getSessionMessagesMock.mockImplementation(async () => {
      messageCalls += 1;
      return messageCalls === 1 ? [] : transcript.promise;
    });
    seedStores(chatFeature());
    seedExistingCodexEnvironment();
    render(<FeaturesView projectId="project-1" />);
    await flushReconcileStart();

    fireEvent.change(screen.getByPlaceholderText("Describe the feature or answer Codex..."), {
      target: { value: "Race recovery" },
    });
    fireEvent.click(screen.getByTitle("Send message"));
    await waitFor(() => expect(liveWorkerWaiting).toBe(true));
    const conversation = useFeaturePlanStore.getState().activeConversations.get("feature-1");
    expect(conversation).toBeTruthy();

    act(() => {
      useFeaturePlanStore.getState().updateConversation(
        {
          featureId: "feature-1",
          operationId: conversation!.operationId,
        },
        {
          phase: "unavailable",
          error: "Check the same live turn.",
        },
      );
    });
    expect(await screen.findByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(messageCalls).toBeGreaterThanOrEqual(2));

    await act(async () => {
      liveStatus.resolve({ status: "idle" });
    });
    await waitFor(() => expect(messageCalls).toBeGreaterThanOrEqual(3));
    await act(async () => {
      transcript.resolve([
        makeCodexMessage({ id: "racing-reply", content: response }),
      ]);
    });

    await waitFor(() => expect(
      useFeaturePlanStore.getState().activeConversations.has("feature-1"),
    ).toBe(false));
    expect(appendMessageMock.mock.calls.filter((call) => (
      call[1] === "assistant" && call[2] === response
    ))).toHaveLength(1);
    expect(updateFeatureMock).toHaveBeenCalledTimes(1);
  });

  test("identifies an unavailable feature while another feature is selected", async () => {
    seedStores([
      chatFeature({
        id: "feature-a",
        title: "Feature A",
        codexEnvironmentId: undefined,
        codexSessionId: undefined,
        order: 0,
      }),
      chatFeature({
        id: "feature-b",
        title: "Feature B",
        messages: [pendingUser()],
        order: 1,
      }),
    ]);
    useFeaturePlanStore.getState().startConversation({
      operationId: "feature-b-recovery",
      featureId: "feature-b",
      startedAt: NOW,
      phase: "unavailable",
      error: "Codex status is unavailable.",
    });

    render(<FeaturesView projectId="project-1" />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByText("Feature A").closest("button")!);

    await waitFor(() => expect(
      screen.getByRole("tab", { name: "Chat" }).getAttribute("aria-selected"),
    ).toBe("true"));
    expect(screen.getByRole("alert").textContent).toContain("Feature B");
    expect(screen.getByRole("alert").textContent).toContain("Codex status is unavailable.");
  });

  test("shows loading state instead of a false empty state while feature loading is pending", async () => {
    seedStores([]);
    useFeaturePlanStore.setState({ isLoading: true });
    render(<FeaturesView projectId="project-1" />);

    expect(screen.getAllByText("Loading features...")).toHaveLength(2);
    expect(screen.queryByText("Create a feature to start discovery.")).toBeNull();
    expect(screen.queryByText("Select or create a feature.")).toBeNull();

    act(() => useFeaturePlanStore.setState({ isLoading: false }));
    await waitFor(() => expect(screen.getByText("Create a feature to start discovery.")).toBeTruthy());
    expect(screen.getByText("Select or create a feature.")).toBeTruthy();
  });

  test("loads each project, filters the rerendered project, and renders the empty state", async () => {
    seedStores([]);
    const view = render(<FeaturesView projectId="project-1" />);

    expect(screen.getByText("Create a feature to start discovery.")).toBeTruthy();
    expect(screen.getByText("Select or create a feature.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "New feature" })).toBeTruthy();
    await waitFor(() => expect(loadFeaturesMock).toHaveBeenCalledWith("project-1"));

    act(() => {
      useFeaturePlanStore.setState({
        features: [
          featureWithStories({ id: "project-1-feature", title: "Project one", projectId: "project-1" }),
          featureWithStories({ id: "project-2-feature", title: "Project two", projectId: "project-2" }),
        ],
      });
    });
    view.rerender(<FeaturesView projectId="project-2" />);

    await waitFor(() => expect(loadFeaturesMock).toHaveBeenCalledWith("project-2"));
    expect(screen.getByText("Project two")).toBeTruthy();
    expect(screen.queryByText("Project one")).toBeNull();
  });

  test("creates and selects a new feature while preserving the chat default", async () => {
    seedStores([]);
    render(<FeaturesView projectId="project-1" />);

    fireEvent.click(screen.getByRole("button", { name: "New feature" }));

    await waitFor(() => expect(createFeatureMock).toHaveBeenCalledWith("project-1"));
    await waitFor(() => expect(screen.getByText("new feature")).toBeTruthy());
    expect(screen.getByRole("tab", { name: "Chat" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Stories" }).hasAttribute("disabled")).toBe(true);
  });

  test("leaves the current selection unchanged when feature creation returns no id", async () => {
    createFeatureMock.mockImplementationOnce(async () => undefined);
    seedStores(featureWithStories({ title: "Existing feature" }));
    render(<FeaturesView projectId="project-1" />);

    fireEvent.click(screen.getByRole("button", { name: "New feature" }));

    await waitFor(() => expect(createFeatureMock).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Existing feature")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Stories" }).getAttribute("aria-selected")).toBe("true");
  });

  test("selects chat or stories according to the selected feature", async () => {
    seedStores([
      featureWithStories({ id: "without", title: "Without stories", stories: [], status: "collecting", order: 0 }),
      featureWithStories({ id: "with", title: "With stories", order: 1 }),
    ]);
    render(<FeaturesView projectId="project-1" />);

    expect(screen.getByRole("tab", { name: "Chat" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByText("With stories").closest("button")!);
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Stories" }).getAttribute("aria-selected")).toBe("true")
    );
    fireEvent.click(screen.getByText("Without stories").closest("button")!);
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Chat" }).getAttribute("aria-selected")).toBe("true")
    );
  });

  test("opens each story once and closes it with mouse and keyboard", async () => {
    seedStores(featureWithStories({
      stories: [
        makeStory({ id: "story-1", title: "Story One" }),
        makeStory({ id: "story-2", title: "Story Two" }),
      ],
    }));
    render(<FeaturesView projectId="project-1" />);

    fireEvent.click(screen.getByRole("button", {
      name: "Story One Story description 1 acceptance criteria",
    }));
    expect(screen.getByRole("tab", { name: "Story One" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("heading", { name: "Story One" })).toBeTruthy();

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Stories" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("button", {
      name: "Story One Story description 1 acceptance criteria",
    }));
    expect(screen.getAllByRole("tab", { name: "Story One" })).toHaveLength(1);

    fireEvent.keyDown(screen.getByRole("button", { name: "Close Story One" }), { key: "Enter" });
    await waitFor(() => expect(screen.queryByRole("tab", { name: "Story One" })).toBeNull());
    expect(screen.getByRole("tab", { name: "Stories" }).getAttribute("aria-selected")).toBe("true");

    fireEvent.click(screen.getByRole("button", {
      name: "Story Two Story description 1 acceptance criteria",
    }));
    fireEvent.click(screen.getByRole("button", { name: "Close Story Two" }));
    await waitFor(() => expect(screen.queryByRole("tab", { name: "Story Two" })).toBeNull());
  });

  test("recovers when the active story is removed without changing the feature id", async () => {
    const feature = featureWithStories({
      stories: [
        makeStory({ id: "story-1", title: "Story One" }),
        makeStory({ id: "story-2", title: "Story Two" }),
      ],
    });
    seedStores(feature);
    render(<FeaturesView projectId="project-1" />);
    fireEvent.click(screen.getByRole("button", { name: /Story One/ }));

    act(() => {
      useFeaturePlanStore.setState({ features: [{ ...feature, stories: [feature.stories[1]!] }] });
    });

    await waitFor(() => expect(screen.queryByRole("tab", { name: "Story One" })).toBeNull());
    expect(screen.getByRole("tab", { name: "Stories" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("button", { name: /Story Two/ })).toBeTruthy();
  });

  test("falls back to Chat when the selected feature loses its final story", async () => {
    const feature = featureWithStories();
    seedStores(feature);
    render(<FeaturesView projectId="project-1" />);
    expect(screen.getByRole("tab", { name: "Stories" }).getAttribute("aria-selected")).toBe("true");

    act(() => {
      useFeaturePlanStore.setState({ features: [{ ...feature, stories: [], status: "collecting" }] });
    });

    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Chat" }).getAttribute("aria-selected")).toBe("true")
    );
    expect(screen.getByRole("tab", { name: "Stories" }).hasAttribute("disabled")).toBe(true);
  });

  test("renders blank-title and story-count boundaries", () => {
    seedStores([
      featureWithStories({ id: "empty", title: "", status: "collecting", stories: [], order: 0 }),
      featureWithStories({ id: "one", title: "One story feature", stories: [makeStory()], order: 1 }),
      featureWithStories({
        id: "two",
        title: "Two story feature",
        stories: [makeStory({ id: "one" }), makeStory({ id: "two" })],
        order: 2,
      }),
    ]);
    render(<FeaturesView projectId="project-1" />);

    const blankButton = screen.getByText("new feature").closest("button")!;
    expect(blankButton.textContent).not.toContain("0 stor");
    expect(screen.getByText("One story feature").closest("button")?.textContent).toContain("1 story");
    expect(screen.getByText("Two story feature").closest("button")?.textContent).toContain("2 stories");
  });

  test("truncates story tab titles only beyond 24 characters", async () => {
    const exact = "123456789012345678901234";
    const long = `${exact}5`;
    seedStores(featureWithStories({
      stories: [
        makeStory({ id: "exact", title: exact }),
        makeStory({ id: "long", title: long }),
      ],
    }));
    render(<FeaturesView projectId="project-1" />);

    fireEvent.click(screen.getByRole("button", {
      name: `${exact} Story description 1 acceptance criteria`,
    }));
    expect(screen.getByRole("tab", { name: exact })).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Stories" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("button", {
      name: `${long} Story description 1 acceptance criteria`,
    }));
    expect(screen.getByRole("tab", { name: `${exact}...` })).toBeTruthy();
  });
});

describe("NativeStyleChatPanel", () => {
  function renderPanel(overrides: Partial<Parameters<typeof NativeStyleChatPanel>[0]> = {}) {
    const props: Parameters<typeof NativeStyleChatPanel>[0] = {
      messages: [],
      stripState: stripFeaturePlannerStateBlocks,
      persistKey: "panel-key",
      draft: "",
      setDraft: mock(() => undefined),
      isRunning: false,
      loadingText: "Working...",
      placeholder: "Type a message",
      onSend: mock(() => undefined),
      ...overrides,
    };
    return { ...render(<NativeStyleChatPanel {...props} />), props };
  }

  test("strips planner state, drops empty messages, and wires normalized message metadata", () => {
    renderPanel({
      messages: [
        {
          id: "visible",
          role: "user",
          content: `Visible reply
<feature_planner_state>{"phase":"collecting"}</feature_planner_state>`,
          createdAt: "2026-01-02T00:00:00.000Z",
        },
        {
          id: "state-only",
          role: "assistant",
          content: `<feature_planner_state>{"phase":"collecting"}</feature_planner_state>`,
          createdAt: "2026-01-02T00:00:01.000Z",
        },
        {
          id: "second",
          role: "assistant",
          content: "Second reply",
          createdAt: "2026-01-02T00:00:02.000Z",
        },
      ],
    });

    expect(screen.getByTestId("native-message-visible").textContent).toBe("Visible reply");
    expect(screen.queryByTestId("native-message-state-only")).toBeNull();
    expect(screen.getByTestId("native-message-second").dataset.previousId).toBe("visible");
    expect(screen.getByTestId("native-message-visible").parentElement?.dataset.itemKey).toBe("visible");
    expect(useVirtuosoScrollStateMock).toHaveBeenCalledWith({
      isActive: true,
      persistKey: "panel-key",
      stickToBottomOnActivation: true,
    });
  });

  test("uses the story-state stripper for story conversations", () => {
    renderPanel({
      stripState: stripStoryRefinementStateBlocks,
      messages: [{
        id: "story-message",
        role: "assistant",
        content: `Refined.
<story_refinement>{"storyId":"story-1"}</story_refinement>`,
        createdAt: NOW,
      }],
    });

    expect(screen.getByTestId("native-message-story-message").textContent).toBe("Refined.");
  });

  test("shows the scroll accessory only away from the bottom", () => {
    useVirtuosoScrollStateMock.mockImplementationOnce(() => ({
      isAtBottom: false,
      isAtBottomRef: { current: false },
      scrollToBottom: scrollToBottomMock,
      virtuosoRef: { current: null },
      scrollProps: {},
    }));
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Scroll to bottom of conversation" }));
    expect(scrollToBottomMock).toHaveBeenCalledTimes(1);
  });

  test("omits the scroll accessory while already at the bottom", () => {
    renderPanel();

    expect(screen.queryByRole("button", {
      name: "Scroll to bottom of conversation",
    })).toBeNull();
  });

  test("wires optional refresh and disables it while running", () => {
    const onRefresh = mock(() => undefined);
    const view = renderPanel({ onRefresh });

    fireEvent.click(screen.getByTitle("Refresh Codex status"));
    expect(onRefresh).toHaveBeenCalledTimes(1);

    view.rerender(<NativeStyleChatPanel {...view.props} isRunning />);
    const refresh = screen.getByTitle("Refresh Codex status");
    expect(refresh.hasAttribute("disabled")).toBe(true);
    fireEvent.click(refresh);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Working...")).toBeTruthy();

    view.rerender(<NativeStyleChatPanel {...view.props} onRefresh={undefined} />);
    expect(screen.queryByTitle("Refresh Codex status")).toBeNull();
  });

  test("sends the original draft by button and Enter but not Shift+Enter", () => {
    const onSend = mock(() => undefined);
    const setDraft = mock(() => undefined);
    renderPanel({ draft: "  hello  ", onSend, setDraft });
    const textarea = screen.getByPlaceholderText("Type a message");

    fireEvent.change(textarea, { target: { value: "changed" } });
    expect(setDraft).toHaveBeenCalledWith("changed");
    fireEvent.click(screen.getByTitle("Send message"));
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });

    expect(onSend).toHaveBeenCalledTimes(2);
    expect(onSend).toHaveBeenNthCalledWith(1, "  hello  ");
    expect(onSend).toHaveBeenNthCalledWith(2, "  hello  ");
  });

  test("blocks whitespace and running drafts", () => {
    const whitespaceSend = mock(() => undefined);
    const first = renderPanel({ draft: "   ", onSend: whitespaceSend });
    const whitespaceButton = screen.getByTitle("Send message");
    expect(whitespaceButton.hasAttribute("disabled")).toBe(true);
    fireEvent.keyDown(screen.getByPlaceholderText("Type a message"), { key: "Enter" });
    expect(whitespaceSend).not.toHaveBeenCalled();

    first.unmount();
    const runningSend = mock(() => undefined);
    renderPanel({ draft: "ready", onSend: runningSend, isRunning: true });
    const runningButton = screen.getByTitle("Send message");
    expect(runningButton.hasAttribute("disabled")).toBe(true);
    fireEvent.click(runningButton);
    fireEvent.keyDown(screen.getByPlaceholderText("Type a message"), { key: "Enter" });
    expect(runningSend).not.toHaveBeenCalled();
  });
});

describe("FeaturesView feature planning chat", () => {
  test("persists a new reply, ignores the baseline assistant, reads text parts, and applies planner state", async () => {
    const oldReply = makeCodexMessage({ id: "old", content: "An earlier answer" });
    const plannerReply = `The feature is ready.
<feature_planner_state>{"phase":"stories","title":"Updated feature","summary":"Updated summary","stories":[{"id":"story-new","title":"First story","description":"Do the work","acceptanceCriteria":["It works"]}]}</feature_planner_state>`;
    const newReply = makeCodexMessage({
      id: "new",
      content: "",
      parts: [{ type: "text", content: plannerReply }],
    });
    seedStores(chatFeature());
    seedExistingCodexEnvironment();
    getSessionMessagesMock
      .mockImplementationOnce(async () => [oldReply])
      .mockImplementationOnce(async () => [oldReply, newReply]);
    const phases: ActiveFeatureConversation[] = [];
    const unsubscribe = useFeaturePlanStore.subscribe((state) => {
      const conversation = state.activeConversations.get("feature-1");
      if (conversation) phases.push({ ...conversation });
    });
    render(<FeaturesView projectId="project-1" />);

    const textarea = screen.getByPlaceholderText("Describe the feature or answer Codex...");
    fireEvent.change(textarea, { target: { value: "Plan this feature" } });
    fireEvent.click(screen.getByTitle("Send message"));

    await waitFor(() => expect(appendMessageMock).toHaveBeenCalledWith(
      "feature-1",
      "assistant",
      plannerReply,
      "pending",
    ));
    expect(sendPromptMock).toHaveBeenCalledWith(
      { baseUrl: "http://127.0.0.1:4200", authToken: "container-token" },
      "session-existing",
      "Plan this feature",
    );
    await waitFor(() => {
      const updated = useFeaturePlanStore.getState().features[0]!;
      expect(updated.title).toBe("Updated feature");
      expect(updated.summary).toBe("Updated summary");
      expect(updated.status).toBe("stories");
      expect(updated.stories[0]?.title).toBe("First story");
    });
    expect(screen.getByRole("tab", { name: "Stories" }).getAttribute("aria-selected")).toBe("true");
    unsubscribe();
    expect(phases).toContainEqual(expect.objectContaining({
      startedAt: NOW,
      phase: "dispatching",
    }));
    expect(phases).toContainEqual(expect.objectContaining({
      startedAt: NOW,
      phase: "running",
    }));
    expect(useFeaturePlanStore.getState().activeConversations.has("feature-1")).toBe(false);
  });

  test("restores an unsaved draft and never contacts Codex when user-message persistence fails", async () => {
    appendMessageMock.mockImplementationOnce(async () => undefined);
    seedStores(chatFeature());
    seedExistingCodexEnvironment();
    render(<FeaturesView projectId="project-1" />);
    await flushReconcileStart();

    const textarea = screen.getByPlaceholderText("Describe the feature or answer Codex...");
    fireEvent.change(textarea, { target: { value: "Keep this draft" } });
    fireEvent.click(screen.getByTitle("Send message"));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(
      "Feature planning failed",
      expect.objectContaining({ description: "Failed to persist the feature message" }),
    ));
    expect((screen.getByPlaceholderText(
      "Describe the feature or answer Codex..."
    ) as HTMLTextAreaElement).value).toBe("Keep this draft");
    expect(sendPromptMock).not.toHaveBeenCalled();
  });

  test("reports prompt rejection without persisting a fabricated assistant response", async () => {
    sendPromptMock.mockImplementationOnce(async () => false);
    seedStores(chatFeature());
    seedExistingCodexEnvironment();
    render(<FeaturesView projectId="project-1" />);
    await flushReconcileStart();

    fireEvent.change(screen.getByPlaceholderText("Describe the feature or answer Codex..."), {
      target: { value: "Send me" },
    });
    fireEvent.click(screen.getByTitle("Send message"));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(
      "Feature planning failed",
      expect.objectContaining({ description: "Failed to send feature planning prompt" }),
    ));
    await waitForConversationToSettle();
    expect(appendMessageMock).toHaveBeenCalledTimes(1);
    expect(appendMessageMock).toHaveBeenCalledWith("feature-1", "user", "Send me");
  });

  test("reports an ambiguous prompt that the session never received", async () => {
    /**
     * An `unknown` outcome is not a rejection — the bridge may be running the
     * turn — so the prompt is not resent. But an idle session with no new reply
     * means it never landed, and that must surface quickly instead of holding
     * the chat for the full ten-minute poll and then claiming Codex is busy.
     */
    sendPromptMock.mockImplementationOnce(
      async () => ({ outcome: "unknown", requestId: "lost-1" }) as never,
    );
    getSessionStatusMock.mockResolvedValue({ status: "idle" } as never);
    getSessionMessagesMock.mockResolvedValue([] as never);
    seedStores(chatFeature());
    seedExistingCodexEnvironment();
    render(<FeaturesView projectId="project-1" />);

    fireEvent.change(screen.getByPlaceholderText("Describe the feature or answer Codex..."), {
      target: { value: "Lost prompt" },
    });
    fireEvent.click(screen.getByTitle("Send message"));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(
      "Feature planning failed",
      expect.objectContaining({
        description: "Codex did not receive the prompt. Please try sending it again.",
      }),
    ), { timeout: 20_000 });
    // Never resent: a lost response does not prove the turn did not start.
    expect(sendPromptMock).toHaveBeenCalledTimes(1);
  }, 30_000);

  test("keeps all feature conversations disabled while another feature request is pending", async () => {
    let resolvePrompt!: (sent: boolean) => void;
    sendPromptMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolvePrompt = resolve;
    }));
    seedStores([
      chatFeature({ id: "feature-a", title: "Feature A", order: 0 }),
      chatFeature({ id: "feature-b", title: "Feature B", order: 1 }),
    ]);
    seedExistingCodexEnvironment();
    render(<FeaturesView projectId="project-1" />);

    fireEvent.change(screen.getByPlaceholderText("Describe the feature or answer Codex..."), {
      target: { value: "Start A" },
    });
    fireEvent.click(screen.getByTitle("Send message"));
    await waitFor(() => expect(sendPromptMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByText("Feature B").closest("button")!);
    const secondDraft = await screen.findByPlaceholderText("Describe the feature or answer Codex...");
    fireEvent.change(secondDraft, { target: { value: "Do not start B yet" } });
    expect(screen.getByTitle("Send message").hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByTitle("Send message"));
    expect(appendMessageMock).not.toHaveBeenCalledWith("feature-b", "user", expect.anything());

    await act(async () => resolvePrompt(false));
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(
      "Feature planning failed",
      expect.objectContaining({ description: "Failed to send feature planning prompt" }),
    ));
  });

  test("keeps a timed-out live turn blocked without reusing a stale assistant response", async () => {
    const staleReply = makeCodexMessage({ id: "stale", content: "Stale response" });
    getSessionMessagesMock.mockImplementation(async () => [staleReply]);
    seedStores(chatFeature());
    seedExistingCodexEnvironment();
    render(<FeaturesView projectId="project-1" />);
    await flushReconcileStart();
    const dateNow = spyOn(Date, "now")
      .mockReturnValueOnce(0)
      .mockReturnValue(10 * 60 * 1000 + 1);

    try {
      fireEvent.change(screen.getByPlaceholderText("Describe the feature or answer Codex..."), {
        target: { value: "Wait for a fresh response" },
      });
      fireEvent.click(screen.getByTitle("Send message"));

      await waitFor(() => expect(mockToastWarning).toHaveBeenCalledWith(
        "Codex is still working",
        expect.objectContaining({ description: expect.stringContaining("Use Check again") }),
      ));
      expect(appendMessageMock).not.toHaveBeenCalledWith(
        "feature-1",
        "assistant",
        "Stale response",
        "pending",
      );
      expect((await screen.findByRole("alert")).textContent).toContain("Codex is still working");
      expect(useFeaturePlanStore.getState().activeConversations.get("feature-1")).toMatchObject({
        phase: "unavailable",
      });
      expect(screen.getByTitle("Send message").hasAttribute("disabled")).toBe(true);
    } finally {
      dateNow.mockRestore();
    }
  });

  test("retries while Codex is running and persists the reply once the session becomes idle", async () => {
    const eventualContent = featurePlannerReply("Eventually ready");
    const reply = makeCodexMessage({ id: "eventual", content: eventualContent });
    seedStores(chatFeature());
    seedExistingCodexEnvironment();
    getSessionStatusMock
      .mockImplementationOnce(async () => ({ status: "idle" }))
      .mockImplementationOnce(async () => ({ status: "running" }))
      .mockImplementationOnce(async () => ({ status: "idle" }));
    getSessionMessagesMock
      .mockImplementationOnce(async () => [])
      .mockImplementationOnce(async () => [])
      .mockImplementationOnce(async () => [reply]);
    render(<FeaturesView projectId="project-1" />);
    const realSetTimeout = globalThis.setTimeout;
    const timeout = spyOn(globalThis, "setTimeout").mockImplementation(((callback: TimerHandler) => {
      if (typeof callback === "function") callback();
      return 1;
    }) as typeof setTimeout);

    try {
      fireEvent.change(screen.getByPlaceholderText("Describe the feature or answer Codex..."), {
        target: { value: "Keep polling" },
      });
      fireEvent.click(screen.getByTitle("Send message"));
      await act(async () => {
        await new Promise<void>((resolve) => realSetTimeout(resolve, 0));
      });
    } finally {
      timeout.mockRestore();
    }
    expect(appendMessageMock).toHaveBeenCalledWith(
      "feature-1",
      "assistant",
      eventualContent,
      "pending",
    );
  });

  test("surfaces a terminal Codex session error", async () => {
    seedStores(chatFeature());
    seedExistingCodexEnvironment();
    getSessionStatusMock
      .mockImplementationOnce(async () => ({ status: "idle" }))
      .mockImplementationOnce(async () => ({ status: "error", error: "model failed" }));
    getSessionMessagesMock
      .mockImplementationOnce(async () => [])
      .mockImplementationOnce(async () => []);
    render(<FeaturesView projectId="project-1" />);
    await flushReconcileStart();

    fireEvent.change(screen.getByPlaceholderText("Describe the feature or answer Codex..."), {
      target: { value: "Trigger failure" },
    });
    fireEvent.click(screen.getByTitle("Send message"));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(
      "Feature planning failed",
      expect.objectContaining({ description: "model failed" }),
    ));
    await waitForConversationToSettle();
    expect(appendMessageMock).toHaveBeenCalledTimes(1);
  });

  test("reports assistant-transcript persistence failure before applying planner state", async () => {
    const response = featurePlannerReply("Do not lose this");
    let appendCount = 0;
    appendMessageMock.mockImplementation(async (featureId, role, content) => {
      appendCount += 1;
      return appendCount === 1
        ? appendFeatureMessageInStore(featureId, role, content)
        : undefined;
    });
    seedStores(chatFeature());
    seedExistingCodexEnvironment();
    getSessionMessagesMock
      .mockImplementationOnce(async () => [])
      .mockImplementationOnce(async () => [makeCodexMessage({ id: "response", content: response })]);
    render(<FeaturesView projectId="project-1" />);
    await flushReconcileStart();

    fireEvent.change(screen.getByPlaceholderText("Describe the feature or answer Codex..."), {
      target: { value: "Persist carefully" },
    });
    fireEvent.click(screen.getByTitle("Send message"));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(
      "Feature planning failed",
      expect.objectContaining({ description: "Failed to persist the feature planning response" }),
    ));
    await waitForConversationPhase("unavailable");
    expect(updateFeatureMock).not.toHaveBeenCalled();
  });

  test("reports planner-state persistence failure after preserving both transcript messages", async () => {
    const response = featurePlannerReply("State update");
    updateFeatureMock.mockImplementationOnce(async () => undefined);
    seedStores(chatFeature());
    seedExistingCodexEnvironment();
    getSessionMessagesMock
      .mockImplementationOnce(async () => [])
      .mockImplementationOnce(async () => [makeCodexMessage({ id: "response", content: response })]);
    render(<FeaturesView projectId="project-1" />);

    fireEvent.change(screen.getByPlaceholderText("Describe the feature or answer Codex..."), {
      target: { value: "Apply state" },
    });
    fireEvent.click(screen.getByTitle("Send message"));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(
      "Feature planning failed",
      expect.objectContaining({ description: "Failed to persist the feature planning state" }),
    ));
    expect(appendMessageMock).toHaveBeenCalledWith("feature-1", "user", "Apply state");
    expect(appendMessageMock).toHaveBeenCalledWith(
      "feature-1",
      "assistant",
      response,
      "pending",
    );
  });

  test("refresh selects the newest valid feature state and ignores story refinements", async () => {
    const featureReply = `Feature refresh
<feature_planner_state>{"phase":"confirming","title":"Refreshed title","summary":"Review it","stories":[]}</feature_planner_state>`;
    const storyReply = `Story refresh
<story_refinement>{"storyId":"story-1","title":"Wrong channel"}</story_refinement>`;
    seedStores(chatFeature());
    seedExistingCodexEnvironment();
    getSessionMessagesMock.mockImplementationOnce(async () => [
      makeCodexMessage({ id: "feature", content: featureReply }),
      makeCodexMessage({ id: "story", content: storyReply }),
    ]);
    render(<FeaturesView projectId="project-1" />);

    fireEvent.click(screen.getByTitle("Refresh Codex status"));

    await waitFor(() => expect(appendMessageMock).toHaveBeenCalledWith(
      "feature-1",
      "assistant",
      featureReply,
      "pending",
    ));
    expect(appendMessageMock).not.toHaveBeenCalledWith(
      "feature-1",
      "assistant",
      storyReply,
      "pending",
    );
    await waitFor(() => expect(useFeaturePlanStore.getState().features[0]?.title).toBe("Refreshed title"));
  });

  test("refresh ignores user messages, empty assistant parts, and assistants without feature state", async () => {
    seedStores(chatFeature());
    seedExistingCodexEnvironment();
    getSessionMessagesMock.mockImplementationOnce(async () => [
      makeCodexMessage({ id: "user", role: "user", content: "User text" }),
      makeCodexMessage({ id: "empty", content: "   ", parts: [] }),
      makeCodexMessage({ id: "plain", content: "No state block" }),
    ]);
    render(<FeaturesView projectId="project-1" />);

    fireEvent.click(screen.getByTitle("Refresh Codex status"));

    await waitFor(() => expect(getSessionMessagesMock).toHaveBeenCalledTimes(1));
    expect(appendMessageMock).not.toHaveBeenCalled();
  });

  test("refresh does not replay an older valid state already present before a newer malformed reply", async () => {
    const valid = featurePlannerReply("Already persisted");
    seedStores(chatFeature({
      messages: [
        { id: "valid", role: "assistant", content: valid, createdAt: NOW },
        { id: "plain", role: "assistant", content: "Newer malformed response", createdAt: NOW },
      ],
    }));
    seedExistingCodexEnvironment();
    getSessionMessagesMock.mockImplementationOnce(async () => [
      makeCodexMessage({ id: "valid", content: valid }),
      makeCodexMessage({ id: "plain", content: "Newer malformed response" }),
    ]);
    render(<FeaturesView projectId="project-1" />);

    fireEvent.click(screen.getByTitle("Refresh Codex status"));

    await waitFor(() => expect(getSessionMessagesMock).toHaveBeenCalledTimes(1));
    expect(appendMessageMock).not.toHaveBeenCalled();
    expect(updateFeatureMock).not.toHaveBeenCalled();
  });

  test("refresh reports failure when a recovered feature response cannot be persisted", async () => {
    const valid = featurePlannerReply("Recovered");
    appendMessageMock.mockImplementationOnce(async () => undefined);
    seedStores(chatFeature());
    seedExistingCodexEnvironment();
    getSessionMessagesMock.mockImplementationOnce(async () => [
      makeCodexMessage({ id: "valid", content: valid }),
    ]);
    render(<FeaturesView projectId="project-1" />);

    fireEvent.click(screen.getByTitle("Refresh Codex status"));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(
      "Failed to refresh feature chat",
      expect.objectContaining({ description: "Failed to persist the refreshed feature response" }),
    ));
    expect(updateFeatureMock).not.toHaveBeenCalled();
  });

  test("feature refresh and remount recovery claim a pending response exactly once", async () => {
    const response = featurePlannerReply("Refresh race");
    const transcript = deferred<CodexMessage[]>();
    let transcriptReads = 0;
    seedStores(chatFeature({ messages: [pendingUser()] }));
    seedExistingCodexEnvironment();
    getSessionMessagesMock.mockImplementation(async () => {
      transcriptReads += 1;
      return transcript.promise;
    });
    const view = render(<FeaturesView projectId="project-1" />);

    fireEvent.click(screen.getByTitle("Refresh Codex status"));
    await waitFor(() => expect(transcriptReads).toBeGreaterThanOrEqual(1));
    const conversation = useFeaturePlanStore.getState()
      .activeConversations.get("feature-1")!;
    act(() => {
      useFeaturePlanStore.getState().updateConversation(
        {
          featureId: conversation.featureId,
          operationId: conversation.operationId,
        },
        {
          phase: "unavailable",
          error: "Recover the refresh.",
        },
      );
    });

    view.unmount();
    render(<FeaturesView projectId="project-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Check again" }));
    await waitFor(() => expect(transcriptReads).toBeGreaterThanOrEqual(2));

    await act(async () => transcript.resolve([
      makeCodexMessage({ id: "refresh-race-response", content: response }),
    ]));

    await waitForConversationToSettle();
    expect(appendMessageMock.mock.calls.filter((call) => (
      call[1] === "assistant" && call[2] === response
    ))).toHaveLength(1);
    expect(updateFeatureMock).toHaveBeenCalledTimes(1);
  });

  test("feature refresh rejects a valid response older than the pending user", async () => {
    const stale = featurePlannerReply("Remote stale response");
    seedStores(chatFeature({ messages: [] }));
    seedExistingCodexEnvironment();
    getSessionMessagesMock.mockImplementationOnce(async () => [
      makeCodexMessage({
        id: "remote-stale-feature",
        content: stale,
        createdAt: "2025-12-31T23:59:59.000Z",
      }),
    ]);
    render(<FeaturesView projectId="project-1" />);
    await flushReconcileStart();
    act(() => {
      updateFeatureInStore("feature-1", { messages: [pendingUser()] });
    });

    fireEvent.click(screen.getByTitle("Refresh Codex status"));

    await waitFor(() => expect(getSessionMessagesMock).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });
    expect(useFeaturePlanStore.getState().activeConversations.get("feature-1"))
      .toBeUndefined();
    expect(appendMessageMock).not.toHaveBeenCalled();
    expect(updateFeatureMock).not.toHaveBeenCalled();
  });

  test("refresh is a no-op without persisted session identifiers and reports backend failures", async () => {
    seedStores(chatFeature({ codexEnvironmentId: undefined, codexSessionId: undefined }));
    render(<FeaturesView projectId="project-1" />);

    // This feature has no session id, so there is nothing to filter the shared spy
    // on. Compare against a snapshot taken immediately before the click instead of
    // asserting an absolute zero, which leaked work from an earlier test can break.
    const readsBeforeRefresh = getSessionMessagesMock.mock.calls.length;
    fireEvent.click(screen.getByTitle("Refresh Codex status"));
    expect(getSessionMessagesMock.mock.calls.length).toBe(readsBeforeRefresh);

    cleanup();
    getSessionMessagesMock.mockImplementationOnce(async () => {
      throw new Error("bridge unavailable");
    });
    seedStores(chatFeature());
    seedExistingCodexEnvironment();
    render(<FeaturesView projectId="project-1" />);
    fireEvent.click(screen.getByTitle("Refresh Codex status"));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(
      "Failed to refresh feature chat",
      expect.objectContaining({ description: "bridge unavailable" }),
    ));
  });
});

describe("FeaturesView Codex session bootstrap", () => {
  test("stops before bridge startup when the created environment id cannot be persisted", async () => {
    seedStores(chatFeature({ codexEnvironmentId: undefined, codexSessionId: undefined }));
    updateFeatureMock.mockImplementationOnce(async () => undefined);
    render(<FeaturesView projectId="project-1" />);

    fireEvent.change(screen.getByPlaceholderText("Describe the feature or answer Codex..."), {
      target: { value: "Create environment" },
    });
    fireEvent.click(screen.getByTitle("Send message"));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(
      "Feature planning failed",
      expect.objectContaining({ description: "Failed to persist the feature planning environment" }),
    ));
    expect(createSessionMock).not.toHaveBeenCalled();
    expect(sendPromptMock).not.toHaveBeenCalled();
  });

  test("stops before prompt dispatch when the new session id cannot be persisted", async () => {
    seedStores(chatFeature({ codexSessionId: undefined }));
    seedExistingCodexEnvironment();
    updateFeatureMock.mockImplementationOnce(async () => undefined);
    render(<FeaturesView projectId="project-1" />);

    fireEvent.change(screen.getByPlaceholderText("Describe the feature or answer Codex..."), {
      target: { value: "Create session" },
    });
    fireEvent.click(screen.getByTitle("Send message"));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(
      "Feature planning failed",
      expect.objectContaining({ description: "Failed to persist the feature planning session" }),
    ));
    expect(createSessionMock).toHaveBeenCalledTimes(1);
    expect(sendPromptMock).not.toHaveBeenCalled();
  });

  test("creates and starts a local environment, starts its bridge, and persists a plan-mode session", async () => {
    const stoppedLocal = makeEnvironment({
      id: "env-local",
      containerId: null,
      environmentType: "local",
      status: "stopped",
      worktreePath: "/tmp/worktree",
    });
    const runningLocal = { ...stoppedLocal, status: "running" as const };
    const assistantContent = featurePlannerReply("Local reply");
    const assistant = makeCodexMessage({ id: "local-reply", content: assistantContent });
    seedStores(chatFeature({
      title: "Local plan",
      summary: "Local summary",
      codexEnvironmentId: undefined,
      codexSessionId: undefined,
    }));
    useConfigStore.setState((state) => ({
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          codexModel: "global-model",
          codexReasoningEffort: "low",
          codexNativeFastModeDefault: true,
        },
        repositories: {
          ...state.config.repositories,
          "project-1": {
            ...(state.config.repositories["project-1"] ?? {
              defaultBranch: "main",
              prBaseBranch: "main",
            }),
            defaultModel: "repository-model",
            defaultEffort: "high",
          },
        },
      },
    }));
    useProjectStore.setState((state) => ({
      projects: state.projects.map((project) => ({ ...project, localPath: "/repo" })),
    }));
    createEnvironmentMock.mockImplementationOnce(async () => stoppedLocal);
    updateEnvironmentAgentSettingsMock.mockImplementationOnce(async () => stoppedLocal);
    getEnvironmentMock.mockImplementationOnce(async () => runningLocal);
    getLocalCodexServerStatusMock.mockImplementation(async () => ({
      running: false,
      port: null,
      pid: null,
      authToken: "",
    }));
    getSessionMessagesMock
      .mockImplementationOnce(async () => [])
      .mockImplementationOnce(async () => [assistant]);
    render(<FeaturesView projectId="project-1" />);

    fireEvent.change(screen.getByPlaceholderText("Describe the feature or answer Codex..."), {
      target: { value: "Use local Codex" },
    });
    fireEvent.click(screen.getByTitle("Send message"));

    await waitFor(() => expect(appendMessageMock).toHaveBeenCalledWith(
      "feature-1",
      "assistant",
      assistantContent,
      "pending",
    ));
    expect(createEnvironmentMock).toHaveBeenCalledWith(
      "project-1",
      "feature-plan-Local plan",
      "full",
      undefined,
      undefined,
      "local",
      "Local summary",
    );
    expect(updateEnvironmentAgentSettingsMock).toHaveBeenCalledWith(
      "env-local",
      "codex",
      null,
      null,
      null,
      "native",
    );
    // This path drives the Codex bridge directly and opens no agent tab, so it
    // must not touch a durable launch intent.
    expect(updateEnvironmentAgentSettingsMock.mock.calls.at(-1)).toHaveLength(6);
    expect(startEnvironmentMock).toHaveBeenCalledWith("env-local", undefined, { silent: true });
    expect(startLocalCodexServerMock).toHaveBeenCalledWith("env-local");
    expect(createClientMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4100",
      "local-token",
    );
    expect(createSessionMock).toHaveBeenCalledWith(
      { baseUrl: "http://127.0.0.1:4100", authToken: "local-token" },
      {
        title: "Local plan",
        model: "repository-model",
        modelReasoningEffort: "high",
        mode: "plan",
        fastMode: true,
      },
    );
    expect(updateFeatureMock).toHaveBeenCalledWith("feature-1", { codexEnvironmentId: "env-local" });
    expect(updateFeatureMock).toHaveBeenCalledWith("feature-1", { codexSessionId: "session-new" });
  });

  test("starts a stopped container bridge and reuses the cached client on the next message", async () => {
    const environment = makeEnvironment({ status: "stopped" });
    const running = { ...environment, status: "running" as const };
    const firstContent = featurePlannerReply("First");
    const secondContent = featurePlannerReply("Second");
    const firstReply = makeCodexMessage({ id: "reply-1", content: firstContent });
    const secondReply = makeCodexMessage({ id: "reply-2", content: secondContent });
    seedStores(chatFeature());
    seedExistingCodexEnvironment(environment);
    getEnvironmentMock.mockImplementationOnce(async () => running);
    getCodexServerStatusMock.mockImplementation(async () => ({
      running: false,
      hostPort: null,
      authToken: "",
    }));
    getSessionMessagesMock
      .mockImplementationOnce(async () => [])
      .mockImplementationOnce(async () => [firstReply])
      .mockImplementationOnce(async () => [firstReply])
      .mockImplementationOnce(async () => [firstReply, secondReply]);
    render(<FeaturesView projectId="project-1" />);

    const textarea = screen.getByPlaceholderText("Describe the feature or answer Codex...");
    fireEvent.change(textarea, { target: { value: "First request" } });
    fireEvent.click(screen.getByTitle("Send message"));
    await waitFor(() => expect(appendMessageMock).toHaveBeenCalledWith(
      "feature-1",
      "assistant",
      firstContent,
      "pending",
    ));

    fireEvent.change(screen.getByPlaceholderText("Describe the feature or answer Codex..."), {
      target: { value: "Second request" },
    });
    fireEvent.click(screen.getByTitle("Send message"));
    await waitFor(() => expect(appendMessageMock).toHaveBeenCalledWith(
      "feature-1",
      "assistant",
      secondContent,
      "pending",
    ));

    expect(startEnvironmentMock).toHaveBeenCalledTimes(1);
    expect(startCodexServerMock).toHaveBeenCalledWith("container-feature");
    expect(createClientMock).toHaveBeenCalledTimes(1);
  });

  test("replaces a cached Codex client after its authenticated health probe fails", async () => {
    const firstContent = featurePlannerReply("First");
    const secondContent = featurePlannerReply("Second");
    const firstReply = makeCodexMessage({ id: "reply-1", content: firstContent });
    const secondReply = makeCodexMessage({ id: "reply-2", content: secondContent });
    seedStores(chatFeature());
    seedExistingCodexEnvironment();
    checkHealthMock.mockResolvedValueOnce(false);
    getSessionMessagesMock
      .mockImplementationOnce(async () => [])
      .mockImplementationOnce(async () => [firstReply])
      .mockImplementationOnce(async () => [firstReply])
      .mockImplementationOnce(async () => [firstReply, secondReply]);
    render(<FeaturesView projectId="project-1" />);

    fireEvent.change(screen.getByPlaceholderText("Describe the feature or answer Codex..."), {
      target: { value: "First request" },
    });
    fireEvent.click(screen.getByTitle("Send message"));
    await waitFor(() => expect(appendMessageMock).toHaveBeenCalledWith(
      "feature-1",
      "assistant",
      firstContent,
      "pending",
    ));

    fireEvent.change(screen.getByPlaceholderText("Describe the feature or answer Codex..."), {
      target: { value: "Second request" },
    });
    fireEvent.click(screen.getByTitle("Send message"));
    await waitFor(() => expect(appendMessageMock).toHaveBeenCalledWith(
      "feature-1",
      "assistant",
      secondContent,
      "pending",
    ));

    expect(checkHealthMock).toHaveBeenCalledTimes(1);
    expect(createClientMock).toHaveBeenCalledTimes(2);
    expect(createClientMock).toHaveBeenLastCalledWith(
      "http://127.0.0.1:4200",
      "container-token",
    );
  });

  test("recreates an expired persisted session before sending", async () => {
    const replacementContent = featurePlannerReply("Replacement reply");
    const reply = makeCodexMessage({ id: "replacement-reply", content: replacementContent });
    seedStores(chatFeature({
      codexSessionId: "expired-session",
      messages: [
        { id: "prior-user", role: "user", content: "Earlier context", createdAt: NOW },
        { id: "prior-assistant", role: "assistant", content: "Earlier answer", createdAt: NOW },
      ],
    }));
    useConfigStore.setState((state) => ({
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          codexModel: "global-fallback-model",
          codexReasoningEffort: "xhigh",
          codexNativeFastModeDefault: false,
        },
        repositories: {
          ...state.config.repositories,
          "project-1": {
            defaultBranch: "main",
            prBaseBranch: "main",
          },
        },
      },
    }));
    seedExistingCodexEnvironment();
    getSessionStatusMock
      .mockImplementationOnce(async () => null)
      .mockImplementationOnce(async () => ({ status: "idle" }));
    getSessionMessagesMock
      .mockImplementationOnce(async () => [])
      .mockImplementationOnce(async () => [reply]);
    render(<FeaturesView projectId="project-1" />);

    fireEvent.change(screen.getByPlaceholderText("Describe the feature or answer Codex..."), {
      target: { value: "Resume after expiry" },
    });
    fireEvent.click(screen.getByTitle("Send message"));

    await waitFor(() => expect(appendMessageMock).toHaveBeenCalledWith(
      "feature-1",
      "assistant",
      replacementContent,
      "pending",
    ));
    expect(createSessionMock).toHaveBeenCalledTimes(1);
    expect(createSessionMock).toHaveBeenCalledWith(
      { baseUrl: "http://127.0.0.1:4200", authToken: "container-token" },
      {
        title: "My Feature",
        model: "global-fallback-model",
        modelReasoningEffort: "xhigh",
        mode: "plan",
        fastMode: false,
      },
    );
    expect(updateFeatureMock).toHaveBeenCalledWith("feature-1", { codexSessionId: "session-new" });
    expect(sendPromptMock.mock.calls[0]?.[2]).toContain("This is a resumed planning session");
  });

  test("uses an existing environment found only in the backend", async () => {
    const replyContent = featurePlannerReply("Backend environment reply");
    seedStores(chatFeature());
    getEnvironmentMock.mockImplementation(async () => makeEnvironment());
    getSessionMessagesMock
      .mockImplementationOnce(async () => [])
      .mockImplementationOnce(async () => [makeCodexMessage({ content: replyContent })]);
    render(<FeaturesView projectId="project-1" />);

    fireEvent.change(screen.getByPlaceholderText("Describe the feature or answer Codex..."), {
      target: { value: "Use the backend environment" },
    });
    fireEvent.click(screen.getByTitle("Send message"));

    await waitFor(() => expect(appendMessageMock).toHaveBeenCalledWith(
      "feature-1",
      "assistant",
      replyContent,
      "pending",
    ));
    expect(getEnvironmentMock).toHaveBeenCalledWith("env-feature");
    expect(createEnvironmentMock).not.toHaveBeenCalled();
    expect(createClientMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4200",
      "container-token",
    );
  });

  test("reports a running local bridge that omits its port", async () => {
    seedStores(chatFeature());
    getEnvironmentMock.mockImplementation(async () => makeEnvironment({
      environmentType: "local",
      containerId: null,
    }));
    getLocalCodexServerStatusMock.mockImplementationOnce(async () => ({
      running: true,
      pid: 10,
      port: null,
      authToken: "local-token",
    }));
    render(<FeaturesView projectId="project-1" />);
    await flushReconcileStart();

    fireEvent.change(screen.getByPlaceholderText("Describe the feature or answer Codex..."), {
      target: { value: "Cannot resolve local bridge" },
    });
    fireEvent.click(screen.getByTitle("Send message"));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(
      "Feature planning failed",
      expect.objectContaining({ description: "Failed to resolve authenticated Codex bridge" }),
    ));
    await waitForConversationToSettle();
    expect(sendPromptMock).not.toHaveBeenCalled();
  });

  test("reports missing container identity and missing bridge ports before sending", async () => {
    seedStores(chatFeature());
    seedExistingCodexEnvironment(makeEnvironment({ containerId: null }));
    render(<FeaturesView projectId="project-1" />);
    await flushReconcileStart();

    fireEvent.change(screen.getByPlaceholderText("Describe the feature or answer Codex..."), {
      target: { value: "Cannot send" },
    });
    fireEvent.click(screen.getByTitle("Send message"));
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(
      "Feature planning failed",
      expect.objectContaining({ description: "Container ID is required for feature planning in a container" }),
    ));
    await waitForConversationToSettle();
    expect(sendPromptMock).not.toHaveBeenCalled();

    cleanup();
    mockToastError.mockClear();
    seedStores(chatFeature());
    seedExistingCodexEnvironment();
    getCodexServerStatusMock.mockImplementationOnce(async () => ({
      running: true,
      hostPort: null,
      authToken: "container-token",
    }));
    render(<FeaturesView projectId="project-1" />);
    await flushReconcileStart();
    fireEvent.change(screen.getByPlaceholderText("Describe the feature or answer Codex..."), {
      target: { value: "Still cannot send" },
    });
    fireEvent.click(screen.getByTitle("Send message"));
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(
      "Feature planning failed",
      expect.objectContaining({ description: "Failed to resolve authenticated Codex bridge" }),
    ));
    await waitForConversationToSettle();
    expect(sendPromptMock).not.toHaveBeenCalled();
  });
});

describe("FeaturesView story refinement chat", () => {
  test("keeps a story refinement blocked across unmount and remount", async () => {
    sendPromptMock.mockImplementationOnce(() => new Promise(() => undefined));
    seedStores(featureWithStories({
      codexEnvironmentId: "env-feature",
      codexSessionId: "session-existing",
    }));
    seedExistingCodexEnvironment();
    const view = render(<FeaturesView projectId="project-1" />);
    openStory();

    fireEvent.change(screen.getByPlaceholderText("Refine the story, description, or acceptance criteria..."), {
      target: { value: "Keep refining in the background" },
    });
    fireEvent.click(screen.getByTitle("Send message"));
    await screen.findByText("Codex is refining...");

    view.unmount();
    getSessionStatusMock.mockClear();
    getSessionStatusMock.mockImplementation(async () => ({ status: "running" }));
    render(<FeaturesView projectId="project-1" />);
    openStory();

    await waitFor(() => expect(getSessionStatusMock).toHaveBeenCalledWith(
      { baseUrl: "http://127.0.0.1:4200", authToken: "container-token" },
      "session-existing",
      { throwOnError: true },
    ));
    await waitFor(() => expect(
      useFeaturePlanStore.getState().activeConversations.get("feature-1"),
    ).toMatchObject({
      storyId: "story-1",
      phase: "running",
    }));
    expect(screen.getByText("Codex is refining...")).toBeTruthy();
    expect(screen.getByTitle("Send message").hasAttribute("disabled")).toBe(true);
  });

  test("persists and applies a matching refinement while preserving siblings and blank-field fallbacks", async () => {
    const sibling = makeStory({ id: "sibling", title: "Sibling" });
    const refinement = `Refined.
<story_refinement>{"storyId":"story-1","title":"Refined story","description":"","acceptanceCriteria":[]}</story_refinement>`;
    seedStores(featureWithStories({
      codexEnvironmentId: "env-feature",
      codexSessionId: "session-existing",
      stories: [makeStory(), sibling],
    }));
    seedExistingCodexEnvironment();
    getSessionMessagesMock
      .mockImplementationOnce(async () => [])
      .mockImplementationOnce(async () => [makeCodexMessage({ id: "refinement", content: refinement })]);
    const phases: ActiveFeatureConversation[] = [];
    const unsubscribe = useFeaturePlanStore.subscribe((state) => {
      const conversation = state.activeConversations.get("feature-1");
      if (conversation) phases.push({ ...conversation });
    });
    render(<FeaturesView projectId="project-1" />);
    openStory();

    fireEvent.change(screen.getByPlaceholderText("Refine the story, description, or acceptance criteria..."), {
      target: { value: "Make it clearer" },
    });
    fireEvent.click(screen.getByTitle("Send message"));

    await waitFor(() => expect(appendStoryMessageMock).toHaveBeenCalledWith(
      "feature-1",
      "story-1",
      "assistant",
      refinement,
      "pending",
    ));
    await waitFor(() => expect(
      useFeaturePlanStore.getState().features[0]?.stories[0]?.title
    ).toBe("Refined story"));
    const updated = useFeaturePlanStore.getState().features[0]!;
    expect(updated.stories[0]?.description).toBe("Story description");
    expect(updated.stories[0]?.acceptanceCriteria).toEqual(["criterion one"]);
    expect(updated.stories[1]).toEqual(sibling);
    expect(sendPromptMock.mock.calls[0]?.[2]).toContain("Make it clearer");
    expect(sendPromptMock.mock.calls[0]?.[2]).toContain('"storyId":"story-1"');
    unsubscribe();
    expect(phases).toContainEqual(expect.objectContaining({
      storyId: "story-1",
      startedAt: NOW,
      phase: "dispatching",
    }));
    expect(phases).toContainEqual(expect.objectContaining({
      storyId: "story-1",
      startedAt: NOW,
      phase: "running",
    }));
    expect(useFeaturePlanStore.getState().activeConversations.has("feature-1")).toBe(false);
  });

  test("restores an unsaved story draft and does not send when persistence fails", async () => {
    appendStoryMessageMock.mockImplementationOnce(async () => undefined);
    seedStores(featureWithStories({
      codexEnvironmentId: "env-feature",
      codexSessionId: "session-existing",
    }));
    seedExistingCodexEnvironment();
    render(<FeaturesView projectId="project-1" />);
    openStory();

    const textarea = screen.getByPlaceholderText("Refine the story, description, or acceptance criteria...");
    fireEvent.change(textarea, { target: { value: "Keep story draft" } });
    fireEvent.click(screen.getByTitle("Send message"));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(
      "Story refinement failed",
      expect.objectContaining({ description: "Failed to persist the story message" }),
    ));
    expect((screen.getByPlaceholderText(
      "Refine the story, description, or acceptance criteria..."
    ) as HTMLTextAreaElement).value).toBe("Keep story draft");
    expect(sendPromptMock).not.toHaveBeenCalled();
  });

  test("reports a rejected story prompt without fabricating a refinement", async () => {
    sendPromptMock.mockImplementationOnce(async () => false);
    seedStores(featureWithStories({
      codexEnvironmentId: "env-feature",
      codexSessionId: "session-existing",
    }));
    seedExistingCodexEnvironment();
    render(<FeaturesView projectId="project-1" />);
    await flushReconcileStart();
    openStory();

    fireEvent.change(screen.getByPlaceholderText(
      "Refine the story, description, or acceptance criteria...",
    ), {
      target: { value: "Reject this refinement" },
    });
    fireEvent.click(screen.getByTitle("Send message"));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(
      "Story refinement failed",
      expect.objectContaining({ description: "Failed to send story refinement prompt" }),
    ));
    await waitForConversationToSettle();
    expect(appendStoryMessageMock).toHaveBeenCalledTimes(1);
    expect(appendStoryMessageMock).toHaveBeenCalledWith(
      "feature-1",
      "story-1",
      "user",
      "Reject this refinement",
    );
  });

  test("reports story assistant-transcript persistence failure before changing the card", async () => {
    const refinement = `Refined.
<story_refinement>{"storyId":"story-1","title":"Do not apply"}</story_refinement>`;
    let appendCount = 0;
    appendStoryMessageMock.mockImplementation(async (featureId, storyId, role, content) => {
      appendCount += 1;
      return appendCount === 1
        ? appendStoryMessageInStore(featureId, storyId, role, content)
        : undefined;
    });
    seedStores(featureWithStories({
      codexEnvironmentId: "env-feature",
      codexSessionId: "session-existing",
    }));
    seedExistingCodexEnvironment();
    getSessionMessagesMock
      .mockImplementationOnce(async () => [])
      .mockImplementationOnce(async () => [makeCodexMessage({ id: "refinement", content: refinement })]);
    render(<FeaturesView projectId="project-1" />);
    await flushReconcileStart();
    openStory();

    fireEvent.change(screen.getByPlaceholderText("Refine the story, description, or acceptance criteria..."), {
      target: { value: "Persist response" },
    });
    fireEvent.click(screen.getByTitle("Send message"));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(
      "Story refinement failed",
      expect.objectContaining({ description: "Failed to persist the story refinement response" }),
    ));
    await waitForConversationPhase("unavailable");
    expect(updateFeatureMock).not.toHaveBeenCalled();
    expect(useFeaturePlanStore.getState().features[0]?.stories[0]?.title).toBe("Story 1");
  });

  test("reports refined-card persistence failure after preserving the story transcript", async () => {
    const refinement = `Refined.
<story_refinement>{"storyId":"story-1","title":"Persist me"}</story_refinement>`;
    updateFeatureMock.mockImplementationOnce(async () => undefined);
    seedStores(featureWithStories({
      codexEnvironmentId: "env-feature",
      codexSessionId: "session-existing",
    }));
    seedExistingCodexEnvironment();
    getSessionMessagesMock
      .mockImplementationOnce(async () => [])
      .mockImplementationOnce(async () => [makeCodexMessage({ id: "refinement", content: refinement })]);
    render(<FeaturesView projectId="project-1" />);
    openStory();

    fireEvent.change(screen.getByPlaceholderText("Refine the story, description, or acceptance criteria..."), {
      target: { value: "Update card" },
    });
    fireEvent.click(screen.getByTitle("Send message"));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(
      "Story refinement failed",
      expect.objectContaining({ description: "Failed to persist the refined story" }),
    ));
    expect(appendStoryMessageMock).toHaveBeenCalledWith(
      "feature-1",
      "story-1",
      "assistant",
      refinement,
      "pending",
    );
  });

  test("keeps a live story send recoverable when persistence fails after unmount", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => undefined);
    const refinement = `Live story failure.
<story_refinement>{"storyId":"story-1","title":"Do not lose this"}</story_refinement>`;
    const assistantAppend = deferred<FeaturePlan | undefined>();
    appendStoryMessageMock.mockImplementation(async (
      featureId,
      storyId,
      role,
      content,
      stateApplication,
    ) => (
      role === "assistant"
        ? assistantAppend.promise
        : appendStoryMessageInStore(
            featureId,
            storyId,
            role,
            content,
            stateApplication,
          )
    ));
    seedStores(featureWithStories({
      codexEnvironmentId: "env-feature",
      codexSessionId: "session-existing",
    }));
    seedExistingCodexEnvironment();
    getSessionMessagesMock
      .mockImplementationOnce(async () => [])
      .mockImplementationOnce(async () => [
        makeCodexMessage({ id: "live-story-unmounted", content: refinement }),
      ]);

    try {
      const view = render(<FeaturesView projectId="project-1" />);
      openStory();
      fireEvent.change(
        screen.getByPlaceholderText(
          "Refine the story, description, or acceptance criteria...",
        ),
        { target: { value: "Fail story persistence after close" } },
      );
      fireEvent.click(screen.getByTitle("Send message"));
      await waitForConversationPhase("persisting");
      view.unmount();

      await act(async () => assistantAppend.reject(
        new Error("Live story append failed after unmount"),
      ));
      await waitForConversationPhase("unavailable");

      render(<FeaturesView projectId="project-1" />);
      openStory();
      expect((await screen.findByRole("alert")).textContent).toContain(
        "Live story append failed after unmount",
      );
      expect(useFeaturePlanStore.getState().activeConversations.get("feature-1"))
        .toMatchObject({
          storyId: "story-1",
          phase: "unavailable",
          responseContent: refinement,
        });
    } finally {
      consoleError.mockRestore();
    }
  });

  test("retries a pending story state write that fails after unmount", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => undefined);
    const refinement = `Pending story state.
<story_refinement>{"storyId":"story-1","title":"Applied story after remount","description":"recovered","acceptanceCriteria":["done"]}</story_refinement>`;
    const stateUpdate = deferred<FeaturePlan | undefined>();
    updateFeatureMock.mockImplementationOnce(async () => stateUpdate.promise);
    seedStores(featureWithStories({
      codexEnvironmentId: "env-feature",
      codexSessionId: "session-existing",
    }));
    seedExistingCodexEnvironment();
    getSessionMessagesMock
      .mockImplementationOnce(async () => [])
      .mockImplementationOnce(async () => [
        makeCodexMessage({ id: "pending-story-state", content: refinement }),
      ]);

    try {
      const view = render(<FeaturesView projectId="project-1" />);
      openStory();
      fireEvent.change(
        screen.getByPlaceholderText(
          "Refine the story, description, or acceptance criteria...",
        ),
        { target: { value: "Persist story state after remount" } },
      );
      fireEvent.click(screen.getByTitle("Send message"));
      await waitFor(() => expect(
        useFeaturePlanStore.getState().features[0]?.stories[0]?.messages.at(-1),
      ).toMatchObject({
        role: "assistant",
        content: refinement,
        stateApplication: "pending",
      }));
      await waitForConversationPhase("persisting");
      view.unmount();

      await act(async () => stateUpdate.resolve(undefined));
      await waitForConversationPhase("unavailable");

      render(<FeaturesView projectId="project-1" />);
      openStory();
      fireEvent.click(await screen.findByRole("button", { name: "Check again" }));
      await waitForConversationToSettle();

      expect(appendStoryMessageMock.mock.calls.filter((call) => (
        call[2] === "assistant" && call[3] === refinement
      ))).toHaveLength(1);
      expect(useFeaturePlanStore.getState().features[0]?.stories[0])
        .toMatchObject({
          title: "Applied story after remount",
          description: "recovered",
          acceptanceCriteria: ["done"],
        });
      expect(useFeaturePlanStore.getState().features[0]?.stories[0]?.messages.at(-1))
        .toMatchObject({
          content: refinement,
          stateApplication: "applied",
        });
    } finally {
      consoleError.mockRestore();
    }
  });

  test("retries story state application after the assistant append already succeeded", async () => {
    const refinement = `Persisted story response.
<story_refinement>{"storyId":"story-1","title":"Recovered story state","description":"Recovered","acceptanceCriteria":["Done"]}</story_refinement>`;
    updateFeatureMock.mockImplementationOnce(async () => undefined);
    getSessionMessagesMock
      .mockImplementationOnce(async () => [])
      .mockImplementationOnce(async () => [
        makeCodexMessage({ id: "partial-story-reply", content: refinement }),
      ]);
    seedStores(featureWithStories({
      codexEnvironmentId: "env-feature",
      codexSessionId: "session-existing",
    }));
    seedExistingCodexEnvironment();
    render(<FeaturesView projectId="project-1" />);
    openStory();

    fireEvent.change(screen.getByPlaceholderText("Refine the story, description, or acceptance criteria..."), {
      target: { value: "Write story transcript then state" },
    });
    fireEvent.click(screen.getByTitle("Send message"));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Failed to persist the refined story",
    );
    expect(appendStoryMessageMock.mock.calls.filter((call) => (
      call[2] === "assistant" && call[3] === refinement
    ))).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));

    await waitFor(() => expect(
      useFeaturePlanStore.getState().features[0]?.stories[0],
    ).toMatchObject({
      title: "Recovered story state",
      description: "Recovered",
      acceptanceCriteria: ["Done"],
    }));
    expect(appendStoryMessageMock.mock.calls.filter((call) => (
      call[2] === "assistant" && call[3] === refinement
    ))).toHaveLength(1);
    expect(useFeaturePlanStore.getState().activeConversations.has("feature-1")).toBe(false);
  });

  test("rejects a refinement for another story after preserving the assistant transcript", async () => {
    const mismatch = `Wrong story.
<story_refinement>{"storyId":"other-story","title":"Do not apply"}</story_refinement>`;
    seedStores(featureWithStories({
      codexEnvironmentId: "env-feature",
      codexSessionId: "session-existing",
    }));
    seedExistingCodexEnvironment();
    getSessionMessagesMock
      .mockImplementationOnce(async () => [])
      .mockImplementationOnce(async () => [makeCodexMessage({ id: "mismatch", content: mismatch })]);
    render(<FeaturesView projectId="project-1" />);
    openStory();

    fireEvent.change(screen.getByPlaceholderText("Refine the story, description, or acceptance criteria..."), {
      target: { value: "Refine" },
    });
    fireEvent.click(screen.getByTitle("Send message"));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(
      "Story refinement failed",
      expect.objectContaining({ description: "Story refinement response targeted a different story" }),
    ));
    expect(appendStoryMessageMock).toHaveBeenCalledWith(
      "feature-1",
      "story-1",
      "assistant",
      mismatch,
      "pending",
    );
    expect(useFeaturePlanStore.getState().features[0]?.stories[0]?.title).toBe("Story 1");
  });

  test("story timeout preserves and blocks the request for explicit recovery", async () => {
    const staleReply = makeCodexMessage({ id: "story-stale", content: "Old story response" });
    seedStores(featureWithStories({
      codexEnvironmentId: "env-feature",
      codexSessionId: "session-existing",
    }));
    seedExistingCodexEnvironment();
    getSessionMessagesMock.mockImplementation(async () => [staleReply]);
    render(<FeaturesView projectId="project-1" />);
    await flushReconcileStart();
    openStory();
    const dateNow = spyOn(Date, "now")
      .mockReturnValueOnce(0)
      .mockReturnValue(10 * 60 * 1000 + 1);

    try {
      fireEvent.change(screen.getByPlaceholderText("Refine the story, description, or acceptance criteria..."), {
        target: { value: "Wait for story" },
      });
      fireEvent.click(screen.getByTitle("Send message"));
      await waitFor(() => expect(mockToastWarning).toHaveBeenCalledWith(
        "Codex is still refining the story",
        expect.objectContaining({ description: expect.stringContaining("Use Check again") }),
      ));
      expect((await screen.findByRole("alert")).textContent).toContain(
        "Codex is still refining this story",
      );
      expect(screen.getByTitle("Refresh Codex status").hasAttribute("disabled")).toBe(true);
      expect(appendStoryMessageMock).not.toHaveBeenCalledWith(
        "feature-1",
        "story-1",
        "assistant",
        "Old story response",
        "pending",
      );
    } finally {
      dateNow.mockRestore();
    }
  });

  test("story refresh reports failure when a recovered response cannot be persisted", async () => {
    const matching = `Matching.
<story_refinement>{"storyId":"story-1","description":"Recovered"}</story_refinement>`;
    appendStoryMessageMock.mockImplementationOnce(async () => undefined);
    seedStores(featureWithStories({
      codexEnvironmentId: "env-feature",
      codexSessionId: "session-existing",
    }));
    seedExistingCodexEnvironment();
    getSessionMessagesMock.mockImplementationOnce(async () => [
      makeCodexMessage({ id: "matching", content: matching }),
    ]);
    render(<FeaturesView projectId="project-1" />);
    openStory();

    fireEvent.click(screen.getByTitle("Refresh Codex status"));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(
      "Failed to refresh story chat",
      expect.objectContaining({ description: "Failed to persist the refreshed story response" }),
    ));
    expect(updateFeatureMock).not.toHaveBeenCalled();
  });

  test("story refresh and remount recovery claim a pending response exactly once", async () => {
    const response = `Story refresh race.
<story_refinement>{"storyId":"story-1","description":"Recovered once"}</story_refinement>`;
    const transcript = deferred<CodexMessage[]>();
    let transcriptReads = 0;
    seedStores(featureWithStories({
      codexEnvironmentId: "env-feature",
      codexSessionId: "session-existing",
      stories: [makeStory({ messages: [pendingUser()] })],
    }));
    seedExistingCodexEnvironment();
    getSessionMessagesMock.mockImplementation(async () => {
      transcriptReads += 1;
      return transcript.promise;
    });
    const view = render(<FeaturesView projectId="project-1" />);
    openStory();

    fireEvent.click(screen.getByTitle("Refresh Codex status"));
    await waitFor(() => expect(transcriptReads).toBeGreaterThanOrEqual(1));
    const conversation = useFeaturePlanStore.getState()
      .activeConversations.get("feature-1")!;
    act(() => {
      useFeaturePlanStore.getState().updateConversation(
        {
          featureId: conversation.featureId,
          operationId: conversation.operationId,
        },
        {
          phase: "unavailable",
          error: "Recover the story refresh.",
        },
      );
    });

    view.unmount();
    render(<FeaturesView projectId="project-1" />);
    openStory();
    fireEvent.click(await screen.findByRole("button", { name: "Check again" }));
    await waitFor(() => expect(transcriptReads).toBeGreaterThanOrEqual(2));

    await act(async () => transcript.resolve([
      makeCodexMessage({ id: "story-refresh-race-response", content: response }),
    ]));

    await waitForConversationToSettle();
    expect(appendStoryMessageMock.mock.calls.filter((call) => (
      call[2] === "assistant" && call[3] === response
    ))).toHaveLength(1);
    expect(updateFeatureMock).toHaveBeenCalledTimes(1);
  });

  test("story refresh rejects a valid response older than the pending user", async () => {
    const stale = `Remote stale story response.
<story_refinement>{"storyId":"story-1","description":"Do not apply"}</story_refinement>`;
    seedStores(featureWithStories({
      codexEnvironmentId: "env-feature",
      codexSessionId: "session-existing",
      stories: [makeStory({ messages: [] })],
    }));
    seedExistingCodexEnvironment();
    getSessionMessagesMock.mockImplementationOnce(async () => [
      makeCodexMessage({
        id: "remote-stale-story",
        content: stale,
        createdAt: "2025-12-31T23:59:59.000Z",
      }),
    ]);
    render(<FeaturesView projectId="project-1" />);
    await flushReconcileStart();
    act(() => {
      const current = useFeaturePlanStore.getState().features[0]!;
      updateFeatureInStore(current.id, {
        stories: current.stories.map((story) => (
          story.id === "story-1"
            ? { ...story, messages: [pendingUser()] }
            : story
        )),
      });
    });
    openStory();

    fireEvent.click(screen.getByTitle("Refresh Codex status"));

    await waitFor(() => expect(getSessionMessagesMock).toHaveBeenCalled());
    await waitForConversationToSettle();
    expect(appendStoryMessageMock).not.toHaveBeenCalled();
    expect(updateFeatureMock).not.toHaveBeenCalled();
  });

  test("story refresh selects only a matching story response, deduplicates it, and reports errors", async () => {
    const matching = `Matching.
<story_refinement>{"storyId":"story-1","description":"Refreshed description"}</story_refinement>`;
    const other = `Other.
<story_refinement>{"storyId":"other","description":"Wrong description"}</story_refinement>`;
    const featureState = `Feature.
<feature_planner_state>{"phase":"collecting","title":"Wrong channel","stories":[]}</feature_planner_state>`;
    seedStores(featureWithStories({
      codexEnvironmentId: "env-feature",
      codexSessionId: "session-existing",
    }));
    seedExistingCodexEnvironment();
    getSessionMessagesMock.mockImplementationOnce(async () => [
      makeCodexMessage({ id: "matching", content: matching }),
      makeCodexMessage({ id: "feature", content: featureState }),
      makeCodexMessage({ id: "other", content: other }),
    ]);
    render(<FeaturesView projectId="project-1" />);
    openStory();

    fireEvent.click(screen.getByTitle("Refresh Codex status"));
    await waitFor(() => expect(appendStoryMessageMock).toHaveBeenCalledWith(
      "feature-1",
      "story-1",
      "assistant",
      matching,
      "pending",
    ));
    expect(appendStoryMessageMock).not.toHaveBeenCalledWith(
      "feature-1",
      "story-1",
      "assistant",
      other,
      "pending",
    );
    await waitFor(() => expect(
      useFeaturePlanStore.getState().features[0]?.stories[0]?.description
    ).toBe("Refreshed description"));

    appendStoryMessageMock.mockClear();
    act(() => {
      const current = useFeaturePlanStore.getState().features[0]!;
      updateFeatureInStore(current.id, {
        stories: current.stories.map((story) => story.id === "story-1"
          ? {
              ...story,
              messages: [
                ...story.messages,
                { id: "newer-plain", role: "assistant", content: "Malformed newer reply", createdAt: NOW },
              ],
            }
          : story),
      });
    });
    getSessionMessagesMock.mockImplementationOnce(async () => [makeCodexMessage({ id: "matching", content: matching })]);
    fireEvent.click(screen.getByTitle("Refresh Codex status"));
    await waitFor(() => expect(getSessionMessagesMock).toHaveBeenCalledTimes(2));
    expect(appendStoryMessageMock).not.toHaveBeenCalled();

    getSessionMessagesMock.mockImplementationOnce(async () => {
      throw new Error("story bridge failed");
    });
    fireEvent.click(screen.getByTitle("Refresh Codex status"));
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(
      "Failed to refresh story chat",
      expect.objectContaining({ description: "story bridge failed" }),
    ));
  });
});

describe("FeaturesView build action", () => {
  test("renders the Build button in the tab header when the feature has stories", () => {
    seedStores(featureWithStories());

    render(<FeaturesView projectId="project-1" />);

    expect(screen.getByRole("button", { name: "Build" })).toBeTruthy();
  });

  test("blocks Build while any project conversation is active", async () => {
    seedStores([
      featureWithStories({
        id: "feature-a",
        title: "Feature A",
        order: 0,
      }),
      chatFeature({
        id: "feature-b",
        title: "Feature B",
        messages: [pendingUser()],
        order: 1,
      }),
    ]);
    seedExistingCodexEnvironment();
    useFeaturePlanStore.getState().startConversation({
      operationId: "feature-b-running",
      featureId: "feature-b",
      startedAt: NOW,
      phase: "running",
    });
    getSessionStatusMock.mockImplementation(async () => ({ status: "running" }));

    render(<FeaturesView projectId="project-1" />);

    fireEvent.click(screen.getByText("Feature A").closest("button")!);
    const build = await screen.findByRole("button", { name: "Build" });
    expect(build.hasAttribute("disabled")).toBe(true);
    fireEvent.click(build);
    await waitFor(() => expect(getSessionStatusMock).toHaveBeenCalledWith(
      { baseUrl: "http://127.0.0.1:4200", authToken: "container-token" },
      "session-existing",
      { throwOnError: true },
    ));
    expect(addTaskMock).not.toHaveBeenCalled();
    expect(startBuildMock).not.toHaveBeenCalled();
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

  test("formats every story into the created Kanban task", async () => {
    seedStores(featureWithStories({
      title: " Saved views ",
      summary: "Users can save filters.",
      stories: [
        makeStory({
          id: "save",
          title: "Save a view",
          description: "Persist the current filters.",
          acceptanceCriteria: ["Can name it", "Can reopen it"],
        }),
        makeStory({
          id: "delete",
          title: "Delete a view",
          description: "Remove an obsolete view.",
          acceptanceCriteria: ["Asks for confirmation"],
        }),
      ],
    }));
    seedPipeline({ environmentId: "env-build" });
    render(<FeaturesView projectId="project-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Build" }));

    await waitFor(() => expect(addTaskMock).toHaveBeenCalledTimes(1));
    const [projectId, title, description] = addTaskMock.mock.calls[0]!;
    expect(projectId).toBe("project-1");
    expect(title).toBe("Saved views");
    expect(description).toContain("Feature summary:\nUsers can save filters.");
    expect(description).toContain("### 1. Save a view\nPersist the current filters.");
    expect(description).toContain("- Can name it\n- Can reopen it");
    expect(description).toContain("### 2. Delete a view\nRemove an obsolete view.");
    expect(description).toContain("- Asks for confirmation");
  });

  test("reports a missing task id and does not start a build", async () => {
    addTaskMock.mockImplementationOnce(async () => null as unknown as string);
    seedStores(featureWithStories());
    render(<FeaturesView projectId="project-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Build" }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(
      "Failed to start feature build",
      { description: "Failed to create Kanban task for feature build" },
    ));
    expect(startBuildMock).not.toHaveBeenCalled();
  });

  test("reports task persistence rejection and re-enables Build", async () => {
    addTaskMock.mockImplementationOnce(async () => {
      throw new Error("task persistence failed");
    });
    seedStores(featureWithStories());
    render(<FeaturesView projectId="project-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Build" }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(
      "Failed to start feature build",
      { description: "task persistence failed" },
    ));
    expect(screen.getByRole("button", { name: "Build" }).hasAttribute("disabled")).toBe(false);
    expect(startBuildMock).not.toHaveBeenCalled();
  });

  test("reports when the created task is absent from the store", async () => {
    seedStores(featureWithStories());
    useKanbanStore.setState({ tasks: [] });
    render(<FeaturesView projectId="project-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Build" }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(
      "Failed to start feature build",
      { description: "Created build task was not found in the Kanban store" },
    ));
    expect(startBuildMock).not.toHaveBeenCalled();
  });

  test("reports startBuild rejection without changing feature state", async () => {
    startBuildMock.mockImplementationOnce(async () => {
      throw new Error("build launch failed");
    });
    seedStores(featureWithStories());
    render(<FeaturesView projectId="project-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Build" }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(
      "Failed to start feature build",
      { description: "build launch failed" },
    ));
    expect(updateFeatureMock).not.toHaveBeenCalledWith(
      "feature-1",
      expect.objectContaining({ status: "building" }),
    );
  });

  test("leaves the feature unchanged when startBuild creates no pipeline", async () => {
    seedStores(featureWithStories());
    render(<FeaturesView projectId="project-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Build" }));

    await waitFor(() => expect(startBuildMock).toHaveBeenCalledTimes(1));
    expect(updateFeatureMock).not.toHaveBeenCalledWith(
      "feature-1",
      expect.objectContaining({ status: "building" }),
    );
  });

  test("omits the environment update when the pipeline has no environment id", async () => {
    seedStores(featureWithStories({ codexEnvironmentId: undefined }));
    const pipelineId = seedPipeline();
    render(<FeaturesView projectId="project-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Build" }));

    await waitFor(() => expect(updateFeatureMock).toHaveBeenCalledWith(
      "feature-1",
      expect.objectContaining({
        status: "building",
        buildPipelineId: pipelineId,
      }),
    ));
    const buildingUpdate = updateFeatureMock.mock.calls.find(([, updates]) =>
      updates.status === "building"
    )?.[1];
    expect(buildingUpdate).not.toHaveProperty("codexEnvironmentId");
  });

  test("uses the local environment preference for local projects", async () => {
    seedStores(featureWithStories({ codexEnvironmentId: undefined }));
    useProjectStore.setState((state) => ({
      projects: state.projects.map((project) => ({ ...project, localPath: "/repo" })),
    }));
    seedPipeline();
    render(<FeaturesView projectId="project-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Build" }));

    await waitFor(() => expect(startBuildMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-1" }),
      "local",
      "codex",
      { existingEnvironmentId: undefined },
    ));
  });

  test("uses the configured environment type before the project-path fallback", async () => {
    seedStores(featureWithStories({ codexEnvironmentId: undefined }));
    useProjectStore.setState((state) => ({
      projects: state.projects.map((project) => ({ ...project, localPath: "/repo" })),
    }));
    useConfigStore.setState((state) => ({
      config: {
        ...state.config,
        repositories: {
          ...state.config.repositories,
          "project-1": {
            ...(state.config.repositories["project-1"] ?? {
              defaultBranch: "main",
              prBaseBranch: "main",
            }),
            lastEnvironmentType: "containerized",
          },
        },
      },
    }));
    seedPipeline();
    render(<FeaturesView projectId="project-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Build" }));

    await waitFor(() => expect(startBuildMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-1" }),
      "containerized",
      "codex",
      { existingEnvironmentId: undefined },
    ));
  });

  test("suppresses a second build click while task creation is pending", async () => {
    let resolveTask!: (taskId: string) => void;
    addTaskMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveTask = resolve;
    }));
    seedStores(featureWithStories());
    seedPipeline();
    render(<FeaturesView projectId="project-1" />);

    const build = screen.getByRole("button", { name: "Build" });
    fireEvent.click(build);
    await waitFor(() => expect(build.hasAttribute("disabled")).toBe(true));
    fireEvent.click(build);
    expect(addTaskMock).toHaveBeenCalledTimes(1);

    await act(async () => resolveTask("task-1"));
    await waitFor(() => expect(startBuildMock).toHaveBeenCalledTimes(1));
  });

  test("reports feature-state persistence failure after a healthy pipeline", async () => {
    seedStores(featureWithStories());
    seedPipeline();
    updateFeatureMock.mockImplementationOnce(async () => undefined);
    render(<FeaturesView projectId="project-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Build" }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(
      "Failed to start feature build",
      { description: "Failed to persist the feature build state" },
    ));
    expect(screen.getByRole("button", { name: "Build" }).hasAttribute("disabled")).toBe(false);
  });
});
