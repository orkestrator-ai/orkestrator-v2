/**
 * system across versions (plan item 7009): a current renderer's `system`
 * client against each node of the pair, reads only and no agent turn. The
 * version and greeting answer; the resource manifest reconciles (a second read
 * at the known generation and revisions has nothing to send); the scoped
 * manifest answers from cursor 0; worktree locations and the bug report
 * snapshot read back. Version 1 decodes each answer with its schema; version 0
 * is today's untyped call, answered as sent.
 */
import { systemClient } from "@orkestrator/protocol/contract/domains/system";
import { defineScenario } from "../scenario.ts";
import { expectedRendererAdapter, pairNodes, rendererClient } from "./renderer-client.ts";

const COMMANDS = [
  "get_app_version",
  "greet",
  "get_resource_revision_manifest",
  "get_scoped_resource_revision_manifest",
  "get_worktree_locations",
  "get_bug_report",
];

export default defineScenario({
  domain: "system",
  title: "Version, manifests, worktree locations and bug report reads, from a current renderer",
  requires: { command: COMMANDS, leaf: COMMANDS },
  async run(ctx) {
    for (const node of pairNodes(ctx.command, ctx.leaf)) {
      const tag = node.role === "command" ? "C" : "L";
      const { client, version } = rendererClient(node, systemClient);
      const system = client.api();
      ctx.check(
        `SY-${tag}1`,
        `the renderer picks the adapter ${node.label}'s hello implies`,
        version === expectedRendererAdapter(node, "system"),
        `picked ${version}`,
      );

      const appVersion = await system.get_app_version({});
      const greeting = await system.greet({ name: "qualification" });
      ctx.check(
        `SY-${tag}2`,
        "the node answers its version and its greeting",
        typeof appVersion === "string" &&
          appVersion.length > 0 &&
          typeof greeting === "string" &&
          greeting.includes("qualification"),
        `version ${String(appVersion).slice(0, 40)}`,
      );

      const first = await system.get_resource_revision_manifest({});
      const again = await system.get_resource_revision_manifest({
        knownGeneration: first.generation,
        knownRevisions: first.revisions,
      });
      ctx.check(
        `SY-${tag}3`,
        "a manifest read at the known generation and revisions has nothing to send",
        typeof first.generation === "string" &&
          again.generation === first.generation &&
          again.reset === false &&
          Object.keys(again.revisions ?? {}).length === 0,
      );

      const scoped = await system.get_scoped_resource_revision_manifest({ cursor: 0 });
      ctx.check(
        `SY-${tag}4`,
        "the scoped manifest answers from cursor 0 within one generation",
        typeof scoped.generation === "string" &&
          typeof scoped.cursor === "number" &&
          typeof scoped.highWater === "number" &&
          Array.isArray(scoped.changes),
        `changes ${Array.isArray(scoped.changes) ? scoped.changes.length : "?"}`,
      );

      const locations = await system.get_worktree_locations({});
      const report = await system.get_bug_report({});
      ctx.check(
        `SY-${tag}5`,
        "worktree locations and the bug report snapshot read back",
        typeof locations.environments?.effective === "string" &&
          typeof locations.dev?.defaultPath === "string" &&
          report !== null &&
          typeof report === "object" &&
          "report" in report,
      );
      ctx.note(`system ${node.label}`, { adapter: version });
    }
  },
});
