import {
  normalizeTicketContent,
  type TicketContent,
  type TicketKind,
  type TicketSections,
} from "@orkestrator/protocol/ticket-sections";

/**
 * A ticket's kind and sections. A backend that predates sections sends only
 * the text fields, so they are derived here the same way the backend does.
 */
export function ticketContentOf(task: {
  kind?: TicketKind;
  description: string;
  acceptanceCriteria: string;
  sections?: TicketSections;
  sectionsBasis?: string;
  createdAt?: string;
}): TicketContent {
  if (task.sections && task.kind) {
    return {
      kind: task.kind,
      description: task.description,
      acceptanceCriteria: task.acceptanceCriteria,
      sections: task.sections,
      sectionsBasis: task.sectionsBasis ?? "",
    };
  }
  return normalizeTicketContent(task, task.createdAt ? { now: task.createdAt } : {});
}
