/**
 * `CodexEngine` over a persistent `codex app-server --stdio` child.
 *
 * Ties together the supervisor (process lifecycle + generations), the JSONL RPC
 * client (transport), the event reducer (protocol → engine events) and the
 * server-request router (never leave app-server waiting).
 *
 * Three properties are load-bearing:
 *
 *  1. **Notifications never block the transport.** The supervisor hands them to a
 *     per-thread serial queue; reduction and fan-out happen there, so a slow
 *     consumer on one thread cannot stall app-server's bounded outbound queue and
 *     take down every other thread in the environment.
 *
 *  2. **Interrupt is a lifecycle, not a boolean.** `turn/interrupt` only *asks*.
 *     The turn is not over until a terminal `turn/completed` arrives, so the
 *     engine exposes an explicit waiter with escalation instead of pretending the
 *     response means "stopped".
 *
 *  3. **Dispatch is at-most-once.** The browser's request id is forwarded as
 *     `clientUserMessageId`; after an ambiguous failure the engine reconciles
 *     against persisted turns rather than retrying blind.
 */
import {
  AppServerSupervisor,
  type AppServerHealth,
  type AppServerSupervisorOptions,
} from "../app-server/process-supervisor.js";
import { ServerRequestRouter } from "../app-server/server-request-router.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalResolution,
} from "../app-server/approvals.js";
import type {
  InteractionAnswer,
  InteractionRequest,
  InteractionResolution,
} from "../app-server/interactions.js";
import { reduceHistoricalTurns, reduceNotification } from "../app-server/event-reducer.js";
import { redactSecrets } from "../app-server/redaction.js";
import {
  AppServerRpcError,
  classifyDispatchFailure,
  isSafeToRetryImmediately,
  isUnmaterializedThreadError,
  toEngineError,
} from "../app-server/errors.js";
import { reconcileFromThreadTurns, type ReconciliationOutcome } from "../sessions/dispatch-journal.js";
import {
  APP_SERVER_CAPABILITIES,
  type CodexEngine,
  type EngineCapabilities,
  type EngineError,
  type EngineEvent,
  type EngineEventListener,
  type EngineGeneration,
  type EngineInfo,
  type EngineModel,
  type EngineThread,
  type EngineThreadTurn,
  type EngineTurn,
  type EngineTurnConfig,
  type EngineUserInput,
  type ListThreadsOptions,
  type ListThreadsResult,
  type ReadThreadOptions,
  type ResumeThreadOptions,
  type StartThreadOptions,
  type StartTurnOptions,
} from "./types.js";

/**
 * Root source kinds Orkestrator threads can have.
 *
 * `thread/list` defaults to *interactive* kinds when `sourceKinds` is omitted,
 * which hides both legacy `exec` threads (created by the SDK engine) and new
 * `appServer` ones — silently emptying the resume dialog. Verified live in
 * `app-server/live-contract.test.ts`.
 *
 * Sub-agent kinds are excluded on purpose: they are children, not conversations
 * the user picks from history.
 */
export const ROOT_THREAD_SOURCE_KINDS = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  "unknown",
] as const;

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function optionalPublicString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? redactSecrets(value).slice(0, 1_000)
    : undefined;
}

function allowlistToolInventory(value: unknown): Record<string, unknown> {
  const source = objectRecord(value);
  const tools: Record<string, unknown> = {};
  for (const [name, candidate] of Object.entries(source)) {
    const tool = objectRecord(candidate);
    tools[name] = {
      ...(optionalPublicString(tool.description)
        ? { description: optionalPublicString(tool.description) }
        : {}),
      ...(optionalPublicString(tool.title) ? { title: optionalPublicString(tool.title) } : {}),
    };
  }
  return tools;
}

function allowlistRuntimeInventory(
  value: unknown,
  kind: "mcp" | "skills" | "hooks",
): { data: Record<string, unknown>[] } | { error: string } {
  const root = objectRecord(value);
  if (typeof root.error === "string") return { error: "Unavailable" };
  const data = Array.isArray(root.data) ? root.data : [];
  const allowed: Record<string, unknown>[] = [];
  for (const candidate of data) {
    const entry = objectRecord(candidate);
    if (kind === "mcp") {
      const name = optionalPublicString(entry.name);
      if (!name) continue;
      const serverInfo = objectRecord(entry.serverInfo);
      allowed.push({
        name,
        ...(optionalPublicString(entry.status)
          ? { status: optionalPublicString(entry.status) }
          : {}),
        ...(Object.keys(serverInfo).length > 0
          ? {
              serverInfo: {
                ...(optionalPublicString(serverInfo.name)
                  ? { name: optionalPublicString(serverInfo.name) }
                  : {}),
                ...(optionalPublicString(serverInfo.version)
                  ? { version: optionalPublicString(serverInfo.version) }
                  : {}),
              },
            }
          : {}),
        ...(entry.tools && typeof entry.tools === "object"
          ? { tools: allowlistToolInventory(entry.tools) }
          : {}),
      });
      continue;
    }

    if (kind === "skills") {
      const skills = Array.isArray(entry.skills) ? entry.skills : [];
      allowed.push({
        skills: skills.flatMap((candidateSkill) => {
          const skill = objectRecord(candidateSkill);
          const name = optionalPublicString(skill.name);
          if (!name) return [];
          const skillInterface = objectRecord(skill.interface);
          return [{
            name,
            ...(optionalPublicString(skill.description)
              ? { description: optionalPublicString(skill.description) }
              : {}),
            ...(optionalPublicString(skill.shortDescription)
              ? { shortDescription: optionalPublicString(skill.shortDescription) }
              : {}),
            ...(Object.keys(skillInterface).length > 0
              ? {
                  interface: {
                    ...(optionalPublicString(skillInterface.displayName)
                      ? { displayName: optionalPublicString(skillInterface.displayName) }
                      : {}),
                    ...(optionalPublicString(skillInterface.shortDescription)
                      ? { shortDescription: optionalPublicString(skillInterface.shortDescription) }
                      : {}),
                    ...(optionalPublicString(skillInterface.brandColor)
                      ? { brandColor: optionalPublicString(skillInterface.brandColor) }
                      : {}),
                  },
                }
              : {}),
            ...(optionalPublicString(skill.scope)
              ? { scope: optionalPublicString(skill.scope) }
              : {}),
            ...(typeof skill.enabled === "boolean" ? { enabled: skill.enabled } : {}),
          }];
        }),
      });
      continue;
    }

    const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
    allowed.push({
      hooks: hooks.flatMap((candidateHook) => {
        const hook = objectRecord(candidateHook);
        const key = optionalPublicString(hook.key);
        const eventName = optionalPublicString(hook.eventName);
        if (!key || !eventName) return [];
        return [{
          key,
          eventName,
          ...(optionalPublicString(hook.handlerType)
            ? { handlerType: optionalPublicString(hook.handlerType) }
            : {}),
          ...(optionalPublicString(hook.source)
            ? { source: optionalPublicString(hook.source) }
            : {}),
          ...(optionalPublicString(hook.pluginId)
            ? { pluginId: optionalPublicString(hook.pluginId) }
            : {}),
          ...(typeof hook.enabled === "boolean" ? { enabled: hook.enabled } : {}),
          ...(typeof hook.isManaged === "boolean" ? { isManaged: hook.isManaged } : {}),
          ...(optionalPublicString(hook.trustStatus)
            ? { trustStatus: optionalPublicString(hook.trustStatus) }
            : {}),
        }];
      }),
    });
  }
  return {
    data: allowed,
  };
}

function allowlistRateLimits(value: unknown): Record<string, unknown> | { error: string } {
  const response = objectRecord(value);
  if (typeof response.error === "string") return { error: "Unavailable" };
  const raw = objectRecord(response.rateLimits);
  const rateLimits: Record<string, unknown> = {};
  const limitName = optionalPublicString(raw.limitName);
  if (limitName) rateLimits.limitName = limitName;
  for (const key of ["primary", "secondary"] as const) {
    const window = objectRecord(raw[key]);
    const allowed: Record<string, number> = {};
    if (typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent)) {
      allowed.usedPercent = Math.max(0, Math.min(100, window.usedPercent));
    }
    if (typeof window.resetsAt === "number" && Number.isFinite(window.resetsAt)) {
      allowed.resetsAt = window.resetsAt;
    }
    if (
      typeof window.windowDurationMins === "number"
      && Number.isFinite(window.windowDurationMins)
      && window.windowDurationMins >= 0
    ) {
      allowed.windowDurationMins = window.windowDurationMins;
    }
    if (Object.keys(allowed).length > 0) rateLimits[key] = allowed;
  }
  return { rateLimits };
}

export interface AppServerEngineOptions {
  codexPath: string;
  cwd: string;
  codexHome: string;
  clientInfo: { name: string; title: string; version: string };
  configOverrides?: Record<string, string>;
  /** Escalation budget for a turn that will not stop. */
  interruptTimeoutMs?: number;
  /** How long a human has to answer an approval before it auto-denies. */
  approvalTimeoutMs?: number;
  now?: () => number;
  /**
   * Supervisor overrides forwarded verbatim.
   *
   * Deliberately *not* an injectable supervisor instance: the engine must always
   * own the `onNotification` / `onServerRequest` wiring, or a supplied supervisor
   * would silently disable event fan-out and server-request answering — which
   * would look like a hung turn rather than a wiring mistake.
   */
  supervisorOverrides?: Partial<
    Pick<
      AppServerSupervisorOptions,
      | "spawnProcess"
      | "refreshEnvironment"
      | "pidFileEnabled"
      | "backoffScheduleMs"
      | "shutdownGraceMs"
      | "circuitBreakerThreshold"
      | "circuitWindowMs"
    >
  >;
}

interface ThreadBinding {
  handle: string;
  threadId: string;
  config: EngineTurnConfig;
  generation: EngineGeneration;
}

interface TerminalWaiter {
  resolve: (status: "completed" | "interrupted" | "failed") => void;
  turnId: string;
}

interface RuntimeNotice {
  method: string;
  message: string;
  receivedAt: string;
}

const DEFAULT_INTERRUPT_TIMEOUT_MS = 15_000;

export class AppServerEngine implements CodexEngine {
  readonly kind = "app-server" as const;
  readonly capabilities: EngineCapabilities = APP_SERVER_CAPABILITIES;

  private readonly supervisor: AppServerSupervisor;
  private readonly router: ServerRequestRouter;
  private readonly listeners = new Set<EngineEventListener>();
  /** handle → binding. For app-server the handle *is* the thread id. */
  private readonly bindings = new Map<string, ThreadBinding>();
  private readonly terminalWaiters = new Map<string, TerminalWaiter[]>();
  private readonly interruptTimeoutMs: number;
  private unknownNotificationCount = 0;
  private unsupportedItemCount = 0;
  private readonly runtimeNotices: RuntimeNotice[] = [];
  private approvalHandler?: (request: ApprovalRequest) => boolean;
  private approvalResolvedHandler?: (
    request: ApprovalRequest,
    decision: ApprovalDecision,
    resolution: ApprovalResolution,
  ) => void;
  private interactionHandler?: (request: InteractionRequest) => boolean;
  private interactionResolvedHandler?: (
    request: InteractionRequest,
    answer: InteractionAnswer,
    resolution: InteractionResolution,
  ) => void;

  constructor(private readonly options: AppServerEngineOptions) {
    this.interruptTimeoutMs = options.interruptTimeoutMs ?? DEFAULT_INTERRUPT_TIMEOUT_MS;

    this.supervisor = new AppServerSupervisor({
      codexPath: options.codexPath,
      cwd: options.cwd,
      codexHome: options.codexHome,
      clientInfo: options.clientInfo,
      configOverrides: options.configOverrides,
      now: options.now,
      ...(options.supervisorOverrides ?? {}),
      // Listed after the overrides so they can never be replaced: losing these
      // would mean silently dropping every event and hanging every turn.
      onNotification: (notification, threadId, generation) => {
        // Enqueue only — reduction happens on the per-thread drain so this
        // returns immediately and the transport never back-pressures.
        const key = threadId ?? "connection";
        this.supervisor.notificationQueue.run(key, () => {
          this.processNotification(notification, generation);
        });
      },
      onServerRequest: (request, generation) => this.router.handle(request, generation),
      onStateChange: (state, detail) =>
        this.emit({
          kind: "engine.state",
          state,
          detail,
          engineGeneration: this.supervisor.getGeneration(),
        }),
      onGenerationReady: (generation, previous) =>
        this.handleGenerationChange(generation, previous),
    });

    this.router = new ServerRequestRouter({
      respond: (generation, id, result) =>
        this.supervisor.respondToServerRequest(generation, id, result),
      respondWithError: (generation, id, code, message) =>
        this.supervisor.respondToServerRequestWithError(generation, id, code, message),
      reportToTranscript: ({ threadId, turnId, message }) => {
        // Surfaced as a non-fatal error event so the user sees why an action was
        // refused instead of watching the turn stall silently.
        this.emit({
          kind: "error",
          threadId,
          turnId: turnId ?? undefined,
          error: { message, code: "server-request-declined" },
          willRetry: false,
          engineGeneration: this.supervisor.getGeneration(),
        });
      },
      onInvariantViolation: () => this.supervisor.recordUnknownServerRequest(),
      onUnknownRequest: () => this.supervisor.recordUnknownServerRequest(),
      ...(options.approvalTimeoutMs === undefined
        ? {}
        : { approvalTimeoutMs: options.approvalTimeoutMs }),
      /**
       * Only claims the approval when a handler is installed *and* it accepts.
       * With no handler the router falls through to its auto-decline, which is the
       * pre-approval behaviour — so attaching a UI is purely additive.
       */
      presentApproval: (request) => this.approvalHandler?.(request) === true,
      onApprovalResolved: (request, decision, resolution) =>
        this.approvalResolvedHandler?.(request, decision, resolution),
      presentInteraction: (request) => this.interactionHandler?.(request) === true,
      onInteractionResolved: (request, answer, resolution) =>
        this.interactionResolvedHandler?.(request, answer, resolution),
    });
  }

  /**
   * Installs the approval surface.
   *
   * Kept as a setter rather than a constructor option because the runtime that
   * owns thread→session mapping is built *after* the engine, and it is the only
   * layer that can turn a threadId into something the UI can address.
   */
  setApprovalHandlers(handlers: {
    present: (request: ApprovalRequest) => boolean;
    resolved: (
      request: ApprovalRequest,
      decision: ApprovalDecision,
      resolution: ApprovalResolution,
    ) => void;
  }): void {
    this.approvalHandler = handlers.present;
    this.approvalResolvedHandler = handlers.resolved;
  }

  setInteractionHandlers(handlers: {
    present: (request: InteractionRequest) => boolean;
    resolved: (
      request: InteractionRequest,
      answer: InteractionAnswer,
      resolution: InteractionResolution,
    ) => void;
  }): void {
    this.interactionHandler = handlers.present;
    this.interactionResolvedHandler = handlers.resolved;
  }

  /** Applies a user's answer. False when the approval is already gone. */
  resolveApproval(approvalId: string, decision: ApprovalDecision): boolean {
    return this.router.resolveApproval(approvalId, decision);
  }

  getParkedApprovals(): readonly ApprovalRequest[] {
    return this.router.getParkedApprovals();
  }

  resolveInteraction(interactionId: string, answer: InteractionAnswer): boolean {
    return this.router.resolveInteraction(interactionId, answer);
  }

  getParkedInteractions(): readonly InteractionRequest[] {
    return this.router.getParkedInteractions();
  }

  /** Drops approvals for a thread that is being closed. */
  abandonThreadApprovals(threadId: string): void {
    this.router.abandonThread(threadId);
  }

  async start(): Promise<EngineInfo> {
    await this.supervisor.ensureReady();
    return this.info();
  }

  async stop(): Promise<void> {
    await this.supervisor.stop();
    this.bindings.clear();
    this.rejectAllWaiters();
  }

  info(): EngineInfo {
    const health = this.supervisor.getHealth();
    return {
      kind: this.kind,
      capabilities: this.capabilities,
      generation: health.generation,
      codexVersion: health.codexVersion,
      codexHome: health.codexHome,
      pid: health.pid ?? undefined,
    };
  }

  getHealth(): AppServerHealth & {
    unknownNotifications: number;
    unsupportedItems: number;
    serverRequests: ReturnType<ServerRequestRouter["getMetrics"]>;
  } {
    return {
      ...this.supervisor.getHealth(),
      unknownNotifications: this.unknownNotificationCount,
      unsupportedItems: this.unsupportedItemCount,
      serverRequests: this.router.getMetrics(),
    };
  }

  getSupervisor(): AppServerSupervisor {
    return this.supervisor;
  }

  subscribe(listener: EngineEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: EngineEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("[codex-bridge] app-server engine listener failed:", error);
      }
    }
  }

  /** Runs on the per-thread queue, off the transport's read loop. */
  private processNotification(
    notification: Parameters<typeof reduceNotification>[0],
    generation: EngineGeneration,
  ): void {
    // Anything from a replaced process describes state that no longer exists.
    if (generation !== this.supervisor.getGeneration()) return;

    if (
      notification.method === "warning"
      || notification.method === "guardianWarning"
      || notification.method === "deprecationNotice"
      || notification.method === "configWarning"
      || notification.method === "model/rerouted"
      || notification.method === "mcpServer/startupStatus/updated"
    ) {
      const params =
        notification.params
        && typeof notification.params === "object"
        && !Array.isArray(notification.params)
          ? notification.params as Record<string, unknown>
          : {};
      const message = [
        params.message,
        params.reason,
        params.error,
        params.status,
      ].find((value): value is string => typeof value === "string" && value.length > 0)
        ?? notification.method.replaceAll("/", " ");
      this.runtimeNotices.push({
        method: notification.method,
        // Redacted at *capture*, not on the way out: MCP-server startup errors
        // are the likeliest place for a real token or a credentialed URL to
        // appear, and `/session/:id/runtime-health` serves these cross-origin
        // with no auth. Truncate afterwards so redaction sees whole tokens.
        message: redactSecrets(message).slice(0, 1_000),
        receivedAt: new Date().toISOString(),
      });
      if (this.runtimeNotices.length > 100) this.runtimeNotices.shift();
    }

    const result = reduceNotification(notification, generation);
    if (result.unknownMethod) {
      this.unknownNotificationCount += 1;
      this.supervisor.recordUnknownNotification();
    }
    if (result.unsupportedItemType) this.unsupportedItemCount += 1;

    for (const event of result.events) {
      if (event.kind === "turn.completed") {
        this.resolveTerminalWaiters(event.threadId, event.turnId, event.status);
      }
      this.emit(event);
    }
  }

  /**
   * A restart replaced the child. Every loaded thread must be re-resumed against
   * the new generation before it can accept turns; callers are told through
   * `engine.state` so they can mark sessions recovering rather than idle.
   */
  private handleGenerationChange(generation: EngineGeneration, previous: EngineGeneration): void {
    // Waiters belong to the dead process; nothing will ever answer them.
    this.rejectAllWaiters();
    // Same for approvals: the old child has forgotten the request, so the card on
    // screen is stale and must be withdrawn rather than left to time out.
    this.router.abandonGeneration(previous);
    for (const binding of this.bindings.values()) binding.generation = previous;
    this.emit({ kind: "engine.generation", generation, previous, engineGeneration: generation });
  }

  private rejectAllWaiters(): void {
    for (const waiters of this.terminalWaiters.values()) {
      for (const waiter of waiters) waiter.resolve("failed");
    }
    this.terminalWaiters.clear();
  }

  private resolveTerminalWaiters(
    threadId: string | null,
    turnId: string,
    status: "completed" | "interrupted" | "failed",
  ): void {
    if (!threadId) return;
    const waiters = this.terminalWaiters.get(threadId);
    if (!waiters) return;
    const remaining = waiters.filter((waiter) => {
      if (waiter.turnId !== turnId) return true;
      waiter.resolve(status);
      return false;
    });
    if (remaining.length > 0) this.terminalWaiters.set(threadId, remaining);
    else this.terminalWaiters.delete(threadId);
  }

  // ---------------------------------------------------------------- models

  /**
   * Paginates `model/list`, preserving the server's ordering.
   *
   * app-server documents that `supportedReasoningEfforts` order is meaningful and
   * clients must not derive it from the names, so it is passed straight through.
   */
  async listModels(): Promise<EngineModel[]> {
    const models: EngineModel[] = [];
    let cursor: string | undefined;
    // Bounded so a misbehaving cursor cannot loop forever.
    for (let page = 0; page < 20; page += 1) {
      const response = await this.supervisor.request<{
        data: Array<Record<string, unknown>>;
        nextCursor: string | null;
      }>("model/list", { ...(cursor ? { cursor } : {}), limit: 50 });

      for (const model of response.data ?? []) {
        const id = typeof model.id === "string" ? model.id : undefined;
        if (!id) continue;
        models.push({
          id,
          displayName: typeof model.displayName === "string" ? model.displayName : id,
          description: typeof model.description === "string" ? model.description : undefined,
          hidden: model.hidden === true,
          supportedReasoningEfforts: Array.isArray(model.supportedReasoningEfforts)
            ? model.supportedReasoningEfforts
                .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
                .map((entry) => ({
                  effort: String(entry.reasoningEffort ?? ""),
                  description:
                    typeof entry.description === "string" ? entry.description : undefined,
                }))
                .filter((entry) => entry.effort.length > 0)
            : [],
          defaultReasoningEffort:
            typeof model.defaultReasoningEffort === "string"
              ? model.defaultReasoningEffort
              : undefined,
          serviceTiers: Array.isArray(model.serviceTiers)
            ? model.serviceTiers
                .filter((tier): tier is Record<string, unknown> => !!tier && typeof tier === "object")
                .map((tier) => String(tier.id ?? ""))
                .filter((id) => id.length > 0)
            : undefined,
          isDefault: model.isDefault === true,
        });
      }

      cursor = response.nextCursor ?? undefined;
      if (!cursor) break;
    }
    return models;
  }

  // --------------------------------------------------------------- threads

  private toThreadParams(config: EngineTurnConfig): Record<string, unknown> {
    return {
      cwd: config.cwd ?? this.options.cwd,
      // Passed explicitly on every call rather than relying on inherited state.
      approvalPolicy: config.approvalPolicy ?? "never",
      sandbox: config.sandbox ?? (config.mode === "plan" ? "read-only" : "danger-full-access"),
      ...(config.model ? { model: config.model } : {}),
      // `null` clears a previously set tier; `undefined` would leave it in place.
      serviceTier: config.serviceTier ?? null,
    };
  }

  async startThread(options: StartThreadOptions): Promise<EngineThread> {
    const response = await this.supervisor.request<{
      thread: Record<string, unknown>;
      model?: unknown;
    }>(
      "thread/start",
      this.toThreadParams(options.config),
    );
    return this.bindThread(response.thread, options.config, response.model);
  }

  async resumeThread(threadId: string, options: ResumeThreadOptions): Promise<EngineThread> {
    const response = await this.supervisor.request<{
      thread: Record<string, unknown>;
      model?: unknown;
    }>(
      "thread/resume",
      { threadId, ...this.toThreadParams(options.config) },
    );
    const thread = this.bindThread(response.thread, options.config, response.model);
    // app-server reconstructs turn history on resume by default.
    thread.turns = this.extractTurns(response.thread);
    return thread;
  }

  async forkThread(
    threadId: string,
    config: EngineTurnConfig,
    lastTurnId?: string,
  ): Promise<EngineThread> {
    const response = await this.supervisor.request<{
      thread: Record<string, unknown>;
      model?: unknown;
    }>(
      "thread/fork",
      {
        threadId,
        ...(lastTurnId ? { lastTurnId } : {}),
        ...this.toThreadParams(config),
      },
    );
    return this.bindThread(response.thread, config, response.model);
  }

  async compactThread(threadId: string): Promise<void> {
    await this.supervisor.request("thread/compact/start", { threadId });
  }

  async steerTurn(
    threadId: string,
    expectedTurnId: string,
    input: EngineUserInput[],
    clientUserMessageId?: string,
  ): Promise<string> {
    const response = await this.supervisor.request<{ turnId: string }>(
      "turn/steer",
      {
        threadId,
        expectedTurnId,
        input: input.map(toAppServerInput),
        ...(clientUserMessageId ? { clientUserMessageId } : {}),
      },
    );
    return response.turnId;
  }

  async startReview(
    threadId: string,
    target:
      | { type: "uncommittedChanges" }
      | { type: "baseBranch"; branch: string }
      | { type: "commit"; sha: string; title: string | null }
      | { type: "custom"; instructions: string },
    delivery: "inline" | "detached" = "inline",
  ): Promise<{ reviewThreadId: string; turnId: string }> {
    const response = await this.supervisor.request<{
      reviewThreadId: string;
      turn: { id: string };
    }>("review/start", { threadId, target, delivery });
    return { reviewThreadId: response.reviewThreadId, turnId: response.turn.id };
  }

  /** One authenticated, allowlisted snapshot of the running child. */
  async getRuntimeHealth(threadId?: string): Promise<{
    engine: {
      state: string;
      generation: number;
      codexVersion?: string;
      restartCount: number;
      circuitOpen: boolean;
    };
    /**
     * Protocol-drift counters, engine-global. This is the surface operators
     * watch after a Codex bump: a rising `serverRequests.unknown-method` or
     * `unknownNotifications` means the pinned protocol has moved. Deliberately
     * not on the public `/global/health` payload — these stay behind auth.
     */
    protocol: {
      unknownNotifications: number;
      unsupportedItems: number;
      serverRequests: ReturnType<ServerRequestRouter["getMetrics"]>;
    };
    mcp: unknown;
    skills: unknown;
    hooks: unknown;
    notices: RuntimeNotice[];
    rateLimits: unknown;
  }> {
    const [mcp, skills, hooks, rateLimits] = await Promise.allSettled([
      this.supervisor.request("mcpServerStatus/list", {
        limit: 100,
        detail: "full",
        ...(threadId ? { threadId } : {}),
      }),
      this.supervisor.request("skills/list", {
        cwds: [this.options.cwd],
      }),
      this.supervisor.request("hooks/list", {
        cwds: [this.options.cwd],
      }),
      this.supervisor.request("account/rateLimits/read", undefined),
    ]);
    const value = (result: PromiseSettledResult<unknown>) =>
      result.status === "fulfilled"
        ? result.value
        : { error: "Unavailable" };
    const engine = this.getHealth();
    return {
      engine: {
        state: engine.state,
        generation: engine.generation,
        ...(engine.codexVersion ? { codexVersion: engine.codexVersion } : {}),
        restartCount: engine.restartCount,
        circuitOpen: engine.circuitOpen,
      },
      protocol: {
        unknownNotifications: engine.unknownNotifications,
        unsupportedItems: engine.unsupportedItems,
        serverRequests: engine.serverRequests,
      },
      mcp: allowlistRuntimeInventory(value(mcp), "mcp"),
      skills: allowlistRuntimeInventory(value(skills), "skills"),
      hooks: allowlistRuntimeInventory(value(hooks), "hooks"),
      notices: this.runtimeNotices.map((notice) => ({
        method: notice.method,
        // Provider notice text is an error/log channel and routinely contains
        // absolute paths, account identity, commands, and filenames. The panel
        // needs to know that a notice occurred, not receive that raw payload.
        message: `Codex reported ${notice.method.replaceAll("/", " ")}`,
        receivedAt: notice.receivedAt,
      })),
      rateLimits: allowlistRateLimits(value(rateLimits)),
    };
  }

  async readThread(threadId: string, options: ReadThreadOptions = {}): Promise<EngineThread | null> {
    try {
      const response = await this.supervisor.request<{ thread: Record<string, unknown> }>(
        "thread/read",
        { threadId, ...(options.includeTurns ? { includeTurns: true } : {}) },
      );
      const thread = this.toEngineThread(response.thread);
      if (options.includeTurns) thread.turns = this.extractTurns(response.thread);
      return thread;
    } catch (error) {
      /**
       * A thread whose first turn never materialized rejects `includeTurns`
       * instead of returning an empty list. Reporting it as "no turns" is exactly
       * right for recovery: it proves no user message was ever persisted.
       */
      if (isUnmaterializedThreadError(error)) {
        return { id: threadId, handle: threadId, turns: [] };
      }
      throw error;
    }
  }

  /**
   * Lists root threads for this workspace.
   *
   * Explicit `sourceKinds`, exact-cwd filtering and dropping anything with a
   * `parentThreadId` are all required: without them the resume dialog either
   * empties or fills with sub-agent threads.
   */
  async listThreads(options: ListThreadsOptions = {}): Promise<ListThreadsResult> {
    const cwd = options.cwd ?? this.options.cwd;
    const response = await this.supervisor.request<{
      data: Array<Record<string, unknown>>;
      nextCursor: string | null;
    }>("thread/list", {
      sourceKinds: [...ROOT_THREAD_SOURCE_KINDS],
      cwd,
      limit: options.limit ?? 100,
      ...(options.cursor ? { cursor: options.cursor } : {}),
      ...(options.includeArchived === undefined ? {} : { archived: options.includeArchived }),
    });

    const threads = (response.data ?? [])
      .map((thread) => this.toEngineThread(thread))
      // Sub-agent threads are children of a conversation, not conversations.
      .filter((thread) => !thread.parentThreadId)
      // `cwd` is a server-side filter, but re-check exactly: a prefix match would
      // pull in sibling worktrees, which are separate environments.
      .filter((thread) => !thread.cwd || thread.cwd === cwd);

    return { threads, nextCursor: response.nextCursor, supported: true };
  }

  private bindThread(
    raw: Record<string, unknown>,
    config: EngineTurnConfig,
    confirmedModel?: unknown,
  ): EngineThread {
    const thread = this.toEngineThread(raw);
    if (typeof confirmedModel === "string" && confirmedModel.trim().length > 0) {
      thread.model = confirmedModel.trim();
    }
    if (thread.id) {
      // The thread id doubles as the engine handle: app-server addresses
      // everything by thread id, so a second indirection would add nothing.
      this.bindings.set(thread.id, {
        handle: thread.id,
        threadId: thread.id,
        config,
        generation: this.supervisor.getGeneration(),
      });
      thread.handle = thread.id;
    }
    return thread;
  }

  private toEngineThread(raw: unknown): EngineThread {
    const thread = (raw ?? {}) as Record<string, unknown>;
    const id = typeof thread.id === "string" ? thread.id : null;
    return {
      id,
      handle: id ?? "",
      cwd: typeof thread.cwd === "string" ? thread.cwd : undefined,
      name: typeof thread.name === "string" ? thread.name : null,
      preview: typeof thread.preview === "string" ? thread.preview : undefined,
      source: describeSource(thread.source),
      parentThreadId:
        typeof thread.parentThreadId === "string" ? thread.parentThreadId : null,
      updatedAt: secondsToIso(thread.updatedAt),
      createdAt: secondsToIso(thread.createdAt),
    };
  }

  private extractTurns(raw: Record<string, unknown>): EngineThreadTurn[] {
    const turns = Array.isArray(raw.turns) ? raw.turns : [];
    return turns
      .filter((turn): turn is Record<string, unknown> => !!turn && typeof turn === "object")
      .map((turn) => {
        const items = Array.isArray(turn.items) ? turn.items : [];
        const clientIds = items
          .filter(
            (item): item is Record<string, unknown> =>
              !!item
              && typeof item === "object"
              && (item as Record<string, unknown>).type === "userMessage",
          )
          .map((item) => item.clientId)
          .filter((clientId): clientId is string => typeof clientId === "string");
        return {
          id: String(turn.id ?? ""),
          status: (turn.status as EngineThreadTurn["status"]) ?? "completed",
          items: [],
          clientId: clientIds[0] ?? null,
          clientIds,
          startedAt: secondsToIso(turn.startedAt),
          completedAt: secondsToIso(turn.completedAt),
        } satisfies EngineThreadTurn;
      });
  }

  /**
   * Replays a resumed thread's history as engine events, so a rehydrated
   * transcript is built by exactly the same code path as a streamed one.
   */
  replayHistory(threadId: string, raw: unknown): void {
    const { events, unsupportedItemTypes } = reduceHistoricalTurns(
      raw,
      this.supervisor.getGeneration(),
      threadId,
      threadId,
    );
    this.unsupportedItemCount += unsupportedItemTypes.length;
    for (const event of events) this.emit(event);
  }

  async setThreadName(threadId: string, name: string): Promise<boolean> {
    try {
      await this.supervisor.request("thread/name/set", { threadId, name });
      return true;
    } catch (error) {
      // A failed rename must not fail the turn; the bridge's own title index is
      // still authoritative for the UI.
      console.warn(
        "[codex-bridge] thread/name/set failed:",
        error instanceof Error ? error.message : error,
      );
      return false;
    }
  }

  /**
   * Releases a thread. Deliberately `thread/unsubscribe`, never `thread/delete`:
   * closing a tab must not destroy the user's conversation or its descendants.
   */
  async unsubscribeThread(handle: string): Promise<void> {
    const binding = this.bindings.get(handle);
    this.bindings.delete(handle);
    if (!binding) return;
    try {
      await this.supervisor.request("thread/unsubscribe", { threadId: binding.threadId });
    } catch (error) {
      // Already gone, or the process died — either way there is nothing to free.
      console.warn(
        "[codex-bridge] thread/unsubscribe failed:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  /**
   * Records new config for the thread. app-server applies policy per turn, so
   * this only updates what the next `turn/start` will send — no protocol call and
   * no new thread object, unlike the SDK engine.
   */
  async configureThread(handle: string, config: EngineTurnConfig): Promise<void> {
    const binding = this.bindings.get(handle);
    if (binding) binding.config = config;
  }

  // ----------------------------------------------------------------- turns

  async startTurn(options: StartTurnOptions): Promise<EngineTurn> {
    const binding = this.bindings.get(options.handle);
    if (!binding) throw new Error(`Unknown app-server thread handle: ${options.handle}`);

    const params = {
      threadId: binding.threadId,
      // The at-most-once key: echoed back on the persisted userMessage as
      // `clientId`, which is what makes ambiguous dispatch recoverable.
      ...(options.requestId ? { clientUserMessageId: options.requestId } : {}),
      ...(options.outputSchema ? { outputSchema: options.outputSchema } : {}),
      input: options.input.map(toAppServerInput),
      ...this.toThreadParams(options.config),
      ...(options.config.reasoningEffort ? { effort: options.config.reasoningEffort } : {}),
      // turn/start takes a resolved policy object, not the mode string.
      sandboxPolicy: toSandboxPolicy(options.config),
    };
    // `sandbox` belongs to thread/start; turn/start uses `sandboxPolicy`.
    delete (params as Record<string, unknown>).sandbox;

    const { result, generation } = await this.supervisor.requestWithGeneration<{
      turn: { id: string };
    }>("turn/start", params);

    binding.generation = generation;
    return { threadId: binding.threadId, turnId: result.turn.id, engineGeneration: generation };
  }

  /**
   * Asks app-server to interrupt. This only *requests* it — the caller must await
   * `waitForTurnTerminal` before treating the thread as idle, or a new prompt
   * could overlap a turn that is still running.
   */
  async interruptTurn(handle: string, turnId: string): Promise<void> {
    const binding = this.bindings.get(handle);
    if (!binding) return;
    await this.supervisor.request("turn/interrupt", { threadId: binding.threadId, turnId });
  }

  /**
   * Resolves when the turn reaches a terminal status.
   *
   * Escalation on timeout: re-ask once (the first interrupt may have raced a
   * busy turn), then check persisted state, and only restart the child as a last
   * resort. Never silently return "idle" — that is what would let a new turn
   * overlap one that is still executing.
   */
  async waitForTurnTerminal(
    handle: string,
    turnId: string,
    options: { timeoutMs?: number; allowRestart?: boolean } = {},
  ): Promise<"completed" | "interrupted" | "failed" | "unknown"> {
    const binding = this.bindings.get(handle);
    if (!binding) return "unknown";
    const timeoutMs = options.timeoutMs ?? this.interruptTimeoutMs;

    const first = await this.raceTerminal(binding.threadId, turnId, timeoutMs);
    if (first) return first;

    // Still running. Ask again before escalating.
    try {
      await this.supervisor.request("turn/interrupt", { threadId: binding.threadId, turnId });
    } catch {
      // The process may already be gone; the read below settles it either way.
    }
    const second = await this.raceTerminal(binding.threadId, turnId, timeoutMs);
    if (second) return second;

    // Consult persisted state rather than guessing.
    const persisted = await this.reconcileTurnById(binding.threadId, turnId);
    if (persisted.result === "terminal") return persisted.status;

    if (options.allowRestart) {
      // Last resort: replacing the child guarantees the turn is not still
      // running, at the cost of every other thread in the environment.
      await this.supervisor.restartNow(`turn ${turnId} would not interrupt`);
      return "interrupted";
    }
    return "unknown";
  }

  private raceTerminal(
    threadId: string,
    turnId: string,
    timeoutMs: number,
  ): Promise<"completed" | "interrupted" | "failed" | null> {
    return new Promise((resolve) => {
      const waiters = this.terminalWaiters.get(threadId) ?? [];
      const waiter: TerminalWaiter = {
        turnId,
        resolve: (status) => {
          clearTimeout(timer);
          resolve(status);
        },
      };
      waiters.push(waiter);
      this.terminalWaiters.set(threadId, waiters);

      const timer = setTimeout(() => {
        const current = this.terminalWaiters.get(threadId) ?? [];
        this.terminalWaiters.set(
          threadId,
          current.filter((entry) => entry !== waiter),
        );
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
    });
  }

  /** Reads persisted turn status when live events cannot answer. */
  async reconcileTurnById(
    threadId: string,
    turnId: string,
  ): Promise<
    | { result: "terminal"; status: "completed" | "interrupted" | "failed" }
    | { result: "running" }
    | { result: "absent" }
    | { result: "unknown" }
  > {
    try {
      const thread = await this.readThread(threadId, { includeTurns: true });
      const turn = thread?.turns?.find((entry) => entry.id === turnId);
      if (!turn) return { result: "absent" };
      if (turn.status === "inProgress") return { result: "running" };
      return { result: "terminal", status: turn.status };
    } catch {
      return { result: "unknown" };
    }
  }

  /**
   * Answers "did this request already execute?" after an ambiguous failure.
   *
   * This is the only safe basis for deciding whether to dispatch again — matching
   * on prompt text would be wrong, because the same text under a different
   * request id is a legitimately different turn.
   */
  async reconcileRequest(threadId: string, requestId: string): Promise<ReconciliationOutcome> {
    const thread = await this.readThread(threadId, { includeTurns: true });
    const turns = (thread?.turns ?? []).map((turn) => ({
      id: turn.id,
      status: turn.status,
      items: (turn.clientIds ?? (turn.clientId ? [turn.clientId] : []))
        .map((clientId) => ({ type: "userMessage" as const, clientId })),
    }));
    return reconcileFromThreadTurns(turns, requestId);
  }

  /** Classifies a dispatch failure so callers know if a retry is even legal. */
  classifyFailure(error: unknown): {
    class: "rejected" | "ambiguous";
    retryImmediately: boolean;
    engineError: EngineError;
  } {
    return {
      class: classifyDispatchFailure(error),
      retryImmediately: isSafeToRetryImmediately(error),
      engineError: toEngineError(error),
    };
  }

  /** Re-reads the environment and restarts the child if PATH-ish vars changed. */
  async ensureEnvironmentIsCurrent(options: {
    hasActiveTurns: () => boolean;
    waitForIdle: () => Promise<void>;
  }): Promise<{ restarted: boolean }> {
    const { restarted } = await this.supervisor.ensureEnvironmentIsCurrent(options);
    return { restarted };
  }

  isOverloaded(error: unknown): boolean {
    return error instanceof AppServerRpcError && error.isOverload();
  }
}

function toAppServerInput(input: EngineUserInput): Record<string, unknown> {
  if (input.type === "text") {
    // `text_elements` is required by the protocol even when empty.
    return { type: "text", text: input.text, text_elements: [] };
  }
  return { type: "localImage", path: input.path };
}

/** turn/start takes a resolved `SandboxPolicy` object, not the mode shorthand. */
function toSandboxPolicy(config: EngineTurnConfig): Record<string, unknown> {
  const sandbox = config.sandbox ?? (config.mode === "plan" ? "read-only" : "danger-full-access");
  const networkAccess = config.networkAccessEnabled ?? true;
  switch (sandbox) {
    case "read-only":
      return { type: "readOnly", networkAccess };
    case "workspace-write":
      return {
        type: "workspaceWrite",
        writableRoots: [],
        networkAccess,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
    case "danger-full-access":
    default:
      return { type: "dangerFullAccess" };
  }
}

/** `SessionSource` is a string or a single-key object (`{ subagent: ... }`). */
function describeSource(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return Object.keys(value)[0];
  return undefined;
}

/** app-server timestamps are unix *seconds*; the bridge speaks ISO strings. */
function secondsToIso(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return new Date(value * 1000).toISOString();
}
