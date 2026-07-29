import { createHash } from "node:crypto";
import type {
  BuildPipelineAgent,
  PipelineSessionPhase,
  TaskSnapshotImage,
} from "@orkestrator/protocol/build-pipeline";
import type { JsonSchema } from "@orkestrator/protocol/structured-output";
import type { Environment, PersistedNativeAgentSession } from "./models.js";
import type { StorageService } from "./storage.js";
import {
  createBuildPipelineProvider,
  PromptRejectedError,
  type BridgeConnection,
  type BuildPipelineProvider,
  type ProviderExecutionMode,
} from "./build-pipeline-provider.js";

type CommandInvoker = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

export interface EnsureNativeAgentSessionInput {
  environmentId: string;
  agent: BuildPipelineAgent;
  logicalSessionKey: string;
  title?: string;
  model?: string;
  reasoningEffort?: string;
  phase?: PipelineSessionPhase;
}

export interface DispatchNativeAgentPromptInput
  extends EnsureNativeAgentSessionInput {
  prompt: string;
  requestId: string;
  images?: TaskSnapshotImage[];
  schema?: JsonSchema;
  mode?: ProviderExecutionMode;
  fastMode?: boolean;
}

export interface AdoptNativeAgentSessionInput
  extends EnsureNativeAgentSessionInput {
  providerSessionId: string;
  expectedProviderSessionId?: string;
}

export interface NativeAgentServiceOptions {
  provider?: (
    input: EnsureNativeAgentSessionInput,
    environment: Environment,
  ) => Promise<BuildPipelineProvider>;
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function nativeAgentSessionStorageKey(
  environmentId: string,
  agent: BuildPipelineAgent,
  logicalSessionKey: string,
): string {
  return createHash("sha256")
    .update(environmentId)
    .update("\0")
    .update(agent)
    .update("\0")
    .update(logicalSessionKey)
    .digest("hex");
}

/**
 * Backend authority for provider-session creation and prompt dispatch.
 *
 * Renderers may ask for the same logical session concurrently. Storage holds
 * its cross-process lock across providers that cannot create deterministically
 * (OpenCode), while Claude/Codex also receive the logical key as a second layer
 * of idempotency at their bridges.
 */
export class NativeAgentService {
  private readonly providers = new Map<string, BuildPipelineProvider>();
  private readonly launchTasks = new Map<string, Promise<void>>();
  private readonly launchRetryAt = new Map<string, number>();
  private readonly queueTasks = new Map<string, Promise<void>>();
  private readonly queueRetryAt = new Map<string, number>();
  private readonly scanTasks = new Set<Promise<void>>();
  private launchTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(
    private readonly storage: StorageService,
    private readonly invoke: CommandInvoker,
    private readonly options: NativeAgentServiceOptions = {},
  ) {}

  async init(): Promise<void> {
    if (this.stopped) throw new Error("Native agent service is shut down");
    await Promise.allSettled([
      this.trackScan(this.reconcilePendingLaunches()),
      this.trackScan(this.drainPromptQueues()),
    ]);
    if (this.stopped) return;
    this.launchTimer = setInterval(() => {
      if (this.stopped) return;
      void this.trackScan(this.reconcilePendingLaunches()).catch(() => undefined);
      void this.trackScan(this.drainPromptQueues()).catch(() => undefined);
    }, 2_000);
    this.launchTimer.unref?.();
  }

  async ensureSession(
    input: EnsureNativeAgentSessionInput,
  ): Promise<PersistedNativeAgentSession> {
    this.assertAcceptingWork();
    if (
      !nonBlank(input.environmentId)
      || !nonBlank(input.logicalSessionKey)
      || !["claude", "codex", "opencode"].includes(input.agent)
    ) {
      throw new Error("Invalid native agent session request");
    }
    const key = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    await this.assertEnvironmentLive(input.environmentId);
    const provider = await this.provider(input);
    const existing = await this.storage.getNativeAgentSession(key);
    if (existing) {
      this.assertSessionIdentity(existing, input, key);
      await this.assertEnvironmentLive(input.environmentId);
      provider.registerSession?.(existing.providerSessionId);
      const status = await provider.status(existing.providerSessionId);
      await this.assertEnvironmentLive(input.environmentId);
      if (status !== "missing") return existing;
      await this.storage.invalidateNativeAgentSession(
        key,
        existing.providerSessionId,
      );
    }
    return this.storage.runWithLiveEnvironment(
      input.environmentId,
      "Native agent session",
      () =>
        this.storage.getOrCreateNativeAgentSession(
          {
            key,
            environmentId: input.environmentId,
            agent: input.agent,
            logicalSessionKey: input.logicalSessionKey,
          },
          () => this.createProviderSession(provider, input),
        ),
    );
  }

  async adoptSession(
    input: AdoptNativeAgentSessionInput,
  ): Promise<PersistedNativeAgentSession> {
    this.assertAcceptingWork();
    if (
      !nonBlank(input.environmentId)
      || !nonBlank(input.logicalSessionKey)
      || !nonBlank(input.providerSessionId)
      || !["claude", "codex", "opencode"].includes(input.agent)
      || (
        input.expectedProviderSessionId !== undefined
        && !nonBlank(input.expectedProviderSessionId)
      )
    ) {
      throw new Error("Invalid native agent session adoption request");
    }
    const key = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    await this.assertEnvironmentLive(input.environmentId);
    const provider = await this.provider(input);
    provider.registerSession?.(input.providerSessionId);
    const status = await provider.status(input.providerSessionId);
    await this.assertEnvironmentLive(input.environmentId);
    if (status === "missing") {
      throw new Error("Native agent provider session was not found");
    }
    return this.storage.adoptNativeAgentSession({
      key,
      environmentId: input.environmentId,
      agent: input.agent,
      logicalSessionKey: input.logicalSessionKey,
      providerSessionId: input.providerSessionId,
      expectedProviderSessionId: input.expectedProviderSessionId,
    });
  }

  async dispatchPrompt(
    input: DispatchNativeAgentPromptInput,
  ): Promise<PersistedNativeAgentSession> {
    this.assertAcceptingWork();
    if (!nonBlank(input.prompt) || !nonBlank(input.requestId)) {
      throw new Error("Native agent prompt and request ID must not be blank");
    }
    const session = await this.ensureSession(input);
    const provider = await this.provider(input);
    provider.registerSession?.(session.providerSessionId);
    const result = await this.storage.runWithLiveEnvironment(
      input.environmentId,
      "Native agent prompt",
      () =>
        this.storage.dispatchNativeAgentPromptOnce(
          session.key,
          input.requestId,
          async (durable) => {
            await provider.send(durable.providerSessionId, input.prompt, {
              requestId: input.requestId,
              images: input.images,
              schema: input.schema,
              mode: input.mode,
              fastMode: input.fastMode,
            });
          },
        ),
    );
    return result.session;
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.launchTimer) clearInterval(this.launchTimer);
    this.launchTimer = null;
    await Promise.allSettled([...this.scanTasks]);
    while (this.launchTasks.size > 0 || this.queueTasks.size > 0) {
      await Promise.allSettled([
        ...this.launchTasks.values(),
        ...this.queueTasks.values(),
      ]);
    }
    await Promise.allSettled(
      [...this.providers.values()].map((provider) => provider.dispose?.()),
    );
    this.providers.clear();
  }

  async reconcileInitialLaunch(environmentId: string): Promise<void> {
    if (this.stopped) return;
    const existing = this.launchTasks.get(environmentId);
    if (existing) return existing;
    const task = this.reconcileInitialLaunchOnce(environmentId)
      .finally(() => {
        if (this.launchTasks.get(environmentId) === task) {
          this.launchTasks.delete(environmentId);
        }
      });
    this.launchTasks.set(environmentId, task);
    return task;
  }

  private async reconcilePendingLaunches(): Promise<void> {
    if (this.stopped) return;
    const now = Date.now();
    const environments = await this.storage.loadEnvironments();
    if (this.stopped) return;
    await Promise.allSettled(
      environments
        .filter((environment) =>
          environment.pendingAgentLaunch
          && environment.status === "running"
          && environment.setupScriptsComplete === true
          && (this.launchRetryAt.get(environment.id) ?? 0) <= now
        )
        .map((environment) => this.reconcileInitialLaunch(environment.id)),
    );
  }

  private async drainPromptQueues(): Promise<void> {
    if (this.stopped) return;
    const now = Date.now();
    const queues = await this.storage.listAllPromptQueues();
    if (this.stopped) return;
    await Promise.allSettled(
      queues
        .filter((queue) => {
          const agent = queue.queueKey.split("\0", 1)[0];
          return (
            (agent === "claude" || agent === "codex" || agent === "opencode")
            && (queue.messages.length > 0 || queue.inFlight !== undefined)
            && queue.dispatchError === undefined
            && (this.queueRetryAt.get(queue.queueKey) ?? 0) <= now
          );
        })
        .map((queue) => this.drainPromptQueue(queue.queueKey)),
    );
  }

  private async drainPromptQueue(queueKey: string): Promise<void> {
    if (this.stopped) return;
    const existing = this.queueTasks.get(queueKey);
    if (existing) return existing;
    const task = this.drainPromptQueueOnce(queueKey)
      .finally(() => {
        if (this.queueTasks.get(queueKey) === task) {
          this.queueTasks.delete(queueKey);
        }
      });
    this.queueTasks.set(queueKey, task);
    return task;
  }

  private async drainPromptQueueOnce(queueKey: string): Promise<void> {
    if (this.stopped) return;
    const separator = queueKey.indexOf("\0");
    if (separator <= 0) return;
    const agent = queueKey.slice(0, separator) as BuildPipelineAgent;
    const logicalSessionKey = queueKey.slice(separator + 1);
    if (
      !["claude", "codex", "opencode"].includes(agent)
      || !nonBlank(logicalSessionKey)
    ) {
      return;
    }
    const queue = await this.storage.getPromptQueue(queueKey);
    if (!queue || queue.dispatchError) return;
    await this.assertEnvironmentLive(queue.environmentId);
    const draftKey =
      `${agent}:${queue.environmentId}:${encodeURIComponent(logicalSessionKey)}`;
    const draft = await this.storage.getComposeDraft(draftKey);
    if (this.composeDraftHoldsQueue(draft?.value)) return;

    const mode = this.queueExecutionMode(agent, queue.inFlight?.message ?? queue.messages[0]);
    const session = await this.ensureSession({
      environmentId: queue.environmentId,
      agent,
      logicalSessionKey,
      model: this.queueString(queue.inFlight?.message ?? queue.messages[0], "model"),
      reasoningEffort: this.queueReasoningEffort(
        queue.inFlight?.message ?? queue.messages[0],
      ),
      phase: mode === "plan" ? "review" : "build",
    });
    const provider = await this.provider({
      environmentId: queue.environmentId,
      agent,
      logicalSessionKey,
      model: this.queueString(queue.inFlight?.message ?? queue.messages[0], "model"),
      reasoningEffort: this.queueReasoningEffort(
        queue.inFlight?.message ?? queue.messages[0],
      ),
    });
    await this.assertEnvironmentLive(queue.environmentId);
    const status = await provider.status(session.providerSessionId);
    await this.assertEnvironmentLive(queue.environmentId);
    if (status === "running") return;
    if (status !== "idle") {
      this.queueRetryAt.set(queueKey, Date.now() + 2_000);
      return;
    }
    if (this.stopped) return;
    const latestDraft = await this.storage.getComposeDraft(draftKey);
    if (this.composeDraftHoldsQueue(latestDraft?.value)) return;
    const reservation = await this.storage.reservePromptQueueHeadForDispatch(
      queueKey,
    );
    if (!reservation || typeof reservation.message !== "object") return;
    const message = reservation.message as Record<string, unknown>;
    if (!nonBlank(message.text)) {
      await this.storage.acknowledgePromptQueueDispatch(
        queueKey,
        reservation.requestId,
      );
      return;
    }

    const attachmentPaths = Array.isArray(message.attachments)
      ? message.attachments.flatMap((candidate) => {
          if (
            !candidate
            || typeof candidate !== "object"
            || !nonBlank((candidate as Record<string, unknown>).path)
          ) {
            return [];
          }
          return [(candidate as { path: string }).path];
        })
      : [];
    const prompt = attachmentPaths.length === 0
      ? message.text
      : [
          message.text,
          "",
          "Attached workspace files:",
          ...attachmentPaths.map((filePath) => `- ${filePath}`),
        ].join("\n");
    try {
      await this.dispatchPrompt({
        environmentId: queue.environmentId,
        agent,
        logicalSessionKey,
        model: nonBlank(message.model) ? message.model : undefined,
        reasoningEffort:
          nonBlank(message.reasoningEffort)
            ? message.reasoningEffort
            : nonBlank(message.effort)
              ? message.effort
              : nonBlank(message.variant)
                ? message.variant
                : undefined,
        phase: this.queueExecutionMode(agent, message) === "plan"
          ? "review"
          : "build",
        mode: this.queueExecutionMode(agent, message),
        fastMode: this.queueFastMode(agent, message),
        prompt,
        requestId: reservation.requestId,
      });
      await this.storage.acknowledgePromptQueueDispatch(
        queueKey,
        reservation.requestId,
      );
      this.queueRetryAt.delete(queueKey);
    } catch (error) {
      if (error instanceof PromptRejectedError) {
        await this.storage.failPromptQueueDispatch(
          queueKey,
          reservation.requestId,
        );
        this.queueRetryAt.delete(queueKey);
        return;
      }
      // Keep the in-flight record durable. The same request id is retried after
      // backoff, so an ambiguous provider response cannot become a second turn.
      this.queueRetryAt.set(queueKey, Date.now() + 2_000);
      throw error;
    }
  }

  private async reconcileInitialLaunchOnce(
    environmentId: string,
  ): Promise<void> {
    if (this.stopped) return;
    const environment = await this.storage.getEnvironment(environmentId);
    if (
      !environment
      || !environment.pendingAgentLaunch
      || environment.status !== "running"
      || environment.setupScriptsComplete !== true
    ) {
      return;
    }
    const config = await this.storage.loadConfig();
    const repository = await this.storage.getRepositoryConfig(
      environment.projectId,
    );
    const agent =
      environment.defaultAgent
      ?? repository.defaultAgent
      ?? config.global.defaultAgent;
    const mode = agent === "claude"
      ? environment.claudeMode ?? config.global.claudeMode
      : agent === "codex"
        ? environment.codexMode ?? config.global.codexMode
        : environment.opencodeMode ?? config.global.opencodeMode;
    const claudeBackend =
      environment.claudeNativeBackend
      ?? repository.claudeNativeBackend
      ?? config.global.claudeNativeBackend;

    // Terminal and Claude-tmux launches still need a PTY/tmux projection. They
    // are left pending for the backend terminal coordinator rather than being
    // falsely marked consumed by this native-session service.
    if (
      mode !== "native"
      || (agent === "claude" && claudeBackend === "tmux")
    ) {
      return;
    }

    const logicalSessionKey = `env-${environment.id}:startup-agent`;
    const model =
      environment.initialAgentModel
      ?? repository.defaultModel
      ?? (
        agent === "claude"
          ? config.global.claudeModel
          : agent === "codex"
            ? config.global.codexModel
            : config.global.opencodeModel
      );
    const reasoningEffort =
      environment.initialReasoningEffort
      ?? repository.defaultEffort
      ?? (agent === "codex" ? config.global.codexReasoningEffort : undefined);

    await this.storage.updateEnvironment(environment.id, {
      startupAgentSession: {
        tabId: "startup-agent",
        agent,
        style: "native",
        model,
        reasoningEffort,
        status: "starting",
      },
    });

    try {
      const prompt = environment.initialPrompt?.trim();
      const images = environment.initialPromptAttachments?.map((attachment) => ({
        filename: attachment.name,
        data: attachment.base64Data,
      }));
      const session = prompt
        ? await this.dispatchPrompt({
            environmentId: environment.id,
            agent,
            logicalSessionKey,
            model,
            reasoningEffort,
            prompt,
            requestId: `initial-prompt:${environment.id}:startup-agent`,
            images,
          })
        : await this.ensureSession({
            environmentId: environment.id,
            agent,
            logicalSessionKey,
            model,
            reasoningEffort,
          });

      await this.storage.updateEnvironment(environment.id, {
        pendingAgentLaunch: false,
        initialAgentModel: undefined,
        initialReasoningEffort: undefined,
        initialPromptAttachments: undefined,
        startupAgentSession: {
          tabId: "startup-agent",
          agent,
          style: "native",
          model,
          reasoningEffort,
          providerSessionId: session.providerSessionId,
          status: "running",
          startedAt: new Date().toISOString(),
        },
      });
      this.launchRetryAt.delete(environment.id);
    } catch (error) {
      this.launchRetryAt.set(environment.id, Date.now() + 10_000);
      await this.storage.updateEnvironment(environment.id, {
        startupAgentSession: {
          tabId: "startup-agent",
          agent,
          style: "native",
          model,
          reasoningEffort,
          status: "error",
          error: "Agent launch failed; the backend will retry.",
        },
      });
      throw error;
    }
  }

  private async provider(
    input: EnsureNativeAgentSessionInput,
  ): Promise<BuildPipelineProvider> {
    this.assertAcceptingWork();
    const cacheKey = JSON.stringify([
      input.environmentId,
      input.agent,
      input.model ?? null,
      input.reasoningEffort ?? null,
    ]);
    const environment = await this.assertEnvironmentLive(input.environmentId);
    const cached = this.providers.get(cacheKey);
    if (cached) return cached;

    if (this.options.provider) {
      const provider = await this.options.provider(input, environment);
      await this.assertEnvironmentLive(input.environmentId);
      this.assertAcceptingWork();
      this.providers.set(cacheKey, provider);
      return provider;
    }
    const connection = await this.bridgeConnection(
      input.agent,
      environment,
      input.model,
      input.reasoningEffort,
    );
    await this.assertEnvironmentLive(input.environmentId);
    this.assertAcceptingWork();
    const provider = createBuildPipelineProvider(connection);
    this.providers.set(cacheKey, provider);
    return provider;
  }

  private trackScan(task: Promise<void>): Promise<void> {
    const tracked = task.finally(() => {
      this.scanTasks.delete(tracked);
    });
    this.scanTasks.add(tracked);
    return tracked;
  }

  private assertAcceptingWork(): void {
    if (this.stopped) throw new Error("Native agent service is shut down");
  }

  private async assertEnvironmentLive(environmentId: string): Promise<Environment> {
    this.assertAcceptingWork();
    const environment = await this.storage.getEnvironment(environmentId);
    if (!environment || environment.deletionRequestedAt) {
      throw new Error("Native agent environment is unavailable");
    }
    this.assertAcceptingWork();
    return environment;
  }

  private assertSessionIdentity(
    session: PersistedNativeAgentSession,
    input: EnsureNativeAgentSessionInput,
    key: string,
  ): void {
    if (
      session.key !== key
      || session.environmentId !== input.environmentId
      || session.agent !== input.agent
      || session.logicalSessionKey !== input.logicalSessionKey
    ) {
      throw new Error("Native agent session key collision");
    }
  }

  private async createProviderSession(
    provider: BuildPipelineProvider,
    input: EnsureNativeAgentSessionInput,
  ): Promise<string> {
    await this.assertEnvironmentLive(input.environmentId);
    const providerSessionId = await provider.createSession(
      input.phase ?? "build",
      input.title?.trim() || "Agent Session",
      input.logicalSessionKey,
    );
    await this.assertEnvironmentLive(input.environmentId);
    return providerSessionId;
  }

  private composeDraftHoldsQueue(value: unknown): boolean {
    if (value === undefined || value === null) return false;
    if (!value || typeof value !== "object" || Array.isArray(value)) return true;
    const draft = value as Record<string, unknown>;
    if (typeof draft.text !== "string") return true;
    if (!Array.isArray(draft.mentions) || !Array.isArray(draft.attachments)) {
      return true;
    }
    return draft.text.trim().length > 0
      || draft.mentions.length > 0
      || draft.attachments.length > 0;
  }

  private queueString(message: unknown, field: string): string | undefined {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return undefined;
    }
    const value = (message as Record<string, unknown>)[field];
    return nonBlank(value) ? value : undefined;
  }

  private queueReasoningEffort(message: unknown): string | undefined {
    return this.queueString(message, "reasoningEffort")
      ?? this.queueString(message, "effort")
      ?? this.queueString(message, "variant");
  }

  private queueFastMode(
    agent: BuildPipelineAgent,
    message: unknown,
  ): boolean | undefined {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return undefined;
    }
    const record = message as Record<string, unknown>;
    const value = agent === "claude"
      ? record.fastModeEnabled
      : agent === "codex"
        ? record.fastMode
        : undefined;
    return typeof value === "boolean" ? value : undefined;
  }

  private queueExecutionMode(
    agent: BuildPipelineAgent,
    message: unknown,
  ): ProviderExecutionMode {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return "plan";
    }
    const record = message as Record<string, unknown>;
    if (agent === "claude") {
      if (record.planModeEnabled === true) return "plan";
      if (record.planModeEnabled === false || record.planModeEnabled === undefined) {
        return "build";
      }
      return "plan";
    }
    if (record.mode === "plan" || record.mode === "build") return record.mode;
    return record.mode === undefined ? "build" : "plan";
  }

  private async bridgeConnection(
    agent: BuildPipelineAgent,
    environment: Environment,
    model?: string,
    effort?: string,
  ): Promise<BridgeConnection> {
    const suffix = agent === "opencode" ? "opencode" : agent;
    if (environment.environmentType === "local") {
      const result = await this.invoke<{ port: number; authToken?: string }>(
        `start_local_${suffix}_server_cmd`,
        { environmentId: environment.id },
      );
      if (!result.authToken) {
        throw new Error(`${agent} bridge authentication is unavailable`);
      }
      return {
        agent,
        baseUrl: `http://127.0.0.1:${result.port}`,
        authToken: result.authToken,
        directory: environment.worktreePath,
        model,
        effort,
      };
    }

    if (!environment.containerId) {
      throw new Error("Native agent container is unavailable");
    }
    const result = await this.invoke<{ hostPort: number; authToken?: string }>(
      `start_${suffix}_server`,
      { containerId: environment.containerId },
    );
    if (!result.authToken) {
      throw new Error(`${agent} bridge authentication is unavailable`);
    }
    return {
      agent,
      baseUrl: `http://127.0.0.1:${result.hostPort}`,
      authToken: result.authToken,
      model,
      effort,
    };
  }
}
