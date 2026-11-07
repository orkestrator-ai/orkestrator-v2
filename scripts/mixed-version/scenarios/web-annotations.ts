/**
 * web-annotations across versions (plan item 7004): a current renderer's
 * `web-annotations` client against each node of the pair, in a worker's
 * environment, without a capture. The capabilities answer at the contract
 * version with storage and rollout state (runtime state, read on every
 * version), the worker's notes list (none yet), and the destinations read.
 * Version 1 sends the envelope and decodes results; version 0 is today's call.
 */
import { WEB_ANNOTATION_CONTRACT_VERSION } from "@orkestrator/protocol/web-annotations";
import { webAnnotationsClient } from "@orkestrator/protocol/contract/domains/web-annotations";
import { defineScenario } from "../scenario.ts";
import { expectedRendererAdapter, pairNodes, rendererClient } from "./renderer-client.ts";

const COMMANDS = [
  "web_annotations_capabilities",
  "web_annotations_list",
  "web_annotation_destinations",
];

export default defineScenario({
  domain: "web-annotations",
  title: "Web annotation capabilities, list and destinations, from a current renderer",
  requires: { command: COMMANDS, leaf: COMMANDS },
  async run(ctx) {
    for (const node of pairNodes(ctx.command, ctx.leaf)) {
      const tag = node.role === "command" ? "C" : "L";
      const worker = await ctx.fixtures.worker(node);
      const { client, version, calls } = rendererClient(node, webAnnotationsClient);
      const annotations = client.api();
      ctx.check(
        `WA-${tag}1`,
        `the renderer picks the adapter ${node.label}'s hello implies`,
        version === expectedRendererAdapter(node, "web-annotations"),
        `picked ${version}`,
      );
      const environmentId = worker.environmentId;
      const capabilities = await annotations.run("web_annotations_capabilities", {
        environmentId,
      });
      ctx.check(
        `WA-${tag}2`,
        "the capabilities answer at the contract version with their storage state",
        capabilities.contractVersion === WEB_ANNOTATION_CONTRACT_VERSION &&
          typeof capabilities.storage === "string",
      );
      if (capabilities.storage === "unavailable" || capabilities.operations.read !== true) {
        ctx.note(`${node.role} web annotations`, {
          adapter: version,
          storage: capabilities.storage,
        });
        continue;
      }
      const listed = await annotations.run("web_annotations_list", { environmentId });
      ctx.check(
        `WA-${tag}3`,
        "a worker without notes lists none",
        Array.isArray(listed.items) && listed.items.length === 0,
      );
      const destinations = await annotations.run("web_annotation_destinations", {
        environmentId,
      });
      ctx.check(
        `WA-${tag}4`,
        "the worker's request destinations read",
        Array.isArray(destinations.options),
      );
      ctx.note(`${node.role} web annotations`, {
        adapter: version,
        calls: Object.fromEntries(calls),
      });
    }
  },
});
