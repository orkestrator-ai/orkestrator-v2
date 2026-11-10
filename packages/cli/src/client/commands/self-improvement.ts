import type {
  SelfImprovementRunSummary,
  SelfImprovementStatus,
} from "@orkestrator/protocol/self-improvement";
import { CliError } from "../errors.js";
import type { CommandSpec } from "../spec.js";
import { optionalBoolean, REQUEST_ID_OPTION, submit } from "./common.js";

/**
 * `self-improvement …`: the experimental feature in Settings → Self-improvement.
 * `run --wait` follows the run until it finishes, as the Settings page does, by
 * reading the status; the backend owns the run either way.
 */

const POLL_MS = 3000;
const WAIT_LIMIT_MS = 60 * 60 * 1000;

function runLines(run: SelfImprovementRunSummary): string[] {
  const refs = (items: Array<{ ticket: string; signature: string }>) =>
    items.map((item) => `#${item.ticket} ${item.signature}`).join("; ");
  const lines = [
    `${run.trigger === "dry-run" ? "Preview" : run.trigger === "daily" ? "Daily run" : "Run"} ${run.outcome} at ${run.finishedAt}`,
  ];
  if (run.error) lines.push(`  ${run.error}`);
  for (const item of run.created) lines.push(`  new ticket #${item.ticket}: ${item.title}`);
  for (const item of run.wouldCreate) lines.push(`  would file: ${item.title}`);
  if (run.verified.length) lines.push(`  fixed and confirmed: ${refs(run.verified)}`);
  if (run.fixFailed.length) {
    lines.push(`  fix did not work, back to the backlog: ${refs(run.fixFailed)}`);
  }
  if (run.partly.length) lines.push(`  partly better, your call: ${refs(run.partly)}`);
  if (run.markedFixed.length)
    lines.push(`  done on the board, now checking: ${refs(run.markedFixed)}`);
  if (run.conversations.enabled) {
    lines.push(
      `  conversations: read ${run.conversations.read}, ${run.conversations.notesAdded} new notes, ${run.conversations.themes} themes, about $${run.conversations.costUsd.toFixed(2)} at list prices`,
    );
  }
  for (const error of run.conversations.errors) lines.push(`  conversation review: ${error}`);
  return lines;
}

function statusLines(status: SelfImprovementStatus): string[] {
  const lines = [
    `Self-improvement: ${status.enabled ? "on" : "off (Settings → Experimental)"}`,
    `Project: ${status.project?.name ?? "not chosen (Settings → Self-improvement)"}`,
    `Conversation review: ${status.settings.conversationReview ? "on" : "off"}; daily run: ${status.settings.dailyRun ? `on, next ${status.nextDailyRunAt ?? "when due"}` : "off"}`,
  ];
  if (status.running)
    lines.push(`Running: ${status.running.step}, started ${status.running.startedAt}`);
  if (status.lastRun) lines.push("", ...runLines(status.lastRun));
  if (status.tracked.length > 0) {
    lines.push("", "Tracked:");
    for (const item of status.tracked) {
      lines.push(
        `  ${item.ticket ? `#${item.ticket}` : "-"} ${item.status} ${item.verdict ?? ""} ${item.title}`,
      );
    }
  }
  return lines;
}

export const selfImprovementCommands: CommandSpec[] = [
  {
    path: ["self-improvement", "status"],
    action: "self-improvement.status",
    summary: "Show self-improvement's settings, the last run, tracked tickets and themes.",
    positionals: [],
    options: [],
    async run(context) {
      const session = await context.session();
      const status = await session.read<SelfImprovementStatus>("self-improvement.status", {});
      return {
        action: "self-improvement.status",
        result: status,
        connection: session.identity,
        human: statusLines(status),
      };
    },
  },
  {
    path: ["self-improvement", "run"],
    action: "self-improvement.run",
    summary: "Start a self-improvement run (experimental); --wait follows it to the end.",
    description:
      "Exports this machine's diagnostics, reviews conversations when that is on, and files what it finds on the chosen project's board. --dry-run reports what it would file without filing it or calling a model.",
    positionals: [],
    options: [
      {
        name: "dry-run",
        kind: "boolean",
        description: "Report without filing or calling a model.",
      },
      {
        name: "wait",
        kind: "boolean",
        description: "Wait for the run to finish and print its summary.",
      },
      REQUEST_ID_OPTION,
    ],
    async run(context, parsed) {
      const dryRun = optionalBoolean(parsed.options, "dry-run") === true;
      const { session, result, receipt, warnings } = await submit<Record<string, unknown>>(
        context,
        "self-improvement.run",
        dryRun ? { dryRun: true } : {},
        parsed.options,
      );
      if (optionalBoolean(parsed.options, "wait") !== true) {
        return {
          action: "self-improvement.run",
          result,
          receipt,
          warnings,
          connection: session.identity,
          human: [
            `Started ${dryRun ? "a preview" : "a run"}; see it with \`orkestrator self-improvement status\`.`,
          ],
        };
      }
      const deadline = Date.now() + WAIT_LIMIT_MS;
      let status = await session.read<SelfImprovementStatus>("self-improvement.status", {});
      while (status.running) {
        if (Date.now() > deadline) {
          throw new CliError(
            "deadline-exceeded",
            "The run is still going; check it with `self-improvement status`.",
          );
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        status = await session.read<SelfImprovementStatus>("self-improvement.status", {});
      }
      return {
        action: "self-improvement.run",
        result: { ...result, lastRun: status.lastRun },
        receipt,
        warnings,
        connection: session.identity,
        human: status.lastRun ? runLines(status.lastRun) : ["The run finished."],
      };
    },
  },
];
