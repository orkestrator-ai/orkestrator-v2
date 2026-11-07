/**
 * pull-requests across versions (plan item 7006): a current renderer's
 * `pull-requests` client against each node of the pair, on a worker
 * environment. The PR-monitor snapshot answers its bare and conditional
 * forms, the post-turn PR recheck is armed only for an open pull request
 * with conflicts (the worker has none, so the arm answers `null`; a token,
 * when one comes back, is rolled back exactly), and auto-merge turns off and
 * reads back off on the node itself. A node
 * with the domain gets version 1; a pre-contract node gets today's bodies
 * through version 0.
 *
 * Nothing here reaches GitHub or pushes: the worker has no pull request, so
 * no `gh` lookup runs, auto-merge is only turned off (turning it on asks the
 * monitor for a reading), and the GitHub issue and pull request viewer
 * commands, which need a credential, are not called.
 */
import { pullRequestsClient } from "@orkestrator/protocol/contract/domains/pull-requests";
import { defineScenario } from "../scenario.ts";
import { expectedRendererAdapter, pairNodes, rendererClient } from "./renderer-client.ts";

const COMMON = [
  "get_pr_monitor_state",
  "arm_pr_refresh_after_agent_completion",
  "disarm_pr_refresh_after_agent_completion",
  "set_environment_auto_merge",
];

export default defineScenario({
  domain: "pull-requests",
  title: "The PR monitor, the post-turn recheck and auto-merge off, from a current renderer",
  requires: { command: COMMON, leaf: COMMON },
  async run(ctx) {
    for (const node of pairNodes(ctx.command, ctx.leaf)) {
      const tag = node.role === "command" ? "C" : "L";
      const worker = await ctx.fixtures.worker(node);
      const prApi = rendererClient(node, pullRequestsClient);
      ctx.check(
        `PR-${tag}1`,
        `the renderer picks the adapter ${node.label}'s hello implies`,
        prApi.version === expectedRendererAdapter(node, "pull-requests"),
        `picked ${prApi.version}`,
      );
      const prs = prApi.client.api();

      const monitor = await prs.get_pr_monitor_state({});
      const stamp =
        "entries" in monitor && typeof monitor.generation === "string"
          ? { generation: monitor.generation, revision: monitor.revision ?? 0 }
          : null;
      const again = stamp
        ? await prs.get_pr_monitor_state({
            knownGeneration: stamp.generation,
            knownRevision: stamp.revision,
          })
        : null;
      ctx.check(
        `PR-${tag}2`,
        "the PR-monitor snapshot reads bare, and conditionally when it is stamped",
        "entries" in monitor &&
          Array.isArray(monitor.entries) &&
          (again === null || "status" in again),
      );

      const armedAt = await prs.arm_pr_refresh_after_agent_completion({
        environmentId: worker.environmentId,
      });
      const disarmed =
        typeof armedAt === "string" &&
        (await prs
          .disarm_pr_refresh_after_agent_completion({
            environmentId: worker.environmentId,
            armedAt,
          })
          .then(
            () => true,
            () => false,
          ));
      // `armPrRecheckAfterAgentCompletion` arms only an open, conflicted pull
      // request; this worker has none, so nothing is armed (2026-11-07: the
      // first live run showed the module had assumed a token).
      ctx.check(
        `PR-${tag}3`,
        "the post-turn recheck arms nothing without a pull request; a returned arm is rolled back exactly",
        armedAt === null || disarmed,
        typeof armedAt,
      );

      const environment = await prs.set_environment_auto_merge({
        environmentId: worker.environmentId,
        enabled: false,
      });
      const stored = (await node.invoke("get_environment", {
        environmentId: worker.environmentId,
      })) as { autoMerge?: boolean } | null;
      ctx.check(
        `PR-${tag}4`,
        "auto-merge turns off, in the answer and on the node itself",
        environment.id === worker.environmentId &&
          environment.autoMerge === false &&
          stored?.autoMerge === false,
      );
      ctx.note(`${node.role} pull-requests`, {
        adapter: prApi.version,
        calls: Object.fromEntries(prApi.calls),
      });
    }
  },
});
