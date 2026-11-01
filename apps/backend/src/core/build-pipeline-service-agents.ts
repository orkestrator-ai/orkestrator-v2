/**
 * Agent harness resolution for build pipelines: the cached provider per
 * environment and harness, the bridge connection behind it, the model, effort
 * and speed each step runs under, and stopping every provider turn a
 * multi-model review owns.
 */
import {
  type BuildPipeline,
  type BuildPipelineAgent,
  type PipelineSessionPhase,
  stepKeyForSessionPhase,
} from "@orkestrator/protocol/build-pipeline";
import type { Environment, AppConfig } from "./models.js";
import {
  type BridgeConnection,
  type BuildPipelineProvider,
  createBuildPipelineProvider,
} from "./build-pipeline-provider.js";
import {
  sessionForCurrentPhase,
  sessionAgent,
  type BuildStepSelection,
  connectionDefaultsFor,
  createAgentModelCatalogReader,
  resolveFastMode,
  stepModel,
  type AgentModelCatalogReader,
} from "./build-pipeline-service-helpers.js";
import { UNATTENDED_AGENT_INTERACTION_POLICY } from "@orkestrator/protocol/agent-interactions";
import type {
  AgentModel,
  NativeAgentDefaultModelResolution,
} from "@orkestrator/protocol/native-agent";
import { stagePromptImages } from "./prompt-attachments.js";
import type { AgentSettingsTier } from "@orkestrator/protocol/agent-settings";
import type { BuildPipelineContext } from "./build-pipeline-context.js";
import { managedProvider, retireProvider } from "./provider-retirement.js";
import { clearReviewerAdmission } from "./review-fanout-admission.js";

/** Tiers and catalogue access shared by every selection in one operation. */
interface BuildSelectionContext {
  environment: { agentSettings?: AgentSettingsTier };
  config: Pick<AppConfig, "global">;
  repository: { agentSettings?: AgentSettingsTier };
  readCatalog: AgentModelCatalogReader;
  /** The model the runtime will use for a configured default, set or unset. */
  resolveDefaultModel: (
    agent: BuildPipelineAgent,
    modelId: string | undefined,
  ) => Promise<NativeAgentDefaultModelResolution | undefined>;
}

export class BuildPipelineAgents {
  constructor(private readonly ctx: BuildPipelineContext) {}

  async provider(
    pipeline: BuildPipeline,
    agent: BuildPipelineAgent = pipeline.agentType,
  ): Promise<BuildPipelineProvider> {
    // Recorded before anything that can throw, so a bridge that is unreachable
    // during connection setup is still attributed to the right harness.
    this.ctx.lastProviderAgent.set(pipeline.id, agent);
    const providerKey = `${pipeline.environmentId}:${agent}`;
    // Concurrent reviewers of one harness resolve this key together. Joining
    // the in-flight creation keeps it to one provider per key: a second
    // instance would never be cached, so nothing would dispose it, and an
    // OpenCode provider's event monitor runs until it is disposed.
    let provider = this.ctx.providers.get(providerKey);
    if (!provider) {
      let creation = this.ctx.providerCreations.get(providerKey);
      if (!creation) {
        creation = this.createProvider(pipeline, agent).then((created) => {
          const managed = managedProvider(created);
          this.ctx.providers.set(providerKey, managed);
          return managed;
        });
        const pending = creation;
        this.ctx.providerCreations.set(providerKey, pending);
        void pending
          .catch(() => undefined)
          .finally(() => {
            if (this.ctx.providerCreations.get(providerKey) === pending) {
              this.ctx.providerCreations.delete(providerKey);
            }
          });
      }
      provider = await creation;
    }
    // Only this harness's own sessions. Registering a sibling step's session id
    // would put a foreign session into an environment-wide monitor that is
    // supposed to ignore everything it does not own.
    for (const session of pipeline.sessions) {
      if (sessionAgent(pipeline, session) !== agent) continue;
      provider.registerSession?.(session.sdkSessionId, {
        origin: session.origin ?? "build-pipeline",
        interactionPolicy: session.interactionPolicy ?? UNATTENDED_AGENT_INTERACTION_POLICY,
        // A packaged review runs as a read-only reviewer. A recreated OpenCode
        // provider needs the marker to restore its constrained reviewer shell,
        // which it grants only to a session created with reviewer metadata.
        ...(session.phase === "review" && pipeline.reviewPackage ? { reviewerSession: true } : {}),
        phase: session.phase,
        workflowId: pipeline.id,
        provider: agent,
        fence: session.sessionKey,
      });
    }
    return provider;
  }

  /** Evict only the failed generation; concurrent consumers finish before disposal. */
  async evictUnreachableProvider(
    pipeline: BuildPipeline,
    agent: BuildPipelineAgent,
    provider: BuildPipelineProvider,
  ): Promise<void> {
    const key = `${pipeline.environmentId}:${agent}`;
    if (this.ctx.providers.get(key) !== provider) return;
    this.ctx.providers.delete(key);
    retireProvider(provider);
  }

  /** Builds an uncached provider for one environment harness. */
  private async createProvider(
    pipeline: BuildPipeline,
    agent: BuildPipelineAgent,
  ): Promise<BuildPipelineProvider> {
    if (this.ctx.options.provider) return this.ctx.options.provider(pipeline, agent);
    const environment = await this.ctx.storage.getEnvironment(pipeline.environmentId);
    if (!environment) throw new Error("Build environment no longer exists");
    const config = await this.ctx.storage.loadConfig();
    const repository = await this.ctx.storage.getRepositoryConfig(pipeline.projectId);
    const connection = await this.bridgeConnection(agent, environment);
    const { fastMode: _fastMode, ...connectionDefaults } = connectionDefaultsFor(
      agent,
      config,
      repository,
      environment,
    );
    return createBuildPipelineProvider(
      {
        ...connection,
        // Connection-level defaults only, and only this harness's own. Every
        // pipeline turn passes the step's model and effort per call, which take
        // precedence; these fill in whatever the step left unset.
        ...connectionDefaults,
      },
      {
        ...this.ctx.options.providerDependencies,
        workflowResults: this.ctx.options.workflowResults,
        bridgeEnvironmentId: environment.id,
        refreshConnection: () => this.bridgeConnection(agent, environment),
        // Task-snapshot images arrive as base64. Both bridges require a workspace
        // path, so they have to be written into the environment before they can be
        // attached to a prompt.
        stageImages: (images) => stagePromptImages(this.ctx.invoke, environment, images),
      },
    );
  }

  async bridgeConnection(
    agent: BuildPipelineAgent,
    environment: Environment,
  ): Promise<BridgeConnection> {
    const suffix = agent === "opencode" ? "opencode" : agent;
    if (environment.environmentType === "local") {
      const result = await this.ctx.invoke<{
        port: number;
        authToken?: string;
      }>(`start_local_${suffix}_server_cmd`, {
        environmentId: environment.id,
      });
      if (!result.authToken) throw new Error(`${agent} bridge authentication is unavailable`);
      return {
        agent,
        baseUrl: `http://127.0.0.1:${result.port}`,
        authToken: result.authToken,
        directory: environment.worktreePath,
      };
    }
    if (!environment.containerId) throw new Error("Build container is unavailable");
    const result = await this.ctx.invoke<{
      hostPort: number;
      authToken?: string;
    }>(`start_${suffix}_server`, {
      containerId: environment.containerId,
    });
    if (!result.authToken) throw new Error(`${agent} bridge authentication is unavailable`);
    return {
      agent,
      baseUrl: `http://127.0.0.1:${result.hostPort}`,
      authToken: result.authToken,
    };
  }

  /**
   * The harness, model and reasoning a step runs under.
   *
   * A step's own selections win. A field it left unset resolves to that
   * harness's default — the same value the launcher displayed for it — which
   * `connectionDefaultsFor` supplies one layer down when these are `undefined`.
   * The repository defaults never cross to a harness they were not chosen for.
   */
  async stepSettings(
    pipeline: BuildPipeline,
    sessionPhase: PipelineSessionPhase,
  ): Promise<BuildStepSelection> {
    const step = pipeline.steps?.[stepKeyForSessionPhase(sessionPhase)];
    if (step) {
      const effort = step.reasoningEffort?.trim();
      return this.settingsForSelection(pipeline, {
        agent: step.agent,
        // Normalised on read as well as on write: `start()` is not the only way
        // a snapshot gets here — `importLegacy` accepts one straight from disk,
        // where a placeholder could otherwise be sent as a real model id.
        model: stepModel(step.agent, step.model),
        effort: effort && effort !== "default" ? effort : undefined,
        fastMode: step.fastMode,
      });
    }
    const config = await this.ctx.storage.loadConfig();
    const repository = await this.ctx.storage.getRepositoryConfig(pipeline.projectId);
    // Deliberately without the environment tier, and deliberately without
    // `fastMode`. Model and effort keep their established repository-and-global
    // semantics here, while an unpinned speed has to stay absent so
    // `settingsForSelection` can resolve it across all three tiers. Passing a
    // repository value through as if the step had pinned it would let it shadow
    // the environment's own choice.
    const { fastMode: _inheritedFastMode, ...defaults } = connectionDefaultsFor(
      pipeline.agentType,
      config,
      repository,
    );
    return this.settingsForSelection(
      pipeline,
      { agent: pipeline.agentType, ...defaults },
      { modelFromDefaults: true },
    );
  }

  /**
   * The tiers and catalogue one operation resolves its selections against.
   *
   * Loaded once and shared, so a fan-out resolving one selection per reviewer
   * does not repeat these reads — or the catalogue fetch behind them — per
   * reviewer.
   */
  async selectionContext(pipeline: BuildPipeline): Promise<BuildSelectionContext> {
    const environment = await this.ctx.storage.getEnvironment(pipeline.environmentId);
    if (!environment) throw new Error("Build environment no longer exists");
    const config = await this.ctx.storage.loadConfig();
    const repository = await this.ctx.storage.getRepositoryConfig(pipeline.projectId);
    return {
      environment,
      config,
      repository,
      readCatalog: createAgentModelCatalogReader(() =>
        this.ctx.invoke<AgentModel[]>("get_native_agent_model_catalog", {
          environmentId: pipeline.environmentId,
        }),
      ),
      // Asks the harness the stage is about to run on anyway, so connectivity
      // comes from the same live report its dispatch preflight reads. Advisory:
      // a provider that cannot be reached here fails in its own setup instead.
      resolveDefaultModel: async (agent, modelId) => {
        try {
          const provider = await this.provider(pipeline, agent);
          return await provider.resolveDefaultModel?.(modelId);
        } catch {
          return undefined;
        }
      },
    };
  }

  async settingsForSelection(
    pipeline: BuildPipeline,
    selection: BuildStepSelection,
    options: { modelFromDefaults?: boolean } = {},
  ): Promise<BuildStepSelection> {
    return this.resolveSelection(selection, await this.selectionContext(pipeline), options);
  }

  /** Resolve a whole fan-out's selections against one shared context. */
  async settingsForSelections(
    pipeline: BuildPipeline,
    selections: readonly BuildStepSelection[],
  ): Promise<BuildStepSelection[]> {
    if (selections.length === 0) return [];
    const context = await this.selectionContext(pipeline);
    return Promise.all(selections.map((selection) => this.resolveSelection(selection, context)));
  }

  /**
   * `modelFromDefaults` marks a selection whose model was filled in from the
   * configured defaults rather than pinned by the step.
   */
  private async resolveSelection(
    selection: BuildStepSelection,
    context: BuildSelectionContext,
    options: { modelFromDefaults?: boolean } = {},
  ): Promise<BuildStepSelection> {
    const defaults = connectionDefaultsFor(
      selection.agent,
      context.config,
      context.repository,
      context.environment,
    );
    // A configured default whose OpenCode provider this login has not
    // connected would fail the stage at its first turn, and an unset one would
    // leave the choice to OpenCode's server, which ignores the provider
    // allowlist. Both resolve to OpenCode's effective default for this stage
    // only: the configuration keeps the user's choice for when the provider
    // reconnects. A model the step pinned is left alone, so an explicit choice
    // still fails loudly. Codex gets the same treatment for a configured
    // default its login's live catalogue does not offer, which fails every
    // turn of the session it was created with.
    const usesDefault = options.modelFromDefaults || !selection.model;
    const configuredDefault = selection.model ?? defaults.model;
    const resolution =
      (selection.agent === "opencode" || selection.agent === "codex") && usesDefault
        ? await context.resolveDefaultModel(selection.agent, configuredDefault)
        : undefined;
    const modelSubstitution = resolution?.substitution;
    // Pinned only when the resolution differs from what the provider would
    // have used anyway, so an unpinned step that resolves to its own default
    // keeps its established unpinned shape.
    const model =
      resolution?.modelId && resolution.modelId !== configuredDefault
        ? resolution.modelId
        : selection.model;
    // A deliberately unpinned step keeps its established model/effort
    // semantics. The provider may still have a connection default, so use that
    // effective model for the speed capability check without pinning it here.
    const capabilityModel = model ?? defaults.model;
    const fastMode = await resolveFastMode(
      selection.agent,
      selection.fastMode ?? defaults.fastMode,
      capabilityModel,
      context.readCatalog,
    );
    const substitution = modelSubstitution ?? selection.modelSubstitution;
    return {
      agent: selection.agent,
      ...(model ? { model } : {}),
      ...(selection.effort ? { effort: selection.effort } : {}),
      ...(typeof fastMode === "boolean" ? { fastMode } : {}),
      ...(substitution && substitution.modelId === model
        ? { modelSubstitution: substitution }
        : {}),
    };
  }

  /** Stops every provider turn owned by a live multi-model review. */
  async abandonReviewFanout(
    pipeline: BuildPipeline,
    sessionStatus: "idle" | "error",
  ): Promise<unknown[]> {
    const fanout = pipeline.reviewFanout;
    if (!fanout) return [];
    const now = new Date().toISOString();
    const targets: Array<{ agent: BuildPipelineAgent; sessionId: string }> = [];
    for (const reviewer of fanout.reviewers) {
      if (
        reviewer.status !== "pending" &&
        reviewer.status !== "running" &&
        reviewer.status !== "cancelled"
      ) {
        continue;
      }
      reviewer.status = "cancelled";
      reviewer.completedAt = now;
      clearReviewerAdmission(reviewer);
      delete reviewer.stalledSince;
      delete reviewer.idleResultPolls;
      if (reviewer.providerSessionId) {
        const session = pipeline.sessions.find(
          (candidate) => candidate.sdkSessionId === reviewer.providerSessionId,
        );
        if (session) {
          session.completedAt = now;
          session.reviewerOutcome = "cancelled";
          if (reviewer.tokenCount !== undefined) session.tokenCount = reviewer.tokenCount;
          if (reviewer.cacheReadTokens !== undefined) {
            session.cacheReadTokens = reviewer.cacheReadTokens;
          }
          if (!reviewer.modelUnpinned) session.model = reviewer.model;
          if (reviewer.reasoningEffort) session.reasoningEffort = reviewer.reasoningEffort;
        }
        targets.push({
          agent: reviewer.agent as BuildPipelineAgent,
          sessionId: reviewer.providerSessionId,
        });
      }
    }
    if (fanout.consolidation && !fanout.report) {
      targets.push({
        agent: fanout.consolidation.agent as BuildPipelineAgent,
        sessionId: fanout.consolidation.providerSessionId,
      });
    }
    const fanoutOwnsCurrentSession =
      pipeline.phase === "reviewing" ||
      (pipeline.phase === "paused" && pipeline.pausedFromPhase === "reviewing");
    const currentSession = sessionForCurrentPhase(pipeline);
    if (!fanoutOwnsCurrentSession && currentSession?.status === "running") {
      targets.push({
        agent: sessionAgent(pipeline, currentSession),
        sessionId: currentSession.sdkSessionId,
      });
    }
    const uniqueTargets = Array.from(
      new Map(targets.map((target) => [target.sessionId, target])).values(),
    );
    const mirroredSessionIds = new Set(
      fanout.reviewers.flatMap((reviewer) =>
        reviewer.providerSessionId ? [reviewer.providerSessionId] : [],
      ),
    );
    if (fanout.consolidation) mirroredSessionIds.add(fanout.consolidation.providerSessionId);
    for (const target of uniqueTargets) mirroredSessionIds.add(target.sessionId);
    const results = await Promise.allSettled(
      uniqueTargets.map(async ({ agent, sessionId }) => {
        await (await this.provider(pipeline, agent)).abort(sessionId);
      }),
    );
    const unconfirmed = new Set(
      uniqueTargets
        .filter((_target, index) => results[index]?.status === "rejected")
        .map((target) => target.sessionId),
    );
    for (const sessionId of mirroredSessionIds) {
      const session = pipeline.sessions.find((candidate) => candidate.sdkSessionId === sessionId);
      if (!session) continue;
      if (unconfirmed.has(sessionId)) {
        session.status = "running";
        delete session.completedAt;
      } else if (session.status === "running") {
        session.status = sessionStatus;
        session.completedAt ??= now;
      }
    }
    return results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  }
}
