import {
  normalizeTicketLabelColor,
  normalizeTicketLabelDescription,
  normalizeTicketLabelName,
  ticketLabelKey,
  TICKET_LABEL_LIMITS,
  type TicketLabelDefinition,
} from "@orkestrator/protocol/ticket-labels";
import type { StorageContext } from "./storage-context.js";
import type { StorageFiles } from "./storage-files.js";
import type { KanbanLabelCatalogue } from "./storage-shared-core.js";
import { nowIso } from "./storage-shared.js";

/**
 * Each project's ticket label catalogue (`kanban-labels`, one row per
 * project). A collaborator of `KanbanRepository`, which reaches it as
 * `storage.kanban`. The catalogue's only writer is `updateStoreRow`; the
 * labels on tickets live on the Kanban rows and are written under the
 * Kanban lease.
 */

export interface KanbanLabelInput {
  name: string;
  color?: string;
  description?: string;
}

/** What a create did: the label as stored, and whether it is new. */
export interface KanbanLabelCreateResult {
  label: TicketLabelDefinition;
  created: boolean;
}

export function parseKanbanLabelInput(input: {
  name: unknown;
  color?: unknown;
  description?: unknown;
}): KanbanLabelInput {
  const description =
    input.description === undefined
      ? undefined
      : normalizeTicketLabelDescription(input.description);
  return {
    name: normalizeTicketLabelName(input.name),
    ...(input.color !== undefined ? { color: normalizeTicketLabelColor(input.color) } : {}),
    ...(description ? { description } : {}),
  };
}

function storedLabels(row: unknown): TicketLabelDefinition[] {
  if (!row || typeof row !== "object") return [];
  const labels = (row as Partial<KanbanLabelCatalogue>).labels;
  if (!Array.isArray(labels)) return [];
  return labels.filter(
    (label): label is TicketLabelDefinition =>
      Boolean(label) && typeof label.name === "string" && typeof label.createdAt === "string",
  );
}

export class KanbanLabelCatalogueStore {
  constructor(
    private readonly context: StorageContext,
    private readonly files: StorageFiles,
  ) {}

  list(projectId: string): TicketLabelDefinition[] {
    return storedLabels(this.context.loadStoreRow(this.files.kanbanLabelsFile(), projectId));
  }

  /**
   * Creates a label, or returns the one with the same name (ignoring case).
   * An existing label takes a colour or description the call gives, and keeps
   * what it omits.
   */
  create(projectId: string, input: KanbanLabelInput): KanbanLabelCreateResult {
    return this.context.updateStoreRow<KanbanLabelCreateResult>(
      this.files.kanbanLabelsFile(),
      projectId,
      (current) => {
        const labels = storedLabels(current);
        const index = labels.findIndex(
          (label) => ticketLabelKey(label.name) === ticketLabelKey(input.name),
        );
        if (index >= 0) {
          const existing = labels[index]!;
          const updated: TicketLabelDefinition = {
            ...existing,
            ...(input.color !== undefined ? { color: input.color } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
          };
          if (JSON.stringify(updated) === JSON.stringify(existing)) {
            return { result: { label: existing, created: false } };
          }
          const next = labels.map((label, position) => (position === index ? updated : label));
          return { result: { label: updated, created: false }, value: { projectId, labels: next } };
        }
        if (labels.length >= TICKET_LABEL_LIMITS.maxCatalogue) {
          throw new Error(
            `A project can have at most ${TICKET_LABEL_LIMITS.maxCatalogue} labels in its catalogue`,
          );
        }
        const label: TicketLabelDefinition = {
          name: input.name,
          ...(input.color !== undefined ? { color: input.color } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          createdAt: nowIso(),
        };
        return {
          result: { label, created: true },
          value: { projectId, labels: [...labels, label] },
        };
      },
    );
  }
}
