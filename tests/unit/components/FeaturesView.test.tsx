import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import * as realVirtualizedMessageList from "@/components/chat/VirtualizedMessageList";
import * as realNativeComposeDock from "@/components/chat/NativeComposeDock";
import * as realNativeMessage from "@/components/chat/NativeMessage";
import * as realUseBuildPipeline from "@/hooks/useBuildPipeline";
import * as realUseEnvironments from "@/hooks/useEnvironments";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { useFeaturePlanStore } from "@/stores/featurePlanStore";
import { useKanbanStore } from "@/stores/kanbanStore";
import { useProjectStore } from "@/stores/projectStore";
import type { FeaturePlan, FeatureStoryCard } from "@/lib/backend";
import type { KanbanTask } from "@/stores/kanbanStore";

const realVirtualizedMessageListSnapshot = { ...realVirtualizedMessageList };
const realNativeComposeDockSnapshot = { ...realNativeComposeDock };
const realNativeMessageSnapshot = { ...realNativeMessage };
const realUseBuildPipelineSnapshot = { ...realUseBuildPipeline };
const realUseEnvironmentsSnapshot = { ...realUseEnvironments };

const startBuildMock = mock(async () => undefined);
const addTaskMock = mock(async (_projectId: string, _title: string, _description: string) => "task-1");
const updateTaskMock = mock(async () => undefined);
const updateFeatureMock = mock(async (_id: string, updates: Partial<FeaturePlan>) => ({
  ...featureWithStories(),
  ...updates,
}));
const loadFeaturesMock = mock(async () => undefined);

// Stub the heavy chat children so the (briefly-rendered) chat tab is cheap to mount.
mock.module("@/components/chat/VirtualizedMessageList", () => ({
  VirtualizedMessageList: () => <div data-testid="virtualized-list" />,
}));
mock.module("@/components/chat/NativeComposeDock", () => ({
  NativeComposeDock: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
mock.module("@/components/chat/NativeMessage", () => ({
  NativeMessage: () => null,
}));

mock.module("@/hooks/useBuildPipeline", () => ({
  useBuildPipeline: () => ({ startBuild: startBuildMock }),
}));
mock.module("@/hooks/useEnvironments", () => ({
  useEnvironments: () => ({
    createEnvironment: mock(async () => ({})),
    startEnvironment: mock(async () => ({})),
  }),
}));

const { FeaturesView } = await import("@/components/kanban/FeaturesView");

afterAll(() => {
  mock.module("@/components/chat/VirtualizedMessageList", () => realVirtualizedMessageListSnapshot);
  mock.module("@/components/chat/NativeComposeDock", () => realNativeComposeDockSnapshot);
  mock.module("@/components/chat/NativeMessage", () => realNativeMessageSnapshot);
  mock.module("@/hooks/useBuildPipeline", () => realUseBuildPipelineSnapshot);
  mock.module("@/hooks/useEnvironments", () => realUseEnvironmentsSnapshot);
});

const NOW = "2026-01-01T00:00:00.000Z";

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
    updateFeature: updateFeatureMock as unknown as ReturnType<typeof useFeaturePlanStore.getState>["updateFeature"],
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
  useBuildPipelineStore.setState({ pipelines: new Map(), buildEnvironmentIds: new Set() });
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
});
