import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { captureLogs, type LogCapture } from "@orkestrator/protocol/testing/log-capture";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { appCommandStore } from "../../../apps/web/src/test/app-command-store";
import type { KanbanTask } from "@/stores/kanbanStore";
import { mockToastError as toastErrorMock } from "../../mocks/sonner";

/**
 * The ticket view's tabs (`KanbanTaskDialog`, `ticket-view/`): which tab a
 * ticket opens on, the Notes tab's availability, each tab's section index and
 * its action bar that stays above the scrolling column, and which actions
 * that bar enables. The ticket text, editing, comments, images and the build
 * launcher are covered in `KanbanTaskDialog.test.tsx`.
 */

const startBuildMock = mock(async () => "pipeline-1" as string | undefined);
const navigateToBuildMock = mock(() => {});
const mergeEnvironmentPrMock = mock(async () => ({ outcome: "merged" as const }));

import * as realUseBuildPipeline from "@/hooks/useBuildPipeline";
import * as realBackend from "@/lib/backend";
const realUseBuildPipelineSnapshot = { ...realUseBuildPipeline };
const realBackendSnapshot = { ...realBackend };

mock.module("@/hooks/useBuildPipeline", () => ({
  ...realUseBuildPipelineSnapshot,
  useBuildPipeline: () => ({ startBuild: startBuildMock, navigateToBuild: navigateToBuildMock }),
}));
mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getKanbanImageData: mock(async () => ""),
  getEnvironmentHead: mock(async () => null),
  getCachedOpenCodeModelCatalog: mock(async () => null),
  mergeEnvironmentPr: mergeEnvironmentPrMock,
}));

const { KanbanTaskDialog } = await import("@/components/kanban/KanbanTaskDialog");
const { kanbanStore } = await import("@/stores/kanbanStore");
const { environmentStore } = await import("@/stores/environmentStore");
const { buildPipelineStore } = await import("@/stores/buildPipelineStore");
const { prMonitorStore } = await import("@/stores/prMonitorStore");
const { buildPipelineFixture } = await import("@/test/build-pipeline-fixture");
const { keyInformation } = await import("@/components/build-pipeline/key-information-test-fixture");

const initialEnvironmentState = appCommandStore(environmentStore).getState();
const initialKanbanState = appCommandStore(kanbanStore).getState();
const PR_URL = "https://github.com/o/r/pull/42";

function makeTask(overrides: Partial<KanbanTask> = {}): KanbanTask {
  return {
    id: "task-1",
    projectId: "project-1",
    title: "Tabbed ticket",
    description: "A description",
    acceptanceCriteria: "- Works",
    status: "backlog",
    order: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    comments: [{ id: "c1", text: "🔨 Build started", createdAt: "2026-01-01T00:00:00.000Z" }],
    images: [],
    ...overrides,
  } as KanbanTask;
}

/** A finished build of task-1 with Notes, in env-1. */
function withNotes() {
  appCommandStore(buildPipelineStore)
    .getState()
    .replacePipeline(
      buildPipelineFixture({
        id: "pipeline-1",
        taskId: "task-1",
        phase: "complete",
        backendRevision: 3,
        keyInformation,
      }),
    );
}

/** env-1's pull request, open, as GitHub reports it; `ready` makes it mergeable now. */
function withPullRequest(ready: boolean) {
  appCommandStore(environmentStore).setState({
    environments: [
      {
        id: "env-1",
        projectId: "project-1",
        name: "build",
        branch: "build",
        status: "running",
        environmentType: "local",
        prUrl: PR_URL,
        prState: "open",
        hasMergeConflicts: false,
        prMergeability: ready ? "clean" : "unavailable",
      } as never,
    ],
  });
  const store = appCommandStore(prMonitorStore);
  store.setState({
    syncStatus: "current",
    states: new Map([
      [
        "env-1",
        {
          environmentId: "env-1",
          mode: "normal",
          checkInProgress: false,
          consecutiveErrors: 0,
          lastCheckAt: "2026-01-01T00:00:00.000Z",
          lastSuccessfulCheckAt: "2026-01-01T00:00:00.000Z",
          prUrl: PR_URL,
          prState: "open",
          hasMergeConflicts: false,
          checkSummary: { passed: 3, total: 3, pending: 0 },
        } as never,
      ],
    ]),
  });
}

function tab(name: "Ticket" | "Notes") {
  return screen.getByRole("tab", { name });
}

describe("the ticket view's tabs", () => {
  let logs: LogCapture;

  beforeEach(() => {
    logs = captureLogs();
    cleanup();
    startBuildMock.mockClear();
    navigateToBuildMock.mockClear();
    mergeEnvironmentPrMock.mockClear();
    toastErrorMock.mockClear();
    appCommandStore(kanbanStore).setState({ ...initialKanbanState, tasks: [] });
    appCommandStore(environmentStore).setState({ ...initialEnvironmentState, environments: [] });
    appCommandStore(buildPipelineStore).setState({
      pipelines: new Map(),
      buildEnvironmentIds: new Set(),
    });
    appCommandStore(prMonitorStore).setState({ states: new Map(), syncStatus: "idle" });
  });

  afterEach(() => {
    cleanup();
    logs.restore();
  });

  afterAll(() => {
    mock.module("@/hooks/useBuildPipeline", () => realUseBuildPipelineSnapshot);
    mock.module("@/lib/backend", () => realBackendSnapshot);
    mock.restore();
  });

  test("are a tablist, Ticket first and Notes second", () => {
    withNotes();
    renderInAppCommandScope(<KanbanTaskDialog task={makeTask()} open onOpenChange={() => {}} />);
    const list = screen.getByRole("tablist", { name: "Ticket view" });
    // Keyboard users start on the selected tab, never on Delete.
    expect(document.activeElement).toBe(tab("Ticket"));
    expect(
      within(list)
        .getAllByRole("tab")
        .map((node) => node.textContent),
    ).toEqual(["Ticket", "Notes"]);
  });

  test("a ticket opened from Review with Notes opens on Notes", () => {
    withNotes();
    renderInAppCommandScope(
      <KanbanTaskDialog
        task={makeTask({ status: "review", buildPipelineId: "pipeline-1" })}
        open
        onOpenChange={() => {}}
        openedFrom="review"
      />,
    );
    expect(tab("Notes").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("ticket-notes-tab")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Key information sections" })).toBeTruthy();
  });

  test("any other ticket opens on Ticket, and Notes is a click away", () => {
    withNotes();
    renderInAppCommandScope(
      <KanbanTaskDialog
        task={makeTask({ status: "in-progress" })}
        open
        onOpenChange={() => {}}
        openedFrom="in-progress"
      />,
    );
    expect(tab("Ticket").getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByTestId("ticket-notes-tab") === null).toBe(true);
    // Radix tabs select on mouse down; keyboard users arrow across the list.
    fireEvent.mouseDown(tab("Notes"), { button: 0 });
    expect(tab("Notes").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("ticket-notes-tab")).toBeTruthy();
  });

  test("a Review ticket without Notes opens on Ticket, with Notes disabled and the reason shown", () => {
    renderInAppCommandScope(
      <KanbanTaskDialog
        task={makeTask({ status: "review" })}
        open
        onOpenChange={() => {}}
        openedFrom="review"
      />,
    );
    expect(tab("Ticket").getAttribute("aria-selected")).toBe("true");
    expect((tab("Notes") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("ticket-notes-unavailable").textContent).toBe(
      "No build has run for this ticket yet.",
    );
  });

  test("the Ticket tab indexes every section as a link and jumps to it", () => {
    renderInAppCommandScope(
      <KanbanTaskDialog task={makeTask({ prUrl: PR_URL })} open onOpenChange={() => {}} />,
    );
    const index = screen.getByRole("navigation", { name: "Ticket sections" });
    const links = within(index).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual([
      "Summary",
      "Acceptance criteria",
      "Delivery",
      "Images",
      "Comments and activity",
      "Pull request",
    ]);
    const column = screen.getByTestId("ticket-view-scroll");
    const scrollTo = mock(() => {});
    column.scrollTo = scrollTo as never;
    Object.defineProperty(column, "scrollHeight", { configurable: true, value: 4000 });
    Object.defineProperty(column, "clientHeight", { configurable: true, value: 400 });
    const target = screen.getByRole("region", { name: "Comments and activity" });
    target.getBoundingClientRect = () => ({ top: 900 }) as DOMRect;
    const link = within(index).getByRole("link", { name: "Comments and activity" });
    expect(link.getAttribute("href")).toBe(`#${target.id}`);
    fireEvent.click(link);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(link.getAttribute("aria-current")).toBe("location");
    // One column: every section is in it, none beside another.
    const flow = screen.getByTestId("ticket-document-column");
    expect(flow.className).toContain("flex-col");
    expect(screen.queryByTestId("ticket-sections-grid") === null).toBe(true);
    expect(flow.contains(screen.getByTestId("ticket-tile-acceptanceCriteria"))).toBe(true);
  });

  test("the Ticket tab's bar stays outside its scrolling column, with working Build and Edit", () => {
    renderInAppCommandScope(<KanbanTaskDialog task={makeTask()} open onOpenChange={() => {}} />);
    const bar = screen.getByRole("toolbar", { name: "Ticket actions" });
    const column = screen.getByTestId("ticket-view-scroll");
    expect(column.contains(bar)).toBe(false);
    expect(bar.className).toContain("sticky");
    column.scrollTop = 600;
    fireEvent.scroll(column);
    expect(screen.getByRole("toolbar", { name: "Ticket actions" })).toBe(bar);

    const edit = within(bar).getByRole("button", { name: "Edit" }) as HTMLButtonElement;
    fireEvent.click(edit);
    expect(screen.getByLabelText("Ticket text")).toBeTruthy();
    expect(edit.disabled).toBe(true);

    const build = within(bar).getByRole("button", { name: "Build…" }) as HTMLButtonElement;
    expect(build.disabled).toBe(false);
    fireEvent.click(build);
    expect(screen.getByRole("button", { name: "Start build" })).toBeTruthy();
  });

  test("Build is disabled while a build of the ticket runs", () => {
    appCommandStore(buildPipelineStore)
      .getState()
      .replacePipeline(buildPipelineFixture({ taskId: "task-1", phase: "building" }));
    renderInAppCommandScope(<KanbanTaskDialog task={makeTask()} open onOpenChange={() => {}} />);
    const bar = screen.getByRole("toolbar", { name: "Ticket actions" });
    expect(
      (within(bar).getByRole("button", { name: "Build…" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  test("the Notes tab's bar shows the PR state and keeps Merge disabled until it is ready", () => {
    withNotes();
    withPullRequest(false);
    renderInAppCommandScope(
      <KanbanTaskDialog
        task={makeTask({ status: "review", environmentId: "env-1" })}
        open
        onOpenChange={() => {}}
        openedFrom="review"
      />,
    );
    const bar = screen.getByRole("toolbar", { name: "Pull request actions" });
    const column = screen.getByTestId("ticket-notes-scroll");
    expect(column.contains(bar)).toBe(false);
    expect(within(bar).getByTestId("ticket-pr-state").textContent).toBe("Draft");
    expect(within(bar).getByTestId("ticket-pr-checks").textContent).toBe("3 checks passed");
    expect((within(bar).getByRole("button", { name: "Merge" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(within(bar).getByRole("button", { name: /Integrate/ })).toBeTruthy();
    expect(mergeEnvironmentPrMock).not.toHaveBeenCalled();
  });

  test("Merge is enabled when the PR is ready, and merges only after the click is confirmed", async () => {
    withNotes();
    withPullRequest(true);
    renderInAppCommandScope(
      <KanbanTaskDialog
        task={makeTask({ status: "review", environmentId: "env-1" })}
        open
        onOpenChange={() => {}}
        openedFrom="review"
      />,
    );
    const bar = screen.getByRole("toolbar", { name: "Pull request actions" });
    expect(within(bar).getByTestId("ticket-pr-state").textContent).toBe("Ready to merge");
    const merge = within(bar).getByRole("button", { name: "Merge" }) as HTMLButtonElement;
    expect(merge.disabled).toBe(false);
    fireEvent.click(merge);
    expect(mergeEnvironmentPrMock).not.toHaveBeenCalled();
    const confirm = screen.getByRole("alertdialog", { name: "Merge pull request" });
    await act(async () => {
      fireEvent.click(within(confirm).getByRole("button", { name: "Merge" }));
    });
    await waitFor(() =>
      expect(mergeEnvironmentPrMock).toHaveBeenCalledWith("env-1", "squash", true, false),
    );
  });

  test("clicking the title on Notes edits on the Ticket tab, where Save and Cancel are", () => {
    withNotes();
    renderInAppCommandScope(
      <KanbanTaskDialog
        task={makeTask({ status: "review", buildPipelineId: "pipeline-1" })}
        open
        onOpenChange={() => {}}
        openedFrom="review"
      />,
    );
    expect(tab("Notes").getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("heading", { name: "Tabbed ticket" }));
    expect(tab("Ticket").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByLabelText("Ticket title")).toBeTruthy();
    expect(screen.getByLabelText("Ticket text")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  test("a merge that fails says so, and the PR is left for another try", async () => {
    withNotes();
    withPullRequest(true);
    mergeEnvironmentPrMock.mockImplementationOnce(async () => {
      throw new Error("Base branch was modified");
    });
    renderInAppCommandScope(
      <KanbanTaskDialog
        task={makeTask({ status: "review", environmentId: "env-1" })}
        open
        onOpenChange={() => {}}
        openedFrom="review"
      />,
    );
    const bar = screen.getByRole("toolbar", { name: "Pull request actions" });
    fireEvent.click(within(bar).getByRole("button", { name: "Merge" }));
    const confirm = screen.getByRole("alertdialog", { name: "Merge pull request" });
    await act(async () => {
      fireEvent.click(within(confirm).getByRole("button", { name: "Merge" }));
    });
    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith("The pull request could not be merged", {
        description: "Base branch was modified",
      }),
    );
    expect(logs.records()).toContainEqual(
      expect.objectContaining({ level: "error", area: "web.kanban", event: "pr.merge-failed" }),
    );
    await waitFor(() =>
      expect(
        (within(bar).getByRole("button", { name: "Merge" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  });

  test("Merge says why it is disabled when the build's environment is not on this machine", () => {
    withNotes();
    renderInAppCommandScope(
      <KanbanTaskDialog
        task={makeTask({ status: "review", buildPipelineId: "pipeline-1" })}
        open
        onOpenChange={() => {}}
        openedFrom="review"
      />,
    );
    const bar = screen.getByRole("toolbar", { name: "Pull request actions" });
    const merge = within(bar).getByRole("button", { name: "Merge" }) as HTMLButtonElement;
    expect(merge.disabled).toBe(true);
    expect(merge.getAttribute("aria-description")).toBe(
      "The build's environment is not on this machine",
    );
    expect(merge.parentElement?.getAttribute("title")).toBe(
      "The build's environment is not on this machine",
    );
  });
});
