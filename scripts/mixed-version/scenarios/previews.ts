/**
 * previews across versions (plan item 7004): a current renderer's `previews`
 * client against each node of the pair, in a worker's (local) environment.
 * The capabilities answer with their response-level versioning, a worktree
 * service is registered, updated at its revision and removed at its
 * revision, a retried registration replays by operation id, and the
 * operator settings read back. Version 1 sends the envelope with the
 * critical keys; version 0 is today's call.
 */
import { previewsClient } from "@orkestrator/protocol/contract/domains/previews";
import { defineScenario } from "../scenario.ts";
import { expectedRendererAdapter, pairNodes, rendererClient } from "./renderer-client.ts";

const COMMANDS = [
  "get_preview_capabilities",
  "get_preview_services",
  "register_preview_service",
  "update_preview_service",
  "remove_preview_service",
  "get_preview_settings",
];

export default defineScenario({
  domain: "previews",
  title: "Preview registry and settings, from a current renderer",
  requires: { command: COMMANDS, leaf: COMMANDS },
  async run(ctx) {
    for (const node of pairNodes(ctx.command, ctx.leaf)) {
      const tag = node.role === "command" ? "C" : "L";
      const worker = await ctx.fixtures.worker(node);
      const { client, version, calls } = rendererClient(node, previewsClient);
      const previews = client.api();
      ctx.check(
        `PV-${tag}1`,
        `the renderer picks the adapter ${node.label}'s hello implies`,
        version === expectedRendererAdapter(node, "previews"),
        `picked ${version}`,
      );

      const capabilities = await previews.capabilities({});
      ctx.check(
        `PV-${tag}2`,
        "the capabilities carry the protocol version, backend epoch and registry availability",
        typeof capabilities.protocolVersion === "number" &&
          typeof capabilities.backendEpoch === "string" &&
          capabilities.registry?.available === true,
      );

      const operationId = `qualification-${tag.toLowerCase()}-${Date.now()}`;
      const service = {
        environmentId: worker.environmentId,
        label: "qualification",
        targetKind: "worktree",
        applicationPort: 4173,
      };
      const created = await previews.register({ service, operationId });
      const replayed = await previews.register({ service, operationId });
      const createdDefinition = created.kind === "definition" ? created.definition : null;
      ctx.check(
        `PV-${tag}3`,
        "a registration is created once and a retry with its operation id replays it",
        createdDefinition !== null &&
          replayed.kind === "definition" &&
          replayed.replayed === true &&
          replayed.definition.serviceId === createdDefinition.serviceId,
      );
      if (!createdDefinition) continue;

      const updated = await previews.update({
        serviceId: createdDefinition.serviceId,
        expectedRevision: createdDefinition.definitionRevision,
        patch: { label: "qualification 2" },
        operationId: `${operationId}-update`,
      });
      const listed = await previews.services({ environmentId: worker.environmentId });
      const revision =
        updated.kind === "definition" ? updated.definition.definitionRevision : undefined;
      const removed = await previews.remove({
        serviceId: createdDefinition.serviceId,
        ...(revision === undefined ? {} : { expectedRevision: revision }),
        operationId: `${operationId}-remove`,
      });
      ctx.check(
        `PV-${tag}4`,
        "the service is updated at its revision, listed, and removed at its revision",
        updated.kind === "definition" &&
          updated.definition.label === "qualification 2" &&
          listed.services.some(
            (entry) => entry.definition.serviceId === createdDefinition.serviceId,
          ) &&
          removed.kind === "removed",
      );

      const settings = await previews.settings({});
      ctx.check(
        `PV-${tag}5`,
        "the operator settings read back",
        typeof settings.effective?.transport === "boolean",
      );
      ctx.note(`${node.role} previews`, { adapter: version, calls: Object.fromEntries(calls) });
    }
  },
});
