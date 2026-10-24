import type {
  PublicPage,
  PublicTicketDetail,
  PublicTicketSummary,
} from "@orkestrator/protocol/public-api-resources";
import { CliError } from "../errors.js";
import { keyValues, table } from "../format.js";
import { readTextSource } from "../inputs.js";
import type { ClientIo } from "../io.js";
import type { CommandSpec, OptionSpec } from "../spec.js";
import { oneOf, REQUEST_ID_OPTION, stringOption, submit } from "./common.js";

const STATUSES = ["backlog", "in-progress", "review", "done"] as const;

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
  return {
    ...(stringOption(options, "title") !== undefined ? { title: options.title } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(stringOption(options, "criteria") !== undefined
      ? { acceptanceCriteria: options.criteria }
      : {}),
    ...(options.status !== undefined
      ? { status: oneOf(options.status, STATUSES, "--status") }
      : {}),
  };
}

function ticketRows(tickets: PublicTicketSummary[]): string[] {
  return table(
    ["ID", "STATUS", "TITLE", "COMMENTS"],
    tickets.map((ticket) => [ticket.id, ticket.status, ticket.title, String(ticket.commentCount)]),
  );
}

function ticketLines(ticket: PublicTicketDetail): string[] {
  return [
    ...keyValues([
      ["id", ticket.id],
      ["project", ticket.projectId],
      ["status", ticket.status],
      ["title", ticket.title],
      ["environment", ticket.environmentId],
      ["pr", ticket.pr.url],
    ]),
    ...(ticket.description ? ["", ticket.description] : []),
    ...(ticket.acceptanceCriteria ? ["", "Acceptance criteria:", ticket.acceptanceCriteria] : []),
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
    options: [PROJECT_OPTION, ...TEXT_FIELD_OPTIONS, STATUS_OPTION, REQUEST_ID_OPTION],
    inputFields: {
      "description-file": "description",
      criteria: "acceptanceCriteria",
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
    summary: "Change a ticket's title, description, criteria or column.",
    positionals: [{ name: "ticket", required: true }],
    options: [PROJECT_OPTION, ...TEXT_FIELD_OPTIONS, STATUS_OPTION, REQUEST_ID_OPTION],
    inputFields: {
      ticket: "ticketId",
      "description-file": "description",
      criteria: "acceptanceCriteria",
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
];
