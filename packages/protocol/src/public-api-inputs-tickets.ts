/**
 * Input contracts of the Kanban ticket actions, including ticket labels.
 * Split from `public-api-inputs.ts`, which composes them into
 * `PUBLIC_ACTION_INPUTS`; the same portable JSON Schema subset applies.
 */

import { PUBLIC_API_LIMITS } from "./public-api.js";
import type {
  PublicActionInputContract,
  PublicActionInputSchema,
  PublicJsonSchema,
} from "./public-api-inputs.js";
import { TICKET_LABEL_LIMITS } from "./ticket-labels.js";
import {
  ACCEPTANCE_CRITERIA_RULE,
  DELIVERY_POLICIES,
  TICKET_KIND_GUIDANCE,
  TICKET_KINDS,
  TICKET_SECTION_LIMITS,
  TICKET_SECTIONS_GUIDANCE,
} from "./ticket-sections.js";

export type TicketActionName =
  | "ticket.list"
  | "ticket.get"
  | "ticket.create"
  | "ticket.update"
  | "ticket.comment"
  | "ticket.labels"
  | "ticket.label"
  | "ticket.label.create";

function schema(
  properties: Record<string, PublicJsonSchema>,
  required: readonly string[] = [],
): PublicActionInputSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

function id(description: string): PublicJsonSchema {
  return { type: "string", minLength: 1, maxLength: PUBLIC_API_LIMITS.idMaxChars, description };
}

const projectId = id("Project ID, from project.list.");
const limit: PublicJsonSchema = {
  type: "integer",
  minimum: 1,
  maximum: PUBLIC_API_LIMITS.pageMaxItems,
  description: `Page size (default ${PUBLIC_API_LIMITS.pageDefaultItems}).`,
};
const cursor: PublicJsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 512,
  description: "nextCursor from the previous page.",
};
const labelName: PublicJsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: TICKET_LABEL_LIMITS.maxNameLength,
  description: "Label name (case is ignored when matching).",
};
const labelList: PublicJsonSchema = {
  type: "array",
  maxItems: TICKET_LABEL_LIMITS.maxPerTicket,
  items: labelName,
  description:
    "Label names, from ticket.labels or new. A name the project already uses keeps its spelling.",
};
const ticketId = id("Ticket ID, from ticket.list.");
const ticketStatus: PublicJsonSchema = {
  type: "string",
  enum: ["backlog", "in-progress", "review", "done"],
};
const ticketTitle: PublicJsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 500,
  description: "Ticket title.",
};
function ticketText(description: string): PublicJsonSchema {
  return { type: "string", maxLength: 100_000, description };
}
const ticketKind: PublicJsonSchema = {
  type: "string",
  enum: TICKET_KINDS,
  description: TICKET_KIND_GUIDANCE,
};
const ticketSections: PublicJsonSchema = {
  type: "object",
  additionalProperties: false,
  description: TICKET_SECTIONS_GUIDANCE,
  properties: {
    summary: ticketText("What the ticket is about."),
    problem: ticketText("What is wrong today."),
    context: ticketText("Background, evidence and where to look."),
    decisions: ticketText("Choices already made."),
    constraints: ticketText(
      "Limits on how the work is done, including what the worker may not read, run or touch.",
    ),
    acceptanceCriteria: {
      type: "array",
      maxItems: TICKET_SECTION_LIMITS.maxAcceptanceCriteria,
      items: { type: "string", minLength: 1, maxLength: TICKET_SECTION_LIMITS.maxCriterionLength },
      description: `One checkable criterion per entry. An unchanged entry keeps its result. ${ACCEPTANCE_CRITERIA_RULE}`,
    },
    checks: {
      type: "array",
      maxItems: TICKET_SECTION_LIMITS.maxChecks,
      items: { type: "string", minLength: 1, maxLength: TICKET_SECTION_LIMITS.maxCheckLength },
      description: "Standard commands that must pass.",
    },
    delivery: {
      type: "object",
      additionalProperties: false,
      properties: {
        policy: {
          type: "string",
          enum: DELIVERY_POLICIES,
          description: "How the work is delivered.",
        },
        note: ticketText("Anything the policy does not say."),
      },
    },
    reporting: ticketText("Report fields beyond the project's standard report."),
    outOfScope: ticketText("What the ticket leaves alone."),
    custom: {
      type: "array",
      maxItems: TICKET_SECTION_LIMITS.maxCustomSections,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "body"],
        properties: {
          title: {
            type: "string",
            minLength: 1,
            maxLength: TICKET_SECTION_LIMITS.maxCustomTitleLength,
          },
          body: ticketText("Section text."),
        },
      },
      description: "Extra titled sections, in order.",
    },
    notes: ticketText("Anything else."),
  },
};

export const TICKET_ACTION_INPUTS: Readonly<Record<TicketActionName, PublicActionInputContract>> =
  Object.freeze({
    "ticket.list": {
      capability: "tickets",
      confirmation: "never",
      input: schema(
        {
          projectId,
          status: { ...ticketStatus, description: "Only tickets in this column." },
          label: { ...labelName, description: "Only tickets with this label (any case)." },
          limit,
          cursor,
        },
        ["projectId"],
      ),
      examples: [{ projectId: "project-1" }, { projectId: "project-1", status: "backlog" }],
    },
    "ticket.get": {
      capability: "tickets",
      confirmation: "never",
      input: schema({ projectId, ticketId }, ["projectId", "ticketId"]),
      examples: [{ projectId: "project-1", ticketId: "ticket-1" }],
    },
    "ticket.create": {
      capability: "tickets",
      confirmation: "never",
      input: schema(
        {
          projectId,
          title: ticketTitle,
          kind: ticketKind,
          sections: ticketSections,
          description: ticketText("Ticket description."),
          acceptanceCriteria: ticketText(
            `Acceptance criteria, one per line. ${ACCEPTANCE_CRITERIA_RULE}`,
          ),
          status: { ...ticketStatus, description: "Column (default backlog)." },
          labels: { ...labelList, description: `${labelList.description} Default none.` },
        },
        ["projectId", "title"],
      ),
      examples: [
        { projectId: "project-1", title: "Fix the login redirect" },
        { projectId: "project-1", title: "Fix the login redirect", labels: ["bug"] },
      ],
    },
    "ticket.update": {
      capability: "tickets",
      confirmation: "never",
      input: schema(
        {
          projectId,
          ticketId,
          title: ticketTitle,
          kind: ticketKind,
          sections: {
            ...ticketSections,
            description: `${TICKET_SECTIONS_GUIDANCE} Sections not named are unchanged.`,
          },
          description: ticketText("New description."),
          acceptanceCriteria: ticketText(
            `New acceptance criteria, one per line. ${ACCEPTANCE_CRITERIA_RULE}`,
          ),
          status: { ...ticketStatus, description: "Move the ticket to this column." },
          labels: {
            ...labelList,
            description: `${labelList.description} Replaces every label; [] removes them all. To add or remove one, use ticket.label.`,
          },
        },
        ["projectId", "ticketId"],
      ),
      examples: [
        { projectId: "project-1", ticketId: "ticket-1", status: "in-progress" },
        { projectId: "project-1", ticketId: "ticket-1", labels: ["bug", "ui"] },
      ],
    },
    "ticket.comment": {
      capability: "tickets",
      confirmation: "never",
      input: schema(
        {
          projectId,
          ticketId,
          text: {
            type: "string",
            minLength: 1,
            maxLength: 20_000,
            description: "Comment text.",
          },
        },
        ["projectId", "ticketId", "text"],
      ),
      examples: [{ projectId: "project-1", ticketId: "ticket-1", text: "Reproduced on main." }],
    },
    "ticket.labels": {
      capability: "tickets",
      confirmation: "never",
      input: schema({ projectId }, ["projectId"]),
      examples: [{ projectId: "project-1" }],
    },
    "ticket.label": {
      capability: "tickets",
      confirmation: "never",
      input: schema(
        {
          projectId,
          ticketId,
          name: {
            ...labelName,
            description:
              "Label name. One from ticket.labels keeps its spelling; a new name starts a label.",
          },
          present: { type: "boolean", description: "False to remove the label (default true)." },
        },
        ["projectId", "ticketId", "name"],
      ),
      examples: [
        { projectId: "project-1", ticketId: "ticket-1", name: "bug" },
        { projectId: "project-1", ticketId: "ticket-1", name: "bug", present: false },
      ],
    },
    "ticket.label.create": {
      capability: "tickets",
      confirmation: "never",
      input: schema(
        {
          projectId,
          name: labelName,
          color: {
            type: "string",
            minLength: 7,
            maxLength: 7,
            description: "Colour as #rrggbb.",
          },
          description: {
            type: "string",
            maxLength: TICKET_LABEL_LIMITS.maxDescriptionLength,
            description: "What the label means.",
          },
        },
        ["projectId", "name"],
      ),
      examples: [
        { projectId: "project-1", name: "bug" },
        {
          projectId: "project-1",
          name: "needs design",
          color: "#a855f7",
          description: "Waiting on a mock",
        },
      ],
    },
  });
