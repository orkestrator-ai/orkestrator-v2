import type {
  PublicAttentionItem,
  PublicAttentionPage,
} from "@orkestrator/protocol/public-api-resources";
import { CliError } from "../errors.js";
import type { CommandSpec } from "../spec.js";
import { observe, ObservationStopped } from "../wait.js";
import { DEFAULT_WAIT_MS, TIMEOUT_OPTION } from "./common.js";

/** One line per item for people; machines read `--json` or `--follow --jsonl`. */
export function attentionLine(item: PublicAttentionItem): string {
  if (item.kind === "interaction") {
    return `${item.blocking ? "waiting" : "pending"}  ${item.agent} in ${item.environmentName}: ${item.title}  (${item.sessionId} ${item.interactionId} rev ${item.revision})`;
  }
  if (item.kind === "setup") {
    return `setup ${item.phase}  ${item.environmentName}  (${item.environmentId})`;
  }
  return `run ${item.state}  ${item.action}${item.errorCode ? ` ${item.errorCode}` : ""}  (${item.operationId})`;
}

function itemKey(item: PublicAttentionItem): string {
  if (item.kind === "interaction") return `interaction:${item.interactionId}:${item.revision}`;
  if (item.kind === "setup") return `setup:${item.environmentId}:${item.at}`;
  return `run:${item.operationId}:${item.state}`;
}

export const attentionCommands: CommandSpec[] = [
  {
    path: ["attention"],
    action: "attention.list",
    summary: "What needs attention: questions, approvals, settled runs, finished setups.",
    description:
      "Lists pending questions and approvals (always), and the runs this client started and setups that finished since --cursor (default: the last hour). --follow --jsonl polls and prints each new item once, which is how a voice runtime or notifier can hear about work without asking; it stops at --timeout or Ctrl+C and never changes anything.",
    positionals: [],
    options: [
      {
        name: "cursor",
        kind: "string",
        valueName: "CURSOR",
        description: "cursor from a previous read: only what changed since.",
      },
      { name: "limit", kind: "integer", valueName: "N", description: "Most items (max 50)." },
      {
        name: "follow",
        kind: "boolean",
        description: "Keep polling and print new items (use --jsonl for machines).",
      },
      TIMEOUT_OPTION,
    ],
    jsonl: true,
    async run(context, parsed) {
      const session = await context.session();
      const input: Record<string, unknown> = {};
      if (parsed.options.cursor !== undefined) input.cursor = parsed.options.cursor;
      if (parsed.options.limit !== undefined) input.limit = parsed.options.limit;
      if (parsed.options.follow !== true) {
        if (context.global.output === "jsonl") {
          throw new CliError("invalid-input", "--jsonl needs --follow");
        }
        const page = await session.read<PublicAttentionPage>("attention.list", input);
        return {
          action: "attention.list",
          result: page,
          connection: session.identity,
          human: [
            ...(page.items.length ? page.items.map(attentionLine) : ["Nothing needs attention."]),
            ...(page.more ? [`and ${page.more} more (raise --limit)`] : []),
            `cursor: ${page.cursor}`,
          ],
        };
      }
      const seen = new Set<string>();
      let cursor = input.cursor as string | undefined;
      let emitted = 0;
      try {
        await observe<never>(
          async () => {
            const page = await session.read<PublicAttentionPage>("attention.list", {
              ...input,
              ...(cursor ? { cursor } : {}),
            });
            cursor = page.cursor;
            for (const item of page.items) {
              const key = itemKey(item);
              if (seen.has(key)) continue;
              seen.add(key);
              emitted += 1;
              if (context.global.output === "jsonl") {
                context.io.stdout(`${JSON.stringify({ type: "attention", item })}\n`);
              } else if (context.global.output === "human") {
                context.io.stdout(`${attentionLine(item)}\n`);
              }
            }
            if (seen.size > 10_000) seen.clear();
            return { done: false };
          },
          {
            timeoutMs: (parsed.options.timeout as number | undefined) ?? DEFAULT_WAIT_MS,
            signal: context.signal,
          },
        );
      } catch (error) {
        if (!(error instanceof ObservationStopped)) throw error;
      }
      return {
        action: "attention.list",
        result: { followed: true, emitted, cursor: cursor ?? null },
        connection: session.identity,
        human: [],
      };
    },
  },
];
