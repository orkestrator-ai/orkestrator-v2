/**
 * The OpenCode session provider for one server generation
 * (docs/todo/agent-engines/0008-opencode-v2.md). `OpenCodeEnvironmentProvider`
 * (`environment-provider.ts`) builds one per server and hands it every call.
 *
 * It drives OpenCode 2's `opencode serve` through {@link OpenCode2Client},
 * covering the session contract and steering:
 *
 * - **Dispatch evidence lives in the input.** Every prompt and steer carries
 *   `metadata.orkestrator.requestId`, which 2.x echoes on the user row (and on
 *   a still-pending inbox item). `dispatchStatus`/`steerStatus` answer
 *   `dispatched` only on that evidence, `absent` only after a definitive 4xx
 *   refusal this process saw, and `unknown` otherwise. An ambiguous attempt is
 *   never re-posted here.
 * - **Activity comes from one cheap read.** `GET /api/session/active` names
 *   every running session, so the activity sweep never reads histories. A run
 *   waiting on a permission or form reads as `waiting`.
 * - **Steer.** A run is identified by the newest `idle` row before it (the
 *   snapshot's run boundary). A steer aimed at a run that has already
 *   settled answers `idle`/`mismatch` before anything is sent; the backend
 *   then delivers it as a new turn. A steer that loses the race after the
 *   check is still delivered once: 2.x starts a new run with it.
 * - **Close never deletes.** It interrupts, rejects parked permissions and
 *   forms, and forgets the session; the conversation stays in OpenCode.
 * - **Orkestrator's tools, results and read-only turns** (phase 5) are in
 *   `workflow-results.ts`: the tab's MCP connection and the workflow-result
 *   broker are location MCP servers (`mcp.ts`), confined to their session by
 *   its permission rules, and a read-only or result turn's rules are granted
 *   under the session's dispatch lock and restored after (`turn-grants.ts`).
 *
 * Models and effort, attachments, slash commands, Plan/Build, compact,
 * undo/redo, fork, the resume list, titles, to-dos and sign-in status live in
 * {@link OpenCode2SessionFeatures} (`features.ts`); transcript, state, usage
 * and interaction cards in `reads.ts`; MCP, workflow results and read-only
 * turns in `workflow-results.ts`. This provider delegates to them.
 */
import type { StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import type {
  AgentModel,
  NativeAgentAuthStatus,
  NativeAgentForkOutcome,
  NativeAgentMcpServer,
  NativeAgentMcpServerAction,
  NativeAgentSessionActionOutcome,
} from "@orkestrator/protocol/native-agent";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import {
  AmbiguousPromptDispatchError,
  PromptRejectedError,
  ProviderUnavailableError,
  ProviderSessionFailedError,
  TURN_STOPPED_BY_USER_MESSAGE,
  type NativeAgentRuntimeProvider,
  type ProviderActiveSteerRun,
  type ProviderActivityState,
  type ProviderCommandCatalogue,
  type ProviderCommandRefreshResult,
  type ProviderCreateSessionOptions,
  type ProviderDispatchStatus,
  type ProviderNativeAgentSessionAction,
  type ProviderPrepareDispatchOptions,
  type ProviderReadOptions,
  type ProviderRuntimeHealth,
  type ProviderSendOptions,
  type ProviderSessionRegistration,
  type ProviderStatus,
  type ProviderSteerDispatchStatus,
} from "../agent-provider-contract.js";
import { OpenCode2Client, OpenCode2RequestError } from "./client.js";
import { readOpenCode2ModelCatalogue } from "./models.js";
import { attachOpenCode2Instructions } from "./instructions.js";
import { noteOpenCode2LocationsReloaded } from "./reload-gate.js";
import { OpenCode2SequenceTracker, readOpenCode2Events } from "./events.js";
import {
  OPENCODE2_EVENT_STREAM_SILENCE_MS,
  OpenCodeStreamSilenceWatchdog,
  type OpenCodeSilenceClock,
} from "./stream-silence.js";
import { OpenCode2SessionReads, openCode2EventSessionId } from "./reads.js";
import { OpenCode2McpServers, openCode2ConfiguredUserMcpServers } from "./mcp.js";
import { openCode2CreateRules, openCode2PolicyRules } from "./permissions.js";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import { OpenCode2TurnGrants, openCode2CreateMetadata } from "./turn-grants.js";
import { OpenCode2WorkflowTurns, openCode2StructuredResult } from "./workflow-results.js";
import { OpenCode2SessionFeatures, type OpenCode2PreparedSend } from "./features.js";
import { openCode2ResumeSessionId } from "./sessions.js";
import { openCode2TurnConnections, type OpenCode2WorkerMailbox } from "./turn-connections.js";
import {
  OPENCODE2_COORDINATOR_AGENT,
  OpenCode2CoordinatorSessions,
  type OpenCode2CoordinatorAuthority,
} from "./coordinator.js";
import { checkOpenCode2Admission, mintOpenCode2InputId, newestOpenCode2IdleId } from "./steer.js";
import type { OpenCode2InboxItem, OpenCode2Message, OpenCode2ModelRef } from "./types.js";

const log = createLogger("native-agent.opencode2");

/** Newest rows read when looking for a request's evidence or the run boundary. */
export const OPENCODE2_EVIDENCE_SCAN_LIMIT = 200;
/** Remembered definitive refusals, so `dispatchStatus` can answer `absent`. */
const MAX_REFUSED_REQUESTS = 512;
/** How long an activity read may be served from cache when no event arrived. */
const ACTIVITY_CACHE_MS = 2_000;
const MAX_TEXT_BYTES = 1024 * 1024;

export interface OpenCode2ProviderDependencies {
  /** Overrides the event-stream retry delay (tests). */
  monitorRetryMs?: number;
  /**
   * Longest silence the event monitor accepts once its stream has sent a
   * heartbeat (`OPENCODE2_EVENT_STREAM_SILENCE_MS` by default).
   */
  monitorSilenceMs?: number;
  /** Test seam for the silence watchdog's clock and timers. */
  monitorClock?: OpenCodeSilenceClock;
  /** Disable the live event monitor (tests that only exercise reads). */
  monitorEvents?: boolean;
  now?: () => number;
  /** MCP registration timing (tests). */
  mcp?: ConstructorParameters<typeof OpenCode2McpServers>[1];
  /** The user's `openCodeModelProviders`, normalized; shapes the 2.x model picker. */
  allowedModelProviders?: () => Promise<readonly string[]>;
  /** A pipeline worker's own mailbox connection, for a turn with `workerMail`. */
  workerMailbox?: OpenCode2WorkerMailbox;
  /**
   * Present when this server is a coordinator's (`coordinator.ts`): what it
   * was launched with, which every session on it runs under.
   */
  coordinator?: OpenCode2CoordinatorAuthority;
}

type SessionState = {
  /** Live hint: a durable event arrived since the last authoritative read. */
  dirty: boolean;
};

/** `provider/model`, split on the first slash only (OpenRouter ids contain their own). */
export function parseOpenCode2Model(modelId: string | undefined): OpenCode2ModelRef | undefined {
  if (!modelId) return undefined;
  const slash = modelId.indexOf("/");
  if (slash <= 0 || slash === modelId.length - 1) return undefined;
  return { providerID: modelId.slice(0, slash), id: modelId.slice(slash + 1) };
}

export class OpenCode2Provider implements NativeAgentRuntimeProvider {
  readonly agent = "opencode" as const;
  private readonly sessions = new Map<string, SessionState>();
  private readonly refused = new Map<string, true>();
  private readonly tracker = new OpenCode2SequenceTracker();
  /** Models, commands, attachments, actions and session lifecycle (`features.ts`). */
  readonly features: OpenCode2SessionFeatures;
  private readonly monitor = new AbortController();
  private readonly monitorTask: Promise<void> | undefined;
  private activityCache: { at: number; running: ReadonlySet<string> } | undefined;
  private disposed = false;
  /** The event stream is open now, so a change reaches the read side as a hint. */
  private streamConnected = false;
  /** Transcript, state, usage and interaction cards (`reads.ts`). */
  readonly reads: OpenCode2SessionReads;
  readonly interactions: OpenCode2SessionReads["interactions"];
  /** MCP connections, per-turn grants and workflow results (`workflow-results.ts`). */
  private readonly workflow: OpenCode2WorkflowTurns;
  private readonly grants: OpenCode2TurnGrants;
  /** A coordinator's server: its rules, tools, agent and commands (`coordinator.ts`). */
  readonly coordinator: OpenCode2CoordinatorSessions | undefined;

  constructor(
    private readonly client: OpenCode2Client,
    private readonly dependencies: OpenCode2ProviderDependencies = {},
  ) {
    this.reads = new OpenCode2SessionReads(client, () => this.streamConnected);
    this.interactions = this.reads.interactions;
    const mcp = new OpenCode2McpServers(client, dependencies.mcp);
    const coordinator = dependencies.coordinator
      ? new OpenCode2CoordinatorSessions(client, mcp, dependencies.coordinator)
      : undefined;
    this.coordinator = coordinator;
    this.grants = new OpenCode2TurnGrants(
      client,
      coordinator ? { rules: () => coordinator.rules() } : undefined,
    );
    this.workflow = new OpenCode2WorkflowTurns(mcp, this.grants);
    this.features = new OpenCode2SessionFeatures(client, {
      now: () => this.now(),
      ...(dependencies.allowedModelProviders
        ? { allowedModelProviders: dependencies.allowedModelProviders }
        : {}),
    });
    if (dependencies.monitorEvents !== false) this.monitorTask = this.watchEvents();
  }

  registerSession(sessionId: string, registration?: ProviderSessionRegistration): void {
    if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, { dirty: true });
    this.reads.register(sessionId, registration);
  }

  releaseSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.features.forget(sessionId);
    this.tracker.forget(sessionId);
    this.reads.forget(sessionId);
  }

  async createSession(
    phase: string,
    label: string,
    options: ProviderCreateSessionOptions = {},
  ): Promise<string> {
    const model = await this.features.createModel(options);
    // A backend execution policy becomes the session's base rules
    // (`permissions.ts`), with a deny for every user MCP server its selection
    // leaves out; on a coordinator's server the launch's rules do.
    this.coordinator?.assertPolicy(options.policy);
    const base = this.coordinator
      ? await this.coordinator.rules()
      : openCode2PolicyRules(
          options.policy,
          await openCode2ConfiguredUserMcpServers(this.client, options.policy),
        );
    const reviewer = !this.coordinator && options.reviewerSession && options.policy;
    let session;
    try {
      session = await this.client.createSession({
        ...(model ? { model } : {}),
        ...(this.coordinator ? { agent: OPENCODE2_COORDINATOR_AGENT } : {}),
        metadata: openCode2CreateMetadata({
          phase,
          label,
          base,
          ...(reviewer ? { reviewerPolicy: options.policy } : {}),
        }),
        permissions: openCode2CreateRules(base),
      });
    } catch (error) {
      if (error instanceof OpenCode2RequestError) throw new PromptRejectedError(error.message);
      throw new ProviderUnavailableError("OpenCode 2.x session could not be created", {
        cause: error,
      });
    }
    this.features.noteCreated(session.id, model, options);
    // A coordinator's server runs the read-only policy: no shared instructions.
    if (!this.coordinator)
      await attachOpenCode2Instructions(this.client, session.id, options.policy);
    this.registerSession(session.id);
    return session.id;
  }

  /** Registers the turn's MCP connections before the at-most-once window. */
  async prepareDispatch(
    sessionId: string,
    options: ProviderPrepareDispatchOptions = {},
  ): Promise<void> {
    if (this.coordinator) {
      await this.coordinator.prepare();
      return;
    }
    await this.workflow.prepare(sessionId, options);
  }

  async send(sessionId: string, prompt: string, requested: ProviderSendOptions): Promise<void> {
    // A coordinator turn runs as `plan`, with its own tools and no command.
    const shaped = this.coordinator ? this.coordinator.sendOptions(requested) : requested;
    // Artifact grant, worker and tab mail as connections (`turn-connections.ts`).
    const options = await openCode2TurnConnections(
      shaped,
      this.coordinator ? undefined : this.dependencies.workerMailbox,
    );
    const text = boundedText(this.workflow.shapePrompt(prompt, options));
    this.registerSession(sessionId);
    if (this.coordinator) await this.coordinator.prepare();
    await this.workflow.prepare(sessionId, options);
    // Command resolution, files, model, effort and agent; nothing is dispatched yet.
    const prepared = await this.features.prepareSend(sessionId, prompt, options);
    await this.coordinator?.pinAgent(sessionId);
    // Grants, the prompt and settlement of one session never interleave.
    await this.workflow.dispatch(
      sessionId,
      options,
      () =>
        prepared.kind === "command"
          ? this.dispatchCommand(sessionId, prepared, options)
          : this.dispatchPrompt(sessionId, text, options, prepared.files),
      () => this.rememberRefusal(options.requestId),
    );
  }

  private async dispatchCommand(
    sessionId: string,
    prepared: Extract<OpenCode2PreparedSend, { kind: "command" }>,
    options: ProviderSendOptions,
  ): Promise<void> {
    try {
      await this.features.sendCommand(sessionId, prepared);
    } catch (error) {
      if (error instanceof PromptRejectedError) this.rememberRefusal(options.requestId);
      throw error;
    } finally {
      this.markDirty(sessionId);
    }
  }

  private async dispatchPrompt(
    sessionId: string,
    text: string,
    options: ProviderSendOptions,
    files: OpenCode2PreparedSend["files"],
  ): Promise<void> {
    const id = mintOpenCode2InputId(this.now());
    let answer: unknown;
    try {
      // `queue` runs after a run in progress instead of entering it mid-step;
      // on an idle session it starts a run (observed on 2.2.6).
      answer = await this.client.prompt(sessionId, {
        id,
        text,
        ...(files ? { files } : {}),
        delivery: "queue",
        metadata: { orkestrator: { requestId: options.requestId } },
      });
    } catch (error) {
      if (error instanceof OpenCode2RequestError) {
        this.rememberRefusal(options.requestId);
        throw new PromptRejectedError(`OpenCode refused the prompt: ${error.message}`);
      }
      throw new AmbiguousPromptDispatchError("OpenCode 2.x prompt dispatch is unconfirmed", {
        cause: error,
      });
    }
    const admission = checkOpenCode2Admission(answer, { id, text });
    if (admission.kind === "conflict") {
      throw new PromptRejectedError("OpenCode already holds different input under this id");
    }
    if (admission.kind === "unrecognized") {
      throw new AmbiguousPromptDispatchError(
        "OpenCode 2.x answered the prompt with an unknown shape",
      );
    }
    this.markDirty(sessionId);
  }

  async dispatchStatus(sessionId: string, requestId: string): Promise<ProviderDispatchStatus> {
    if (await this.hasEvidence(sessionId, requestId)) return "dispatched";
    return this.refused.has(requestId) ? "absent" : "unknown";
  }

  async steerStatus(sessionId: string, requestId: string): Promise<ProviderSteerDispatchStatus> {
    if (await this.hasEvidence(sessionId, requestId)) return "dispatched";
    return this.refused.has(requestId) ? "absent" : "unknown";
  }

  async status(sessionId: string): Promise<ProviderStatus> {
    const activity = await this.activity(sessionId);
    if (activity === "missing") return "missing";
    if (activity === "waiting") return "blocked";
    if (activity === "working") return "running";
    const session = await this.client.getSession(sessionId).catch((error: unknown) => {
      if (error instanceof OpenCode2RequestError && error.status === 404) return undefined;
      throw error;
    });
    if (!session) return "missing";
    if (session.outcome === "failed" || session.outcome === "interrupted") {
      const state = await this.reads.sessionState(sessionId, "idle");
      throw new ProviderSessionFailedError("opencode", state.error ?? TURN_STOPPED_BY_USER_MESSAGE);
    }
    return "idle";
  }

  private async lifecycleStatus(sessionId: string): Promise<ProviderStatus> {
    try {
      return await this.status(sessionId);
    } catch (error) {
      if (error instanceof ProviderSessionFailedError) return "idle";
      throw error;
    }
  }

  async activity(sessionId: string): Promise<ProviderActivityState> {
    return (await this.activityBatch([sessionId])).get(sessionId) ?? "missing";
  }

  /** One `/api/session/active` read for every session; never touches histories. */
  async activityBatch(sessionIds: readonly string[]): Promise<Map<string, ProviderActivityState>> {
    const running = await this.runningSessions(sessionIds);
    const result = new Map<string, ProviderActivityState>();
    for (const sessionId of sessionIds) {
      if (!running.has(sessionId)) {
        result.set(sessionId, "idle");
        continue;
      }
      const waiting = await this.waitingOnUser(sessionId).catch(() => false);
      result.set(sessionId, waiting ? "waiting" : "working");
    }
    return result;
  }

  /** The newest rows, oldest first, without what a staged Undo covers (`revert.ts`). */
  async messages(sessionId: string, options: { limit?: number } = {}): Promise<unknown[]> {
    return (
      await this.features.visibleHistory(sessionId, options.limit ?? OPENCODE2_EVIDENCE_SCAN_LIMIT)
    ).rows;
  }

  // ── reads (`reads.ts`) ─────────────────────────────────────────────────────

  transcriptSnapshot(...args: Parameters<OpenCode2SessionReads["transcriptSnapshot"]>) {
    return this.reads.transcriptSnapshot(...args);
  }

  transcriptPage(...args: Parameters<OpenCode2SessionReads["transcriptPage"]>) {
    return this.reads.transcriptPage(...args);
  }

  /** Status, usage, model and terminal outcome; never the transcript. */
  async sessionState(sessionId: string) {
    return this.reads.sessionState(sessionId, await this.lifecycleStatus(sessionId));
  }

  /** {@link sessionState} plus the newest normalized rows. */
  async interactiveState(sessionId: string) {
    return this.reads.interactive(sessionId, await this.lifecycleStatus(sessionId));
  }

  refreshUsage(sessionId: string) {
    return this.reads.usage(sessionId);
  }

  /** A `schema` turn's parsed final answer, once its run has settled. */
  async structured<T>(
    sessionId: string,
    requestId: string,
  ): Promise<StructuredOutputResult<T> | null> {
    return openCode2StructuredResult<T>(
      await this.history(sessionId, OPENCODE2_EVIDENCE_SCAN_LIMIT),
      requestId,
    );
  }

  /** Restores a finished request's turn grant; false while its run is still going. */
  settleTurn(sessionId: string, requestId: string): Promise<boolean> {
    return this.workflow.settleTurn(sessionId, requestId, () =>
      this.history(sessionId, OPENCODE2_EVIDENCE_SCAN_LIMIT),
    );
  }

  /** The user's MCP servers on this location; Orkestrator's own are not listed. */
  mcpServers(
    _sessionId?: string,
    options: ProviderReadOptions = {},
  ): Promise<NativeAgentMcpServer[]> {
    return this.workflow.mcpServers(options.signal);
  }

  mcpServerAction(_sessionId: string, serverId: string, action: NativeAgentMcpServerAction) {
    return this.workflow.mcpServerAction(serverId, action);
  }

  async abort(sessionId: string): Promise<void> {
    try {
      await this.client.interrupt(sessionId, { resume: false });
    } catch (error) {
      if (error instanceof OpenCode2RequestError && error.status === 404) return;
      throw new ProviderUnavailableError("OpenCode 2.x interrupt failed", { cause: error });
    } finally {
      this.markDirty(sessionId);
    }
    try {
      // Whichever turn held a grant (read-only, result tools) no longer does.
      await this.workflow.afterAbort(sessionId);
    } finally {
      await this.rejectPendingRequests(sessionId);
    }
  }

  /** Stop owned work and forget the session. Never deletes the conversation. */
  async closeSession(sessionId: string): Promise<void> {
    try {
      await this.abort(sessionId);
    } finally {
      await this.workflow.closeSession(sessionId);
      this.releaseSession(sessionId);
    }
  }

  async steerSupported(): Promise<boolean> {
    return true;
  }

  async activeSteerRun(sessionId: string): Promise<ProviderActiveSteerRun> {
    let running: ReadonlySet<string>;
    try {
      running = await this.runningSessions([sessionId], true);
    } catch {
      return { state: "unknown" };
    }
    if (!running.has(sessionId)) return { state: "idle" };
    try {
      return { state: "running", runId: await this.currentRunId(sessionId) };
    } catch {
      return { state: "unknown" };
    }
  }

  async performSessionAction(
    sessionId: string,
    action: ProviderNativeAgentSessionAction,
  ): Promise<NativeAgentSessionActionOutcome> {
    if (action.kind !== "steer") {
      try {
        return await this.features.performAction(sessionId, action);
      } finally {
        this.markDirty(sessionId);
      }
    }
    const text = boundedText(action.text);
    const current = await this.activeSteerRun(sessionId);
    if (current.state === "idle") return { outcome: "idle" };
    if (current.state !== "running") {
      throw new ProviderUnavailableError("OpenCode 2.x run state is unavailable");
    }
    if (current.runId !== action.expectedRunId) return { outcome: "mismatch" };
    const id = mintOpenCode2InputId(this.now());
    let answer: unknown;
    try {
      answer = await this.client.prompt(sessionId, {
        id,
        text,
        delivery: "steer",
        metadata: { orkestrator: { requestId: action.requestId, steer: true } },
      });
    } catch (error) {
      if (error instanceof OpenCode2RequestError) {
        this.rememberRefusal(action.requestId);
        throw new PromptRejectedError(`OpenCode refused the steer: ${error.message}`);
      }
      log.warn("steer.unconfirmed", { error: formatLogError(error, { message: false }) });
      return { outcome: "unknown", requestId: action.requestId };
    } finally {
      this.markDirty(sessionId);
    }
    const admission = checkOpenCode2Admission(answer, { id, text });
    if (admission.kind === "admitted") return { outcome: "applied", requestId: action.requestId };
    if (admission.kind === "conflict") {
      throw new PromptRejectedError("OpenCode already holds different input under this id");
    }
    return { outcome: "unknown", requestId: action.requestId };
  }

  // ── session features (`features.ts`) ───────────────────────────────────────

  async forkSession(sessionId: string, messageId?: string): Promise<NativeAgentForkOutcome> {
    const outcome = await this.features.fork(sessionId, messageId);
    if (this.coordinator) {
      const forked = outcome.sessionId;
      await this.grants.runExclusive(forked, () => this.grants.restate(forked));
    }
    this.registerSession(outcome.sessionId);
    return outcome;
  }

  listResumableSessions(options?: { includeArchived?: boolean }) {
    return this.features.listResumable(options);
  }

  /**
   * The resume picker's remove/restore. A conversation this server still holds
   * for a tab or a run is refused, as Codex and Cursor refuse one (409): 2.x
   * would go on accepting turns for it while the picker reports it archived.
   * Restoring is always allowed.
   */
  async setResumableSessionArchived(resumableSessionId: string, archived: boolean): Promise<void> {
    const sessionId = openCode2ResumeSessionId(resumableSessionId) ?? resumableSessionId;
    await this.grants.runExclusive(sessionId, async () => {
      if (archived && this.sessions.has(sessionId)) {
        throw new PromptRejectedError("This conversation is open in a tab");
      }
      await this.features.setArchived(resumableSessionId, archived);
    });
  }

  /**
   * A resume-list id (or a bare 2.x id) as the session it names, checked to
   * exist. On a coordinator's server the launch's rules are restated first.
   */
  async resumeSession(resumableSessionId: string): Promise<string> {
    const key = openCode2ResumeSessionId(resumableSessionId) ?? resumableSessionId;
    return this.grants.runExclusive(key, async () => {
      const sessionId = await this.features.resumableSession(resumableSessionId);
      if (this.coordinator) await this.grants.restate(sessionId);
      // A conversation from before the instructions entry existed gets it now.
      else await attachOpenCode2Instructions(this.client, sessionId);
      this.registerSession(sessionId);
      return sessionId;
    });
  }

  /**
   * Restate a session's execution policy. On a coordinator's server the
   * launch's rules apply and any other policy is refused; elsewhere the
   * policy becomes the session's base rules.
   */
  async synchronizeSessionPolicy(
    sessionId: string,
    policy: NativeAgentExecutionPolicy,
  ): Promise<void> {
    if (this.coordinator) {
      this.coordinator.assertPolicy(policy);
      await this.grants.runExclusive(sessionId, () => this.grants.restate(sessionId));
      return;
    }
    const base = openCode2PolicyRules(policy);
    await this.grants.runExclusive(sessionId, () => this.grants.rebase(sessionId, base));
  }

  setSessionTitle(sessionId: string, title: string): Promise<void> {
    return this.features.setTitle(sessionId, title);
  }

  authStatus(): Promise<NativeAgentAuthStatus> {
    return this.features.authStatus();
  }

  /** A coordinator runs no provider command (`coordinator.ts`), so it lists none. */
  async commandCatalogue(): Promise<ProviderCommandCatalogue> {
    if (this.coordinator) return { enhanced: true, commands: [], status: "unsupported" };
    return this.features.commandCatalogue();
  }

  async refreshCommands(): Promise<ProviderCommandRefreshResult> {
    if (this.coordinator) return { outcome: "unsupported" };
    return this.features.refreshCommands();
  }

  async slashCommands() {
    return (await this.commandCatalogue()).commands;
  }

  runtimeHealth(sessionId: string): Promise<ProviderRuntimeHealth> {
    return this.features.runtimeHealth(sessionId);
  }

  refreshCatalog(): void {
    this.features.refreshCatalog();
  }

  /** The unfiltered catalogue (no allowlist), for the durable cache. */
  async rawModelCatalog(): Promise<AgentModel[]> {
    return (await readOpenCode2ModelCatalogue(this.client, [])).models;
  }

  /**
   * Whether any session on this server has a run in progress, whichever
   * provider owns it: a tab's, a pipeline's, a review's or one no provider in
   * this backend registered. A parked permission or form belongs to a run, so
   * it reads busy too. One fresh `/api/session/active` read, never the cache.
   */
  async serverBusy(): Promise<boolean> {
    const running = await this.client.activeSessions();
    this.activityCache = { at: this.now(), running };
    return running.size > 0;
  }

  /**
   * Rebuild every loaded location, so the server reads its configuration
   * again (`POST /api/location/reload`). It cancels pending permissions and
   * forms; callers reload only an idle server. It also drops the runtime MCP
   * servers every provider registered, which the next turn re-registers
   * (`mcp.ts`).
   */
  async reloadLocations(): Promise<void> {
    try {
      await this.client.api("POST", "/api/location/reload", "OpenCode configuration reload", {
        signal: AbortSignal.timeout(30_000),
      });
      // The reload answers before the location is rebuilt, and a catalogue
      // read in between answers an empty command list (seen on 2.2.6), which
      // would be cached as the truth. The agent list waits for the rebuilt
      // location, so the gate is held until reads see its new state.
      await this.client
        .api("GET", "/api/agent", "OpenCode agent list", { signal: AbortSignal.timeout(30_000) })
        .catch((error: unknown) => {
          log.debug("location.reload-unconfirmed", {
            error: formatLogError(error, { message: false }),
          });
        });
    } finally {
      // Even an ambiguous failure may have rebuilt the location and dropped
      // every runtime MCP server on it: no provider trusts its registrations.
      noteOpenCode2LocationsReloaded(this.client.baseUrl);
    }
    this.refreshCatalog();
  }

  observationStreamLive(): boolean {
    return this.monitorTask !== undefined && !this.monitor.signal.aborted;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.monitor.abort();
    await this.monitorTask?.catch(() => undefined);
    this.sessions.clear();
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private now(): number {
    return this.dependencies.now?.() ?? Date.now();
  }

  /** Oldest first, every row: the evidence scans must see a staged revert's rows too. */
  private async history(sessionId: string, limit: number): Promise<OpenCode2Message[]> {
    let page;
    try {
      page = await this.client.listMessages(sessionId, { limit, order: "desc" });
    } catch (error) {
      if (error instanceof OpenCode2RequestError && error.status === 404) return [];
      throw error;
    }
    return [...page.messages].reverse();
  }

  private async currentRunId(sessionId: string): Promise<string> {
    const anchor = newestOpenCode2IdleId(
      await this.history(sessionId, OPENCODE2_EVIDENCE_SCAN_LIMIT),
    );
    return `${sessionId}:${anchor ?? "start"}`;
  }

  private async hasEvidence(sessionId: string, requestId: string): Promise<boolean> {
    const [rows, inbox] = await Promise.all([
      this.history(sessionId, OPENCODE2_EVIDENCE_SCAN_LIMIT),
      this.client.listInbox(sessionId).catch((): OpenCode2InboxItem[] => []),
    ]);
    return (
      rows.some((row) => carriesRequest(row.metadata, requestId)) ||
      inbox.some((item) => carriesRequest(item.payload?.metadata, requestId))
    );
  }

  private async waitingOnUser(sessionId: string): Promise<boolean> {
    const [permissions, forms] = await Promise.all([
      this.client.listPermissions(sessionId),
      this.client.listForms(sessionId),
    ]);
    return permissions.length > 0 || forms.length > 0;
  }

  /** Approvals and questions deny on the way out (AGENTS.md invariant 10). */
  private async rejectPendingRequests(sessionId: string): Promise<void> {
    const [permissions, forms] = await Promise.all([
      this.client.listPermissions(sessionId).catch(() => []),
      this.client.listForms(sessionId).catch(() => []),
    ]);
    await Promise.all([
      ...permissions.map((request) =>
        this.client.replyPermission(sessionId, request.id, "reject").catch(() => undefined),
      ),
      ...forms.map((form) =>
        this.client.rejectForm(sessionId, form.id, "The turn was stopped.").catch(() => undefined),
      ),
    ]);
  }

  private async runningSessions(
    sessionIds: readonly string[],
    fresh = false,
  ): Promise<ReadonlySet<string>> {
    const cached = this.activityCache;
    const anyDirty = sessionIds.some((id) => this.sessions.get(id)?.dirty !== false);
    if (
      !fresh &&
      cached &&
      !anyDirty &&
      this.observationStreamLive() &&
      this.now() - cached.at < ACTIVITY_CACHE_MS
    ) {
      return cached.running;
    }
    const running = await this.client.activeSessions();
    this.activityCache = { at: this.now(), running };
    for (const id of sessionIds) {
      const state = this.sessions.get(id);
      if (state) state.dirty = false;
    }
    return running;
  }

  private markDirty(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state) state.dirty = true;
    this.activityCache = undefined;
  }

  private rememberRefusal(requestId: string): void {
    this.refused.set(requestId, true);
    while (this.refused.size > MAX_REFUSED_REQUESTS) {
      this.refused.delete(this.refused.keys().next().value!);
    }
  }

  /**
   * Live events only mark sessions dirty; reads stay authoritative. A dropped
   * stream, a sequence gap or an oversized frame marks everything dirty so the
   * next read goes to the server.
   *
   * A stream that stays open but goes quiet is a loss too: while it counts as
   * connected the transcript may answer "unchanged" without a read. Each
   * connection gets a silence watchdog, armed by the server's first
   * `: heartbeat` comment and fed by every chunk read, that aborts the
   * connection onto the same loss path (to-do 7559, retired; see
   * recurring-work.md B22). It is stopped whenever the connection ends
   * (AGENTS.md invariant 15).
   */
  private async watchEvents(): Promise<void> {
    const retryMs = this.dependencies.monitorRetryMs ?? 1_000;
    while (!this.disposed) {
      const connection = new AbortController();
      const abortConnection = () => connection.abort();
      this.monitor.signal.addEventListener("abort", abortConnection, { once: true });
      const watchdog = new OpenCodeStreamSilenceWatchdog(
        (silenceMs) => {
          log.warn("monitor.silent", { silenceMs });
          connection.abort();
        },
        {
          silenceMs: this.dependencies.monitorSilenceMs ?? OPENCODE2_EVENT_STREAM_SILENCE_MS,
          ...(this.dependencies.monitorClock ? { clock: this.dependencies.monitorClock } : {}),
        },
      );
      try {
        const body = await this.client.openEvents(connection.signal);
        // Whatever changed while the stream was down was never hinted.
        this.reads.transcript.invalidateAll(true);
        this.streamConnected = true;
        await readOpenCode2Events(
          body,
          (signal) => {
            if (signal.kind === "desync") {
              this.reads.transcript.invalidateAll(true);
              return this.markAllDirty();
            }
            const sessionId = openCode2EventSessionId(signal.event);
            if (!sessionId || !this.sessions.has(sessionId)) return;
            const durable = signal.event.durable;
            if (durable && this.tracker.note(sessionId, durable.seq) === "gap") {
              this.reads.transcript.invalidate(sessionId);
            }
            this.reads.observe(sessionId, signal.event);
            if (durable) this.markDirty(sessionId);
          },
          connection.signal,
          (heartbeat) => watchdog.frame(heartbeat),
        );
      } catch (error) {
        if (this.disposed) return;
        log.debug("events.dropped", { error: formatLogError(error, { message: false }) });
      } finally {
        watchdog.stop();
        this.monitor.signal.removeEventListener("abort", abortConnection);
        this.streamConnected = false;
      }
      this.reads.transcript.invalidateAll(true);
      this.markAllDirty();
      if (this.disposed) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, retryMs);
        this.monitor.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }
  }

  private markAllDirty(): void {
    for (const state of this.sessions.values()) state.dirty = true;
    this.activityCache = undefined;
  }
}

function carriesRequest(metadata: unknown, requestId: string): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  const orkestrator = (metadata as { orkestrator?: unknown }).orkestrator;
  return (
    !!orkestrator &&
    typeof orkestrator === "object" &&
    (orkestrator as { requestId?: unknown }).requestId === requestId
  );
}

function boundedText(text: string): string {
  if (!text.trim()) throw new PromptRejectedError("The prompt is empty");
  if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
    throw new PromptRejectedError("The prompt exceeds OpenCode 2.x's 1 MB input bound");
  }
  return text;
}
