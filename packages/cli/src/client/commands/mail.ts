import type { MailboxDescriptor } from "@orkestrator/protocol/agent-mail";
import { CliError } from "../errors.js";
import { table } from "../format.js";
import { readTextSource } from "../inputs.js";
import type { CommandSpec } from "../spec.js";
import { REQUEST_ID_OPTION, stringOption, submit } from "./common.js";

interface MailboxPage {
  mailboxes: MailboxDescriptor[];
  total: number;
  offset: number;
  limit: number;
}

export const mailCommands: CommandSpec[] = [
  {
    path: ["mail", "mailboxes"],
    action: "mail.mailboxes",
    summary: "List agent mailboxes a message can be sent to.",
    positionals: [],
    options: [
      { name: "q", kind: "string", valueName: "TEXT", description: "Filter by name." },
      { name: "offset", kind: "integer", valueName: "N", description: "Rows to skip." },
      { name: "limit", kind: "integer", valueName: "N", description: "Rows (max 200)." },
    ],
    async run(context, parsed) {
      const session = await context.session();
      const page = await session.read<MailboxPage>("mail.mailboxes", {
        ...(parsed.options.q !== undefined ? { q: parsed.options.q } : {}),
        ...(parsed.options.offset !== undefined ? { offset: parsed.options.offset } : {}),
        ...(parsed.options.limit !== undefined ? { limit: parsed.options.limit } : {}),
      });
      return {
        action: "mail.mailboxes",
        result: page,
        connection: session.identity,
        human: table(
          ["ENVIRONMENT", "TAB", "NAME", "PRESENCE"],
          page.mailboxes.map((mailbox) => [
            mailbox.environmentId,
            mailbox.tabId,
            `${mailbox.environmentName} / ${mailbox.displayName}`,
            mailbox.presence,
          ]),
        ),
      };
    },
  },
  {
    path: ["mail", "send"],
    action: "mail.send",
    summary: "Place a message in one tab's inbox (never injected into a turn).",
    positionals: [
      { name: "environment", required: true },
      { name: "tab", required: true },
    ],
    options: [
      { name: "subject", kind: "string", valueName: "TEXT", description: "Subject line." },
      { name: "body", kind: "string", valueName: "TEXT", description: "Message text." },
      {
        name: "body-file",
        kind: "string",
        valueName: "PATH",
        description: "Read the message from a local file.",
      },
      { name: "body-stdin", kind: "boolean", description: "Read the message from stdin." },
      REQUEST_ID_OPTION,
    ],
    inputFields: {
      environment: "toEnvironmentId",
      tab: "toTabId",
      "body-file": "body",
      "body-stdin": "body",
    },
    idOutput: "message ID",
    async run(context, parsed) {
      const body = await readTextSource(context.io, {
        file: parsed.options["body-file"],
        stdin: parsed.options["body-stdin"],
        inline: parsed.options.body,
        label: "Message",
        maxBytes: 32 * 1024,
        names: { file: "--body-file", stdin: "--body-stdin", inline: "--body" },
        required: true,
      });
      const subject = stringOption(parsed.options, "subject");
      if (subject !== undefined && subject.trim().length === 0) {
        throw new CliError("invalid-input", "--subject is empty");
      }
      const { session, result, receipt, warnings } = await submit<{ messageId: string | null }>(
        context,
        "mail.send",
        {
          toEnvironmentId: parsed.positionals.environment,
          toTabId: parsed.positionals.tab,
          body,
          ...(subject ? { subject } : {}),
        },
        parsed.options,
      );
      return {
        action: "mail.send",
        result,
        receipt,
        warnings,
        connection: session.identity,
        ids: result.messageId ? [result.messageId] : [],
        human: [`sent message ${result.messageId ?? ""}`.trim()],
      };
    },
  },
];
