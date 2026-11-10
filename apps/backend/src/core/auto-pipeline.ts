import { connectionDefaultsFor } from "./build-pipeline-service-helpers.js";
import { UNATTENDED_AGENT_INTERACTION_POLICY } from "@orkestrator/protocol/agent-interactions";
import {
  workflowResultInstruction,
  workflowResultToolName,
} from "@orkestrator/protocol/workflow-results";
/** Manual-only promotion. Drafting never dispatches to the source session. */
import { randomUUID, createHash } from "node:crypto";
import {
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
import { resolveEnvironmentExecutionPolicy } from "./native-agent-execution-policy.js";
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
}
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
async function beforeDeadline<T>(operation: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Auto-pipeline drafting timed out")),
          Math.max(0, deadline - Date.now()),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function bounded(value: unknown, max: number): void {
  if (Buffer.byteLength(JSON.stringify(value)) > max)
    throw new Error("Auto-pipeline input exceeds its size limit");
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
    private readonly draftTimeoutMs = 120_000,
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
  ): Promise<{ tabId: string; session: PersistedNativeAgentSession }[]> {
    const layout = await this.context.storage.getPaneLayout(id);
    const leaves = paneLayoutLeaves(layout?.root);
    const activeTab = leaves.find((leaf) => leaf.id === layout?.activePaneId)?.activeTabId;
    const tabIdByKey = new Map<string, string>();
    for (const tab of leaves.flatMap((leaf) => leaf.tabs)) {
      if (typeof tab.id === "string")
        tabIdByKey.set(nativeTabLogicalSessionKey(id, tab.id), tab.id);
    }
    const sessions = await this.context.storage.listNativeAgentSessions();
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
    bounded({ status, diff, untracked, hashes }, 2 * 1024 * 1024);
    return {
      head,
      status,
      diff,
      fingerprint: digest({ head, branch, status, diff, untracked, hashes }),
    };
  }
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
      // Refused before any session exists; record it so the tab can say why.
      const error = new Error("Too many drafting sessions are running. Retry when one finishes");
      remember(outcomes.failures, key, error.message);
      return Promise.reject(error);
    }
    const controller = new AbortController();
    outcomes.failures.delete(key);
    const operation = this.createDraft(environmentId, tabId, controller.signal);
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
  private async createDraft(
    environmentId: string,
    tabId: string,
    signal: AbortSignal,
  ): Promise<AutoPipelineDraft> {
    const environment = await this.environment(environmentId);
    const source = await this.session(environmentId, tabId);
    if (!source) throw new Error("Choose an open interactive agent tab");
    const ports = this.ports();
    let drafting: { provider: BuildPipelineProvider; id: string } | undefined;
    let resultKey: string | undefined;
    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    // Cancellation may arrive during preparation, before the send race is installed.
    void cancelled.catch(() => undefined);
    try {
      signal.throwIfAborted();
      const original = await ports.provider(environment, source.agent);
      if (
        source.pendingDispatch ||
        source.pendingSteer ||
        (await original.status(source.providerSessionId)) !== "idle"
      )
        throw new Error("Wait for this tab's turn to finish");
      const messages = await original.messages(source.providerSessionId);
      bounded(messages, 2 * 1024 * 1024);
      const state = await this.fingerprint(ports, environment);
      const existing = this.context.storage.latestAutoPipelineDraft(environmentId, tabId);
      if (
        existing?.fingerprint === state.fingerprint &&
        digest(existing.attempt.messages) === digest(messages)
      )
        return existing.draft;
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
      const selection = {
        agent: input.agentType,
        model: configured?.model ?? defaults.model,
        reasoningEffort: configured?.reasoningEffort ?? defaults.effort,
        fastMode: configured?.fastMode ?? defaults.fastMode,
      };
      input.steps = { ...input.steps, build: selection };
      const provider = await ports.provider(environment, input.agentType);
      const policy = resolveEnvironmentExecutionPolicy(environment, "coordinator");
      const id = await provider.createSession("build", "Auto-pipeline draft", {
        readOnly: true,
        interaction: {
          origin: "automated-review",
          interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
        },
        mode: "plan",
        model: selection?.model,
        effort: selection.reasoningEffort,
        fastMode: selection.fastMode,
        policy,
      });
      drafting = { provider, id };
      signal.throwIfAborted();
      const requestId = randomUUID();
      const results = this.context.workflowResults;
      if (!results || !this.context.agentTools?.workflowResultConnection)
        throw new Error("Structured Auto-pipeline result tools are unavailable");
      resultKey = requestId;
      await results.prepare({
        resultKey: requestId,
        kind: "auto-pipeline-draft",
        environmentId,
        projectId: environment.projectId,
        provider: input.agentType,
      });
      const agentMcp = this.context.agentTools.workflowResultConnection(
        environmentId,
        environment.projectId,
        environment.environmentType === "local" ? "host" : "container",
        requestId,
        input.agentType,
      );
      const instruction = workflowResultInstruction("auto-pipeline-draft", requestId, {
        capability: agentMcp.workflowResultCapability,
      });
      const deadline = Date.now() + this.draftTimeoutMs;
      signal.throwIfAborted();
      await beforeDeadline(
        Promise.race([
          cancelled,
          provider.send(
            id,
            `Draft a ticket and finished Build handoff from this completed interactive work. Do not edit files, commit, or send messages. Return the schema-constrained result. Description must contain Summary, Problem and Context. Each acceptance criterion must be independently checkable. Notes must record only observed decisions, files touched, checks and results, and unfinished work.\nTranscript:\n${JSON.stringify(messages)}\nBranch diff:\n${state.diff}\nPending paths:\n${state.status}\n${instruction}`,
            {
              requestId,
              agentMcp,
              workflowResultTool: workflowResultToolName("auto-pipeline-draft"),
              workflowResultKey: requestId,
              readOnly: true,
              mode: "plan",
              model: selection?.model,
              effort: selection.reasoningEffort,
              fastMode: selection.fastMode,
            },
          ),
        ]),
        deadline,
      );
      let result;
      while (Date.now() < deadline) {
        const status = await beforeDeadline(
          Promise.race([cancelled, provider.status(id)]),
          deadline,
        );
        if (status === "error") throw new Error("Auto-pipeline drafting session failed");
        result = await beforeDeadline(
          Promise.race([cancelled, results.structured(requestId)]),
          deadline,
        );
        if (result) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!result?.ok)
        throw new Error("Auto-pipeline drafting did not return a valid structured result");
      signal.throwIfAborted();
      const parsed = parseAutoPipelineResult(result.value);
      if ((await this.fingerprint(ports, environment)).fingerprint !== state.fingerprint)
        throw new Error("Work changed during drafting. Retry to review the current work");
      signal.throwIfAborted();
      const draft: AutoPipelineDraft = {
        ...parsed,
        id: randomUUID(),
        uncommittedFiles: state.status.split("\n").filter(Boolean),
      };
      const now = new Date().toISOString();
      this.context.storage.putAutoPipelineDraft({
        environmentId,
        environment,
        source,
        input,
        draft,
        fingerprint: state.fingerprint,
        attempt: {
          tabId,
          sessionId: source.providerSessionId,
          agent: source.agent,
          startedAt: source.createdAt,
          completedAt: now,
          commit: state.head,
          model: source.controls?.modelId,
          reasoningEffort: source.controls?.reasoningId,
          messages,
          notes: parsed.notes,
        },
      });
      await results.consume(requestId);
      return draft;
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
      if (drafting) {
        await drafting.provider.abort(drafting.id).catch(() => undefined);
        await drafting.provider.closeSession?.(drafting.id).catch(() => undefined);
      }
      if (resultKey)
        await this.context.workflowResults?.close(resultKey, "cancelled").catch(() => undefined);
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
    const state = await this.fingerprint(ports, environment);
    if (
      digest(await provider.messages(record.source.providerSessionId)) !==
      digest(record.attempt.messages)
    )
      throw new Error("The source transcript changed. Draft again before confirming");
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
      digest(await provider.messages(source.providerSessionId)) !== digest(record.attempt.messages)
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
