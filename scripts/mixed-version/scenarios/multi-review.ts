/**
 * multi-review across versions (plan item 7007): a current renderer's
 * `multi-review` client against each node of the pair, without starting a
 * review or an agent turn. A worker environment lists no workflows, an
 * unknown workflow reads as `null` (also when the read is conditional on a
 * revision), and malformed start and history-page requests are refused with
 * the guards' own text, before any supervision. A pre-contract node gets
 * today's calls through version 0.
 */
import { multiReviewClient } from "@orkestrator/protocol/contract/domains/multi-review";
import { defineScenario } from "../scenario.ts";
import { expectedRendererAdapter, pairNodes, rendererClient } from "./renderer-client.ts";

const COMMANDS = [
  "list_multi_review_workflows",
  "get_multi_review_workflow",
  "start_multi_review",
  "get_multi_review_reviewer_history_page",
];

async function refusal(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export default defineScenario({
  domain: "multi-review",
  title: "Workflow reads and refused malformed requests, from a current renderer",
  requires: { command: COMMANDS, leaf: COMMANDS },
  async run(ctx) {
    for (const node of pairNodes(ctx.command, ctx.leaf)) {
      const tag = node.role === "command" ? "C" : "L";
      const worker = await ctx.fixtures.worker(node);
      const { projectId } = await ctx.fixtures.project(node);
      const { client, version, calls } = rendererClient(node, multiReviewClient);
      const reviews = client.api();
      ctx.check(
        `MR-${tag}1`,
        `the renderer picks the adapter ${node.label}'s hello implies`,
        version === expectedRendererAdapter(node, "multi-review"),
        `picked ${version}`,
      );

      const listed = await reviews.list_multi_review_workflows({
        environmentId: worker.environmentId,
      });
      const missing = await reviews.get_multi_review_workflow({
        workflowId: "qualification-missing",
      });
      const conditional = await reviews.get_multi_review_workflow({
        workflowId: "qualification-missing",
        knownRevision: 3,
      });
      ctx.check(
        `MR-${tag}2`,
        "a fresh environment lists no workflows and an unknown workflow reads as null",
        Array.isArray(listed) && listed.length === 0 && missing === null && conditional === null,
      );

      const start = await refusal(() =>
        reviews.start_multi_review({
          environmentId: worker.environmentId,
          projectId,
          targetBranch: "main",
          reviewers: [],
        }),
      );
      const page = await refusal(() =>
        reviews.get_multi_review_reviewer_history_page({
          workflowId: "qualification-missing",
          reviewerId: "reviewer-1",
          before: "",
        }),
      );
      ctx.check(
        `MR-${tag}3`,
        "malformed start and history-page requests are refused with the guards' text",
        (start?.includes("Invalid multi review start request") ?? false) &&
          (page?.includes("Invalid multi review reviewer history page request") ?? false),
        `${start ?? "start accepted"}; ${page ?? "page accepted"}`,
      );
      ctx.note(`${node.role} multi-review`, {
        adapter: version,
        calls: Object.fromEntries(calls),
      });
    }
  },
});
