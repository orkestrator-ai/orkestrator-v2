import { expect, test } from "bun:test";
import type { GraphRun } from "@orkestrator/protocol/graphs/run";
import { turnSlots } from "../graph-agent-test-support.js";
import { multiReviewGraphRunId } from "./graph-engine.js";
import {
  INTERLEAVING_REPORT,
  REAL_AGENT_NODE,
  multiReviewInterleavingWorld,
} from "./graph-interleaving-support.js";
import { graphReviewIssue } from "./graph-test-support.js";

test("the graph Address executor journals the effective setting and reuses it after a prepared restart", async () => {
  const reviewerReport = {
    ...INTERLEAVING_REPORT,
    issues: [graphReviewIssue("A branch regression")],
  };
  const world = await multiReviewInterleavingWorld({
    realAgentNodes: [REAL_AGENT_NODE, "address-findings"],
    script: async (turn, tools) => {
      const reportKey = turnSlots(turn).report;
      if (reportKey)
        await tools.call("submit_report", { resultKey: reportKey, result: reviewerReport });
      return "idle";
    },
  });
  try {
    world.fakes.scripts.set("consolidate", () => ({
      ...reviewerReport,
      issues: [{ ...reviewerReport.issues[0]!, reviewSourceIds: ["review/panel.1/issue-1"] }],
    }));
    world.fakes.referenceContents = (value) =>
      Buffer.from(
        JSON.stringify({
          ...(value as object),
          validation: [
            { command: "bun test", status: "failed", stdoutPath: null, stderrPath: null },
          ],
        }),
      );
    await world.storage.patchGlobalConfig({ addressFindingsRepairsPreExisting: true });
    const process = world.start();
    await process.ready;
    const started = await world.startReview({
      autoAddressFindings: true,
      addressFindingsModel: { agent: "claude", model: "opus" },
    });
    const runId = multiReviewGraphRunId(started.id);
    const address = (run: GraphRun | null) =>
      run?.activations.find((activation) => activation.nodeId === "address-findings");
    let requestId: string | undefined;
    world.hooks.afterRunSave = (run) => {
      const activation = address(run);
      if (activation?.session?.dispatchState !== "prepared") return false;
      requestId = activation.session.requestId;
      return true;
    };
    for (let pass = 0; pass < 40 && process.alive; pass++) {
      await Promise.race([process.service.advanceNow(started.id), process.died]);
      if (process.alive && (await world.run(runId))) {
        await Promise.race([process.graphRuns.advanceNow(runId), process.died]);
        await world.provider.settle();
      }
    }
    const saved = await world.run(runId);
    expect(requestId).toBeDefined();
    expect(address(saved)).toMatchObject({
      addressFindingsPreExistingFailures: "repair",
      session: { dispatchState: "prepared", requestId },
    });
    const reviewer = saved?.activations.find((activation) => activation.nodeId === REAL_AGENT_NODE);
    expect(reviewer?.state).toBe("complete");
    expect(reviewer?.addressFindingsPreExistingFailures).toBeUndefined();
    expect(world.provider.turns().some((turn) => turn.requestId === requestId)).toBe(false);

    await world.storage.patchGlobalConfig({ addressFindingsRepairsPreExisting: false });
    delete world.hooks.afterRunSave;
    const resumed = await world.restart(started.id);
    for (let pass = 0; pass < 20 && !world.provider.journal.has(requestId!); pass++) {
      await resumed.graphRuns.advanceNow(runId);
      await world.provider.settle();
    }
    const delivered = world.provider.turns().filter((turn) => turn.requestId === requestId);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.prompt).toContain("**Pre-existing failures**");
    expect(address(await world.run(runId))?.addressFindingsPreExistingFailures).toBe("repair");
  } finally {
    await world.cleanup();
  }
}, 30_000);
