/**
 * The coordinator's Multi Review surfaces on the graph engine (item 301):
 * `launch_multi_review` and `start_multi_review` start a graph-engine review
 * with the button's automation defaults, `get_multi_review` answers from the
 * projected record exactly as from a bespoke one, and status wakes report each
 * end once, with the review's own graph run adding nothing. Real registry,
 * coordinator, control MCP server and graph runtime; fake agents only.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  MULTI_REVIEW_WORKFLOW_VERSION,
  type MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import { multiReviewStatus } from "./coordinator-status-wakes.js";
import { graphEnvironmentFixture } from "./graph-run-test-support.js";
import { multiReviewGraphRunId } from "./multi-review-graph-engine.js";
import {
  graphCoordinatorWorld,
  scriptGraphReview,
  type GraphCoordinatorWorld,
} from "./multi-review-graph-surfaces-test-support.js";

const worlds: GraphCoordinatorWorld[] = [];

afterEach(async () => {
  for (const world of worlds.splice(0)) await world.close();
});

async function world(): Promise<GraphCoordinatorWorld> {
  const created = await graphCoordinatorWorld();
  worlds.push(created);
  return created;
}

const opus = { agent: "claude", model: "opus" } as const;
const sonnet = { agent: "claude", model: "sonnet" } as const;
const rows = { reviewers: [opus, sonnet], reviewModel: opus, fixModel: opus };

/** The coordinator's Multi Review button, as `launch_multi_review` invokes it. */
async function launch(
  c: GraphCoordinatorWorld,
  input: Record<string, unknown> = {},
): Promise<MultiReviewWorkflow> {
  const outcome = (await c.commands.get("launch_coordinator_multi_review_action")!(
    {
      scope: c.scope,
      input: { environmentId: c.w.environmentId, requestId: "launch-1", ...rows, ...input },
    },
    c.context,
  )) as { workflow: MultiReviewWorkflow; outcome: string };
  expect(outcome.outcome).toBe("opened");
  return outcome.workflow;
}

async function saveAutomationDefaults(
  c: GraphCoordinatorWorld,
  multiReview: { autoFix?: boolean; autoPr?: boolean },
): Promise<void> {
  const config = await c.w.fixture.storage.loadConfig();
  await c.w.fixture.storage.updateGlobalConfig({
    ...config.global,
    agentSettings: { ...config.global.agentSettings, multiReview },
  });
}

describe("coordinator launch on the graph engine", () => {
  test("launch_multi_review starts a graph-engine review with the saved automation defaults", async () => {
    const c = await world();
    scriptGraphReview(c.w, { findings: false });
    c.w.fakes.held.add("review");
    // Saved auto-fix on; the caller asks for auto-PR only.
    await saveAutomationDefaults(c, { autoFix: true, autoPr: false });
    const result = await c.tool("launch_multi_review", {
      requestId: "mcp-launch",
      environmentId: c.w.environmentId,
      ...rows,
      autoPr: true,
    });
    expect(result.isError).not.toBe(true);
    const content = result.structuredContent as {
      outcome: string;
      delivery: string;
      workflow: { id: string; phase: string; automation: Record<string, unknown> };
      selection: { autoFix: boolean; autoPr: boolean; source: Record<string, string> };
    };
    expect(content.outcome).toBe("opened");
    expect(content.delivery).toBe("async");
    expect(content.selection).toMatchObject({
      autoFix: true,
      autoPr: true,
      source: { autoFix: "implied", autoPr: "requested" },
    });
    const stored = await c.w.workflow(content.workflow.id);
    expect(stored).toMatchObject({
      engine: "graph",
      graphRun: { runId: multiReviewGraphRunId(content.workflow.id) },
      autoFix: true,
      autoPr: true,
    });
    // The run is bound from the same automation the record holds.
    const launched = await c.drive(stored.id, (current) => current.phase === "reviewing");
    const run = await c.w.run(launched);
    expect(run.bindings.params).toMatchObject({ autoFix: true, autoPr: true });
    // The coordinator owns the review, never its graph run.
    const associations = await c.w.fixture.storage.coordinators.listCoordinatorWorkflowAssociations(
      c.scope.projectId,
    );
    expect(associations).toEqual([
      expect.objectContaining({ kind: "multi-review", resourceId: stored.id }),
    ]);
  });

  test("an explicit auto-fix override wins over the saved default on the graph engine", async () => {
    const c = await world();
    await saveAutomationDefaults(c, { autoFix: true, autoPr: true });
    const workflow = await launch(c, { autoFix: false });
    const stored = await c.w.workflow(workflow.id);
    expect(stored).toMatchObject({ engine: "graph", autoFix: false, autoPr: true });
    const run = await c.w.run(
      await c.drive(workflow.id, (current) => current.phase !== "preparing"),
    );
    expect(run.bindings.params).toMatchObject({ autoFix: false, autoPr: true });
  });

  test("start_multi_review (the build-gated primitive) also starts a graph-engine review", async () => {
    const c = await world();
    await saveAutomationDefaults(c, { autoFix: false, autoPr: true });
    const storage = c.w.fixture.storage;
    storage.getBuildPipeline = (async () => ({
      snapshot: { projectId: c.w.projectId, environmentId: c.w.environmentId, phase: "complete" },
    })) as unknown as typeof storage.getBuildPipeline;
    const result = await c.tool("start_multi_review", {
      requestId: "start-1",
      buildPipelineId: "build-1",
      environmentId: c.w.environmentId,
      targetBranch: "main",
      ...rows,
    });
    expect(result.isError).not.toBe(true);
    const content = result.structuredContent as {
      workflow: { id: string };
      selection: { autoFix: boolean; autoPr: boolean };
    };
    expect(content.selection).toMatchObject({ autoFix: false, autoPr: true });
    expect(await c.w.workflow(content.workflow.id)).toMatchObject({
      engine: "graph",
      autoFix: false,
      autoPr: true,
    });
  });
});

/**
 * `get_multi_review` for the graph record, and for the same record without its
 * engine fields saved as an ordinary review in another environment.
 */
async function readBoth(
  c: GraphCoordinatorWorld,
  graph: MultiReviewWorkflow,
): Promise<{ graph: Record<string, unknown>; bespoke: Record<string, unknown> }> {
  const storage = c.w.fixture.storage;
  if (!(await storage.getEnvironment("bespoke-env"))) {
    await storage.addEnvironment(
      graphEnvironmentFixture({ id: "bespoke-env", projectId: c.w.projectId, name: "Bespoke" }),
    );
  }
  const { engine: _engine, graphRun: _graphRun, ...rest } = graph;
  const twinId = `bespoke-${graph.phase}`;
  await storage.createMultiReviewWorkflowIfNoActive(
    twinId,
    "bespoke-env",
    MULTI_REVIEW_WORKFLOW_VERSION,
    { ...rest, id: twinId, environmentId: "bespoke-env" },
  );
  const read = async (workflowId: string) => {
    const result = await c.tool("get_multi_review", { workflowId });
    expect(result.isError).not.toBe(true);
    const {
      id: _id,
      environmentId: _environmentId,
      updatedAt: _updatedAt,
      createdAt: _createdAt,
      revision: _revision,
      ...summary
    } = result.structuredContent.workflow as Record<string, unknown>;
    return summary;
  };
  const answer = { graph: await read(graph.id), bespoke: await read(twinId) };
  await storage.deleteMultiReviewWorkflow(twinId);
  return answer;
}

describe("get_multi_review on a graph-engine record", () => {
  test("reviewing and ready read exactly as a bespoke record at the same phase", async () => {
    const c = await world();
    scriptGraphReview(c.w, { findings: true });
    c.w.fakes.held.add("review");
    const workflow = await launch(c);
    const reviewing = await c.drive(workflow.id, (current) => current.phase === "reviewing");
    const atReviewing = await readBoth(c, reviewing);
    expect(atReviewing.graph).toEqual(atReviewing.bespoke);
    expect(atReviewing.graph).toEqual({
      projectId: c.w.projectId,
      phase: "reviewing",
      automation: {
        autoFix: false,
        autoPr: false,
        next: "Stops at ready; address_multi_review starts the Fix.",
      },
    });

    c.w.fakes.held.delete("review");
    const ready = await c.drive(workflow.id, (current) => current.graphRun?.settled === true);
    expect(ready.phase).toBe("ready");
    expect(ready.consolidationOverlap?.consolidatedFindings).toBe(2);
    const atReady = await readBoth(c, ready);
    expect(atReady.graph).toEqual(atReady.bespoke);
    expect(atReady.graph).toMatchObject({
      phase: "ready",
      automation: { next: "Waiting for address_multi_review to start the Fix." },
    });
  });

  test("completed with its pull request reads exactly as a bespoke record", async () => {
    const c = await world();
    scriptGraphReview(c.w, { findings: true });
    const workflow = await launch(c, { autoFix: true, autoPr: true });
    const completed = await c.drive(workflow.id, (current) => current.graphRun?.settled === true);
    expect(completed.phase).toBe("completed");
    const both = await readBoth(c, completed);
    // Everything but the next-step wording reads as a bespoke record: on the
    // graph engine a system step, not a PR session, opened the pull request.
    const withoutNext = (read: Record<string, unknown>) => ({
      ...read,
      automation: { ...(read.automation as Record<string, unknown>), next: undefined },
    });
    expect(withoutNext(both.graph)).toEqual(withoutNext(both.bespoke));
    expect(both.bespoke).toMatchObject({
      automation: {
        next: "The PR session started; it pushes the branch and opens the pull request. Nothing else runs automatically.",
      },
    });
    expect(both.graph).toMatchObject({
      phase: "completed",
      automation: {
        autoFix: true,
        autoPr: true,
        // No tab: the graph's pull request is a system node, not an agent tab.
        prLaunch: { state: "launched" },
        next: "The graph run's pull request step pushed the branch and opened the pull request. Nothing else runs automatically.",
      },
    });
  });
});

describe("status wakes for a coordinator-launched graph-engine review", () => {
  test("ready wakes once; neither later passes nor the graph run add a notice", async () => {
    const c = await world();
    scriptGraphReview(c.w, { findings: true });
    const workflow = await launch(c);
    const ready = await c.drive(workflow.id, (current) => current.graphRun?.settled === true);
    expect(ready.phase).toBe("ready");
    for (let index = 0; index < 5; index++) {
      await c.drive(workflow.id, () => true);
    }
    expect(await c.notices()).toEqual(["ready"]);
    expect(multiReviewStatus(ready, ready.id)).toMatchObject({
      state: "ready",
      headline: "is ready to address",
      details: ["Consolidated report: 1 finding (1 P1), 1 test-coverage gap; verdict: with-fixes."],
      tools: [
        `get_multi_review { "workflowId": "${ready.id}" }`,
        `address_multi_review { "workflowId": "${ready.id}" }`,
      ],
    });
    const associations = await c.w.fixture.storage.coordinators.listCoordinatorWorkflowAssociations(
      c.scope.projectId,
    );
    expect(associations.map((association) => association.kind)).toEqual(["multi-review"]);
  });

  test("auto-fix and auto-PR end in one completed wake that names the pull request", async () => {
    const c = await world();
    scriptGraphReview(c.w, { findings: true });
    const workflow = await launch(c, { autoFix: true, autoPr: true });
    const completed = await c.drive(workflow.id, (current) => current.graphRun?.settled === true);
    expect(completed.phase).toBe("completed");
    expect(await c.notices()).toEqual(["completed"]);
    expect(multiReviewStatus(completed, completed.id)).toMatchObject({
      state: "completed",
      terminal: true,
      details: ["Fix: Fixed", "Files changed: 1", "The graph run opened the pull request."],
    });
  });

  test("a clean report under auto-PR wakes once, for the pull request, not for ready", async () => {
    const c = await world();
    scriptGraphReview(c.w, { findings: false });
    const workflow = await launch(c, { autoFix: false, autoPr: true });
    const settled = await c.drive(workflow.id, (current) => current.graphRun?.settled === true);
    expect(settled.phase).toBe("ready");
    expect(settled.autoPrLaunch?.state).toBe("launched");
    expect(await c.notices()).toEqual(["pr-started"]);
    expect(multiReviewStatus(settled, settled.id)).toMatchObject({
      state: "pr-started",
      headline: "found nothing to fix; the graph run opened the pull request",
    });
  });

  test("a Fix that does not complete wakes once, failed", async () => {
    const c = await world();
    scriptGraphReview(c.w, { findings: true, complete: false });
    const workflow = await launch(c, { autoFix: true, autoPr: true });
    const failed = await c.drive(workflow.id, (current) => current.graphRun?.settled === true);
    expect(failed.phase).toBe("failed");
    expect(await c.notices()).toEqual(["failed"]);
    expect(multiReviewStatus(failed, failed.id)?.details).toEqual([
      "Error: The fix model could not address every finding: One finding remains",
    ]);
  });

  test("cancelling wakes once, cancelled", async () => {
    const c = await world();
    scriptGraphReview(c.w, { findings: false });
    c.w.fakes.held.add("review");
    const workflow = await launch(c);
    await c.drive(workflow.id, (current) => current.phase === "reviewing");
    await c.w.service.cancel(workflow.id);
    const cancelled = await c.drive(workflow.id, (current) => current.graphRun?.settled === true);
    expect(cancelled.phase).toBe("cancelled");
    for (let index = 0; index < 3; index++) await c.drive(workflow.id, () => true);
    expect(await c.notices()).toEqual(["cancelled"]);
  });
});

/**
 * Every saved revision of the run, projected onto the record as a supervision
 * pass woken by that save would project it, with the wake it would send.
 */
function watchRevisions(c: GraphCoordinatorWorld, workflowId: string) {
  const runId = multiReviewGraphRunId(workflowId);
  const seen: string[] = [];
  const pending: Promise<void>[] = [];
  const stop = c.w.fixture.storage.addResourceChangeListener((change) => {
    if (change.resource !== "graph-run" || change.id !== runId) return;
    pending.push(
      (async () => {
        const run = await c.w.fixture.storage.graphRuns.getGraphRun(runId);
        if (!run) return;
        const projected = await c.w.engine.project(await c.w.workflow(workflowId), run);
        seen.push(
          `${projected.phase}:${projected.autoPrLaunch?.state ?? "none"}:${multiReviewStatus(projected, workflowId)?.state ?? "quiet"}`,
        );
      })(),
    );
  });
  return async () => {
    stop();
    await Promise.all(pending);
    return [...new Set(seen)];
  };
}

describe("no saved revision of the run reads as an end the bespoke engine never shows", () => {
  test("auto-fix: consolidation goes on to the Fix and a completed Fix to its pull request", async () => {
    const c = await world();
    scriptGraphReview(c.w, { findings: true });
    const workflow = await launch(c, { autoFix: true, autoPr: true });
    const revisions = watchRevisions(c, workflow.id);
    await c.drive(workflow.id, (current) => current.graphRun?.settled === true);
    // Not `ready:none:ready` after consolidation, and not
    // `completed:none:completed` (a terminal wake without the PR) after the Fix.
    expect(await revisions()).toEqual([
      "preparing:none:quiet",
      "reviewing:none:quiet",
      "consolidating:none:reviews-finished",
      "fixing:none:quiet",
      "completed:pending:quiet",
      "completed:launched:completed",
    ]);
  });

  test("a clean report under auto-PR is pending its pull request from the save that holds it", async () => {
    const c = await world();
    scriptGraphReview(c.w, { findings: false });
    const workflow = await launch(c, { autoFix: true, autoPr: true });
    const revisions = watchRevisions(c, workflow.id);
    await c.drive(workflow.id, (current) => current.graphRun?.settled === true);
    // Not `ready:none:ready` ("found nothing to fix ... no Fix or PR session started").
    expect(await revisions()).toEqual([
      "preparing:none:quiet",
      "reviewing:none:quiet",
      "consolidating:none:reviews-finished",
      "ready:pending:quiet",
      "ready:launched:pr-started",
    ]);
  });
});
