import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { useEffect, useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  within,
} from "@testing-library/react";
import type { MultiReviewWorkflow } from "@orkestrator/protocol/multi-review";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import {
  TerminalProvider,
  useTerminalContext,
  type CreatableTabType,
  type CreateTabOptions,
} from "@/contexts";
import { useMessagePartExpansionStore } from "@/stores/messagePartExpansionStore";
import { useMultiReviewFlowViewStore } from "@/stores/multiReviewFlowViewStore";
import { useMultiReviewStore } from "@/stores/multiReviewStore";
import { MultiReviewTab } from "./MultiReviewTab";
import {
  MultiReviewFlowGraph,
  type MultiReviewFlowGraphProps,
  type MultiReviewFlowNodeModel,
} from "./MultiReviewFlowGraph";
import { useFlowViewport } from "./MultiReviewFlowViewport";
import {
  multiReviewFlowLayout,
  type MultiReviewFlowEdgeState,
  type MultiReviewFlowState,
} from "./multi-review-flow";
import { fitFlowZoom, flowViewportHeight } from "./multi-review-flow-viewport";

const STARTED = "2026-08-14T00:00:00.000Z";

const report: StructuredReviewReport = {
  reviewScope: {
    targetBranch: "main",
    baseRef: "origin/main...HEAD",
    commit: null,
    filesReviewed: ["src/review.ts"],
    filesSkipped: [],
    filesLeftUncommitted: [],
    commandsRun: [],
    commandsNotRun: [],
    limitations: [],
  },
  whatChanged: {
    overview: "Flow graph",
    before: "Cards",
    after: "Graph",
    keyCodeChanges: [],
    userImpact: "Readable pipeline",
  },
  riskProfile: { changeTypes: ["ui"], riskAreas: [], overallRisk: "low", reasoning: "Layout" },
  testResults: { total: 0, passed: 0, failed: 0, notRun: 0, failures: [] },
  strengths: [],
  issues: [
    {
      severity: "P0",
      confidence: 90,
      category: "correctness",
      title: "Shared finding",
      file: "src/review.ts",
      line: 12,
      symbol: "review",
      description: "A finding",
      evidence: "Seen",
      suggestion: "Fix it",
      verification: "Test it",
    },
  ],
  testCoverageGaps: [],
  verdict: { ready: "with-fixes", reasoning: "One issue" },
  summaryOfChange: "Flow graph",
  reviewSummary: "One finding",
};

type Reviewer = MultiReviewWorkflow["reviewers"][number];

const pending = (index: number): Reviewer => ({
  id: `reviewer-${index + 1}`,
  agent: index === 1 ? "codex" : "claude",
  model: index === 1 ? "gpt-5.6" : "opus",
  status: "pending",
});
const running = (index: number): Reviewer => ({
  ...pending(index),
  status: "running",
  providerSessionId: `session-${index + 1}`,
  startedAt: STARTED,
});
const completed = (index: number): Reviewer => ({
  ...running(index),
  status: "completed",
  completedAt: STARTED,
  report,
});
const failed = (index: number): Reviewer => ({
  ...running(index),
  status: "failed",
  error: "The reviewer failed",
});
const cancelled = (index: number): Reviewer => ({ ...running(index), status: "cancelled" });

function workflow(overrides: Partial<MultiReviewWorkflow>): MultiReviewWorkflow {
  return {
    version: 1,
    controller: "backend",
    id: "multi-flow",
    environmentId: "env-1",
    projectId: "project-1",
    targetBranch: "main",
    phase: "reviewing",
    reviewers: [completed(0), running(1), pending(2)],
    fixModel: { agent: "codex", model: "gpt-5.6", reasoningEffort: "high" },
    createdAt: STARTED,
    updatedAt: STARTED,
    backendRevision: 1,
    ...overrides,
  };
}

const allDone = () => [completed(0), completed(1), completed(2)];
const fixSession = (status: "running" | "idle"): MultiReviewWorkflow["fixSession"] => ({
  agent: "codex",
  model: "gpt-5.6",
  sessionKey: "fix",
  providerSessionId: "provider-fix",
  requestIds: ["fix-1"],
  status,
  startedAt: STARTED,
});

interface PhaseCase {
  name: string;
  workflow: MultiReviewWorkflow;
  nodes: [MultiReviewFlowState, MultiReviewFlowState[], MultiReviewFlowState, MultiReviewFlowState];
  edges: {
    intoReviewers: MultiReviewFlowEdgeState[];
    intoConsolidation: MultiReviewFlowEdgeState[];
    intoFix: MultiReviewFlowEdgeState;
  };
  selected: string;
}

const NOT = "not-started" as const;

const PHASES: PhaseCase[] = [
  {
    name: "preparing",
    workflow: workflow({ phase: "preparing", reviewers: [pending(0), pending(1), pending(2)] }),
    nodes: ["running", [NOT, NOT, NOT], NOT, NOT],
    edges: {
      intoReviewers: ["pending", "pending", "pending"],
      intoConsolidation: ["pending", "pending", "pending"],
      intoFix: "pending",
    },
    selected: "Review package",
  },
  {
    name: "reviewing",
    workflow: workflow({ phase: "reviewing" }),
    nodes: ["complete", ["complete", "running", NOT], NOT, NOT],
    edges: {
      intoReviewers: ["complete", "active", "pending"],
      intoConsolidation: ["ready", "pending", "pending"],
      intoFix: "pending",
    },
    selected: "Reviewer 2 ·",
  },
  {
    name: "consolidating",
    workflow: workflow({
      phase: "consolidating",
      reviewers: [completed(0), completed(1), cancelled(2)],
      activeRequest: { kind: "consolidate", requestId: "c-1", state: "sent", createdAt: STARTED },
    }),
    nodes: ["complete", ["complete", "complete", "cancelled"], "running", NOT],
    edges: {
      intoReviewers: ["complete", "complete", "pending"],
      intoConsolidation: ["active", "active", "pending"],
      intoFix: "pending",
    },
    selected: "Consolidation",
  },
  {
    name: "ready",
    workflow: workflow({ phase: "ready", reviewers: allDone(), consolidatedReport: report }),
    nodes: ["complete", ["complete", "complete", "complete"], "complete", NOT],
    edges: {
      intoReviewers: ["complete", "complete", "complete"],
      intoConsolidation: ["complete", "complete", "complete"],
      intoFix: "ready",
    },
    selected: "Consolidation",
  },
  {
    name: "fixing",
    workflow: workflow({
      phase: "fixing",
      reviewers: allDone(),
      consolidatedReport: report,
      fixSession: fixSession("running"),
    }),
    nodes: ["complete", ["complete", "complete", "complete"], "complete", "running"],
    edges: {
      intoReviewers: ["complete", "complete", "complete"],
      intoConsolidation: ["complete", "complete", "complete"],
      intoFix: "active",
    },
    selected: "Fix,",
  },
  {
    name: "interactive",
    workflow: workflow({
      phase: "interactive",
      reviewers: allDone(),
      consolidatedReport: report,
      fixSession: fixSession("running"),
      stepRuntimes: { fix: { startedAt: STARTED } },
    }),
    nodes: ["complete", ["complete", "complete", "complete"], "complete", "running"],
    edges: {
      intoReviewers: ["complete", "complete", "complete"],
      intoConsolidation: ["complete", "complete", "complete"],
      intoFix: "active",
    },
    selected: "Fix,",
  },
  {
    name: "paused while preparing",
    workflow: workflow({
      phase: "paused",
      pausedStep: "prepare",
      reviewers: [pending(0), pending(1), pending(2)],
    }),
    nodes: ["paused", [NOT, NOT, NOT], NOT, NOT],
    edges: {
      intoReviewers: ["pending", "pending", "pending"],
      intoConsolidation: ["pending", "pending", "pending"],
      intoFix: "pending",
    },
    selected: "Review package",
  },
  {
    name: "paused while consolidating",
    workflow: workflow({ phase: "paused", pausedStep: "consolidate", reviewers: allDone() }),
    nodes: ["complete", ["complete", "complete", "complete"], "paused", NOT],
    edges: {
      intoReviewers: ["complete", "complete", "complete"],
      intoConsolidation: ["ready", "ready", "ready"],
      intoFix: "pending",
    },
    selected: "Consolidation",
  },
  {
    name: "paused while fixing",
    workflow: workflow({
      phase: "paused",
      pausedStep: "fix",
      reviewers: allDone(),
      consolidatedReport: report,
    }),
    nodes: ["complete", ["complete", "complete", "complete"], "complete", "paused"],
    edges: {
      intoReviewers: ["complete", "complete", "complete"],
      intoConsolidation: ["complete", "complete", "complete"],
      intoFix: "ready",
    },
    selected: "Fix,",
  },
  {
    name: "completed",
    workflow: workflow({ phase: "completed", reviewers: allDone(), consolidatedReport: report }),
    nodes: ["complete", ["complete", "complete", "complete"], "complete", "complete"],
    edges: {
      intoReviewers: ["complete", "complete", "complete"],
      intoConsolidation: ["complete", "complete", "complete"],
      intoFix: "complete",
    },
    selected: "Fix,",
  },
  {
    name: "cancelling",
    workflow: workflow({
      phase: "cancelling",
      reviewers: [completed(0), cancelled(1), pending(2)],
    }),
    nodes: ["complete", ["complete", "cancelled", NOT], "cancelling", "cancelling"],
    edges: {
      intoReviewers: ["complete", "pending", "pending"],
      intoConsolidation: ["pending", "pending", "pending"],
      intoFix: "pending",
    },
    // Consolidation and Fix are being cancelled without having run.
    selected: "Reviewer 2 ·",
  },
  {
    name: "cancelled",
    workflow: workflow({ phase: "cancelled", reviewers: [completed(0), cancelled(1), pending(2)] }),
    nodes: ["complete", ["complete", "cancelled", NOT], "cancelled", "cancelled"],
    edges: {
      intoReviewers: ["complete", "pending", "pending"],
      intoConsolidation: ["pending", "pending", "pending"],
      intoFix: "pending",
    },
    selected: "Reviewer 2 ·",
  },
  {
    name: "failed in review",
    workflow: workflow({ phase: "failed", reviewers: [failed(0), completed(1), completed(2)] }),
    nodes: ["complete", ["failed", "complete", "complete"], NOT, NOT],
    edges: {
      intoReviewers: ["failed", "complete", "complete"],
      intoConsolidation: ["pending", "ready", "ready"],
      intoFix: "pending",
    },
    selected: "Reviewer 3 ·",
  },
  {
    name: "failed in consolidation",
    workflow: workflow({
      phase: "failed",
      reviewers: allDone(),
      activeRequest: { kind: "consolidate", requestId: "c-1", state: "sent", createdAt: STARTED },
    }),
    nodes: ["complete", ["complete", "complete", "complete"], "failed", NOT],
    edges: {
      intoReviewers: ["complete", "complete", "complete"],
      intoConsolidation: ["failed", "failed", "failed"],
      intoFix: "pending",
    },
    selected: "Consolidation",
  },
];

function renderTab(target: MultiReviewWorkflow) {
  useMultiReviewStore.getState().replaceWorkflow(target);
  return render(
    <MultiReviewTab
      data={{ environmentId: target.environmentId, workflowId: target.id, isLocal: true }}
      isActive
      hydrateWorkflow={mock(async () => target)}
      loadReviewerTranscript={mock(async () => undefined as never)}
    />,
  );
}

function edgeState(id: string): string | null {
  return (
    document.querySelector(`[data-flow-edge="${id}"]`)?.getAttribute("data-edge-state") ?? null
  );
}

beforeEach(() => {
  useMultiReviewStore.setState({ workflows: new Map() });
  useMultiReviewFlowViewStore.setState({ views: new Map() });
  useMessagePartExpansionStore.getState().reset();
});
afterEach(cleanup);

describe("flow graph by phase", () => {
  test.each(PHASES)("maps nodes and edges while $name", (phase) => {
    renderTab(phase.workflow);
    const pipeline = screen.getByRole("tablist", { name: "Multi Review pipeline" });
    const states = within(pipeline)
      .getAllByRole("tab")
      .map((node) => node.dataset.flowState);
    const [packageState, reviewerStates, consolidationState, fixState] = phase.nodes;
    expect(states).toEqual([packageState, ...reviewerStates, consolidationState, fixState]);

    phase.edges.intoReviewers.forEach((state, index) =>
      expect(edgeState(`into-reviewer-${index}`)).toBe(state),
    );
    phase.edges.intoConsolidation.forEach((state, index) =>
      expect(edgeState(`into-consolidation-${index}`)).toBe(state),
    );
    expect(edgeState("into-fix")).toBe(phase.edges.intoFix);

    const selected = within(pipeline)
      .getAllByRole("tab")
      .filter((node) => node.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0]!.getAttribute("aria-label")).toStartWith(phase.selected);
  });

  test("draws pending edges dashed, live edges solid cyan and finished edges solid green", () => {
    renderTab(PHASES.find((phase) => phase.name === "reviewing")!.workflow);
    const complete = document.querySelector('[data-flow-edge="into-reviewer-0"]')!;
    const active = document.querySelector('[data-flow-edge="into-reviewer-1"]')!;
    const pendingEdge = document.querySelector('[data-flow-edge="into-reviewer-2"]')!;
    const ready = document.querySelector('[data-flow-edge="into-consolidation-0"]')!;

    expect(complete.getAttribute("class")).toContain("stroke-success");
    expect(complete.getAttribute("class")).toContain("opacity-55");
    expect(complete.getAttribute("stroke-dasharray")).toBeNull();
    expect(active.getAttribute("class")).toContain("stroke-cyan-400");
    expect(active.getAttribute("stroke-dasharray")).toBeNull();
    expect(pendingEdge.getAttribute("class")).toContain("stroke-flow-edge");
    expect(pendingEdge.getAttribute("stroke-dasharray")).toBe("4 5");
    expect(ready.getAttribute("class")).toContain("stroke-success");
    expect(ready.getAttribute("stroke-dasharray")).toBe("4 5");
    // Fan-out and fan-in are curves; the hop to Fix is level.
    expect(complete.getAttribute("d")).toContain(" C");
    expect(document.querySelector('[data-flow-edge="into-fix"]')!.getAttribute("d")).toContain(
      " L",
    );
  });

  test("labels the columns and counts finished reviewers", () => {
    renderTab(PHASES.find((phase) => phase.name === "reviewing")!.workflow);
    const pipeline = screen.getByRole("tablist", { name: "Multi Review pipeline" });
    for (const label of ["Prepare", "Review · 1/3", "Consolidate", "Fix"]) {
      expect(within(pipeline).getAllByText(label).length).toBeGreaterThan(0);
    }
  });
});

describe("flow graph nodes", () => {
  test("shows elapsed time and tokens side by side on every running node", () => {
    const originalNow = Date.now;
    Date.now = () => Date.parse("2026-08-14T00:01:35.000Z");
    try {
      renderTab(
        workflow({
          phase: "reviewing",
          reviewers: [{ ...running(0), tokenCount: 12_345 }, running(1)],
          stepRuntimes: {
            prepare: { startedAt: STARTED, completedAt: STARTED, tokenCount: 900 },
          },
        }),
      );
      const runtime = screen.getByLabelText("Reviewer 1 runtime and token usage");
      expect(runtime.textContent).toBe("1m 35s · 12k tokens");
      expect(runtime.className).toContain("text-cyan-300");
      expect(within(runtime).getByText("·").className).toContain("text-flow-edge");
      // The word "tokens" is for screen readers; the node shows the count.
      expect(within(runtime).getByText("tokens").className).toContain("sr-only");
      expect(screen.getByLabelText("Reviewer 2 runtime and token usage").textContent).toBe(
        "1m 35s · Tokens pending",
      );
      expect(screen.getByLabelText("Review package generation runtime").textContent).toBe(
        "0s · 900 tokens",
      );
    } finally {
      Date.now = originalNow;
    }
  });

  test("puts the workflow's elapsed time and total tokens in the header", () => {
    const originalNow = Date.now;
    Date.now = () => Date.parse("2026-08-14T01:02:03.000Z");
    try {
      renderTab(
        workflow({
          phase: "reviewing",
          reviewers: [
            { ...completed(0), tokenCount: 200_000 },
            { ...running(1), tokenCount: 60_000 },
          ],
          stepRuntimes: {
            prepare: { startedAt: STARTED, completedAt: STARTED, tokenCount: 52_000 },
          },
        }),
      );
      expect(screen.getByTestId("multi-review-elapsed").textContent).toBe(" · 1h 2m 3s");
      expect(screen.getByTestId("multi-review-total-tokens").textContent).toBe(" · 312k tokens");
      // The phase copy stays its own element.
      expect(screen.getByText("Independent read-only reviews are running")).toBeTruthy();
    } finally {
      Date.now = originalNow;
    }
  });

  test("truncates long model names instead of widening the node", () => {
    const model = `deepseek-${"very-long-model-name-".repeat(8)}flash`;
    renderTab(workflow({ reviewers: [{ ...completed(0), model }, running(1)] }));
    const node = screen.getByRole("tab", { name: /^Reviewer 1 ·/ });
    expect(within(node).getByText(model).className).toContain("truncate");
    expect(node.style.width).toMatch(/^\d+px$/);
  });

  test("labels queued and not-started nodes where their runtime would be", () => {
    renderTab(workflow({ phase: "reviewing" }));
    expect(
      within(screen.getByRole("tab", { name: /^Reviewer 3 ·/ })).getByText("queued"),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("tab", { name: /^Consolidation/ })).getByText("waiting"),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("tab", { name: /^Fix,/ })).getByText("not started"),
    ).toBeTruthy();
  });

  test("shows a queued reviewer's place in the admission queue, and no start estimate", () => {
    const queued = (index: number, position: number): Reviewer => ({
      ...pending(index),
      admissionState: "queued",
      queuePosition: position,
    });
    renderTab(
      workflow({
        reviewers: [
          running(0),
          { ...pending(1), admissionState: "admitting" },
          queued(2, 2),
          queued(3, 1),
          queued(4, 3),
        ],
      }),
    );
    const third = screen.getByRole("tab", { name: /^Reviewer 3 ·/ });
    expect(within(third).getByText("queued · #2 of 3")).toBeTruthy();
    expect(third.getAttribute("aria-label")).toContain("Queued · #2 of 3");
    expect(
      within(screen.getByRole("tab", { name: /^Reviewer 4 ·/ })).getByText("queued · #1 of 3"),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("tab", { name: /^Reviewer 2 ·/ })).getByText("starting"),
    ).toBeTruthy();
    fireEvent.click(third);
    expect(screen.getByTestId("multi-review-inspector-status").textContent).toBe(
      "Queued · #2 of 3",
    );
    // Position only: nothing guesses when it will start.
    expect(screen.getByTestId("multi-review-inspector").textContent).not.toMatch(
      /starts in|expected|ETA/i,
    );
  });

  test("a backend without queue fields keeps the bare queued label", () => {
    renderTab(workflow({ reviewers: [running(0), pending(1), pending(2)] }));
    expect(
      within(screen.getByRole("tab", { name: /^Reviewer 2 ·/ })).getByText("queued"),
    ).toBeTruthy();
    expect(screen.getByRole("tab", { name: /^Reviewer 2 ·/ }).getAttribute("aria-label")).toContain(
      "Queued",
    );
  });

  test("keeps validation checks on the package node", () => {
    renderTab(
      workflow({
        validationRun: {
          id: "validation-1",
          status: "completed",
          startedAt: STARTED,
          plan: { headRef: "a".repeat(40), commands: [], limitations: [] },
          results: (
            [
              ["typecheck", "passed"],
              ["cargo", "skipped"],
              ["test", "failed"],
            ] as const
          ).map(([id, status]) => ({
            id,
            command: `mise run ${id}`,
            status,
            exitCode: null,
            stdoutPath: null,
            stderrPath: null,
            stdoutBytes: 0,
            stderrBytes: 0,
            durationMs: 0,
            limitation: null,
          })),
        },
      }),
    );
    const node = screen.getByRole("tab", { name: /^Review package/ });
    const chips = node.querySelectorAll("[data-validation-status]");
    expect([...chips].map((chip) => chip.textContent)).toEqual([
      "typecheck",
      "cargo skipped",
      "test",
    ]);
    expect(chips[0]!.className).toContain("text-green-300");
    expect(chips[2]!.className).toContain("text-failure");
  });

  test("walks the pipeline with the arrow keys and opens a step with Enter", () => {
    const target = workflow({
      phase: "preparing",
      reviewers: [pending(0), pending(1)],
      fixSession: { ...fixSession("running")!, requestIds: ["prepare-1"] },
      activeRequest: { kind: "prepare", requestId: "prepare-1", state: "sent", createdAt: STARTED },
    });
    useMultiReviewStore.getState().replaceWorkflow(target);
    const createTab = mock((_type: CreatableTabType, _options?: CreateTabOptions) => true);
    function Registrar() {
      const terminal = useTerminalContext();
      useEffect(() => {
        terminal.setCreateTab(createTab);
        return () => terminal.setCreateTab(null);
      }, [terminal]);
      return null;
    }
    render(
      <TerminalProvider>
        <Registrar />
        <MultiReviewTab
          data={{ environmentId: target.environmentId, workflowId: target.id, isLocal: true }}
          isActive
          hydrateWorkflow={mock(async () => target)}
        />
      </TerminalProvider>,
    );

    const tabs = () => screen.getAllByRole("tab");
    // One tab stop: the selected node.
    expect(tabs().map((node) => node.tabIndex)).toEqual([0, -1, -1, -1, -1]);
    const packageNode = tabs()[0]!;
    packageNode.focus();
    fireEvent.keyDown(packageNode, { key: "ArrowRight" });
    expect(document.activeElement?.getAttribute("aria-label")).toStartWith("Reviewer 1 ·");
    expect(tabs()[1]!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement?.getAttribute("aria-label")).toStartWith("Reviewer 2 ·");
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement?.getAttribute("aria-label")).toStartWith("Fix,");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(document.activeElement?.getAttribute("aria-label")).toStartWith("Fix,");
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(tabs()[0]!);
    expect(screen.getByTestId("multi-review-inspector").getAttribute("aria-labelledby")).toBe(
      tabs()[0]!.id,
    );

    // Enter is a direct activation, so the backend-owned session may open.
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(createTab).toHaveBeenCalledTimes(1);
    expect(createTab.mock.calls[0]?.[1]).toMatchObject({ resumeSessionId: "provider-fix" });
  });

  test("keeps a picked node selected while the workflow moves on", () => {
    const view = renderTab(workflow({ phase: "reviewing" }));
    fireEvent.click(screen.getByRole("tab", { name: /^Reviewer 1 ·/ }));
    const next = workflow({
      phase: "consolidating",
      reviewers: allDone(),
      backendRevision: 2,
      activeRequest: { kind: "consolidate", requestId: "c-1", state: "sent", createdAt: STARTED },
    });
    act(() => useMultiReviewStore.getState().replaceWorkflow(next));
    view.rerender(
      <MultiReviewTab
        data={{ environmentId: next.environmentId, workflowId: next.id, isLocal: true }}
        isActive
        hydrateWorkflow={mock(async () => next)}
        loadReviewerTranscript={mock(async () => undefined as never)}
      />,
    );
    expect(screen.getByRole("tab", { name: /^Reviewer 1 ·/ }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });
});

function node(
  id: string,
  kind: MultiReviewFlowNodeModel["kind"],
  state: MultiReviewFlowState,
): MultiReviewFlowNodeModel {
  return {
    id,
    kind,
    title: id,
    state,
    stalled: false,
    statusLabel: state,
    detail: "codex · gpt-5.6",
    runtime: null,
    runtimeLabel: `${id} runtime`,
    canOpen: false,
    onOpen: () => undefined,
    contextMenu: null,
  };
}

describe("stacked layout", () => {
  const props = {
    packageNode: node("package", "package", "complete"),
    reviewerNodes: [
      node("reviewer:1", "reviewer", "complete"),
      node("reviewer:2", "reviewer", "running"),
    ],
    consolidationNode: node("consolidation", "consolidation", "not-started"),
    fixNode: node("fix", "fix", "not-started"),
    edges: {
      intoReviewers: ["complete", "active"] as MultiReviewFlowEdgeState[],
      intoConsolidation: ["ready", "pending"] as MultiReviewFlowEdgeState[],
      intoFix: "pending" as const,
    },
    reviewLabel: "Review · 1/2",
    selectedId: "reviewer:2",
    onSelect: () => undefined,
    panelId: "panel",
    viewKey: "workflow-stacked",
  };

  test("stacks the nodes in pipeline order with one straight connector per hop", () => {
    render(<MultiReviewFlowGraph {...props} layout="stacked" />);
    expect(document.querySelector("[data-flow-layout]")?.getAttribute("data-flow-layout")).toBe(
      "stacked",
    );
    expect(screen.getAllByRole("tab").map((tab) => tab.getAttribute("aria-label"))).toEqual([
      "package, complete",
      "reviewer:1, complete",
      "reviewer:2, running",
      "consolidation, not-started",
      "fix, not-started",
    ]);
    expect(document.querySelector("path[data-flow-edge]") === null).toBe(true);
    expect(edgeState("into-reviewers")).toBe("active");
    expect(edgeState("into-consolidation")).toBe("ready");
    expect(edgeState("into-fix")).toBe("pending");
    expect(document.querySelector('[data-flow-edge="into-fix"]')!.className).toContain(
      "border-dashed",
    );
  });

  test("switches to the stacked layout below the threshold width", () => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get: () => 720,
    });
    try {
      render(<MultiReviewFlowGraph {...props} />);
      expect(document.querySelector("[data-flow-layout]")?.getAttribute("data-flow-layout")).toBe(
        "stacked",
      );
    } finally {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, "clientWidth", descriptor);
      else delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
    }
  });

  test("lays the graph out left to right at desktop width", () => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get: () => 1440,
    });
    try {
      render(<MultiReviewFlowGraph {...props} />);
      expect(document.querySelector("[data-flow-layout]")?.getAttribute("data-flow-layout")).toBe(
        "graph",
      );
      const reviewer = screen.getByRole("tab", { name: "reviewer:1, complete" });
      expect(reviewer.style.position).toBe("absolute");
      expect(reviewer.style.width).toBe("270px");
    } finally {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, "clientWidth", descriptor);
      else delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
    }
  });
});

describe("failed nodes", () => {
  const error =
    "The reviewer session ended before it filed a report.\nProvider said: rate limited after 3 retries";

  test("shows a one-line excerpt of a failed reviewer's error and keeps the whole text", () => {
    renderTab(workflow({ reviewers: [{ ...failed(0), error }, running(1)] }));
    const node = screen.getByRole("tab", { name: /^Reviewer 1 ·/ });
    const excerpt = node.querySelector<HTMLElement>("[data-flow-node-error]")!;
    expect(excerpt.textContent).toBe(
      "The reviewer session ended before it filed a report. Provider said: rate limited after 3 retries",
    );
    expect(excerpt.className).toContain("truncate");
    expect(excerpt.className).toContain("text-failure");
    // The whole error is the node's accessible description.
    expect(node.getAttribute("aria-describedby")).toBe(excerpt.id);
    // The error takes the model's place and replaces the bare "failed" word.
    expect(within(node).queryByText("opus") === null).toBe(true);
    expect(within(node).queryByText("failed") === null).toBe(true);
    expect(node.getAttribute("title")).toBeNull();
    expect(screen.queryByRole("tooltip") === null).toBe(true);
  });

  test("opens the full error in a tooltip when the node is reached from the keyboard", async () => {
    renderTab(workflow({ reviewers: [{ ...failed(0), error }, running(1)] }));
    const running2 = screen.getByRole("tab", { name: /^Reviewer 2 ·/ });
    fireEvent.click(running2);
    running2.focus();
    fireEvent.keyDown(running2, { key: "ArrowUp" });
    const failedNode = screen.getByRole("tab", { name: /^Reviewer 1 ·/ });
    expect(document.activeElement).toBe(failedNode);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toContain("The reviewer session ended before it filed a report.");
    expect(tooltip.textContent).toContain("Provider said: rate limited after 3 retries");
    fireEvent.keyDown(failedNode, { key: "Escape" });
    expect(screen.queryByRole("tooltip") === null).toBe(true);
  });

  test("keeps a partial report's severity beside the error", () => {
    renderTab(workflow({ reviewers: [{ ...failed(0), error, report }, running(1)] }));
    const node = screen.getByRole("tab", { name: /^Reviewer 1 ·/ });
    expect(node.querySelector("[data-flow-node-error]")).toBeTruthy();
    expect(node.querySelector('[data-severity="P0"]')?.textContent).toBe("1");
  });

  test("shows why a failed consolidation stopped, and nothing on steps that did not fail", () => {
    renderTab(
      workflow({
        phase: "failed",
        reviewers: allDone(),
        error: "Consolidation returned an invalid report twice",
        activeRequest: { kind: "consolidate", requestId: "c-1", state: "sent", createdAt: STARTED },
      }),
    );
    const consolidation = screen.getByRole("tab", { name: /^Consolidation/ });
    expect(consolidation.querySelector("[data-flow-node-error]")?.textContent).toBe(
      "Consolidation returned an invalid report twice",
    );
    for (const name of [/^Review package/, /^Fix,/, /^Reviewer 1 ·/]) {
      expect(
        screen.getByRole("tab", { name }).querySelector("[data-flow-node-error]") === null,
      ).toBe(true);
    }
  });

  test("shows the error an interactive fix session stopped with", () => {
    renderTab(
      workflow({
        phase: "interactive",
        reviewers: allDone(),
        consolidatedReport: report,
        fixSession: { ...fixSession("idle")!, status: "failed", error: "Codex exited with code 1" },
      }),
    );
    const fix = screen.getByRole("tab", { name: /^Fix,/ });
    expect(fix.dataset.flowState).toBe("failed");
    expect(fix.querySelector("[data-flow-node-error]")?.textContent).toBe(
      "Codex exited with code 1",
    );
  });

  test("a failed node with no recorded error keeps its model and the failed word", () => {
    renderTab(workflow({ reviewers: [{ ...failed(0), error: undefined }, running(1)] }));
    const node = screen.getByRole("tab", { name: /^Reviewer 1 ·/ });
    expect(node.querySelector("[data-flow-node-error]") === null).toBe(true);
    expect(within(node).getByText("opus")).toBeTruthy();
    expect(within(node).getByText("failed")).toBeTruthy();
    expect(node.getAttribute("aria-describedby")).toBeNull();
  });
});

describe("zoom and pan", () => {
  const panel = (count: number): MultiReviewFlowGraphProps => ({
    packageNode: node("package", "package", "complete"),
    reviewerNodes: Array.from({ length: count }, (_, index) =>
      node(`reviewer:${index + 1}`, "reviewer", "running"),
    ),
    consolidationNode: node("consolidation", "consolidation", "not-started"),
    fixNode: node("fix", "fix", "not-started"),
    edges: {
      intoReviewers: Array.from({ length: count }, () => "active" as const),
      intoConsolidation: Array.from({ length: count }, () => "pending" as const),
      intoFix: "pending",
    },
    reviewLabel: `Review · 0/${count}`,
    selectedId: "reviewer:1",
    onSelect: () => undefined,
    panelId: "panel",
    viewKey: "workflow-zoom",
    layout: "graph",
  });

  function SelectableGraph(props: MultiReviewFlowGraphProps) {
    const [selectedId, setSelectedId] = useState(props.selectedId);
    return <MultiReviewFlowGraph {...props} selectedId={selectedId} onSelect={setSelectedId} />;
  }

  const zoomLevel = () => screen.getByTestId("multi-review-zoom-level").textContent;
  const viewport = () => document.querySelector<HTMLElement>("[data-flow-viewport]")!;
  const geometry = (count: number) =>
    multiReviewFlowLayout({ width: 1440, reviewerCount: count, packageHasChips: false });

  test("zooms in and out within bounds and resets to 100%", () => {
    render(<MultiReviewFlowGraph {...panel(4)} />);
    const zoomIn = screen.getByRole("button", { name: "Zoom in" });
    const zoomOut = screen.getByRole("button", { name: "Zoom out" });
    expect(zoomLevel()).toBe("100%");
    for (let click = 0; click < 10; click += 1) fireEvent.click(zoomIn);
    expect(zoomLevel()).toBe("200%");
    expect((zoomIn as HTMLButtonElement).disabled).toBe(true);
    for (let click = 0; click < 20; click += 1) fireEvent.click(zoomOut);
    expect(zoomLevel()).toBe("20%");
    expect((zoomOut as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Zoom 20%, reset to 100%" }));
    expect(zoomLevel()).toBe("100%");
  });

  test("scales the canvas rather than relaying it out", () => {
    render(<MultiReviewFlowGraph {...panel(2)} />);
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    const canvas = screen.getByRole("tablist", { name: "Multi Review pipeline" });
    expect(canvas.style.transform).toBe("scale(1.25)");
    expect(screen.getByRole("tab", { name: "reviewer:1, running" }).style.width).toBe("270px");
    const sizer = canvas.parentElement!;
    expect(sizer.style.width).toBe(`${geometry(2).width * 1.25}px`);
  });

  test("fits the 32-reviewer maximum inside the viewport", () => {
    render(<MultiReviewFlowGraph {...panel(32)} />);
    const layout = geometry(32);
    const height = flowViewportHeight(layout.height);
    expect(viewport().style.height).toBe(`${height}px`);
    fireEvent.click(screen.getByRole("button", { name: "Fit the whole pipeline" }));
    const fit = fitFlowZoom(
      { width: layout.width, height: layout.height },
      { width: 1440, height },
    );
    expect(fit).toBeLessThan(0.33);
    expect(zoomLevel()).toBe(`${Math.round(fit * 100)}%`);
    const sizer = screen.getByRole("tablist", { name: "Multi Review pipeline" }).parentElement!;
    expect(Number.parseFloat(sizer.style.height)).toBeLessThanOrEqual(height);
    expect(Number.parseFloat(sizer.style.width)).toBeLessThanOrEqual(1440);
  });

  test("keeps a node reached from the keyboard in view", () => {
    render(<SelectableGraph {...panel(32)} />);
    const layout = geometry(32);
    const height = flowViewportHeight(layout.height);
    screen.getByRole("tab", { name: "reviewer:1, running" }).focus();
    for (let step = 1; step < 20; step += 1) {
      fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    }
    expect(document.activeElement?.getAttribute("aria-label")).toBe("reviewer:20, running");
    const rect = layout.reviewers[19]!;
    const { scrollTop } = viewport();
    expect(scrollTop).toBeGreaterThan(0);
    expect(rect.y - scrollTop).toBeGreaterThanOrEqual(0);
    expect(rect.y + rect.height - scrollTop).toBeLessThanOrEqual(height);

    // At another zoom the scaled position is what has to be visible.
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    const fix = layout.fix;
    const zoomed = viewport();
    expect(fix.y * 1.25 - zoomed.scrollTop).toBeGreaterThanOrEqual(0);
    expect((fix.y + fix.height) * 1.25 - zoomed.scrollTop).toBeLessThanOrEqual(height);
    expect((fix.x + fix.width) * 1.25 - zoomed.scrollLeft).toBeLessThanOrEqual(1440);
  });

  test("zooms with Ctrl + wheel or a pinch, and leaves a plain wheel to scrolling", () => {
    render(<MultiReviewFlowGraph {...panel(4)} />);
    // happy-dom's WheelEvent drops modifier keys from its init dictionary.
    const wheel = (deltaY: number, ctrlKey: boolean) => {
      const event = new WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true });
      Object.defineProperty(event, "ctrlKey", { value: ctrlKey });
      act(() => {
        viewport().dispatchEvent(event);
      });
      return event;
    };
    expect(wheel(-100, false).defaultPrevented).toBe(false);
    expect(zoomLevel()).toBe("100%");
    // A pinch arrives as Ctrl + wheel, which must not zoom the whole window.
    expect(wheel(-100, true).defaultPrevented).toBe(true);
    expect(zoomLevel()).toBe("141%");
    wheel(100, true);
    expect(zoomLevel()).toBe("100%");
    for (let notch = 0; notch < 20; notch += 1) wheel(100, true);
    expect(zoomLevel()).toBe("20%");
  });

  test("pans by dragging the canvas, but not from a node", () => {
    render(<MultiReviewFlowGraph {...panel(32)} />);
    const element = viewport();
    fireEvent.pointerDown(screen.getByRole("tab", { name: "reviewer:1, running" }), {
      button: 0,
      pointerId: 1,
      pointerType: "mouse",
      clientX: 400,
      clientY: 400,
    });
    fireEvent.pointerMove(element, { pointerId: 1, clientX: 300, clientY: 100 });
    expect(element.scrollTop).toBe(0);
    fireEvent.pointerDown(element, {
      button: 0,
      pointerId: 2,
      pointerType: "mouse",
      clientX: 400,
      clientY: 400,
    });
    fireEvent.pointerMove(element, { pointerId: 2, clientX: 400, clientY: 100 });
    expect(element.scrollTop).toBe(300);
    fireEvent.pointerUp(element, { pointerId: 2 });
    fireEvent.pointerMove(element, { pointerId: 2, clientX: 400, clientY: 0 });
    expect(element.scrollTop).toBe(300);
  });

  test("the stacked layout has the same controls and bounds, with 44 px targets", () => {
    render(<MultiReviewFlowGraph {...panel(4)} layout="stacked" />);
    const controls = screen.getByRole("group", { name: "Zoom" });
    for (const name of ["Zoom out", "Zoom in", "Fit the whole pipeline"]) {
      expect(within(controls).getByRole("button", { name }).className).toContain("size-11");
    }
    expect(screen.getByTestId("multi-review-zoom-level").className).toContain("h-11");
    // The page, not the column, scrolls vertically; the browser leaves pinch to it.
    const viewport = document.querySelector<HTMLElement>("[data-flow-viewport]")!;
    expect(viewport.className).toContain("overflow-y-hidden");
    expect(viewport.className).toContain("[touch-action:pan-x_pan-y]");

    const zoomIn = screen.getByRole("button", { name: "Zoom in" }) as HTMLButtonElement;
    const zoomOut = screen.getByRole("button", { name: "Zoom out" }) as HTMLButtonElement;
    for (let click = 0; click < 10; click += 1) fireEvent.click(zoomIn);
    expect(zoomLevel()).toBe("200%");
    expect(zoomIn.disabled).toBe(true);
    for (let click = 0; click < 20; click += 1) fireEvent.click(zoomOut);
    expect(zoomLevel()).toBe("20%");
    expect(zoomOut.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Zoom 20%, reset to 100%" }));
    expect(zoomLevel()).toBe("100%");
    // Unmeasured, Fit leaves the column as it is rather than guessing.
    fireEvent.click(screen.getByRole("button", { name: "Fit the whole pipeline" }));
    expect(zoomLevel()).toBe("100%");
  });

  test("the stacked and wide layouts each keep their own view", () => {
    const stacked = render(<MultiReviewFlowGraph {...panel(4)} layout="stacked" />);
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(zoomLevel()).toBe("125%");
    stacked.unmount();

    const wide = render(<MultiReviewFlowGraph {...panel(4)} layout="graph" />);
    expect(zoomLevel()).toBe("100%");
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(zoomLevel()).toBe("80%");
    wide.unmount();

    const views = useMultiReviewFlowViewStore.getState().views;
    expect(views.get("workflow-zoom")?.zoom).toBe(0.8);
    expect(views.get("workflow-zoom\u0000stacked")?.zoom).toBe(1.25);
    const again = render(<MultiReviewFlowGraph {...panel(4)} layout="stacked" />);
    expect(zoomLevel()).toBe("125%");
    again.unmount();
    render(<MultiReviewFlowGraph {...panel(4)} layout="graph" />);
    expect(zoomLevel()).toBe("80%");
  });

  test("a two-finger pinch zooms either layout, and one finger leaves scrolling alone", () => {
    for (const layout of ["stacked", "graph"] as const) {
      const view = render(<MultiReviewFlowGraph {...panel(4)} layout={layout} />);
      const viewport = document.querySelector<HTMLElement>("[data-flow-viewport]")!;
      const touch = (type: string, points: Array<[number, number]>) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, "touches", {
          value: points.map(([clientX, clientY]) => ({ clientX, clientY })),
        });
        act(() => {
          viewport.dispatchEvent(event);
        });
        return event;
      };
      touch("touchstart", [[100, 100]]);
      expect(touch("touchmove", [[100, 300]]).defaultPrevented).toBe(false);
      expect(zoomLevel()).toBe("100%");
      touch("touchstart", [
        [100, 100],
        [200, 100],
      ]);
      // Fingers spread to twice the distance: twice the zoom.
      const spread = touch("touchmove", [
        [50, 100],
        [250, 100],
      ]);
      expect(spread.defaultPrevented).toBe(true);
      expect(zoomLevel()).toBe("200%");
      touch("touchend", []);
      view.unmount();
      useMultiReviewFlowViewStore.setState({ views: new Map() });
    }
  });

  test("remembers zoom per workflow between visits", () => {
    const first = workflow({ id: "multi-flow-a" });
    const view = renderTab(first);
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(zoomLevel()).toBe("150%");
    view.unmount();

    const other = renderTab(workflow({ id: "multi-flow-b" }));
    expect(zoomLevel()).toBe("100%");
    other.unmount();

    renderTab(first);
    expect(zoomLevel()).toBe("150%");
    // Nothing about the view reaches the workflow record.
    expect(useMultiReviewStore.getState().workflows.get(first.id)).toEqual(first);
  });

  test("resets zoom and pan when the panel width changes", () => {
    const content = { width: 1440, height: 2_400 };
    const hook = renderHook(
      ({ width }: { width: number | null }) =>
        useFlowViewport({ viewKey: "workflow-resize", measuredWidth: width, content }),
      { initialProps: { width: 1200 as number | null } },
    );
    act(() => hook.result.current.zoomBy(1));
    expect(hook.result.current.zoom).toBe(1.25);
    expect(useMultiReviewFlowViewStore.getState().views.get("workflow-resize")?.width).toBe(1200);

    hook.rerender({ width: 1000 });
    expect(hook.result.current.zoom).toBe(1);
    expect(useMultiReviewFlowViewStore.getState().views.has("workflow-resize")).toBe(false);

    // Going back to the old width does not bring the old view back.
    hook.rerender({ width: 1200 });
    expect(hook.result.current.zoom).toBe(1);
  });

  test("restores a remembered view only at the width it was taken at", () => {
    useMultiReviewFlowViewStore
      .getState()
      .saveView("workflow-restore", { zoom: 0.5, scrollLeft: 0, scrollTop: 40, width: 1200 });
    const content = { width: 1440, height: 2_400 };
    const before = renderHook(
      ({ width }: { width: number | null }) =>
        useFlowViewport({ viewKey: "workflow-restore", measuredWidth: width, content }),
      { initialProps: { width: null as number | null } },
    );
    // Until the width is measured nothing is restored, and nothing is lost.
    expect(before.result.current.zoom).toBe(1);
    before.rerender({ width: 1200 });
    expect(before.result.current.zoom).toBe(0.5);
    before.unmount();

    renderHook(() => useFlowViewport({ viewKey: "workflow-restore", measuredWidth: 900, content }));
    expect(useMultiReviewFlowViewStore.getState().views.has("workflow-restore")).toBe(false);
  });
});

describe("step transcript tails", () => {
  function renderWithStepTail(target: MultiReviewWorkflow) {
    useMultiReviewStore.getState().replaceWorkflow(target);
    const loadStepTranscript = mock(
      async (workflowId: string, step: "prepare" | "consolidate" | "fix") => ({
        workflowId,
        step,
        workflowPhase: target.phase,
        session: "own" as const,
        agent: "codex" as const,
        transcript: "snapshot" as const,
        messages: [
          {
            id: `${step}-1`,
            role: "assistant",
            content: "",
            createdAt: STARTED,
            parts: [{ type: "text", content: `Working on ${step}` }],
          },
        ],
      }),
    );
    render(
      <MultiReviewTab
        data={{ environmentId: target.environmentId, workflowId: target.id, isLocal: true }}
        isActive
        hydrateWorkflow={mock(async () => target)}
        loadReviewerTranscript={mock(async () => undefined as never)}
        loadStepTranscript={loadStepTranscript}
      />,
    );
    return loadStepTranscript;
  }

  test("shows the selected step's own session tail in the inspector", async () => {
    const loadStepTranscript = renderWithStepTail(
      workflow({
        phase: "consolidating",
        reviewers: allDone(),
        reviewModel: { agent: "codex", model: "gpt-5.6" },
        reviewSession: { ...fixSession("running")!, providerSessionId: "consolidation" },
        activeRequest: { kind: "consolidate", requestId: "c-1", state: "sent", createdAt: STARTED },
      }),
    );
    const tail = await screen.findByRole("log", { name: "Latest consolidation activity" });
    expect(await within(tail).findByText("Working on consolidate")).toBeTruthy();
    expect(loadStepTranscript.mock.calls[0]?.slice(0, 2)).toEqual(["multi-flow", "consolidate"]);
  });

  test("does not read a step whose shared session another step is using", () => {
    // Every step of this older workflow runs in the fix session; consolidation
    // is using it, so the Fix step has nothing of its own to show.
    const loadStepTranscript = renderWithStepTail(
      workflow({
        phase: "consolidating",
        reviewers: allDone(),
        fixSession: fixSession("running"),
        activeRequest: { kind: "consolidate", requestId: "c-1", state: "sent", createdAt: STARTED },
      }),
    );
    fireEvent.click(screen.getByRole("tab", { name: /^Fix,/ }));
    expect(
      screen.getByText(
        "This step's session is now running consolidation. Open session to read the whole conversation.",
      ),
    ).toBeTruthy();
    expect(loadStepTranscript.mock.calls.map((call) => call[1])).not.toContain("fix");
  });
});

describe("provisional findings", () => {
  const reported = (title: string) => ({
    id: title.replace(/\W/g, "").toLowerCase().padEnd(24, "0").slice(0, 24),
    reportedAt: STARTED,
    issue: { ...report.issues[0]!, title, file: "src/live.ts", line: 3 },
  });

  test("lists what live and failed reviewers reported, marked, beside confirmed findings", () => {
    renderTab(
      workflow({
        reviewers: [
          completed(0),
          { ...running(1), provisionalFindings: [reported("Reported while running")] },
          { ...failed(2), provisionalFindings: [reported("Reported before failing")] },
        ],
      }),
    );
    expect(screen.getByTestId("multi-review-findings-count").textContent).toBe(
      "1 · from 1 reviewer · 2 provisional",
    );
    const rows = screen.getAllByRole("listitem");
    const standing = (title: string) =>
      within(rows.find((row) => row.textContent?.includes(title))!).queryByTestId(
        "multi-review-finding-standing",
      )?.textContent ?? null;
    expect(standing("Shared finding")).toBeNull();
    expect(standing("Reported while running")).toBe("provisional");
    expect(standing("Reported before failing")).toBe("unconfirmed (reviewer failed)");

    fireEvent.click(screen.getByRole("tab", { name: /^Reviewer 2 ·/ }));
    expect(screen.getByTestId("multi-reviewer-provisional-reviewer-2").textContent).toBe(
      "1 finding reported so far, provisional until the report is accepted",
    );
    fireEvent.click(screen.getByRole("tab", { name: /^Reviewer 3 ·/ }));
    expect(screen.getByTestId("multi-reviewer-provisional-reviewer-3").textContent).toBe(
      "1 finding reported before it failed, unconfirmed",
    );
  });

  test("a backend without provisional findings shows confirmed reports only, as before", () => {
    renderTab(workflow({ reviewers: [completed(0), running(1)] }));
    expect(screen.getByTestId("multi-review-findings-count").textContent).toBe(
      "1 · from 1 reviewer",
    );
    expect(screen.queryByTestId("multi-review-finding-standing") === null).toBe(true);
  });
});
