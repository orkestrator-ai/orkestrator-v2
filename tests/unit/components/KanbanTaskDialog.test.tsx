import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { KanbanTask } from "@/stores/kanbanStore";
import type { Environment } from "@/types";
import {
  mockToastError as toastErrorMock,
  mockToastSuccess as toastSuccessMock,
} from "../../mocks/sonner";

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

const startBuildMock = mock(async () => {});
const navigateToBuildMock = mock(() => {});
const getKanbanImageDataMock = mock(async () => "");
const detectPrMock = mock(async () => null as { url: string; state: "open" | "merged" | "closed"; hasMergeConflicts: boolean } | null);
const detectPrLocalMock = mock(async () => null as { url: string; state: "open" | "merged" | "closed"; hasMergeConflicts: boolean } | null);
const openInBrowserMock = mock(async () => {});
const readImageMock = mock(async () => {
  throw new Error("no image");
});

const addTaskMock = mock(async (_projectId: string, _title: string, _description: string) => "task-created");
const updateTaskMock = mock(async (_taskId: string, _updates: KanbanTaskUpdates) => {});
const deleteTaskMock = mock(async (_taskId: string) => {});
const moveTaskMock = mock(async (_taskId: string, _status: KanbanTask["status"]) => {});
const addCommentMock = mock(async (_taskId: string, _text: string) => {});
const deleteCommentMock = mock(async (_taskId: string, _commentId: string) => {});
const addImageMock = mock(async (_taskId: string, _filename: string, _data: string) => {});
const deleteImageMock = mock(async (_taskId: string, _imageId: string) => {});

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
  readImage: readImageMock,
}));

const { KanbanTaskDialog } = await import("@/components/kanban/KanbanTaskDialog");
const { useKanbanStore } = await import("@/stores/kanbanStore");
const { useEnvironmentStore } = await import("@/stores/environmentStore");
const initialKanbanState = useKanbanStore.getState();
const initialEnvironmentState = useEnvironmentStore.getState();
const originalGetContext = HTMLCanvasElement.prototype.getContext;
const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
const originalReadAsDataURL = FileReader.prototype.readAsDataURL;
const originalConsoleWarn = console.warn;
const putImageDataMock = mock(() => {});

if (typeof globalThis.ImageData === "undefined") {
  (globalThis as Record<string, unknown>).ImageData = class ImageData {
    constructor(
      public data: Uint8ClampedArray,
      public width: number,
      public height: number,
    ) {}
  };
}

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
    readImageMock.mockClear();
    readImageMock.mockImplementation(async () => {
      throw new Error("no image");
    });
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
    putImageDataMock.mockClear();
    HTMLCanvasElement.prototype.getContext = (() => ({
      putImageData: putImageDataMock,
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.toDataURL = (() =>
      "data:image/png;base64,QUJD") as typeof HTMLCanvasElement.prototype.toDataURL;
  });

  afterEach(() => {
    cleanup();
    resetStores();
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    HTMLCanvasElement.prototype.toDataURL = originalToDataURL;
    FileReader.prototype.readAsDataURL = originalReadAsDataURL;
    console.warn = originalConsoleWarn;
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

  test("edit mode cancel controls discard title and acceptance-criteria edits", () => {
    render(
      <KanbanTaskDialog
        task={makeTask({ description: "", acceptanceCriteria: "" })}
        open
        onOpenChange={() => {}}
      />,
    );

    expect(screen.getByText("Click to add a description...")).toBeTruthy();
    fireEvent.click(screen.getByText("Existing task"));
    fireEvent.change(screen.getByDisplayValue("Existing task"), {
      target: { value: "Discarded title" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(updateTaskMock).not.toHaveBeenCalled();
    expect(screen.getByText("Existing task")).toBeTruthy();

    fireEvent.click(screen.getByText("Click to add acceptance criteria..."));
    fireEvent.change(screen.getByPlaceholderText("Define what 'done' looks like..."), {
      target: { value: "Discarded criteria" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(updateTaskMock).not.toHaveBeenCalled();
    expect(screen.getByText("Click to add acceptance criteria...")).toBeTruthy();
  });

  test("pressing Enter in the create title submits the task", async () => {
    render(
      <KanbanTaskDialog task={null} open onOpenChange={() => {}} createForProjectId="project-1" />,
    );
    const title = screen.getByPlaceholderText("Task title...");
    fireEvent.change(title, { target: { value: "Keyboard task" } });
    fireEvent.keyDown(title, { key: "Enter" });

    await waitFor(() => {
      expect(addTaskMock).toHaveBeenCalledWith("project-1", "Keyboard task", "");
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

  test("rejects non-image and oversized attachments", async () => {
    render(
      <KanbanTaskDialog task={null} open onOpenChange={() => {}} createForProjectId="project-1" />,
    );
    const fileInput = document.querySelector<HTMLInputElement>("input[type='file']")!;
    fireEvent.change(fileInput, {
      target: { files: [new File(["text"], "notes.txt", { type: "text/plain" })] },
    });
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith("Only image files are supported"));

    toastErrorMock.mockClear();
    const oversized = new File(["x"], "large.png", { type: "image/png" });
    Object.defineProperty(oversized, "size", { value: 5 * 1024 * 1024 + 1 });
    fireEvent.change(fileInput, { target: { files: [oversized] } });
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith("Image is too large (max 5 MB)"));
    expect(screen.queryByAltText("notes.txt")).toBeNull();
    expect(screen.queryByAltText("large.png")).toBeNull();
  });

  test("reports file-reader failures and resets the file input", async () => {
    FileReader.prototype.readAsDataURL = function () {
      this.onerror?.(new ProgressEvent("error"));
    } as typeof FileReader.prototype.readAsDataURL;
    render(
      <KanbanTaskDialog task={null} open onOpenChange={() => {}} createForProjectId="project-1" />,
    );
    const fileInput = document.querySelector<HTMLInputElement>("input[type='file']")!;

    fireEvent.change(fileInput, {
      target: { files: [new File(["image"], "broken.png", { type: "image/png" })] },
    });

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith("Failed to read image file");
    });
    expect(screen.queryByAltText("broken.png")).toBeNull();
    expect(fileInput.value).toBe("");
  });

  test("attach control opens the hidden image picker", () => {
    render(
      <KanbanTaskDialog task={null} open onOpenChange={() => {}} createForProjectId="project-1" />,
    );
    const fileInput = document.querySelector<HTMLInputElement>("input[type='file']")!;
    const click = mock(() => {});
    fileInput.click = click;

    fireEvent.click(screen.getByTitle("Attach image"));

    expect(click).toHaveBeenCalledTimes(1);
  });

  test("selected image files attach directly to an existing task", async () => {
    render(
      <KanbanTaskDialog task={makeTask()} open onOpenChange={() => {}} />,
    );
    const fileInput = document.querySelector<HTMLInputElement>("input[type='file']")!;
    fireEvent.change(fileInput, {
      target: { files: [new File(["image"], "existing.png", { type: "image/png" })] },
    });

    await waitFor(() => {
      expect(addImageMock).toHaveBeenCalledWith("task-1", "existing.png", expect.any(String));
      expect(toastSuccessMock).toHaveBeenCalledWith("Image attached");
    });
  });

  test("reports failed image persistence after creating a task", async () => {
    addImageMock.mockRejectedValueOnce(new Error("disk full"));
    render(
      <KanbanTaskDialog task={null} open onOpenChange={() => {}} createForProjectId="project-1" />,
    );
    fireEvent.change(screen.getByPlaceholderText("Task title..."), { target: { value: "Image failure" } });
    const fileInput = document.querySelector<HTMLInputElement>("input[type='file']")!;
    fireEvent.change(fileInput, {
      target: { files: [new File(["image"], "failure.png", { type: "image/png" })] },
    });
    await screen.findByAltText("failure.png");
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith("Failed to save 1 image"));
  });

  test("removes a pending image before creating the task", async () => {
    render(
      <KanbanTaskDialog task={null} open onOpenChange={() => {}} createForProjectId="project-1" />,
    );
    const fileInput = document.querySelector<HTMLInputElement>("input[type='file']")!;
    fireEvent.change(fileInput, {
      target: { files: [new File(["image"], "remove-me.png", { type: "image/png" })] },
    });
    const thumbnail = await screen.findByAltText("remove-me.png");
    const removeButton = thumbnail.closest("div")?.querySelector("button");
    expect(removeButton).toBeTruthy();
    fireEvent.click(removeButton!);

    expect(screen.queryByAltText("remove-me.png")).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("Task title..."), {
      target: { value: "No image task" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
    await waitFor(() => expect(addTaskMock).toHaveBeenCalled());
    expect(addImageMock).not.toHaveBeenCalled();
  });

  test("reports when task creation for a build returns no id", async () => {
    addTaskMock.mockImplementationOnce(async () => "");
    render(
      <KanbanTaskDialog task={null} open onOpenChange={() => {}} createForProjectId="project-1" />,
    );
    fireEvent.change(screen.getByPlaceholderText("Task title..."), {
      target: { value: "Failed creation" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Build Container" }));

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith("Failed to create task"));
    expect(startBuildMock).not.toHaveBeenCalled();
  });

  test("continues a build when acceptance criteria persistence fails", async () => {
    const createdTask = makeTask({ id: "task-created", title: "Partial build task" });
    addTaskMock.mockImplementationOnce(async () => {
      useKanbanStore.setState({ tasks: [createdTask] });
      return createdTask.id;
    });
    updateTaskMock.mockRejectedValueOnce(new Error("storage unavailable"));
    render(
      <KanbanTaskDialog task={null} open onOpenChange={() => {}} createForProjectId="project-1" />,
    );
    fireEvent.change(screen.getByPlaceholderText("Task title..."), {
      target: { value: createdTask.title },
    });
    fireEvent.change(screen.getByPlaceholderText("Define what 'done' looks like..."), {
      target: { value: "Persist this" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Build Local" }));

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(
        "Task created but acceptance criteria could not be saved",
      );
      expect(startBuildMock).toHaveBeenCalledWith(createdTask, "local");
    });
  });

  test("reports when a newly created task cannot be found for building", async () => {
    render(
      <KanbanTaskDialog task={null} open onOpenChange={() => {}} createForProjectId="project-1" />,
    );
    fireEvent.change(screen.getByPlaceholderText("Task title..."), { target: { value: "Missing build task" } });
    fireEvent.click(screen.getByRole("button", { name: "Build Container" }));
    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith("Task created but could not start build");
    });
    expect(startBuildMock).not.toHaveBeenCalled();
  });

  test("creates a task and starts its local build", async () => {
    const createdTask = makeTask({ id: "task-created", title: "Created build task" });
    addTaskMock.mockImplementationOnce(async () => {
      useKanbanStore.setState({ tasks: [createdTask] });
      return createdTask.id;
    });
    render(
      <KanbanTaskDialog task={null} open onOpenChange={() => {}} createForProjectId="project-1" />,
    );
    fireEvent.change(screen.getByPlaceholderText("Task title..."), { target: { value: createdTask.title } });
    fireEvent.click(screen.getByRole("button", { name: "Build Local" }));
    await waitFor(() => expect(startBuildMock).toHaveBeenCalledWith(createdTask, "local"));
  });

  test("create mode attaches a pasted clipboard image with a generated UUID", async () => {
    readImageMock.mockImplementation(async () => ({
      rgba: async () => new Uint8Array([255, 0, 0, 255]),
      size: async () => ({ width: 1, height: 1 }),
    }));

    render(
      <KanbanTaskDialog
        task={null}
        open
        onOpenChange={() => {}}
        createForProjectId="project-1"
      />,
    );

    const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
    document.dispatchEvent(pasteEvent);

    await waitFor(() => {
      expect(readImageMock).toHaveBeenCalledTimes(1);
      expect(screen.getByAltText(/^clipboard-.*\.png$/)).toBeTruthy();
      expect(toastSuccessMock).toHaveBeenCalledWith("Image pasted");
    });
    expect(pasteEvent.defaultPrevented).toBe(true);

    fireEvent.change(screen.getByPlaceholderText("Task title..."), {
      target: { value: "Pasted image task" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

    await waitFor(() => {
      expect(addImageMock).toHaveBeenCalledWith(
        "task-created",
        expect.stringMatching(/^clipboard-.*\.png$/),
        expect.any(String),
      );
    });
  });

  test("uses an image supplied by the browser paste event", async () => {
    const pastedFile = new File(["browser-image"], "browser.png", { type: "image/png" });
    readImageMock.mockImplementation(async () => ({
      rgba: async () => new Uint8Array([255, 0, 0, 255]),
      size: async () => ({ width: 1, height: 1 }),
    }));
    render(
      <KanbanTaskDialog task={null} open onOpenChange={() => {}} createForProjectId="project-1" />,
    );
    const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, "clipboardData", {
      value: {
        items: [{ kind: "file", type: "image/png", getAsFile: () => pastedFile }],
        files: [],
      },
    });

    document.dispatchEvent(pasteEvent);

    await waitFor(() => {
      expect(readImageMock).toHaveBeenCalledWith(pastedFile);
      expect(screen.getByAltText(/^clipboard-.*\.png$/)).toBeTruthy();
    });
    expect(pasteEvent.defaultPrevented).toBe(true);
  });

  test("paste exits cleanly when canvas creation or encoding fails", async () => {
    readImageMock.mockImplementation(async () => ({
      rgba: async () => new Uint8Array([255, 0, 0, 255]),
      size: async () => ({ width: 1, height: 1 }),
    }));
    HTMLCanvasElement.prototype.getContext = (() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    render(
      <KanbanTaskDialog task={null} open onOpenChange={() => {}} createForProjectId="project-1" />,
    );
    document.dispatchEvent(new Event("paste", { bubbles: true, cancelable: true }));
    await waitFor(() => expect(readImageMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByAltText(/^clipboard-.*\.png$/)).toBeNull();
    expect(toastSuccessMock).not.toHaveBeenCalled();

    cleanup();
    readImageMock.mockClear();
    HTMLCanvasElement.prototype.getContext = (() => ({
      putImageData: putImageDataMock,
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.toDataURL = (() => "data:image/png;base64,") as typeof HTMLCanvasElement.prototype.toDataURL;
    render(
      <KanbanTaskDialog task={null} open onOpenChange={() => {}} createForProjectId="project-1" />,
    );
    document.dispatchEvent(new Event("paste", { bubbles: true, cancelable: true }));
    await waitFor(() => expect(readImageMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByAltText(/^clipboard-.*\.png$/)).toBeNull();
    expect(toastSuccessMock).not.toHaveBeenCalled();
  });

  test("rejects an oversized encoded clipboard image", async () => {
    readImageMock.mockImplementation(async () => ({
      rgba: async () => new Uint8Array([255, 0, 0, 255]),
      size: async () => ({ width: 1, height: 1 }),
    }));
    HTMLCanvasElement.prototype.toDataURL = (() =>
      `data:image/png;base64,${"A".repeat(7 * 1024 * 1024)}`) as typeof HTMLCanvasElement.prototype.toDataURL;
    render(
      <KanbanTaskDialog task={null} open onOpenChange={() => {}} createForProjectId="project-1" />,
    );

    document.dispatchEvent(new Event("paste", { bubbles: true, cancelable: true }));

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith("Image is too large (max 5 MB)");
    });
    expect(screen.queryByAltText(/^clipboard-.*\.png$/)).toBeNull();
  });

  test("pasted clipboard images attach directly to an existing task", async () => {
    readImageMock.mockImplementation(async () => ({
      rgba: async () => new Uint8Array([255, 0, 0, 255]),
      size: async () => ({ width: 1, height: 1 }),
    }));
    render(<KanbanTaskDialog task={makeTask()} open onOpenChange={() => {}} />);

    document.dispatchEvent(new Event("paste", { bubbles: true, cancelable: true }));

    await waitFor(() => {
      expect(addImageMock).toHaveBeenCalledWith(
        "task-1",
        expect.stringMatching(/^clipboard-.*\.png$/),
        "QUJD",
      );
      expect(toastSuccessMock).toHaveBeenCalledWith("Image pasted");
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

    fireEvent.click(screen.getByRole("button", { name: "Build Container" }));
    expect(startBuildMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Start Build" }));

    await waitFor(() => {
      expect(startBuildMock).toHaveBeenCalledWith(task, "containerized");
    });

    startBuildMock.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Build Local" }));
    expect(startBuildMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Start Build" }));
    await waitFor(() => {
      expect(startBuildMock).toHaveBeenCalledWith(task, "local");
    });
  });

  test("view build navigates to the linked environment and closes the dialog", () => {
    const onOpenChange = mock(() => {});
    const task = makeTask({ environmentId: "env-1" });
    render(<KanbanTaskDialog task={task} open onOpenChange={onOpenChange} />);

    fireEvent.click(screen.getByRole("button", { name: /View Build/ }));

    expect(navigateToBuildMock).toHaveBeenCalledWith(task);
    expect(onOpenChange).toHaveBeenCalledWith(false);
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

  test("detects closed pull requests for local environments", async () => {
    detectPrLocalMock.mockImplementation(async () => ({
      url: "https://github.com/org/repo/pull/2",
      state: "closed",
      hasMergeConflicts: false,
    }));
    useEnvironmentStore.setState({
      environments: [makeEnvironment({
        id: "local-env",
        environmentType: "local",
        containerId: undefined,
        worktreePath: "/tmp/worktree",
        branch: "feature/local",
      })],
    });
    render(
      <KanbanTaskDialog
        task={makeTask({
          environmentId: "local-env",
          prUrl: "https://github.com/org/repo/pull/2",
          prState: "open",
          prMergeCommented: false,
        })}
        open
        onOpenChange={() => {}}
      />,
    );

    await waitFor(() => {
      expect(detectPrLocalMock).toHaveBeenCalledWith("local-env", "feature/local");
      expect(addCommentMock).toHaveBeenCalledWith("task-1", "❌ PR closed");
      expect(updateTaskMock).toHaveBeenCalledWith("task-1", {
        prState: "closed",
        prMergeCommented: true,
      });
    });
  });

  test("logs and contains PR lookup failures", async () => {
    const warn = mock(() => {});
    console.warn = warn;
    detectPrMock.mockRejectedValueOnce(new Error("lookup failed"));
    useEnvironmentStore.setState({ environments: [makeEnvironment()] });
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
      expect(warn).toHaveBeenCalledWith(
        "[KanbanTaskDialog] Failed to check PR state on dialog open:",
        expect.any(Error),
      );
    });
    expect(updateTaskMock).not.toHaveBeenCalled();
    expect(addCommentMock).not.toHaveBeenCalled();
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
