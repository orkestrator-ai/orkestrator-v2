import { beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { KanbanBoard, canClearTaskBuildStatus } from "@/components/kanban/KanbanBoard";
import { useProjectStore } from "@/stores/projectStore";
import { useKanbanStore } from "@/stores/kanbanStore";
import { useGitHubIssuesStore } from "@/stores/githubIssuesStore";
import { useUIStore } from "@/stores/uiStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import type { KanbanTask } from "@/stores/kanbanStore";
import type { BuildPhase, BuildPipeline } from "@/stores/buildPipelineStore";
import type { Environment } from "@/types";

const loadTasksMock = mock(async () => undefined);
const loadNotesMock = mock(async () => undefined);
const saveNotesMock = mock(async () => undefined);
const loadGitHubIssuesMock = mock(async () => undefined);

beforeEach(() => {
  cleanup();
  loadTasksMock.mockClear();
  loadNotesMock.mockClear();
  saveNotesMock.mockClear();
  loadGitHubIssuesMock.mockClear();
  useProjectStore.setState({
    projects: [
      {
        id: "project-1",
        name: "Project",
        gitUrl: "https://github.com/acme/repo.git",
        localPath: null,
        addedAt: "2026-01-01T00:00:00.000Z",
        order: 0,
      },
    ],
    isLoading: false,
    error: null,
  });
  useKanbanStore.setState({
    tasks: [],
    notes: "",
    loadTasks: loadTasksMock as unknown as ReturnType<typeof useKanbanStore.getState>["loadTasks"],
    loadNotes: loadNotesMock as unknown as ReturnType<typeof useKanbanStore.getState>["loadNotes"],
    saveNotes: saveNotesMock as unknown as ReturnType<typeof useKanbanStore.getState>["saveNotes"],
  });
  useUIStore.setState({
    projectBoardTab: "kanban",
    projectBoardNotesOpen: false,
  });
  useEnvironmentStore.setState({ environments: [] });
  useBuildPipelineStore.setState({ pipelines: new Map(), buildEnvironmentIds: new Set() });
  useGitHubIssuesStore.setState({
    snapshots: new Map([
      [
        "project-1",
        {
          repository: {
            owner: "acme",
            name: "repo",
            fullName: "acme/repo",
            htmlUrl: "https://github.com/acme/repo",
          },
          viewer: { login: "reviewer" },
          issues: [],
        },
      ],
    ]),
    loadingProjects: new Set(),
    projectErrors: new Map(),
    loadIssues: loadGitHubIssuesMock as unknown as ReturnType<
      typeof useGitHubIssuesStore.getState
    >["loadIssues"],
  });
});

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
    createdAt: "2026-01-01T00:00:00.000Z",
    order: 0,
    ...overrides,
  };
}

function makeEnvironment(overrides: Partial<Environment> = {}): Environment {
  return {
    id: "env-1",
    projectId: "project-1",
    name: "attach-images-to",
    branch: "main",
    containerId: "container-1",
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "containerized",
    ...overrides,
  };
}

function makePipeline(overrides: Partial<BuildPipeline> = {}): BuildPipeline {
  return {
    id: "pipeline-1",
    taskId: "task-1",
    projectId: "project-1",
    environmentId: "env-1",
    environmentType: "local",
    agentType: "codex",
    phase: "building",
    sessions: [],
    currentSessionIndex: -1,
    iteration: 0,
    maxIterations: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
    taskTitle: "Task",
    taskSnapshot: {
      title: "Task",
      description: "",
      acceptanceCriteria: "",
      comments: [],
      images: [],
    },
    source: { type: "kanban", taskId: "task-1" },
    backendRevision: 1,
    controller: "backend",
    ...overrides,
  };
}

describe("canClearTaskBuildStatus", () => {
  test("is false for a plain task with no links or build phase", () => {
    expect(canClearTaskBuildStatus(makeTask(), undefined)).toBe(false);
  });

  test("is true when the task has a leftover environment link and no build phase", () => {
    expect(canClearTaskBuildStatus(makeTask({ environmentId: "env-1" }), undefined)).toBe(true);
  });

  test("is true when the task has a leftover pipeline link and no build phase", () => {
    expect(canClearTaskBuildStatus(makeTask({ buildPipelineId: "pipeline-1" }), undefined)).toBe(
      true,
    );
  });

  test.each<BuildPhase>(["complete", "failed", "paused"])(
    "is true for the terminal/paused phase %s",
    (phase) => {
      expect(canClearTaskBuildStatus(makeTask({ environmentId: "env-1" }), phase)).toBe(true);
    },
  );

  test.each<BuildPhase>([
    "creating-environment",
    "starting-environment",
    "waiting-for-setup",
    "building",
    "reviewing",
    "addressing",
    "verifying",
    "fixing",
    "creating-pr",
    "resolving-conflicts",
  ])("is false while actively building (phase %s) even with links", (phase) => {
    expect(
      canClearTaskBuildStatus(makeTask({ environmentId: "env-1", buildPipelineId: "p-1" }), phase),
    ).toBe(false);
  });
});

describe("KanbanBoard ticket sources", () => {
  test("renders the kanban board content for a project board", async () => {
    render(<KanbanBoard projectId="project-1" />);

    expect(screen.getByText("Backlog")).toBeTruthy();
    expect(screen.getByText("In Progress")).toBeTruthy();
    await waitFor(() => {
      expect(loadTasksMock).toHaveBeenCalledWith("project-1");
    });
  });

  test("renders the project notes view instead of the board when notes are open", () => {
    useUIStore.setState({ projectBoardTab: "kanban", projectBoardNotesOpen: true });

    render(<KanbanBoard projectId="project-1" />);

    // Board columns are replaced by the notes view.
    expect(screen.queryByText("Backlog") === null).toBe(true);
    expect(screen.getByText("Project Notes")).toBeTruthy();
    expect(loadNotesMock).toHaveBeenCalledWith("project-1");
  });

  test("mounts the GitHub issues view for the GitHub project-board tab", async () => {
    useUIStore.setState({ projectBoardTab: "github", projectBoardNotesOpen: false });

    render(<KanbanBoard projectId="project-1" />);

    expect(screen.getByText("acme/repo")).toBeTruthy();
    expect(screen.getByText("No open issues")).toBeTruthy();
    await waitFor(() => {
      expect(loadGitHubIssuesMock).toHaveBeenCalledWith("project-1");
    });
  });
});

describe("KanbanBoard environment labels", () => {
  test("labels a card with the name of the environment its task links to", () => {
    useKanbanStore.setState({ tasks: [makeTask({ environmentId: "env-1" })] });
    useEnvironmentStore.setState({ environments: [makeEnvironment()] });

    render(<KanbanBoard projectId="project-1" />);

    expect(screen.getByText("attach-images-to")).toBeTruthy();
  });

  test("falls back to the pipeline's environment before the task link is written", () => {
    // A build creates its environment before the task row records the link, so
    // the pipeline is the only place the id lives during that window.
    useKanbanStore.setState({ tasks: [makeTask()] });
    useEnvironmentStore.setState({
      environments: [makeEnvironment({ id: "env-2", name: "fix-provider-icons" })],
    });
    useBuildPipelineStore.setState({
      pipelines: new Map([["pipeline-1", makePipeline({ environmentId: "env-2" })]]),
      buildEnvironmentIds: new Set(["env-2"]),
    });

    render(<KanbanBoard projectId="project-1" />);

    expect(screen.getByText("fix-provider-icons")).toBeTruthy();
  });

  test("prefers the task's environment when its pipeline points somewhere else", () => {
    useKanbanStore.setState({ tasks: [makeTask({ environmentId: "env-1" })] });
    useEnvironmentStore.setState({
      environments: [
        makeEnvironment(),
        makeEnvironment({ id: "env-2", name: "pipeline-environment" }),
      ],
    });
    useBuildPipelineStore.setState({
      pipelines: new Map([["pipeline-1", makePipeline({ environmentId: "env-2" })]]),
      buildEnvironmentIds: new Set(["env-2"]),
    });

    render(<KanbanBoard projectId="project-1" />);

    expect(screen.getByText("attach-images-to")).toBeTruthy();
    expect(screen.queryByText("pipeline-environment") === null).toBe(true);
  });

  test("ignores pipeline environment links from another project", () => {
    useKanbanStore.setState({ tasks: [makeTask()] });
    useEnvironmentStore.setState({ environments: [makeEnvironment()] });
    useBuildPipelineStore.setState({
      pipelines: new Map([
        ["pipeline-1", makePipeline({ projectId: "project-2", environmentId: "env-1" })],
      ]),
      buildEnvironmentIds: new Set(["env-1"]),
    });

    render(<KanbanBoard projectId="project-1" />);

    expect(screen.queryByText("attach-images-to") === null).toBe(true);
  });

  test("shows no environment label when the linked environment is gone", () => {
    useKanbanStore.setState({ tasks: [makeTask({ environmentId: "env-deleted" })] });
    useEnvironmentStore.setState({ environments: [makeEnvironment()] });

    render(<KanbanBoard projectId="project-1" />);

    expect(screen.queryByText("attach-images-to") === null).toBe(true);
  });
});
