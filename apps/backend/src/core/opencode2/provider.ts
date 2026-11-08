/**
 * The OpenCode 2.x session provider (docs/todo/agent-engines/0008-opencode-v2.md,
 * build plan phase 3).
 *
 * It drives a 2.x `opencode serve` through {@link OpenCode2Client}. It is not
 * routed to yet: the routing provider and the per-session protocol marker
 * come next. The provider covers the required session contract and steering:
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
 *
 * Not yet covered (later phases): attachments, structured output and
 * workflow-result tools, transcript projection and paging, interaction
 * cards, MCP, sign-in and slash commands. Requests that need them are refused
 * explicitly rather than silently degraded.
 */
import type { StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import type { NativeAgentSessionActionOutcome } from "@orkestrator/protocol/native-agent";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import {
  AmbiguousPromptDispatchError,
  PromptRejectedError,
  ProviderUnavailableError,
  type NativeAgentRuntimeProvider,
  type ProviderActiveSteerRun,
  type ProviderActivityState,
  type ProviderCreateSessionOptions,
  type ProviderDispatchStatus,
  type ProviderNativeAgentSessionAction,
  type ProviderSendOptions,
  type ProviderStatus,
  type ProviderSteerDispatchStatus,
} from "../agent-provider-contract.js";
import { OpenCode2Client, OpenCode2RequestError } from "./client.js";
import { OpenCode2SequenceTracker, readOpenCode2Events } from "./events.js";
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
  /** Disable the live event monitor (tests that only exercise reads). */
  monitorEvents?: boolean;
  now?: () => number;
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
  private readonly appliedModel = new Map<string, string>();
  private readonly tracker = new OpenCode2SequenceTracker();
  private readonly monitor = new AbortController();
  private readonly monitorTask: Promise<void> | undefined;
  private activityCache: { at: number; running: ReadonlySet<string> } | undefined;
  private disposed = false;

  constructor(
    private readonly client: OpenCode2Client,
    private readonly dependencies: OpenCode2ProviderDependencies = {},
  ) {
    if (dependencies.monitorEvents !== false) this.monitorTask = this.watchEvents();
  }

  registerSession(sessionId: string): void {
    if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, { dirty: true });
  }

  releaseSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.appliedModel.delete(sessionId);
    this.tracker.forget(sessionId);
  }

  async createSession(
    phase: string,
    label: string,
    options: ProviderCreateSessionOptions = {},
  ): Promise<string> {
    const model = parseOpenCode2Model(options.model);
    let session;
    try {
      session = await this.client.createSession({
        ...(model ? { model } : {}),
        metadata: { orkestrator: { phase: phase.slice(0, 120), label: label.slice(0, 200) } },
      });
    } catch (error) {
      if (error instanceof OpenCode2RequestError) throw new PromptRejectedError(error.message);
      throw new ProviderUnavailableError("OpenCode 2.x session could not be created", {
        cause: error,
      });
    }
    if (model) this.appliedModel.set(session.id, options.model!);
    this.registerSession(session.id);
    return session.id;
  }

  async send(sessionId: string, prompt: string, options: ProviderSendOptions): Promise<void> {
    refuseUnsupportedSendOptions(options);
    const text = boundedText(prompt);
    this.registerSession(sessionId);
    await this.applyModel(sessionId, options.model);
    const id = mintOpenCode2InputId(this.now());
    let answer: unknown;
    try {
      // `queue` runs after a run in progress instead of entering it mid-step;
      // on an idle session it starts a run (observed on 2.2.6).
      answer = await this.client.prompt(sessionId, {
        id,
        text,
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
    return activity === "working" ? "running" : "idle";
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

  async messages(sessionId: string, options: { limit?: number } = {}): Promise<unknown[]> {
    return this.history(sessionId, options.limit ?? OPENCODE2_EVIDENCE_SCAN_LIMIT);
  }

  /** Structured output arrives with the workflow-result tool (phase 5). */
  async structured<T>(): Promise<StructuredOutputResult<T> | null> {
    return null;
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
    await this.rejectPendingRequests(sessionId);
  }

  /** Stop owned work and forget the session. Never deletes the conversation. */
  async closeSession(sessionId: string): Promise<void> {
    try {
      await this.abort(sessionId);
    } finally {
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
      throw new PromptRejectedError(`OpenCode 2.x does not support ${action.kind} yet`);
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

  private async applyModel(sessionId: string, modelId: string | undefined): Promise<void> {
    if (!modelId || this.appliedModel.get(sessionId) === modelId) return;
    const model = parseOpenCode2Model(modelId);
    if (!model) throw new PromptRejectedError(`OpenCode model "${modelId}" is not provider/model`);
    try {
      await this.client.selectModel(sessionId, model);
    } catch (error) {
      if (error instanceof OpenCode2RequestError) {
        throw new PromptRejectedError(`OpenCode refused the model: ${error.message}`);
      }
      // Nothing was dispatched yet: unavailable, not ambiguous.
      throw new ProviderUnavailableError("OpenCode 2.x model switch failed", { cause: error });
    }
    this.appliedModel.set(sessionId, modelId);
  }

  /** Oldest first. */
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
   */
  private async watchEvents(): Promise<void> {
    const retryMs = this.dependencies.monitorRetryMs ?? 1_000;
    while (!this.disposed) {
      try {
        const body = await this.client.openEvents(this.monitor.signal);
        await readOpenCode2Events(
          body,
          (signal) => {
            if (signal.kind === "desync") return this.markAllDirty();
            const durable = signal.event.durable;
            if (!durable || !this.sessions.has(durable.aggregateID)) return;
            this.tracker.note(durable.aggregateID, durable.seq);
            this.markDirty(durable.aggregateID);
          },
          this.monitor.signal,
        );
      } catch (error) {
        if (this.disposed) return;
        log.debug("events.dropped", { error: formatLogError(error, { message: false }) });
      }
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

/** Explicit refusals for what later phases add, instead of silently dropping it. */
function refuseUnsupportedSendOptions(options: ProviderSendOptions): void {
  const unsupported = [
    options.attachments?.length ? "attachments" : undefined,
    options.images?.length ? "images" : undefined,
    options.schema ? "structured output" : undefined,
    options.workflowResultTool || options.workflowResultSlots?.length
      ? "workflow results"
      : undefined,
    options.command ? "slash commands" : undefined,
    options.readOnly ? "read-only turns" : undefined,
  ].filter((name): name is string => name !== undefined);
  if (unsupported.length > 0) {
    throw new PromptRejectedError(
      `OpenCode 2.x sessions do not support ${unsupported.join(", ")} yet`,
    );
  }
}
