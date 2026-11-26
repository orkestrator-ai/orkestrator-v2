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

import type { CommandContext } from "../commands/index.js";

export interface RunningWorkEnvironment {
  id: string;
  environmentType?: string;
  agentActivityState?: string;
  agentActivitySources?: Partial<Record<string, { state?: string; stale?: boolean } | undefined>>;
}

export interface RunningWorkSession {
  environmentId: string;
  agent: string;
  active?: boolean;
}

/** Sources that only ever run Claude Code (terminal and tmux modes). */
const CLAUDE_ONLY_SOURCES = ["claude-terminal", "claude-tmux"];

export function inFlight(state: string | undefined): boolean {
  return state === "working" || state === "waiting";
}

/** The providers with work in flight on this machine's own homes. */
export function busyProvidersFrom(
  environments: readonly RunningWorkEnvironment[],
  sessions: readonly RunningWorkSession[],
): AgentPlatform[] {
  const busy = new Set<AgentPlatform>();
  const platforms = new Set<string>(AGENT_PLATFORMS);
  const isPlatform = (agent: string): agent is AgentPlatform => platforms.has(agent);
  const sessionsByEnvironment = new Map<string, RunningWorkSession[]>();
  for (const session of sessions) {
    const existing = sessionsByEnvironment.get(session.environmentId);
    if (existing) existing.push(session);
    else sessionsByEnvironment.set(session.environmentId, [session]);
  }
  for (const environment of environments) {
    if (environment.environmentType === "containerized") continue;
    const environmentSessions = sessionsByEnvironment.get(environment.id) ?? [];
    for (const session of environmentSessions) {
      if (session.active && isPlatform(session.agent)) busy.add(session.agent);
    }
    if (!inFlight(environment.agentActivityState)) continue;
    const sources = environment.agentActivitySources ?? {};
    const working = Object.entries(sources).filter(([, entry]) => inFlight(entry?.state));
    const onlyClaude =
      working.length > 0 && working.every(([source]) => CLAUDE_ONLY_SOURCES.includes(source));
    if (onlyClaude) {
      busy.add("claude");
      continue;
    }
    const agents = environmentSessions.map((session) => session.agent).filter(isPlatform);
    if (working.some(([source]) => CLAUDE_ONLY_SOURCES.includes(source))) busy.add("claude");
    for (const agent of agents.length > 0 ? agents : AGENT_PLATFORMS) busy.add(agent);
  }
  return AGENT_PLATFORMS.filter((provider) => busy.has(provider));
}

export async function activeCapabilityEnvironment(
  context: CommandContext,
  environmentId: string,
): Promise<boolean> {
  const environment = await context.storage.getEnvironment(environmentId);
  if (!environment || inFlight(environment.agentActivityState)) return true;
  const sessions = await context.storage.listNativeAgentSessions();
  return sessions.some(
    (session) =>
      session.environmentId === environmentId &&
      (inFlight(context.nativeAgents?.capabilityActivity?.(session.key)) ||
        Boolean(session.pendingDispatch && !session.pendingDispatch.mailRefused)),
  );
}

/** {@link busyProvidersFrom} over this backend's environments and native sessions. */
export async function busyHostProviders(context: CommandContext): Promise<AgentPlatform[]> {
  const [environments, sessions] = await Promise.all([
    context.storage.loadEnvironments(),
    context.storage.listNativeAgentSessions(),
  ]);
  return busyProvidersFrom(
    environments as RunningWorkEnvironment[],
    sessions.map((session) => ({
      environmentId: session.environmentId,
      agent: session.agent,
      active:
        inFlight(context.nativeAgents?.capabilityActivity?.(session.key)) ||
        Boolean(session.pendingDispatch && !session.pendingDispatch.mailRefused),
    })),
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

// Reserve admission before async I/O so startup and executor writes cannot pass
// one another between the activity read and publication.
const turnStarts = new Map<AgentPlatform, number>();
const capabilityWrites = new Map<Promise<void>, readonly AgentPlatform[]>();

export async function beginCapabilityTurn(agent: string): Promise<() => void> {
  const platform = AGENT_PLATFORMS.find((entry) => entry === agent);
  if (!platform) return () => undefined;
  turnStarts.set(platform, (turnStarts.get(platform) ?? 0) + 1);
  await Promise.all(
    Array.from(capabilityWrites, ([done, readers]) =>
      readers.includes(platform) ? done : undefined,
    ),
  );
  return () => {
    const count = turnStarts.get(platform) ?? 0;
    if (count <= 1) turnStarts.delete(platform);
    else turnStarts.set(platform, count - 1);
  };
}

export function beginCapabilityWrite(readers: readonly AgentPlatform[]): (() => void) | undefined {
  if (readers.some((reader) => turnStarts.has(reader))) return undefined;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  capabilityWrites.set(done, readers);
  return () => {
    capabilityWrites.delete(done);
    finish();
  };
}
