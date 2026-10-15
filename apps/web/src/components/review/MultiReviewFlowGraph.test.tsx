import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { useEffect } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { MultiReviewWorkflow } from "@orkestrator/protocol/multi-review";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import {
  TerminalProvider,
  useTerminalContext,
  type CreatableTabType,
  type CreateTabOptions,
} from "@/contexts";
import { useMessagePartExpansionStore } from "@/stores/messagePartExpansionStore";
import { useMultiReviewStore } from "@/stores/multiReviewStore";
import { MultiReviewTab } from "./MultiReviewTab";
import { MultiReviewFlowGraph, type MultiReviewFlowNodeModel } from "./MultiReviewFlowGraph";
import type { MultiReviewFlowEdgeState, MultiReviewFlowState } from "./multi-review-flow";

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
