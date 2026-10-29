import { afterEach, describe, expect, test } from "bun:test";
import { GRAPH_TICKET_LIFECYCLE_EVENTS } from "@orkestrator/protocol/graphs/system-actions";
import { buildPipelineKanbanUpdate } from "./build-pipeline-kanban-lifecycle.js";
import type { GraphActivationReport } from "./graph-run-executors.js";
import { SYSTEM_REPO, systemWorld, type SystemWorld } from "./graph-system-test-support.js";

const worlds: SystemWorld[] = [];
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.cleanup();
});

const PR = `https://github.com/${SYSTEM_REPO}/pull/1`;

/** A world with a backlog ticket linked to the run's environment, criteria as `ticket@1`'s example. */
async function world(): Promise<{ w: SystemWorld; taskId: string }> {
  const w = await systemWorld();
  worlds.push(w);
  const task = await w.storage.kanban.addKanbanTask("p1", "Add CSV export", "Users need CSV.", {
    acceptanceCriteria:
      "- The reports page has an Export CSV button.\n- The CSV has a header row and every visible row.",
  });
  await w.storage.kanban.updateKanbanTask(task.id, { environmentId: "e1" });
  return { w, taskId: task.id };
}

function complete(report: GraphActivationReport): void {
  expect(report).toMatchObject({ state: "complete", outputs: {} });
}

async function ticket(w: SystemWorld, taskId: string) {
  return (await w.storage.kanban.getKanbanTasks("p1")).find((task) => task.id === taskId)!;
}

describe("update-ticket", () => {
  test("lifecycle updates match today's pipeline, in order, and never repeat", async () => {
    const { w, taskId } = await world();
    const executor = w.executor();
    for (const node of ["started", "validated", "raised", "completed"]) {
      complete(await executor.start(w.context(w.activation(node))));
    }
    // What `build-pipeline-service-supervisor.test.ts` pins for a pipeline run.
    const task = await ticket(w, taskId);
    expect(task).toMatchObject({ status: "review", prUrl: PR, prState: "open" });
    expect(task.comments.map((comment) => comment.text)).toEqual([
      "🔨 Build started",
      "✅ Validation complete",
      `🔗 PR raised: ${PR}`,
    ]);
    // Retries, a restart and another iteration add nothing.
    for (const node of ["started", "validated", "raised"]) {
      complete(await executor.start(w.context(w.activation(node, { attempt: 2 }))));
      complete(
        await w
          .executor({ owner: "process-2" })
          .recover(w.context(w.activation(node, { iteration: 2 }))),
      );
    }
    expect((await ticket(w, taskId)).comments).toHaveLength(3);
  });

  test("a failed run moves the ticket back to backlog, as the pipeline does", async () => {
    const { w, taskId } = await world();
    complete(await w.executor().start(w.context(w.activation("started"))));
    complete(await w.executor().start(w.context(w.activation("failed"))));
    expect((await ticket(w, taskId)).status).toBe("backlog");
  });

  test("the lifecycle table is the pipeline's", () => {
    expect(
      Object.fromEntries(
        GRAPH_TICKET_LIFECYCLE_EVENTS.map((event) => [
          event,
          buildPipelineKanbanUpdate(event, { url: PR }),
        ]),
      ),
    ).toEqual({
      "build-started": { status: "in-progress", comment: "🔨 Build started" },
      "validation-complete": { comment: "✅ Validation complete" },
      "pr-raised": { status: "review", prUrl: PR, prState: "open", comment: `🔗 PR raised: ${PR}` },
      complete: { status: "review" },
      failed: { status: "backlog" },
    });
  });

  test("a column move and a comment, once, after a crash before or after either", async () => {
    const { w, taskId } = await world();
    // A crash after the comment, before the effect was recorded done.
    await w.storage.graphEffects.beginGraphEffect({
      runId: "run-1",
      key: "update-ticket:move#iter=1",
      action: "update-ticket",
      nodeId: "move",
      activation: "move#iter=1#attempt=1",
      owner: "crashed-process",
    });
    await w.storage.kanban.addKanbanComment(taskId, "Graph run started");
    complete(await w.executor().recover(w.context(w.activation("move", { state: "running" }))));
    const task = await ticket(w, taskId);
    expect(task.status).toBe("in-progress");
    expect(task.comments.map((comment) => comment.text)).toEqual(["Graph run started"]);
    expect(
      await w.storage.graphEffects.getGraphEffect("run-1", "update-ticket:move#iter=1"),
    ).toMatchObject({ state: "done", attempts: 2, data: { moved: true, commented: false } });
  });

  test("records the verdict's criteria results as Verify does", async () => {
    const { w, taskId } = await world();
    complete(await w.executor().start(w.context(w.activation("criteria"))));
    const criteria = (await ticket(w, taskId)).sections?.acceptanceCriteria ?? [];
    expect(
      criteria.map((criterion) => [criterion.id, criterion.check?.status, criterion.check?.source]),
    ).toEqual([
      ["ac-1", "passed", "verify"],
      ["ac-2", "failed", "verify"],
    ]);
    expect(criteria[1]!.check).toMatchObject({
      evidence: "A three-row report exports two rows.",
      checkedAt: w.now.toISOString(),
    });
  });

  test("a run without a linked ticket fails with a clear reason", async () => {
    const w = await systemWorld();
    worlds.push(w);
    const report = await w.executor().start(w.context(w.activation("move")));
    expect(report).toMatchObject({ state: "failed", cause: "system-error" });
    expect((report as { error: string }).error).toContain("No Kanban ticket is linked");
  });
});
