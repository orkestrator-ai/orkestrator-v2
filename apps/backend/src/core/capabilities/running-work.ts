/**
 * Running work holds shared deliveries
 * (docs/architecture/agent-capabilities-management.md, "Running work").
 *
 * A machine-wide provider home is read by every session of that provider on
 * the machine, so a write there would reach work already in progress: a
 * running task could gain a skill, lose one, or meet a new hook mid-way. The
 * reconciler therefore holds an add, update or removal at a shared location
 * while any provider that reads the location has work in flight on the
 * machine, reports it as `queued-until-idle`, and applies the latest desired
 * revision once that work ends. Work in flight is read from the authoritative
 * activity each local environment persists (`agentActivityState`), which the
 * native-agent, graph-run, build-pipeline and terminal observers all feed,
 * never from mounted renderer state.
 *
 * A containerized environment is not counted: its agents read their own
 * staged copies, never this machine's homes. An environment that is working
 * without a session that names its provider holds every provider: the hold
 * errs towards not changing running work.
 */
import { AGENT_PLATFORMS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";

import type { CommandContext } from "../commands-context.js";

export interface RunningWorkEnvironment {
  id: string;
  environmentType?: string;
  agentActivityState?: string;
  agentActivitySources?: Partial<Record<string, { state?: string } | undefined>>;
}

export interface RunningWorkSession {
  environmentId: string;
  agent: string;
}

/** Sources that only ever run Claude Code (terminal and tmux modes). */
const CLAUDE_ONLY_SOURCES = ["claude-terminal", "claude-tmux"];

/** The providers with work in flight on this machine's own homes. */
export function busyProvidersFrom(
  environments: readonly RunningWorkEnvironment[],
  sessions: readonly RunningWorkSession[],
): AgentPlatform[] {
  const busy = new Set<AgentPlatform>();
  const platforms = new Set<string>(AGENT_PLATFORMS);
  for (const environment of environments) {
    if (environment.environmentType === "containerized") continue;
    if (environment.agentActivityState !== "working") continue;
    const sources = environment.agentActivitySources ?? {};
    const working = Object.entries(sources).filter(([, entry]) => entry?.state === "working");
    const onlyClaude =
      working.length > 0 && working.every(([source]) => CLAUDE_ONLY_SOURCES.includes(source));
    if (onlyClaude) {
      busy.add("claude");
      continue;
    }
    const agents = sessions
      .filter((session) => session.environmentId === environment.id)
      .map((session) => session.agent)
      .filter((agent): agent is AgentPlatform => platforms.has(agent));
    if (working.some(([source]) => CLAUDE_ONLY_SOURCES.includes(source))) busy.add("claude");
    if (agents.length === 0) return [...AGENT_PLATFORMS];
    for (const agent of agents) busy.add(agent);
  }
  return AGENT_PLATFORMS.filter((provider) => busy.has(provider));
}

/** {@link busyProvidersFrom} over this backend's environments and native sessions. */
export async function busyHostProviders(context: CommandContext): Promise<AgentPlatform[]> {
  const [environments, sessions] = await Promise.all([
    context.storage.loadEnvironments(),
    context.storage.listNativeAgentSessions(),
  ]);
  return busyProvidersFrom(
    environments as RunningWorkEnvironment[],
    sessions.map((session) => ({ environmentId: session.environmentId, agent: session.agent })),
  );
}

/** True when any provider reading `readers` is busy. */
export function heldByRunningWork(
  readers: readonly AgentPlatform[],
  busy: ReadonlySet<AgentPlatform> | undefined,
): boolean {
  if (!busy || busy.size === 0) return false;
  return readers.some((provider) => busy.has(provider));
}

export const RUNNING_WORK_HOLD_REASON =
  "Waits until the agents on this machine that read this location finish their current work, so running work never gains or loses it mid-task.";
