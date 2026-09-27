/**
 * Native execution adapter for web annotation requests.
 *
 * Native dispatch stays the only execution authority. This adapter publishes a
 * frozen request into the existing per-tab prompt queue (drained by
 * `NativeAgentService`), and observes its progress from durable storage plus
 * the service's in-memory, no-touch activity snapshots. It never calls a
 * provider route itself, never hydrates an idle session to poll it, and never
 * allocates a second request id for the same request.
 */
import path from "node:path";
import {
  AGENT_PLATFORM_LABELS,
  normalizeAgentPlatforms,
} from "@orkestrator/protocol/agent-platforms";
import { nativeAgentCapabilities } from "@orkestrator/protocol/native-agent";
import {
  WEB_ANNOTATION_LIMITS,
  WEB_ANNOTATION_WORKSPACE_DIRECTORY,
  parseWebAnnotationRequestMarker,
  type WebAnnotationDestination,
  type WebAnnotationDestinationOption,
  type WebAnnotationRequest,
  type WebAnnotationDispatchMode,
  type WebAnnotationFileCheck,
  type WebAnnotationRequestAttachment,
  type WebAnnotationRequestInteraction,
  type WebAnnotationRequestState,
  type WebAnnotationTurnOutcome,
  webAnnotationQueueOrigin,
} from "@orkestrator/protocol/web-annotations";
import { isSafeRelativePath } from "@orkestrator/protocol/web-annotations-validation";
import { checkWebAnnotationWorkspacePaths } from "./web-annotation-source-checks.js";
import { composeDraftHoldsQueue } from "./compose-draft-occupancy.js";
import type { Environment, PersistedNativeAgentSession, PersistedPromptQueue } from "./models.js";
import type { NativeAgentService } from "./native-agent-service.js";
import {
  isEnvironmentReadyForAgents,
  nativeAgentSessionStorageKey,
} from "./native-agent-service-shared.js";
import { assertValidPromptAttachments } from "./prompt-attachments.js";
import type { StorageService } from "./storage.js";
import { PROMPT_QUEUE_MESSAGE_CONFLICT } from "./storage-prompts.js";
import type {
  BriefDestinationCapabilities,
  CancelOutcome,
  DispatchEnvironment,
  DispatchObservation,
  MaterializeInput,
  PublishInput,
  PublishReceipt,
  WebAnnotationDispatchPort,
} from "./web-annotation-contracts.js";

export type WebAnnotationDispatchStorage = Pick<
  StorageService,
  | "getEnvironment"
  | "loadConfig"
  | "listNativeAgentSessions"
  | "getNativeAgentSession"
  | "getPromptQueue"
  | "getComposeDraft"
  | "getPaneLayout"
  | "enqueuePromptQueueMessageIfAbsent"
  | "removePromptQueueMessage"
  | "retryPromptQueueDispatch"
> &
  Partial<Pick<StorageService, "getAgentModelCatalogCache">>;

export type WebAnnotationDispatchNativeAgents = Pick<
  NativeAgentService,
  | "sessionActivitySnapshot"
  | "sessionTurnActivitySnapshot"
  | "sessionPresentationSnapshot"
  | "reconcileMailInject"
  | "getProjection"
> &
  Partial<
    Pick<
      NativeAgentService,
      "cachedProjectionSnapshot" | "sessionTurnOutcome" | "sessionPendingInteractions"
    >
  > & { notifyPromptQueueChanged?: (queueKey: string) => void };

export type WebAnnotationCommandInvoker = (
  command: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

export interface WebAnnotationDispatchAdapterOptions {
  storage: WebAnnotationDispatchStorage;
  nativeAgents: WebAnnotationDispatchNativeAgents | null | undefined;
  invoke: WebAnnotationCommandInvoker;
  /**
   * Whether the optional annotation result tools are served to agent tab
   * credentials (i.e. a tool host is installed). Defaults to false.
   */
  resultToolsAvailable?: () => boolean;
  now?: () => number;
}

const MAX_DESTINATIONS = 50;
const MAX_REASON_CHARS = 500;
const MAX_TRANSCRIPT_SCAN = 400;
const MAX_REQUEST_INTERACTIONS = 16;

function bounded(text: string, max = MAX_REASON_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function webAnnotationQueueKey(
  destination: Pick<WebAnnotationDestination, "agent" | "logicalSessionKey">,
): string {
  return `${destination.agent}\0${destination.logicalSessionKey}`;
}

function composeDraftKey(environmentId: string, destination: WebAnnotationDestination): string {
  return `${destination.agent}:${environmentId}:${encodeURIComponent(destination.logicalSessionKey)}`;
}

function logicalPrefix(environmentId: string): string {
  return `env-${environmentId}:`;
}

function tabIdFromLogicalKey(environmentId: string, logicalSessionKey: string): string | null {
  const prefix = logicalPrefix(environmentId);
  if (!logicalSessionKey.startsWith(prefix)) return null;
  const tabId = logicalSessionKey.slice(prefix.length);
  return tabId.length > 0 ? tabId : null;
}

interface LayoutAgentTab {
  tabId: string;
  agent: WebAnnotationDestination["agent"];
  title: string | null;
}

/** Agent-native tabs from the persisted (renderer-owned, opaque) pane tree. */
function layoutAgentTabs(root: unknown): LayoutAgentTab[] {
  const tabs: LayoutAgentTab[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (!isRecord(node) || depth > 32 || tabs.length >= MAX_DESTINATIONS) return;
    if (node.kind === "leaf" && Array.isArray(node.tabs)) {
      for (const tab of node.tabs) {
        if (!isRecord(tab) || tab.type !== "agent-native" || tab.isReviewTab === true) continue;
        if (typeof tab.id !== "string" || !tab.id) continue;
        const data = tab.nativeAgentData;
        const platform = isRecord(data) ? data.platform : undefined;
        if (typeof platform !== "string" || !(platform in AGENT_PLATFORM_LABELS)) continue;
        tabs.push({
          tabId: tab.id,
          agent: platform as WebAnnotationDestination["agent"],
          title:
            typeof tab.displayTitle === "string" && tab.displayTitle.trim()
              ? tab.displayTitle.trim()
              : null,
        });
      }
      return;
    }
    if (node.kind === "split" && Array.isArray(node.children)) {
      for (const child of node.children) visit(child, depth + 1);
    }
  };
  visit(root, 0);
  return tabs;
}

function queueHoldsId(queue: PersistedPromptQueue | null, id: string): boolean {
  return Boolean(queue?.messages.some((message) => isRecord(message) && message.id === id));
}

function claimHoldsId(queue: PersistedPromptQueue | null, id: string): boolean {
  if (!queue) return false;
  if (
    queue.inFlight &&
    (queue.inFlight.requestId === id ||
      (isRecord(queue.inFlight.message) && queue.inFlight.message.id === id))
  ) {
    return true;
  }
  return isRecord(queue.outstandingClaim?.message) && queue.outstandingClaim.message.id === id;
}

/** The queue recorded that this id was removed from `messages` before dispatch. */
function removedFromQueue(queue: PersistedPromptQueue | null, id: string): boolean {
  return Boolean(queue?.removedOrigins?.some((entry) => entry.requestId === id));
}

/** Locate the prompt message carrying `requestId`'s marker in a projection. */
function anchorInProjection(
  projection: {
    messages: unknown[];
    turnBoundaries?: Array<{ turnId: string; messageId?: string }>;
  },
  requestId: string,
): { messageId?: string; turnId?: string } | null {
  const messages = projection.messages.slice(-MAX_TRANSCRIPT_SCAN);
  for (const message of messages) {
    if (
      !isRecord(message) ||
      message.role !== "user" ||
      typeof message.content !== "string" ||
      parseWebAnnotationRequestMarker(message.content)?.requestId !== requestId
    ) {
      continue;
    }
    const messageId = typeof message.id === "string" && message.id ? message.id : undefined;
    if (!messageId) return null;
    const turnId = projection.turnBoundaries?.find(
      (boundary) => boundary.messageId === messageId,
    )?.turnId;
    return { messageId, ...(turnId ? { turnId } : {}) };
  }
  return null;
}

export class WebAnnotationDispatchAdapter implements WebAnnotationDispatchPort {
  private readonly storage: WebAnnotationDispatchStorage;
  private readonly nativeAgents: WebAnnotationDispatchNativeAgents | null;
  private readonly invoke: WebAnnotationCommandInvoker;
  private readonly resultToolsAvailable: () => boolean;
  private readonly now: () => number;

  constructor(options: WebAnnotationDispatchAdapterOptions) {
    this.storage = options.storage;
    this.nativeAgents = options.nativeAgents ?? null;
    this.invoke = options.invoke;
    this.resultToolsAvailable = options.resultToolsAvailable ?? (() => false);
    this.now = options.now ?? Date.now;
  }

  /**
   * Destination capabilities from the advertised native capability table,
   * narrowed by what is known about this session and its selected model.
   *
   * - Images: the platform must accept images, and a model that explicitly
   *   rejects them wins; without model information the platform answer is
   *   used and labelled `imageSupport: "agent"`.
   * - Plan mode: only a per-turn mode (`composer.modeScope === "turn"`) can
   *   make one discussion read-only without changing the session's own mode.
   * - Result tools: the platform must receive the agent tools credential, the
   *   session must be environment-owned, and a tool host must be installed.
   */
  capabilitiesFor(
    agent: WebAnnotationDestination["agent"],
    context: {
      session?: PersistedNativeAgentSession | null;
      modelImages?: boolean | null;
    } = {},
  ): BriefDestinationCapabilities {
    const capabilities = nativeAgentCapabilities(agent);
    const modelImages = context.modelImages ?? null;
    const environmentOwned =
      !context.session ||
      context.session.owner === undefined ||
      context.session.owner.kind === "environment";
    return {
      images: capabilities.attachments.images && modelImages !== false,
      imageSupport: modelImages === null ? "agent" : "model",
      planMode: capabilities.composer.mode && capabilities.composer.modeScope === "turn",
      resultTools:
        capabilities.agentTools === true && environmentOwned && this.resultToolsAvailable(),
    };
  }

  private cachedProjection(environmentId: string, destination: WebAnnotationDestination) {
    try {
      return (
        this.nativeAgents?.cachedProjectionSnapshot?.(
          environmentId,
          destination.agent,
          destination.logicalSessionKey,
        ) ?? null
      );
    } catch {
      return null;
    }
  }

  /**
   * The selected model and whether it accepts images, from what is already
   * known without touching a provider: the session's persisted controls, the
   * in-memory projection's composer, then the host-wide model catalogue cache.
   * `images: null` means "not known" (fall back to the platform capability).
   */
  private async modelImageSupport(
    environmentId: string,
    destination: WebAnnotationDestination,
    session: PersistedNativeAgentSession | null,
  ): Promise<{ modelId: string | null; images: boolean | null }> {
    const composer = this.cachedProjection(environmentId, destination)?.composer;
    const modelId =
      session?.controls?.modelId ??
      composer?.selectedModelId ??
      session?.inferredComposerSelection?.modelId ??
      null;
    if (!modelId) return { modelId: null, images: null };
    const matches = (model: { id: string; aliases?: string[] }) =>
      model.id === modelId || model.aliases?.includes(modelId) === true;
    const fromComposer = composer?.models.find(matches);
    if (typeof fromComposer?.supportsImageInput === "boolean") {
      return { modelId, images: fromComposer.supportsImageInput };
    }
    const agent = destination.agent;
    if (agent === "cursor" || agent === "grok" || agent === "pi") {
      const cache = await this.storage.getAgentModelCatalogCache?.().catch(() => null);
      const cached = cache?.[agent]?.models.find(matches);
      if (typeof cached?.supportsImageInput === "boolean") {
        return { modelId, images: cached.supportsImageInput };
      }
    }
    return { modelId, images: null };
  }

  private async destinationCapabilities(
    environmentId: string,
    destination: WebAnnotationDestination,
    session: PersistedNativeAgentSession | null,
  ): Promise<BriefDestinationCapabilities> {
    const model = await this.modelImageSupport(environmentId, destination, session);
    return this.capabilitiesFor(destination.agent, { session, modelImages: model.images });
  }

  private sessionKey(environmentId: string, destination: WebAnnotationDestination): string {
    return nativeAgentSessionStorageKey(
      environmentId,
      destination.agent,
      destination.logicalSessionKey,
    );
  }

  private async enabledPlatforms(): Promise<ReadonlySet<string>> {
    const config = await this.storage.loadConfig();
    return new Set(normalizeAgentPlatforms(config.global.enabledAgentPlatforms));
  }

  private turnActivity(environmentId: string, destination: WebAnnotationDestination) {
    return (
      this.nativeAgents?.sessionTurnActivitySnapshot(
        environmentId,
        destination.agent,
        destination.logicalSessionKey,
      ) ?? "unknown"
    );
  }

  // -------------------------------------------------------------------------
  // Destinations

  async listDestinations(
    environmentId: string,
    defaultTabId: string | null,
  ): Promise<WebAnnotationDestinationOption[]> {
    const environment = await this.storage.getEnvironment(environmentId);
    if (!environment || environment.deletionRequestedAt) return [];
    const [enabled, sessions, layout] = await Promise.all([
      this.enabledPlatforms(),
      this.storage.listNativeAgentSessions(),
      this.storage.getPaneLayout(environmentId).catch(() => null),
    ]);
    const prefix = logicalPrefix(environmentId);
    const owned = sessions.filter(
      (session) =>
        session.environmentId === environmentId &&
        session.origin === "interactive-native" &&
        (session.owner === undefined || session.owner.kind === "environment") &&
        session.logicalSessionKey.startsWith(prefix),
    );
    const sessionByTab = new Map<string, PersistedNativeAgentSession>();
    for (const session of owned) {
      const tabId = tabIdFromLogicalKey(environmentId, session.logicalSessionKey);
      if (tabId) sessionByTab.set(`${session.agent}\0${tabId}`, session);
    }

    // The pane layout decides which tabs exist. A persisted session whose tab
    // was closed is hidden, not offered; without any layout (headless use),
    // every interactive session in the environment is a candidate.
    const candidates: Array<{
      tabId: string;
      agent: WebAnnotationDestination["agent"];
      title: string | null;
    }> = layout
      ? layoutAgentTabs(layout.root)
      : [...sessionByTab.entries()]
          .map(([key, session]) => ({
            tabId: key.slice(key.indexOf("\0") + 1),
            agent: session.agent,
            title: null,
          }))
          .sort((a, b) => (a.tabId < b.tabId ? -1 : a.tabId > b.tabId ? 1 : 0));

    const options: WebAnnotationDestinationOption[] = [];
    for (const candidate of candidates.slice(0, MAX_DESTINATIONS)) {
      if (!enabled.has(candidate.agent)) continue;
      const destination: WebAnnotationDestination = {
        agent: candidate.agent,
        tabId: candidate.tabId,
        logicalSessionKey: `${prefix}${candidate.tabId}`,
      };
      const session = sessionByTab.get(`${candidate.agent}\0${candidate.tabId}`) ?? null;
      const [queue, draft] = await Promise.all([
        this.storage.getPromptQueue(webAnnotationQueueKey(destination)),
        this.storage.getComposeDraft(composeDraftKey(environmentId, destination)),
      ]);
      const presentation = this.nativeAgents?.sessionPresentationSnapshot(
        environmentId,
        destination.agent,
        destination.logicalSessionKey,
      );
      const activity = presentation?.presence ?? "unknown";
      const holds: WebAnnotationDestinationOption["holds"] = [];
      if (composeDraftHoldsQueue(draft?.value)) holds.push("compose-draft");
      if (session?.pendingDispatch || queue?.dispatchError) holds.push("parked-dispatch");
      if (queue && (queue.messages.length > 0 || queue.inFlight !== undefined))
        holds.push("queued-prompts");
      const title =
        candidate.title ?? presentation?.title ?? AGENT_PLATFORM_LABELS[candidate.agent];
      const model = await this.modelImageSupport(environmentId, destination, session);
      const capabilities = this.capabilitiesFor(candidate.agent, {
        session,
        modelImages: model.images,
      });
      options.push({
        destination: { ...destination, label: bounded(title, WEB_ANNOTATION_LIMITS.titleChars) },
        title: bounded(title, WEB_ANNOTATION_LIMITS.titleChars),
        model: model.modelId,
        activity:
          activity === "idle" || activity === "working" || activity === "waiting"
            ? activity
            : "unknown",
        images: capabilities.images,
        imageSupport: capabilities.imageSupport ?? "agent",
        planMode: capabilities.planMode,
        resultTools: capabilities.resultTools,
        holds,
        isDefault: defaultTabId !== null && candidate.tabId === defaultTabId,
      });
    }
    return options;
  }

  async validateDestination(
    environmentId: string,
    destination: WebAnnotationDestination,
  ): Promise<
    | { ok: true; capabilities: BriefDestinationCapabilities }
    | { ok: false; reason: string; code: "destination-unavailable" | "environment-not-ready" }
  > {
    const environment = await this.storage.getEnvironment(environmentId);
    if (!environment || environment.deletionRequestedAt) {
      return {
        ok: false,
        code: "environment-not-ready",
        reason: "The environment no longer exists.",
      };
    }
    if (!isEnvironmentReadyForAgents(environment)) {
      return {
        ok: false,
        code: "environment-not-ready",
        reason: "The environment is not running and ready for agents.",
      };
    }
    const tabId = tabIdFromLogicalKey(environmentId, destination.logicalSessionKey);
    if (!tabId || tabId !== destination.tabId) {
      return {
        ok: false,
        code: "destination-unavailable",
        reason: "The agent session does not belong to this environment.",
      };
    }
    if (!(await this.enabledPlatforms()).has(destination.agent)) {
      return {
        ok: false,
        code: "destination-unavailable",
        reason: `${AGENT_PLATFORM_LABELS[destination.agent]} is not enabled.`,
      };
    }
    const session = await this.storage.getNativeAgentSession(
      this.sessionKey(environmentId, destination),
    );
    if (session) {
      if (
        session.environmentId !== environmentId ||
        session.agent !== destination.agent ||
        session.logicalSessionKey !== destination.logicalSessionKey ||
        (session.owner !== undefined && session.owner.kind !== "environment") ||
        session.origin !== "interactive-native"
      ) {
        return {
          ok: false,
          code: "destination-unavailable",
          reason: "The agent session belongs to another owner.",
        };
      }
    } else {
      // No provider session yet is fine (the drainer creates it), but the tab
      // itself must still exist so a deleted destination is never recreated.
      const layout = await this.storage.getPaneLayout(environmentId).catch(() => null);
      if (
        layout &&
        !layoutAgentTabs(layout.root).some(
          (tab) => tab.tabId === tabId && tab.agent === destination.agent,
        )
      ) {
        return {
          ok: false,
          code: "destination-unavailable",
          reason: "The agent tab was closed or reassigned.",
        };
      }
    }
    return {
      ok: true,
      capabilities: await this.destinationCapabilities(environmentId, destination, session),
    };
  }

  // -------------------------------------------------------------------------
  // Materialization

  async materialize(input: MaterializeInput): Promise<WebAnnotationRequestAttachment[]> {
    const { environment, requestId } = input;
    const local = environment.environmentType === "local";
    if (local && !environment.worktreePath)
      throw new Error("Cannot materialize evidence without a worktree path");
    if (!local && !environment.containerId)
      throw new Error("Cannot materialize evidence without a container");
    const safeRequest = requestId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
    if (!safeRequest || safeRequest.startsWith("."))
      throw new Error("Request id cannot name a workspace file");
    const materialized: WebAnnotationRequestAttachment[] = [];
    // Sequential on purpose: at most one image buffer is held at a time.
    for (const attachment of input.attachments) {
      const basename = path.posix.basename(attachment.relativePath);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.png$/.test(basename)) {
        throw new Error("Attachment path is not an app-generated evidence path");
      }
      const relativePath = `${WEB_ANNOTATION_WORKSPACE_DIRECTORY}/${safeRequest}-${basename}`;
      if (
        !isSafeRelativePath(relativePath) ||
        !relativePath.startsWith(`${WEB_ANNOTATION_WORKSPACE_DIRECTORY}/`)
      ) {
        throw new Error("Attachment path escapes the evidence directory");
      }
      const data = await input.readAsset(attachment.assetId);
      if (data.byteLength !== attachment.bytes) {
        throw new Error("Stored evidence does not match the frozen request");
      }
      const base64Data = data.toString("base64");
      let materializedPath: string;
      if (local) {
        const written = await this.invoke("write_local_file", {
          worktreePath: environment.worktreePath,
          filePath: relativePath,
          base64Data,
        });
        materializedPath =
          typeof written === "string" && written
            ? written
            : path.join(environment.worktreePath!, relativePath);
      } else {
        await this.invoke("write_container_file", {
          containerId: environment.containerId,
          filePath: relativePath,
          base64Data,
        });
        materializedPath = `/workspace/${relativePath}`;
      }
      materialized.push({ ...attachment, relativePath, materializedPath });
    }
    return materialized;
  }

  // -------------------------------------------------------------------------
  // Publication

  async publish(input: PublishInput): Promise<PublishReceipt> {
    const { request, text } = input;
    const destination = request.destination;
    const queueKey = webAnnotationQueueKey(destination);
    if (parseWebAnnotationRequestMarker(text)?.requestId !== request.id) {
      return {
        status: "rejected",
        reason: "The dispatched text does not carry this request's marker.",
      };
    }
    let attachments;
    try {
      if (request.attachments.some((attachment) => !attachment.materializedPath)) {
        throw new Error("Evidence attachments were not materialized");
      }
      attachments = assertValidPromptAttachments(
        request.attachments.map((attachment) => ({
          type: "image",
          path: attachment.materializedPath,
          filename: path.posix.basename(attachment.relativePath),
        })),
      );
    } catch (error) {
      return { status: "rejected", reason: bounded(errorMessage(error)) };
    }
    const { fields: modeFields, dispatchMode } = await this.dispatchModeFields(request);
    const message = {
      id: request.id,
      requestId: request.id,
      text,
      attachments,
      ...modeFields,
      // The brief is literal text: never a provider slash command.
      command: { kind: "literal" },
      origin: { kind: "web-annotation", requestId: request.id, bodyHash: request.bodyHash },
    };
    let status: "queued" | "present" | "consumed";
    try {
      ({ status } = await this.storage.enqueuePromptQueueMessageIfAbsent(
        queueKey,
        request.environmentId,
        message,
      ));
    } catch (error) {
      const reason = errorMessage(error);
      if (reason.startsWith(PROMPT_QUEUE_MESSAGE_CONFLICT)) {
        // The same request/body may already be queued with other delivery
        // fields (a message written by an earlier backend version). That is
        // this request, not a conflicting one.
        if (await this.queuedWithSameBody(queueKey, request, text)) {
          return { status: "queued", dispatchMode };
        }
        return {
          status: "rejected",
          reason: "This request id was already published with a different body.",
        };
      }
      if (
        /environment (not found|is being deleted)|belongs to another environment|does not match its environment|exceeds the 32 MB limit|must have a non-blank ID/.test(
          reason,
        )
      ) {
        return { status: "rejected", reason: bounded(reason) };
      }
      // Anything else may have happened after the durable write; let the
      // caller retry the same id, which the idempotent enqueue deduplicates.
      throw error;
    }
    if (status === "consumed") return { status: "consumed" };
    try {
      this.nativeAgents?.notifyPromptQueueChanged?.(queueKey);
    } catch {
      // The periodic drain sweep is the safety net for a missed wake-up.
    }
    return { status: "queued", dispatchMode };
  }

  private async queuedWithSameBody(
    queueKey: string,
    request: WebAnnotationRequest,
    text: string,
  ): Promise<boolean> {
    const queue = await this.storage.getPromptQueue(queueKey).catch(() => null);
    const held = [
      ...(queue?.messages ?? []),
      queue?.outstandingClaim?.message,
      queue?.inFlight?.message,
    ].find((candidate) => isRecord(candidate) && candidate.id === request.id);
    return (
      isRecord(held) &&
      held.text === text &&
      webAnnotationQueueOrigin(held)?.requestId === request.id &&
      webAnnotationQueueOrigin(held)?.bodyHash === request.bodyHash
    );
  }

  /**
   * Mode fields for the queued message. Never changes a session's own mode:
   *
   * - Discuss in `plan-mode` (only offered for per-turn modes): ask for plan
   *   mode on this one prompt.
   * - Otherwise send the session's current mode when it is known, and when it
   *   is not, mark the message `preserveSessionMode` so the drain sends no
   *   mode at all (a `build` default would switch a session-scoped provider
   *   out of a plan mode the user chose).
   */
  private async dispatchModeFields(request: WebAnnotationRequest): Promise<{
    fields: Record<string, unknown>;
    dispatchMode: WebAnnotationDispatchMode;
  }> {
    const destination = request.destination;
    const claude = destination.agent === "claude";
    const withMode = (mode: "plan" | "build") => ({
      mode,
      ...(claude ? { planModeEnabled: mode === "plan" } : {}),
    });
    if (request.operation === "discuss" && request.readOnly === "plan-mode") {
      return { fields: withMode("plan"), dispatchMode: "plan" };
    }
    const capabilities = nativeAgentCapabilities(destination.agent);
    if (capabilities.composer.mode) {
      const session = await this.storage
        .getNativeAgentSession(this.sessionKey(request.environmentId, destination))
        .catch(() => null);
      const current =
        session?.controls?.mode ??
        this.cachedProjection(request.environmentId, destination)?.composer?.selectedModeId;
      if (current === "plan" || current === "build") {
        return { fields: withMode(current), dispatchMode: current };
      }
    }
    return { fields: { preserveSessionMode: true }, dispatchMode: "session" };
  }

  // -------------------------------------------------------------------------
  // Observation (storage + in-memory snapshots only)

  async observe(request: WebAnnotationRequest): Promise<DispatchObservation> {
    const destination = request.destination;
    const environmentId = request.environmentId;
    const queueKey = webAnnotationQueueKey(destination);
    const [environment, queue, session, draft] = await Promise.all([
      this.storage.getEnvironment(environmentId),
      this.storage.getPromptQueue(queueKey),
      this.storage.getNativeAgentSession(this.sessionKey(environmentId, destination)),
      this.storage.getComposeDraft(composeDraftKey(environmentId, destination)),
    ]);
    const id = request.id;
    const keep = (extra: Partial<DispatchObservation> = {}): DispatchObservation => ({
      state: request.state,
      blockedReason: request.blockedReason,
      reason: null,
      dispatchConfirmed: request.dispatchConfirmedAt !== null,
      interactionIds: request.interactionIds,
      destinationMissing: false,
      ...extra,
    });
    const observation = (
      state: WebAnnotationRequestState,
      extra: Partial<DispatchObservation> = {},
    ): DispatchObservation => ({
      state,
      blockedReason: null,
      reason: null,
      dispatchConfirmed: false,
      interactionIds: [],
      destinationMissing: false,
      ...extra,
    });

    // Session receipts first: they are the authoritative record of what the
    // provider accepted, even while a queue reservation is still being acked.
    const dispatched = session?.dispatchedRequestIds ?? [];
    const position = dispatched.lastIndexOf(id);
    const claimed = claimHoldsId(queue, id);
    const pending = session?.pendingDispatch?.requestId === id;
    // `dispatchedRequestIds` is bounded. A confirmation persisted on the
    // request stays authoritative after the id rolls out of that window
    // (1,000 later prompts means this turn has certainly ended).
    const rolledOver =
      position < 0 &&
      session !== null &&
      request.dispatchConfirmedAt !== null &&
      !pending &&
      !claimed &&
      !queueHoldsId(queue, id);
    if (position >= 0 || rolledOver) {
      return this.observeDispatched(request, session!, {
        laterTurn: rolledOver || position < dispatched.length - 1,
        rolledOver,
        observation,
      });
    }
    if (pending) {
      return observation("unconfirmed", {
        reason: "The agent may have received this request, but delivery was not confirmed.",
      });
    }
    if (claimed) return observation("dispatching");

    const error = queue?.dispatchError;
    if (error && (error.requestId === id || error.messageId === id)) {
      // The drain rejected this request and parked the queue on it. Leave the
      // queue parked: the drain deliberately does not retry a rejected prompt,
      // and the user's later prompts must not jump past it silently. The
      // request stays held; Retry (same id) or Cancel are explicit actions.
      return observation("queued", {
        blockedReason: "dispatch-rejected",
        reason: bounded(error.message),
      });
    }

    if (queueHoldsId(queue, id)) {
      const destinationMissing = !session
        ? await this.destinationTabMissing(environmentId, destination)
        : false;
      return observation("queued", {
        blockedReason: destinationMissing
          ? "destination-unavailable"
          : this.blockedReason(
              environment,
              draft?.value,
              queue,
              session,
              id,
              destination,
              environmentId,
            ),
        destinationMissing,
      });
    }

    // Removed from the chat queue before any dispatch: the queue recorded a
    // tombstone for this id under the same lock as the removal.
    if (removedFromQueue(queue, id) && request.dispatchConfirmedAt === null) {
      return observation("cancelled", {
        reason: "Removed from the chat queue before it was sent.",
        cancelSource: "chat-queue",
      });
    }

    // Absence alone is not proof: the item may have been acknowledged between
    // the queue and session reads. A missing destination is surfaced (retarget
    // or cancel) but never settles the request by itself.
    if (request.queueReceiptAt !== null || request.dispatchConfirmedAt !== null) {
      const destinationMissing =
        !environment ||
        (!session && (await this.destinationTabMissing(environmentId, destination)));
      if (destinationMissing) {
        return keep({
          blockedReason: "destination-unavailable",
          reason:
            "The destination agent session no longer exists. Choose another session or cancel.",
          destinationMissing: true,
        });
      }
    }
    return keep();
  }

  /**
   * Observation for a request the provider accepted. Settlement needs the
   * turn to have ended (idle, or a later turn with no live observation), and
   * uses the durable turn outcome so a provider error settles as `failed`.
   */
  private async observeDispatched(
    request: WebAnnotationRequest,
    session: PersistedNativeAgentSession,
    context: {
      laterTurn: boolean;
      rolledOver: boolean;
      observation: (
        state: WebAnnotationRequestState,
        extra?: Partial<DispatchObservation>,
      ) => DispatchObservation;
    },
  ): Promise<DispatchObservation> {
    const { laterTurn, rolledOver, observation } = context;
    const destination = request.destination;
    const environmentId = request.environmentId;
    const transcript = this.transcriptAnchor(request);
    const confirmed = { dispatchConfirmed: true, ...(transcript ? { transcript } : {}) };
    // A later id usually means a later turn, but accepted steering input for
    // the running turn also joins `dispatchedRequestIds`. While the session
    // is visibly busy, a later id is therefore not proof that this turn
    // ended; only an idle session, or a later id with no live observation
    // (e.g. after a backend restart), settles it.
    const activity = this.turnActivity(environmentId, destination);
    if (!laterTurn && activity === "waiting") {
      const interactions = await this.pendingInteractions(request);
      return observation("needs-input", {
        ...confirmed,
        interactionIds: (interactions ?? request.interactions ?? []).map((item) => item.id),
        interactions: interactions ?? request.interactions ?? [],
      });
    }
    const ended = activity === "idle" || (laterTurn && activity === "unknown") || rolledOver;
    if (!ended) {
      return observation(request.state === "cancelling" ? "cancelling" : "running", {
        ...confirmed,
        interactions: [],
      });
    }

    let outcome = session.turnOutcomes?.find((entry) => entry.requestId === request.id) ?? null;
    if (!outcome && !laterTurn && this.nativeAgents?.sessionTurnOutcome) {
      const read = await this.nativeAgents
        .sessionTurnOutcome({
          environmentId,
          agent: destination.agent,
          logicalSessionKey: destination.logicalSessionKey,
          requestId: request.id,
        })
        .catch(() => ({ outcome: "unknown" as const }));
      if (read.outcome === "pending") {
        return observation(request.state === "cancelling" ? "cancelling" : "running", {
          ...confirmed,
          interactions: [],
        });
      }
      if (read.outcome !== "unknown") {
        outcome = {
          requestId: request.id,
          outcome: read.outcome,
          ...(read.error ? { error: read.error } : {}),
          observedAt: new Date(this.now()).toISOString(),
        };
      }
    }
    const turnOutcome: WebAnnotationTurnOutcome = outcome?.outcome ?? "unknown";
    const turnError = outcome?.outcome === "failed" ? bounded(outcome.error ?? "", 300) : null;
    const settled = { ...confirmed, interactions: [], turnOutcome, turnError };
    // `cancelling` means a stop was actually sent to this turn.
    if (request.state === "cancelling") {
      return observation("cancelled", {
        ...settled,
        reason: "Stopped by the user; changes made before the stop may remain.",
        cancelSource: "user",
      });
    }
    if (turnOutcome === "failed") {
      return observation("failed", {
        ...settled,
        reason: turnError ? `The agent turn failed: ${turnError}` : "The agent turn failed.",
      });
    }
    const cancelArrivedLate = request.cancelRequestedAt !== null;
    return observation(request.operation === "implement" ? "awaiting-review" : "completed", {
      ...settled,
      ...(cancelArrivedLate
        ? {
            cancelArrivedLate: true,
            reason: "Cancel arrived after the request was sent; the turn finished normally.",
          }
        : {}),
    });
  }

  private async pendingInteractions(
    request: WebAnnotationRequest,
  ): Promise<WebAnnotationRequestInteraction[] | null> {
    const read = this.nativeAgents?.sessionPendingInteractions;
    if (!read) return null;
    const destination = request.destination;
    const requests = await read
      .call(this.nativeAgents, {
        environmentId: request.environmentId,
        agent: destination.agent,
        logicalSessionKey: destination.logicalSessionKey,
      })
      .catch(() => null);
    if (!requests) return null;
    return requests
      .filter((item) => typeof item.id === "string" && item.id.length > 0 && item.id.length <= 512)
      .slice(0, MAX_REQUEST_INTERACTIONS)
      .map((item) => ({
        id: item.id,
        kind: item.kind,
        state: item.state,
        blocking: item.blocking !== false,
        ...(typeof item.expiresAt === "number" ? { expiresAt: item.expiresAt } : {}),
      }));
  }

  /**
   * The transcript message (and turn) carrying this request's marker, from the
   * in-memory projection only. `readResponse` records the same anchor on
   * demand when no projection is cached.
   */
  private transcriptAnchor(
    request: WebAnnotationRequest,
  ): { messageId?: string; turnId?: string } | null {
    if (request.transcript.messageId) return null;
    const projection = this.cachedProjection(request.environmentId, request.destination);
    return projection ? anchorInProjection(projection, request.id) : null;
  }

  private blockedReason(
    environment: Environment | null,
    draftValue: unknown,
    queue: PersistedPromptQueue | null,
    session: PersistedNativeAgentSession | null,
    id: string,
    destination: WebAnnotationDestination,
    environmentId: string,
  ): DispatchObservation["blockedReason"] {
    if (
      !environment ||
      environment.deletionRequestedAt ||
      !isEnvironmentReadyForAgents(environment)
    ) {
      return "environment-stopped";
    }
    if (composeDraftHoldsQueue(draftValue)) return "compose-draft";
    if (
      queue?.dispatchError ||
      (session?.pendingDispatch && session.pendingDispatch.requestId !== id)
    ) {
      return "queue-parked";
    }
    const activity = this.turnActivity(environmentId, destination);
    if (activity === "working" || activity === "waiting") return "agent-busy";
    const head = queue?.messages[0];
    if (queue?.inFlight || (isRecord(head) && head.id !== id)) return "agent-busy";
    return null;
  }

  private async destinationTabMissing(
    environmentId: string,
    destination: WebAnnotationDestination,
  ): Promise<boolean> {
    const layout = await this.storage.getPaneLayout(environmentId).catch(() => null);
    if (!layout) return false;
    return !layoutAgentTabs(layout.root).some(
      (tab) => tab.tabId === destination.tabId && tab.agent === destination.agent,
    );
  }

  // -------------------------------------------------------------------------
  // Cancellation

  async cancel(request: WebAnnotationRequest): Promise<CancelOutcome> {
    const destination = request.destination;
    const queueKey = webAnnotationQueueKey(destination);
    const id = request.id;
    const queue = await this.storage.getPromptQueue(queueKey);
    if (queueHoldsId(queue, id)) {
      // The atomic removal fence: it either removes the unclaimed item or
      // finds that the drainer reserved it first.
      const { removed } = await this.storage.removePromptQueueMessage(
        queueKey,
        request.environmentId,
        id,
      );
      if (removed) return { outcome: "cancelled" };
    }
    const latestQueue = await this.storage.getPromptQueue(queueKey);
    if (claimHoldsId(latestQueue, id)) {
      return {
        outcome: "not-cancellable",
        code: "claimed",
        reason: "The request is being delivered to the agent; stop it once it is running.",
      };
    }
    if (removedFromQueue(latestQueue, id) && request.dispatchConfirmedAt === null) {
      return { outcome: "cancelled", reason: "Removed from the chat queue before it was sent." };
    }
    const sessionKey = this.sessionKey(request.environmentId, destination);
    const session = await this.storage.getNativeAgentSession(sessionKey);
    if (session?.pendingDispatch?.requestId === id) {
      return {
        outcome: "not-cancellable",
        code: "unconfirmed",
        reason: "Delivery is unconfirmed; recover or discard it instead.",
      };
    }
    const dispatched = session?.dispatchedRequestIds ?? [];
    if (!session && (request.destinationMissingAt || request.dispatchConfirmedAt !== null)) {
      // The destination session is gone: nothing here can run or be stopped
      // any more. Settle it, without claiming that no work ever ran.
      const environment = await this.storage.getEnvironment(request.environmentId);
      if (!environment || (await this.destinationTabMissing(request.environmentId, destination))) {
        return {
          outcome: "cancelled",
          reason:
            request.dispatchConfirmedAt !== null
              ? "Cancelled after the destination session was deleted; work sent before that may have run."
              : "Cancelled: the destination session was deleted before this request was sent.",
        };
      }
    }
    if (!dispatched.includes(id)) {
      return {
        outcome: "not-cancellable",
        code: "not-active",
        reason: "The request is not queued or running.",
      };
    }
    if (dispatched[dispatched.length - 1] !== id) {
      return {
        outcome: "not-cancellable",
        code: "newer-turn",
        reason: "A newer turn is running in this session; it was not stopped.",
      };
    }
    if (this.turnActivity(request.environmentId, destination) === "idle") {
      return {
        outcome: "not-cancellable",
        code: "already-finished",
        reason: "The request already finished.",
      };
    }
    // Compare identity immediately before stopping: an old card must never
    // stop a newer unrelated turn in the same session.
    const latest = await this.storage.getNativeAgentSession(sessionKey);
    const latestIds = latest?.dispatchedRequestIds ?? [];
    if (latestIds[latestIds.length - 1] !== id || latest?.pendingDispatch) {
      return {
        outcome: "not-cancellable",
        code: "newer-turn",
        reason: "A newer turn started in this session; it was not stopped.",
      };
    }
    try {
      await this.invoke("stop_native_agent_session", {
        environmentId: request.environmentId,
        agent: destination.agent,
        logicalSessionKey: destination.logicalSessionKey,
      });
    } catch (error) {
      return {
        outcome: "not-cancellable",
        code: "stop-failed",
        reason: bounded(`Stop failed: ${errorMessage(error)}`),
      };
    }
    return { outcome: "cancelling" };
  }

  // -------------------------------------------------------------------------
  // Recovery (same request id only)

  async recover(
    request: WebAnnotationRequest,
    action: "reconcile" | "retry" | "discard",
  ): Promise<DispatchObservation> {
    const destination = request.destination;
    const input = {
      environmentId: request.environmentId,
      agent: destination.agent,
      logicalSessionKey: destination.logicalSessionKey,
      requestId: request.id,
    };
    const session = await this.storage.getNativeAgentSession(
      this.sessionKey(request.environmentId, destination),
    );
    const parked = session?.pendingDispatch?.requestId === request.id;
    if (action === "reconcile") {
      if (parked && this.nativeAgents) {
        // Settles only against the provider's dispatch journal for this id;
        // "could not find out" stays unconfirmed.
        await this.nativeAgents.reconcileMailInject(input).catch(() => "unknown" as const);
      }
      return this.observe(request);
    }
    if (action === "retry") {
      if (!parked) {
        // A queue parked on this request's own rejection: the user's explicit
        // retry clears that latch (same id; the drain sends it again).
        const queueKey = webAnnotationQueueKey(destination);
        const queue = await this.storage.getPromptQueue(queueKey);
        const latch = queue?.dispatchError;
        if (latch && (latch.requestId === request.id || latch.messageId === request.id)) {
          await this.storage.retryPromptQueueDispatch(queueKey);
          try {
            this.nativeAgents?.notifyPromptQueueChanged?.(queueKey);
          } catch {
            // The periodic drain sweep picks it up.
          }
          return this.observe(request);
        }
        const current = await this.observe(request);
        return {
          ...current,
          reason: current.reason ?? "There is no parked delivery to retry for this request.",
        };
      }
      let rejection: string | null = null;
      try {
        const outcome = await this.invoke("retry_native_agent_dispatch", input);
        if (isRecord(outcome) && outcome.outcome === "rejected") {
          rejection = typeof outcome.error === "string" ? outcome.error : "The retry was rejected.";
        }
      } catch (error) {
        rejection = errorMessage(error);
      }
      const current = await this.observe(request);
      return rejection ? { ...current, reason: bounded(rejection) } : current;
    }
    // discard
    if (!parked) {
      const current = await this.observe(request);
      return {
        ...current,
        reason: current.reason ?? "There is no parked delivery to discard for this request.",
      };
    }
    let discarded = false;
    try {
      const outcome = await this.invoke("discard_native_agent_dispatch", input);
      discarded = isRecord(outcome) && outcome.discarded === true;
    } catch (error) {
      const current = await this.observe(request);
      return { ...current, reason: bounded(`Discard failed: ${errorMessage(error)}`) };
    }
    if (!discarded) return this.observe(request);
    return {
      state: "abandoned-unconfirmed",
      blockedReason: null,
      reason:
        "Delivery was discarded while unconfirmed; the agent may still have run this request.",
      dispatchConfirmed: false,
      interactionIds: [],
      destinationMissing: false,
    };
  }

  // -------------------------------------------------------------------------
  // Response excerpt (on demand; may hydrate this one session)

  async readResponse(request: WebAnnotationRequest): Promise<{
    excerpt: import("@orkestrator/protocol/web-annotations").WebAnnotationResponseExcerpt | null;
    sourceAvailable: boolean;
    transcript?: { messageId?: string; turnId?: string };
  }> {
    const destination = request.destination;
    const session = await this.storage.getNativeAgentSession(
      this.sessionKey(request.environmentId, destination),
    );
    if (!session || !this.nativeAgents) return { excerpt: null, sourceAvailable: false };
    let projection;
    try {
      projection = await this.nativeAgents.getProjection({
        environmentId: request.environmentId,
        agent: destination.agent,
        logicalSessionKey: destination.logicalSessionKey,
      });
    } catch {
      return { excerpt: null, sourceAvailable: false };
    }
    if (!projection) return { excerpt: null, sourceAvailable: false };
    const messages = projection.messages.filter(isRecord);
    const start = messages.findIndex(
      (message) =>
        message.role === "user" &&
        typeof message.content === "string" &&
        parseWebAnnotationRequestMarker(message.content)?.requestId === request.id,
    );
    if (start < 0) return { excerpt: null, sourceAvailable: true };
    const anchor = anchorInProjection(projection, request.id);
    const transcript = anchor ? { transcript: anchor } : {};
    const parts: string[] = [];
    let messageId: string | undefined;
    for (const message of messages.slice(start + 1)) {
      if (message.role === "user") break;
      if (message.role !== "assistant" || typeof message.content !== "string") continue;
      const content = message.content.trim();
      if (!content) continue;
      messageId ??= typeof message.id === "string" ? message.id : undefined;
      parts.push(content);
    }
    if (parts.length === 0) return { excerpt: null, sourceAvailable: true, ...transcript };
    const limit = WEB_ANNOTATION_LIMITS.responseExcerptChars;
    const joined = parts.join("\n\n");
    let text = joined;
    let truncated = false;
    if (joined.length > limit) {
      let end = limit;
      const code = joined.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end -= 1;
      text = joined.slice(0, end);
      truncated = true;
    }
    return {
      excerpt: {
        text,
        capturedAt: new Date(this.now()).toISOString(),
        provenance: "agent-reference",
        ...(messageId ? { messageId } : {}),
        truncated,
      },
      sourceAvailable: true,
      ...transcript,
    };
  }

  // -------------------------------------------------------------------------
  // Workspace path checks (containment + existence; never reads contents)

  async checkWorkspacePaths(
    environment: DispatchEnvironment,
    paths: readonly string[],
  ): Promise<WebAnnotationFileCheck[]> {
    return checkWebAnnotationWorkspacePaths(environment, paths);
  }
}
