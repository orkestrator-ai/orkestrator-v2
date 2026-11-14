/**
 * Ticket text for insight themes, and the board labels the loop files under:
 * `insight` for themes found in conversations, `improvement` for problems
 * found in the app's diagnostics.
 */
import type { DigestRecord, DigestSignal } from "../ledger.js";
import { IMPROVED_RATIO } from "../ledger.js";
import type { Theme } from "./analyze.js";

export const INSIGHT_LABEL = "insight";
export const IMPROVEMENT_LABEL = "improvement";

export const LABELS = [
  {
    name: INSIGHT_LABEL,
    color: "#7C3AED",
    description: "Found by self-improvement in your conversations with agents",
  },
  {
    name: IMPROVEMENT_LABEL,
    color: "#0EA5E9",
    description: "Found by self-improvement in the app's own diagnostics",
  },
] as const;

const WHERE: Record<Theme["fixWhere"], string> = {
  orkestrator: "In Orkestrator: a change to the app.",
  instructions:
    "In the agent instructions: a rule in AGENTS.md, a skill or a prompt template, rather than code.",
  provider:
    "In the model or agent itself. Nothing to change here unless a rule or default can steer around it.",
  unclear: "Unclear: decide before starting.",
};

function percent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

export function insightTicketFor(
  theme: Theme,
  signal: DigestSignal,
  digest: DigestRecord,
): { title: string; description: string; criteria: string } {
  const conversations = Number(signal.evidence.conversations ?? signal.count);
  const projects = Number(signal.evidence.projects ?? 1);
  const examples = theme.examples
    .slice(0, 5)
    .map(
      (example) =>
        `- ${new Date(example.at).toISOString().slice(0, 10)}, ${example.project}: ${example.summary}${example.quote ? ` You wrote: "${example.quote}"` : ""}`,
    );
  const description = [
    `Found by self-improvement's review of your conversations with agents (Settings → Self-improvement), in digest ${digest.id}.`,
    "",
    "## Problem",
    theme.summary,
    "",
    "## Where to fix",
    WHERE[theme.fixWhere],
    "",
    "## Evidence",
    `Seen in ${conversations} conversation(s) on ${signal.activeDays} day(s), across ${projects} project(s): ${percent(signal.measure.value)} of the conversations read in the last 30 days. Theme \`${signal.signature}\` (${theme.kind}).`,
    ...(examples.length > 0 ? ["", ...examples] : []),
    "",
    "## Suggestion",
    theme.suggestion,
    "",
    "When this ticket is done, the next self-improvement run starts watching conversations on newer app versions, and comments here once it can tell whether the theme has gone.",
  ].join("\n");
  const target = percent(signal.measure.value * IMPROVED_RATIO);
  const criteria = [
    theme.acceptance,
    `On the release that carries the change, this theme shows up in at most ${target} of conversations (self-improvement checks this).`,
  ]
    .filter(Boolean)
    .join("\n");
  return { title: theme.title.slice(0, 140), description, criteria };
}
