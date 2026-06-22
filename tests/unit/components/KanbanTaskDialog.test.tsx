import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { KanbanTask } from "@/stores/kanbanStore";
import type { Environment } from "@/types";

type KanbanTaskUpdates = Partial<
  Pick<
    KanbanTask,
    | "title"
    | "description"
    | "acceptanceCriteria"
    | "status"
    | "environmentId"
    | "buildPipelineId"
    | "prUrl"
    | "prState"
    | "prMergeCommented"
  >
>;

const toastSuccessMock = mock(() => {});
const toastErrorMock = mock(() => {});
const startBuildMock = mock(async () => {});
const navigateToBuildMock = mock(() => {});
const getKanbanImageDataMock = mock(async () => "");
const detectPrMock = mock(async () => null as { url: string; state: "open" | "merged" | "closed"; hasMergeConflicts: boolean } | null);
const detectPrLocalMock = mock(async () => null as { url: string; state: "open" | "merged" | "closed"; hasMergeConflicts: boolean } | null);
const openInBrowserMock = mock(async () => {});

const addTaskMock = mock(async (_projectId: string, _title: string, _description: string) => "task-created");
const updateTaskMock = mock(async (_taskId: string, _updates: KanbanTaskUpdates) => {});
const deleteTaskMock = mock(async (_taskId: string) => {});
const moveTaskMock = mock(async (_taskId: string, _status: KanbanTask["status"]) => {});
const addCommentMock = mock(async (_taskId: string, _text: string) => {});
const deleteCommentMock = mock(async (_taskId: string, _commentId: string) => {});
const addImageMock = mock(async (_taskId: string, _filename: string, _data: string) => {});
const deleteImageMock = mock(async (_taskId: string, _imageId: string) => {});

mock.module("sonner", () => ({
  toast: {
    success: toastSuccessMock,
    error: toastErrorMock,
  },
}));

// Snapshot-and-restore the narrow app modules we stub so the global Bun module
// cache doesn't leak these fakes into sibling suites that need the real ones.
import * as realUseBuildPipeline from "@/hooks/useBuildPipeline";
import * as realBackend from "@/lib/backend";
import * as realClipboard from "@/lib/native/clipboard";
const realUseBuildPipelineSnapshot = { ...realUseBuildPipeline };
const realBackendSnapshot = { ...realBackend };
const realClipboardSnapshot = { ...realClipboard };

mock.module("@/hooks/useBuildPipeline", () => ({
  ...realUseBuildPipelineSnapshot,
  useBuildPipeline: () => ({
    startBuild: startBuildMock,
    navigateToBuild: navigateToBuildMock,
  }),
}));

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getKanbanImageData: getKanbanImageDataMock,
  detectPr: detectPrMock,
  detectPrLocal: detectPrLocalMock,
  openInBrowser: openInBrowserMock,
}));

mock.module("@/lib/native/clipboard", () => ({
  ...realClipboardSnapshot,
  readImage: mock(async () => {
    throw new Error("no image");
  }),
}));

const { KanbanTaskDialog } = await import("@/components/kanban/KanbanTaskDialog");
const { useKanbanStore } = await import("@/stores/kanbanStore");
const { useEnvironmentStore } = await import("@/stores/environmentStore");
const initialKanbanState = useKanbanStore.getState();
const initialEnvironmentState = useEnvironmentStore.getState();

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

function makeEnvironment(overrides: Partial<Environment> = {}): Environment {
  return {
    id: "env-1",
    projectId: "project-1",
    name: "Environment 1",
    branch: "feature/test",
    containerId: "container-1",
    status: "running",
    prUrl: "https://github.com/org/repo/pull/1",
    prState: "open",
    hasMergeConflicts: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "containerized",
    ...overrides,
  };
}

function installKanbanActionMocks() {
  useKanbanStore.setState({
    tasks: [],
    isLoading: false,
    currentProjectId: null,
    notes: "",
    notesLoading: false,
    currentNotesProjectId: null,
    loadTasks: mock(async () => {}),
    addTask: addTaskMock,
    updateTask: updateTaskMock,
    deleteTask: deleteTaskMock,
    moveTask: moveTaskMock,
    addComment: addCommentMock,
    deleteComment: deleteCommentMock,
    addImage: addImageMock,
    deleteImage: deleteImageMock,
    loadNotes: mock(async () => {}),
    saveNotes: mock(async () => {}),
  });
}

function resetStores() {
  useKanbanStore.setState({
    ...initialKanbanState,
    tasks: [],
    notes: "",
    currentProjectId: null,
    currentNotesProjectId: null,
  });
  useEnvironmentStore.setState({
    ...initialEnvironmentState,
    environments: [],
    workspaceReadyEnvironments: new Set(),
    deletingEnvironments: new Set(),
    pendingSetupCommands: new Map(),
    setupCommandsResolved: new Set(),
    setupScriptsRunning: new Set(),
    sessionActivated: new Set(),
  });
}

function getDialogBody(dialog: HTMLElement = screen.getByRole("dialog")) {
  const scrollAreas = Array.from(dialog.querySelectorAll<HTMLElement>("[data-slot='scroll-area']"));
  const taskBody = scrollAreas.find((node) =>
    node.className.includes("min-h-0") && node.className.includes("flex-1")
  );
  expect(taskBody).toBeTruthy();
  return taskBody!;
}

describe("KanbanTaskDialog", () => {
  beforeEach(() => {
    cleanup();
    toastSuccessMock.mockClear();
    toastErrorMock.mockClear();
    startBuildMock.mockClear();
    navigateToBuildMock.mockClear();
    getKanbanImageDataMock.mockClear();
    getKanbanImageDataMock.mockImplementation(async () => "");
    detectPrMock.mockClear();
    detectPrMock.mockImplementation(async () => null);
    detectPrLocalMock.mockClear();
    detectPrLocalMock.mockImplementation(async () => null);
    openInBrowserMock.mockClear();
    addTaskMock.mockClear();
    addTaskMock.mockImplementation(async () => "task-created");
    updateTaskMock.mockClear();
    updateTaskMock.mockImplementation(async () => {});
    deleteTaskMock.mockClear();
    moveTaskMock.mockClear();
    addCommentMock.mockClear();
    deleteCommentMock.mockClear();
    addImageMock.mockClear();
    deleteImageMock.mockClear();
    resetStores();
    installKanbanActionMocks();
  });

  afterEach(() => {
    cleanup();
    resetStores();
  });

  afterAll(() => {
    mock.module("@/hooks/useBuildPipeline", () => realUseBuildPipelineSnapshot);
    mock.module("@/lib/backend", () => realBackendSnapshot);
    mock.module("@/lib/native/clipboard", () => realClipboardSnapshot);
    mock.restore();
  });

  test("create mode renders an sr-only dialog description", () => {
    render(
      <KanbanTaskDialog
        task={null}
        open
        onOpenChange={() => {}}
        createForProjectId="project-1"
      />,
    );

    const description = screen.getByText(
      "Create a Kanban task with optional acceptance criteria and images.",
    );
    expect(description).toBeTruthy();
    // Radix wires DialogContent's aria-describedby to this node, so it must be
    // present (sr-only) to avoid the missing-description accessibility warning.
    expect(description.className).toContain("sr-only");
  });

  test("edit mode renders an sr-only dialog description", () => {
    render(
      <KanbanTaskDialog task={makeTask()} open onOpenChange={() => {}} />,
    );

    const description = screen.getByText(
      "View and edit task details, build actions, images, and comments.",
    );
    expect(description).toBeTruthy();
    expect(description.className).toContain("sr-only");
  });

  test("edit mode keeps long ticket details inside a scrollable body", () => {
    const longTask = makeTask({
      description: Array.from({ length: 40 }, (_, i) => `Description line ${i + 1}`).join("\n"),
      acceptanceCriteria: Array.from({ length: 40 }, (_, i) => `Acceptance line ${i + 1}`).join("\n"),
    });

    render(
      <KanbanTaskDialog task={longTask} open onOpenChange={() => {}} />,
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog.className).toContain("max-h-[85vh]");
    expect(dialog.className).toContain("overflow-hidden");

    const taskBody = getDialogBody(dialog);
    expect(taskBody.style.overflow).toBe("auto");
    expect(taskBody.textContent).toContain("Acceptance line 40");

    taskBody.scrollTop = 240;
    fireEvent.scroll(taskBody);
    expect(taskBody.scrollTop).toBe(240);
    expect(taskBody.contains(screen.getByPlaceholderText("Add a comment..."))).toBe(false);
  });

  test("create mode keeps long draft details inside a scrollable body", () => {
    const longDescription = Array.from({ length: 40 }, (_, i) => `Draft description ${i + 1}`).join("\n");
    const longAcceptanceCriteria = Array.from({ length: 40 }, (_, i) => `Draft acceptance ${i + 1}`).join("\n");

    render(
      <KanbanTaskDialog
        task={null}
        open
        onOpenChange={() => {}}
        createForProjectId="project-1"
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("Task title..."), {
      target: { value: "Scrollable draft" },
    });
    fireEvent.change(screen.getByPlaceholderText("Description..."), {
      target: { value: longDescription },
    });
    fireEvent.change(screen.getByPlaceholderText("Define what 'done' looks like..."), {
      target: { value: longAcceptanceCriteria },
    });

    const dialog = screen.getByRole("dialog");
    expect(dialog.className).toContain("max-h-[85vh]");
    expect(dialog.className).toContain("overflow-hidden");

    const taskBody = getDialogBody(dialog);
    expect(taskBody.style.overflow).toBe("auto");
    expect((screen.getByPlaceholderText("Description...") as HTMLTextAreaElement).value).toContain("Draft description 40");
    expect((screen.getByPlaceholderText("Define what 'done' looks like...") as HTMLTextAreaElement).value).toContain("Draft acceptance 40");

    taskBody.scrollTop = 180;
    fireEvent.scroll(taskBody);
    expect(taskBody.scrollTop).toBe(180);
    expect(taskBody.contains(screen.getByRole("button", { name: "Create Task" }))).toBe(false);
  });

  test("create mode saves a new task and acceptance criteria", async () => {
    const onOpenChange = mock(() => {});

    render(
      <KanbanTaskDialog
        task={null}
        open
        onOpenChange={onOpenChange}
        createForProjectId="project-1"
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("Task title..."), {
      target: { value: "  New task  " },
    });
    fireEvent.change(screen.getByPlaceholderText("Description..."), {
      target: { value: "  New description  " },
    });
    fireEvent.change(screen.getByPlaceholderText("Define what 'done' looks like..."), {
      target: { value: "  Done means shipped  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    await waitFor(() => {
      expect(addTaskMock).toHaveBeenCalledWith("project-1", "New task", "New description");
      expect(updateTaskMock).toHaveBeenCalledWith("task-created", { acceptanceCriteria: "Done means shipped" });
    });
  });

  test("edit mode saves title, description, and acceptance criteria changes", async () => {
    render(
      <KanbanTaskDialog task={makeTask()} open onOpenChange={() => {}} />,
    );

    fireEvent.click(screen.getByText("Existing task"));
    fireEvent.change(screen.getByDisplayValue("Existing task"), {
      target: { value: "  Updated task  " },
    });
    fireEvent.change(screen.getByPlaceholderText("Description..."), {
      target: { value: "  Updated description  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(updateTaskMock).toHaveBeenCalledWith("task-1", {
      title: "Updated task",
      description: "Updated description",
    });

    fireEvent.click(screen.getByText("Some criteria"));
    fireEvent.change(screen.getByPlaceholderText("Define what 'done' looks like..."), {
      target: { value: "  Updated acceptance criteria  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(updateTaskMock).toHaveBeenCalledWith("task-1", {
      acceptanceCriteria: "Updated acceptance criteria",
    });
  });

  test("comment input adds comments and existing comment delete controls remove comments", () => {
    const task = makeTask({
      comments: [
        {
          id: "comment-1",
          text: "Existing comment",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    render(
      <KanbanTaskDialog task={task} open onOpenChange={() => {}} />,
    );

    fireEvent.change(screen.getByPlaceholderText("Add a comment..."), {
      target: { value: "  New comment  " },
    });
    fireEvent.keyDown(screen.getByPlaceholderText("Add a comment..."), {
      key: "Enter",
    });

    expect(addCommentMock).toHaveBeenCalledWith("task-1", "New comment");

    const existingComment = screen.getByText("Existing comment");
    const deleteButton = existingComment.closest("div")?.querySelector("button");
    expect(deleteButton).toBeTruthy();
    fireEvent.click(deleteButton!);

    expect(deleteCommentMock).toHaveBeenCalledWith("task-1", "comment-1");
  });

  test("renders real comment links and opens them through the backend wrapper", () => {
    render(
      <KanbanTaskDialog
        task={makeTask({
          comments: [
            {
              id: "comment-1",
              text: "Review https://example.com/details",
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        })}
        open
        onOpenChange={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "https://example.com/details" }));

    expect(openInBrowserMock).toHaveBeenCalledWith("https://example.com/details");
  });

  test("loads image thumbnails, opens preview, and deletes images", async () => {
    getKanbanImageDataMock.mockImplementation(async () => "base64-image-data");

    render(
      <KanbanTaskDialog
        task={makeTask({
          images: [
            {
              id: "image-1",
              filename: "attached.png",
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        })}
        open
        onOpenChange={() => {}}
      />,
    );

    await waitFor(() => {
      expect(getKanbanImageDataMock).toHaveBeenCalledWith("image-1");
      expect(screen.getByAltText("attached.png")).toBeTruthy();
    });

    fireEvent.click(screen.getByAltText("attached.png"));
    expect(screen.getAllByAltText("attached.png")).toHaveLength(2);

    const thumbnail = screen.getAllByAltText("attached.png")[0]!;
    const deleteButton = thumbnail.closest("div")?.querySelector("button");
    expect(deleteButton).toBeTruthy();
    fireEvent.click(deleteButton!);

    expect(deleteImageMock).toHaveBeenCalledWith("task-1", "image-1");
  });

  test("create mode attaches selected image files and saves them with the new task", async () => {
    render(
      <KanbanTaskDialog
        task={null}
        open
        onOpenChange={() => {}}
        createForProjectId="project-1"
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("Task title..."), {
      target: { value: "Task with image" },
    });

    const fileInput = document.querySelector<HTMLInputElement>("input[type='file']");
    expect(fileInput).toBeTruthy();
    fireEvent.change(fileInput!, {
      target: {
        files: [
          new File(["image-bytes"], "attached.png", {
            type: "image/png",
          }),
        ],
      },
    });

    await waitFor(() => {
      expect(toastSuccessMock).toHaveBeenCalledWith("Image attached");
      expect(screen.getByAltText("attached.png")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

    await waitFor(() => {
      expect(addTaskMock).toHaveBeenCalledWith("project-1", "Task with image", "");
      expect(addImageMock).toHaveBeenCalledWith("task-created", "attached.png", expect.any(String));
    });
  });

  test("existing task build actions start builds and close the dialog", async () => {
    const onOpenChange = mock(() => {});
    const task = makeTask();

    render(
      <KanbanTaskDialog task={task} open onOpenChange={onOpenChange} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Build Container" }));

    await waitFor(() => {
      expect(startBuildMock).toHaveBeenCalledWith(task, "containerized");
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  test("existing environment build actions require confirmation before starting", async () => {
    const task = makeTask({ environmentId: "env-1" });

    render(
      <KanbanTaskDialog task={task} open onOpenChange={() => {}} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Build Local" }));
    expect(startBuildMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Start Build" }));

    await waitFor(() => {
      expect(startBuildMock).toHaveBeenCalledWith(task, "local");
    });
  });

  test("detects merged pull requests on open and records the merge comment once", async () => {
    detectPrMock.mockImplementation(async () => ({
      url: "https://github.com/org/repo/pull/1",
      state: "merged",
      hasMergeConflicts: false,
    }));
    useEnvironmentStore.setState({
      environments: [makeEnvironment()],
    });

    render(
      <KanbanTaskDialog
        task={makeTask({
          environmentId: "env-1",
          prUrl: "https://github.com/org/repo/pull/1",
          prState: "open",
          prMergeCommented: false,
        })}
        open
        onOpenChange={() => {}}
      />,
    );

    await waitFor(() => {
      expect(detectPrMock).toHaveBeenCalledWith("container-1", "feature/test");
      expect(addCommentMock).toHaveBeenCalledWith("task-1", expect.stringContaining("PR merged"));
      expect(updateTaskMock).toHaveBeenCalledWith("task-1", {
        prState: "merged",
        prMergeCommented: true,
      });
    });
  });

  test("delete task control removes the task and closes the dialog", () => {
    const onOpenChange = mock(() => {});

    render(
      <KanbanTaskDialog task={makeTask()} open onOpenChange={onOpenChange} />,
    );

    const deleteButton = screen.getByRole("dialog").querySelector("button");
    expect(deleteButton).toBeTruthy();
    fireEvent.click(deleteButton!);

    expect(deleteTaskMock).toHaveBeenCalledWith("task-1");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test("renders nothing when closed in edit mode with no task", () => {
    const { container } = render(
      <KanbanTaskDialog task={null} open={false} onOpenChange={() => {}} />,
    );

    expect(container.innerHTML).toBe("");
    expect(
      screen.queryByText(
        "View and edit task details, build actions, images, and comments.",
      ),
    ).toBeNull();
  });
});
