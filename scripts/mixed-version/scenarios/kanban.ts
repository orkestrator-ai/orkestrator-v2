/**
 * kanban across versions (plan item 7008): a current renderer's `kanban`
 * client against each node of the pair, in each node's own project. A ticket
 * is created (with a `requestId`), updated, listed, commented on and deleted;
 * the project notes are saved and read back; a feature plan is created,
 * renamed and listed. No Linear or GitHub call, no planning agent turn.
 *
 * Ticket ids are the same on every node and ticket sync may copy one node's
 * tickets to the other, so each node is checked on its own: what it answers
 * for the ticket it created, never the absence of the other's.
 */
import { kanbanClient } from "@orkestrator/protocol/contract/domains/kanban";
import { defineScenario } from "../scenario.ts";
import { expectedRendererAdapter, pairNodes, rendererClient } from "./renderer-client.ts";

const COMMANDS = [
  "add_kanban_task",
  "update_kanban_task",
  "get_kanban_tasks",
  "add_kanban_comment",
  "delete_kanban_task",
  "save_project_notes",
  "get_project_notes",
  "create_feature_plan",
  "update_feature_plan",
  "get_feature_plans",
];

/** A list read's array, or the snapshot of a conditional answer. */
function listOf<T>(answer: T[] | { status: string; snapshot?: T[] }): T[] {
  return Array.isArray(answer) ? answer : (answer.snapshot ?? []);
}

export default defineScenario({
  domain: "kanban",
  title: "Kanban tickets, project notes and feature plans, from a current renderer",
  requires: { command: COMMANDS, leaf: COMMANDS },
  async run(ctx) {
    for (const node of pairNodes(ctx.command, ctx.leaf)) {
      const tag = node.role === "command" ? "C" : "L";
      const { projectId } = await ctx.fixtures.project(node);
      const { client, version, calls } = rendererClient(node, kanbanClient);
      const kanban = client.api();
      ctx.check(
        `KB-${tag}1`,
        `the renderer picks the adapter ${node.label}'s hello implies`,
        version === expectedRendererAdapter(node, "kanban"),
        `picked ${version}`,
      );

      const title = `qualification ticket ${tag}`;
      const requestId = `qualification-ticket-${tag.toLowerCase()}`;
      const created = await kanban.add_kanban_task({
        projectId,
        title,
        description: "Created by the mixed-version qualification.",
        requestId,
      });
      const retried = await kanban.add_kanban_task({
        projectId,
        title,
        description: "Created by the mixed-version qualification.",
        requestId,
      });
      ctx.check(
        `KB-${tag}2`,
        "a ticket is created in the node's project, and a retry by requestId returns it",
        created.projectId === projectId && created.title === title && retried.id === created.id,
      );

      const updated = await kanban.update_kanban_task({ taskId: created.id, status: "review" });
      const listed = listOf(await kanban.get_kanban_tasks({ projectId })).find(
        (ticket) => ticket.id === created.id,
      );
      ctx.check(
        `KB-${tag}3`,
        "an update is answered and listed by the node that holds the ticket",
        updated.status === "review" && listed?.status === "review" && listed.title === title,
      );

      const commented = await kanban.add_kanban_comment({
        taskId: created.id,
        text: "qualification comment",
        projectId,
      });
      ctx.check(
        `KB-${tag}4`,
        "a comment is added to the ticket",
        (commented.comments ?? []).some((comment) => comment.text === "qualification comment"),
      );

      await kanban.delete_kanban_task({ taskId: created.id });
      const afterDelete = listOf(await kanban.get_kanban_tasks({ projectId }));
      ctx.check(
        `KB-${tag}5`,
        "a deleted ticket leaves the node's list",
        !afterDelete.some((ticket) => ticket.id === created.id),
      );

      const content = `qualification notes ${tag}`;
      await kanban.save_project_notes({ projectId, content });
      const notes = await kanban.get_project_notes({ projectId });
      ctx.check(
        `KB-${tag}6`,
        "project notes are saved and read back",
        "content" in notes && notes.content === content,
      );

      const plan = await kanban.create_feature_plan({ projectId });
      const renamed = await kanban.update_feature_plan({
        featureId: plan.id,
        updates: { title: `qualification plan ${tag}` },
      });
      const plans = listOf(await kanban.get_feature_plans({ projectId }));
      ctx.check(
        `KB-${tag}7`,
        "a feature plan is created, renamed and listed",
        renamed.title === `qualification plan ${tag}` &&
          plans.some((candidate) => candidate.id === plan.id),
      );
      ctx.note(`${node.role} kanban`, { adapter: version, calls: Object.fromEntries(calls) });
    }
  },
});
