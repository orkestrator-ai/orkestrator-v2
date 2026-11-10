/**
 * The `opencode` provider of an interactive native session, routed per
 * session between OpenCode 1.x and 2.x
 * (docs/todo/agent-engines/0008-opencode-v2.md, build plan phase 3).
 *
 * The provider registry caches one provider per (environment, agent), and
 * both lines mint `ses_…` ids, so neither the cache key nor the id can pick a
 * line. This provider holds the 1.x {@link OpenCodeProvider} and a lazily
 * built {@link OpenCode2Provider}, and sends each session to one of them:
 *
 * - **By the record, never by guess.** A session is 2.x when it was created
 *   here with `openCodeProtocol: "v2"`, registered with that marker, or its
 *   persisted record carries it (looked up once, on first use). A workflow
 *   provider (build pipelines, Multi Review, graphs) picks the line itself
 *   through `newSessionProtocol` and records it (`recordSession`, the
 *   `opencode2-sessions` store) before handing the id out. Everything
 *   else is 1.x, so every existing session stays where it is. A failed lookup
 *   is an error, not "1.x": routing a 2.x session to 1.x would read it as
 *   missing, and a missing session is replaced.
 * - **The 2.x server starts only on demand.** Observers (`activity`,
 *   `activityBatch`, `observationStreamLive`) never start it; a 2.x session
 *   with no server running has no turn in flight and reads idle, the way a
 *   bridge that is not running does. A replaced server (new port or
 *   password) gets a new 2.x provider; the old one is disposed.
 * - **No 1.x behaviour reaches a 2.x session.** Members the 2.x provider does
 *   not have answer what an absent capability would (empty catalogues) or
 *   refuse with a clear error. Transcript windows and pages, session state,
 *   usage and interaction cards (`reads.ts`), MCP, workflow results and
 *   read-only turns, and the session features (models, commands, revert,
 *   fork, resume; `features.ts`) are the 2.x provider's own. Snapshots carry
 *   `capabilityLimits`, which the projection uses to narrow a 2.x tab to what
 *   its session offers.
 *
 * Catalogue members with no session (models, sign-in, MCP reload, change
 * evidence) stay on 1.x: the lines share `provider/model` ids, and a 2.x
 * session's composer carries its own server's catalogue. The resume list
 * holds both lines, 2.x rows under `opencode2:` ids, and the sign-in status of
 * a 2.x session is its server's.
 */
import {
  AGENT_INTERACTION_CONTRACT_VERSION,
  type AgentInteractionSnapshot,
} from "@orkestrator/protocol/agent-interactions";
import { idleSteerPromptReply } from "@orkestrator/protocol/agent-slash-commands";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import {
  type AgentModel,
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
import type { OpenCodeProvider } from "../opencode-provider.js";
import { OpenCode2Client, type OpenCode2Connection } from "./client.js";
import { OPENCODE2_EVIDENCE_SCAN_LIMIT, OpenCode2Provider } from "./provider.js";
import type { OpenCode2SessionState } from "./session-state.js";
import type { OpenCode2CoordinatorAuthority } from "./coordinator.js";
import { openCode2ResumeSessionId } from "./sessions.js";
import type { OpenCode2WorkerMailbox } from "./turn-connections.js";
import { normalizeOpenCode2Transcript } from "./transcript.js";
import { isOpenCode2IdleMessage, type OpenCode2Message } from "./types.js";

const log = createLogger("native-agent.opencode2");

type Line = "legacy" | "v2";

/** Sessions whose line is remembered; older entries are looked up again. */
const MAX_ROUTED_SESSIONS = 4_096;

/**
 * What a 2.x session does not offer; the projection narrows its capabilities
 * by it. Compact, undo, redo, fork, attachments and slash commands work on
 * 2.x (`features.ts`); OpenCode's platform table offers neither share nor
 * message rewind, which stay listed so a later table change cannot widen a
 * 2.x tab by accident.
 */
export const OPENCODE2_CAPABILITY_LIMITS: ProviderCapabilityLimits = {
  withoutActions: ["rewindMessages", "share"],
};

/** One 2.x server generation: a new port or password is a new generation. */
export interface OpenCode2RouteConnection extends OpenCode2Connection {
  generation: string;
  /**
   * Set when the server is a coordinator's: the policy and research it was
   * launched with, which every session on it runs under (`coordinator.ts`).
   */
  coordinator?: OpenCode2CoordinatorAuthority;
}

export interface OpenCodeRoutingDependencies {
  /**
   * The environment's 2.x server. `start: false` never spawns one and answers
   * undefined when none is running; `start: true` starts it or throws.
   */
  connection(options: { start: boolean }): Promise<OpenCode2RouteConnection | undefined>;
  /** The persisted marker of a session this provider has not seen yet. */
  persistedProtocol(sessionId: string): Promise<"v2" | undefined>;
  /**
   * Workflow providers only (build pipelines, Multi Review, graphs): which
   * line a new session takes when the caller does not say. Absent for the
   * interactive service, whose unmarked sessions are always 1.x.
   */
  newSessionProtocol?(options: ProviderCreateSessionOptions): Promise<"v2" | undefined>;
  /**
   * Durably record a session {@link newSessionProtocol} put on 2.x, so
   * {@link persistedProtocol} answers `"v2"` for it from then on. Required
   * with `newSessionProtocol`; a failure refuses the session.
   */
  recordSession?(sessionId: string): Promise<void>;
  /** Builds the 2.x provider for one server generation (tests substitute it). */
  createProvider?(client: OpenCode2Client, connection: OpenCode2RouteConnection): OpenCode2Provider;
  /** The user's `openCodeModelProviders`, normalized; shapes the 2.x model picker. */
  allowedModelProviders?(): Promise<readonly string[]>;
  /**
   * Whether new sessions take 2.x (the preview setting). The resume list
   * starts the 2.x server to list its sessions only then; otherwise it lists
   * them only while a 2.x server is already running.
   */
  newSessionsUseV2?(): Promise<boolean>;
  /**
   * Workflow providers only: a pipeline worker's own mailbox connection, for
   * a 2.x turn that carries `workerMail` (`turn-connections.ts`).
   */
  workerMailbox?: OpenCode2WorkerMailbox;
}

/** The members the router reads from the 1.x provider. */
type LegacyOpenCodeProvider = OpenCodeProvider;

export class OpenCodeRoutingProvider implements NativeAgentRuntimeProvider {
  readonly agent = "opencode" as const;
  readonly usageMessageLimit: number | undefined;
  readonly messageReadLimit: number | undefined;
  private readonly liveV2Sessions = new Set<string>();
  private readonly lines = new Map<string, Line>();
  private readonly lookups = new Map<string, Promise<Line>>();
  private current: { generation: string; provider: OpenCode2Provider } | undefined;
  private disposed = false;

  readonly interactions: AgentInteractionProviderCapability;

  constructor(
    private readonly legacy: LegacyOpenCodeProvider,
    private readonly deps: OpenCodeRoutingDependencies,
  ) {
    this.usageMessageLimit = legacy.usageMessageLimit;
    this.messageReadLimit = legacy.messageReadLimit;
    const legacyInteractions = legacy.interactions;
    this.interactions = {
      // Observers: a 2.x session with no server running has nothing pending.
      listPendingInteractions: async (sessionId) => {
        if ((await this.lineOf(sessionId)) !== "v2") {
          return legacyInteractions.listPendingInteractions(sessionId);
        }
        const provider = await this.observedV2();
        return provider
          ? provider.interactions.listPendingInteractions(sessionId)
          : emptyInteractionSnapshot();
      },
      resolveInteraction: async (sessionId, interactionId, resolution) => {
        if ((await this.lineOf(sessionId)) !== "v2") {
          return legacyInteractions.resolveInteraction(sessionId, interactionId, resolution);
        }
        const provider = await this.observedV2();
        // No server, no run: whatever the card showed is gone.
        if (!provider) return { result: "stale", sessionId, interactionId, revision: 0 };
        return provider.interactions.resolveInteraction(sessionId, interactionId, resolution);
      },
      // Synchronous by contract: a session whose line is not known yet has
      // listed nothing here, so it has no detail to give.
      permissionRuleDetail: (sessionId: string, interactionId: string) => {
        const line = this.lines.get(sessionId);
        if (line === "v2") {
          return (
            this.current?.provider.interactions.permissionRuleDetail(sessionId, interactionId) ??
            null
          );
        }
        if (line !== "legacy") return null;
        return legacyInteractions.permissionRuleDetail?.(sessionId, interactionId) ?? null;
      },
    } satisfies AgentInteractionProviderCapability;
  }

  /** Which line serves a session, as far as this provider has recorded it (tests, diagnostics). */
  knownLine(sessionId: string): Line | undefined {
    return this.lines.get(sessionId);
  }

  // ── registration and creation ──────────────────────────────────────────────

  registerSession(sessionId: string, interaction?: ProviderSessionRegistration): void {
    if (interaction?.openCodeProtocol === "v2") this.remember(sessionId, "v2");
    const known = this.lines.get(sessionId);
    if (known) {
      this.registerOn(known, sessionId, interaction);
      return;
    }
    // Registered once the record says which line it is. A later call on the
    // session waits on the same lookup, so it runs after this registration.
    void this.lineOf(sessionId).then(
      (line) => this.registerOn(line, sessionId, interaction),
      () => undefined,
    );
  }

  async createSession(
    phase: string,
    label: string,
    options: ProviderCreateSessionOptions = {},
  ): Promise<string> {
    // The interactive service decides per request; a workflow provider asks its
    // own policy (`newSessionProtocol`) and records the answer itself.
    const chosenHere = options.openCodeProtocol === undefined && !!this.deps.newSessionProtocol;
    const protocol =
      options.openCodeProtocol ??
      (await this.deps.newSessionProtocol?.(options).catch((error: unknown) => {
        log.debug("protocol.select-failed", { error: formatLogError(error, { message: false }) });
        return undefined;
      }));
    if (protocol !== "v2") {
      const id = await this.legacy.createSession(phase, label, options);
      this.remember(id, "legacy");
      return id;
    }
    const provider = await this.requireV2();
    const id = await provider.createSession(phase, label, options);
    if (chosenHere) {
      // Recorded before the caller sees the id, so the run never changes line.
      // A session that could not be recorded is not handed out (it stays
      // unused in OpenCode, which is harmless).
      try {
        await this.deps.recordSession!(id);
      } catch (error) {
        throw new ProviderUnavailableError("The OpenCode 2 session could not be recorded", {
          cause: error,
        });
      }
    }
    this.liveV2Sessions.add(id);
    this.remember(id, "v2");
    return id;
  }

  async prepareDispatch(sessionId: string, options?: ProviderPrepareDispatchOptions) {
    if ((await this.lineOf(sessionId)) === "v2") {
      // The cold start (spawn and readiness) and the MCP registrations belong
      // before the at-most-once window.
      return (await this.requireV2()).prepareDispatch(sessionId, options);
    }
    return this.legacy.prepareDispatch(sessionId, options);
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
    if ((await this.lineOf(sessionId)) === "v2") {
      return (await this.requireV2()).send(sessionId, prompt, options);
    }
    return this.legacy.send(sessionId, prompt, options);
  }

  async dispatchStatus(sessionId: string, requestId: string): Promise<ProviderDispatchStatus> {
    if ((await this.lineOf(sessionId)) === "v2") {
      return (await this.requireV2()).dispatchStatus(sessionId, requestId);
    }
    return this.legacy.dispatchStatus(sessionId, requestId);
  }

  async settleTurn(sessionId: string, requestId: string): Promise<boolean> {
    if ((await this.lineOf(sessionId)) === "v2") {
      // The grant lives in the session, so restoring it needs the server.
      return (await this.requireV2()).settleTurn(sessionId, requestId);
    }
    return this.legacy.settleTurn(sessionId, requestId);
  }

  async turnTerminalError(sessionId: string, requestId: string): Promise<string | null> {
    if ((await this.lineOf(sessionId)) !== "v2") {
      return this.legacy.turnTerminalError(sessionId, requestId);
    }
    const provider = await this.requireV2();
    const rows = (await provider.messages(sessionId, {
      limit: OPENCODE2_EVIDENCE_SCAN_LIMIT,
    })) as OpenCode2Message[];
    return openCode2TurnTerminalError(rows, requestId);
  }

  // ── lifecycle reads ────────────────────────────────────────────────────────

  async status(sessionId: string): Promise<ProviderStatus> {
    if ((await this.lineOf(sessionId)) === "v2") {
      return (await this.requireV2()).status(sessionId);
    }
    return this.legacy.status(sessionId);
  }

  async activity(sessionId: string): Promise<ProviderActivityState> {
    if ((await this.lineOf(sessionId)) !== "v2") return this.legacy.activity(sessionId);
    const provider = await this.observedV2();
    return provider ? provider.activity(sessionId) : "idle";
  }

  async activityBatch(sessionIds: readonly string[]): Promise<Map<string, ProviderActivityState>> {
    const lines = await Promise.all(sessionIds.map((id) => this.lineOf(id)));
    const legacyIds = sessionIds.filter((_, index) => lines[index] === "legacy");
    const v2Ids = sessionIds.filter((_, index) => lines[index] === "v2");
    const result = new Map<string, ProviderActivityState>();
    if (legacyIds.length > 0) {
      for (const [id, state] of await this.legacy.activityBatch(legacyIds)) result.set(id, state);
    }
    if (v2Ids.length > 0) {
      const provider = await this.observedV2();
      if (provider) {
        for (const [id, state] of await provider.activityBatch(v2Ids)) result.set(id, state);
      } else {
        for (const id of v2Ids) result.set(id, "idle");
      }
    }
    return result;
  }

  /**
   * Live only while every known session is reported by a live stream. 2.x
   * events reach no observation hint yet, so a 2.x session keeps the sweep
   * at its full cadence.
   */
  observationStreamLive(): boolean {
    for (const line of this.lines.values()) if (line === "v2") return false;
    return this.legacy.observationStreamLive();
  }

  usageFromMessages(messages: readonly unknown[]): NativeAgentContextUsage | undefined {
    return this.legacy.usageFromMessages(messages);
  }

  async humanPromptOutput(sessionId: string) {
    if ((await this.lineOf(sessionId)) === "v2") return null;
    return this.legacy.humanPromptOutput(sessionId);
  }

  // ── transcript and snapshots ───────────────────────────────────────────────

  async messages(sessionId: string, options: { limit?: number } = {}): Promise<unknown[]> {
    if ((await this.lineOf(sessionId)) !== "v2") return this.legacy.messages(sessionId, options);
    return normalizeOpenCode2Transcript(await this.v2Rows(sessionId, options.limit));
  }

  async transcriptSnapshot(
    sessionId: string,
    options: Parameters<LegacyOpenCodeProvider["transcriptSnapshot"]>[1],
  ): Promise<ProviderTranscriptSnapshot | { unchanged: true; sourceToken: string }> {
    if ((await this.lineOf(sessionId)) !== "v2") {
      return this.legacy.transcriptSnapshot(sessionId, options);
    }
    return (await this.requireV2()).transcriptSnapshot(sessionId, options);
  }

  async transcriptPage(
    sessionId: string,
    options: Parameters<LegacyOpenCodeProvider["transcriptPage"]>[1],
  ): Promise<ProviderTranscriptPage | undefined> {
    if ((await this.lineOf(sessionId)) === "v2") {
      return (await this.requireV2()).transcriptPage(sessionId, options);
    }
    return this.legacy.transcriptPage(sessionId, options);
  }

  async interactiveSnapshot(sessionId: string): Promise<ProviderInteractiveSnapshot> {
    if ((await this.lineOf(sessionId)) !== "v2") return this.legacy.interactiveSnapshot(sessionId);
    const provider = await this.requireV2();
    const [{ messages, messagesComplete, ...state }, features] = await Promise.all([
      provider.interactiveState(sessionId),
      provider.features.sessionState(sessionId),
    ]);
    return { ...v2StateSnapshot(state, features), messages, messagesComplete };
  }

  async sessionStateSnapshot(sessionId: string): Promise<ProviderSessionStateSnapshot> {
    if ((await this.lineOf(sessionId)) !== "v2") return this.legacy.sessionStateSnapshot(sessionId);
    const provider = await this.requireV2();
    const [state, features] = await Promise.all([
      provider.sessionState(sessionId),
      provider.features.sessionState(sessionId),
    ]);
    return v2StateSnapshot(state, features);
  }

  /** 2.x keeps the lifetime ledger on the session; 1.x reports usage on its snapshots. */
  async refreshUsage(sessionId: string): Promise<NativeAgentContextUsage | undefined> {
    if ((await this.lineOf(sessionId)) !== "v2") return undefined;
    const provider = await this.observedV2();
    return provider ? provider.refreshUsage(sessionId) : undefined;
  }

  async runtimeHealth(sessionId: string): Promise<ProviderRuntimeHealth> {
    if ((await this.lineOf(sessionId)) !== "v2") return this.legacy.runtimeHealth(sessionId);
    // Health is optional: never start a server for it.
    const provider = await this.observedV2();
    if (!provider) {
      return { summary: { state: "OpenCode 2 preview" }, notices: [], authoritative: false };
    }
    return provider.runtimeHealth(sessionId);
  }

  async structured<T>(
    sessionId: string,
    requestId: string,
  ): Promise<StructuredOutputResult<T> | null> {
    if ((await this.lineOf(sessionId)) === "v2") {
      return (await this.requireV2()).structured<T>(sessionId, requestId);
    }
    return this.legacy.structured<T>(sessionId, requestId);
  }

  // ── catalogues ─────────────────────────────────────────────────────────────
  // Session-free model reads stay on 1.x: launch surfaces read them before a
  // session (and its line) exists, and both lines share `provider/model` ids.
  // A 2.x session's composer carries its own server's catalogue instead.

  modelCatalog(): Promise<AgentModel[]> {
    return this.legacy.modelCatalog();
  }

  connectedModelProviders(): Promise<string[] | undefined> {
    return this.legacy.connectedModelProviders();
  }

  /** A new 2.x session's default comes from 2.x's own catalogue, not 1.x's. */
  async resolveDefaultModel(modelId: string | undefined, options?: { openCodeProtocol?: "v2" }) {
    if (options?.openCodeProtocol === "v2") {
      return (await this.requireV2()).features.resolveDefaultModel(modelId);
    }
    return this.legacy.resolveDefaultModel(modelId);
  }

  rawModelCatalog(): Promise<AgentModel[]> {
    return this.legacy.rawModelCatalog();
  }

  /**
   * Both lines' conversations. 2.x rows carry `opencode2:` ids, so a resume
   * finds its line from the id alone, after a restart too. The 2.x server is
   * started for the list only while new sessions take 2.x; a 2.x list that
   * fails leaves the 1.x list standing.
   */
  async listResumableSessions(options?: { includeArchived?: boolean }) {
    const [legacy, v2] = await Promise.all([
      this.legacy.listResumableSessions(),
      this.v2ForLists()
        .then((provider) => (provider ? provider.listResumableSessions(options) : []))
        .catch((error: unknown) => {
          log.debug("resume-list.unavailable", {
            error: formatLogError(error, { message: false }),
          });
          return [];
        }),
    ]);
    return [...legacy, ...v2];
  }

  async setResumableSessionArchived(resumableSessionId: string, archived: boolean): Promise<void> {
    if (!openCode2ResumeSessionId(resumableSessionId)) {
      throw new PromptRejectedError("OpenCode 1 sessions cannot be archived here");
    }
    await (await this.requireV2()).setResumableSessionArchived(resumableSessionId, archived);
  }

  refreshCatalog(): void {
    this.legacy.refreshCatalog();
    this.current?.provider.refreshCatalog();
  }

  async commandCatalogue(sessionId?: string): Promise<ProviderCommandCatalogue> {
    if (sessionId && (await this.lineOf(sessionId)) === "v2") {
      // A catalogue read is metadata: it never starts the 2.x server.
      const provider = await this.observedV2();
      return provider
        ? provider.commandCatalogue()
        : { enhanced: true, commands: [], status: "stale" };
    }
    return this.legacy.commandCatalogue();
  }

  async refreshCommands(sessionId?: string): Promise<ProviderCommandRefreshResult> {
    if (sessionId && (await this.lineOf(sessionId)) === "v2") {
      return (await this.requireV2()).refreshCommands();
    }
    return this.legacy.refreshCommands();
  }

  async slashCommands(sessionId?: string) {
    if (sessionId && (await this.lineOf(sessionId)) === "v2") {
      return (await this.commandCatalogue(sessionId)).commands;
    }
    return this.legacy.slashCommands();
  }

  async mcpServers(sessionId: string) {
    if ((await this.lineOf(sessionId)) === "v2") {
      // A catalogue read never starts the 2.x server.
      const provider = await this.observedV2();
      return provider ? provider.mcpServers() : [];
    }
    return this.legacy.mcpServers();
  }

  async mcpServerAction(...args: Parameters<LegacyOpenCodeProvider["mcpServerAction"]>) {
    if ((await this.lineOf(args[0])) === "v2") {
      return (await this.requireV2()).mcpServerAction(...args);
    }
    return this.legacy.mcpServerAction(...args);
  }

  reloadMcpConfiguration(): Promise<"reloaded" | "busy"> {
    return this.legacy.reloadMcpConfiguration();
  }

  /**
   * The sign-in status of the line a session runs on: a 2.x session reports
   * its server's providers, which come from the 2.x database. Without a
   * session, or a 2.x server not running, it is 1.x's.
   */
  async authStatus(sessionId?: string) {
    if (sessionId && (await this.lineOf(sessionId)) === "v2") {
      const provider = await this.observedV2();
      if (provider) return provider.authStatus();
    }
    return this.legacy.authStatus();
  }

  changeEvidenceSource(environmentId: string) {
    return this.legacy.changeEvidenceSource(environmentId);
  }

  // ── session actions ────────────────────────────────────────────────────────

  async setSessionTitle(sessionId: string, title: string): Promise<void> {
    // The backend's title goes to OpenCode too, so its own lists agree.
    if ((await this.lineOf(sessionId)) === "v2") {
      return (await this.requireV2()).setSessionTitle(sessionId, title);
    }
    return this.legacy.setSessionTitle(sessionId, title);
  }

  /**
   * `opencode2:<id>` (a 2.x resume-list row) resumes on 2.x whatever this
   * provider remembers; anything else follows the session's recorded line.
   */
  async resumeSession(
    sessionId: string,
    controls?: NativeAgentControlUpdate,
    policy?: NativeAgentExecutionPolicy,
  ): Promise<string> {
    const listed = openCode2ResumeSessionId(sessionId);
    if (!listed && (await this.lineOf(sessionId)) !== "v2") {
      return this.legacy.resumeSession(sessionId, controls, policy);
    }
    const provider = await this.requireV2();
    const resumed = await provider.resumeSession(sessionId);
    this.liveV2Sessions.add(resumed);
    this.remember(resumed, "v2");
    return resumed;
  }

  /** `"v2"` for a session this provider routes to 2.x, so its record keeps the marker. */
  async sessionProtocol(sessionId: string): Promise<"v2" | undefined> {
    return (await this.lineOf(sessionId)) === "v2" ? "v2" : undefined;
  }

  async synchronizeSessionPolicy(
    sessionId: string,
    policy: NativeAgentExecutionPolicy,
  ): Promise<void> {
    if ((await this.lineOf(sessionId)) === "v2") {
      // A coordinator's server applies its launch's rules and refuses any other policy.
      return (await this.requireV2()).synchronizeSessionPolicy(sessionId, policy);
    }
    return this.legacy.synchronizeSessionPolicy(sessionId, policy);
  }

  async forkSession(sessionId: string, messageId?: string): Promise<NativeAgentForkOutcome> {
    if ((await this.lineOf(sessionId)) === "v2") {
      const outcome = await (await this.requireV2()).forkSession(sessionId, messageId);
      // The fork's tab resumes it by this id next; it is a 2.x session too.
      this.liveV2Sessions.add(outcome.sessionId);
      this.remember(outcome.sessionId, "v2");
      return outcome;
    }
    return this.legacy.forkSession(sessionId, messageId);
  }

  async steerSupported(sessionId: string): Promise<boolean> {
    return (await this.lineOf(sessionId)) === "v2";
  }

  async activeSteerRun(sessionId: string): Promise<ProviderActiveSteerRun> {
    if ((await this.lineOf(sessionId)) !== "v2") return { state: "unknown" };
    return (await this.requireV2()).activeSteerRun(sessionId);
  }

  async steerStatus(sessionId: string, requestId: string): Promise<ProviderSteerDispatchStatus> {
    if ((await this.lineOf(sessionId)) !== "v2") return "unknown";
    return (await this.requireV2()).steerStatus(sessionId, requestId);
  }

  async performSessionAction(
    sessionId: string,
    action: ProviderNativeAgentSessionAction,
  ): Promise<NativeAgentSessionActionOutcome> {
    if ((await this.lineOf(sessionId)) === "v2") {
      return (await this.requireV2()).performSessionAction(sessionId, action);
    }
    if (action.kind === "steer") {
      throw new PromptRejectedError("OpenCode 1 sessions cannot be steered");
    }
    return this.legacy.performSessionAction(sessionId, action);
  }

  async abort(sessionId: string): Promise<void> {
    if ((await this.lineOf(sessionId)) !== "v2") return this.legacy.abort(sessionId);
    const provider = await this.observedV2();
    // No 2.x server running means no turn to stop.
    if (provider) await provider.abort(sessionId);
  }

  async closeSession(sessionId: string): Promise<void> {
    if ((await this.lineOf(sessionId)) !== "v2") return this.legacy.closeSession(sessionId);
    const provider = await this.observedV2();
    if (provider) await provider.closeSession(sessionId);
    this.liveV2Sessions.delete(sessionId);
  }

  releaseSession(sessionId: string): void {
    this.liveV2Sessions.delete(sessionId);
    const line = this.lines.get(sessionId);
    this.lines.delete(sessionId);
    this.lookups.delete(sessionId);
    if (line === "v2") this.current?.provider.releaseSession(sessionId);
    else this.legacy.releaseSession(sessionId);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const current = this.current;
    this.current = undefined;
    this.liveV2Sessions.clear();
    this.lines.clear();
    this.lookups.clear();
    await Promise.all([
      this.legacy.dispose(),
      current ? current.provider.dispose() : Promise.resolve(),
    ]);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private remember(sessionId: string, line: Line): void {
    this.lines.delete(sessionId);
    this.lines.set(sessionId, line);
    while (this.lines.size > MAX_ROUTED_SESSIONS) {
      const oldest = this.lines.keys().next().value!;
      this.lines.delete(oldest);
    }
  }

  private registerOn(
    line: Line,
    sessionId: string,
    interaction: ProviderSessionRegistration | undefined,
  ): void {
    if (this.disposed) return;
    if (line === "legacy") this.legacy.registerSession(sessionId, interaction);
    else {
      this.liveV2Sessions.add(sessionId);
      this.current?.provider.registerSession(sessionId, interaction);
    }
  }

  private lineOf(sessionId: string): Promise<Line> {
    const known = this.lines.get(sessionId);
    if (known) return Promise.resolve(known);
    const pending = this.lookups.get(sessionId);
    if (pending) return pending;
    const lookup = this.deps.persistedProtocol(sessionId).then(
      (protocol) => {
        const line: Line = protocol === "v2" ? "v2" : "legacy";
        if (this.lookups.get(sessionId) === lookup) {
          this.lookups.delete(sessionId);
          this.remember(sessionId, line);
        }
        return line;
      },
      (error: unknown) => {
        if (this.lookups.get(sessionId) === lookup) this.lookups.delete(sessionId);
        // Never "1.x by default": a 2.x session read on 1.x reads as missing.
        throw new ProviderUnavailableError("The OpenCode session's version could not be read", {
          cause: error,
        });
      },
    );
    this.lookups.set(sessionId, lookup);
    return lookup;
  }

  private async requireV2(): Promise<OpenCode2Provider> {
    const provider = await this.v2({ start: true });
    if (!provider) throw new ProviderUnavailableError("The OpenCode 2 server is not running");
    return provider;
  }

  private observedV2(): Promise<OpenCode2Provider | undefined> {
    return this.v2({ start: false });
  }

  private async v2(options: { start: boolean }): Promise<OpenCode2Provider | undefined> {
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
    this.current = { generation: connection.generation, provider };
    // Routing lookups are history, not evidence that a tab still holds an id.
    for (const sessionId of this.liveV2Sessions) provider.registerSession(sessionId);
    if (previous) {
      void Promise.resolve(previous.provider.dispose()).catch((error: unknown) => {
        log.debug("provider.dispose-failed", { error: formatLogError(error, { message: false }) });
      });
    }
    return provider;
  }

  private async v2Rows(sessionId: string, limit: number | undefined): Promise<OpenCode2Message[]> {
    const provider = await this.requireV2();
    return (await provider.messages(sessionId, {
      limit: Math.min(limit ?? OPENCODE2_EVIDENCE_SCAN_LIMIT, OPENCODE2_EVIDENCE_SCAN_LIMIT),
    })) as OpenCode2Message[];
  }

  /** The 2.x server for a list read: started only while new sessions take 2.x. */
  private async v2ForLists(): Promise<OpenCode2Provider | undefined> {
    const preferred = await this.deps.newSessionsUseV2?.().catch(() => false);
    return preferred ? this.requireV2() : this.observedV2();
  }
}

function emptyInteractionSnapshot(): AgentInteractionSnapshot {
  return { version: AGENT_INTERACTION_CONTRACT_VERSION, revision: 0, requests: [] };
}

/**
 * A 2.x session's state as the shared snapshot. A parked permission or form
 * reads `blocked`, and its card comes from `interactions`.
 */
function v2StateSnapshot(
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
