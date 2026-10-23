import { describe, expect, test } from "bun:test";
import type { MultiReviewWorkflow } from "@orkestrator/protocol/multi-review";
import type { ReviewIssue, StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import {
  FLOW_GRAPH_MIN_HEIGHT,
  FLOW_GRAPH_STACK_BELOW,
  defaultFlowSelection,
  flowEdgePath,
  flowPendingLabel,
  mergeReviewerFindings,
  multiReviewElapsedSeconds,
  multiReviewFlowEdgeState,
  multiReviewFlowEdges,
  multiReviewFlowLayout,
  multiReviewTotalTokens,
  provisionalFindingLabel,
  reviewerFlowState,
  severityCounts,
  summarizeFlowEdges,
  type FlowRect,
  type MultiReviewFlowState,
} from "./multi-review-flow";

type Reviewer = MultiReviewWorkflow["reviewers"][number];

function issue(severity: ReviewIssue["severity"], title: string, file = "src/a.ts", line = 1) {
  return {
    severity,
    confidence: 90,
    category: "correctness" as const,
    title,
    file,
    line,
    symbol: "",
    description: title,
    evidence: "",
    suggestion: "",
    verification: "",
  };
}

function report(issues: ReviewIssue[]): StructuredReviewReport {
  return { issues } as unknown as StructuredReviewReport;
}

function reviewer(index: number, overrides: Partial<Reviewer> = {}): Reviewer {
  return {
    id: `reviewer-${index + 1}`,
    agent: index % 2 === 0 ? "claude" : "codex",
    model: index % 2 === 0 ? "opus" : "gpt-5.6",
    status: "completed",
    ...overrides,
  };
}

function workflow(overrides: Partial<MultiReviewWorkflow> = {}): MultiReviewWorkflow {
  return {
    version: 1,
    controller: "backend",
    id: "multi-1",
    environmentId: "env-1",
    projectId: "project-1",
    targetBranch: "main",
    phase: "ready",
    reviewers: [],
    fixModel: { agent: "codex", model: "gpt-5.6" },
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:30:00.000Z",
    backendRevision: 1,
    ...overrides,
  };
}

describe("node and edge states", () => {
  test("maps every reviewer status onto the shared node vocabulary", () => {
    expect(reviewerFlowState("pending")).toBe("not-started");
    expect(reviewerFlowState("running")).toBe("running");
    expect(reviewerFlowState("completed")).toBe("complete");
    expect(reviewerFlowState("failed")).toBe("failed");
    expect(reviewerFlowState("cancelled")).toBe("cancelled");
  });

  test("an unfinished source flows nothing, whatever its target is doing", () => {
    const targets: MultiReviewFlowState[] = [
      "not-started",
      "running",
      "paused",
      "complete",
      "failed",
      "cancelling",
      "cancelled",
    ];
    for (const from of ["not-started", "running", "failed", "cancelled"] as const) {
      for (const to of targets) {
        expect(multiReviewFlowEdgeState(from, to, { waitingIsReady: true })).toBe("pending");
      }
    }
  });

  test("a finished source takes its edge style from the target", () => {
    const edge = (to: MultiReviewFlowState, waitingIsReady = true) =>
      multiReviewFlowEdgeState("complete", to, { waitingIsReady });
    expect(edge("running")).toBe("active");
    expect(edge("complete")).toBe("complete");
    expect(edge("failed")).toBe("failed");
    expect(edge("not-started")).toBe("ready");
    expect(edge("paused")).toBe("ready");
    expect(edge("cancelled")).toBe("pending");
    expect(edge("cancelling")).toBe("pending");
    // A queued reviewer waits for admission, not for more input.
    expect(edge("not-started", false)).toBe("pending");
  });

  test("builds every edge of a mid-review panel", () => {
    expect(
      multiReviewFlowEdges({
        package: "complete",
        reviewers: ["complete", "running", "not-started", "failed", "cancelled"],
        consolidation: "not-started",
        fix: "not-started",
        pr: "not-started",
      }),
    ).toEqual({
      intoReviewers: ["complete", "active", "pending", "failed", "pending"],
      intoConsolidation: ["ready", "pending", "pending", "pending", "pending"],
      intoFix: "pending",
      intoPr: "pending",
      prSource: "fix",
    });
    expect(
      multiReviewFlowEdges({
        package: "complete",
        reviewers: ["complete", "cancelled"],
        consolidation: "complete",
        fix: "running",
        pr: "not-started",
      }),
    ).toEqual({
      intoReviewers: ["complete", "pending"],
      intoConsolidation: ["complete", "pending"],
      intoFix: "active",
      intoPr: "pending",
      prSource: "fix",
    });
  });

  test("feeds the PR from the Fix, or from consolidation after a clean report", () => {
    const states = {
      package: "complete",
      reviewers: ["complete"],
      consolidation: "complete",
      fix: "complete",
      pr: "running",
    } as const;
    expect(multiReviewFlowEdges(states).intoPr).toBe("active");
    expect(multiReviewFlowEdges({ ...states, pr: "not-started" }).intoPr).toBe("ready");
    expect(
      multiReviewFlowEdges({ ...states, fix: "not-started", prFromConsolidation: true }).intoPr,
    ).toBe("active");
    expect(multiReviewFlowEdges({ ...states, fix: "not-started" }).intoPr).toBe("pending");
  });

  test("summarises a group of edges for the stacked layout", () => {
    expect(summarizeFlowEdges(["complete", "active", "pending"])).toBe("active");
    expect(summarizeFlowEdges(["complete", "failed"])).toBe("failed");
    expect(summarizeFlowEdges(["complete", "pending"])).toBe("complete");
    expect(summarizeFlowEdges(["ready", "pending"])).toBe("ready");
    expect(summarizeFlowEdges([])).toBe("pending");
  });

  test("labels a node that has not run", () => {
    expect(flowPendingLabel("reviewer", "Queued")).toBe("queued");
    expect(flowPendingLabel("step", "Waiting for reviews")).toBe("waiting");
    expect(flowPendingLabel("step", "Waiting for review package")).toBe("waiting");
    expect(flowPendingLabel("step", "Ready to start")).toBe("ready");
    expect(flowPendingLabel("step", "Not started")).toBe("not started");
  });
});

describe("default selection", () => {
  test("prefers a running node, then a paused one, in pipeline order", () => {
    expect(
      defaultFlowSelection([
        { id: "package", state: "complete", stage: 0, activityAt: 30 },
        { id: "reviewer:1", state: "running", stage: 1 },
        { id: "reviewer:2", state: "running", stage: 1 },
        { id: "consolidation", state: "paused", stage: 2 },
      ]),
    ).toBe("reviewer:1");
    expect(
      defaultFlowSelection([
        { id: "package", state: "complete", stage: 0 },
        { id: "consolidation", state: "paused", stage: 2 },
      ]),
    ).toBe("consolidation");
  });

  test("otherwise picks the furthest stage reached, then its latest activity", () => {
    // A later step ran after the reviewers even without its own timestamps.
    expect(
      defaultFlowSelection([
        { id: "package", state: "complete", stage: 0 },
        { id: "reviewer:1", state: "complete", stage: 1, activityAt: 90 },
        { id: "consolidation", state: "complete", stage: 2 },
        { id: "fix", state: "not-started", stage: 3 },
      ]),
    ).toBe("consolidation");
    // Among parallel reviewers the latest wins; a queued one never does.
    expect(
      defaultFlowSelection([
        { id: "package", state: "complete", stage: 0, activityAt: 10 },
        { id: "reviewer:1", state: "failed", stage: 1, activityAt: 50 },
        { id: "reviewer:2", state: "complete", stage: 1, activityAt: 40 },
        { id: "reviewer:3", state: "not-started", stage: 1, activityAt: 90 },
        { id: "fix", state: "not-started", stage: 3 },
      ]),
    ).toBe("reviewer:1");
  });

  test("does not treat a step cancelled before it ran as reached", () => {
    expect(
      defaultFlowSelection([
        { id: "package", state: "complete", stage: 0 },
        { id: "reviewer:1", state: "complete", stage: 1, activityAt: 20 },
        { id: "reviewer:2", state: "cancelled", stage: 1, activityAt: 20 },
        { id: "consolidation", state: "cancelling", stage: 2 },
        { id: "fix", state: "cancelled", stage: 3 },
      ]),
    ).toBe("reviewer:2");
    expect(defaultFlowSelection([{ id: "package", state: "not-started", stage: 0 }])).toBe(
      "package",
    );
    expect(defaultFlowSelection([])).toBeNull();
  });
});

describe("findings so far", () => {
  test("merges the same issue from several completed reviewers and keeps the worst severity", () => {
    const { findings, reviewerCount } = mergeReviewerFindings([
      reviewer(0, {
        report: report([
          issue("P2", "Shared  finding", "src/a.ts", 4),
          issue("P1", "Only first", "src/b.ts", 9),
        ]),
      }),
      reviewer(1, { report: report([issue("P0", "shared finding", "src/a.ts", 4)]) }),
      // Partial reports from unfinished reviewers are not findings so far.
      reviewer(2, { status: "failed", report: report([issue("P0", "Partial", "src/c.ts")]) }),
      reviewer(3, { status: "running" }),
    ]);
    expect(reviewerCount).toBe(2);
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({
      severity: "P0",
      title: "Shared  finding",
      file: "src/a.ts",
      line: 4,
    });
    expect(findings[0]!.sources.map((source) => source.index)).toEqual([0, 1]);
    expect(findings[1]).toMatchObject({ severity: "P1", title: "Only first" });
  });

  test("orders by severity, then by how many reviewers agree", () => {
    const { findings } = mergeReviewerFindings([
      reviewer(0, {
        report: report([
          issue("P2", "Low", "z.ts"),
          issue("P1", "Single", "a.ts"),
          issue("P1", "Agreed", "b.ts"),
        ]),
      }),
      reviewer(1, { report: report([issue("P1", "Agreed", "b.ts")]) }),
    ]);
    expect(findings.map((finding) => finding.title)).toEqual(["Agreed", "Single", "Low"]);
  });

  test("counts a clean reviewer and reports nothing before any reviewer finishes", () => {
    expect(mergeReviewerFindings([reviewer(0, { report: report([]) })])).toEqual({
      findings: [],
      reviewerCount: 1,
      provisionalCount: 0,
    });
    expect(mergeReviewerFindings([reviewer(0, { status: "running" })])).toEqual({
      findings: [],
      reviewerCount: 0,
      provisionalCount: 0,
    });
  });

  test("adds what live reviewers reported, marked provisional until a report confirms it", () => {
    const reported = (
      title: string,
      severity: ReviewIssue["severity"] = "P1",
      file = "src/a.ts",
    ) => ({
      id: title.padEnd(24, "0").slice(0, 24),
      reportedAt: "2026-10-16T00:00:00.000Z",
      issue: issue(severity, title, file),
    });
    const { findings, reviewerCount, provisionalCount } = mergeReviewerFindings([
      reviewer(0, { report: report([issue("P1", "Confirmed", "src/c.ts")]) }),
      reviewer(1, {
        status: "running",
        // The same finding a completed report already has: the report decides.
        provisionalFindings: [reported("Confirmed", "P0", "src/c.ts"), reported("Live only")],
      }),
      reviewer(2, { status: "failed", provisionalFindings: [reported("From a failure", "P2")] }),
      reviewer(3, { status: "cancelled", provisionalFindings: [reported("From a stop", "P2")] }),
      // Pending reviewers have reported nothing.
      reviewer(4, { status: "pending" }),
    ]);
    expect(reviewerCount).toBe(1);
    expect(provisionalCount).toBe(3);
    const confirmed = findings.find((finding) => finding.title === "Confirmed")!;
    expect(confirmed).toMatchObject({ provisional: false, severity: "P1" });
    expect(confirmed.sources.map((source) => source.standing)).toEqual([
      "confirmed",
      "provisional",
    ]);
    expect(provisionalFindingLabel(confirmed)).toBeNull();
    const label = (title: string) =>
      provisionalFindingLabel(findings.find((finding) => finding.title === title)!);
    expect(label("Live only")).toBe("provisional");
    expect(label("From a failure")).toBe("unconfirmed (reviewer failed)");
    expect(label("From a stop")).toBe("unconfirmed (reviewer stopped)");
    // Within a severity, confirmed rows lead.
    expect(findings.map((finding) => finding.title)).toEqual([
      "Confirmed",
      "Live only",
      "From a failure",
      "From a stop",
    ]);
  });

  test("counts issues per severity", () => {
    expect(severityCounts([issue("P0", "a"), issue("P2", "b"), issue("P2", "c")])).toEqual({
      P0: 1,
      P1: 0,
      P2: 2,
    });
  });
});

describe("workflow totals", () => {
  test("adds every reviewer to each step's own token record", () => {
    expect(
      multiReviewTotalTokens(
        workflow({
          reviewers: [reviewer(0, { tokenCount: 1_000 }), reviewer(1, { tokenCount: 2_000 })],
          stepRuntimes: {
            prepare: { startedAt: "2026-08-14T00:00:00.000Z", tokenCount: 300 },
            consolidate: { startedAt: "2026-08-14T00:00:00.000Z" },
            fix: { startedAt: "2026-08-14T00:00:00.000Z", tokenCount: 40 },
          },
          // The shared session's cumulative counter is not added again.
          fixSession: {
            agent: "codex",
            model: "gpt-5.6",
            sessionKey: "fix",
            providerSessionId: "provider-fix",
            requestIds: [],
            status: "idle",
            startedAt: "2026-08-14T00:00:00.000Z",
            tokenCount: 99_999,
          },
        }),
      ),
    ).toBe(3_340);
  });

  test("counts each legacy session once and is null before any usage", () => {
    const session = {
      agent: "codex" as const,
      model: "gpt-5.6",
      sessionKey: "shared",
      providerSessionId: "provider",
      requestIds: [],
      status: "idle" as const,
      startedAt: "2026-08-14T00:00:00.000Z",
      tokenCount: 500,
    };
    expect(
      multiReviewTotalTokens(
        workflow({ reviewSession: session, fixSession: session, reviewers: [reviewer(0)] }),
      ),
    ).toBe(500);
    expect(multiReviewTotalTokens(workflow({ reviewers: [reviewer(0)] }))).toBeNull();
  });

  test("runs the clock while work runs and stops it at the last activity", () => {
    const now = Date.parse("2026-08-14T01:00:00.000Z");
    const settled = workflow({
      reviewers: [
        reviewer(0, {
          startedAt: "2026-08-14T00:01:00.000Z",
          completedAt: "2026-08-14T00:05:00.000Z",
        }),
      ],
      stepRuntimes: {
        consolidate: {
          startedAt: "2026-08-14T00:06:00.000Z",
          completedAt: "2026-08-14T00:07:30.000Z",
        },
      },
    });
    expect(multiReviewElapsedSeconds(settled, false, now)).toBe(450);
    expect(multiReviewElapsedSeconds(settled, true, now)).toBe(3_600);
    // Nothing recorded: the last write stands in for the end.
    expect(multiReviewElapsedSeconds(workflow(), false, now)).toBe(1_800);
    expect(multiReviewElapsedSeconds(workflow({ createdAt: "never" }), true, now)).toBeNull();
  });
});

function overlaps(a: FlowRect, b: FlowRect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

describe("layout", () => {
  test.each([1, 2, 4, 8])("places %i reviewers without overlap inside the canvas", (count) => {
    const layout = multiReviewFlowLayout({
      width: 1440,
      reviewerCount: count,
      packageHasChips: true,
    });
    const nodes = [
      layout.package,
      ...layout.reviewers,
      layout.consolidation,
      layout.fix,
      layout.pr,
    ];
    expect(layout.reviewers).toHaveLength(count);
    for (const [index, node] of nodes.entries()) {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.y).toBeGreaterThanOrEqual(48);
      expect(node.x + node.width).toBeLessThanOrEqual(layout.width);
      expect(node.y + node.height).toBeLessThanOrEqual(layout.height);
      for (const other of nodes.slice(index + 1)) expect(overlaps(node, other)).toBe(false);
    }
    // Columns run left to right.
    expect(layout.package.x + layout.package.width).toBeLessThan(layout.reviewers[0]!.x);
    expect(layout.reviewers[0]!.x + layout.reviewers[0]!.width).toBeLessThan(
      layout.consolidation.x,
    );
    expect(layout.consolidation.x + layout.consolidation.width).toBeLessThan(layout.fix.x);
    expect(layout.fix.x + layout.fix.width).toBeLessThan(layout.pr.x);
    // The single nodes centre on the reviewer stack.
    const stackTop = layout.reviewers[0]!.y;
    const stackBottom = layout.reviewers.at(-1)!.y + layout.reviewers.at(-1)!.height;
    const centre = layout.consolidation.y + layout.consolidation.height / 2;
    expect(Math.abs(centre - (stackTop + stackBottom) / 2)).toBeLessThanOrEqual(1);
  });

  test("keeps the designed height up to five reviewers and grows beyond", () => {
    const height = (count: number) =>
      multiReviewFlowLayout({ width: 1440, reviewerCount: count, packageHasChips: true }).height;
    expect(height(1)).toBe(FLOW_GRAPH_MIN_HEIGHT);
    expect(height(4)).toBe(FLOW_GRAPH_MIN_HEIGHT);
    expect(height(5)).toBe(FLOW_GRAPH_MIN_HEIGHT);
    expect(height(8)).toBeGreaterThan(FLOW_GRAPH_MIN_HEIGHT);
  });

  test("matches the design at full width and gives nodes their room first when narrower", () => {
    const full = multiReviewFlowLayout({ width: 1440, reviewerCount: 4, packageHasChips: true });
    expect([
      full.package.width,
      full.reviewers[0]!.width,
      full.consolidation.width,
      full.fix.width,
    ]).toEqual([260, 270, 230, 230]);

    const narrow = multiReviewFlowLayout({ width: 1024, reviewerCount: 4, packageHasChips: true });
    // At this width the edges shorten instead of names truncating.
    expect(narrow.reviewers[0]!.width).toBeGreaterThanOrEqual(258);
    expect(narrow.consolidation.width).toBeGreaterThanOrEqual(223);
    expect(narrow.fix.x + narrow.fix.width).toBeLessThanOrEqual(1024);

    const wide = multiReviewFlowLayout({ width: 2000, reviewerCount: 2, packageHasChips: false });
    // Past the designed width the graph centres instead of stretching.
    expect(wide.fix.width).toBe(230);
    expect(wide.width).toBe(2000);
    expect(Math.abs(wide.package.x - (2000 - (wide.pr.x + wide.pr.width)))).toBeLessThanOrEqual(1);
  });

  test("keeps Package to Fix in the width and runs the PR column past it", () => {
    for (const width of [960, 1024, 1440]) {
      const layout = multiReviewFlowLayout({ width, reviewerCount: 4, packageHasChips: true });
      const without = width - 16;
      // The first four columns lay out as they would on their own.
      expect(layout.fix.x + layout.fix.width).toBeLessThanOrEqual(without);
      // Column widths round down, which can leave a pixel or two.
      expect(layout.fix.x + layout.fix.width).toBeGreaterThanOrEqual(without - 4);
      // The PR column follows at the same spacing and widens the canvas.
      expect(layout.pr.x - (layout.fix.x + layout.fix.width)).toBeCloseTo(
        layout.fix.x - (layout.consolidation.x + layout.consolidation.width),
        0,
      );
      expect(layout.pr.width).toBe(layout.fix.width);
      expect(layout.width).toBe(layout.pr.x + layout.pr.width + 16);
      expect(layout.width).toBeGreaterThan(width);
    }
    const full = multiReviewFlowLayout({ width: 1440, reviewerCount: 4, packageHasChips: true });
    expect(full.package.x).toBe(16);
  });

  test("never lays out the graph narrower than the stacking threshold", () => {
    const layout = multiReviewFlowLayout({ width: 400, reviewerCount: 2, packageHasChips: false });
    expect(layout.fix.x + layout.fix.width).toBeGreaterThan(FLOW_GRAPH_STACK_BELOW - 24);
    expect(layout.fix.x + layout.fix.width).toBeLessThanOrEqual(FLOW_GRAPH_STACK_BELOW - 16);
    expect(layout.width).toBe(layout.pr.x + layout.pr.width + 16);
  });

  test("draws level edges straight and the rest as horizontal-tangent béziers", () => {
    const from = { x: 0, y: 100, width: 100, height: 60 };
    expect(flowEdgePath(from, { x: 200, y: 100, width: 100, height: 60 })).toBe(
      "M100 130 L200 130",
    );
    expect(flowEdgePath(from, { x: 200, y: 0, width: 100, height: 60 })).toBe(
      "M100 130 C150 130 150 30 200 30",
    );
  });
});
