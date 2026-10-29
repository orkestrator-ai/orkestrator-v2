/**
 * Auto-fix and auto-PR ordering on the graph engine (item 301), against
 * `review-preparation.md` §"Auto-fix and auto-PR": only proof that a Fix
 * completed, or a clean report, queues the pull request, and the pull
 * request is the `open-pull-request` system node, never an agent.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { GraphRun, NodeActivation } from "@orkestrator/protocol/graphs/run";
import type { MultiReviewWorkflow } from "@orkestrator/protocol/multi-review";
import { multiReviewFixIdentity } from "./multi-review-fix-identity.js";
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

async function world(findings: boolean, fixComplete = true): Promise<GraphReviewWorld> {
  const w = await graphReviewWorld();
  worlds.push(w);
  const report = graphReviewReport(
    findings
      ? {
          issues: [{ ...graphReviewIssue("Broken"), reviewSourceIds: ["review/panel.1/issue-1"] }],
          testCoverageGaps: [],
          verdict: { ready: "with-fixes", reasoning: "Fix first" },
        }
      : {},
  );
  w.fakes.scripts.set("review", ({ port }) =>
    port === "report"
      ? graphReviewReport(
          findings
            ? { issues: [graphReviewIssue("Broken")], testCoverageGaps: [graphReviewGap("Gap")] }
            : {},
        )
      : undefined,
  );
  w.fakes.scripts.set("consolidate", ({ port }) => (port === "report" ? report : undefined));
  w.fakes.scripts.set("fix", ({ port }) =>
    port === "result"
      ? {
          complete: fixComplete,
          summary: fixComplete ? "Fixed" : "One finding remains",
          filesChanged: ["src/a.ts"],
          commandsRun: [],
          notes: [],
          // An incomplete result must say why (the type's domain check).
          limitations: fixComplete ? [] : ["One finding needs a design decision"],
        }
      : undefined,
  );
  return w;
}

const only = (run: GraphRun, nodeId: string): NodeActivation => {
  const found = run.activations.filter((activation) => activation.nodeId === nodeId);
  if (found.length !== 1) throw new Error(`${nodeId} has ${found.length} activations`);
  return found[0]!;
};

/** Every distinct `autoPrLaunch.state` the record showed, in order. */
async function settleWatchingPr(
  w: GraphReviewWorld,
  workflowId: string,
): Promise<{ settled: MultiReviewWorkflow; prStates: string[]; phases: string[] }> {
  const prStates: string[] = [];
  const phases: string[] = [];
  const settled = await w.drive(workflowId, (current) => {
    const state = current.autoPrLaunch?.state ?? "none";
    if (prStates.at(-1) !== state) prStates.push(state);
    if (phases.at(-1) !== current.phase) phases.push(current.phase);
    return current.graphRun?.settled === true;
  });
  return { settled, prStates, phases };
}

describe("auto-fix and auto-PR on the graph engine", () => {
  test("a Fix that completes queues the pull request, which opens only after it", async () => {
    const w = await world(true);
    const { settled, prStates, phases } = await settleWatchingPr(
      w,
      (await w.start({ autoFix: true, autoPr: true })).id,
    );
    expect(phases).toEqual(
      expect.arrayContaining(["reviewing", "consolidating", "fixing", "completed"]),
    );
    expect(phases.indexOf("fixing")).toBeLessThan(phases.indexOf("completed"));
    expect(settled.phase).toBe("completed");
    expect(settled.fixResult?.complete).toBe(true);
    expect(prStates).toEqual(["none", "pending", "launched"]);
    expect(settled.autoPrLaunch).toMatchObject({
      state: "launched",
      fixIdentity: multiReviewFixIdentity(settled.fixSession),
    });
    expect(settled.autoPrLaunch?.basis).toBeUndefined();

    const run = await w.run(settled);
    const fix = only(run, "fix");
    const describe = only(run, "describe-pr");
    const pr = only(run, "pr");
    // The Fix's own commit is what the pull request publishes.
    expect(only(run, "fix-complete").outlet).toBe("complete");
    expect(describe.inputs.code).toBe(fix.outputs.code);
    expect(pr.inputs.code).toBe(fix.outputs.code);
    expect(Date.parse(pr.startedAt!)).toBeGreaterThanOrEqual(Date.parse(fix.finishedAt!));
    // The pull request is a system node; no agent pushed or opened it.
    expect(run.plan.nodes.find((node) => node.id === "pr")?.kind).toBe("system");
    const agentStarts = w.fakes.callsOf("start").filter((call) => call.kind === "agent");
    expect(agentStarts.map((call) => call.nodeId)).not.toContain("pr");
  });

  test("a Fix that does not complete fails the review and queues no pull request", async () => {
    const w = await world(true, false);
    const { settled, prStates } = await settleWatchingPr(
      w,
      (await w.start({ autoFix: true, autoPr: true })).id,
    );
    expect(settled.phase).toBe("failed");
    expect(settled.error).toBe(
      "The fix model could not address every finding: One finding remains",
    );
    expect(prStates).toEqual(["none"]);
    const run = await w.run(settled);
    expect(only(run, "pr").state).toBe("skipped");
    expect(only(run, "describe-pr").state).toBe("skipped");
  });

  test("a clean report goes straight to the pull request whatever autoFix says", async () => {
    const w = await world(false);
    const { settled, prStates } = await settleWatchingPr(
      w,
      (await w.start({ autoFix: false, autoPr: true })).id,
    );
    expect(settled.phase).toBe("ready");
    expect(prStates).toEqual(["none", "pending", "launched"]);
    expect(settled.autoPrLaunch).toMatchObject({ basis: "clean-review", state: "launched" });
    const run = await w.run(settled);
    expect(only(run, "has-findings").outlet).toBe("clean");
    expect(only(run, "fix").state).toBe("skipped");
    expect(only(run, "pr").inputs.code).toBe(only(run, "plan").outputs.code);
  });

  test("findings without autoFix end ready; the manual Fix then runs as on any review", async () => {
    const w = await world(true);
    const { settled, prStates } = await settleWatchingPr(
      w,
      (await w.start({ autoFix: false, autoPr: true })).id,
    );
    expect(settled.phase).toBe("ready");
    expect(prStates).toEqual(["none"]);
    const run = await w.run(settled);
    expect(only(run, "fix").state).toBe("skipped");
    expect(only(run, "pr").state).toBe("skipped");
    // The settled record is an ordinary review: the user's Fix is the bespoke
    // interactive handoff, and its completion may still queue the PR.
    const addressed = await w.service.address(settled.id);
    expect(addressed).toMatchObject({
      engine: "graph",
      phase: "interactive",
      addressPromptPending: true,
      graphRun: { settled: true },
    });
  });

  test("autoPr off never reaches the pull request nodes", async () => {
    const w = await world(true);
    const { settled, prStates } = await settleWatchingPr(
      w,
      (await w.start({ autoFix: true, autoPr: false })).id,
    );
    expect(settled.phase).toBe("completed");
    expect(prStates).toEqual(["none"]);
    const run = await w.run(settled);
    expect(only(run, "describe-pr").state).toBe("skipped");
    expect(only(run, "pr").state).toBe("skipped");
  });
});
