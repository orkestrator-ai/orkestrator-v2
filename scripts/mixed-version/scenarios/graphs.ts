/**
 * graphs across versions (plan item 7007): a current renderer's `graphs`
 * client against each node of the pair, without a run or an agent turn. The
 * template library lists its built-ins, reads and compiles one, duplicates it
 * into a user template that is read back and deleted at its revision (the
 * compare-and-swap `expectedRevision` is a critical field on version 1), the
 * project's capability ceiling is read, and a worker's environment lists no
 * runs. A pre-contract node gets today's calls through version 0.
 */
import { graphsClient } from "@orkestrator/protocol/contract/domains/graphs";
import { defineScenario } from "../scenario.ts";
import { expectedRendererAdapter, pairNodes, rendererClient } from "./renderer-client.ts";

const COMMANDS = [
  "graph_templates_list",
  "graph_template_get",
  "graph_template_compile",
  "graph_template_duplicate",
  "graph_template_delete",
  "graph_capability_ceiling_get",
  "graph_runs_list",
];

export default defineScenario({
  domain: "graphs",
  title: "Template library round trip, ceiling and run list, from a current renderer",
  requires: { command: COMMANDS, leaf: COMMANDS },
  async run(ctx) {
    for (const node of pairNodes(ctx.command, ctx.leaf)) {
      const tag = node.role === "command" ? "C" : "L";
      const worker = await ctx.fixtures.worker(node);
      const { projectId } = await ctx.fixtures.project(node);
      const { client, version, calls } = rendererClient(node, graphsClient);
      const graphs = client.api();
      ctx.check(
        `GR-${tag}1`,
        `the renderer picks the adapter ${node.label}'s hello implies`,
        version === expectedRendererAdapter(node, "graphs"),
        `picked ${version}`,
      );

      const listed = await graphs.graph_templates_list({ projectId });
      const builtin = listed.templates.find((entry) => entry.scope === "builtin");
      ctx.check(
        `GR-${tag}2`,
        "the library lists built-in templates and the project's ceiling",
        builtin !== undefined && Array.isArray(listed.ceiling?.deny),
      );
      if (!builtin) continue;

      const detail = await graphs.graph_template_get({ ref: builtin.ref, projectId });
      const compiled = await graphs.graph_template_compile({ ref: builtin.ref, projectId });
      ctx.check(
        `GR-${tag}3`,
        "a built-in template is read and compiled",
        detail.template.id === builtin.id &&
          typeof compiled.ok === "boolean" &&
          Array.isArray(compiled.diagnostics),
      );

      const id = `qualification-${tag.toLowerCase()}`;
      const copy = await graphs.graph_template_duplicate({
        ref: builtin.ref,
        id,
        name: `Qualification ${tag}`,
      });
      const read = await graphs.graph_template_get({ ref: copy.summary.ref });
      const deleted = await graphs.graph_template_delete({
        id: copy.template.id,
        expectedRevision: copy.summary.revision,
      });
      const after = await graphs.graph_templates_list({});
      ctx.check(
        `GR-${tag}4`,
        "a duplicate is saved as a user template, read back and deleted at its revision",
        copy.summary.scope === "user" &&
          read.template.id === copy.template.id &&
          deleted.deleted === true &&
          !after.templates.some((entry) => entry.scope === "user" && entry.id === copy.template.id),
      );

      const ceiling = await graphs.graph_capability_ceiling_get({ projectId });
      const runs = await graphs.graph_runs_list({ environmentId: worker.environmentId });
      ctx.check(
        `GR-${tag}5`,
        "the project's ceiling is read and a fresh environment has no runs",
        ceiling.projectId === projectId && Array.isArray(runs) && runs.length === 0,
      );
      ctx.note(`${node.role} graphs`, {
        adapter: version,
        calls: Object.fromEntries(calls),
        builtins: listed.templates.filter((entry) => entry.scope === "builtin").length,
      });
    }
  },
});
