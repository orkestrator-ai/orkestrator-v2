import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
  activation?: "respect-intent" | "latest";
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
 * assert that the transcript stays mounted below the graph.
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
  mock.module("@/components/chat/VirtualizedMessageList", () => realVirtualizedMessageListSnapshot);
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
      messages: [
        {
          id: "answer-1",
          role: "assistant",
          parts: [{ type: "text", content: "Implementation complete" }],
        },
      ],
    },
    {
      phase: "verify",
      iteration: 0,
      sessionKey: "verify-key",
      sdkSessionId: "verify-session",
      status: "running",
      startedAt: "2026-07-29T00:01:00.000Z",
      label: "Verification Session",
      messages: [
        {
          id: "answer-2",
          role: "assistant",
          parts: [{ type: "text", content: "All criteria pass" }],
        },
      ],
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
      messages: [
        {
          id: "review-answer",
          role: "assistant",
          parts: [{ type: "text", content: "The review is complete" }],
        },
      ],
    },
    pipeline.sessions[1]!,
  ],
  currentSessionIndex: 2,
  structuredReview: TEST_STRUCTURED_REVIEW_REPORT,
  structuredReviewRequestId: "review-request",
  backendRevision: 40,
};

function renderPipeline(next: BuildPipeline, layout?: "graph" | "stacked") {
  useBuildPipelineStore.setState({
    pipelines: new Map([[next.id, next]]),
    buildEnvironmentIds: new Set([next.environmentId]),
  });
  render(
    <BuildChatTab
      data={{
        pipelineId: next.id,
        environmentId: next.environmentId,
        taskId: next.taskId,
        isLocal: true,
      }}
      isActive
      layout={layout}
    />,
  );
}

/**
 * A phone renders the graph as one stacked column. happy-dom measures every
 * width as zero, so the column is asked for, as the measured width would.
 */
function renderTab(layout: "graph" | "stacked" = "stacked") {
  renderPipeline(pipeline, layout);
}

/** A node of the graph, by its title. */
function node(title: string): HTMLElement {
  return within(screen.getByRole("tablist", { name: "Build pipeline" })).getByRole("tab", {
    name: new RegExp(`^${title},`),
  });
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

  test("stacks the graph above the inspector, with no view switcher", () => {
    renderTab();

    expect(document.querySelector('[data-flow-layout="stacked"]')).toBeTruthy();
    expect(
      screen.getByRole("tablist", { name: "Build pipeline" }).getAttribute("aria-orientation"),
    ).toBe("vertical");
    expect(screen.queryByRole("tablist", { name: "Build view" }) === null).toBe(true);
    // The running stage is selected and its transcript is on the same page.
    expect(node("Verify").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("All criteria pass")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Send a message to the agent" })).toBeTruthy();
  });

  test("keeps the header compact", () => {
    renderTab();
    expect(screen.getByTestId("build-pipeline-header").className).toContain("px-3");
  });

  test("keeps the zoom controls in reach at the top of the column", () => {
    renderTab();
    const controls = screen.getByRole("group", { name: "Zoom" });
    expect(controls.closest(".sticky")).toBeTruthy();
    for (const button of within(controls).getAllByRole("button")) {
      // 44 px touch targets: square icons, and the level beside them.
      expect(button.className).toMatch(/size-11|h-11/);
    }
  });

  test("shows a chosen stage in the inspector below without moving focus", () => {
    renderTab();
    const chosen = node("Build");
    chosen.focus();
    fireEvent.click(chosen);

    expect(chosen.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(chosen);
    expect(screen.getByText("Implementation complete")).toBeTruthy();
    expect(screen.getByTestId("pipeline-inspector").getAttribute("aria-labelledby")).toBe(
      chosen.id,
    );
    // The transcript stays on screen, so it keeps following the stream.
    expect(lastScrollState()).toMatchObject({
      isActive: true,
      persistKey: "build-pipeline:pipeline-1",
      activation: "latest",
    });
  });

  test("walks the column with the arrow keys", () => {
    renderTab();
    const verify = node("Verify");
    verify.focus();
    fireEvent.keyDown(verify, { key: "ArrowUp" });
    expect(node("Build").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(node("Build"));
    fireEvent.keyDown(node("Build"), { key: "Home" });
    expect(node("Ticket").getAttribute("aria-selected")).toBe("true");
  });

  test("the review report hint selects the stage holding the report", () => {
    renderPipeline(reviewed, "stacked");
    fireEvent.click(screen.getByRole("button", { name: /The review reported/ }));

    expect(node("Review").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByLabelText("Structured review report")).toBeTruthy();
  });

  test("keeps an unsent draft while another stage is read", () => {
    renderTab();
    fireEvent.change(screen.getByRole("textbox", { name: "Send a message to the agent" }), {
      target: { value: "half-written" },
    });
    fireEvent.click(node("Build"));
    expect(screen.queryByRole("textbox", { name: "Send a message to the agent" }) === null).toBe(
      true,
    );
    fireEvent.click(node("Verify"));
    expect(
      (screen.getByRole("textbox", { name: "Send a message to the agent" }) as HTMLTextAreaElement)
        .value,
    ).toBe("half-written");
  });
});

describe("BuildChatTab across the breakpoint", () => {
  beforeEach(() => setMobileViewport(true));

  test("draws the pipeline controls as accessible tooltip icon buttons", () => {
    renderTab();

    // Three labelled buttons beside the title do not fit a ~390px screen: they
    // pushed the phase line underneath themselves and clipped the last control
    // off the edge. The label survives as the accessible name and is displayed
    // by the shared tooltip rather than duplicated inside the button.
    for (const name of ["Restart Build Stage", "Pause", "Cancel"]) {
      const control = screen.getByRole("button", { name });
      expect(control.getAttribute("aria-label")).toBe(name);
      expect(control.getAttribute("title")).toBeNull();
      expect(control.textContent?.trim()).toBe("");
    }
  });

  test("names the paused and failed-stage icon controls", () => {
    renderPipeline({
      ...pipeline,
      phase: "paused",
      pausedFromPhase: "building",
      backendRevision: 9,
    });

    for (const name of ["Resume", "Cancel"]) {
      const control = screen.getByRole("button", { name });
      expect(control.getAttribute("aria-label")).toBe(name);
      expect(control.getAttribute("title")).toBeNull();
      expect(control.textContent?.trim()).toBe("");
    }

    cleanup();
    renderPipeline({
      ...pipeline,
      phase: "failed",
      error: "Verification did not complete",
      failureContext: {
        phase: "verifying",
        kind: "stage-transition",
        sessionId: "verify-session",
      },
      backendRevision: 10,
    });

    const retry = screen.getByRole("button", { name: "Retry Verification Stage" });
    expect(retry.getAttribute("aria-label")).toBe("Retry Verification Stage");
    expect(retry.getAttribute("title")).toBeNull();
    expect(retry.textContent?.trim()).toBe("");
  });

  test("omits the controls region when the pipeline has no available action", () => {
    renderPipeline({
      ...pipeline,
      phase: "complete",
      backendRevision: 9,
    });

    expect(screen.getByTestId("build-pipeline-header")).toBeTruthy();
    expect(screen.queryByTestId("build-pipeline-header-controls") === null).toBe(true);
    for (const name of ["Restart Build Stage", "Pause", "Resume", "Cancel"]) {
      expect(screen.queryByRole("button", { name }) === null).toBe(true);
    }
  });

  test("crossing the breakpoint keeps the selection and the transcript", () => {
    renderTab("graph");
    fireEvent.click(node("Build"));
    act(() => emitViewportChange(false));
    expect(node("Build").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Implementation complete")).toBeTruthy();
    act(() => emitViewportChange(true));
    expect(node("Build").getAttribute("aria-selected")).toBe("true");
    expect(lastScrollState().isActive).toBe(true);
  });
});

describe("BuildChatTab on a desktop", () => {
  beforeEach(() => setMobileViewport(false));

  test("draws the wide graph above the inspector", () => {
    renderTab("graph");

    expect(document.querySelector('[data-flow-layout="graph"]')).toBeTruthy();
    expect(screen.queryByRole("tablist", { name: "Build view" }) === null).toBe(true);
    expect(node("Build")).toBeTruthy();
    expect(screen.getByText("All criteria pass")).toBeTruthy();
    expect(screen.getByRole("textbox")).toBeTruthy();
    expect(lastScrollState().isActive).toBe(true);
    expect(screen.getByTestId("build-pipeline-header").className).not.toContain("px-3");
  });

  test("keeps the pipeline controls icon-only and reveals their labels in tooltips", async () => {
    renderTab();

    for (const name of ["Restart Build Stage", "Pause", "Cancel"]) {
      const control = screen.getByRole("button", { name });
      expect(control.getAttribute("aria-label")).toBe(name);
      expect(control.textContent?.trim()).toBe("");
    }

    fireEvent.focus(screen.getByRole("button", { name: "Restart Build Stage" }));
    expect((await screen.findByRole("tooltip")).textContent).toContain("Restart Build Stage");
  });
});
