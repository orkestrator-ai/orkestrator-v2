import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import type { KanbanTask } from "@/stores/kanbanStore";

const toastSuccessMock = mock(() => {});
const toastErrorMock = mock(() => {});

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
    startBuild: mock(async () => {}),
    navigateToBuild: mock(() => {}),
  }),
}));

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getKanbanImageData: mock(async () => ""),
  detectPr: mock(async () => null),
  detectPrLocal: mock(async () => null),
  openInBrowser: mock(async () => {}),
}));

mock.module("@/lib/native/clipboard", () => ({
  ...realClipboardSnapshot,
  readImage: mock(async () => {
    throw new Error("no image");
  }),
}));

const { KanbanTaskDialog } = await import("@/components/kanban/KanbanTaskDialog");

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

describe("KanbanTaskDialog accessibility descriptions", () => {
  beforeEach(() => {
    toastSuccessMock.mockClear();
    toastErrorMock.mockClear();
  });

  afterEach(() => {
    cleanup();
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

    const scrollAreas = Array.from(dialog.querySelectorAll<HTMLElement>("[data-slot='scroll-area']"));
    const taskBody = scrollAreas.find((node) =>
      node.className.includes("min-h-0") && node.className.includes("flex-1")
    );

    expect(taskBody).toBeTruthy();
    expect(taskBody?.style.overflow).toBe("auto");
    expect(taskBody?.textContent).toContain("Acceptance line 40");
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
