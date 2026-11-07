/**
 * coordinator across versions (plan item 7009): a current renderer's
 * `coordinator` client against each node of the pair, on the fixtures'
 * coordinators, without starting an agent turn. The coordinator snapshot is
 * read plainly and conditionally (the second read with its stamp answers
 * `unchanged`), the panel's cross-project reads answer (activity, launch
 * overrides, the checkout's turn, the project's Git status), and a side
 * conversation is opened and closed. Version 1 sends the envelope and decodes
 * every answer with the command's schema; version 0 is today's untyped call.
 * The two newest panel reads (launch overrides, the checkout's turn) are
 * skipped by name on a release that predates them (2026-11-07: with them
 * required, the module never applied against any published release).
 */
import { coordinatorClient } from "@orkestrator/protocol/contract/domains/coordinator";
import { defineScenario } from "../scenario.ts";
import { expectedRendererAdapter, pairNodes, rendererClient } from "./renderer-client.ts";

const COMMANDS = [
  "get_project_coordinator",
  "get_project_coordinator_view",
  "list_coordinator_activity",
  "get_project_git_status",
  "create_coordinator_conversation",
  "close_coordinator_conversation",
];

type Conversation = { id: string; role?: string; closedAt?: string };

export default defineScenario({
  domain: "coordinator",
  title: "Coordinator snapshot, conditional view, panel reads and a side conversation",
  requires: { command: COMMANDS, leaf: COMMANDS },
  async run(ctx) {
    for (const node of pairNodes(ctx.command, ctx.leaf)) {
      const tag = node.role === "command" ? "C" : "L";
      const fixture = await ctx.fixtures.coordinator(node);
      const { client, version } = rendererClient(node, coordinatorClient);
      const coordinator = client.api();
      ctx.check(
        `CO-${tag}1`,
        `the renderer picks the adapter ${node.label}'s hello implies`,
        version === expectedRendererAdapter(node, "coordinator"),
        `picked ${version}`,
      );

      const { projectId } = fixture;
      const snapshot = await coordinator.get_project_coordinator({ projectId });
      const view = (await coordinator.get_project_coordinator_view({ projectId })) as {
        status?: string;
        generation?: string;
        revision?: number;
      };
      const again =
        typeof view.generation === "string" && typeof view.revision === "number"
          ? ((await coordinator.get_project_coordinator_view({
              projectId,
              knownGeneration: view.generation,
              knownRevision: view.revision,
            })) as { status?: string })
          : null;
      ctx.check(
        `CO-${tag}2`,
        "the coordinator snapshot is read, and a conditional read with its stamp is unchanged",
        snapshot?.workspace.id === fixture.coordinatorId &&
          view.status === "snapshot" &&
          again?.status === "unchanged",
        `view ${view.status ?? "?"}, again ${again?.status ?? "none"}`,
      );

      // Commands without arguments go as today's call without an arguments object.
      const activity = await coordinator.list_coordinator_activity(undefined as never);
      const hasOverrides = node.has("list_coordinator_launch_overrides");
      const hasTurn = node.has("get_coordinator_checkout_turn");
      const overrides = hasOverrides
        ? await coordinator.list_coordinator_launch_overrides(undefined as never)
        : null;
      const turn = hasTurn ? await coordinator.get_coordinator_checkout_turn({ projectId }) : null;
      const git = await coordinator.get_project_git_status({ projectId });
      ctx.check(
        `CO-${tag}3`,
        "the panel's reads answer: activity, launch overrides, the checkout's turn, Git status (the newer two where the node has them)",
        typeof activity?.projects === "object" &&
          (!hasOverrides || Array.isArray(overrides?.overrides)) &&
          (turn === null || typeof turn?.kind === "string") &&
          git?.projectId === projectId,
        `turn ${turn === null ? "none" : String(turn.kind)}`,
      );
      const skipped = [
        ...(hasOverrides ? [] : ["list_coordinator_launch_overrides"]),
        ...(hasTurn ? [] : ["get_coordinator_checkout_turn"]),
      ];

      const before = new Set(snapshot?.workspace.conversations.map((item) => item.id) ?? []);
      const opened = await coordinator.create_coordinator_conversation({
        projectId,
        title: `Qualification ${tag}`,
      });
      const side = (opened.workspace.conversations as readonly Conversation[]).find(
        (item) => !before.has(item.id),
      );
      const closed = side
        ? await coordinator.close_coordinator_conversation({ projectId, conversationId: side.id })
        : null;
      const sideAfter = (
        closed?.workspace.conversations as readonly Conversation[] | undefined
      )?.find((item) => item.id === side?.id);
      ctx.check(
        `CO-${tag}4`,
        "a side conversation is opened and closed",
        side?.role === "side" &&
          (sideAfter === undefined || typeof sideAfter.closedAt === "string"),
      );
      ctx.note(`coordinator.${tag}`, {
        adapter: version,
        conversations: before.size,
        ...(skipped.length > 0 ? { skipped } : {}),
      });
    }
  },
});
