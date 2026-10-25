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
 * - Nothing planned is dropped for display: an operation tracks up to
 *   `runtimesTrackedPerOperation` runtimes and only its snapshot is paged
 *   ({@link publicApply}).
 */

import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { coordinatorIdFromRuntimeId } from "@orkestrator/protocol/coordinator";
import {
  MCP_MANAGEMENT_LIMITS,
  type McpApplyState,
  type McpConfigSource,
  type McpOperationSnapshot,
  type McpRuntimeApplyEntry,
} from "@orkestrator/protocol/mcp-management";

import { awaitsEvidenceIn, withTimeout, type RuntimeEvidenceRead } from "./evidence.js";
import type { Supersession } from "./external-edits.js";

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
  /** The provider session the logical session maps to now, when persisted. */
  providerSessionId?: string;
  pendingDispatch: boolean;
  /** The open dispatch's request id, when one is open. */
  pendingDispatchId?: string;
  /**
   * The newest dispatch the provider accepted for this session. A different
   * value later means a turn started since (Codex reload evidence).
   */
  lastDispatchId?: string;
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
  reloadCodex(environmentId: string): Promise<ReloadOutcome>;
  /**
   * Rebuild the environment's OpenCode instance for its worktree so it reads
   * the saved files again (`instance.dispose`), only if its server is already
   * running and every session there is idle. `busy` means OpenCode itself saw
   * work running; `names` are the MCP servers the rebuilt instance lists.
   */
  reloadOpenCode?(environmentId: string): Promise<{ outcome: ReloadOutcome; names?: string[] }>;
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
export type ReloadOutcome = CodexReloadOutcome | "busy";

export interface PlannedRuntime extends McpRuntimeApplyEntry {
  agent: AgentPlatform;
  logicalSessionKey?: string;
  /** A local runtime whose bridge may later prove it loaded the save. */
  awaitsEvidence?: boolean;
  /** Bridge process id at planning time, for providers that apply on restart. */
  bridgePid?: number;
  /**
   * What identifies a local runtime's generation at planning time; the
   * service turns it into the opaque `generation` label.
   */
  generationParts?: GenerationParts;
}

/** The bridge process and provider session behind one local runtime. */
export interface GenerationParts {
  bridgePid?: number;
  providerSessionId?: string;
}

const NOT_RUNNING = "Loads when the environment next starts this provider.";
const OPENCODE_RESTART =
  "OpenCode reads configuration when its server starts; stop and start the environment to load the change.";
const OPENCODE_USER_RESTART =
  "OpenCode keeps its user configuration until its server restarts; stop and start the environment to load the change.";
export const ENVIRONMENT_DELETED = "The environment was deleted.";
export const COORDINATOR_BLOCKED =
  "Coordinator sessions use a private configuration home and do not load user MCP servers.";

/**
 * What a container runtime of `provider` does with a backend-user change.
 * Every boot copies the inputs staged for the container. Claude's
 * `.claude.json` is staged again before each start; every other provider's
 * inputs, Cursor's `mcp.json` included (images with `staged-inputs` 2), are
 * staged when the container is created, and a defaults refresh rewrites them.
 */
export function containerDelivery(provider: AgentPlatform): {
  state: McpApplyState;
  reason: string;
} {
  if (provider === "claude") {
    return {
      state: "restart-required",
      reason:
        "This container copies Claude's configuration each time it starts; stop and start the environment to use the change.",
    };
  }
  return {
    state: "restart-required",
    reason: CONTAINER_DEFAULTS_REASON,
  };
}

export const CONTAINER_DEFAULTS_REASON =
  "This container copied its configuration when it was created; refresh its defaults from the environment's MCP settings, or rebuild the environment, to use the change.";

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
 * Keep the first `limit` runtimes, but take one runtime from every environment
 * (among those `spread` selects) before any environment's second. Planning
 * spreads queued runtimes, because a Codex reload is per environment and an
 * environment with no kept runtime would never be reloaded; the snapshot page
 * spreads every runtime, so each environment stays visible.
 */
export function pageRuntimes<T extends Pick<McpRuntimeApplyEntry, "environmentId" | "state">>(
  runtimes: T[],
  limit: number,
  spread: (runtime: T) => boolean = (runtime) => runtime.state === "queued",
): { runtimes: T[]; rest: T[] } {
  if (runtimes.length <= limit) return { runtimes, rest: [] };
  const firsts = new Set<T>();
  const seen = new Set<string>();
  for (const runtime of runtimes) {
    if (!spread(runtime)) continue;
    const key = runtime.environmentId ?? "";
    if (seen.has(key)) continue;
    seen.add(key);
    firsts.add(runtime);
  }
  const chosen = new Set<T>(Array.from(firsts).slice(0, limit));
  for (const runtime of runtimes) {
    if (chosen.size >= limit) break;
    chosen.add(runtime);
  }
  // Preserve the original order for display.
  return {
    runtimes: runtimes.filter((runtime) => chosen.has(runtime)),
    rest: runtimes.filter((runtime) => !chosen.has(runtime)),
  };
}

/**
 * The apply state a snapshot shows. An operation keeps every runtime it
 * tracks, and the scheduler advances all of them; only the listing is cut to
 * `runtimesPerOperation`. The rest are counted in `omitted` with their states
 * in `omittedStates`, beside any runtimes planning could not track at all.
 * `omittedStates` carries no `cancelReason`, so a superseded runtime is always
 * listed when there is one: it is what tells a client a retry is refused.
 */
export function publicApply(apply: McpOperationSnapshot["apply"]): McpOperationSnapshot["apply"] {
  const limit = MCP_MANAGEMENT_LIMITS.runtimesPerOperation;
  if (apply.runtimes.length <= limit) return apply;
  const page = pageRuntimes(apply.runtimes, limit, () => true);
  const superseded = (runtime: McpRuntimeApplyEntry) =>
    runtime.state === "cancelled" && runtime.cancelReason !== undefined;
  const hidden = page.rest.find(superseded);
  if (hidden && !page.runtimes.some(superseded)) {
    // Swap it for the last listed runtime, keeping the original order.
    const listed = new Set([...page.runtimes.slice(0, -1), hidden]);
    page.runtimes = apply.runtimes.filter((runtime) => listed.has(runtime));
    page.rest = apply.runtimes.filter((runtime) => !listed.has(runtime));
  }
  const omittedStates: Partial<Record<McpApplyState, number>> = {};
  for (const runtime of page.rest) {
    omittedStates[runtime.state] = (omittedStates[runtime.state] ?? 0) + 1;
  }
  return {
    ...apply,
    runtimes: page.runtimes,
    omitted: apply.omitted + page.rest.length,
    omittedStates,
  };
}

/**
 * Initial per-runtime states for a saved change to `scope` of `provider`.
 * `environmentIds` limits the change to one environment for worktree scopes;
 * `null` means every local environment (backend-user files). `omitted` counts
 * the runtimes past `runtimesTrackedPerOperation`, which are not scheduled.
 */
export async function planRuntimes(
  probe: RuntimeProbe,
  provider: AgentPlatform,
  scope: McpConfigSource["scope"],
  environmentIds: ReadonlySet<string> | null,
  sourceExcluded: string | undefined,
  now: string,
  savedRevision?: string,
  options: {
    /**
     * OpenCode: the saved file is one each directory instance reads when it
     * is built (project files, `.opencode` and config directories,
     * `OPENCODE_CONFIG`), so rebuilding the instance loads it. OpenCode 1.19
     * caches the user files in `$XDG_CONFIG_HOME/opencode` for the server's
     * lifetime, so those still need a restart.
     */
    openCodeInstanceSource?: boolean;
  } = {},
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
    const pid = local ? environment?.bridgePid?.(provider) : undefined;
    if (local) {
      planned.generationParts = {
        ...(pid !== undefined ? { bridgePid: pid } : {}),
        ...(session.providerSessionId ? { providerSessionId: session.providerSessionId } : {}),
      };
    }
    // Only a local runtime reads the host files the save wrote; a container's
    // copy or a coordinator's private home can never carry that evidence.
    if (local && awaitsEvidenceIn(provider, state)) {
      planned.awaitsEvidence = true;
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
    // A backend-user change reaches a container only through its copy; a
    // save written into the container itself is adopted like a local one.
    const container = environment.environmentType === "containerized";
    if (container && scope === "backend-user") {
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
    // Evidence and generations come from host files and host bridge pids only.
    const local = !container;
    if (environment.status !== "running" || !environment.providerRunning(provider)) {
      add(session, environment, "pending-next-turn", NOT_RUNNING, local);
      continue;
    }
    switch (provider) {
      case "claude":
        add(
          session,
          environment,
          "pending-next-turn",
          "Loads on the session's next message.",
          local,
        );
        break;
      case "cursor":
      case "pi":
        add(
          session,
          environment,
          "pending-next-turn",
          "Reconnects MCP servers before the session's next message.",
          local,
        );
        break;
      case "codex":
        add(session, environment, "queued", "Waiting to reload Codex's MCP configuration.", local);
        break;
      case "opencode":
        // A worktree's instance is rebuilt in place once the directory is
        // idle, for files an instance reads when it is built. A container's
        // server is not reloaded from here, so it still needs the restart.
        if (local && options.openCodeInstanceSource) {
          add(
            session,
            environment,
            "queued",
            "Waiting to reload OpenCode's configuration for this worktree.",
            local,
          );
        } else {
          add(
            session,
            environment,
            "restart-required",
            local ? OPENCODE_USER_RESTART : OPENCODE_RESTART,
            local,
          );
        }
        break;
      case "grok":
        add(
          session,
          environment,
          "restart-required",
          "Grok Build loads MCP servers when it starts; stop and start the environment to load the change.",
          local,
        );
        break;
    }
  }
  const tracked = pageRuntimes(runtimes, MCP_MANAGEMENT_LIMITS.runtimesTrackedPerOperation);
  return { runtimes: tracked.runtimes, omitted: tracked.rest.length };
}

export const CODEX_APPLY_WAIT_MS = 30 * 60_000;
const CODEX_RELOAD_TIMEOUT_MS = 30_000;

/** Providers whose apply is one reload per environment, run while it is idle. */
const RELOADED_PROVIDERS = new Set<AgentPlatform>(["codex", "opencode"]);

/** What a reload proves about the saved change, for the OpenCode post-reload check. */
export interface ReloadExpectation {
  /** A server name the rebuilt runtime must list (added, edited or renamed to). */
  present?: string;
}

const RELOAD_TEXT = {
  codex: {
    name: "Codex",
    busy: "Waiting for Codex to finish its current work.",
    applying: "Reloading Codex's MCP configuration.",
    timeout: "Codex stayed busy for 30 minutes; retry apply when its sessions are idle.",
    unsupported:
      "This Codex bridge predates on-request reload; stop and start the environment to load the change.",
    refused: "Codex did not accept the reload request; retry apply.",
  },
  opencode: {
    name: "OpenCode",
    busy: "Waiting for OpenCode to finish its current work in this worktree.",
    applying: "Reloading OpenCode's configuration for this worktree.",
    timeout: "OpenCode stayed busy for 30 minutes; retry apply when its sessions are idle.",
    unsupported: OPENCODE_RESTART,
    refused: "OpenCode did not rebuild its instance; retry apply.",
  },
} as const;

/**
 * Advance queued Codex and OpenCode runtimes. Returns the updated list,
 * whether any are still waiting, the ids of Codex runtimes whose app-server
 * reloaded, and the ids of Codex runtimes now waiting for a turn (reloaded,
 * or nothing running) — the service records their turn baseline. One reload
 * per environment covers every session in it.
 *
 * Codex: `config/mcpServer/reload` on the environment's app-server; threads
 * use the change from their next turn, which the service proves separately.
 *
 * OpenCode: `instance.dispose` for the worktree, only while every session
 * there is idle (the provider checks again), so the next request rebuilds the
 * instance from the saved files. The rebuilt instance's MCP listing is the
 * evidence: `applied` when it lists `expectation.present` (or the change was
 * a removal), `restart-required` when it does not.
 *
 * `refusal` is asked once, just before the first reload, whether the change
 * still applies; a supersession cancels the queued runtimes, with its reason
 * and `cancelReason`, instead of reloading.
 */
export async function advanceReloadRuntimes(
  probe: RuntimeProbe,
  runtimes: PlannedRuntime[],
  queuedAt: number,
  nowMs: number,
  refusal?: () => Promise<Supersession | undefined>,
  expectation: ReloadExpectation = {},
): Promise<{
  runtimes: PlannedRuntime[];
  waiting: boolean;
  changed: boolean;
  reloaded: string[];
  awaitingTurn: string[];
}> {
  const now = new Date(nowMs).toISOString();
  const queued = runtimes.filter(
    (runtime) =>
      RELOADED_PROVIDERS.has(runtime.agent) &&
      (runtime.state === "queued" || runtime.state === "applying"),
  );
  if (!queued.length) {
    return { runtimes, waiting: false, changed: false, reloaded: [], awaitingTurn: [] };
  }
  const environments = new Map(
    (await probe.environments()).map((environment) => [environment.id, environment]),
  );
  const sessions = await probe.sessions();
  let waiting = false;
  let changed = false;
  const reloaded: string[] = [];
  const awaitingTurn: string[] = [];
  const byEnvironment = new Map<string, PlannedRuntime[]>();
  for (const runtime of queued) {
    const key = `${runtime.agent}\u0000${runtime.environmentId!}`;
    const list = byEnvironment.get(key) ?? [];
    list.push(runtime);
    byEnvironment.set(key, list);
  }
  let refused: Promise<Supersession | undefined> | undefined;
  const set = (
    list: PlannedRuntime[],
    state: McpApplyState,
    reason: string,
    cancelReason?: Supersession["cancelReason"],
  ) => {
    for (const runtime of list) {
      if (runtime.state !== state || runtime.reason !== reason) changed = true;
      runtime.state = state;
      runtime.reason = reason;
      if (cancelReason) runtime.cancelReason = cancelReason;
      else delete runtime.cancelReason;
      runtime.updatedAt = now;
    }
  };
  for (const list of byEnvironment.values()) {
    const provider = list[0]!.agent as "codex" | "opencode";
    const environmentId = list[0]!.environmentId!;
    const text = RELOAD_TEXT[provider];
    const wait = () => {
      if (nowMs - queuedAt > CODEX_APPLY_WAIT_MS) {
        set(list, "failed", text.timeout);
      } else {
        set(list, "queued", text.busy);
        waiting = true;
      }
    };
    const environment = environments.get(environmentId);
    if (!environment) {
      // Deleted (or being deleted): there is nothing left to apply to.
      set(list, "cancelled", ENVIRONMENT_DELETED);
      continue;
    }
    if (environment.status !== "running" || !environment.providerRunning(provider)) {
      set(list, "pending-next-turn", NOT_RUNNING);
      if (provider === "codex") awaitingTurn.push(...list.map((runtime) => runtime.runtimeId));
      continue;
    }
    // The reload is process- or directory-wide: every session sharing it must be idle.
    const shared = sessions.filter(
      (session) =>
        session.agent === provider &&
        session.environmentId === environmentId &&
        !session.coordinator,
    );
    const busy = shared.some(
      (session) =>
        session.pendingDispatch ||
        probe.activity(environmentId, provider, session.logicalSessionKey) !== "idle",
    );
    if (busy) {
      wait();
      continue;
    }
    // The file may have changed since the save; a reload would then load a
    // configuration that no longer carries this change.
    refused ??= (refusal?.() ?? Promise.resolve(undefined)).catch(() => undefined);
    const superseded = await refused;
    if (superseded) {
      set(list, "cancelled", superseded.reason, superseded.cancelReason);
      continue;
    }
    set(list, "applying", text.applying);
    try {
      // Environment-level and no-spawn: a bridge restart that forgot every
      // session still reloads, and a stopped process is never cold-started.
      const result =
        provider === "codex"
          ? {
              outcome: await withTimeout(probe.reloadCodex(environmentId), CODEX_RELOAD_TIMEOUT_MS),
            }
          : probe.reloadOpenCode
            ? await withTimeout(probe.reloadOpenCode(environmentId), CODEX_RELOAD_TIMEOUT_MS)
            : { outcome: "unsupported" as const };
      const outcome = result.outcome;
      if (outcome === "unsupported") {
        set(list, "restart-required", text.unsupported);
      } else if (outcome === "busy") {
        wait();
      } else if (outcome === "not-running") {
        set(
          list,
          "pending-next-turn",
          `${text.name} is not running; it reads the saved configuration when it next starts.`,
        );
        if (provider === "codex") awaitingTurn.push(...list.map((runtime) => runtime.runtimeId));
      } else if (provider === "codex") {
        set(
          list,
          "pending-next-turn",
          "Codex reloaded its MCP configuration; each thread uses it from its next turn.",
        );
        reloaded.push(...list.map((runtime) => runtime.runtimeId));
        awaitingTurn.push(...list.map((runtime) => runtime.runtimeId));
      } else {
        const names = "names" in result ? result.names : undefined;
        if (!names) {
          // Disposed, but the rebuilt instance has not answered yet; the next
          // request builds it from the saved files either way.
          set(
            list,
            "pending-next-turn",
            "OpenCode dropped this worktree's instance; it rebuilds it from the saved files at its next request.",
          );
        } else if (expectation.present && !names.includes(expectation.present)) {
          set(
            list,
            "restart-required",
            `OpenCode rebuilt this worktree's instance but does not list ${expectation.present}; stop and start the environment to load the change.`,
          );
        } else {
          set(
            list,
            "applied",
            "OpenCode rebuilt this worktree's instance from the saved configuration.",
          );
        }
      }
    } catch {
      set(list, "failed", text.refused);
    }
  }
  return { runtimes, waiting, changed, reloaded, awaitingTurn };
}
