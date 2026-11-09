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

/** Drafts and promotion receipts survive restarts; clients cannot replace generated notes. */
export class AutoPipelineService {
  constructor(
    private readonly context: CommandContext,
    private readonly ports: () => AutoPipelinePorts,
    private readonly draftTimeoutMs = 120_000,
  ) {}

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
    if (active.size >= 32)
      return Promise.reject(new Error("Too many drafting sessions are running"));
    const controller = new AbortController();
    const operation = this.createDraft(environmentId, tabId, controller.signal);
    active.set(key, { operation, controller });
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
    return this.context.storage.withAutoPipelinePromotion(record.environment.id, async () => {
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
          run: () => this.promote(id, ticket, ports, provider),
        });
      } finally {
        ports.release();
      }
    });
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
    const environment = await this.context.storage.getEnvironment(environmentId);
    if (
      this.context.runtime.terminals.hasLiveSessionsForEnvironment(environmentId) ||
      (environment?.containerId &&
        this.context.runtime.terminals.hasContainerTerminal(environment.containerId))
    )
      throw new Error(
        "Close this environment's terminals before promotion; a shell may still write.",
      );
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
