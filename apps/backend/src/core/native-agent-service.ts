import { createHash } from "node:crypto";
import type {
  BuildPipelineAgent,
  PipelineSessionPhase,
  TaskSnapshotImage,
} from "@orkestrator/protocol/build-pipeline";
import {
  aggregateAgentActivityState,
  type AgentActivityState,
} from "@orkestrator/protocol/agent-activity";
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
import {
  assertValidPromptAttachments,
  INITIAL_PROMPT_STAGING_DIRECTORY,
  stagePromptImages,
  type PromptAttachment,
} from "./prompt-attachments.js";

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
  /**
   * Execution mode for the session, overriding what the phase implies.
   *
   * Looped-review phases collapse several distinct steps onto `review`, and one
   * of them (preparation) has to commit changes — so a phase-derived read-only
   * Codex session would make that round fail.
   */
  sessionMode?: ProviderExecutionMode;
}

export interface DispatchNativeAgentPromptInput
  extends EnsureNativeAgentSessionInput {
  prompt: string;
  requestId: string;
  /** Base64 images that still need staging into the workspace. */
  images?: TaskSnapshotImage[];
  /** Attachments the caller already staged, carrying workspace paths. */
  attachments?: PromptAttachment[];
  schema?: JsonSchema;
  mode?: ProviderExecutionMode;
  fastMode?: boolean;
  subAgent?: string;
  includeLocalSettings?: boolean;
  promptSuggestions?: boolean;
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

const QUEUE_RETRY_BASE_MS = 2_000;
const QUEUE_RETRY_CEILING_MS = 60_000;
const MAX_QUEUE_DISPATCH_ATTEMPTS = 5;
const LAUNCH_RETRY_MS = 10_000;
const ACTIVITY_STATUS_CONCURRENCY = 8;

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * An agent can only be driven once its environment is running and its setup
 * scripts have finished.
 *
 * The launch path has always checked this. The drain path must too: without it a
 * stopped or still-provisioning environment with a leftover queued prompt makes
 * the backend spawn bridge servers and attempt dispatch every two seconds.
 */
function isEnvironmentReadyForAgents(environment: Environment): boolean {
  return environment.status === "running"
    && environment.setupScriptsComplete === true;
}

const LEGACY_TIMESTAMP_ENVIRONMENT_NAME = /^\d{8}-\d{6}$/;
const COMPACT_TIMESTAMP_ENVIRONMENT_NAME = /^\d{15}$/;

/**
 * True for a name generated before the environment had a prompt-derived title.
 *
 * Twin of `apps/web/src/lib/environment-name.ts` — the renderer applies the same
 * guard on its own send path, and both must agree on which names are renameable.
 */
function isGeneratedEnvironmentName(name: string): boolean {
  return LEGACY_TIMESTAMP_ENVIRONMENT_NAME.test(name)
    || COMPACT_TIMESTAMP_ENVIRONMENT_NAME.test(name);
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
  private readonly queueAttempts = new Map<string, number>();
  private readonly scanTasks = new Set<Promise<void>>();
  private activityScan: Promise<void> | null = null;
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
              attachments: input.attachments,
              schema: input.schema,
              mode: input.mode,
              fastMode: input.fastMode,
              subAgent: input.subAgent,
              includeLocalSettings: input.includeLocalSettings,
              promptSuggestions: input.promptSuggestions,
              model: input.model,
              effort: input.reasoningEffort,
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

  /**
   * Rebuild the durable environment activity projection from provider-owned
   * session state. This does not depend on a mounted tab or a renderer event.
   */
  reconcileAgentActivity(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.activityScan) return this.activityScan;
    const scan = this.trackScan(this.reconcileAgentActivityOnce())
      .finally(() => {
        if (this.activityScan === scan) this.activityScan = null;
      });
    this.activityScan = scan;
    return scan;
  }

  private async reconcileAgentActivityOnce(): Promise<void> {
    const [environments, sessions] = await Promise.all([
      this.storage.loadEnvironments(),
      this.storage.listNativeAgentSessions(),
    ]);
    if (this.stopped) return;

    const environmentsById = new Map(
      environments.map((environment) => [environment.id, environment]),
    );
    const sessionsByEnvironment = new Map<
      string,
      PersistedNativeAgentSession[]
    >();
    for (const session of sessions) {
      if (!environmentsById.has(session.environmentId)) continue;
      const grouped = sessionsByEnvironment.get(session.environmentId) ?? [];
      grouped.push(session);
      sessionsByEnvironment.set(session.environmentId, grouped);
    }

    const activityByEnvironment = new Map<
      string,
      Record<string, { state: AgentActivityState; updatedAt: string }>
    >();
    const failedEnvironments = new Set<string>();
    const groups = new Map<string, PersistedNativeAgentSession[]>();
    for (const [environmentId, environmentSessions] of sessionsByEnvironment) {
      const environment = environmentsById.get(environmentId)!;
      const canRun = environment.environmentType === "local"
        || environment.status === "running";
      if (!canRun || environment.setupScriptsComplete !== true) continue;
      for (const session of environmentSessions) {
        const key = `${environmentId}\0${session.agent}`;
        const grouped = groups.get(key) ?? [];
        grouped.push(session);
        groups.set(key, grouped);
      }
    }

    const pendingGroups = [...groups.values()];
    let nextGroup = 0;
    const worker = async (): Promise<void> => {
      while (!this.stopped) {
        const group = pendingGroups[nextGroup++];
        if (!group) return;
        const first = group[0]!;
        try {
          const provider = await this.provider(first);
          for (const session of group) {
            provider.registerSession?.(session.providerSessionId);
            const activity = provider.activity
              ? await provider.activity(session.providerSessionId)
              : await provider.status(session.providerSessionId).then((status) =>
                  status === "running" ? "working" : "idle"
                );
            if (activity === "missing") {
              await this.storage.invalidateNativeAgentSession(
                session.key,
                session.providerSessionId,
              );
              continue;
            }
            const sources = activityByEnvironment.get(session.environmentId)
              ?? {};
            sources[session.key] = {
              state: activity,
              // Only the state matters for this in-memory aggregate. A real
              // timestamp is supplied once per committed environment below.
              updatedAt: "1970-01-01T00:00:00.000Z",
            };
            activityByEnvironment.set(session.environmentId, sources);
          }
        } catch (error) {
          failedEnvironments.add(first.environmentId);
          console.warn(
            `[native-agent] Activity reconciliation for ${first.environmentId} failed:`,
            error instanceof Error ? error.name : "unknown error",
          );
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(ACTIVITY_STATUS_CONCURRENCY, pendingGroups.length) },
        () => worker(),
      ),
    );
    if (this.stopped) return;

    for (const environment of environments) {
      if (failedEnvironments.has(environment.id)) continue;
      const hasRegisteredSessions = sessionsByEnvironment.has(environment.id);
      const previous = environment.agentActivitySources?.["native-agent"];
      if (!hasRegisteredSessions && !previous) continue;
      const canRun = environment.environmentType === "local"
        || environment.status === "running";
      const desiredState = canRun && environment.setupScriptsComplete === true
        ? aggregateAgentActivityState(
            activityByEnvironment.get(environment.id) ?? {},
          )
        : "idle";
      if (previous?.state === desiredState) continue;
      await this.storage.setEnvironmentAgentActivity(
        environment.id,
        desiredState,
        new Date().toISOString(),
        "native-agent",
      ).catch((error) => {
        console.warn(
          `[native-agent] Failed to persist activity for ${environment.id}:`,
          error instanceof Error ? error.name : "unknown error",
        );
      });
    }
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
    await this.pruneProviders(
      new Set(
        environments
          .filter((environment) => !environment.deletionRequestedAt)
          .map((environment) => environment.id),
      ),
    );
    if (this.stopped) return;
    await Promise.allSettled(
      environments
        .filter((environment) =>
          environment.pendingAgentLaunch
          && isEnvironmentReadyForAgents(environment)
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

  /**
   * Back off a queue and, once the attempts are clearly not transient, park it
   * with a durable error the renderer can show.
   *
   * An unbounded 2s retry is invisible: nothing is logged, no dispatchError is
   * latched, and the user sees a queue that simply never drains.
   */
  private async deferQueue(
    queueKey: string,
    reason: string,
    requestId?: string,
  ): Promise<void> {
    const attempts = (this.queueAttempts.get(queueKey) ?? 0) + 1;
    this.queueAttempts.set(queueKey, attempts);
    if (attempts >= MAX_QUEUE_DISPATCH_ATTEMPTS) {
      // The key and the reason are safe to log; the prompt itself never is.
      console.warn(
        `[native-agent] Prompt queue ${queueKey} has failed ${attempts} times: ${reason}`,
      );
      if (requestId !== undefined) {
        this.queueAttempts.delete(queueKey);
        this.queueRetryAt.delete(queueKey);
        await this.storage.failPromptQueueDispatch(queueKey, requestId, reason);
        return;
      }
    }
    // Exponential up to a ceiling so a wedged provider is retried rarely rather
    // than every two seconds forever.
    const backoff = Math.min(
      QUEUE_RETRY_CEILING_MS,
      QUEUE_RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 8),
    );
    this.queueRetryAt.set(queueKey, Date.now() + backoff);
  }

  private clearQueueBackoff(queueKey: string): void {
    this.queueAttempts.delete(queueKey);
    this.queueRetryAt.delete(queueKey);
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
    try {
      await this.drainReadyPromptQueue(queueKey);
    } catch (error) {
      // Any fault that escapes the drain must still back off. A storage read or
      // reservation that throws bypasses every inner handler, and the scan's
      // `allSettled` swallows the rejection — so without this the queue was
      // retried every two seconds with no attempt counter, no latch and no log:
      // the same invisible hot loop deferQueue exists to prevent, reached
      // through a storage fault instead of a provider fault.
      await this.deferQueue(
        queueKey,
        error instanceof Error ? error.name : "unknown drain error",
      ).catch(() => undefined);
    }
  }

  private async drainReadyPromptQueue(queueKey: string): Promise<void> {
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
    const environment = await this.assertEnvironmentLive(queue.environmentId);
    // The launch path has always required this; so must the drain path. A
    // stopped or still-provisioning environment must not be started by a
    // leftover queued prompt.
    if (!isEnvironmentReadyForAgents(environment)) {
      await this.deferQueue(queueKey, "environment is not ready for agents");
      return;
    }
    const draftKey =
      `${agent}:${queue.environmentId}:${encodeURIComponent(logicalSessionKey)}`;
    const draft = await this.storage.getComposeDraft(draftKey);
    if (this.composeDraftHoldsQueue(draft?.value)) return;

    const head = queue.inFlight?.message ?? queue.messages[0];
    const mode = this.queueExecutionMode(agent, head);
    const session = await this.ensureSession({
      environmentId: queue.environmentId,
      agent,
      logicalSessionKey,
      model: this.queueString(head, "model"),
      reasoningEffort: this.queueReasoningEffort(head),
      phase: mode === "plan" ? "review" : "build",
    });
    const provider = await this.provider({
      environmentId: queue.environmentId,
      agent,
      logicalSessionKey,
      model: this.queueString(head, "model"),
      reasoningEffort: this.queueReasoningEffort(head),
    });
    await this.assertEnvironmentLive(queue.environmentId);
    const status = await provider.status(session.providerSessionId);
    await this.assertEnvironmentLive(queue.environmentId);
    if (status === "running") return;
    if (status !== "idle") {
      await this.deferQueue(
        queueKey,
        `provider session is ${status}`,
        queue.inFlight?.requestId,
      );
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

    // Queued attachments were staged by the renderer, so they already carry
    // workspace paths and can be attached for real. Flattening them into prose
    // silently degraded an image to a filename the model had to guess at.
    let attachments: PromptAttachment[] = [];
    try {
      attachments = Array.isArray(message.attachments)
        ? assertValidPromptAttachments(message.attachments)
        : [];
    } catch (error) {
      const reason = error instanceof Error
        ? error.message
        : "Queued attachment is invalid";
      await this.storage.failPromptQueueDispatch(
        queueKey,
        reservation.requestId,
        reason,
      );
      this.clearQueueBackoff(queueKey);
      return;
    }
    try {
      // Only the first prompt in a session names the environment, and only while
      // it still carries a generated name — the same guard the renderer applied
      // before draining moved to the backend.
      if ((session.dispatchedRequestIds?.length ?? 0) === 0) {
        await this.renameEnvironmentFromFirstPrompt(
          queue.environmentId,
          message.text,
        );
      }
      await this.dispatchPrompt({
        environmentId: queue.environmentId,
        agent,
        logicalSessionKey,
        model: this.queueString(message, "model"),
        reasoningEffort: this.queueReasoningEffort(message),
        phase: this.queueExecutionMode(agent, message) === "plan"
          ? "review"
          : "build",
        mode: this.queueExecutionMode(agent, message),
        fastMode: this.queueFastMode(agent, message),
        subAgent: this.queueString(message, "agent"),
        includeLocalSettings: this.queueBoolean(message, "includeLocalSettings"),
        promptSuggestions: this.queueBoolean(message, "promptSuggestions"),
        attachments,
        prompt: message.text,
        requestId: reservation.requestId,
      });
      await this.storage.acknowledgePromptQueueDispatch(
        queueKey,
        reservation.requestId,
      );
      this.clearQueueBackoff(queueKey);
    } catch (error) {
      if (error instanceof PromptRejectedError) {
        await this.storage.failPromptQueueDispatch(
          queueKey,
          reservation.requestId,
          error.message,
        );
        this.clearQueueBackoff(queueKey);
        return;
      }
      // Keep the in-flight record durable. The same request id is retried after
      // backoff, so an ambiguous provider response cannot become a second turn.
      // Handled here rather than rethrown so the attempt is counted once, with
      // the reservation id the latch needs.
      await this.deferQueue(
        queueKey,
        error instanceof Error ? error.name : "unknown dispatch error",
        reservation.requestId,
      );
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
      || !isEnvironmentReadyForAgents(environment)
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
      // Passed as base64 rather than staged here: the provider stages inside the
      // durable dispatch lock, so only the supervisor that actually wins the
      // launch writes the file. Staging first would have every supervisor write
      // the same path concurrently.
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
      // A rejection is the provider's verdict on this prompt, not a transient
      // fault: retrying it every ten seconds forever would never succeed and
      // leaves the environment hidden-mounted and polled for the life of the
      // app. Stop retrying and let the surfaced error stand.
      const terminal = error instanceof PromptRejectedError;
      console.warn(
        `[native-agent] Startup launch for ${environment.id} failed`
        + `${terminal ? " permanently" : ""}: `
        + (error instanceof Error ? error.name : "unknown error"),
      );
      if (!terminal) this.launchRetryAt.set(environment.id, Date.now() + LAUNCH_RETRY_MS);
      await this.storage.updateEnvironment(environment.id, {
        ...(terminal
          ? {
              pendingAgentLaunch: false,
              initialPromptAttachments: undefined,
            }
          : {}),
        startupAgentSession: {
          tabId: "startup-agent",
          agent,
          style: "native",
          model,
          reasoningEffort,
          status: "error",
          error: terminal
            ? `The agent rejected the initial prompt: ${error.message}`
            : "Agent launch failed; the backend will retry.",
        },
      });
      throw error;
    }
  }

  /**
   * Name the environment from its first prompt.
   *
   * Draining moved out of the renderer, and this call moved with the rest of
   * `handleSend` — so an environment whose first prompt arrived through the
   * queue kept its generated timestamp name. A failure here must never block the
   * prompt: the name is cosmetic, the dispatch is not.
   */
  private async renameEnvironmentFromFirstPrompt(
    environmentId: string,
    prompt: unknown,
  ): Promise<void> {
    if (!nonBlank(prompt)) return;
    const environment = await this.storage.getEnvironment(environmentId);
    if (!environment || !isGeneratedEnvironmentName(environment.name)) return;
    try {
      await this.invoke("rename_environment_from_prompt", {
        environmentId,
        prompt,
      });
    } catch (error) {
      console.warn(
        `[native-agent] Failed to rename ${environmentId} from its first prompt:`,
        error instanceof Error ? error.name : "unknown error",
      );
    }
  }

  /**
   * One provider per environment and agent.
   *
   * Model and effort are deliberately excluded from the key and passed per call
   * instead: keying on them accumulated an undisposed provider — and for
   * OpenCode a permanent event stream — for every variant a user ever queued.
   */
  private async provider(
    input: EnsureNativeAgentSessionInput,
  ): Promise<BuildPipelineProvider> {
    this.assertAcceptingWork();
    const cacheKey = `${input.environmentId}\0${input.agent}`;
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
    const provider = createBuildPipelineProvider(connection, {
      // Interactive sessions belong to a tab that renders approvals and
      // questions. Answering them here would run a command the user never saw
      // and cancel the card that exists to answer it.
      autoAnswerRequests: false,
      stageImages: (images) =>
        this.stageImages(input.environmentId, images),
    });
    this.providers.set(cacheKey, provider);
    return provider;
  }

  /** Stage base64 images into the workspace so a bridge will accept them. */
  private async stageImages(
    environmentId: string,
    images: readonly TaskSnapshotImage[],
  ): Promise<PromptAttachment[]> {
    const environment = await this.assertEnvironmentLive(environmentId);
    return stagePromptImages(
      this.invoke,
      environment,
      images,
      INITIAL_PROMPT_STAGING_DIRECTORY,
    );
  }

  /**
   * Dispose providers whose environment has gone away.
   *
   * Without this a deleted environment's provider stays cached for the life of
   * the process, holding its bridge connection open.
   */
  private async pruneProviders(liveEnvironmentIds: Set<string>): Promise<void> {
    const stale: Array<[string, BuildPipelineProvider]> = [];
    for (const [cacheKey, provider] of this.providers) {
      const environmentId = cacheKey.slice(0, cacheKey.indexOf("\0"));
      if (!liveEnvironmentIds.has(environmentId)) stale.push([cacheKey, provider]);
    }
    if (stale.length === 0) return;
    for (const [cacheKey] of stale) this.providers.delete(cacheKey);
    await Promise.allSettled(stale.map(([, provider]) => provider.dispose?.()));
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
      {
        clientSessionKey: input.logicalSessionKey,
        model: input.model,
        effort: input.reasoningEffort,
        mode: input.sessionMode,
      },
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

  private queueBoolean(message: unknown, field: string): boolean | undefined {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return undefined;
    }
    const value = (message as Record<string, unknown>)[field];
    return typeof value === "boolean" ? value : undefined;
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
