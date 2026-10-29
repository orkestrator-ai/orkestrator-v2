/**
 * Multi Review on the graph engine end to end (item 301): the engine setting
 * and its override, the launch bound from the review's own input, the
 * projection of every step onto the record, cancellation, refused step
 * controls and the manual Fix after the run settles.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { isMultiReviewWorkflow } from "@orkestrator/protocol/multi-review";
import {
  configuredMultiReviewEngine,
  multiReviewGraphRunId,
  multiReviewWorkflowIdOfRun,
} from "./multi-review-graph-engine.js";
import {
  graphReviewGap,
  graphReviewIssue,
  graphReviewReport,
  graphReviewWorld,
  type GraphReviewWorld,
} from "./multi-review-graph-test-support.js";

const worlds: GraphReviewWorld[] = [];

afterEach(async () => {
  for (const world of worlds.splice(0)) await world.close();
});

async function world(): Promise<GraphReviewWorld> {
  const created = await graphReviewWorld();
  worlds.push(created);
  return created;
}

/** Reviewer N reports `issues` named after its position; consolidation cites them all. */
function scriptReview(w: GraphReviewWorld, options: { findings: boolean; complete?: boolean }) {
  w.fakes.scripts.set("review", ({ port, branchKey }) =>
    port === "report"
      ? graphReviewReport(
          options.findings
            ? {
                issues: [graphReviewIssue(`Issue from ${branchKey}`)],
                testCoverageGaps: [graphReviewGap("Failure branch")],
                verdict: { ready: "with-fixes", reasoning: "Fix first" },
              }
            : {},
        )
      : undefined,
  );
  w.fakes.scripts.set("consolidate", ({ port }) =>
    port === "report"
      ? graphReviewReport(
          options.findings
            ? {
                issues: [
                  {
                    ...graphReviewIssue("Merged issue"),
                    reviewSourceIds: ["review/panel.1/issue-1", "review/panel.2/issue-1"],
                  },
                ],
                testCoverageGaps: [
                  {
                    ...graphReviewGap("Failure branch"),
                    reviewSourceIds: ["review/panel.2/coverage-gap-1"],
                  },
                ],
                verdict: { ready: "with-fixes", reasoning: "Fix first" },
              }
            : {},
        )
      : undefined,
  );
  w.fakes.scripts.set("fix", ({ port }) =>
    port === "result"
      ? {
          complete: options.complete ?? true,
          summary: options.complete === false ? "One finding remains" : "Fixed",
          filesChanged: ["src/a.ts"],
          commandsRun: [],
          notes: [],
          limitations: [],
        }
      : undefined,
  );
}

describe("the engine setting", () => {
  test("the override wins over the setting; an unknown override is ignored", () => {
    expect(configuredMultiReviewEngine(undefined, {})).toBe("bespoke");
    expect(configuredMultiReviewEngine("graph", {})).toBe("graph");
    expect(
      configuredMultiReviewEngine("bespoke", { ORKESTRATOR_MULTI_REVIEW_ENGINE: "graph" }),
    ).toBe("graph");
    expect(
      configuredMultiReviewEngine("graph", { ORKESTRATOR_MULTI_REVIEW_ENGINE: "Bespoke" }),
    ).toBe("bespoke");
    expect(configuredMultiReviewEngine("graph", { ORKESTRATOR_MULTI_REVIEW_ENGINE: "fast" })).toBe(
      "graph",
    );
    expect(configuredMultiReviewEngine("other", {})).toBe("bespoke");
  });

  test("the app setting is stored, validated, and kept by a save that omits it", async () => {
    const w = await world();
    const storage = w.fixture.storage;
    const config = await storage.loadConfig();
    expect(config.global.multiReviewEngine).toBeUndefined();
    await storage.updateGlobalConfig({ ...config.global, multiReviewEngine: "graph" });
    expect((await storage.loadConfig()).global.multiReviewEngine).toBe("graph");
    // A renderer save that predates the setting does not reset it.
    const { multiReviewEngine: _omitted, ...withoutEngine } = (await storage.loadConfig()).global;
    await storage.updateGlobalConfig(withoutEngine);
    expect((await storage.loadConfig()).global.multiReviewEngine).toBe("graph");
    await expect(
      storage.updateGlobalConfig({
        ...config.global,
        multiReviewEngine: "turbo" as unknown as "graph",
      }),
    ).rejects.toThrow(/bespoke or graph/);
  });

  test("run ids map back to their workflow and to nothing else", () => {
    expect(multiReviewWorkflowIdOfRun(multiReviewGraphRunId("w-1"))).toBe("w-1");
    expect(multiReviewWorkflowIdOfRun("launch-abc")).toBeUndefined();
    expect(multiReviewWorkflowIdOfRun("multi-review-")).toBeUndefined();
  });

  test("bespoke starts record no engine; graph starts record the run they launch", async () => {
    const w = await world();
    w.setEngine("bespoke");
    const bespoke = await w.start();
    expect(bespoke.engine).toBeUndefined();
    expect(bespoke.graphRun).toBeUndefined();
    await w.service.cancel(bespoke.id);
    await w.drive(bespoke.id, (workflow) => workflow.phase === "cancelled");
    await w.service.close(bespoke.id);

    w.setEngine("graph");
    const graph = await w.start();
    expect(graph.engine).toBe("graph");
    expect(graph.graphRun).toEqual({ runId: multiReviewGraphRunId(graph.id) });
    expect(isMultiReviewWorkflow(graph)).toBe(true);
  });

  test("a review instruction longer than a graph parameter stays on the bespoke engine", async () => {
    const w = await world();
    const workflow = await w.start({ reviewInstruction: "x".repeat(5_000) });
    expect(workflow.engine).toBeUndefined();
  });
});

describe("a graph-engine Multi Review", () => {
  test("binds the run from the review's own input", async () => {
    const w = await world();
    scriptReview(w, { findings: false });
    const workflow = await w.start({
      reviewInstruction: "Look at the parser",
      autoFix: true,
      reviewers: [
        { agent: "claude", model: "opus", lens: { label: "Security", instruction: "Injection" } },
        { agent: "claude", model: "sonnet" },
      ],
      reviewModel: { agent: "claude", model: "haiku" },
    });
    const launched = await w.drive(
      workflow.id,
      (current) => current.graphRun?.projectedRevision !== undefined,
    );
    const run = await w.run(launched);
    expect(run.template).toMatchObject({ id: "multi-review", scope: "built-in" });
    expect(run.plan.template.engine).toBeUndefined();
    expect(run.environmentId).toBe(w.environmentId);
    expect(run.bindings.params).toMatchObject({
      autoFix: true,
      autoPr: false,
      targetBranch: "main",
      reviewInstruction: "Look at the parser",
    });
    expect(run.bindings.roles.preparer).toEqual({ platform: "claude", model: "haiku" });
    expect(run.bindings.roles.consolidator).toEqual({ platform: "claude", model: "haiku" });
    expect(run.bindings.roles.fixer).toEqual({ platform: "claude", model: "opus" });
    expect(run.bindings.roles.reviewer).toEqual([
      {
        platform: "claude",
        model: "opus",
        lens: { label: "Security", instruction: "Injection" },
      },
      { platform: "claude", model: "sonnet" },
    ]);
    // The package and pull request take the review's target branch literally.
    const pr = run.plan.nodes.find((node) => node.id === "pr");
    expect(pr && "params" in pr ? pr.params : undefined).toMatchObject({ targetBranch: "main" });
  });

  test("projects every step, ending ready with the consolidated report and its overlap", async () => {
    const w = await world();
    scriptReview(w, { findings: true });
    const workflow = await w.start();
    const seen = new Set<string>();
    const settled = await w.drive(workflow.id, (current) => {
      seen.add(current.phase);
      expect(isMultiReviewWorkflow(current)).toBe(true);
      return current.graphRun?.settled === true;
    });
    expect([...seen]).toEqual(
      expect.arrayContaining(["preparing", "reviewing", "consolidating", "ready"]),
    );
    expect(settled.phase).toBe("ready");
    expect(settled.reviewers.map((reviewer) => reviewer.status)).toEqual([
      "completed",
      "completed",
    ]);
    // Reports are attributed by the backend, as bespoke reports are.
    expect(settled.reviewers[1]!.report!.issues[0]!.reviewModels).toEqual(["claude/sonnet"]);
    expect(settled.reviewers[0]!.providerSessionId).toMatch(/^ps-/);
    expect(settled.preparationSession?.openedFor).toBe("prepare");
    expect(settled.reviewSession?.openedFor).toBe("consolidate");
    expect(settled.stepRuntimes?.prepare?.completedAt).toBeDefined();
    expect(settled.stepRuntimes?.consolidate?.completedAt).toBeDefined();
    expect(settled.reviewPackage?.targetBranch).toBe("main");
    // Graph ids were translated to Multi Review's, then provenance derived.
    expect(settled.consolidatedReport!.issues[0]!.reviewModels).toEqual([
      "claude/opus",
      "claude/sonnet",
    ]);
    expect(settled.consolidatedReport!.testCoverageGaps[0]!.reviewModels).toEqual([
      "claude/sonnet",
    ]);
    expect(settled.consolidationOverlap).toMatchObject({
      version: 1,
      reviewers: 2,
      sourceFindings: 4,
      citedSourceFindings: 3,
      consolidatedFindings: 2,
      singleSourceFindings: 1,
    });
    expect(settled.fixSession).toBeUndefined();
    expect(settled.autoPrLaunch).toBeUndefined();
  });

  test("a failed reviewer is carried, not a blocker", async () => {
    const w = await world();
    scriptReview(w, { findings: false });
    w.fakes.failBranches.set("review/panel.2", [
      "provider-error",
      "provider-error",
      "provider-error",
    ]);
    const settled = await w.settle((await w.start()).id);
    expect(settled.phase).toBe("ready");
    expect(settled.reviewers.map((reviewer) => reviewer.status)).toEqual(["completed", "failed"]);
    expect(settled.reviewers[1]!.error).toBeDefined();
    expect(settled.consolidationOverlap?.reviewers).toBe(1);
  });

  test("cancelling stops the run and settles the record cancelled", async () => {
    const w = await world();
    scriptReview(w, { findings: false });
    w.fakes.held.add("review");
    const workflow = await w.start();
    await w.drive(workflow.id, (current) => current.phase === "reviewing");
    const cancelling = await w.service.cancel(workflow.id);
    expect(cancelling.phase).toBe("cancelling");
    const settled = await w.settle(workflow.id);
    expect(settled.phase).toBe("cancelled");
    expect((await w.run(settled)).status).toBe("cancelled");
    expect(settled.reviewers.every((reviewer) => reviewer.status === "cancelled")).toBe(true);
    // A settled record can be deleted like any other.
    await w.service.close(workflow.id);
    expect(await w.fixture.storage.getMultiReviewWorkflow(workflow.id)).toBeNull();
  });

  test("bespoke step controls are refused; the manual Fix waits for the run to end", async () => {
    const w = await world();
    scriptReview(w, { findings: true });
    w.fakes.held.add("review");
    const workflow = await w.start();
    await w.drive(workflow.id, (current) => current.phase === "reviewing");
    const reviewerId = (await w.workflow(workflow.id)).reviewers[0]!.id;
    await expect(w.service.restartReviewer(workflow.id, reviewerId)).rejects.toThrow(
      /graph runtime/,
    );
    await expect(w.service.stopReviewer(workflow.id, reviewerId)).rejects.toThrow(/graph runtime/);
    await expect(w.service.pauseStep(workflow.id, "prepare")).rejects.toThrow(/graph runtime/);
    await expect(w.service.retry(workflow.id)).rejects.toThrow(/graph runtime/);
    await expect(w.service.address(workflow.id)).rejects.toThrow(/has not ended/);
  });

  test("a launch the graph runtime refuses fails the review with its reason", async () => {
    const w = await world();
    const config = await w.fixture.storage.loadConfig();
    await w.fixture.storage.saveConfig({
      ...config,
      global: { ...config.global, enabledAgentPlatforms: ["codex"] },
    });
    const settled = await w.settle((await w.start()).id);
    expect(settled.phase).toBe("failed");
    expect(settled.error).toMatch(/graph runtime could not start.*invalid-binding/);
    expect(settled.graphRun?.settled).toBe(true);
  });

  test("a pass over an unchanged run reads nothing but the run and saves nothing", async () => {
    const w = await world();
    scriptReview(w, { findings: false });
    w.fakes.held.add("review");
    const workflow = await w.start();
    await w.drive(workflow.id, (current) => current.phase === "reviewing");
    // Let the run reach a steady state, then project it once.
    for (let index = 0; index < 3; index++) {
      w.time.jump(3_000);
      await w.graphRuns.advanceNow(workflow.graphRun!.runId);
    }
    await w.service.advanceNow(workflow.id);
    const saves = w.efficiency.count("workflow.save");
    const reads = w.artifactReads.length;
    for (let index = 0; index < 5; index++) await w.service.advanceNow(workflow.id);
    expect(w.efficiency.count("workflow.save")).toBe(saves);
    expect(w.artifactReads.length).toBe(reads);
  });
});
