/**
 * The `opencode` provider of one environment: OpenCode 2.x, the only
 * OpenCode line Orkestrator runs.
 *
 * The provider registry caches one provider per (environment, agent). This
 * one holds the environment's OpenCode server connection
 * ({@link OpenCodeEnvironmentDependencies.connection}) and an
 * {@link OpenCode2Provider} built for the server generation it last saw:
 *
 * - **The server starts only on demand.** Observers (`activity`,
 *   `activityBatch`, catalogue and interaction reads) never start it; a
 *   session with no server running has no turn in flight and reads idle, the
 *   way a bridge that is not running does. A replaced server (new port or
 *   password) gets a new 2.x provider; the old one is disposed.
 * - **What a session does not offer** answers what an absent capability would
 *   (empty catalogues) or refuses with a clear error. Snapshots carry
 *   `capabilityLimits`, which the projection uses to narrow the tab to what
 *   its session offers.
 */
import {
  AGENT_INTERACTION_CONTRACT_VERSION,
  type AgentInteractionSnapshot,
} from "@orkestrator/protocol/agent-interactions";
import { idleSteerPromptReply } from "@orkestrator/protocol/agent-slash-commands";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import {
  type AgentModel,
  type NativeAgentAuthStatus,
  type NativeAgentContextUsage,
  type NativeAgentControlUpdate,
  type NativeAgentExecutionPolicy,
  type NativeAgentForkOutcome,
  type NativeAgentSessionActionOutcome,
} from "@orkestrator/protocol/native-agent";
import type { StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import {
  PromptRejectedError,
  ProviderUnavailableError,
  TURN_STOPPED_BY_USER_MESSAGE,
  type AgentInteractionProviderCapability,
  type NativeAgentRuntimeProvider,
  type ProviderActiveSteerRun,
  type ProviderActivityState,
  type ProviderCapabilityLimits,
  type ProviderCommandCatalogue,
  type ProviderCommandRefreshResult,
  type ProviderCreateSessionOptions,
  type ProviderDispatchStatus,
  type ProviderInteractiveSnapshot,
  type ProviderNativeAgentSessionAction,
  type ProviderPrepareDispatchOptions,
  type ProviderRuntimeHealth,
  type ProviderSendOptions,
  type ProviderSessionRegistration,
  type ProviderSessionStateSnapshot,
  type ProviderStatus,
  type ProviderSteerDispatchStatus,
  type ProviderTranscriptPage,
  type ProviderTranscriptSnapshot,
} from "../agent-provider-contract.js";
import { OpenCode2Client, type OpenCode2Connection } from "./client.js";
import { OPENCODE2_EVIDENCE_SCAN_LIMIT, OpenCode2Provider } from "./provider.js";
import type { OpenCode2SessionState } from "./session-state.js";
import type { OpenCode2CoordinatorAuthority } from "./coordinator.js";
import type { OpenCode2WorkerMailbox } from "./turn-connections.js";
import {
  exclusiveOpenCode2Reload,
  openCode2ReloadGateKey,
  withinOpenCode2Dispatch,
} from "./reload-gate.js";
import { normalizeOpenCode2Transcript } from "./transcript.js";
import { isOpenCode2IdleMessage, type OpenCode2Message } from "./types.js";

const log = createLogger("native-agent.opencode2");

/**
 * What an OpenCode session does not offer; the projection narrows its
 * capabilities by it. Compact, undo, redo, fork, attachments and slash
 * commands work (`features.ts`); OpenCode's platform table offers neither
 * share nor message rewind, which stay listed so a later table change cannot
 * widen an OpenCode tab by accident.
 */
export const OPENCODE2_CAPABILITY_LIMITS: ProviderCapabilityLimits = {
  withoutActions: ["rewindMessages", "share"],
};

/** One 2.x server generation: a new port or password is a new generation. */
export interface OpenCode2ServerConnection extends OpenCode2Connection {
  generation: string;
  /**
   * Set when the server is a coordinator's: the policy and research it was
   * launched with, which every session on it runs under (`coordinator.ts`).
   */
  coordinator?: OpenCode2CoordinatorAuthority;
  /**
   * Rewrite the configuration the server reads (the mirror of the user's
   * global configuration) before a reload. Absent where the backend cannot
   * rewrite it (a container's is root's, written at launch).
   */
  refreshConfiguration?(): Promise<void>;
}

export interface OpenCodeEnvironmentDependencies {
  /**
   * The environment's OpenCode server. `start: false` never spawns one and
   * answers undefined when none is running; `start: true` starts it or throws.
   */
  connection(options: { start: boolean }): Promise<OpenCode2ServerConnection | undefined>;
  /** Builds the 2.x provider for one server generation (tests substitute it). */
  createProvider?(
    client: OpenCode2Client,
    connection: OpenCode2ServerConnection,
  ): OpenCode2Provider;
  /** The user's `openCodeModelProviders`, normalized; shapes the model picker. */
  allowedModelProviders?(): Promise<readonly string[]>;
  /**
   * Workflow providers only: a pipeline worker's own mailbox connection, for
   * a turn that carries `workerMail` (`turn-connections.ts`).
   */
  workerMailbox?: OpenCode2WorkerMailbox;
  /**
   * The model and effort the caller's connection names (a pipeline step's
   * configured model), used when a create or send names none, as every
   * bridge provider uses its connection's.
   */
  defaults?: { model?: string; effort?: string };
}

export class OpenCodeEnvironmentProvider implements NativeAgentRuntimeProvider {
  readonly agent = "opencode" as const;
  readonly messageReadLimit = OPENCODE2_EVIDENCE_SCAN_LIMIT;
  /** Ids a tab or workflow holds, re-registered on a replacement server's provider. */
  private readonly liveSessions = new Set<string>();
  private current: { generation: string; gateKey: string; provider: OpenCode2Provider } | undefined;
  private disposed = false;

  readonly interactions: AgentInteractionProviderCapability;

  constructor(private readonly deps: OpenCodeEnvironmentDependencies) {
    this.interactions = {
      // Observers: a session with no server running has nothing pending.
      listPendingInteractions: async (sessionId) => {
        const provider = await this.observed();
        return provider
          ? provider.interactions.listPendingInteractions(sessionId)
          : emptyInteractionSnapshot();
      },
      resolveInteraction: async (sessionId, interactionId, resolution) => {
        const provider = await this.observed();
        // No server, no run: whatever the card showed is gone.
        if (!provider) return { result: "stale", sessionId, interactionId, revision: 0 };
        return provider.interactions.resolveInteraction(sessionId, interactionId, resolution);
      },
      // Synchronous by contract: only the current server's provider has listed anything.
      permissionRuleDetail: (sessionId: string, interactionId: string) =>
        this.current?.provider.interactions.permissionRuleDetail(sessionId, interactionId) ?? null,
    } satisfies AgentInteractionProviderCapability;
  }

  // ── registration and creation ──────────────────────────────────────────────

  registerSession(sessionId: string, interaction?: ProviderSessionRegistration): void {
    if (this.disposed) return;
    this.liveSessions.add(sessionId);
    this.current?.provider.registerSession(sessionId, interaction);
  }

  async createSession(
    phase: string,
    label: string,
    options: ProviderCreateSessionOptions = {},
  ): Promise<string> {
    const id = await this.dispatching((provider) =>
      provider.createSession(phase, label, this.withDefaults(options)),
    );
    this.liveSessions.add(id);
    return id;
  }

  async prepareDispatch(sessionId: string, options?: ProviderPrepareDispatchOptions) {
    // The cold start (spawn and readiness) and the MCP registrations belong
    // before the at-most-once window.
    return this.dispatching((provider) => provider.prepareDispatch(sessionId, options));
  }

  async send(sessionId: string, prompt: string, options: ProviderSendOptions): Promise<void> {
    // A `/steer` that reaches the provider as a prompt arrived while the
    // composer saw no running turn. Answer it here, as the bridges do
    // (`idleSteerPromptReply`), rather than let the raw command start a model
    // turn. Literal intent and a resolved command skip it.
    if (options.allowProviderCommands !== false && !options.command) {
      const reply = idleSteerPromptReply(prompt, "OpenCode");
      if (reply) throw new PromptRejectedError(reply);
    }
    return this.dispatching((provider) =>
      provider.send(sessionId, prompt, this.withDefaults(options)),
    );
  }

  async dispatchStatus(sessionId: string, requestId: string): Promise<ProviderDispatchStatus> {
    return (await this.required()).dispatchStatus(sessionId, requestId);
  }

  async settleTurn(sessionId: string, requestId: string): Promise<boolean> {
    // The grant lives in the session, so restoring it needs the server.
    return (await this.required()).settleTurn(sessionId, requestId);
  }

  async turnTerminalError(sessionId: string, requestId: string): Promise<string | null> {
    const rows = (await (
      await this.required()
    ).messages(sessionId, {
      limit: OPENCODE2_EVIDENCE_SCAN_LIMIT,
    })) as OpenCode2Message[];
    return openCode2TurnTerminalError(rows, requestId);
  }

  // ── lifecycle reads ────────────────────────────────────────────────────────

  async status(sessionId: string): Promise<ProviderStatus> {
    return (await this.required()).status(sessionId);
  }

  async activity(sessionId: string): Promise<ProviderActivityState> {
    const provider = await this.observed();
    return provider ? provider.activity(sessionId) : "idle";
  }

  async activityBatch(sessionIds: readonly string[]): Promise<Map<string, ProviderActivityState>> {
    const provider = await this.observed();
    if (provider) return provider.activityBatch(sessionIds);
    return new Map(sessionIds.map((id) => [id, "idle" as const]));
  }

  /** 2.x events reach no observation hint yet, so its sessions keep the sweep at full cadence. */
  observationStreamLive(): boolean {
    return false;
  }

  // ── transcript and snapshots ───────────────────────────────────────────────

  async messages(sessionId: string, options: { limit?: number } = {}): Promise<unknown[]> {
    const provider = await this.required();
    const rows = (await provider.messages(sessionId, {
      limit: Math.min(
        options.limit ?? OPENCODE2_EVIDENCE_SCAN_LIMIT,
        OPENCODE2_EVIDENCE_SCAN_LIMIT,
      ),
    })) as OpenCode2Message[];
    return normalizeOpenCode2Transcript(rows);
  }

  async transcriptSnapshot(
    sessionId: string,
    options: Parameters<OpenCode2Provider["transcriptSnapshot"]>[1],
  ): Promise<ProviderTranscriptSnapshot | { unchanged: true; sourceToken: string }> {
    return (await this.required()).transcriptSnapshot(sessionId, options);
  }

  async transcriptPage(
    sessionId: string,
    options: Parameters<OpenCode2Provider["transcriptPage"]>[1],
  ): Promise<ProviderTranscriptPage | undefined> {
    return (await this.required()).transcriptPage(sessionId, options);
  }

  async interactiveSnapshot(sessionId: string): Promise<ProviderInteractiveSnapshot> {
    const provider = await this.required();
    const [{ messages, messagesComplete, ...state }, features] = await Promise.all([
      provider.interactiveState(sessionId),
      provider.features.sessionState(sessionId),
    ]);
    return { ...stateSnapshot(state, features), messages, messagesComplete };
  }

  async sessionStateSnapshot(sessionId: string): Promise<ProviderSessionStateSnapshot> {
    const provider = await this.required();
    const [state, features] = await Promise.all([
      provider.sessionState(sessionId),
      provider.features.sessionState(sessionId),
    ]);
    return stateSnapshot(state, features);
  }

  /** 2.x keeps the lifetime ledger on the session. */
  async refreshUsage(sessionId: string): Promise<NativeAgentContextUsage | undefined> {
    const provider = await this.observed();
    return provider ? provider.refreshUsage(sessionId) : undefined;
  }

  /** Every recent response's usage, for a settled turn; never starts a server. */
  async recentTurnUsage(sessionId: string): Promise<NativeAgentContextUsage | undefined> {
    const provider = await this.observed();
    return provider ? provider.recentTurnUsage(sessionId) : undefined;
  }

  async runtimeHealth(sessionId: string): Promise<ProviderRuntimeHealth> {
    // Health is optional: never start a server for it.
    const provider = await this.observed();
    if (!provider) return { summary: { state: "Not running" }, notices: [], authoritative: false };
    return provider.runtimeHealth(sessionId);
  }

  async structured<T>(
    sessionId: string,
    requestId: string,
  ): Promise<StructuredOutputResult<T> | null> {
    return (await this.required()).structured<T>(sessionId, requestId);
  }

  // ── catalogues ─────────────────────────────────────────────────────────────

  async modelCatalog(): Promise<AgentModel[]> {
    return (await (await this.required()).features.models.read()).models;
  }

  async connectedModelProviders(): Promise<string[] | undefined> {
    return (await (await this.required()).features.models.read()).connectedProviderIds;
  }

  /**
   * The unfiltered catalogue for the durable cache: no allowlist, so a later
   * allowlist change can be served before the server runs again.
   */
  async rawModelCatalog(): Promise<AgentModel[]> {
    return (await this.required()).rawModelCatalog();
  }

  async resolveDefaultModel(modelId: string | undefined) {
    return (await this.required()).features.resolveDefaultModel(modelId);
  }

  /** OpenCode 2's own conversations, under `opencode2:` ids. */
  async listResumableSessions(options?: { includeArchived?: boolean }) {
    return (await this.required()).listResumableSessions(options);
  }

  async setResumableSessionArchived(resumableSessionId: string, archived: boolean): Promise<void> {
    await (await this.required()).setResumableSessionArchived(resumableSessionId, archived);
  }

  refreshCatalog(): void {
    this.current?.provider.refreshCatalog();
  }

  /** A catalogue read is metadata: it never starts the server. */
  async commandCatalogue(_sessionId?: string): Promise<ProviderCommandCatalogue> {
    const provider = await this.observed();
    return provider
      ? provider.commandCatalogue()
      : { enhanced: true, commands: [], status: "stale" };
  }

  /**
   * The composer's explicit refresh. The server runs without file watchers
   * (`server.ts`), so a running location never re-reads command files added
   * or edited since it loaded; only a location reload does. An idle server is
   * reloaded first, under the same gate as an MCP reload (it cancels pending
   * permissions and forms, so never while any session on the server runs);
   * a busy one is only re-read and says so.
   */
  async refreshCommands(_sessionId?: string): Promise<ProviderCommandRefreshResult> {
    const provider = await this.required();
    // A coordinator's server offers no commands; nothing to reload for it.
    if (provider.coordinator) return provider.refreshCommands();
    const key = this.current?.gateKey;
    const reload = key
      ? await exclusiveOpenCode2Reload(key, async () => {
          if (await provider.serverBusy()) return "busy" as const;
          await provider.reloadLocations();
          return "reloaded" as const;
        })
      : ("busy" as const);
    const result = await provider.refreshCommands();
    if (result.outcome !== "reread") return result;
    return reload === "reloaded"
      ? { outcome: "reloaded" }
      : {
          outcome: "reread",
          message:
            "OpenCode is busy, so command files changed since it started may not be listed yet. Refresh again once its sessions are idle.",
        };
  }

  async slashCommands(sessionId?: string) {
    return (await this.commandCatalogue(sessionId)).commands;
  }

  /**
   * A settings edit to the user's MCP servers, applied to a running server:
   * its mirrored configuration is rewritten and every loaded location
   * rebuilt (`POST /api/location/reload`). That cancels pending permissions
   * and forms of every session on the server, and the server is shared with
   * the environment's other providers (pipelines, reviews, graphs, suborks).
   * So it runs under the server's reload gate (`reload-gate.ts`): `busy`
   * while any provider's dispatch is open or any session on the server has a
   * run, and no dispatch starts until it is done.
   */
  async reloadMcpConfiguration(): Promise<"reloaded" | "not-running" | "unsupported" | "busy"> {
    const connection = await this.deps.connection({ start: false });
    if (!connection) return "not-running";
    const provider = await this.observed();
    if (!provider) return "not-running";
    const refreshConfiguration = connection.refreshConfiguration?.bind(connection);
    if (!refreshConfiguration) return "unsupported";
    return exclusiveOpenCode2Reload(openCode2ReloadGateKey(connection), async () => {
      if (await provider.serverBusy()) return "busy" as const;
      await refreshConfiguration();
      await provider.reloadLocations();
      return "reloaded" as const;
    });
  }

  /** A catalogue read never starts the server. */
  async mcpServers(_sessionId: string) {
    const provider = await this.observed();
    return provider ? provider.mcpServers() : [];
  }

  async mcpServerAction(...args: Parameters<OpenCode2Provider["mcpServerAction"]>) {
    return (await this.required()).mcpServerAction(...args);
  }

  /** The running server's providers; without one, unknown rather than started for it. */
  async authStatus(_sessionId?: string): Promise<NativeAgentAuthStatus> {
    const provider = await this.observed();
    return provider ? provider.authStatus() : { state: "unknown" };
  }

  // ── session actions ────────────────────────────────────────────────────────

  async setSessionTitle(sessionId: string, title: string): Promise<void> {
    // The backend's title goes to OpenCode too, so its own lists agree.
    return (await this.required()).setSessionTitle(sessionId, title);
  }

  /** A session id, or an `opencode2:<id>` resume-list row. */
  async resumeSession(
    sessionId: string,
    _controls?: NativeAgentControlUpdate,
    _policy?: NativeAgentExecutionPolicy,
  ): Promise<string> {
    const resumed = await this.dispatching((provider) => provider.resumeSession(sessionId));
    this.liveSessions.add(resumed);
    return resumed;
  }

  async synchronizeSessionPolicy(
    sessionId: string,
    policy: NativeAgentExecutionPolicy,
  ): Promise<void> {
    // A coordinator's server applies its launch's rules and refuses any other policy.
    return (await this.required()).synchronizeSessionPolicy(sessionId, policy);
  }

  async forkSession(sessionId: string, messageId?: string): Promise<NativeAgentForkOutcome> {
    const outcome = await this.dispatching((provider) =>
      provider.forkSession(sessionId, messageId),
    );
    // The fork's tab resumes it by this id next.
    this.liveSessions.add(outcome.sessionId);
    return outcome;
  }

  async steerSupported(_sessionId: string): Promise<boolean> {
    return true;
  }

  async activeSteerRun(sessionId: string): Promise<ProviderActiveSteerRun> {
    return (await this.required()).activeSteerRun(sessionId);
  }

  async steerStatus(sessionId: string, requestId: string): Promise<ProviderSteerDispatchStatus> {
    return (await this.required()).steerStatus(sessionId, requestId);
  }

  async performSessionAction(
    sessionId: string,
    action: ProviderNativeAgentSessionAction,
  ): Promise<NativeAgentSessionActionOutcome> {
    // Compact, undo and redo start runs of their own.
    return this.dispatching((provider) => provider.performSessionAction(sessionId, action));
  }

  async abort(sessionId: string): Promise<void> {
    const provider = await this.observed();
    // No server running means no turn to stop.
    if (provider) await provider.abort(sessionId);
  }

  async closeSession(sessionId: string): Promise<void> {
    const provider = await this.observed();
    if (provider) await provider.closeSession(sessionId);
    this.liveSessions.delete(sessionId);
  }

  releaseSession(sessionId: string): void {
    this.liveSessions.delete(sessionId);
    this.current?.provider.releaseSession(sessionId);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const current = this.current;
    this.current = undefined;
    this.liveSessions.clear();
    if (current) await current.provider.dispose();
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** The connection's model and effort, for a request that names neither. */
  private withDefaults<T extends { model?: string; effort?: string }>(options: T): T {
    const defaults = this.deps.defaults;
    if (!defaults?.model || options.model) return options;
    return {
      ...options,
      model: defaults.model,
      ...(options.effort === undefined && defaults.effort ? { effort: defaults.effort } : {}),
    };
  }

  private async required(): Promise<OpenCode2Provider> {
    const provider = await this.serverProvider({ start: true });
    if (!provider) throw new ProviderUnavailableError("The OpenCode server is not running");
    return provider;
  }

  /**
   * Run `operation` as one dispatch on the server's reload gate, so it waits
   * out a configuration reload and holds the next one off while it runs.
   */
  private async dispatching<T>(operation: (provider: OpenCode2Provider) => Promise<T>): Promise<T> {
    const provider = await this.required();
    const key = this.current?.gateKey;
    if (!key) return operation(provider);
    return withinOpenCode2Dispatch(key, () => operation(provider));
  }

  private observed(): Promise<OpenCode2Provider | undefined> {
    return this.serverProvider({ start: false });
  }

  private async serverProvider(options: {
    start: boolean;
  }): Promise<OpenCode2Provider | undefined> {
    if (this.disposed) throw new ProviderUnavailableError("OpenCode provider was disposed");
    const connection = await this.deps.connection(options);
    if (!connection) return undefined;
    if (this.disposed) throw new ProviderUnavailableError("OpenCode provider was disposed");
    if (this.current?.generation === connection.generation) return this.current.provider;
    const previous = this.current;
    const client = new OpenCode2Client(connection);
    const allowedModelProviders = this.deps.allowedModelProviders?.bind(this.deps);
    const workerMailbox = this.deps.workerMailbox;
    const provider =
      this.deps.createProvider?.(client, connection) ??
      new OpenCode2Provider(client, {
        ...(allowedModelProviders ? { allowedModelProviders } : {}),
        ...(workerMailbox ? { workerMailbox } : {}),
        ...(connection.coordinator ? { coordinator: connection.coordinator } : {}),
      });
    this.current = {
      generation: connection.generation,
      gateKey: openCode2ReloadGateKey(connection),
      provider,
    };
    for (const sessionId of this.liveSessions) provider.registerSession(sessionId);
    if (previous) {
      void Promise.resolve(previous.provider.dispose()).catch((error: unknown) => {
        log.debug("provider.dispose-failed", { error: formatLogError(error, { message: false }) });
      });
    }
    return provider;
  }
}

function emptyInteractionSnapshot(): AgentInteractionSnapshot {
  return { version: AGENT_INTERACTION_CONTRACT_VERSION, revision: 0, requests: [] };
}

/**
 * A session's state as the shared snapshot. A parked permission or form
 * reads `blocked`, and its card comes from `interactions`.
 */
function stateSnapshot(
  state: OpenCode2SessionState,
  features: Awaited<ReturnType<OpenCode2Provider["features"]["sessionState"]>>,
): ProviderSessionStateSnapshot {
  // The run's own state (`reads.ts`) first; the session features add the
  // composer (2.x catalogue, effort, mode), title and resume id on top.
  const { notices: featureNotices, ...rest } = features;
  const notices = [...(state.notices ?? []), ...featureNotices];
  return {
    ...state,
    ...rest,
    capabilityLimits: OPENCODE2_CAPABILITY_LIMITS,
    ...(notices.length > 0 ? { notices } : {}),
  };
}

function carriesRequest(row: OpenCode2Message, requestId: string): boolean {
  const orkestrator = (row.metadata as { orkestrator?: { requestId?: unknown } } | undefined)
    ?.orkestrator;
  return orkestrator?.requestId === requestId;
}

/**
 * The failure of one request's run, read from the run boundary after its
 * input: `null` for a run that succeeded (or a request not in the scanned
 * history), the user's stop for an interrupted one. Throws while the run has
 * not settled, so an early idle read is never taken as success.
 */
export function openCode2TurnTerminalError(
  rows: readonly OpenCode2Message[],
  requestId: string,
): string | null {
  const start = rows.findIndex((row) => carriesRequest(row, requestId));
  if (start < 0) return null;
  for (const row of rows.slice(start + 1)) {
    if (!isOpenCode2IdleMessage(row)) continue;
    if (row.outcome === "succeeded") return null;
    if (row.outcome === "interrupted") return TURN_STOPPED_BY_USER_MESSAGE;
    return "OpenCode 2 reported that the turn failed";
  }
  throw new ProviderUnavailableError("The OpenCode 2 turn has not settled yet");
}
