/**
 * Runtime application of a saved configuration revision.
 *
 * Saving is complete before anything here runs. This module only decides, for
 * every runtime the backend already knows about, whether and when that runtime
 * adopts the saved file — and it reports each outcome separately:
 *
 * - It never creates a session to have something to apply to.
 * - It never interrupts a turn. Process-wide work (Codex's MCP reload) waits
 *   until every session sharing the process is idle; "unknown" activity counts
 *   as busy, because idle-looking UI is not evidence.
 * - "applied" is only reported on evidence. A provider that reloads at its next
 *   message stays `pending-next-turn`; one that needs a restart says so.
 */

import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  MCP_MANAGEMENT_LIMITS,
  type McpApplyState,
  type McpConfigSource,
  type McpRuntimeApplyEntry,
} from "@orkestrator/protocol/mcp-management";

export interface ApplyEnvironment {
  id: string;
  name: string;
  status: string;
  environmentType: "local" | "containerized";
  /** Whether the provider's bridge/server is known to be running there. */
  providerRunning: (provider: AgentPlatform) => boolean;
}

export interface ApplySession {
  environmentId: string;
  agent: AgentPlatform;
  logicalSessionKey: string;
  pendingDispatch: boolean;
  coordinator: boolean;
  projectResources?: boolean;
}

export interface RuntimeProbe {
  environments(): Promise<ApplyEnvironment[]>;
  sessions(): Promise<ApplySession[]>;
  activity(
    environmentId: string,
    agent: AgentPlatform,
    logicalSessionKey: string,
  ): "idle" | "working" | "waiting" | "unknown";
  /** Ask the environment's Codex app-server to reload MCP configuration. */
  reloadCodex(environmentId: string, logicalSessionKey: string): Promise<void>;
}

export interface PlannedRuntime extends McpRuntimeApplyEntry {
  agent: AgentPlatform;
  logicalSessionKey?: string;
}

const NOT_RUNNING = "Loads when the environment next starts this provider.";

function entry(
  session: ApplySession,
  environment: ApplyEnvironment | undefined,
  state: McpApplyState,
  reason: string,
  now: string,
): PlannedRuntime {
  const label = `${environment?.name ?? session.environmentId} · ${session.logicalSessionKey.split(":").pop() ?? "session"}`;
  return {
    runtimeId: `${session.environmentId}\u0000${session.logicalSessionKey}`,
    environmentId: session.environmentId,
    label,
    state,
    reason,
    updatedAt: now,
    agent: session.agent,
    logicalSessionKey: session.logicalSessionKey,
  };
}

/**
 * Initial per-runtime states for a saved change to `scope` of `provider`.
 * `environmentIds` limits the change to one environment for worktree scopes;
 * `null` means every local environment (backend-user files).
 */
export async function planRuntimes(
  probe: RuntimeProbe,
  provider: AgentPlatform,
  scope: McpConfigSource["scope"],
  environmentIds: ReadonlySet<string> | null,
  sourceExcluded: string | undefined,
  now: string,
): Promise<{ runtimes: PlannedRuntime[]; omitted: number }> {
  const environments = new Map(
    (await probe.environments()).map((environment) => [environment.id, environment]),
  );
  const sessions = (await probe.sessions()).filter(
    (session) =>
      session.agent === provider && (!environmentIds || environmentIds.has(session.environmentId)),
  );
  const runtimes: PlannedRuntime[] = [];
  for (const session of sessions) {
    const environment = environments.get(session.environmentId);
    if (!environment) continue;
    if (environment.environmentType === "containerized") {
      runtimes.push(
        entry(
          session,
          environment,
          "restart-required",
          "This container copied its configuration when it was created; recreate the environment to use the change.",
          now,
        ),
      );
      continue;
    }
    if (session.coordinator) {
      runtimes.push(
        entry(
          session,
          environment,
          "blocked-policy",
          "Coordinator sessions use a private configuration home.",
          now,
        ),
      );
      continue;
    }
    const projectScoped = scope === "project" || scope === "claude-local";
    if (projectScoped && (sourceExcluded || session.projectResources === false)) {
      runtimes.push(
        entry(
          session,
          environment,
          "blocked-policy",
          sourceExcluded ?? "This session excludes project servers.",
          now,
        ),
      );
      continue;
    }
    if (environment.status !== "running" || !environment.providerRunning(provider)) {
      runtimes.push(entry(session, environment, "pending-next-turn", NOT_RUNNING, now));
      continue;
    }
    switch (provider) {
      case "claude":
        runtimes.push(
          entry(
            session,
            environment,
            "pending-next-turn",
            "Loads on the session's next message.",
            now,
          ),
        );
        break;
      case "cursor":
      case "pi":
        runtimes.push(
          entry(
            session,
            environment,
            "pending-next-turn",
            "Reconnects MCP servers before the session's next message.",
            now,
          ),
        );
        break;
      case "codex":
        runtimes.push(
          entry(
            session,
            environment,
            "queued",
            "Waiting to reload Codex's MCP configuration.",
            now,
          ),
        );
        break;
      case "opencode":
        runtimes.push(
          entry(
            session,
            environment,
            "restart-required",
            "OpenCode reads configuration when its server starts; stop and start the environment to load the change.",
            now,
          ),
        );
        break;
      case "grok":
        runtimes.push(
          entry(
            session,
            environment,
            "restart-required",
            "Grok Build loads MCP servers when it starts; stop and start the environment to load the change.",
            now,
          ),
        );
        break;
    }
  }
  const limit = MCP_MANAGEMENT_LIMITS.runtimesPerOperation;
  return { runtimes: runtimes.slice(0, limit), omitted: Math.max(0, runtimes.length - limit) };
}

export const CODEX_APPLY_WAIT_MS = 30 * 60_000;
const CODEX_RELOAD_TIMEOUT_MS = 30_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Advance queued Codex runtimes. Returns the updated list and whether any are
 * still waiting. One reload per environment covers every thread in it.
 */
export async function advanceCodexRuntimes(
  probe: RuntimeProbe,
  runtimes: PlannedRuntime[],
  queuedAt: number,
  nowMs: number,
): Promise<{ runtimes: PlannedRuntime[]; waiting: boolean; changed: boolean }> {
  const now = new Date(nowMs).toISOString();
  const queued = runtimes.filter(
    (runtime) =>
      runtime.agent === "codex" && (runtime.state === "queued" || runtime.state === "applying"),
  );
  if (!queued.length) return { runtimes, waiting: false, changed: false };
  const environments = new Map(
    (await probe.environments()).map((environment) => [environment.id, environment]),
  );
  const sessions = await probe.sessions();
  let waiting = false;
  let changed = false;
  const byEnvironment = new Map<string, PlannedRuntime[]>();
  for (const runtime of queued) {
    const list = byEnvironment.get(runtime.environmentId!) ?? [];
    list.push(runtime);
    byEnvironment.set(runtime.environmentId!, list);
  }
  const set = (list: PlannedRuntime[], state: McpApplyState, reason: string) => {
    for (const runtime of list) {
      if (runtime.state !== state || runtime.reason !== reason) changed = true;
      runtime.state = state;
      runtime.reason = reason;
      runtime.updatedAt = now;
    }
  };
  for (const [environmentId, list] of byEnvironment) {
    const environment = environments.get(environmentId);
    if (!environment || environment.status !== "running" || !environment.providerRunning("codex")) {
      set(list, "pending-next-turn", NOT_RUNNING);
      continue;
    }
    // The reload is process-wide: every Codex session in the environment must be idle.
    const shared = sessions.filter(
      (session) =>
        session.agent === "codex" &&
        session.environmentId === environmentId &&
        !session.coordinator,
    );
    const busy = shared.some(
      (session) =>
        session.pendingDispatch ||
        probe.activity(environmentId, "codex", session.logicalSessionKey) !== "idle",
    );
    if (busy) {
      if (nowMs - queuedAt > CODEX_APPLY_WAIT_MS) {
        set(
          list,
          "failed",
          "Codex stayed busy for 30 minutes; retry apply when its sessions are idle.",
        );
      } else {
        set(list, "queued", "Waiting for Codex to finish its current work.");
        waiting = true;
      }
      continue;
    }
    const via = shared[0] ?? list[0];
    if (!via?.logicalSessionKey) {
      set(list, "pending-next-turn", "New Codex threads read configuration when they start.");
      continue;
    }
    set(list, "applying", "Reloading Codex's MCP configuration.");
    try {
      await withTimeout(
        probe.reloadCodex(environmentId, via.logicalSessionKey),
        CODEX_RELOAD_TIMEOUT_MS,
      );
      set(
        list,
        "pending-next-turn",
        "Codex reloaded its MCP configuration; each thread uses it from its next turn.",
      );
    } catch {
      set(list, "failed", "Codex did not accept the reload request; retry apply.");
    }
  }
  return { runtimes, waiting, changed };
}
