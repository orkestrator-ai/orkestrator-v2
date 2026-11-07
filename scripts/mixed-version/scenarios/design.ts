/**
 * design across versions (plan item 7004): a current renderer's `design`
 * client against each node of the pair, in a worker's environment. The
 * capability envelope answers (version 1 lays the domain's flags over it;
 * version 0 is the node's own `design_capabilities`), and the worker's design
 * library reads through the typed envelope, an empty page or a typed
 * failure, never a thrown schema error. The design renderer is not started.
 */
import { designClient, designLibraryCommand } from "@orkestrator/protocol/contract/domains/design";
import { defineScenario } from "../scenario.ts";
import { expectedRendererAdapter, pairNodes, rendererClient } from "./renderer-client.ts";

const COMMANDS = ["design_capabilities", "design_library"];

export default defineScenario({
  domain: "design",
  title: "Design capabilities and library, from a current renderer",
  requires: { command: COMMANDS, leaf: COMMANDS },
  async run(ctx) {
    for (const node of pairNodes(ctx.command, ctx.leaf)) {
      const tag = node.role === "command" ? "C" : "L";
      const worker = await ctx.fixtures.worker(node);
      const { client, version, calls } = rendererClient(node, designClient);
      const design = client.api();
      ctx.check(
        `DS-${tag}1`,
        `the renderer picks the adapter ${node.label}'s hello implies`,
        version === expectedRendererAdapter(node, "design"),
        `picked ${version}`,
      );

      const capabilities = (await design.capabilities()) as { ok?: unknown } | null;
      ctx.check(
        `DS-${tag}2`,
        "the capabilities answer a typed envelope",
        typeof capabilities?.ok === "boolean",
      );

      const library = (await design.command(designLibraryCommand, {
        environmentId: worker.environmentId,
        query: { filter: "live", limit: 5 },
      })) as { ok?: unknown } | null;
      ctx.check(
        `DS-${tag}3`,
        "the worker's design library reads through the typed envelope",
        typeof library?.ok === "boolean",
      );
      ctx.note(`${node.role} design`, { adapter: version, calls: Object.fromEntries(calls) });
    }
  },
});
