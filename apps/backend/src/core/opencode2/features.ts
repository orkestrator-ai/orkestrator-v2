/**
 * The session features of an OpenCode 2.x provider beyond prompt dispatch
 * (docs/todo/agent-engines/0008-opencode-v2.md, build plan phase 5): the
 * model catalogue and effort, attachments, slash commands, Plan/Build, compact,
 * undo/redo, fork, the resume list, titles, to-dos and sign-in status.
 *
 * A collaborator of {@link OpenCode2Provider}, which delegates to it, so the
 * provider stays a dispatch-and-activity core. One instance per 2.x server
 * generation: its caches belong to that server.
 */
import {
  DEFAULT_OPENCODE_MODEL_PROVIDERS,
  EMPTY_NATIVE_AGENT_COMPOSER_STATE,
  type NativeAgentAuthStatus,
  type NativeAgentForkOutcome,
  type NativeAgentNotice,
  type NativeAgentResumeEntry,
  type NativeAgentSessionAction,
  type NativeAgentSessionActionOutcome,
} from "@orkestrator/protocol/native-agent";
import {
  PromptRejectedError,
  ProviderUnavailableError,
  type ProviderCommandCatalogue,
  type ProviderCommandRefreshResult,
  type ProviderCreateSessionOptions,
  type ProviderRuntimeHealth,
  type ProviderSendOptions,
  type ProviderSessionStateSnapshot,
} from "../agent-provider-contract.js";
import type { OpenCodeCommandDispatch, OpenCodeCommandRegistry } from "./command-catalogue.js";
import { openCode2PromptFiles } from "./attachments.js";
import { OpenCode2RequestError, type OpenCode2Client } from "./client.js";
import {
  createOpenCode2CommandRegistry,
  dispatchOpenCode2Command,
  resolveOpenCode2CommandDispatch,
} from "./commands.js";
import { openCode2AuthStatus } from "./credentials.js";
import {
  OpenCode2ModelCatalogueCache,
  openCode2ModelSelection,
  resolveOpenCode2DefaultModel,
  type OpenCode2ModelCatalogue,
} from "./models.js";
import {
  clearOpenCode2Revert,
  openCode2RevertMarker,
  openCode2RevertNotice,
  openCode2UndoTarget,
  stageOpenCode2Revert,
  withoutStagedOpenCode2Revert,
  type OpenCode2RevertMarker,
} from "./revert.js";
import {
  OPENCODE2_RESUME_PREFIX,
  OpenCode2AgentCache,
  forkOpenCode2Session,
  listOpenCode2ResumableSessions,
  openCode2ResumeSessionId,
  openCode2SessionDetails,
  openCode2TodoCount,
  selectOpenCode2Agent,
  updateOpenCode2Session,
  type OpenCode2SessionDetails,
} from "./sessions.js";
import type { OpenCode2FileInput, OpenCode2Message, OpenCode2ModelRef } from "./types.js";

/** Newest rows a visible-history read takes by default. */
const DEFAULT_HISTORY_LIMIT = 200;

export interface OpenCode2FeatureDependencies {
  /** The user's `openCodeModelProviders`, normalized; read per catalogue read. */
  allowedModelProviders?: () => Promise<readonly string[]>;
  now?: () => number;
}

/** What `send` runs: a server command, or a prompt with these files. */
export type OpenCode2PreparedSend =
  | { kind: "command"; command: OpenCodeCommandDispatch; files?: OpenCode2FileInput[] }
  | { kind: "prompt"; files?: OpenCode2FileInput[] };

export interface OpenCode2VisibleHistory {
  /** Oldest first, without the rows a staged revert covers. */
  rows: OpenCode2Message[];
  /** False when only the newest `limit` rows were read. */
  complete: boolean;
  revert?: OpenCode2RevertMarker;
  session?: OpenCode2SessionDetails;
}

function isNotFound(error: unknown): boolean {
  return error instanceof OpenCode2RequestError && error.status === 404;
}

export class OpenCode2SessionFeatures {
  readonly models: OpenCode2ModelCatalogueCache;
  readonly agents: OpenCode2AgentCache;
  readonly commands: OpenCodeCommandRegistry;
  /** `model#effort` last applied per session, so an unchanged selection sends nothing. */
  private readonly appliedModel = new Map<string, string>();
  private readonly appliedAgent = new Map<string, string>();
  private readonly allowedModelProviders: () => Promise<readonly string[]>;

  constructor(
    private readonly client: OpenCode2Client,
    dependencies: OpenCode2FeatureDependencies = {},
  ) {
    const now = dependencies.now ?? Date.now;
    this.allowedModelProviders =
      dependencies.allowedModelProviders ?? (async () => DEFAULT_OPENCODE_MODEL_PROVIDERS);
    this.models = new OpenCode2ModelCatalogueCache(client, this.allowedModelProviders, now);
    this.agents = new OpenCode2AgentCache(client, now);
    this.commands = createOpenCode2CommandRegistry(client, now);
  }

  forget(sessionId: string): void {
    this.appliedModel.delete(sessionId);
    this.appliedAgent.delete(sessionId);
  }

  refreshCatalog(): void {
    this.models.clear();
    this.agents.clear();
    this.commands.invalidate();
  }

  // ── create and send ────────────────────────────────────────────────────────

  /** A new 2.x session's default, from this server's catalogue (`models.ts`). */
  async resolveDefaultModel(modelId: string | undefined) {
    return resolveOpenCode2DefaultModel(modelId, await this.models.readOrUndefined());
  }

  /**
   * The model a new session starts on. A model this server cannot serve is
   * left out, so the session starts on OpenCode's default and the next send
   * refuses the selection with a clear reason instead of the tab failing to
   * open.
   */
  async createModel(
    options: Pick<ProviderCreateSessionOptions, "model" | "effort">,
  ): Promise<OpenCode2ModelRef | undefined> {
    if (!options.model) return undefined;
    try {
      return openCode2ModelSelection(
        options.model,
        options.effort,
        await this.models.readOrUndefined(),
      );
    } catch {
      return undefined;
    }
  }

  /** Record what a session was created with, so its first send does not re-send it. */
  noteCreated(
    sessionId: string,
    model: OpenCode2ModelRef | undefined,
    options: { model?: string; effort?: string },
  ): void {
    if (model && options.model)
      this.appliedModel.set(sessionId, modelKey(options.model, options.effort));
  }

  /**
   * Everything a send decides before its prompt or command is posted: the
   * command (refusing a stale selection), the files, and the session's model,
   * effort and agent, which are session state on 2.x. Nothing here dispatches
   * a turn, so every failure is a refusal or unavailability, never ambiguous.
   */
  async prepareSend(
    sessionId: string,
    prompt: string,
    options: ProviderSendOptions,
  ): Promise<OpenCode2PreparedSend> {
    const command = await resolveOpenCode2CommandDispatch(this.commands, prompt, options);
    const files = openCode2PromptFiles(options, this.client.directory);
    await this.applyModel(sessionId, options.model, options.effort);
    await this.applyAgent(sessionId, options.executionAgent ?? options.mode);
    return command
      ? { kind: "command", command, ...(files ? { files } : {}) }
      : { kind: "prompt", ...(files ? { files } : {}) };
  }

  sendCommand(
    sessionId: string,
    prepared: Extract<OpenCode2PreparedSend, { kind: "command" }>,
  ): Promise<void> {
    return dispatchOpenCode2Command(this.client, sessionId, prepared.command, prepared.files);
  }

  private async applyModel(
    sessionId: string,
    modelId: string | undefined,
    effort: string | undefined,
  ): Promise<void> {
    if (!modelId) return;
    const key = modelKey(modelId, effort);
    if (this.appliedModel.get(sessionId) === key) return;
    const model = openCode2ModelSelection(modelId, effort, await this.models.readOrUndefined());
    // A session this provider has not switched yet (resumed, or after a
    // restart) may already be on it; every switch appends a history row.
    if (!this.appliedModel.has(sessionId)) {
      const current = await this.currentDetails(sessionId);
      if (current?.modelId && modelKey(current.modelId, current.reasoningId) === key) {
        this.appliedModel.set(sessionId, key);
        return;
      }
    }
    try {
      await this.client.selectModel(sessionId, model);
    } catch (error) {
      if (error instanceof OpenCode2RequestError) {
        throw new PromptRejectedError(`OpenCode refused the model: ${error.message}`);
      }
      // Nothing was dispatched yet: unavailable, not ambiguous.
      throw new ProviderUnavailableError("OpenCode 2.x model switch failed", { cause: error });
    }
    this.appliedModel.set(sessionId, key);
  }

  private async applyAgent(sessionId: string, agent: string | undefined): Promise<void> {
    const wanted = agent?.trim();
    if (!wanted || wanted === "default" || this.appliedAgent.get(sessionId) === wanted) return;
    if (
      !this.appliedAgent.has(sessionId) &&
      (await this.currentDetails(sessionId))?.agent === wanted
    ) {
      this.appliedAgent.set(sessionId, wanted);
      return;
    }
    await selectOpenCode2Agent(
      this.client,
      sessionId,
      wanted,
      await this.agents.read().catch(() => undefined),
    );
    this.appliedAgent.set(sessionId, wanted);
  }

  /** The session's own model and agent, or undefined when it cannot be read. */
  private async currentDetails(sessionId: string): Promise<OpenCode2SessionDetails | undefined> {
    return this.client
      .getSession(sessionId)
      .then(openCode2SessionDetails)
      .catch(() => undefined);
  }

  // ── session actions ────────────────────────────────────────────────────────

  async performAction(
    sessionId: string,
    action: Exclude<NativeAgentSessionAction, { kind: "steer" }>,
  ): Promise<NativeAgentSessionActionOutcome> {
    if (action.kind === "compact") {
      // 2.x compacts with the session's model; there is no per-request model.
      try {
        await this.client.api(
          "POST",
          `/api/session/${encodeURIComponent(sessionId)}/compact`,
          "OpenCode compact",
          { body: { delivery: "queue" } },
        );
      } catch (error) {
        if (error instanceof OpenCode2RequestError) {
          throw new PromptRejectedError(`OpenCode refused to compact: ${error.message}`);
        }
        throw new ProviderUnavailableError("OpenCode 2.x compact failed", { cause: error });
      }
      return { outcome: "applied" };
    }
    if (action.kind === "undo") {
      const history = await this.visibleHistory(sessionId, DEFAULT_HISTORY_LIMIT);
      // The rows are already cut at a staged revert, so the newest user row
      // left is the turn before it: undoing again goes one turn further back.
      const target =
        action.messageId ?? openCode2UndoTarget(history.rows, undefined, { complete: true });
      if (!target) throw new PromptRejectedError("There is no turn to undo");
      await stageOpenCode2Revert(this.client, sessionId, target);
      return { outcome: "applied" };
    }
    if (action.kind === "redo") {
      await clearOpenCode2Revert(this.client, sessionId);
      return { outcome: "applied" };
    }
    throw new PromptRejectedError(`OpenCode 2.x does not support ${action.kind}`);
  }

  // ── reads ──────────────────────────────────────────────────────────────────

  /**
   * The newest rows of the session as the tab should show them, with the
   * session record the read was cut by. A missing session reads as empty.
   */
  async visibleHistory(
    sessionId: string,
    limit = DEFAULT_HISTORY_LIMIT,
  ): Promise<OpenCode2VisibleHistory> {
    const [page, session] = await Promise.all([
      this.client.listMessages(sessionId, { limit, order: "desc" }).catch((error: unknown) => {
        if (isNotFound(error)) return undefined;
        throw error;
      }),
      this.client.getSession(sessionId).catch((error: unknown) => {
        if (isNotFound(error)) return undefined;
        throw error;
      }),
    ]);
    if (!page) return { rows: [], complete: true };
    const rows = [...page.messages].reverse();
    const complete = page.messages.length < limit;
    const revert = openCode2RevertMarker(session);
    return {
      rows: [...withoutStagedOpenCode2Revert(rows, revert, { complete })],
      complete,
      ...(revert ? { revert } : {}),
      ...(session ? { session: openCode2SessionDetails(session) } : {}),
    };
  }

  /**
   * The composer, selection, title and revert notice of one session. Optional
   * reads (catalogue, agents, session) degrade to their absence.
   */
  async sessionState(
    sessionId: string,
  ): Promise<
    Pick<
      ProviderSessionStateSnapshot,
      "composer" | "sessionModelId" | "sessionReasoningId" | "title" | "resumableSessionId"
    > & { notices: NativeAgentNotice[] }
  > {
    const [catalogue, profiles, session] = await Promise.all([
      this.models.readOrUndefined(),
      this.agents.read().catch(() => undefined),
      this.client.getSession(sessionId).catch(() => undefined),
    ]);
    const details = session ? openCode2SessionDetails(session) : {};
    const revert = openCode2RevertMarker(session);
    return {
      composer: composerState(catalogue, profiles, details),
      ...(details.modelId ? { sessionModelId: details.modelId } : {}),
      ...(details.reasoningId ? { sessionReasoningId: details.reasoningId } : {}),
      ...(details.title ? { title: details.title } : {}),
      resumableSessionId: `${OPENCODE2_RESUME_PREFIX}${sessionId}`,
      notices: openCode2RevertNotice(revert),
    };
  }

  async runtimeHealth(sessionId: string): Promise<ProviderRuntimeHealth> {
    const [history, commands] = await Promise.all([
      this.visibleHistory(sessionId).catch(() => undefined),
      this.commands.read().catch(() => undefined),
    ]);
    const todos = history ? openCode2TodoCount(history.rows) : undefined;
    return {
      summary: {
        state: "Running",
        ...(todos === undefined ? {} : { todos }),
        ...(commands ? { commands: commands.commands.length } : {}),
      },
      notices: [],
      authoritative: history !== undefined,
    };
  }

  async authStatus(): Promise<NativeAgentAuthStatus> {
    const [providers, allowed] = await Promise.all([
      this.client.api<unknown>("GET", "/api/provider", "OpenCode provider list", {
        maxBytes: 2 * 1024 * 1024,
      }),
      this.allowedModelProviders(),
    ]);
    return openCode2AuthStatus(providers, allowed, "Sign a provider in from Settings → OpenCode.");
  }

  commandCatalogue(): Promise<ProviderCommandCatalogue> {
    return this.commands.catalogue();
  }

  refreshCommands(): Promise<ProviderCommandRefreshResult> {
    return this.commands.refreshCommands();
  }

  // ── session lifecycle ──────────────────────────────────────────────────────

  fork(sessionId: string, messageId?: string): Promise<NativeAgentForkOutcome> {
    return forkOpenCode2Session(this.client, sessionId, messageId);
  }

  listResumable(options?: { includeArchived?: boolean }): Promise<NativeAgentResumeEntry[]> {
    return listOpenCode2ResumableSessions(this.client, options);
  }

  /** The 2.x session behind a resume-list id, checked to exist; throws for anything else. */
  async resumableSession(resumableId: string): Promise<string> {
    const sessionId = openCode2ResumeSessionId(resumableId) ?? resumableId;
    try {
      const details = openCode2SessionDetails(await this.client.getSession(sessionId));
      if (details.archived) {
        throw new PromptRejectedError("This OpenCode session is archived; restore it first");
      }
    } catch (error) {
      if (isNotFound(error)) throw new PromptRejectedError("OpenCode session was not found");
      throw error;
    }
    return sessionId;
  }

  async setArchived(resumableId: string, archived: boolean): Promise<void> {
    const sessionId = openCode2ResumeSessionId(resumableId) ?? resumableId;
    await updateOpenCode2Session(this.client, sessionId, { archived });
  }

  async setTitle(sessionId: string, title: string): Promise<void> {
    await updateOpenCode2Session(this.client, sessionId, { title });
  }
}

function modelKey(modelId: string, effort: string | undefined): string {
  return `${modelId}#${effort && effort !== "default" ? effort : "default"}`;
}

function composerState(
  catalogue: OpenCode2ModelCatalogue | undefined,
  profiles: Awaited<ReturnType<OpenCode2AgentCache["read"]>> | undefined,
  details: OpenCode2SessionDetails,
): NonNullable<ProviderSessionStateSnapshot["composer"]> {
  const models = catalogue?.models ?? [];
  const selectedModelId =
    details.modelId && models.some((model) => model.id === details.modelId)
      ? details.modelId
      : catalogue?.selectedModelId;
  return {
    ...EMPTY_NATIVE_AGENT_COMPOSER_STATE,
    models,
    ...(selectedModelId ? { selectedModelId } : {}),
    ...(selectedModelId && selectedModelId === details.modelId && details.reasoningId
      ? { selectedReasoningId: details.reasoningId }
      : {}),
    ...(profiles ? { executionProfiles: profiles } : {}),
    ...(details.agent && profiles?.some((profile) => profile.id === details.agent)
      ? { selectedExecutionProfileId: details.agent }
      : {}),
  };
}
