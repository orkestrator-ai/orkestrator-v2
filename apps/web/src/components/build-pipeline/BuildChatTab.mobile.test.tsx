import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { useBuildPipelineStore, type BuildPipeline } from "@/stores/buildPipelineStore";
import * as realHooks from "@/hooks";
import * as realVirtualizedMessageList from "@/components/chat/VirtualizedMessageList";
import {
  emitViewportChange,
  restoreMatchMedia,
  setMobileViewport,
} from "../../../../../tests/mocks/match-media";
import { TEST_STRUCTURED_REVIEW_REPORT } from "./structured-review-test-fixture";

const realHooksSnapshot = { ...realHooks };
const realVirtualizedMessageListSnapshot = { ...realVirtualizedMessageList };

/**
 * The options the tab handed `useVirtuosoScrollState`, newest last.
 *
 * `isActive` is the whole contract between the layout and the transcript's
 * scroll state — hiding the transcript has to deactivate it exactly as a tab
 * switch does, which is what re-locks it to the live bottom on return. Nothing
 * about that reaches the DOM, so it is recorded here rather than asserted on
 * rendered output.
 */
interface ScrollStateOptions {
  isActive?: boolean;
  persistKey?: string;
  stickToBottomOnActivation?: boolean;
}

const scrollStateOptions: ScrollStateOptions[] = [];

/*
 * Only `useVirtuosoScrollState` is replaced; everything else in the barrel —
 * `useMediaQuery` above all, which is what decides the layout under test —
 * stays real. The real hook drives react-virtuoso through refs that never
 * resolve under happy-dom, so its own behaviour belongs to its own suite.
 */
mock.module("@/hooks", () => ({
  ...realHooksSnapshot,
  useVirtuosoScrollState: (options: ScrollStateOptions) => {
    scrollStateOptions.push(options);
    return {
      isAtBottom: true,
      isAtBottomRef: { current: true },
      scrollToBottom: () => {},
      virtuosoRef: { current: null },
      scrollProps: {},
    };
  },
}));

/*
 * react-virtuoso measures a real viewport, so its rows never render under
 * happy-dom. Stubbed exactly as the sibling suite does, because these tests
 * assert that the transcript stays mounted behind the stage list.
 */
mock.module("@/components/chat/VirtualizedMessageList", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  VirtualizedMessageList: ({ messages, renderMessage, emptyState, footer }: any) => (
    <div>
      {messages.length === 0 ? emptyState : null}
      {messages.map((message: unknown, index: number) => (
        <div key={index}>{renderMessage(index, message, null)}</div>
      ))}
      {footer}
    </div>
  ),
}));

const { BuildChatTab } = await import("./BuildChatTab");

afterAll(() => {
  mock.module("@/hooks", () => realHooksSnapshot);
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

/**
 * The same build after a review produced a report, with the pipeline advanced
 * past it — the shape that renders the report hint, because the stage holding
 * the report is not the stage on screen.
 */
const reviewed: BuildPipeline = {
  ...pipeline,
  sessions: [
    pipeline.sessions[0]!,
    {
      phase: "review",
      iteration: 0,
      sessionKey: "review-key",
      sdkSessionId: "review-session",
      status: "idle",
      startedAt: "2026-07-29T00:00:30.000Z",
      label: "Review Session",
      structuredRequestId: "review-request",
      structuredResultStatus: "accepted",
      messages: [{
        id: "review-answer",
        role: "assistant",
        parts: [{ type: "text", content: "The review is complete" }],
      }],
    },
    pipeline.sessions[1]!,
  ],
  currentSessionIndex: 2,
  structuredReview: TEST_STRUCTURED_REVIEW_REPORT,
  structuredReviewRequestId: "review-request",
  backendRevision: 40,
};

function renderPipeline(next: BuildPipeline) {
  useBuildPipelineStore.setState({
    pipelines: new Map([[next.id, next]]),
    buildEnvironmentIds: new Set([next.environmentId]),
  });
  render(<BuildChatTab
    data={{
      pipelineId: next.id,
      environmentId: next.environmentId,
      taskId: next.taskId,
      isLocal: true,
    }}
    isActive
  />);
}

function renderTab() {
  renderPipeline(pipeline);
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

/** The options behind the transcript on screen right now. */
function lastScrollState(): ScrollStateOptions {
  const last = scrollStateOptions.at(-1);
  if (!last) throw new Error("The transcript's scroll state was never created.");
  return last;
}

beforeEach(() => {
  cleanup();
  scrollStateOptions.length = 0;
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

  test("deactivates the transcript's scroll state while the stage list is on screen", () => {
    renderTab();
    expect(lastScrollState().isActive).toBe(true);

    fireEvent.click(viewTabs().getByRole("tab", { name: "Stages" }));

    // Hiding the transcript has to deactivate it exactly as switching tabs
    // does. Leaving it active would keep it following a stream nobody can see
    // and skip the re-lock that brings the user back to the live bottom.
    expect(lastScrollState().isActive).toBe(false);
    expect(lastScrollState().stickToBottomOnActivation).toBe(true);

    fireEvent.click(viewTabs().getByRole("tab", { name: "Verification Session" }));

    expect(lastScrollState().isActive).toBe(true);
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

  test("hands focus to the transcript tab when the stage list that held it hides", () => {
    renderTab();
    fireEvent.click(viewTabs().getByRole("tab", { name: "Stages" }));
    const chosen = stageTab("Build Session")!;
    chosen.focus();
    fireEvent.click(chosen);

    // Hiding the element that holds focus drops focus to <body>, and the next
    // Tab would restart from the top of the document. Compared by id rather
    // than by node: a failed element-identity assertion makes the runner
    // serialize both DOM subtrees, which crashes it instead of reporting.
    expect(document.activeElement?.id).toBe(
      viewTabs().getByRole("tab", { name: "Build Session" }).id,
    );
  });

  test("leaves focus alone when the stage list was not holding it", () => {
    renderTab();
    const stages = viewTabs().getByRole("tab", { name: "Stages" });
    fireEvent.click(stages);
    stages.focus();
    fireEvent.click(stageTab("Build Session")!);

    // A tap leaves focus where the pointer put it, and moving it would be a
    // change the user did not ask for.
    expect(document.activeElement?.id).toBe(stages.id);
  });

  test("brings the transcript forward when the review report hint is chosen", () => {
    cleanup();
    renderPipeline(reviewed);
    fireEvent.click(viewTabs().getByRole("tab", { name: "Stages" }));
    expect(stageTab("Review Session")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /The review reported/ }));

    // The hint sits above the switcher so it is reachable from either half,
    // and it is a request to read a stage — so it moves the view like a pick
    // in the stage list does.
    expect(stageTab("Review Session")).toBeNull();
    expect(
      viewTabs().getByRole("tab", { name: "Review Session" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByText("The review is complete")).toBeTruthy();
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

    const stages = viewTabs().getByRole("tab", { name: "Stages" });
    expect(stages.getAttribute("aria-selected")).toBe("true");
    expect(stageTab("Build Session")).toBeTruthy();
    // A tablist moves focus with the selection, so the next arrow key keeps
    // walking the switcher rather than starting over from the document.
    expect(document.activeElement?.id).toBe(stages.id);
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

describe("BuildChatTab across the breakpoint", () => {
  beforeEach(() => setMobileViewport(true));

  test("widening past the breakpoint puts both halves back on screen", () => {
    renderTab();
    fireEvent.click(viewTabs().getByRole("tab", { name: "Stages" }));
    expect(lastScrollState().isActive).toBe(false);

    act(() => emitViewportChange(false));

    // Nothing left to choose between, so the switcher goes away with the
    // constraint that produced it.
    expect(screen.queryByRole("tablist", { name: "Build view" })).toBeNull();
    expect(stageTab("Build Session")).toBeTruthy();
    expect(screen.getByText("All criteria pass")).toBeTruthy();
    // The transcript is on screen again, so it follows the stream again.
    expect(lastScrollState().isActive).toBe(true);
  });

  test("narrowing again returns to the half the user last chose", () => {
    renderTab();
    fireEvent.click(viewTabs().getByRole("tab", { name: "Stages" }));
    act(() => emitViewportChange(false));
    act(() => emitViewportChange(true));

    expect(
      viewTabs().getByRole("tab", { name: "Stages" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(stageTab("Build Session")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(lastScrollState().isActive).toBe(false);
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
    expect(lastScrollState().isActive).toBe(true);
  });

  test("choosing a stage neither hides anything nor moves focus", () => {
    renderTab();
    const chosen = stageTab("Build Session")!;
    chosen.focus();
    fireEvent.click(chosen);

    // The mobile-only view switch has nothing to hide here, so the stage list
    // keeps both the selection and the focus that made it.
    expect(document.activeElement?.id).toBe(chosen.id);
    expect(stageTab("Verification Session")).toBeTruthy();
    expect(screen.getByText("Implementation complete")).toBeTruthy();
    expect(lastScrollState().isActive).toBe(true);
  });
});
