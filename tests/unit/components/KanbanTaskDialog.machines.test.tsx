import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { NodeSummary } from "@orkestrator/protocol/node-summaries";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { appCommandStore } from "../../../apps/web/src/test/app-command-store";
import type { KanbanTask } from "@/stores/kanbanStore";
import { portalStore } from "@/lib/portal/portal-store";

/**
 * The ticket dialog's Machine choice reaches the build: both launchers (an
 * existing ticket's and create-and-build) get the machines the real
 * repository match finds, and a pick on another machine is what `startBuild`
 * receives. The launcher's own behaviour is covered beside it
 * (`BuildLaunchDialog.machines.test.tsx`).
 */

type StartBuild = ReturnType<typeof realUseBuildPipeline.useBuildPipeline>["startBuild"];
const startBuildMock = mock(
  async (..._args: Parameters<StartBuild>): Promise<string | undefined> => "pipeline-1",
);
const addTaskMock = mock(
  async (_projectId: string, _title: string, _description: string): Promise<string | undefined> =>
    "task-created",
);

import * as realUseBuildPipeline from "@/hooks/useBuildPipeline";
import * as realBackend from "@/lib/backend";
const realUseBuildPipelineSnapshot = { ...realUseBuildPipeline };
const realBackendSnapshot = { ...realBackend };

mock.module("@/hooks/useBuildPipeline", () => ({
  ...realUseBuildPipelineSnapshot,
  useBuildPipeline: () => ({ startBuild: startBuildMock, navigateToBuild: mock(() => {}) }),
}));
mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getKanbanImageData: mock(async () => ""),
  getEnvironmentHead: mock(async () => null),
  getCachedOpenCodeModelCatalog: mock(async () => null),
  getComposeDraft: mock(async () => null),
  saveComposeDraft: mock(async () => null),
  deleteComposeDraft: mock(async () => {}),
}));

const { KanbanTaskDialog } = await import("@/components/kanban/KanbanTaskDialog");
const { kanbanStore } = await import("@/stores/kanbanStore");
const { projectStore } = await import("@/stores/projectStore");

const initialKanbanState = appCommandStore(kanbanStore).getState();
const initialProjectState = appCommandStore(projectStore).getState();
const initialPortal = portalStore.store.getState();
const routed = spyOn(portalStore, "invokeOnNode");

/** Another machine holding the same repository, with a checkout there. */
const BUILDER: NodeSummary = {
  nodeId: "node-builder",
  available: true,
  view: { displayName: "Builder" },
  projects: [
    {
      ref: { backendId: "node-builder", projectId: "builder-web" },
      key: "node-builder:builder-web",
      name: "web",
      order: 0,
      repositoryHint: "github.com/acme/web",
      pathName: "web",
    },
  ],
  environments: [],
} as unknown as NodeSummary;

function makeTask(overrides: Partial<KanbanTask> = {}): KanbanTask {
  return {
    id: "task-1",
    projectId: "project-1",
    title: "Existing task",
    description: "A description",
    acceptanceCriteria: "Some criteria",
    status: "backlog",
    order: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    comments: [],
    images: [],
    prUrl: null,
    ...overrides,
  } as KanbanTask;
}

/** Opens the launcher, picks Builder, waits for its Docker answer, starts in a container. */
async function launchOnBuilder() {
  fireEvent.click(screen.getByRole("button", { name: "Build…" }));
  const machines = screen.getByRole("radiogroup", { name: "Machine" });
  fireEvent.click(within(machines).getByRole("radio", { name: /Builder/ }));
  const container = () =>
    within(screen.getByRole("radiogroup", { name: "Where it runs" })).getByRole("radio", {
      name: /^Container/,
    }) as HTMLInputElement;
  await waitFor(() => expect(container().disabled).toBe(false));
  fireEvent.click(container());
  fireEvent.click(screen.getByRole("button", { name: "Start build" }));
}

const builderChoice = {
  machine: "node-builder",
  nodeId: "node-builder",
  projectId: "builder-web",
  name: "Builder",
};

beforeEach(() => {
  cleanup();
  startBuildMock.mockClear();
  startBuildMock.mockResolvedValue("pipeline-1");
  addTaskMock.mockClear();
  routed.mockReset();
  routed.mockImplementation((async (_nodeId: unknown, command: string) =>
    command === "check_docker"
      ? { available: true }
      : undefined) as unknown as typeof portalStore.invokeOnNode);
  portalStore.store.setState({ nodes: [BUILDER] });
  appCommandStore(projectStore).setState({
    projects: [
      {
        id: "project-1",
        name: "Web",
        gitUrl: "https://github.com/acme/web.git",
        localPath: "/work/web",
        addedAt: "2026-08-11T00:00:00.000Z",
        order: 0,
      },
    ],
  });
  appCommandStore(kanbanStore).setState({
    ...initialKanbanState,
    tasks: [],
    addTask: addTaskMock,
    updateTask: mock(async () => {}),
    addImage: mock(async () => {}),
  });
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
  routed.mockRestore();
  portalStore.store.setState(initialPortal, true);
  appCommandStore(projectStore).setState(initialProjectState, true);
  appCommandStore(kanbanStore).setState(initialKanbanState, true);
  mock.module("@/hooks/useBuildPipeline", () => realUseBuildPipelineSnapshot);
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

describe("KanbanTaskDialog machine choice", () => {
  test("an existing ticket's build goes to the picked machine", async () => {
    const task = makeTask();
    renderInAppCommandScope(<KanbanTaskDialog task={task} open onOpenChange={() => {}} />);
    await launchOnBuilder();

    await waitFor(() => expect(startBuildMock).toHaveBeenCalled());
    const [startedTask, environmentType, , options] = startBuildMock.mock.calls[0]!;
    expect(startedTask).toBe(task);
    expect(environmentType).toBe("containerized");
    expect(options?.machine).toEqual(builderChoice);
  });

  test("create-and-build sends the new ticket to the picked machine", async () => {
    const created = makeTask({ id: "task-created", title: "New ticket" });
    addTaskMock.mockImplementationOnce(async () => {
      appCommandStore(kanbanStore).setState({ tasks: [created] });
      return created.id;
    });
    renderInAppCommandScope(
      <KanbanTaskDialog task={null} open onOpenChange={() => {}} createForProjectId="project-1" />,
    );
    fireEvent.change(screen.getByPlaceholderText("Task title..."), {
      target: { value: created.title },
    });
    await launchOnBuilder();

    await waitFor(() => expect(startBuildMock).toHaveBeenCalled());
    const [startedTask, environmentType, , options] = startBuildMock.mock.calls[0]!;
    expect(startedTask.id).toBe("task-created");
    expect(environmentType).toBe("containerized");
    expect(options?.machine).toEqual(builderChoice);
  });

  test("a build on this machine carries no machine", async () => {
    const task = makeTask();
    renderInAppCommandScope(<KanbanTaskDialog task={task} open onOpenChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Build…" }));
    expect(screen.getByRole("radiogroup", { name: "Machine" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start build" }));

    await waitFor(() => expect(startBuildMock).toHaveBeenCalled());
    expect(startBuildMock.mock.calls[0]![3]?.machine).toBeUndefined();
  });
});
