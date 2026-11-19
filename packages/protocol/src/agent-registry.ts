import type { AgentInteractionKind, AgentInteractionRequest } from "./agent-interactions.js";
import type { AgentPlatform } from "./agent-platforms.js";
import type { NativeAgentGoalSummary } from "./native-agent-goal.js";

/**
 * What one agent tab is doing right now.
 *
 * `stopped` means its environment (or coordinator) is not running, so nothing
 * there can work until it is started. `unknown` is a tab whose activity has
 * never been observed — a fresh native tab, or a terminal agent, whose CLI
 * reports no per-tab state.
 */
export type AgentTabState = "working" | "waiting" | "idle" | "stopped" | "unknown";

/** One agent tab anywhere in the app: an environment tab or a coordinator conversation. */
export interface AgentRegistryEntry {
  projectId: string;
  environmentId: string;
  environmentName: string;
  tabId: string;
  ownerKind: "environment" | "coordinator";
  /** How the agent runs: an SDK session, Claude under tmux, or a plain terminal CLI. */
  kind: "native" | "tmux" | "terminal";
  /** Null for a native tab whose platform has not been chosen yet. */
  agent: AgentPlatform | null;
  /** The public session handle of a native tab whose platform has been chosen. */
  sessionId?: string;
  displayName: string;
  /** One-based position in the environment's tab strip. */
  tabOrdinal: number;
  state: AgentTabState;
  coordinatorRole?: "main" | "side";
  /**
   * The tab's goal, if it has one. `state` is about the current turn, so a tab
   * between iterations reads `idle` while `goal.running` says it will continue.
   */
  goal?: NativeAgentGoalSummary;
  /**
   * What a `waiting` native tab is waiting on: its oldest pending approval or
   * question, summarised for one line. Present only when the snapshot was
   * asked for it (`includePending`) and the tab's provider reported one.
   */
  pending?: AgentPendingInteractionSummary;
}

/**
 * One line about the approval or question a tab is waiting on, safe for a
 * sidebar row: a fixed label for its kind and, where the request carries a
 * reliable short summary that cannot hold a secret, that summary. Never the
 * request's body, options, URL or any answer.
 */
export interface AgentPendingInteractionSummary {
  interactionId: string;
  kind: AgentInteractionKind;
  /** Fixed wording for the kind, e.g. "Needs approval" or "Question". */
  label: string;
  /** A bounded single-line summary; absent where none is reliable or it may be sensitive. */
  detail?: string;
  /** When the request was made, epoch milliseconds (its authority's clock). */
  since: number;
  /** How many requests the tab has pending, this one included. */
  count: number;
}

export interface AgentRegistryEnvironmentSummary {
  environmentId: string;
  tabs: number;
  working: number;
  waiting: number;
  idle: number;
  stopped: number;
  unknown: number;
}

export interface AgentRegistrySnapshot {
  generatedAt: string;
  entries: AgentRegistryEntry[];
  environments: AgentRegistryEnvironmentSummary[];
}

export function summarizeAgentRegistry(
  entries: readonly AgentRegistryEntry[],
): AgentRegistryEnvironmentSummary[] {
  const byEnvironment = new Map<string, AgentRegistryEnvironmentSummary>();
  for (const entry of entries) {
    const summary = byEnvironment.get(entry.environmentId) ?? {
      environmentId: entry.environmentId,
      tabs: 0,
      working: 0,
      waiting: 0,
      idle: 0,
      stopped: 0,
      unknown: 0,
    };
    summary.tabs += 1;
    summary[entry.state] += 1;
    byEnvironment.set(entry.environmentId, summary);
  }
  return [...byEnvironment.values()];
}

/** "3 agent tabs · 1 working · 1 waiting", omitting zero counts after the total. */
export function describeAgentRegistrySummary(summary: AgentRegistryEnvironmentSummary): string {
  const parts = [`${summary.tabs} agent tab${summary.tabs === 1 ? "" : "s"}`];
  if (summary.working) parts.push(`${summary.working} working`);
  if (summary.waiting) parts.push(`${summary.waiting} waiting`);
  if (summary.stopped) parts.push(`${summary.stopped} stopped`);
  return parts.join(" · ");
}

/** The longest detail a pending-interaction summary carries. */
export const PENDING_INTERACTION_DETAIL_MAX = 120;

const PENDING_INTERACTION_LABELS: Record<AgentInteractionKind, string> = {
  question: "Question",
  "plan-approval": "Plan ready for review",
  "command-approval": "Needs approval",
  "file-approval": "Needs approval",
  permission: "Needs approval",
  "mcp-form": "Needs input",
  "mcp-url": "Needs you to open a link",
  elicitation: "Needs input",
  "terminal-selection": "Needs a choice",
};

/**
 * Titles bridges use when the provider gave nothing more specific. They say no
 * more than the label does, so the summary leaves them out.
 */
const GENERIC_TITLES = new Set([
  "approve command",
  "approve file changes",
  "approve permissions",
  "approve network access",
  "approval requested",
  "claude needs input",
  "grok needs input",
  "codex needs input",
  "opencode needs input",
  "pi needs input",
  "cursor needs input",
  "question",
  "input requested",
]);

/** One line, no control characters, bounded on a character boundary. */
function singleLine(text: string, max = PENDING_INTERACTION_DETAIL_MAX): string | undefined {
  // oxlint-disable-next-line no-control-regex -- stripping control characters is the point
  const line = text
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!line) return undefined;
  const chars = Array.from(line);
  return chars.length > max
    ? `${chars
        .slice(0, max - 1)
        .join("")
        .trimEnd()}…`
    : line;
}

/**
 * The detail for one request, or `undefined` when it has no reliable summary
 * or might show sensitive input: a request with a secret question, and a link
 * request (its URL is never shown outside the card) get only their label.
 */
function pendingInteractionDetail(request: AgentInteractionRequest): string | undefined {
  const { presentation } = request;
  if (request.kind === "mcp-url") return undefined;
  if (presentation.questions.some((question) => question.secret)) return undefined;
  if (request.kind === "plan-approval") return undefined;
  if (request.kind === "question" || request.kind === "elicitation") {
    const prompt = presentation.questions[0]?.prompt;
    const fromPrompt = prompt ? singleLine(prompt) : undefined;
    if (fromPrompt) return fromPrompt;
  }
  const title = singleLine(presentation.title);
  if (!title || GENERIC_TITLES.has(title.toLowerCase())) return undefined;
  return title;
}

/**
 * The summary of a tab's oldest pending request (blocking ones first), or
 * `undefined` when none is pending. `requests` is the provider's pending list.
 */
export function summarizePendingInteractions(
  requests: readonly AgentInteractionRequest[],
): AgentPendingInteractionSummary | undefined {
  const live = requests.filter(
    (request) => request.state === "pending" || request.state === "answering",
  );
  if (live.length === 0) return undefined;
  const [first] = [...live].sort(
    (a, b) =>
      Number(b.blocking !== false) - Number(a.blocking !== false) ||
      a.createdAt - b.createdAt ||
      a.id.localeCompare(b.id),
  );
  if (!first) return undefined;
  const detail = pendingInteractionDetail(first);
  return {
    interactionId: first.id.slice(0, 512),
    kind: first.kind,
    label: PENDING_INTERACTION_LABELS[first.kind] ?? "Needs input",
    ...(detail ? { detail } : {}),
    since: first.createdAt,
    count: live.length,
  };
}
