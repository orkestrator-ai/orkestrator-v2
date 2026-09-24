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
 *   message stays `pending-next-turn`; one that needs a restart says so. The
 *   evidence itself is checked in `evidence.ts`.
 */

import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { coordinatorIdFromRuntimeId } from "@orkestrator/protocol/coordinator";
import {
  MCP_MANAGEMENT_LIMITS,
  type McpApplyState,
  type McpConfigSource,
  type McpRuntimeApplyEntry,
} from "@orkestrator/protocol/mcp-management";

import { awaitsEvidenceIn, withTimeout, type RuntimeEvidenceRead } from "./evidence.js";

export interface ApplyEnvironment {
  id: string;
  name: string;
  status: string;
  environmentType: "local" | "containerized";
  /** Whether the provider's bridge/server is known to be running there. */
  providerRunning: (provider: AgentPlatform) => boolean;
  /** The provider bridge's recorded process id, when one is running. */
  bridgePid?: (provider: AgentPlatform) => number | undefined;
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
  /**
   * Ask the environment's Codex app-server to reload MCP configuration, only if
   * one is already running. Never starts a bridge or an app-server:
   * `not-running` means the next process start reads the saved file anyway, and
   * `unsupported` means the bridge predates the reload route.
   */
  reloadCodex(environmentId: string): Promise<CodexReloadOutcome>;
  /**
   * What the session's bridge reports about the MCP configuration its live
   * runtime was built from, read through the no-touch `/runtime-health`
   * route. Never starts a bridge, touches liveness or re-attaches a session;
   * `not-running` and `none` are answers, not failures.
   */
  mcpConfigEvidence(
    environmentId: string,
    agent: AgentPlatform,
    logicalSessionKey: string,
  ): Promise<RuntimeEvidenceRead>;
}

export type CodexReloadOutcome = "reloaded" | "not-running" | "unsupported";

export interface PlannedRuntime extends McpRuntimeApplyEntry {
  agent: AgentPlatform;
  logicalSessionKey?: string;
  /** A local runtime whose bridge may later prove it loaded the save. */
  awaitsEvidence?: boolean;
  /** Bridge process id at planning time, for providers that apply on restart. */
  bridgePid?: number;
}

const NOT_RUNNING = "Loads when the environment next starts this provider.";
export const ENVIRONMENT_DELETED = "The environment was deleted.";
export const COORDINATOR_BLOCKED =
  "Coordinator sessions use a private configuration home and do not load user MCP servers.";

/**
 * What a container runtime of `provider` does with a backend-user change.
 * Containers copy provider configuration when they are created — except
 * Cursor's, which `docker/entrypoint.sh` never copies at all.
 */
export function containerDelivery(provider: AgentPlatform): {
  state: McpApplyState;
  reason: string;
} {
  if (provider === "cursor") {
    return {
      state: "blocked-policy",
      reason:
        "Cursor's MCP configuration is not copied into containers, so this change never reaches container sessions.",
    };
  }
  return {
    state: "restart-required",
    reason:
      "This container copied its configuration when it was created; recreate the environment to use the change.",
  };
}

function entry(
  session: ApplySession,
  environment: ApplyEnvironment | undefined,
  state: McpApplyState,
  reason: string,
  now: string,
  savedRevision: string | undefined,
): PlannedRuntime {
  const place =
    environment?.name ?? (isCoordinatorSession(session) ? "Coordinator" : session.environmentId);
  const label = `${place} · ${session.logicalSessionKey.split(":").pop() ?? "session"}`;
  return {
    runtimeId: `${session.environmentId}\u0000${session.logicalSessionKey}`,
    environmentId: session.environmentId,
    label,
    state,
    reason,
    updatedAt: now,
    ...(savedRevision ? { savedRevision } : {}),
    agent: session.agent,
    logicalSessionKey: session.logicalSessionKey,
  };
}

function isCoordinatorSession(session: ApplySession): boolean {
  return session.coordinator || coordinatorIdFromRuntimeId(session.environmentId) !== null;
}

/**
 * Keep the first `limit` runtimes, but list one runtime from every environment
 * before any environment's second: a queued Codex reload is per environment,
 * so an environment with no listed runtime would never be reloaded.
 */
export function pageRuntimes(
  runtimes: PlannedRuntime[],
  limit: number,
): { runtimes: PlannedRuntime[]; omitted: number } {
  if (runtimes.length <= limit) return { runtimes, omitted: 0 };
  const firsts = new Set<PlannedRuntime>();
  const seen = new Set<string>();
  for (const runtime of runtimes) {
    if (runtime.state !== "queued") continue;
    const key = runtime.environmentId ?? "";
    if (seen.has(key)) continue;
    seen.add(key);
    firsts.add(runtime);
  }
  const chosen = new Set<PlannedRuntime>(Array.from(firsts).slice(0, limit));
  for (const runtime of runtimes) {
    if (chosen.size >= limit) break;
    chosen.add(runtime);
  }
  // Preserve the original order for display.
  const page = runtimes.filter((runtime) => chosen.has(runtime));
  return { runtimes: page, omitted: runtimes.length - page.length };
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
  savedRevision?: string,
): Promise<{ runtimes: PlannedRuntime[]; omitted: number }> {
  const environments = new Map(
    (await probe.environments()).map((environment) => [environment.id, environment]),
  );
  const sessions = (await probe.sessions()).filter(
    (session) =>
      session.agent === provider && (!environmentIds || environmentIds.has(session.environmentId)),
  );
  const runtimes: PlannedRuntime[] = [];
  const add = (
    session: ApplySession,
    environment: ApplyEnvironment | undefined,
    state: McpApplyState,
    reason: string,
    local = false,
  ) => {
    const planned = entry(session, environment, state, reason, now, savedRevision);
    // Only a local runtime reads the host files the save wrote; a container's
    // copy or a coordinator's private home can never carry that evidence.
    if (local && awaitsEvidenceIn(provider, state)) {
      planned.awaitsEvidence = true;
      const pid = environment?.bridgePid?.(provider);
      if (pid !== undefined) planned.bridgePid = pid;
    }
    runtimes.push(planned);
  };
  for (const session of sessions) {
    const environment = environments.get(session.environmentId);
    // Coordinators run under a runtime id, not an environment id, so they must
    // be reported before the environment lookup rather than silently dropped.
    if (isCoordinatorSession(session)) {
      add(session, environment, "blocked-policy", COORDINATOR_BLOCKED);
      continue;
    }
    if (!environment) continue;
    if (environment.environmentType === "containerized") {
      const delivery = containerDelivery(provider);
      add(session, environment, delivery.state, delivery.reason);
      continue;
    }
    const projectScoped = scope === "project" || scope === "claude-local";
    if (projectScoped && (sourceExcluded || session.projectResources === false)) {
      add(
        session,
        environment,
        "blocked-policy",
        sourceExcluded ?? "This session excludes project servers.",
      );
      continue;
    }
    if (environment.status !== "running" || !environment.providerRunning(provider)) {
      add(session, environment, "pending-next-turn", NOT_RUNNING, true);
      continue;
    }
    switch (provider) {
      case "claude":
        add(
          session,
          environment,
          "pending-next-turn",
          "Loads on the session's next message.",
          true,
        );
        break;
      case "cursor":
      case "pi":
        add(
          session,
          environment,
          "pending-next-turn",
          "Reconnects MCP servers before the session's next message.",
          true,
        );
        break;
      case "codex":
        add(session, environment, "queued", "Waiting to reload Codex's MCP configuration.");
        break;
      case "opencode":
        add(
          session,
          environment,
          "restart-required",
          "OpenCode reads configuration when its server starts; stop and start the environment to load the change.",
        );
        break;
      case "grok":
        add(
          session,
          environment,
          "restart-required",
          "Grok Build loads MCP servers when it starts; stop and start the environment to load the change.",
          true,
        );
        break;
    }
  }
  return pageRuntimes(runtimes, MCP_MANAGEMENT_LIMITS.runtimesPerOperation);
}

export const CODEX_APPLY_WAIT_MS = 30 * 60_000;
const CODEX_RELOAD_TIMEOUT_MS = 30_000;

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
    if (!environment) {
      // Deleted (or being deleted): there is nothing left to apply to.
      set(list, "cancelled", ENVIRONMENT_DELETED);
      continue;
    }
    if (environment.status !== "running" || !environment.providerRunning("codex")) {
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
    set(list, "applying", "Reloading Codex's MCP configuration.");
    try {
      // Environment-level and no-spawn: a bridge restart that forgot every
      // session still reloads, and a stopped app-server is never cold-started.
      const outcome = await withTimeout(probe.reloadCodex(environmentId), CODEX_RELOAD_TIMEOUT_MS);
      if (outcome === "unsupported") {
        set(
          list,
          "restart-required",
          "This Codex bridge predates on-request reload; stop and start the environment to load the change.",
        );
      } else {
        set(
          list,
          "pending-next-turn",
          outcome === "reloaded"
            ? "Codex reloaded its MCP configuration; each thread uses it from its next turn."
            : "Codex is not running; it reads the saved configuration when it next starts.",
        );
      }
    } catch {
      set(list, "failed", "Codex did not accept the reload request; retry apply.");
    }
  }
  return { runtimes, waiting, changed };
}
