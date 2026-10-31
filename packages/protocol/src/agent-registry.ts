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
