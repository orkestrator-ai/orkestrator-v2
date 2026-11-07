/**
 * pipelines across versions (plan item 7007): a current renderer's
 * `pipelines` client against each node of the pair, without starting a build
 * or an agent turn. A project's pipelines are listed, an unknown pipeline
 * reads as `null`, an empty legacy import changes nothing, the backend-owned
 * record refuses a renderer save, and a worker environment's unread badge is
 * set and cleared at its last activity (`expectedLastActivityAt` is a
 * critical field on version 1). A pre-contract node gets today's calls
 * through version 0.
 */
import { pipelinesClient } from "@orkestrator/protocol/contract/domains/pipelines";
import { defineScenario } from "../scenario.ts";
import { expectedRendererAdapter, pairNodes, rendererClient } from "./renderer-client.ts";

const COMMANDS = [
  "list_build_pipelines",
  "get_build_pipeline",
  "import_legacy_build_pipelines",
  "save_build_pipeline",
  "set_environment_unread",
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
  domain: "pipelines",
  title:
    "Pipeline reads, an empty import, a refused save and the unread badge, from a current renderer",
  requires: { command: COMMANDS, leaf: COMMANDS },
  async run(ctx) {
    for (const node of pairNodes(ctx.command, ctx.leaf)) {
      const tag = node.role === "command" ? "C" : "L";
      const worker = await ctx.fixtures.worker(node);
      const { projectId } = await ctx.fixtures.project(node);
      const { client, version, calls } = rendererClient(node, pipelinesClient);
      const pipelines = client.api();
      ctx.check(
        `PL-${tag}1`,
        `the renderer picks the adapter ${node.label}'s hello implies`,
        version === expectedRendererAdapter(node, "pipelines"),
        `picked ${version}`,
      );

      const listed = await pipelines.list_build_pipelines({ projectId });
      const missing = await pipelines.get_build_pipeline({ pipelineId: "qualification-missing" });
      ctx.check(
        `PL-${tag}2`,
        "a project's pipelines list as records and an unknown pipeline reads as null",
        Array.isArray(listed) && missing === null,
      );

      const imported = await pipelines.import_legacy_build_pipelines({ projectId, snapshots: [] });
      const refused = await refusal(() => pipelines.save_build_pipeline({}));
      ctx.check(
        `PL-${tag}3`,
        "an empty legacy import changes nothing and a renderer save is refused",
        imported.importedIds.length === 0 &&
          imported.skipped === 0 &&
          (refused?.includes("backend-owned") ?? false),
        refused ?? "save accepted",
      );

      const marked = await pipelines.set_environment_unread({
        environmentId: worker.environmentId,
        unread: true,
      });
      const cleared = await pipelines.set_environment_unread({
        environmentId: worker.environmentId,
        unread: false,
        expectedLastActivityAt: marked.lastActivityAt ?? null,
      });
      ctx.check(
        `PL-${tag}4`,
        "the worker's unread badge is set, then cleared at its last activity",
        marked.id === worker.environmentId &&
          marked.hasUnreadWork === true &&
          cleared.hasUnreadWork === false,
      );
      ctx.note(`${node.role} pipelines`, {
        adapter: version,
        calls: Object.fromEntries(calls),
        listed: Array.isArray(listed) ? listed.length : null,
      });
    }
  },
});
