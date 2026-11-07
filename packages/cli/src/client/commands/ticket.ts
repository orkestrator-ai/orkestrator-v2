import type {
  PublicPage,
  PublicTicketDetail,
  PublicTicketLabel,
  PublicTicketSummary,
} from "@orkestrator/protocol/public-api-resources";
import { CliError } from "../errors.js";
import { keyValues, table } from "../format.js";
import { readTextSource } from "../inputs.js";
import type { ClientIo } from "../io.js";
import type { CommandSpec, OptionSpec } from "../spec.js";
import { oneOf, REQUEST_ID_OPTION, stringOption, submit } from "./common.js";

const STATUSES = ["backlog", "in-progress", "review", "done"] as const;
const KINDS = ["feature", "work-brief"] as const;

const PROJECT_OPTION: OptionSpec = {
  name: "project",
  kind: "string",
  valueName: "PROJECT_ID",
  description: "Project ID (project list).",
};
const STATUS_OPTION: OptionSpec = {
  name: "status",
  kind: "string",
  valueName: "COLUMN",
  description: `Column: ${STATUSES.join(", ")}.`,
};
const LABEL_OPTION: OptionSpec = {
  name: "label",
  kind: "list",
  valueName: "NAME",
  description: "A label (ticket labels lists them); replaces the ticket's labels.",
};
const CLEAR_LABELS_OPTION: OptionSpec = {
  name: "clear-labels",
  kind: "boolean",
  description: "Remove every label.",
};
const TEXT_FIELD_OPTIONS: OptionSpec[] = [
  { name: "title", kind: "string", valueName: "TEXT", description: "Ticket title." },
  {
    name: "description",
    kind: "string",
    valueName: "TEXT",
    description: "Description (or --description-file).",
  },
  {
    name: "description-file",
    kind: "string",
    valueName: "PATH",
    description: "Read the description from a local file.",
  },
  {
    name: "criteria",
    kind: "string",
    valueName: "TEXT",
    description: "Acceptance criteria.",
  },
  {
    name: "kind",
    kind: "string",
    valueName: "KIND",
    description: `Ticket kind: ${KINDS.join(", ")}.`,
  },
  {
    name: "sections-file",
    kind: "string",
    valueName: "PATH",
    description: "Read structured sections (a JSON object) from a local file.",
  },
];

function requireProject(options: Record<string, unknown>): string {
  const projectId = stringOption(options, "project");
  if (!projectId) throw new CliError("invalid-input", "--project is required");
  return projectId;
}

async function ticketFields(
  io: ClientIo,
  options: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const description = await readTextSource(io, {
    file: options["description-file"],
    inline: options.description,
    label: "Description",
    maxBytes: 400_000,
    names: { file: "--description-file", stdin: "--description-stdin", inline: "--description" },
    required: false,
  });
  const sectionsText = await readTextSource(io, {
    file: options["sections-file"],
    label: "Sections",
    maxBytes: 400_000,
    names: { file: "--sections-file", stdin: "--sections-stdin" },
    required: false,
  });
  let sections: unknown;
  if (sectionsText !== undefined) {
    try {
      sections = JSON.parse(sectionsText);
    } catch {
      throw new CliError("invalid-input", "--sections-file must contain a JSON object");
    }
  }
  return {
    ...(stringOption(options, "title") !== undefined ? { title: options.title } : {}),
    ...(options.kind !== undefined ? { kind: oneOf(options.kind, KINDS, "--kind") } : {}),
    ...(sections !== undefined ? { sections } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(stringOption(options, "criteria") !== undefined
      ? { acceptanceCriteria: options.criteria }
      : {}),
    ...(options.status !== undefined
      ? { status: oneOf(options.status, STATUSES, "--status") }
      : {}),
    ...ticketLabelsField(options),
  };
}

function ticketLabelsField(options: Record<string, unknown>): { labels?: string[] } {
  const labels = Array.isArray(options.label) ? (options.label as string[]) : undefined;
  if (options["clear-labels"] === true) {
    if (labels?.length) {
      throw new CliError("invalid-input", "Pass --label or --clear-labels, not both");
    }
    return { labels: [] };
  }
  return labels?.length ? { labels } : {};
}

function ticketRows(tickets: PublicTicketSummary[]): string[] {
  return table(
    ["ID", "STATUS", "TITLE", "COMMENTS", "LABELS"],
    tickets.map((ticket) => [
      ticket.id,
      ticket.status,
      ticket.title,
      String(ticket.commentCount),
      (ticket.labels ?? []).join(", "),
    ]),
  );
}

function labelRows(labels: PublicTicketLabel[]): string[] {
  return table(
    ["NAME", "TICKETS", "COLOR", "DESCRIPTION"],
    labels.map((label) => [
      label.name,
      String(label.ticketCount),
      label.color ?? "",
      label.description ?? "",
    ]),
  );
}

const CRITERION_MARKS = {
  passed: "[x]",
  failed: "[!]",
  "not-checked": "[?]",
  unchecked: "[ ]",
} as const;

function ticketLines(ticket: PublicTicketDetail): string[] {
  return [
    ...keyValues([
      ["id", ticket.id],
      ["project", ticket.projectId],
      ["status", ticket.status],
      ["title", ticket.title],
      ["kind", ticket.kind ?? "feature"],
      ["environment", ticket.environmentId],
      ["pr", ticket.pr.url],
      ...(ticket.labels?.length ? [["labels", ticket.labels.join(", ")] as [string, unknown]] : []),
      ...(ticket.deliveryPolicy ? [["delivery", ticket.deliveryPolicy] as [string, unknown]] : []),
    ]),
    ...(ticket.description ? ["", ticket.description] : []),
    ...(ticket.criteria?.length
      ? [
          "",
          "Acceptance criteria:",
          ...ticket.criteria.map(
            (criterion) =>
              `${CRITERION_MARKS[criterion.status ?? "unchecked"]} ${criterion.id} ${criterion.text}${criterion.evidence ? ` (${criterion.evidence})` : ""}`,
          ),
        ]
      : ticket.acceptanceCriteria
        ? ["", "Acceptance criteria:", ticket.acceptanceCriteria]
        : []),
    ...ticket.comments.flatMap((comment) => ["", `[${comment.createdAt}] ${comment.text}`]),
  ];
}

export const ticketCommands: CommandSpec[] = [
  {
    path: ["ticket", "list"],
    action: "ticket.list",
    summary: "List a project's Kanban tickets.",
    positionals: [],
    options: [
      PROJECT_OPTION,
      STATUS_OPTION,
      {
        name: "label",
        kind: "string",
        valueName: "NAME",
        description: "Only tickets with this label.",
      },
      { name: "limit", kind: "integer", valueName: "N", description: "Items per page (max 200)." },
      {
        name: "cursor",
        kind: "string",
        valueName: "CURSOR",
        description: "Continue from a previous page.",
      },
    ],
    idOutput: "ticket IDs, one per line",
    async run(context, parsed) {
      const session = await context.session();
      const page = await session.read<PublicPage<PublicTicketSummary>>("ticket.list", {
        projectId: requireProject(parsed.options),
        ...(parsed.options.status !== undefined
          ? { status: oneOf(parsed.options.status, STATUSES, "--status") }
          : {}),
        ...(parsed.options.label !== undefined ? { label: parsed.options.label } : {}),
        ...(parsed.options.limit !== undefined ? { limit: parsed.options.limit } : {}),
        ...(parsed.options.cursor !== undefined ? { cursor: parsed.options.cursor } : {}),
      });
      return {
        action: "ticket.list",
        result: page,
        connection: session.identity,
        ids: page.items.map((ticket) => ticket.id),
        human: [
          ...ticketRows(page.items),
          ...(page.nextCursor ? [`more: --cursor ${page.nextCursor}`] : []),
        ],
      };
    },
  },
  {
    path: ["ticket", "get"],
    action: "ticket.get",
    summary: "Show one ticket with its description, criteria and latest comments.",
    positionals: [{ name: "ticket", required: true }],
    options: [PROJECT_OPTION],
    inputFields: { ticket: "ticketId" },
    idOutput: "ticket ID",
    async run(context, parsed) {
      const session = await context.session();
      const ticket = await session.read<PublicTicketDetail>("ticket.get", {
        projectId: requireProject(parsed.options),
        ticketId: parsed.positionals.ticket,
      });
      return {
        action: "ticket.get",
        result: ticket,
        connection: session.identity,
        ids: [ticket.id],
        human: ticketLines(ticket),
      };
    },
  },
  {
    path: ["ticket", "create"],
    action: "ticket.create",
    summary: "Create a Kanban ticket.",
    positionals: [],
    options: [
      PROJECT_OPTION,
      ...TEXT_FIELD_OPTIONS,
      STATUS_OPTION,
      { ...LABEL_OPTION, description: "A label for the new ticket (ticket labels lists them)." },
      REQUEST_ID_OPTION,
    ],
    inputFields: {
      label: "labels",
      "description-file": "description",
      criteria: "acceptanceCriteria",
      "sections-file": "sections",
    },
    idOutput: "ticket ID",
    async run(context, parsed) {
      const fields = await ticketFields(context.io, parsed.options);
      if (typeof fields.title !== "string")
        throw new CliError("invalid-input", "--title is required");
      const { session, result, receipt, warnings } = await submit<{ ticketId: string }>(
        context,
        "ticket.create",
        { projectId: requireProject(parsed.options), ...fields },
        parsed.options,
      );
      return {
        action: "ticket.create",
        result,
        receipt,
        warnings,
        connection: session.identity,
        ids: [result.ticketId],
        human: [`created ticket ${result.ticketId}`],
      };
    },
  },
  {
    path: ["ticket", "update"],
    action: "ticket.update",
    summary: "Change a ticket's title, kind, sections, description, criteria, labels or column.",
    positionals: [{ name: "ticket", required: true }],
    options: [
      PROJECT_OPTION,
      ...TEXT_FIELD_OPTIONS,
      STATUS_OPTION,
      LABEL_OPTION,
      CLEAR_LABELS_OPTION,
      REQUEST_ID_OPTION,
    ],
    inputFields: {
      ticket: "ticketId",
      label: "labels",
      "clear-labels": "labels",
      "description-file": "description",
      criteria: "acceptanceCriteria",
      "sections-file": "sections",
    },
    idOutput: "ticket ID",
    async run(context, parsed) {
      const fields = await ticketFields(context.io, parsed.options);
      if (Object.keys(fields).length === 0) {
        throw new CliError("invalid-input", "Pass at least one field to change");
      }
      const { session, result, receipt, warnings } = await submit<{ ticketId: string }>(
        context,
        "ticket.update",
        {
          projectId: requireProject(parsed.options),
          ticketId: parsed.positionals.ticket,
          ...fields,
        },
        parsed.options,
      );
      return {
        action: "ticket.update",
        result,
        receipt,
        warnings,
        connection: session.identity,
        ids: [result.ticketId],
        human: [`updated ticket ${result.ticketId}`],
      };
    },
  },
  {
    path: ["ticket", "comment"],
    action: "ticket.comment",
    summary: "Append a comment to a ticket.",
    positionals: [{ name: "ticket", required: true }],
    options: [
      PROJECT_OPTION,
      { name: "text", kind: "string", valueName: "TEXT", description: "Comment text." },
      {
        name: "text-file",
        kind: "string",
        valueName: "PATH",
        description: "Read the comment from a local file.",
      },
      REQUEST_ID_OPTION,
    ],
    inputFields: { ticket: "ticketId", "text-file": "text" },
    idOutput: "ticket ID",
    async run(context, parsed) {
      const text = await readTextSource(context.io, {
        file: parsed.options["text-file"],
        inline: parsed.options.text,
        label: "Comment",
        maxBytes: 80_000,
        names: { file: "--text-file", stdin: "--text-stdin", inline: "--text" },
        required: true,
      });
      const { session, result, receipt, warnings } = await submit<{ ticketId: string }>(
        context,
        "ticket.comment",
        { projectId: requireProject(parsed.options), ticketId: parsed.positionals.ticket, text },
        parsed.options,
      );
      return {
        action: "ticket.comment",
        result,
        receipt,
        warnings,
        connection: session.identity,
        ids: [result.ticketId],
        human: [`commented on ticket ${result.ticketId}`],
      };
    },
  },
  {
    path: ["ticket", "labels"],
    action: "ticket.labels",
    summary: "List the labels a project's tickets can carry, with how many tickets carry each.",
    positionals: [],
    options: [PROJECT_OPTION],
    idOutput: "label names, one per line",
    async run(context, parsed) {
      const session = await context.session();
      const result = await session.read<{ labels: PublicTicketLabel[]; total: number }>(
        "ticket.labels",
        { projectId: requireProject(parsed.options) },
      );
      return {
        action: "ticket.labels",
        result,
        connection: session.identity,
        ids: result.labels.map((label) => label.name),
        human: labelRows(result.labels),
      };
    },
  },
  {
    path: ["ticket", "label"],
    action: "ticket.label",
    summary: "Add or remove one label on a ticket.",
    positionals: [{ name: "ticket", required: true }],
    options: [
      PROJECT_OPTION,
      { name: "name", kind: "string", valueName: "LABEL", description: "Label name." },
      { name: "remove", kind: "boolean", description: "Remove it instead." },
      REQUEST_ID_OPTION,
    ],
    inputFields: { ticket: "ticketId", remove: "present" },
    idOutput: "ticket ID",
    async run(context, parsed) {
      const name = stringOption(parsed.options, "name");
      if (!name) throw new CliError("invalid-input", "--name is required");
      const { session, result, receipt, warnings } = await submit<{
        ticketId: string;
        labels: string[];
      }>(
        context,
        "ticket.label",
        {
          projectId: requireProject(parsed.options),
          ticketId: parsed.positionals.ticket,
          name,
          ...(parsed.options.remove === true ? { present: false } : {}),
        },
        parsed.options,
      );
      return {
        action: "ticket.label",
        result,
        receipt,
        warnings,
        connection: session.identity,
        ids: [result.ticketId],
        human: [`ticket ${result.ticketId} labels: ${result.labels.join(", ") || "(none)"}`],
      };
    },
  },
  {
    path: ["ticket", "label-create"],
    action: "ticket.label.create",
    summary: "Create a ticket label in a project's catalogue.",
    positionals: [],
    options: [
      PROJECT_OPTION,
      { name: "name", kind: "string", valueName: "LABEL", description: "Label name." },
      { name: "color", kind: "string", valueName: "#RRGGBB", description: "Label colour." },
      {
        name: "description",
        kind: "string",
        valueName: "TEXT",
        description: "What the label means.",
      },
      REQUEST_ID_OPTION,
    ],
    idOutput: "label name",
    async run(context, parsed) {
      const name = stringOption(parsed.options, "name");
      if (!name) throw new CliError("invalid-input", "--name is required");
      const { session, result, receipt, warnings } = await submit<{
        name: string;
        created: boolean;
      }>(
        context,
        "ticket.label.create",
        {
          projectId: requireProject(parsed.options),
          name,
          ...(parsed.options.color !== undefined ? { color: parsed.options.color } : {}),
          ...(parsed.options.description !== undefined
            ? { description: parsed.options.description }
            : {}),
        },
        parsed.options,
      );
      return {
        action: "ticket.label.create",
        result,
        receipt,
        warnings,
        connection: session.identity,
        ids: [result.name],
        human: [result.created ? `created label ${result.name}` : `label ${result.name} exists`],
      };
    },
  },
];
