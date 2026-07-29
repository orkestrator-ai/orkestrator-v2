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
  type BridgeConnection,
  type BuildPipelineProvider,
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
  agent: BuildPipelineAgent,
  logicalSessionKey: string,
): string {
  return createHash("sha256")
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
  private launchTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly storage: StorageService,
    private readonly invoke: CommandInvoker,
    private readonly options: NativeAgentServiceOptions = {},
  ) {}

  async init(): Promise<void> {
    await this.reconcilePendingLaunches();
    await this.drainPromptQueues();
    this.launchTimer = setInterval(() => {
      void this.reconcilePendingLaunches();
      void this.drainPromptQueues();
    }, 2_000);
    this.launchTimer.unref?.();
  }

  async ensureSession(
    input: EnsureNativeAgentSessionInput,
  ): Promise<PersistedNativeAgentSession> {
    if (
      !nonBlank(input.environmentId)
      || !nonBlank(input.logicalSessionKey)
      || !["claude", "codex", "opencode"].includes(input.agent)
    ) {
      throw new Error("Invalid native agent session request");
    }
    const key = nativeAgentSessionStorageKey(
      input.agent,
      input.logicalSessionKey,
    );
    const provider = await this.provider(input);
    const existing = await this.storage.getNativeAgentSession(key);
    if (existing) {
      provider.registerSession?.(existing.providerSessionId);
      const status = await provider.status(existing.providerSessionId);
      if (status !== "missing") return existing;
      await this.storage.invalidateNativeAgentSession(
        key,
        existing.providerSessionId,
      );
    }
    return this.storage.getOrCreateNativeAgentSession(
      {
        key,
        environmentId: input.environmentId,
        agent: input.agent,
        logicalSessionKey: input.logicalSessionKey,
      },
      () =>
        provider.createSession(
          input.phase ?? "build",
          input.title?.trim() || "Agent Session",
          input.logicalSessionKey,
        ),
    );
  }

  async dispatchPrompt(
    input: DispatchNativeAgentPromptInput,
  ): Promise<PersistedNativeAgentSession> {
    if (!nonBlank(input.prompt) || !nonBlank(input.requestId)) {
      throw new Error("Native agent prompt and request ID must not be blank");
    }
    const session = await this.ensureSession(input);
    const provider = await this.provider(input);
    provider.registerSession?.(session.providerSessionId);
    const result = await this.storage.dispatchNativeAgentPromptOnce(
      session.key,
      input.requestId,
      async (durable) => {
        await provider.send(durable.providerSessionId, input.prompt, {
          requestId: input.requestId,
          images: input.images,
          schema: input.schema,
        });
      },
    );
    return result.session;
  }

  async shutdown(): Promise<void> {
    if (this.launchTimer) clearInterval(this.launchTimer);
    this.launchTimer = null;
    await Promise.allSettled([...this.launchTasks.values()]);
    await Promise.allSettled([...this.queueTasks.values()]);
    await Promise.allSettled(
      [...this.providers.values()].map((provider) => provider.dispose?.()),
    );
    this.providers.clear();
  }

  async reconcileInitialLaunch(environmentId: string): Promise<void> {
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
    const now = Date.now();
    const environments = await this.storage.loadEnvironments();
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
    const now = Date.now();
    const queues = await this.storage.listAllPromptQueues();
    await Promise.allSettled(
      queues
        .filter((queue) => {
          const agent = queue.queueKey.split("\0", 1)[0];
          return (
            (agent === "claude" || agent === "codex" || agent === "opencode")
            && (queue.messages.length > 0 || queue.inFlight !== undefined)
            && (this.queueRetryAt.get(queue.queueKey) ?? 0) <= now
          );
        })
        .map((queue) => this.drainPromptQueue(queue.queueKey)),
    );
  }

  private async drainPromptQueue(queueKey: string): Promise<void> {
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
    if (!queue) return;
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
        phase: message.mode === "plan" ? "review" : "build",
        prompt,
        requestId: reservation.requestId,
      });
      await this.storage.acknowledgePromptQueueDispatch(
        queueKey,
        reservation.requestId,
      );
      this.queueRetryAt.delete(queueKey);
    } catch (error) {
      // Keep the in-flight record durable. The same request id is retried after
      // backoff, so an ambiguous provider response cannot become a second turn.
      this.queueRetryAt.set(queueKey, Date.now() + 2_000);
      throw error;
    }
  }

  private async reconcileInitialLaunchOnce(
    environmentId: string,
  ): Promise<void> {
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
    const cacheKey = JSON.stringify([
      input.environmentId,
      input.agent,
      input.model ?? null,
      input.reasoningEffort ?? null,
    ]);
    const cached = this.providers.get(cacheKey);
    if (cached) return cached;

    const environment = await this.storage.getEnvironment(input.environmentId);
    if (!environment || environment.deletionRequestedAt) {
      throw new Error("Native agent environment is unavailable");
    }
    if (this.options.provider) {
      const provider = await this.options.provider(input, environment);
      this.providers.set(cacheKey, provider);
      return provider;
    }
    const connection = await this.bridgeConnection(
      input.agent,
      environment,
      input.model,
      input.reasoningEffort,
    );
    const provider = createBuildPipelineProvider(connection);
    this.providers.set(cacheKey, provider);
    return provider;
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
