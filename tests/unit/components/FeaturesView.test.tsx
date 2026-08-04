import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
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
import { useFeaturePlanStore } from "@/stores/featurePlanStore";
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
  _modelId?: string,
) => undefined as FeaturePlan | undefined);
const appendStoryMessageMock = mock(async (
  _featureId: string,
  _storyId: string,
  _role: FeaturePlanMessage["role"],
  _content: string,
  _stateApplication?: FeaturePlanMessage["stateApplication"],
  _modelId?: string,
) => undefined as FeaturePlan | undefined);
const updateFeatureMock = mock(async (
  _id: string,
  _updates: Partial<FeaturePlan>,
) => undefined as FeaturePlan | undefined);
const claimFeatureBuildMock = mock(async (
  _id: string,
  _taskId: string,
) => undefined as {
  claimed: boolean;
  feature: FeaturePlan;
} | undefined);
const deleteTaskMock = mock(async (_taskId: string) => undefined);
const loadFeaturesMock = mock(async () => true);
const startPlanningMock = mock(async (
  _featureId: string,
  _kind: "feature" | "story",
  _userMessage: string,
  _storyId?: string,
) => ({ operationId: "planning-1" } as never));
const retryPlanningMock = mock(async (_featureId: string) => ({ operationId: "planning-1" } as never));
const cancelPlanningMock = mock(async (_featureId: string) => true);
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
const getComposeDraftMock = mock(async (_draftKey: string) => null as Awaited<
  ReturnType<typeof realBackend.getComposeDraft>
>);
const saveComposeDraftMock = mock(async (
  draftKey: string,
  ownerType: "environment" | "project",
  ownerId: string,
  value: unknown,
) => ({
  draftKey,
  ownerType,
  ownerId,
  value,
  revision: 1,
  updatedAt: NOW,
}));
const deleteComposeDraftMock = mock(async (_draftKey: string) => undefined);
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
    resolvePreviousMessage,
    computeItemKey,
    footer,
  }: {
    messages: Array<{ id: string }>;
    renderMessage: (index: number, message: never, previousMessage: never) => ReactNode;
    resolvePreviousMessage?: (
      messages: readonly { id: string }[],
      index: number,
    ) => { id: string } | null;
    computeItemKey: (index: number, message: { id: string }) => string;
    footer?: ReactNode;
  }) => (
    <div
      data-testid="virtualized-list"
      data-has-previous-resolver={resolvePreviousMessage ? "true" : "false"}
    >
      {messages.map((message, index) => (
        <div key={message.id} data-item-key={computeItemKey(index, message)}>
          {renderMessage(
            index,
            message as never,
            // Mirror the real list so the panel's resolver actually runs here.
            (resolvePreviousMessage
              ? resolvePreviousMessage(messages, index)
              : messages[index - 1]) as never,
          )}
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
    message: { id: string; content: string; modelId?: string };
    previousMessage?: { id: string };
  }) => (
    <div
      data-testid={`native-message-${message.id}`}
      data-previous-id={previousMessage?.id ?? ""}
      data-model-id={message.modelId ?? ""}
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
  getComposeDraft: getComposeDraftMock,
  saveComposeDraft: saveComposeDraftMock,
  deleteComposeDraft: deleteComposeDraftMock,
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

function planningRecord(
  overrides: Partial<NonNullable<FeaturePlan["planning"]>> = {},
): NonNullable<FeaturePlan["planning"]> {
  return {
    version: 1,
    operationId: "planning-1",
    featureId: "feature-1",
    projectId: "project-1",
    kind: "feature",
    userMessage: "Please plan this",
    phase: "running",
    startedAt: NOW,
    updatedAt: NOW,
    backendRevision: 1,
    ...overrides,
  };
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
  modelId?: string,
): FeaturePlan | undefined {
  const feature = useFeaturePlanStore.getState().features.find((candidate) => candidate.id === featureId);
  if (!feature) return undefined;
  return updateFeatureInStore(featureId, {
    messages: [...feature.messages, {
      id: `${role}-${feature.messages.length + 1}`,
      role,
      content,
      createdAt: NOW,
      ...(modelId ? { modelId } : {}),
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
  modelId?: string,
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
            ...(modelId ? { modelId } : {}),
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
    loadFeatures: loadFeaturesMock as unknown as ReturnType<typeof useFeaturePlanStore.getState>["loadFeatures"],
    createFeature: createFeatureMock as unknown as ReturnType<typeof useFeaturePlanStore.getState>["createFeature"],
    updateFeature: updateFeatureMock as unknown as ReturnType<typeof useFeaturePlanStore.getState>["updateFeature"],
    claimFeatureBuild: claimFeatureBuildMock as unknown as ReturnType<typeof useFeaturePlanStore.getState>["claimFeatureBuild"],
    appendMessage: appendMessageMock as unknown as ReturnType<typeof useFeaturePlanStore.getState>["appendMessage"],
    appendStoryMessage: appendStoryMessageMock as unknown as ReturnType<typeof useFeaturePlanStore.getState>["appendStoryMessage"],
    startPlanning: startPlanningMock as unknown as ReturnType<typeof useFeaturePlanStore.getState>["startPlanning"],
    retryPlanning: retryPlanningMock as unknown as ReturnType<typeof useFeaturePlanStore.getState>["retryPlanning"],
    cancelPlanning: cancelPlanningMock as unknown as ReturnType<typeof useFeaturePlanStore.getState>["cancelPlanning"],
  });
  useKanbanStore.setState({
    tasks: [makeTask()],
    addTask: addTaskMock as unknown as ReturnType<typeof useKanbanStore.getState>["addTask"],
    deleteTask: deleteTaskMock as unknown as ReturnType<typeof useKanbanStore.getState>["deleteTask"],
    updateTask: updateTaskMock as unknown as ReturnType<typeof useKanbanStore.getState>["updateTask"],
  });
}

function seedPipeline(
  { taskId = "task-1", environmentId, failed = false }: { taskId?: string; environmentId?: string; failed?: boolean } = {},
): string {
  const id = `pipeline-${taskId}`;
  useBuildPipelineStore.getState().replacePipeline({
    id,
    taskId,
    projectId: "project-1",
    environmentId: environmentId ?? "",
    environmentType: "containerized",
    agentType: "codex",
    phase: failed ? "failed" : "building",
    sessions: [],
    currentSessionIndex: -1,
    iteration: 0,
    maxIterations: 3,
    createdAt: NOW,
    taskTitle: "Task",
    taskSnapshot: { title: "Task", description: "", acceptanceCriteria: "", comments: [], images: [] },
    source: { type: "kanban", taskId },
    ...(failed ? { error: "failed to start environment" } : {}),
    backendRevision: 1,
    controller: "backend",
  });
  return id;
}

/**
 * Unmount the view and let its reconcile monitors finish reacting.
 *
 * `FeaturesView` keeps one abortable monitor per active conversation, and its
 * effect cleanup aborts them on unmount — but abort only takes effect at the
 * monitor's next checkpoint, which sits behind an already-issued status or
 * transcript promise. Without draining those checkpoints here, a monitor left
 * over from one test resumed *inside the next one*, calling the freshly cleared
 * `getSessionStatus`/`getSessionMessages` mocks and making call-count
 * assertions depend on how loaded the machine was. Draining runs each straggler
 * to its abort check while its own test's mocks are still installed.
 */
async function drainReconcileMonitors(): Promise<void> {
  cleanup();
  // Three turns: one for the in-flight request's continuation, one for the poll
  // timer that resolves early on abort, one for the loop's own re-check.
  for (let turn = 0; turn < 3; turn += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
    });
  }
}

afterEach(async () => {
  await drainReconcileMonitors();
});

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
  appendMessageMock.mockImplementation(async (featureId, role, content, stateApplication, modelId) =>
    appendFeatureMessageInStore(featureId, role, content, stateApplication, modelId)
  );
  appendStoryMessageMock.mockClear();
  appendStoryMessageMock.mockImplementation(async (
    featureId,
    storyId,
    role,
    content,
    stateApplication,
    modelId,
  ) =>
    appendStoryMessageInStore(
      featureId,
      storyId,
      role,
      content,
      stateApplication,
      modelId,
    )
  );
  updateFeatureMock.mockClear();
  updateFeatureMock.mockImplementation(async (featureId, updates) =>
    updateFeatureInStore(featureId, updates)
  );
  claimFeatureBuildMock.mockClear();
  claimFeatureBuildMock.mockImplementation(async (featureId, taskId) => {
    const feature = await updateFeatureInStore(featureId, {
      status: "building",
      buildTaskId: taskId,
    });
    return feature ? { claimed: true, feature } : undefined;
  });
  deleteTaskMock.mockClear();
  deleteTaskMock.mockImplementation(async () => undefined);
  loadFeaturesMock.mockReset();
  loadFeaturesMock.mockResolvedValue(true);
  startPlanningMock.mockReset();
  startPlanningMock.mockResolvedValue({ operationId: "planning-1" } as never);
  retryPlanningMock.mockReset();
  retryPlanningMock.mockResolvedValue({ operationId: "planning-1" } as never);
  cancelPlanningMock.mockReset();
  cancelPlanningMock.mockResolvedValue(true);
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
  getComposeDraftMock.mockReset();
  getComposeDraftMock.mockResolvedValue(null);
  saveComposeDraftMock.mockReset();
  saveComposeDraftMock.mockImplementation(async (draftKey, ownerType, ownerId, value) => ({
    draftKey,
    ownerType,
    ownerId,
    value,
    revision: 1,
    updatedAt: NOW,
  }));
  deleteComposeDraftMock.mockReset();
  deleteComposeDraftMock.mockResolvedValue(undefined);
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
  useFeaturePlanStore.setState({ chatDrafts: new Map() });
  useBuildPipelineStore.setState({ pipelines: new Map(), buildEnvironmentIds: new Set() });
});

describe("FeaturesView message drafts", () => {
  test("does not delete backend drafts when the feature snapshot fails to load", async () => {
    loadFeaturesMock.mockResolvedValueOnce(false);
    getComposeDraftMock.mockResolvedValueOnce({
      draftKey: "feature-chat:project-1:all",
      ownerType: "project",
      ownerId: "project-1",
      value: { "feature:feature-1": "Keep after feature load failure" },
      revision: 2,
      updatedAt: NOW,
    });
    seedStores([]);

    render(<FeaturesView projectId="project-1" />);

    await waitFor(() => expect(getComposeDraftMock).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(deleteComposeDraftMock).not.toHaveBeenCalled();
    expect(saveComposeDraftMock).not.toHaveBeenCalled();
  });

  test("waits for feature loading before restoring and persisting backend drafts", async () => {
    const featureLoad = deferred<boolean>();
    loadFeaturesMock.mockImplementationOnce(() => featureLoad.promise);
    getComposeDraftMock.mockResolvedValueOnce({
      draftKey: "feature-chat:project-1:all",
      ownerType: "project",
      ownerId: "project-1",
      value: { "feature:feature-1": "Wait for features" },
      revision: 2,
      updatedAt: NOW,
    });
    seedStores(chatFeature());

    render(<FeaturesView projectId="project-1" />);
    await waitFor(() => expect(getComposeDraftMock).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(deleteComposeDraftMock).not.toHaveBeenCalled();

    featureLoad.resolve(true);
    await waitFor(() => expect((screen.getByPlaceholderText(
      "Describe the feature or answer Codex...",
    ) as HTMLTextAreaElement).value).toBe("Wait for features"));
  });

  test("restores feature chat drafts from backend persistence", async () => {
    getComposeDraftMock.mockResolvedValueOnce({
      draftKey: "feature-chat:project-1:all",
      ownerType: "project",
      ownerId: "project-1",
      value: { "feature:feature-1": "Recovered backend draft" },
      revision: 2,
      updatedAt: NOW,
    });
    seedStores(chatFeature());

    render(<FeaturesView projectId="project-1" />);

    await waitFor(() => expect((screen.getByPlaceholderText(
      "Describe the feature or answer Codex...",
    ) as HTMLTextAreaElement).value).toBe("Recovered backend draft"));
  });

  test("flushes a changed feature chat draft when the view unmounts before debounce", async () => {
    seedStores(chatFeature());
    const view = render(<FeaturesView projectId="project-1" />);
    const composer = screen.getByPlaceholderText("Describe the feature or answer Codex...");

    fireEvent.change(composer, { target: { value: "Persist before unmount" } });
    view.unmount();

    await waitFor(() => expect(saveComposeDraftMock).toHaveBeenCalledWith(
      "feature-chat:project-1:all",
      "project",
      "project-1",
      { "feature:feature-1": "Persist before unmount" },
      // 0 because hydration found no stored draft, and hydration is ordered
      // ahead of this save. It used to assert 1: the save ran before hydration
      // published, inheriting the cursor a previous mount had left behind.
      0,
    ));
  });

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
    const first = render(<FeaturesView projectId="project-1" />);

    fireEvent.click(screen.getByTitle("Send message"));
    await waitFor(() => expect(startPlanningMock).toHaveBeenCalledWith(
      "feature-1",
      "feature",
      "send feature",
    ));
    expect(useFeaturePlanStore.getState().getChatDraft("feature:feature-1")).toBe("");
    expect(useFeaturePlanStore.getState().getChatDraft("feature:other")).toBe("leave feature");
    first.unmount();

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

    await waitFor(() => expect(startPlanningMock).toHaveBeenCalledWith(
      "feature-1",
      "story",
      "send story",
      "story-1",
    ));
    expect(useFeaturePlanStore.getState().getChatDraft("feature:feature-1:story:story-1")).toBe("");
    expect(useFeaturePlanStore.getState().getChatDraft("feature:feature-1")).toBe("leave chat");
  });

  test("restores the exact feature draft and reports a rejected planning start", async () => {
    startPlanningMock.mockResolvedValueOnce(undefined as never);
    seedStores(chatFeature());
    useFeaturePlanStore.setState({
      chatDrafts: new Map([["feature:feature-1", "  keep my exact wording  "]]),
    });
    render(<FeaturesView projectId="project-1" />);

    fireEvent.click(screen.getByTitle("Send message"));

    await waitFor(() => expect(startPlanningMock).toHaveBeenCalledWith(
      "feature-1",
      "feature",
      "keep my exact wording",
    ));
    await waitFor(() => expect((screen.getByPlaceholderText(
      "Describe the feature or answer Codex...",
    ) as HTMLTextAreaElement).value).toBe("  keep my exact wording  "));
    expect(mockToastError).toHaveBeenCalledWith(
      "Feature planning failed to start",
      { description: "The backend refused the planning request." },
    );
  });

  test("restores the exact story draft and reports a rejected refinement start", async () => {
    startPlanningMock.mockResolvedValueOnce(undefined as never);
    seedStores(featureWithStories());
    useFeaturePlanStore.setState({
      chatDrafts: new Map([[
        "feature:feature-1:story:story-1",
        "  preserve story spacing  ",
      ]]),
    });
    render(<FeaturesView projectId="project-1" />);
    openStory();

    fireEvent.click(screen.getByTitle("Send message"));

    await waitFor(() => expect(startPlanningMock).toHaveBeenCalledWith(
      "feature-1",
      "story",
      "preserve story spacing",
      "story-1",
    ));
    await waitFor(() => expect((screen.getByPlaceholderText(
      "Refine the story, description, or acceptance criteria...",
    ) as HTMLTextAreaElement).value).toBe("  preserve story spacing  "));
    expect(mockToastError).toHaveBeenCalledWith(
      "Story refinement failed to start",
      { description: "The backend refused the planning request." },
    );
  });
});

describe("FeaturesView backend-owned planning controls", () => {
  test("projects active planning as working and blocks compose and refresh", () => {
    seedStores(chatFeature({ planning: planningRecord() }));

    render(<FeaturesView projectId="project-1" />);

    expect(screen.getByText("Codex is working...")).toBeTruthy();
    expect(screen.getByTitle("Send message").hasAttribute("disabled")).toBe(true);
    const refresh = screen.getByTitle("Refresh Codex status");
    expect(refresh.hasAttribute("disabled")).toBe(true);
    fireEvent.click(refresh);
    expect(loadFeaturesMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
  });

  test("shows failed planning recovery and wires retry and stop", async () => {
    seedStores(chatFeature({
      title: "Search feature",
      planning: planningRecord({
        phase: "failed",
        failure: {
          code: "provider",
          message: "Codex bridge disconnected",
          occurredAt: NOW,
          retryPhase: "running",
        },
      }),
    }));

    render(<FeaturesView projectId="project-1" />);

    expect(screen.getByRole("alert").textContent).toContain(
      "Search feature: Codex bridge disconnected",
    );
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(retryPlanningMock).toHaveBeenCalledWith("feature-1"));
    fireEvent.click(screen.getByRole("button", { name: "Stop waiting" }));
    await waitFor(() => expect(cancelPlanningMock).toHaveBeenCalledWith("feature-1"));
  });

  test("reports retry and stop failures from the planning recovery controls", async () => {
    retryPlanningMock.mockResolvedValueOnce(undefined as never);
    cancelPlanningMock.mockResolvedValueOnce(false);
    seedStores(chatFeature({
      planning: planningRecord({
        phase: "failed",
        failure: {
          code: "provider",
          message: "Planning needs attention",
          occurredAt: NOW,
          retryPhase: "running",
        },
      }),
    }));
    render(<FeaturesView projectId="project-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(
      "Feature planning retry failed",
      { description: "The backend refused the retry request." },
    ));

    fireEvent.click(screen.getByRole("button", { name: "Stop waiting" }));
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(
      "Failed to stop feature planning",
      { description: "The backend did not cancel the planning request." },
    ));
  });

  test("refreshes idle planning state and reports refresh failure", async () => {
    seedStores(chatFeature());
    loadFeaturesMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    render(<FeaturesView projectId="project-1" />);

    fireEvent.click(screen.getByTitle("Refresh Codex status"));

    await waitFor(() => expect(loadFeaturesMock).toHaveBeenCalledTimes(2));
    expect(mockToastError).toHaveBeenCalledWith(
      "Failed to refresh feature planning",
      { description: "The latest backend state could not be loaded." },
    );
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
          modelId: "gpt-5.3-codex",
        },
      ],
    });

    expect(screen.getByTestId("native-message-visible").textContent).toBe("Visible reply");
    expect(screen.queryByTestId("native-message-state-only")).toBeNull();
    expect(screen.getByTestId("native-message-second").dataset.previousId).toBe("visible");
    // The panel opts into block-level continuity, so an empty assistant
    // placeholder cannot become a row's attribution anchor.
    expect(
      screen.getByTestId("virtualized-list").dataset.hasPreviousResolver,
    ).toBe("true");
    expect(screen.getByTestId("native-message-second").dataset.modelId).toBe("gpt-5.3-codex");
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

describe("FeaturesView build action", () => {
  test("renders the Build button in the tab header when the feature has stories", () => {
    seedStores(featureWithStories());

    render(<FeaturesView projectId="project-1" />);

    expect(screen.getByRole("button", { name: "Build" })).toBeTruthy();
  });

  test("keeps Build disabled after remount when the feature has a durable reservation", () => {
    seedStores(featureWithStories({
      status: "building",
      buildTaskId: "task-existing",
      buildPipelineId: "pipeline-existing",
    }));

    const first = render(<FeaturesView projectId="project-1" />);
    expect(screen.getByRole("button", { name: "Build" }).hasAttribute("disabled")).toBe(true);
    first.unmount();

    render(<FeaturesView projectId="project-1" />);
    const build = screen.getByRole("button", { name: "Build" });
    expect(build.hasAttribute("disabled")).toBe(true);
    fireEvent.click(build);
    expect(addTaskMock).not.toHaveBeenCalled();
    expect(startBuildMock).not.toHaveBeenCalled();
  });

  test("deletes the losing task when another client owns the feature reservation", async () => {
    const winner = featureWithStories({
      status: "building",
      buildTaskId: "task-winner",
    });
    claimFeatureBuildMock.mockResolvedValueOnce({
      claimed: false,
      feature: winner,
    });
    seedStores(featureWithStories());

    render(<FeaturesView projectId="project-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Build" }));

    await waitFor(() =>
      expect(claimFeatureBuildMock).toHaveBeenCalledWith("feature-1", "task-1"),
    );
    expect(deleteTaskMock).toHaveBeenCalledWith("task-1");
    expect(startBuildMock).not.toHaveBeenCalled();
    expect(mockToastError).toHaveBeenCalledWith(
      "This feature already has an active build",
    );
  });

  test("blocks Build while any project planning turn is active", async () => {
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
        // Backend-owned: the record is on the plan, so it is visible to every
        // client and survives a reload of this one.
        planning: {
          version: 1,
          operationId: "feature-b-running",
          featureId: "feature-b",
          projectId: "project-1",
          kind: "feature",
          userMessage: "please plan",
          phase: "running",
          startedAt: NOW,
          updatedAt: NOW,
          backendRevision: 1,
        },
      }),
    ]);

    render(<FeaturesView projectId="project-1" />);

    fireEvent.click(screen.getByText("Feature A").closest("button")!);
    const build = await screen.findByRole("button", { name: "Build" });
    expect(build.hasAttribute("disabled")).toBe(true);
    fireEvent.click(build);
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
      expect.objectContaining({
        existingEnvironmentId: "env-feature",
        featurePlanId: "feature-1",
      }),
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
    // The pre-launch reservation is durable, but a failed launch must restore
    // the original feature state.
    await waitFor(() => {
      expect(useFeaturePlanStore.getState().features[0]?.status).toBe("stories");
    });
    expect(updateFeatureMock.mock.calls.at(-1)?.[1]).toMatchObject({
      status: "stories",
      buildTaskId: undefined,
      buildPipelineId: undefined,
    });
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
    expect(deleteTaskMock).toHaveBeenCalledWith("task-1");
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
    expect(useFeaturePlanStore.getState().features[0]?.status).toBe("stories");
    expect(updateFeatureMock.mock.calls.at(-1)?.[1]).toMatchObject({
      status: "stories",
    });
  });

  test("leaves the feature unchanged when startBuild creates no pipeline", async () => {
    seedStores(featureWithStories());
    render(<FeaturesView projectId="project-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Build" }));

    await waitFor(() => expect(startBuildMock).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(useFeaturePlanStore.getState().features[0]?.status).toBe("stories");
    });
    expect(updateFeatureMock.mock.calls.at(-1)?.[1]).toMatchObject({
      status: "stories",
    });
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
      expect.objectContaining({
        existingEnvironmentId: undefined,
        featurePlanId: "feature-1",
      }),
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
      expect.objectContaining({
        existingEnvironmentId: undefined,
        featurePlanId: "feature-1",
      }),
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
    updateFeatureMock
      .mockImplementationOnce(async () => undefined);
    render(<FeaturesView projectId="project-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Build" }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(
      "Failed to start feature build",
      { description: "Failed to persist the feature build state" },
    ));
    expect(screen.getByRole("button", { name: "Build" }).hasAttribute("disabled")).toBe(false);
  });
});
