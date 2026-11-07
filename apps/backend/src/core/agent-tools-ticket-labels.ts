import type { McpServer } from "@modelcontextprotocol/server";
import { Schema } from "effect";
import type { KanbanTask, StorageService } from "./storage.js";
import { parseKanbanLabelInput } from "./storage-kanban-labels.js";
import { describe, str, toolInput, withDefault } from "./tool-schema.js";
import {
  ticketLabelColorField,
  ticketLabelDescriptionField,
  ticketLabelNameField,
} from "./ticket-tool-fields.js";

/**
 * The worker agent tools for ticket labels, scoped to the credential's
 * project: `list_ticket_labels` with the read group, `create_ticket_label`
 * and `set_ticket_label` with the write group. `create_ticket` and
 * `update_ticket` take `labels` too; these add or remove one at a time and
 * manage the project's catalogue.
 */
export function registerAgentTicketLabelTools(
  server: McpServer,
  storage: StorageService,
  scope: { projectId: string },
  access: { read: boolean; write: boolean },
  ticketResult: (ticket: KanbanTask) => {
    content: Array<{ type: "text"; text: string }>;
    structuredContent: Record<string, unknown>;
  },
): void {
  const toolResult = (value: Record<string, unknown>) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  });
  if (access.read) {
    server.registerTool(
      "list_ticket_labels",
      {
        title: "List Kanban ticket labels",
        description:
          "List the labels tickets in the current project can carry: its label catalogue and every label in use, with ticketCount.",
        inputSchema: toolInput(Schema.Struct({})),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => {
        const labels = await storage.kanban.getKanbanLabels(scope.projectId);
        return toolResult({ labels, total: labels.length });
      },
    );
  }
  if (!access.write) return;
  server.registerTool(
    "create_ticket_label",
    {
      title: "Create a Kanban ticket label",
      description:
        "Add a label to the current project's catalogue so tickets can use it. An existing name (any case) is kept, taking a color or description given here.",
      inputSchema: toolInput(
        Schema.Struct({
          name: ticketLabelNameField,
          color: ticketLabelColorField,
          description: ticketLabelDescriptionField,
        }),
      ),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ name, color, description }) => {
      const { label, created } = await storage.kanban.createKanbanLabel(
        scope.projectId,
        parseKanbanLabelInput({
          name,
          ...(color !== undefined ? { color } : {}),
          ...(description !== undefined ? { description } : {}),
        }),
      );
      return toolResult({ label, created });
    },
  );

  server.registerTool(
    "set_ticket_label",
    {
      title: "Add or remove a ticket label",
      description:
        "Add one label to a Kanban ticket in the current project, or remove it with present false. A name the project already uses keeps its spelling; a new name starts a label.",
      inputSchema: toolInput(
        Schema.Struct({
          ticketId: str({ trim: true, min: 1, max: 200 }),
          name: ticketLabelNameField,
          present: describe(withDefault(Schema.Boolean, true), "False removes the label."),
        }),
      ),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ ticketId, name, present }) => {
      const owned = (await storage.kanban.getKanbanTasks(scope.projectId)).some(
        (candidate) => candidate.id === ticketId,
      );
      if (!owned) throw new Error(`Kanban ticket not found in this project: ${ticketId}`);
      const ticket = await storage.kanban.setKanbanTaskLabel(
        ticketId,
        name,
        present,
        scope.projectId,
      );
      return ticketResult(ticket);
    },
  );
}
