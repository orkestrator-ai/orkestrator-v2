import { connectionDefaultsFor } from "./build-pipeline-service-helpers.js";
/** Manual-only promotion. The tab's own agent drafts; the user confirms. */
import { randomUUID, createHash } from "node:crypto";
import {
  autoPipelineDraftPrompt,
  parseAutoPipelineTicket,
  parseAutoPipelineResult,
  type AutoPipelineDraft,
  type AutoPipelineEdits,
  type AutoPipelineState,
  type AutoPipelineTicket,
  type AutoPipelineSources,
} from "@orkestrator/protocol/build-pipeline";
import type { StartBuildPipelineInput } from "@orkestrator/protocol/build-pipeline";
import type { CommandContext } from "./commands-context.js";
import type { BuildPipelineProvider } from "./build-pipeline-provider.js";
import {
  assertNoOtherWorkflowWriting,
  withWorkspaceCodeRewindReservation,
  type EnvironmentGit,
} from "./workspace-code-rewind.js";
import { multiReviewWorkspaceUse } from "./workspace-writers.js";
import { paneLayoutLeaves } from "./storage-shared.js";
import { nativeTabLogicalSessionKey } from "@orkestrator/protocol/public-api-resources";
import { buildPipelineStartWithSavedDefaults } from "./build-pipeline-launch.js";
import { boundAdoptedTranscript } from "./auto-pipeline-transcript.js";
import type { Environment, PersistedNativeAgentSession } from "./models.js";
import type { CompletedBuildAttempt } from "./build-pipeline-completed-build.js";

export interface AutoPipelinePorts {
  provider(
    environment: Environment,
    agent: PersistedNativeAgentSession["agent"],
  ): Promise<BuildPipelineProvider>;
  release(): void;
  git: EnvironmentGit;
}
export interface AutoPipelineDraftRecord {
  environmentId: string;
  environment: Environment;
  source: PersistedNativeAgentSession;
  input: StartBuildPipelineInput;
  attempt: CompletedBuildAttempt;
  draft: AutoPipelineDraft;
  fingerprint: string;
  /** The user's unconfirmed changes to the generated ticket fields. */
  edits?: AutoPipelineEdits;
  reviewed?: AutoPipelineTicket;
  pipelineId?: string;
  /**
   * The source tab's newest dispatched request when the agent submitted this
   * draft. Confirming refuses once the tab has taken another message, so the
   * draft always describes the conversation the user is looking at. Absent on
   * a draft an earlier version wrote, which therefore expires.
   */
  sourceMark?: string;
}
/** The newest request the tab has dispatched; what a draft is checked against. */
function sourceMarkOf(session: PersistedNativeAgentSession | undefined): string {
  return session?.dispatchedRequestIds?.at(-1) ?? "";
}
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export { parseAutoPipelineResult } from "@orkestrator/protocol/build-pipeline";

const draftingByStorage = new WeakMap<
  CommandContext["storage"],
  Map<string, { operation: Promise<AutoPipelineDraft>; controller: AbortController }>
>();

/**
 * Process-local outcomes the tab's state read reports. Drafting and promotion
 * run in this process, so a restart ends them; the persisted draft records
 * remain and are what the tab then shows. Each map is bounded by the drafting
 * cap or by the number of drafts, and an entry is replaced on the next attempt.
 */
interface AutoPipelineOutcomes {
  /** `environmentId:tabId` → why its last drafting attempt failed. */
  failures: Map<string, string>;
  /**
   * Draft id → confirmations in progress for it. Keyed by draft rather than
   * tab, so a newer draft of the same tab is never reported as promoting.
   */
  promoting: Map<string, number>;
  /** Draft id → why its last confirmation was refused. */
  confirmErrors: Map<string, string>;
}
const outcomesByStorage = new WeakMap<CommandContext["storage"], AutoPipelineOutcomes>();
const MAX_OUTCOMES = 256;
/** Drafting sessions one backend runs at once, across every environment. */
export const MAX_ACTIVE_DRAFTS = 32;
function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_OUTCOMES) map.delete(map.keys().next().value as K);
}
function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message.trim() || "Auto-pipeline failed").slice(0, 2000);
}

/** Drafts and promotion receipts survive restarts; clients cannot replace generated notes. */
export class AutoPipelineService {
  constructor(
    private readonly context: CommandContext,
    private readonly ports: () => AutoPipelinePorts,
    /** How long a request waits for the agent's draft; the turn ending ends it sooner. */
    private readonly draftTimeoutMs = 30 * 60_000,
    /** How often a request looks for the draft and for the end of the agent's turn. */
    private readonly pollMs = 1_000,
  ) {}

  private outcomes(): AutoPipelineOutcomes {
    let outcomes = outcomesByStorage.get(this.context.storage);
    if (!outcomes) {
      outcomes = { failures: new Map(), promoting: new Map(), confirmErrors: new Map() };
      outcomesByStorage.set(this.context.storage, outcomes);
    }
    return outcomes;
  }
  /**
   * Where a tab's draft stands. Reads only: it never starts, resumes or
   * revalidates drafting, so polling it from a mounted tab is cheap and safe.
   */
  state(environmentId: string, tabId: string): AutoPipelineState {
    const key = `${environmentId}:${tabId}`;
    const outcomes = this.outcomes();
    // Once any draft of the tab is promoted the environment belongs to that
    // pipeline, so a newer draft can never be confirmed: report the promotion.
    const promoted = this.context.storage.latestAutoPipelineDraft(environmentId, tabId, {
      includeReviewed: true,
      promotedOnly: true,
    });
    if (promoted?.pipelineId) return { phase: "promoted", pipelineId: promoted.pipelineId };
    const record = this.context.storage.latestAutoPipelineDraft(environmentId, tabId, {
      includeReviewed: true,
    });
    const edits = record?.edits ? { edits: record.edits } : {};
    // A draft whose confirmation began keeps the ticket it was confirmed with.
    const reviewed = record?.reviewed ? { reviewed: record.reviewed } : {};
    if (record && outcomes.promoting.has(record.draft.id))
      return { phase: "promoting", draft: record.draft, ...edits, ...reviewed };
    if (draftingByStorage.get(this.context.storage)?.has(key)) return { phase: "drafting" };
    const failure = outcomes.failures.get(key);
    if (failure) return { phase: "failed", error: failure };
    if (!record) return { phase: "idle" };
    const confirmError = outcomes.confirmErrors.get(record.draft.id);
    return {
      phase: "ready",
      draft: record.draft,
      ...edits,
      ...reviewed,
      ...(confirmError ? { confirmError } : {}),
    };
  }
  /** Keeps unconfirmed ticket edits with the draft; refused once confirmation has begun. */
  saveEdits(draftId: string, edits: AutoPipelineEdits): void {
    const record = this.context.storage.getAutoPipelineDraft(draftId);
    if (!record) throw new Error("Auto-pipeline draft expired. Draft again before editing");
    if (record.reviewed || record.pipelineId)
      throw new Error("This draft was already confirmed; its ticket can no longer change");
    if (this.outcomes().promoting.has(draftId))
      throw new Error("This draft is being confirmed; its ticket can no longer change");
    record.edits = {
      title: edits.title,
      description: edits.description,
      acceptanceCriteria: [...edits.acceptanceCriteria],
    };
    this.context.storage.putAutoPipelineDraft(record);
  }
  private async environment(id: string): Promise<Environment> {
    const environment = await this.context.storage.getEnvironment(id);
    if (!environment || environment.projectHome || environment.deletionRequestedAt)
      throw new Error("Choose a prompt environment");
    const pipelines = await this.context.storage.listBuildPipelines(environment.projectId);
    if (pipelines.some((record) => record.environmentId === id))
      throw new Error("This environment already belongs to a pipeline");
    return environment;
  }
  /**
   * Interactive sessions behind this environment's open tabs, active tab first.
   * A session's `logicalSessionKey` is `env-<environmentId>:<tabId>`, never the
   * bare tab id the pane layout and the renderer use.
   */
  private async sessions(
    id: string,
    /** Read the shared frozen snapshot, for a caller that only reads. */
    snapshot = false,
  ): Promise<{ tabId: string; session: PersistedNativeAgentSession }[]> {
    const layout = await this.context.storage.getPaneLayout(id);
    const leaves = paneLayoutLeaves(layout?.root);
    const activeTab = leaves.find((leaf) => leaf.id === layout?.activePaneId)?.activeTabId;
    const tabIdByKey = new Map<string, string>();
    for (const tab of leaves.flatMap((leaf) => leaf.tabs)) {
      if (typeof tab.id === "string")
        tabIdByKey.set(nativeTabLogicalSessionKey(id, tab.id), tab.id);
    }
    const sessions = snapshot
      ? await this.context.storage.readNativeAgentSessionsSnapshot()
      : await this.context.storage.listNativeAgentSessions();
    return sessions
      .flatMap((session) => {
        const tabId = tabIdByKey.get(session.logicalSessionKey);
        return session.environmentId === id && session.origin === "interactive-native" && tabId
          ? [{ tabId, session }]
          : [];
      })
      .sort((a, b) => Number(b.tabId === activeTab) - Number(a.tabId === activeTab));
  }
  private async session(environmentId: string, tabId: string) {
    return (await this.sessions(environmentId)).find((entry) => entry.tabId === tabId)?.session;
  }
  async sources(id: string): Promise<AutoPipelineSources> {
    let environment: Environment;
    try {
      environment = await this.environment(id);
    } catch {
      return { available: false, sources: [] };
    }
    const ports = this.ports();
    try {
      const sources = [];
      for (const { tabId, session } of await this.sessions(id)) {
        try {
          const provider = await ports.provider(environment, session.agent);
          const idle =
            !session.pendingDispatch &&
            !session.pendingSteer &&
            (await provider.status(session.providerSessionId)) === "idle";
          sources.push({
            tabId,
            label: session.backendTitle?.title ?? session.agent,
            ...(!idle ? { disabledReason: "Wait for this tab's turn to finish" } : {}),
          });
        } catch {
          sources.push({
            tabId,
            label: session.backendTitle?.title ?? session.agent,
            disabledReason: "This tab is unavailable. Retry when its provider reconnects",
          });
        }
      }
      return { available: true, sources };
    } finally {
      ports.release();
    }
  }
  private async fingerprint(ports: AutoPipelinePorts, environment: Environment) {
    const id = environment.id;
    const base = environment.delegationBaseCommit ?? environment.createdFromCommit;
    if (!base || !/^[a-f0-9]{40,64}$/i.test(base))
      throw new Error("The environment's base commit is unavailable");
    const head = (await ports.git(id, ["rev-parse", "HEAD"])).trim();
    const branch = (await ports.git(id, ["branch", "--show-current"])).trim();
    if (branch !== environment.branch) throw new Error("The environment branch changed");
    const status = await ports.git(id, ["status", "--porcelain", "--untracked-files=all"]);
    if (status.split("\n").filter(Boolean).length > 1000)
      throw new Error("Too many pending files to promote (maximum 1000)");
    const diff = await ports.git(id, ["diff", "--no-ext-diff", "--no-textconv", base, "--"]);
    const untracked = (await ports.git(id, ["ls-files", "--others", "--exclude-standard", "-z"]))
      .split("\0")
      .filter(Boolean);
    if (untracked.length > 1000) throw new Error("Too many pending files to promote");
    const hashes = untracked.length ? await ports.git(id, ["hash-object", "--", ...untracked]) : "";
    return {
      head,
      status,
      diff,
      fingerprint: digest({ head, branch, status, diff, untracked, hashes }),
    };
  }
  /**
   * Asks the source tab's own agent to draft, and resolves with the draft it
   * submits through `convert_to_pipeline`. The agent works from its own record
   * of the session and from the repository, so no transcript or diff is copied
   * into a prompt and nothing here can outgrow one. The request is an ordinary
   * message in the tab, sent at most once under its own request id.
   *
   * Outcomes are recorded for the tab's state read; a restart ends the wait,
   * but an agent that still calls the tool afterwards leaves a draft the tab
   * then shows.
   */
  draft(environmentId: string, tabId: string): Promise<AutoPipelineDraft> {
    let active = draftingByStorage.get(this.context.storage);
    if (!active) {
      active = new Map();
      draftingByStorage.set(this.context.storage, active);
    }
    const key = `${environmentId}:${tabId}`;
    const pending = active.get(key);
    if (pending) return pending.operation;
    const outcomes = this.outcomes();
    if (active.size >= MAX_ACTIVE_DRAFTS) {
      // Refused before the tab is asked anything; record it so the tab can say why.
      const error = new Error("Too many drafting requests are running. Retry when one finishes");
      remember(outcomes.failures, key, error.message);
      return Promise.reject(error);
    }
    const controller = new AbortController();
    outcomes.failures.delete(key);
    const operation = this.requestDraft(environmentId, tabId, controller.signal);
    active.set(key, { operation, controller });
    operation.catch((error: unknown) => {
      // A cancelled draft is a deliberate stop, not a failure to show.
      if (!controller.signal.aborted) remember(outcomes.failures, key, errorText(error));
    });
    return operation.finally(() => {
      if (active.get(key)?.operation === operation) active.delete(key);
    });
  }
  cancelDraft(environmentId: string, tabId: string): void {
    draftingByStorage
      .get(this.context.storage)
      ?.get(`${environmentId}:${tabId}`)
      ?.controller.abort(new Error("Auto-pipeline drafting cancelled"));
  }
  private async requestDraft(
    environmentId: string,
    tabId: string,
    signal: AbortSignal,
  ): Promise<AutoPipelineDraft> {
    const nativeAgents = this.context.nativeAgents;
    if (!nativeAgents) throw new Error("Native agent service is unavailable");
    const environment = await this.environment(environmentId);
    const source = await this.session(environmentId, tabId);
    if (!source) throw new Error("Choose an open interactive agent tab");
    const ports = this.ports();
    let provider: BuildPipelineProvider | undefined;
    try {
      signal.throwIfAborted();
      provider = await ports.provider(environment, source.agent);
      if (
        source.pendingDispatch ||
        source.pendingSteer ||
        (await provider.status(source.providerSessionId)) !== "idle"
      )
        throw new Error("Wait for this tab's turn to finish");
      // Refuse a checkout that could never be promoted before asking the agent to describe it.
      const state = await this.fingerprint(ports, environment);
      // Nothing changed since the last draft: it still describes the tab.
      const existing = this.context.storage.latestAutoPipelineDraft(environmentId, tabId);
      if (
        existing?.sourceMark !== undefined &&
        existing.sourceMark === sourceMarkOf(source) &&
        existing.fingerprint === state.fingerprint
      )
        return existing.draft;
      signal.throwIfAborted();
      const startedAt = Date.now();
      const deadline = startedAt + this.draftTimeoutMs;
      const requestId = `auto-pipeline:${randomUUID()}`;
      const identity = {
        environmentId,
        agent: source.agent,
        logicalSessionKey: source.logicalSessionKey,
      };
      const outcome = await nativeAgents.dispatchIntent({
        ...identity,
        origin: "interactive-native",
        prompt: autoPipelineDraftPrompt(),
        requestId,
      });
      if (outcome.outcome !== "accepted")
        throw new Error(
          ("error" in outcome && outcome.error) || "The tab did not accept the drafting request",
        );
      const submitted = () => {
        const record = this.context.storage.latestAutoPipelineDraft(environmentId, tabId);
        return record && Date.parse(record.attempt.completedAt) >= startedAt ? record.draft : null;
      };
      while (Date.now() < deadline) {
        signal.throwIfAborted();
        const found = submitted();
        if (found) return found;
        const turn = await nativeAgents.sessionTurnOutcome({ ...identity, requestId });
        if (turn.outcome !== "pending") {
          // The call is made inside the turn, so a draft stored before the turn
          // settled is visible now.
          const late = submitted();
          if (late) return late;
          if (turn.outcome === "failed")
            throw new Error(turn.error?.trim() || "The agent's turn failed before it drafted");
          throw new Error(
            turn.outcome === "completed"
              ? "The agent finished without submitting a draft. Retry drafting"
              : "Could not confirm the agent's turn finished. Retry drafting",
          );
        }
        await new Promise((resolve) => setTimeout(resolve, this.pollMs));
      }
      throw new Error("Drafting timed out waiting for the agent");
    } catch (error) {
      // Stopping the wait stops the agent's turn: it would otherwise carry on
      // drafting something nobody is waiting for.
      if (signal.aborted && provider)
        await provider.abort(source.providerSessionId).catch(() => undefined);
      throw error;
    } finally {
      ports.release();
    }
  }
  /**
   * Whether this tab may be offered `convert_to_pipeline`: an open interactive
   * agent tab of a prompt environment that does not belong to a pipeline.
   * Read-only and bounded to one environment's tabs (the sessions come from the
   * shared frozen snapshot), because the tool list asks on every MCP request.
   */
  async offered(environmentId: string, tabId: string): Promise<boolean> {
    try {
      await this.environment(environmentId);
      return (await this.sessions(environmentId, true)).some((entry) => entry.tabId === tabId);
    } catch {
      return false;
    }
  }
  /**
   * Stores the draft an interactive tab's agent submitted. Called by
   * `convert_to_pipeline`, whether the user pressed the toolbar button or asked
   * in plain chat. It only records a draft: nothing is created or started
   * until the user reviews it and confirms.
   *
   * The agent supplies the ticket and notes; the checkout's state and the tab's
   * newest message are read here, so a draft cannot claim a different state
   * than the one it was written against. A later call replaces an unconfirmed
   * draft of the same tab. Once a draft has started a pipeline the environment
   * belongs to it, so `environment()` refuses any further submission.
   */
  async submitDraft(
    environmentId: string,
    tabId: string,
    value: unknown,
  ): Promise<{ draftId: string }> {
    const environment = await this.environment(environmentId);
    const source = await this.session(environmentId, tabId);
    if (!source) throw new Error("This tab is not an open interactive agent tab");
    const parsed = parseAutoPipelineResult(value);
    const ports = this.ports();
    try {
      const state = await this.fingerprint(ports, environment);
      const input = await buildPipelineStartWithSavedDefaults(
        {
          projectId: environment.projectId,
          taskId: randomUUID(),
          taskTitle: "Auto-pipeline",
          taskSnapshot: {
            title: "Auto-pipeline",
            description: "Draft",
            acceptanceCriteria: "",
            comments: [],
            images: [],
          },
          environmentType: environment.environmentType,
          existingEnvironmentId: environment.id,
        },
        this.context,
      );
      const defaults = connectionDefaultsFor(
        input.agentType,
        await this.context.storage.loadConfig(),
        await this.context.storage.getRepositoryConfig(environment.projectId),
      );
      const configured = input.steps?.build;
      input.steps = {
        ...input.steps,
        build: {
          agent: input.agentType,
          model: configured?.model ?? defaults.model,
          reasoningEffort: configured?.reasoningEffort ?? defaults.effort,
          fastMode: configured?.fastMode ?? defaults.fastMode,
        },
      };
      const draft: AutoPipelineDraft = {
        ...parsed,
        id: randomUUID(),
        uncommittedFiles: state.status.split("\n").filter(Boolean),
      };
      const key = `${environmentId}:${tabId}`;
      this.context.storage.putAutoPipelineDraft({
        environmentId,
        environment,
        source,
        input,
        draft,
        fingerprint: state.fingerprint,
        sourceMark: source.dispatchedRequestIds?.at(-1) ?? "",
        attempt: {
          tabId,
          sessionId: source.providerSessionId,
          agent: source.agent,
          startedAt: source.createdAt,
          completedAt: new Date().toISOString(),
          commit: state.head,
          model: source.controls?.modelId,
          reasoningEffort: source.controls?.reasoningId,
          // Read from the provider at confirmation, when the tab is idle.
          messages: [],
          notes: parsed.notes,
        },
      });
      // A draft now exists, so an earlier failure or timeout no longer describes the tab.
      this.outcomes().failures.delete(key);
      return { draftId: draft.id };
    } finally {
      ports.release();
    }
  }
  confirm(id: string, ticket: AutoPipelineTicket): Promise<unknown> {
    const record = this.context.storage.getAutoPipelineDraft(id);
    if (!record)
      return Promise.reject(
        new Error("Auto-pipeline draft expired. Draft again before confirming"),
      );
    const outcomes = this.outcomes();
    outcomes.promoting.set(id, (outcomes.promoting.get(id) ?? 0) + 1);
    outcomes.confirmErrors.delete(id);
    return this.context.storage
      .withAutoPipelinePromotion(record.environment.id, () =>
        this.confirmSerialized(record, ticket),
      )
      .catch((error: unknown) => {
        remember(outcomes.confirmErrors, id, errorText(error));
        throw error;
      })
      .finally(() => {
        const remaining = (outcomes.promoting.get(id) ?? 1) - 1;
        if (remaining > 0) outcomes.promoting.set(id, remaining);
        else outcomes.promoting.delete(id);
      });
  }
  private async confirmSerialized(
    record: AutoPipelineDraftRecord,
    ticket: AutoPipelineTicket,
  ): Promise<unknown> {
    const ports = this.ports();
    try {
      // Local bridge startup rejects moving checkouts, even for the owner.
      // Acquire before reserving; promote revalidates all state inside the fence.
      const admitted = (
        await this.context.storage.listBuildPipelines(record.environment.projectId)
      ).some((item) => item.environmentId === record.environmentId);
      const provider = admitted
        ? undefined
        : await ports.provider(record.environment, record.source.agent);
      return await withWorkspaceCodeRewindReservation({
        fence: this.context.runtime.environments.fence,
        storage: this.context.storage,
        environmentId: record.environmentId,
        assertQuiet: async () => {},
        run: () => this.promote(record.draft.id, ticket, ports, provider),
      });
    } finally {
      ports.release();
    }
  }

  private async assertCheckoutQuiet(environmentId: string): Promise<void> {
    await assertNoOtherWorkflowWriting(this.context.storage, environmentId, {});
    for (const review of await this.context.storage.listAllMultiReviewWorkflows()) {
      if (review.environmentId === environmentId && multiReviewWorkspaceUse(review.snapshot))
        throw new Error("A Multi Review is using this checkout. Finish it before promotion.");
    }
    if (
      this.context.runtime.tmux.sessions.activityState(environmentId) !== "idle" ||
      (await this.context.nativeAgents?.hasActiveCheckoutWork(environmentId))
    )
      throw new Error("An agent may still write to this checkout. Stop it before promotion.");
    const sessions = await this.context.storage.listNativeAgentSessions();
    if (
      sessions.some(
        (session) =>
          session.environmentId === environmentId &&
          (session.pendingDispatch || session.pendingSteer),
      )
    )
      throw new Error("An agent submission is unresolved; settle it before promotion.");
  }
  /**
   * Closes every terminal shell of the environment and waits for each process
   * tree to exit, the way moving an environment does. A shell that outlives the
   * close could still write while the work is committed, so promotion refuses.
   * The setup terminal counts: it ends in an interactive shell that stays open
   * after setup and has no tab the user could close it from.
   */
  private async closeTerminals(environment: Environment): Promise<void> {
    const terminals = this.context.runtime.terminals;
    const survivors = await terminals.terminateSessionsForEnvironment(environment.id);
    if (
      survivors.length > 0 ||
      terminals.hasLiveSessionsForEnvironment(environment.id) ||
      (environment.containerId && terminals.hasContainerTerminal(environment.containerId))
    )
      throw new Error(
        "A terminal in this environment did not close. Stop the command running in it and confirm again.",
      );
  }
  private async promote(
    id: string,
    value: AutoPipelineTicket,
    ports: AutoPipelinePorts,
    provider?: BuildPipelineProvider,
  ) {
    const record = this.context.storage.getAutoPipelineDraft(id);
    if (!record) throw new Error("Auto-pipeline draft expired. Draft again before confirming");
    const ticket = parseAutoPipelineTicket(value);
    if (record.reviewed && digest(record.reviewed) !== digest(ticket))
      throw new Error("This confirmation was already submitted with different content");

    if (!this.context.buildPipelines) throw new Error("Build pipeline supervisor is unavailable");
    const admitted = (
      await this.context.storage.listBuildPipelines(record.environment.projectId)
    ).find((item) => item.environmentId === record.environment.id);
    if (admitted) {
      const task = await this.context.storage.kanban.findKanbanTaskByRequestId(
        record.environment.projectId,
        `auto-pipeline:${id}`,
      );
      if (task && (admitted.snapshot as { taskId?: string }).taskId === task.id) {
        const snapshot = admitted.snapshot as { sourceLinkedAt?: string };
        if (!snapshot.sourceLinkedAt)
          throw new Error("Pipeline source linkage is pending; retry the failed pipeline stage");
        await this.context.storage.ensureBuildPipelineTab({
          pipelineId: admitted.id,
          taskId: task.id,
          environmentId: record.environment.id,
          isLocal: record.environment.environmentType === "local",
        });
        return admitted;
      }
      throw new Error("This environment already belongs to a pipeline");
    }
    await this.assertCheckoutQuiet(record.environmentId);
    const environment = await this.environment(record.environment.id);
    if (environment.status !== "running") throw new Error("The environment must be running");
    const source = (await this.sessions(environment.id)).find(
      ({ session }) =>
        session.logicalSessionKey === record.source.logicalSessionKey &&
        session.providerSessionId === record.source.providerSessionId,
    )?.session;
    if (!source || source.pendingDispatch || source.pendingSteer)
      throw new Error("The original idle tab is no longer available");
    if (!provider) throw new Error("Source provider is unavailable");
    if ((await provider.status(record.source.providerSessionId)) !== "idle")
      throw new Error("Wait for this tab's turn to finish");
    // An agent that submitted this draft recorded the tab's newest message; a
    // draft without one predates that and cannot be trusted to match the tab.
    if (record.sourceMark === undefined)
      throw new Error("Auto-pipeline draft expired. Draft again before confirming");
    const state = await this.fingerprint(ports, environment);
    if (sourceMarkOf(source) !== record.sourceMark)
      throw new Error(
        "The tab received a new message since drafting. Draft again before confirming",
      );
    if (state.fingerprint !== record.fingerprint) {
      const lastMessage = record.reviewed
        ? await ports.git(environment.id, ["log", "-1", "--format=%B"])
        : "";
      const parent = record.reviewed
        ? (await ports.git(environment.id, ["rev-parse", "HEAD^"])).trim()
        : "";
      if (
        state.status.trim() ||
        parent !== record.attempt.commit ||
        lastMessage
          .trimEnd()
          .split(/\n\s*\n/)
          .at(-1) !== `Orkestrator-Auto-Pipeline: ${id}`
      )
        throw new Error("Work changed since drafting. Draft again before confirming");
    }
    // Inside the fence no new terminal can start, so the shells closed here
    // stay closed; the fingerprint read below sees anything they wrote first.
    await this.closeTerminals(environment);
    record.reviewed = ticket;
    this.context.storage.putAutoPipelineDraft(record);
    if (
      (await this.fingerprint(ports, environment)).fingerprint !== state.fingerprint ||
      (await provider.status(source.providerSessionId)) !== "idle" ||
      sourceMarkOf(await this.session(environment.id, record.attempt.tabId)) !== record.sourceMark
    )
      throw new Error("Work changed during confirmation. Draft again before confirming");
    if ((await ports.git(environment.id, ["status", "--porcelain"])).trim()) {
      await ports.git(environment.id, ["add", "--all"]);
      await ports.git(environment.id, [
        "commit",
        "-m",
        `${ticket.title}\n\nOrkestrator-Auto-Pipeline: ${id}`,
      ]);
    }
    // The adopted Build keeps the conversation, cut to what adoption accepts, so
    // a long session cannot make confirming fail on its size.
    record.attempt.messages = boundAdoptedTranscript(
      await provider.messages(source.providerSessionId),
    );
    record.attempt.commit = (await ports.git(environment.id, ["rev-parse", "HEAD"])).trim();
    record.fingerprint = (await this.fingerprint(ports, environment)).fingerprint;
    this.context.storage.putAutoPipelineDraft(record);
    const task =
      (await this.context.storage.kanban.findKanbanTaskByRequestId(
        environment.projectId,
        `auto-pipeline:${id}`,
      )) ??
      (await this.context.storage.kanban.addKanbanTask(
        environment.projectId,
        ticket.title,
        ticket.description,
        {
          acceptanceCriteria: ticket.acceptanceCriteria.map((text) => `- [ ] ${text}`).join("\n"),
          status: "in-progress",
          requestId: `auto-pipeline:${id}`,
        },
      ));
    const pipeline = await this.context.buildPipelines
      .startFromCompletedBuild(
        {
          ...record.input,
          taskId: task.id,
          taskTitle: ticket.title,
          taskSnapshot: {
            title: ticket.title,
            description: ticket.description,
            acceptanceCriteria: task.acceptanceCriteria,
            comments: [],
            images: [],
          },
          source: { type: "kanban", taskId: task.id },
        },
        record.attempt,
      )
      .catch(async (error: unknown) => {
        const pipelines = await this.context.storage.listBuildPipelines(environment.projectId);
        if (!pipelines.some((entry) => (entry.snapshot as { taskId?: string }).taskId === task.id))
          await this.context.storage.kanban.deleteKanbanTask(task.id);
        throw error;
      });
    record.pipelineId = pipeline.id;
    this.context.storage.putAutoPipelineDraft(record);
    return this.context.storage.getBuildPipeline(pipeline.id);
  }
}
