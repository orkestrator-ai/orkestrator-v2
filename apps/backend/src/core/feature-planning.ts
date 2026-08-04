import { randomUUID } from "node:crypto";
import {
  FEATURE_PLANNING_LIMITS,
  FEATURE_PLANNING_RECORD_VERSION,
  boundRawResponse,
  createStoryCardsFromParsedState,
  createStoryRefinementPrompt,
  isActiveFeaturePlanningPhase,
  isFeaturePlanningRecord,
  isStartFeaturePlanningInput,
  isTerminalFeaturePlanningPhase,
  parseFeaturePlannerState,
  parseStoryRefinement,
  selectFeaturePlannerPrompt,
  type ActiveFeaturePlanningPhase,
  type FeaturePlanningFailureCode,
  type FeaturePlanningRecord,
  type StartFeaturePlanningInput,
} from "@orkestrator/protocol/feature-planning";
import {
  AmbiguousPromptDispatchError,
  createBuildPipelineProvider,
  type BuildPipelineProvider,
} from "./build-pipeline-provider.js";
import {
  FeaturePlanningFenceError,
  type FeaturePlan,
  type FeaturePlanMessage,
  type StorageService,
} from "./storage.js";
import type { Environment } from "./models.js";

type CommandInvoker = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

const DEFAULT_POLL_MS = 1_000;
/** How long the environment may take to reach `running` before the turn fails. */
const ENVIRONMENT_READY_DEADLINE_MS = 15 * 60_000;
/** How long a dispatched turn may run before it is reported as stuck. */
const REPLY_DEADLINE_MS = 10 * 60_000;
/**
 * Grace period for an idle session with no new assistant message.
 *
 * A dispatch whose response was lost may never have reached the bridge. Without
 * this the record would sit in `running` until the reply deadline and then
 * claim Codex is still working about a session doing nothing.
 */
const IDLE_WITHOUT_REPLY_MS = 8_000;

/** Bridge transcript entry, validated before anything is read out of it. */
interface BridgeMessage {
  id: string;
  role: string;
  content?: string;
  parts?: Array<{ type?: string; content?: string }>;
  createdAt?: string;
  modelId?: string;
}

interface AssistantReply {
  id: string;
  content: string;
  modelId?: string;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * A failure the record should stop on rather than retry from the tick loop.
 *
 * Transient provider errors are left to the next tick; this marks the ones that
 * need a user decision.
 */
class DefiniteFeaturePlanningError extends Error {
  constructor(
    readonly code: FeaturePlanningFailureCode,
    readonly retryPhase: ActiveFeaturePlanningPhase,
    text: string,
  ) {
    super(text);
    this.name = "DefiniteFeaturePlanningError";
  }
}

function isBridgeMessage(value: unknown): value is BridgeMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string"
    && candidate.id.length > 0
    && candidate.id.length <= FEATURE_PLANNING_LIMITS.maxIdLength
    && typeof candidate.role === "string";
}

function bridgeMessageContent(entry: BridgeMessage): string {
  if (entry.content?.trim()) return entry.content;
  return (entry.parts ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.content ?? "")
    .join("\n")
    .trim();
}

function assistantMessageIds(messages: readonly BridgeMessage[]): string[] {
  return messages
    .filter((entry) => entry.role === "assistant")
    .map((entry) => entry.id)
    .filter((id) => id.length <= FEATURE_PLANNING_LIMITS.maxIdLength)
    .slice(-FEATURE_PLANNING_LIMITS.maxBaselineAssistantIds);
}

/**
 * The newest assistant message the caller has not already seen.
 *
 * Identity comes from the baseline id set captured before dispatch, not from a
 * timestamp, so it survives a reload and a clock the backend does not own.
 */
function latestAssistantReply(
  messages: readonly BridgeMessage[],
  baseline: ReadonlySet<string>,
  accept?: (content: string) => boolean,
  createdAfter?: string,
): AssistantReply | null {
  const minimumCreatedAt = createdAfter ? Date.parse(createdAfter) : null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index];
    if (!entry || entry.role !== "assistant") continue;
    // The baseline is deliberately bounded. Stop at its newest surviving
    // anchor instead of continuing into older, omitted history and mistaking
    // that history for this turn's response.
    if (baseline.has(entry.id)) break;
    if (minimumCreatedAt !== null) {
      const createdAt = entry.createdAt ? Date.parse(entry.createdAt) : Number.NaN;
      if (!Number.isFinite(minimumCreatedAt) || !Number.isFinite(createdAt)
        || createdAt < minimumCreatedAt) continue;
    }
    const content = bridgeMessageContent(entry);
    if (!content.trim()) continue;
    if (accept && !accept(content)) continue;
    return { id: entry.id, content, ...(entry.modelId ? { modelId: entry.modelId } : {}) };
  }
  return null;
}

export interface FeaturePlanningServiceOptions {
  autoAdvance?: boolean;
  pollIntervalMs?: number;
  environmentReadyDeadlineMs?: number;
  replyDeadlineMs?: number;
  idleWithoutReplyMs?: number;
  /** Test seam; production builds a codex provider per environment. */
  provider?: (environmentId: string) => Promise<BuildPipelineProvider>;
}

/**
 * Backend-owned controller for the feature/story planning conversation.
 *
 * The workflow used to live in `FeaturesView`, which only renders when no
 * environment is selected — so clicking into an environment unmounted it and
 * abandoned the in-flight reply, and a reload during the persist step destroyed
 * an answer the renderer was holding as its only copy. Here the record is
 * durable at every step, and the reply is written to it before anything is
 * applied to the plan.
 */
export class FeaturePlanningService {
  private readonly locks = new Map<string, Promise<void>>();
  private readonly scheduledRuns = new Map<string, { pending: boolean; promise: Promise<void> }>();
  private readonly providers = new Map<string, BuildPipelineProvider>();
  /** Feature id → when the session was first seen idle with no new reply. */
  private readonly idleSince = new Map<string, number>();
  /** Feature id -> operation id requested for cancellation. */
  private readonly cancellationRequests = new Map<string, string>();
  /** Operation ids whose provider turn has already been aborted. */
  private readonly cancellationAborts = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickRun: { pending: boolean; promise: Promise<void> } | null = null;
  private stopped = false;

  constructor(
    private readonly storage: StorageService,
    private readonly invoke: CommandInvoker,
    private readonly options: FeaturePlanningServiceOptions = {},
  ) {}

  async init(): Promise<void> {
    this.stopped = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.adoptLegacyConversations().catch((error) => {
      console.warn("[feature-planning] Failed to adopt legacy conversations:", message(error));
    });
    if (this.options.autoAdvance === false) return;
    this.timer = setInterval(
      () => void this.requestTick(),
      this.options.pollIntervalMs ?? DEFAULT_POLL_MS,
    );
    this.timer.unref?.();
    // Deliberately not awaited: requestTick loops while the interval re-arms
    // it, so awaiting here would hold up backend startup for as long as ticks
    // keep exceeding the poll interval.
    void this.requestTick();
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.allSettled([
      ...this.locks.values(),
      ...[...this.scheduledRuns.values()].map((entry) => entry.promise),
      ...(this.tickRun ? [this.tickRun.promise] : []),
    ]);
    await Promise.allSettled(
      [...this.providers.values()].map((provider) => provider.dispose?.()),
    );
    this.providers.clear();
    this.idleSince.clear();
    this.cancellationRequests.clear();
    this.cancellationAborts.clear();
  }

  /**
   * Attaches a planning exchange and returns immediately.
   *
   * Everything after this — environment, bridge, session, dispatch, reply,
   * parse, persist — is advanced by the tick loop, so the caller may go away.
   */
  async start(input: StartFeaturePlanningInput): Promise<FeaturePlanningRecord> {
    if (!isStartFeaturePlanningInput(input)) {
      throw new Error("Invalid feature planning request");
    }
    const plan = await this.storage.getFeaturePlan(input.featureId);
    if (!plan) throw new Error(`Feature plan not found: ${input.featureId}`);
    if (input.kind === "story") {
      const story = plan.stories.find((candidate) => candidate.id === input.storyId);
      if (!story) throw new Error(`Feature story not found: ${input.storyId}`);
    }
    const timestamp = nowIso();
    const record: FeaturePlanningRecord = {
      version: FEATURE_PLANNING_RECORD_VERSION,
      operationId: randomUUID(),
      featureId: plan.id,
      projectId: plan.projectId,
      kind: input.kind,
      ...(input.kind === "story" ? { storyId: input.storyId } : {}),
      userMessage: input.userMessage,
      ...(plan.codexEnvironmentId ? { environmentId: plan.codexEnvironmentId } : {}),
      phase: "dispatching",
      startedAt: timestamp,
      attemptStartedAt: timestamp,
      updatedAt: timestamp,
      backendRevision: 0,
    };
    const { started, feature } = await this.storage.startFeaturePlanning(record);
    if (!started) {
      throw new Error("A planning request is already running for this feature");
    }
    // The user's message is persisted by the backend so the transcript and the
    // record agree even if the caller never comes back.
    await this.storage.mutateFeaturePlanning(feature.id, record.operationId, (plan, current) => {
      const persisted = this.appendMessage(plan, current, "user", input.userMessage);
      current.userMessageId = persisted.id;
    });
    void this.runLocked(plan.id);
    return (await this.read(plan.id)) ?? record;
  }

  /** Every record for a project, including terminal ones the UI still renders. */
  async snapshot(projectId: string): Promise<FeaturePlanningRecord[]> {
    const plans = await this.storage.getFeaturePlans(projectId);
    return plans
      .map((plan) => plan.planning)
      .filter((record): record is FeaturePlanningRecord => isFeaturePlanningRecord(record));
  }

  async retry(featureId: string): Promise<FeaturePlanningRecord> {
    const record = await this.read(featureId);
    if (!record) throw new Error("There is no planning request to retry");
    if (record.phase !== "failed") return record;
    const retryPhase = record.failure?.retryPhase ?? "dispatching";
    await this.storage.mutateFeaturePlanning(featureId, record.operationId, (_plan, current) => {
      current.phase = retryPhase;
      delete current.failure;
      if (retryPhase === "dispatching") {
        // A new attempt is a new turn: the previous dispatch is abandoned
        // rather than resumed, so its id must not fence the next one.
        delete current.dispatchId;
        delete current.requestId;
        delete current.dispatchState;
        delete current.rawResponse;
        delete current.responseModelId;
        delete current.responseMessageId;
        delete current.dispatchedAt;
        current.attemptStartedAt = nowIso();
      }
    });
    void this.runLocked(featureId);
    return (await this.read(featureId)) ?? record;
  }

  /**
   * Abandons the exchange, aborting the provider turn when one is running.
   *
   * The reply, if it already arrived, stays on the plan: cancelling stops the
   * workflow, it does not retract what the agent said.
   */
  async cancel(featureId: string): Promise<void> {
    const record = await this.read(featureId);
    if (!record) return;
    this.cancellationRequests.set(featureId, record.operationId);
    try {
      // Do not wait behind a provider call that may itself be hung. The
      // dispatch record is stamped before send, so once it is present we can
      // ask the bridge to abort immediately; the locked pass below remains the
      // authoritative re-read/clear fence.
      await this.abortForCancellation(record);
      await this.withLock(featureId, async () => {
        const current = await this.read(featureId);
        if (!current || current.operationId !== record.operationId) return;
        await this.abortForCancellation(current);
        this.idleSince.delete(featureId);
        await this.storage.clearFeaturePlanning(featureId, current.operationId);
      });
    } finally {
      if (this.cancellationRequests.get(featureId) === record.operationId) {
        this.cancellationRequests.delete(featureId);
      }
      this.cancellationAborts.delete(record.operationId);
    }
  }

  advanceNow(featureId: string): Promise<void> {
    return this.runLocked(featureId);
  }

  /* ---------------------------------------------------------------- *
   * Scheduling
   * ---------------------------------------------------------------- */

  private requestTick(): Promise<void> {
    if (this.tickRun) {
      this.tickRun.pending = true;
      return this.tickRun.promise;
    }
    const run = { pending: false, promise: Promise.resolve() };
    run.promise = (async () => {
      do {
        run.pending = false;
        await this.tick();
      } while (run.pending && !this.stopped);
    })().finally(() => {
      if (this.tickRun === run) this.tickRun = null;
    });
    this.tickRun = run;
    return run.promise;
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    const records = await this.storage.listActiveFeaturePlanning().catch(() => []);
    await Promise.all(records.map((record) => this.runLocked(record.featureId)));
  }

  private runLocked(featureId: string): Promise<void> {
    const existing = this.scheduledRuns.get(featureId);
    if (existing) {
      existing.pending = true;
      return existing.promise;
    }
    const run = { pending: false, promise: Promise.resolve() };
    run.promise = (async () => {
      do {
        run.pending = false;
        await this.withLock(featureId, async () => {
          try {
            await this.advance(featureId);
          } catch (error) {
            await this.fail(featureId, error).catch(() => undefined);
          }
        });
      } while (run.pending && !this.stopped);
    })().finally(() => {
      if (this.scheduledRuns.get(featureId) === run) this.scheduledRuns.delete(featureId);
    });
    this.scheduledRuns.set(featureId, run);
    return run.promise;
  }

  private withLock(featureId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.locks.get(featureId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.locks.set(featureId, current);
    const release = () => {
      if (this.locks.get(featureId) === current) this.locks.delete(featureId);
    };
    // Passing both handlers to `then` releases the lock without deriving a new
    // rejected promise nobody is attached to.
    current.then(release, release);
    return current;
  }

  /* ---------------------------------------------------------------- *
   * The workflow
   * ---------------------------------------------------------------- */

  private async advance(featureId: string): Promise<void> {
    const record = await this.read(featureId);
    if (!record || !isActiveFeaturePlanningPhase(record.phase)) return;
    if (await this.clearIfCancellationRequested(record)) return;
    if (record.phase === "dispatching") return await this.runDispatch(record);
    if (record.phase === "running") return await this.runAwaitReply(record);
    return await this.runPersist(record);
  }

  private async runDispatch(record: FeaturePlanningRecord): Promise<void> {
    // A dispatch id already on the record means the prompt may have reached the
    // bridge. Re-sending would run the turn twice, so the exchange reconciles
    // by reading the transcript instead.
    if (record.dispatchId) {
      await this.update(record, (_plan, current) => {
        current.phase = "running";
        current.dispatchState = "sent";
        // `updatedAt` is the durable prepared timestamp. Using wall-clock now
        // after a restart would grant an old ambiguous turn a fresh deadline.
        current.dispatchedAt ??= current.updatedAt;
      });
      return;
    }
    const attemptStartedAt = record.attemptStartedAt ?? record.startedAt;
    if (Date.now() - Date.parse(attemptStartedAt) > this.environmentDeadlineMs()) {
      throw new DefiniteFeaturePlanningError(
        "environment",
        "dispatching",
        "The planning environment did not become ready in time",
      );
    }
    const environment = await this.ensureEnvironment(record);
    if (!environment) return;
    const provider = await this.provider(environment.id);
    const session = await this.ensureSession(record, environment.id, provider);
    const sessionId = session.sessionId;
    if (await this.clearIfCancellationRequested(record)) return;
    const plan = await this.storage.getFeaturePlan(record.featureId);
    if (!plan) throw new DefiniteFeaturePlanningError(
      "persistence",
      "dispatching",
      "The feature plan no longer exists",
    );
    const baseline = assistantMessageIds(await this.providerOperation(
      environment.id,
      provider,
      () => this.messages(provider, sessionId),
    ));
    const prompt = this.buildPrompt(plan, record, sessionId, session.created);
    const requestId = randomUUID();
    const dispatchId = randomUUID();
    // Recorded before the send, so a crash between the two is resolved by
    // reconciling rather than by dispatching a second time.
    await this.update(record, (_current, current) => {
      current.dispatchId = dispatchId;
      current.requestId = requestId;
      current.dispatchState = "prepared";
      current.baselineAssistantIds = baseline;
      current.providerSessionId = sessionId;
    });
    if (await this.clearIfCancellationRequested(record)) return;
    const config = await this.storage.loadConfig();
    try {
      await provider.send(sessionId, prompt, {
        requestId,
        mode: "plan",
        ...(config.global.codexNativeFastModeDefault ? { fastMode: true } : {}),
      });
    } catch (error) {
      if (error instanceof AmbiguousPromptDispatchError) {
        await this.evictProvider(environment.id, provider);
        if (await this.clearIfCancellationRequested(record, provider, sessionId)) return;
        // Whether the prompt ran is unknowable. Move to `running`: the reply
        // watcher settles it from the transcript either way.
        await this.update(record, (_plan, current) => {
          current.phase = "running";
          current.dispatchState = "sent";
          current.dispatchedAt = nowIso();
        });
        return;
      }
      throw new DefiniteFeaturePlanningError("dispatch", "dispatching", message(error));
    }
    if (await this.clearIfCancellationRequested(record, provider, sessionId)) return;
    await this.update(record, (_plan, current) => {
      current.dispatchState = "sent";
      current.dispatchedAt = nowIso();
      current.phase = "running";
    });
  }

  private async runAwaitReply(record: FeaturePlanningRecord): Promise<void> {
    if (!record.environmentId || !record.providerSessionId) {
      throw new DefiniteFeaturePlanningError(
        "provider",
        "dispatching",
        "The planning session was lost before a reply arrived",
      );
    }
    const provider = await this.provider(record.environmentId);
    const activity = await this.providerOperation(record.environmentId, provider, async () => (
      provider.activity
        ? await provider.activity(record.providerSessionId!)
        : (await provider.status(record.providerSessionId!)) === "idle"
          ? "idle" as const
          : "working" as const
    ));
    if (activity === "missing") {
      throw new DefiniteFeaturePlanningError(
        "provider",
        "dispatching",
        "The Codex planning session no longer exists; retry creates a replacement",
      );
    }
    const baseline = new Set(record.baselineAssistantIds ?? []);
    const messages = await this.providerOperation(
      record.environmentId,
      provider,
      () => this.messages(provider, record.providerSessionId!),
    );
    const reply = record.kind === "story"
      // A story refinement only counts once the state block is present;
      // otherwise a preamble turn would be applied as the answer.
      ? latestAssistantReply(messages, baseline, (content) => {
          const parsed = parseStoryRefinement(content);
          return parsed !== null
            && (parsed.storyId === undefined || parsed.storyId === record.storyId);
        }, record.requestId ? undefined : record.startedAt)
      : latestAssistantReply(
          messages,
          baseline,
          undefined,
          record.requestId ? undefined : record.startedAt,
        );

    if (reply && activity === "idle") {
      this.idleSince.delete(record.featureId);
      await this.update(record, (_plan, current) => {
        current.rawResponse = boundRawResponse(reply.content);
        if (reply.modelId) current.responseModelId = reply.modelId;
        current.phase = "persisting";
      });
      return;
    }
    if (activity === "idle" && !reply) {
      const since = this.idleSince.get(record.featureId) ?? Date.now();
      this.idleSince.set(record.featureId, since);
      if (Date.now() - since >= this.idleWithoutReplyMs()) {
        throw new DefiniteFeaturePlanningError(
          "dispatch",
          "dispatching",
          "Codex did not receive the prompt. Retry to send it again.",
        );
      }
      return;
    }
    this.idleSince.delete(record.featureId);
    const dispatchedAt = record.dispatchedAt ?? record.updatedAt ?? record.startedAt;
    if (Date.now() - Date.parse(dispatchedAt) > this.replyDeadlineMs()) {
      throw new DefiniteFeaturePlanningError(
        "provider",
        "dispatching",
        "Codex did not finish this planning turn in time",
      );
    }
  }

  /**
   * Applies a reply that is already durable.
   *
   * Split in two so a crash between them is recoverable: the assistant message
   * is appended and its id recorded first, then the state block is applied. The
   * message carries `stateApplication: "pending"` until the second half lands,
   * which is what makes a replay idempotent.
   */
  private async runPersist(record: FeaturePlanningRecord): Promise<void> {
    const raw = record.rawResponse;
    if (!raw) {
      throw new DefiniteFeaturePlanningError(
        "persistence",
        "dispatching",
        "The planning reply was lost before it could be applied",
      );
    }
    if (!record.responseMessageId) {
      await this.update(record, (plan, current) => {
        const existing = this.findPersistedResponse(plan, current, raw);
        const persisted = existing ?? this.appendMessage(
          plan,
          current,
          "assistant",
          raw,
          "pending",
          current.responseModelId,
        );
        current.responseMessageId = persisted.id;
      });
      const refreshed = await this.read(record.featureId);
      if (!refreshed) return;
      record = refreshed;
    }
    const parsed = record.kind === "story"
      ? parseStoryRefinement(raw)
      : parseFeaturePlannerState(raw);
    if (!parsed) {
      // The reply is on the plan and on the record. Only the structured half
      // failed, so this stops for a user decision without losing anything.
      throw new DefiniteFeaturePlanningError(
        "parse",
        "dispatching",
        record.kind === "story"
          ? "The reply did not contain a story refinement block"
          : "The reply did not contain a feature planner state block",
      );
    }
    // Applying the state block and detaching the record are one write: a
    // `complete` record left attached by a crash between two writes would sit
    // on the plan forever, since nothing sweeps terminal records.
    await this.update(record, (plan, current) => {
      if (current.kind === "story") this.applyStoryRefinement(plan, current);
      else this.applyFeaturePlannerState(plan, current);
      delete plan.planning;
    });
    this.idleSince.delete(record.featureId);
  }

  /* ---------------------------------------------------------------- *
   * Plan mutation (runs inside the storage mutation, never on its own)
   * ---------------------------------------------------------------- */

  private appendMessage(
    plan: FeaturePlan,
    record: FeaturePlanningRecord,
    role: FeaturePlanMessage["role"],
    content: string,
    stateApplication?: FeaturePlanMessage["stateApplication"],
    modelId?: string,
  ): FeaturePlanMessage {
    const entry: FeaturePlanMessage = {
      id: randomUUID(),
      role,
      content,
      createdAt: nowIso(),
      ...(modelId ? { modelId } : {}),
      ...(stateApplication ? { stateApplication } : {}),
    };
    const target = this.messageTarget(plan, record);
    target.push(entry);
    return entry;
  }

  private messageTarget(
    plan: FeaturePlan,
    record: FeaturePlanningRecord,
  ): FeaturePlanMessage[] {
    if (record.kind !== "story") return plan.messages;
    const story = plan.stories.find((candidate) => candidate.id === record.storyId);
    if (!story) {
      throw new DefiniteFeaturePlanningError(
        "persistence",
        "persisting",
        "The story this refinement belongs to no longer exists",
      );
    }
    story.updatedAt = nowIso();
    return story.messages;
  }

  /**
   * Finds a reply already appended by an earlier attempt.
   *
   * Without this a crash between appending and recording the id would append
   * the same answer twice on the next pass.
   */
  private findPersistedResponse(
    plan: FeaturePlan,
    record: FeaturePlanningRecord,
    content: string,
  ): FeaturePlanMessage | undefined {
    const messages = this.messageTarget(plan, record);
    const userIndex = record.userMessageId
      ? messages.findIndex((entry) => entry.id === record.userMessageId)
      : -1;
    for (let index = messages.length - 1; index > userIndex; index -= 1) {
      const entry = messages[index];
      if (entry?.role === "assistant" && entry.content === content) return entry;
    }
    return undefined;
  }

  private applyFeaturePlannerState(
    plan: FeaturePlan,
    record: FeaturePlanningRecord,
  ): void {
    const parsed = parseFeaturePlannerState(record.rawResponse ?? "");
    if (!parsed) return;
    // A plan that has moved on to building must not be dragged back to an
    // earlier planning status by a reply that was in flight when it started.
    const preserveLaterBuildState = plan.status === "building" || plan.status === "built";
    if (!preserveLaterBuildState) {
      if (parsed.title?.trim()) plan.title = parsed.title.trim();
      if (parsed.summary !== undefined) plan.summary = parsed.summary;
      if (parsed.phase === "collecting") plan.status = "collecting";
      if (parsed.phase === "confirming") plan.status = "confirming";
      if (parsed.phase === "stories") {
        plan.status = "stories";
        plan.stories = createStoryCardsFromParsedState(parsed, plan.stories, {
          now: nowIso(),
          newStoryId: randomUUID,
        });
      }
    }
    this.resolveStateApplications(
      plan,
      record,
      preserveLaterBuildState ? "superseded" : "applied",
    );
  }

  private applyStoryRefinement(
    plan: FeaturePlan,
    record: FeaturePlanningRecord,
  ): void {
    const parsed = parseStoryRefinement(record.rawResponse ?? "");
    const story = plan.stories.find((candidate) => candidate.id === record.storyId);
    if (!parsed) return;
    if (!story) {
      throw new DefiniteFeaturePlanningError(
        "persistence",
        "dispatching",
        "The story this refinement belongs to no longer exists",
      );
    }
    if (parsed.storyId !== undefined && parsed.storyId !== record.storyId) {
      throw new DefiniteFeaturePlanningError(
        "parse",
        "dispatching",
        "The reply belongs to a different story",
      );
    }
    if (parsed.title?.trim()) story.title = parsed.title.trim();
    if (parsed.description?.trim()) story.description = parsed.description.trim();
    if (parsed.acceptanceCriteria) story.acceptanceCriteria = parsed.acceptanceCriteria;
    story.updatedAt = nowIso();
    this.resolveStateApplications(plan, record, "applied");
  }

  /**
   * Settles the recovery markers: this reply becomes `applied` (or
   * `superseded`), and every earlier `pending` marker in the same thread is
   * superseded because a later state block has now overwritten it.
   */
  private resolveStateApplications(
    plan: FeaturePlan,
    record: FeaturePlanningRecord,
    outcome: "applied" | "superseded",
  ): void {
    const messages = this.messageTarget(plan, record);
    for (const entry of messages) {
      if (entry.stateApplication !== "pending") continue;
      entry.stateApplication = entry.id === record.responseMessageId
        ? outcome
        : "superseded";
    }
  }

  /* ---------------------------------------------------------------- *
   * Environment, bridge and session
   * ---------------------------------------------------------------- */

  /**
   * Returns the running planning environment, creating and starting it when
   * needed. A `null` return means "not ready yet, try next tick".
   */
  private async ensureEnvironment(
    record: FeaturePlanningRecord,
  ): Promise<Environment | null> {
    const plan = await this.storage.getFeaturePlan(record.featureId);
    if (!plan) {
      throw new DefiniteFeaturePlanningError(
        "persistence",
        "dispatching",
        "The feature plan no longer exists",
      );
    }
    let environment = plan.codexEnvironmentId
      ? await this.storage.getEnvironment(plan.codexEnvironmentId)
      : null;
    if (environment?.deletionRequestedAt) environment = null;
    if (!environment) {
      environment = await this.createEnvironment(plan);
      await this.storage.updateFeaturePlan(plan.id, {
        codexEnvironmentId: environment.id,
      });
      await this.update(record, (_plan, current) => {
        current.environmentId = environment!.id;
        // A replacement environment cannot host the old session.
        delete current.providerSessionId;
      });
    }
    if (environment.status !== "running") {
      await this.invoke("start_environment_background", { environmentId: environment.id });
      return null;
    }
    if (record.environmentId !== environment.id) {
      await this.update(record, (_plan, current) => {
        current.environmentId = environment!.id;
      });
    }
    return environment;
  }

  private async createEnvironment(plan: FeaturePlan): Promise<Environment> {
    const config = await this.storage.loadConfig();
    const project = await this.storage.getProject(plan.projectId);
    const environmentType = config.repositories[plan.projectId]?.lastEnvironmentType
      ?? (project?.localPath ? "local" : "containerized");
    const created = await this.invoke<Environment>("create_environment", {
      projectId: plan.projectId,
      name: `feature-plan-${plan.title || "new-feature"}`,
      networkAccessMode: environmentType === "containerized" ? "restricted" : "full",
      environmentType,
      namingPrompt: plan.summary || plan.title,
    });
    return await this.invoke<Environment>("update_environment_agent_settings", {
      environmentId: created.id,
      defaultAgent: "codex",
      claudeMode: null,
      claudeNativeBackend: null,
      opencodeMode: null,
      codexMode: "native",
    });
  }

  /**
   * Resolves the planning session, creating one when the plan has none or the
   * bridge has forgotten it.
   *
   * `created` matters to the prompt: a reused session still holds the
   * conversation, so only the raw message is sent, whereas a fresh one has to
   * be rebuilt from the persisted transcript.
   */
  private async ensureSession(
    record: FeaturePlanningRecord,
    environmentId: string,
    provider: BuildPipelineProvider,
  ): Promise<{ sessionId: string; created: boolean }> {
    const plan = await this.storage.getFeaturePlan(record.featureId);
    const existing = plan?.codexSessionId;
    if (existing) {
      const status = await this.providerOperation(
        environmentId,
        provider,
        () => provider.status(existing),
      );
      if (status !== "missing") return { sessionId: existing, created: false };
    }
    const config = await this.storage.loadConfig();
    const repository = config.repositories[record.projectId];
    const created = await this.providerOperation(
      environmentId,
      provider,
      () => provider.createSession("review", plan?.title || "Feature planning", {
        clientSessionKey: `feature-planning:${record.featureId}`,
        mode: "plan",
        ...(repository?.defaultModel || config.global.codexModel
          ? { model: repository?.defaultModel || config.global.codexModel }
          : {}),
        effort: repository?.defaultEffort || config.global.codexReasoningEffort || "medium",
      }),
    );
    await this.storage.updateFeaturePlan(record.featureId, { codexSessionId: created });
    await this.update(record, (_plan, current) => {
      current.providerSessionId = created;
      // A new session has none of the old transcript, so the previous baseline
      // would exclude nothing and match the wrong message.
      delete current.baselineAssistantIds;
    });
    return { sessionId: created, created: true };
  }

  private buildPrompt(
    plan: FeaturePlan,
    record: FeaturePlanningRecord,
    sessionId: string,
    createdSession: boolean,
  ): string {
    if (record.kind === "story") {
      const story = plan.stories.find((candidate) => candidate.id === record.storyId);
      if (!story) {
        throw new DefiniteFeaturePlanningError(
          "persistence",
          "dispatching",
          "The story this refinement belongs to no longer exists",
        );
      }
      return createStoryRefinementPrompt(
        // The user's message is already on the story; the prompt builder wants
        // the transcript that preceded it.
        { ...story, messages: story.messages.filter((entry) => entry.id !== record.userMessageId) },
        record.userMessage,
      );
    }
    return selectFeaturePlannerPrompt({
      feature: {
        ...plan,
        messages: plan.messages.filter((entry) => entry.id !== record.userMessageId),
      },
      userMessage: record.userMessage,
      // A reused session still holds the conversation; a session created for
      // this exchange has to be given the transcript.
      previousSessionId: createdSession ? null : sessionId,
      sessionId,
    });
  }

  private async provider(environmentId: string): Promise<BuildPipelineProvider> {
    const cached = this.providers.get(environmentId);
    if (cached) return cached;
    if (this.options.provider) {
      const provider = await this.options.provider(environmentId);
      this.providers.set(environmentId, provider);
      return provider;
    }
    const environment = await this.storage.getEnvironment(environmentId);
    if (!environment) {
      throw new DefiniteFeaturePlanningError(
        "environment",
        "dispatching",
        "The planning environment no longer exists",
      );
    }
    const connection = environment.environmentType === "local"
      ? await this.localConnection(environment)
      : await this.containerConnection(environment);
    const provider = createBuildPipelineProvider(connection, { autoAnswerRequests: false });
    this.providers.set(environmentId, provider);
    return provider;
  }

  private async localConnection(environment: Environment) {
    const result = await this.invoke<{ port: number; authToken?: string }>(
      "start_local_codex_server_cmd",
      { environmentId: environment.id },
    );
    if (!result.authToken) throw new Error("Codex bridge authentication is unavailable");
    return {
      agent: "codex" as const,
      baseUrl: `http://127.0.0.1:${result.port}`,
      authToken: result.authToken,
      directory: environment.worktreePath,
    };
  }

  private async containerConnection(environment: Environment) {
    if (!environment.containerId) {
      throw new Error("The planning container is unavailable");
    }
    const result = await this.invoke<{ hostPort: number; authToken?: string }>(
      "start_codex_server",
      { containerId: environment.containerId },
    );
    if (!result.authToken) throw new Error("Codex bridge authentication is unavailable");
    return {
      agent: "codex" as const,
      baseUrl: `http://127.0.0.1:${result.hostPort}`,
      authToken: result.authToken,
    };
  }

  private async messages(
    provider: BuildPipelineProvider,
    sessionId: string,
  ): Promise<BridgeMessage[]> {
    const raw = await provider.messages(sessionId);
    return raw.filter(isBridgeMessage);
  }

  /**
   * Drops a provider whose transport failed so the next tick rediscovers the
   * bridge port and authentication token. The operation itself is not retried
   * here: dispatch reconciliation must remain at-most-once.
   */
  private async providerOperation<T>(
    environmentId: string,
    provider: BuildPipelineProvider,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      await this.evictProvider(environmentId, provider);
      throw error;
    }
  }

  private async evictProvider(
    environmentId: string,
    provider: BuildPipelineProvider,
  ): Promise<void> {
    if (this.providers.get(environmentId) !== provider) return;
    this.providers.delete(environmentId);
    await Promise.resolve(provider.dispose?.()).catch(() => undefined);
  }

  /** Completes a cancellation observed by work already holding the lock. */
  private async clearIfCancellationRequested(
    record: FeaturePlanningRecord,
    provider?: BuildPipelineProvider,
    sessionId?: string,
  ): Promise<boolean> {
    if (this.cancellationRequests.get(record.featureId) !== record.operationId) return false;
    await this.abortForCancellation(record, provider, sessionId);
    this.idleSince.delete(record.featureId);
    await this.storage.clearFeaturePlanning(record.featureId, record.operationId);
    return true;
  }

  private async abortForCancellation(
    record: FeaturePlanningRecord,
    provider?: BuildPipelineProvider,
    sessionId?: string,
  ): Promise<void> {
    if (this.cancellationAborts.has(record.operationId)) return;
    if (record.phase !== "running" && !record.dispatchId) return;
    const targetSessionId = sessionId ?? record.providerSessionId;
    if (!targetSessionId) return;
    let targetProvider = provider;
    if (!targetProvider && record.environmentId) {
      targetProvider = await this.provider(record.environmentId).catch(() => undefined);
    }
    if (!targetProvider) return;
    try {
      await targetProvider.abort(targetSessionId);
      this.cancellationAborts.add(record.operationId);
    } catch {
      // The locked pass retries once after any in-flight state transition.
    }
  }

  /* ---------------------------------------------------------------- *
   * Failure, adoption and helpers
   * ---------------------------------------------------------------- */

  private async fail(featureId: string, error: unknown): Promise<void> {
    // A fence error means this exchange has already been replaced. Failing the
    // record that replaced it would report someone else's error.
    if (error instanceof FeaturePlanningFenceError) return;
    const record = await this.read(featureId);
    if (!record || isTerminalFeaturePlanningPhase(record.phase)) return;
    const definite = error instanceof DefiniteFeaturePlanningError ? error : null;
    if (!definite) {
      // Transient: the next tick retries. Nothing is written, so a bridge that
      // is briefly unreachable does not consume the user's exchange.
      console.warn(`[feature-planning] ${featureId} retrying after:`, message(error));
      return;
    }
    this.idleSince.delete(featureId);
    await this.storage.mutateFeaturePlanning(featureId, record.operationId, (_plan, current) => {
      current.phase = "failed";
      current.failure = {
        code: definite.code,
        message: definite.message,
        occurredAt: nowIso(),
        retryPhase: definite.retryPhase,
      };
    });
  }

  /**
   * Adopts conversations started by the previous renderer-driven controller.
   *
   * Those carried no record: their only trace was a persisted user message with
   * no assistant answer after it. Left alone they would be orphaned — the React
   * controller that used to finish them is gone — so each becomes a record in
   * `running`, which the reply watcher settles from the transcript.
   */
  private async adoptLegacyConversations(): Promise<void> {
    for (const plan of await this.storage.listAllFeaturePlans()) {
      if (plan.planning !== undefined) continue;
      if (!plan.codexSessionId || !plan.codexEnvironmentId) continue;
      const pending = this.unansweredMessage(plan);
      if (!pending) continue;
      await this.storage.startFeaturePlanning({
        version: FEATURE_PLANNING_RECORD_VERSION,
        operationId: randomUUID(),
        featureId: plan.id,
        projectId: plan.projectId,
        kind: pending.storyId ? "story" : "feature",
        ...(pending.storyId ? { storyId: pending.storyId } : {}),
        userMessage: pending.message.content,
        userMessageId: pending.message.id,
        environmentId: plan.codexEnvironmentId,
        providerSessionId: plan.codexSessionId,
        // Adopted as already-dispatched: the turn may well be running, and
        // re-sending it is the one thing that must not happen.
        dispatchId: randomUUID(),
        dispatchState: "sent",
        baselineAssistantIds: [],
        phase: "running",
        startedAt: pending.message.createdAt,
        attemptStartedAt: pending.message.createdAt,
        dispatchedAt: pending.message.createdAt,
        updatedAt: nowIso(),
        backendRevision: 0,
      }).catch(() => undefined);
    }
  }

  private unansweredMessage(
    plan: FeaturePlan,
  ): { message: FeaturePlanMessage; storyId?: string } | null {
    const trailing = (messages: FeaturePlanMessage[]) => {
      const last = messages.at(-1);
      return last?.role === "user" ? last : null;
    };
    const featureMessage = trailing(plan.messages);
    if (featureMessage) return { message: featureMessage };
    for (const story of plan.stories) {
      const storyMessage = trailing(story.messages);
      if (storyMessage) return { message: storyMessage, storyId: story.id };
    }
    return null;
  }

  private async read(featureId: string): Promise<FeaturePlanningRecord | null> {
    const plan = await this.storage.getFeaturePlan(featureId);
    const record = plan?.planning;
    return isFeaturePlanningRecord(record) ? record : null;
  }

  private async update(
    record: FeaturePlanningRecord,
    mutator: (plan: FeaturePlan, current: FeaturePlanningRecord) => void,
  ): Promise<void> {
    await this.storage.mutateFeaturePlanning(record.featureId, record.operationId, mutator);
  }

  private environmentDeadlineMs(): number {
    return this.options.environmentReadyDeadlineMs ?? ENVIRONMENT_READY_DEADLINE_MS;
  }

  private replyDeadlineMs(): number {
    return this.options.replyDeadlineMs ?? REPLY_DEADLINE_MS;
  }

  private idleWithoutReplyMs(): number {
    return this.options.idleWithoutReplyMs ?? IDLE_WITHOUT_REPLY_MS;
  }
}
