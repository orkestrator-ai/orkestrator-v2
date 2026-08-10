import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { useBuildPipelineStore, type BuildPipeline } from "@/stores/buildPipelineStore";
import * as realVirtualizedMessageList from "@/components/chat/VirtualizedMessageList";
import {
  restoreMatchMedia,
  setMobileViewport,
} from "../../../../../tests/mocks/match-media";

const realVirtualizedMessageListSnapshot = { ...realVirtualizedMessageList };

/*
 * react-virtuoso measures a real viewport, so its rows never render under
 * happy-dom. Stubbed exactly as the sibling suite does, because these tests
 * assert that the transcript stays mounted behind the stage list.
 */
mock.module("@/components/chat/VirtualizedMessageList", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  VirtualizedMessageList: ({ messages, renderMessage, emptyState }: any) => (
    <div>
      {messages.length === 0 ? emptyState : null}
      {messages.map((message: unknown, index: number) => (
        <div key={index}>{renderMessage(index, message, null)}</div>
      ))}
    </div>
  ),
}));

const { BuildChatTab } = await import("./BuildChatTab");

afterAll(() => {
  mock.module(
    "@/components/chat/VirtualizedMessageList",
    () => realVirtualizedMessageListSnapshot,
  );
  restoreMatchMedia();
});

const pipeline: BuildPipeline = {
  id: "pipeline-1",
  taskId: "task-1",
  projectId: "project-1",
  environmentId: "env-1",
  environmentType: "local",
  agentType: "codex",
  phase: "building",
  sessions: [
    {
      phase: "build",
      iteration: 0,
      sessionKey: "build-key",
      sdkSessionId: "build-session",
      status: "idle",
      startedAt: "2026-07-29T00:00:00.000Z",
      label: "Build Session",
      messages: [{
        id: "answer-1",
        role: "assistant",
        parts: [{ type: "text", content: "Implementation complete" }],
      }],
    },
    {
      phase: "verify",
      iteration: 0,
      sessionKey: "verify-key",
      sdkSessionId: "verify-session",
      status: "running",
      startedAt: "2026-07-29T00:01:00.000Z",
      label: "Verification Session",
      messages: [{
        id: "answer-2",
        role: "assistant",
        parts: [{ type: "text", content: "All criteria pass" }],
      }],
    },
  ],
  currentSessionIndex: 1,
  iteration: 0,
  maxIterations: 3,
  createdAt: "2026-07-29T00:00:00.000Z",
  taskTitle: "Backend-owned build",
  taskSnapshot: {
    title: "Backend-owned build",
    description: "",
    acceptanceCriteria: "",
    comments: [],
    images: [],
  },
  backendRevision: 8,
  controller: "backend",
};

function renderTab() {
  render(<BuildChatTab
    data={{
      pipelineId: pipeline.id,
      environmentId: pipeline.environmentId,
      taskId: pipeline.taskId,
      isLocal: true,
    }}
    isActive
  />);
}

/** The mobile switcher, scoped so its tabs never collide with the stage tabs. */
function viewTabs() {
  return within(screen.getByRole("tablist", { name: "Build view" }));
}

/**
 * A stage tab, or null while the stage list is hidden.
 *
 * `getByRole` skips anything the accessibility tree excludes, so this doubles
 * as the visibility assertion: a `hidden` panel takes its tabs with it. Scoped
 * to the stage list because the switcher names its transcript tab after the
 * selected stage, so the two lists share a name while both are on screen.
 */
function stageTab(name: string): HTMLElement | null {
  const list = screen.queryByRole("tablist", { name: "Build stages" });
  if (!list) return null;
  return within(list).queryByRole("tab", { name: new RegExp(name) });
}

beforeEach(() => {
  cleanup();
  useBuildPipelineStore.setState({
    pipelines: new Map([[pipeline.id, pipeline]]),
    buildEnvironmentIds: new Set([pipeline.environmentId]),
  });
});

describe("BuildChatTab on a phone", () => {
  beforeEach(() => setMobileViewport(true));

  test("opens on the transcript with the stage rail folded away", () => {
    renderTab();

    expect(viewTabs().getByRole("tab", { name: "Stages" }).getAttribute("aria-selected"))
      .toBe("false");
    expect(
      viewTabs().getByRole("tab", { name: "Verification Session" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    // The rail would otherwise take 240px of a ~390px screen.
    expect(stageTab("Build Session")).toBeNull();
    expect(screen.getByText("All criteria pass")).toBeTruthy();
  });

  test("gives the stage list the full width without unmounting the transcript", () => {
    renderTab();
    fireEvent.click(viewTabs().getByRole("tab", { name: "Stages" }));

    expect(stageTab("Build Session")).toBeTruthy();
    expect(stageTab("Verification Session")).toBeTruthy();
    // Still in the DOM, just not on screen: unmounting it would throw away the
    // transcript's scroll position every time the user checked the stage list.
    expect(screen.getByText("All criteria pass")).toBeTruthy();
    expect(document.getElementById(
      viewTabs().getByRole("tab", { name: "Stages" }).getAttribute("aria-controls")!,
    )?.hidden).toBe(false);
    // The composer addresses the transcript, so it travels with it rather than
    // eating a third of the stage list.
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  test("brings the transcript forward when a stage is chosen", () => {
    renderTab();
    fireEvent.click(viewTabs().getByRole("tab", { name: "Stages" }));
    fireEvent.click(stageTab("Build Session")!);

    expect(
      viewTabs().getByRole("tab", { name: "Build Session" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(stageTab("Verification Session")).toBeNull();
    expect(screen.getByText("Implementation complete")).toBeTruthy();
  });

  test("browses the stage list with arrow keys without leaving it", () => {
    renderTab();
    fireEvent.click(viewTabs().getByRole("tab", { name: "Stages" }));
    fireEvent.keyDown(stageTab("Verification Session")!, { key: "ArrowUp" });

    // Arrow keys walk the list; only an explicit pick switches views.
    expect(stageTab("Build Session")?.getAttribute("aria-selected")).toBe("true");
    expect(
      viewTabs().getByRole("tab", { name: "Stages" }).getAttribute("aria-selected"),
    ).toBe("true");
  });

  test("moves between the two views with arrow keys", () => {
    renderTab();
    fireEvent.keyDown(
      viewTabs().getByRole("tab", { name: "Verification Session" }),
      { key: "ArrowLeft" },
    );

    expect(
      viewTabs().getByRole("tab", { name: "Stages" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(stageTab("Build Session")).toBeTruthy();
  });

  test("keeps an unsent draft while the stage list is on screen", () => {
    renderTab();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "check the migration" },
    });
    fireEvent.click(viewTabs().getByRole("tab", { name: "Stages" }));
    fireEvent.click(viewTabs().getByRole("tab", { name: "Verification Session" }));

    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value)
      .toBe("check the migration");
  });
});

describe("BuildChatTab on a desktop", () => {
  beforeEach(() => setMobileViewport(false));

  test("keeps the stage rail beside the transcript with no view switcher", () => {
    renderTab();

    expect(screen.queryByRole("tablist", { name: "Build view" })).toBeNull();
    expect(stageTab("Build Session")).toBeTruthy();
    expect(screen.getByText("All criteria pass")).toBeTruthy();
    expect(screen.getByRole("textbox")).toBeTruthy();
  });
});
