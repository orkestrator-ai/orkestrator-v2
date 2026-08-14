import { randomUUID } from "node:crypto";
import {
  MULTI_REVIEW_WORKFLOW_VERSION,
  isMultiReviewTerminalPhase,
  isMultiReviewWorkflow,
  isStartMultiReviewInput,
  type MultiReviewModelSelection,
  type MultiReviewWorkflow,
  type StartMultiReviewInput,
} from "@orkestrator/protocol/multi-review";
import { UNATTENDED_AGENT_INTERACTION_POLICY } from "@orkestrator/protocol/agent-interactions";
import {
  STRUCTURED_REVIEW_REPORT_JSON_SCHEMA,
  parseStructuredReviewReport,
} from "@orkestrator/protocol/structured-review";
import type { JsonSchema, StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import type { Environment } from "./models.js";
import type { StorageService } from "./storage.js";
import {
  createBuildPipelineProvider,
  type BridgeConnection,
  type BuildPipelineProvider,
  type ProviderDependencies,
} from "./build-pipeline-provider.js";
import { addressPrompt } from "./build-pipeline-prompts.js";
import {
  REVIEW_FIX_RESULT_JSON_SCHEMA,
  parseFixResult,
} from "./looped-review-prompts.js";
import {
  createMultiReviewConsolidationPrompt,
  createMultiReviewerPrompt,
} from "./multi-review-prompts.js";

type CommandInvoker = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
const DEFAULT_POLL_MS = 1_000;
const CONTROLLER_LEASE_MS = 15_000;
const MAX_IDLE_RESULT_POLLS = 5;

function nowIso(): string {
  return new Date().toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface MultiReviewServiceOptions {
  autoAdvance?: boolean;
  pollIntervalMs?: number;
  provider?: (
    workflow: MultiReviewWorkflow,
    selection: MultiReviewModelSelection,
  ) => Promise<BuildPipelineProvider>;
  providerDependencies?: Pick<ProviderDependencies, "openCodeClient" | "monitorRetryMs">;
}

/** Durable backend owner for reviewer fan-out, consolidation, and fixes. */
export class MultiReviewService {
  private readonly ownerId = randomUUID();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly providers = new Map<string, BuildPipelineProvider>();
  private readonly providerUsers = new Map<string, Set<string>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(
    private readonly storage: StorageService,
    private readonly invoke: CommandInvoker,
    private readonly options: MultiReviewServiceOptions = {},
  ) {}

  async init(): Promise<void> {
    this.stopped = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.options.autoAdvance !== false) {
      this.timer = setInterval(() => void this.tick(), this.options.pollIntervalMs ?? DEFAULT_POLL_MS);
      this.timer.unref?.();
      void this.tick();
    }
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.allSettled([...this.locks.values()]);
    const records = await this.storage.listAllMultiReviewWorkflows().catch(() => []);
    await Promise.allSettled(records.flatMap((record) =>
      record.controllerLease?.ownerId === this.ownerId
        ? [this.storage.releaseMultiReviewController(
            record.id, this.ownerId, record.controllerLease.token,
          )]
        : []));
    await Promise.allSettled([...this.providers.values()].map((provider) => provider.dispose?.()));
    this.providers.clear();
    this.providerUsers.clear();
  }

  async start(input: StartMultiReviewInput): Promise<MultiReviewWorkflow> {
    if (!isStartMultiReviewInput(input)) throw new Error("Invalid multi review start request");
    const environment = await this.storage.getEnvironment(input.environmentId);
    if (!environment || environment.projectId !== input.projectId || environment.deletionRequestedAt) {
      throw new Error("The review environment is unavailable");
    }
    const existing = await this.storage.listMultiReviewWorkflows(input.environmentId);
    if (existing.some((record) => isMultiReviewWorkflow(record.snapshot)
      && !isMultiReviewTerminalPhase(record.snapshot.phase))) {
      throw new Error("Finish, cancel, or delete the existing Multi Review before starting another");
    }
    const timestamp = nowIso();
    const workflow: MultiReviewWorkflow = {
      version: MULTI_REVIEW_WORKFLOW_VERSION,
      controller: "backend",
      id: randomUUID(),
      environmentId: input.environmentId,
      projectId: input.projectId,
      targetBranch: input.targetBranch,
      ...(input.reviewInstruction ? { reviewInstruction: input.reviewInstruction } : {}),
      reviewers: input.reviewers.map((selection) => ({
        id: randomUUID(), ...selection, status: "pending" as const,
      })),
      fixModel: input.fixModel,
      phase: "reviewing",
      createdAt: timestamp,
      updatedAt: timestamp,
      backendRevision: 0,
    };
    const saved = await this.storage.saveMultiReviewWorkflow(
      workflow.id, workflow.environmentId, MULTI_REVIEW_WORKFLOW_VERSION, workflow, 0,
    );
    workflow.backendRevision = saved.revision;
    void this.advanceNow(workflow.id);
    return workflow;
  }

  async address(workflowId: string): Promise<MultiReviewWorkflow> {
    return this.withLock(workflowId, async () => {
      const controlled = await this.loadControlled(workflowId);
      if (!controlled) throw new Error(`Multi review workflow not found: ${workflowId}`);
      const { workflow, token } = controlled;
      if (workflow.phase !== "ready" || !workflow.consolidatedReport || !workflow.fixSession) {
        throw new Error("The consolidated review is not ready to address");
      }
      const requestId = randomUUID();
      workflow.phase = "fixing";
      workflow.fixSession.status = "running";
      workflow.fixSession.requestIds.push(requestId);
      workflow.activeRequest = {
        kind: "fix", requestId, state: "prepared", createdAt: nowIso(),
      };
      delete workflow.error;
      const saved = await this.save(workflow, token);
      void this.advanceNow(workflowId);
      return saved;
    });
  }

  async retry(workflowId: string): Promise<MultiReviewWorkflow> {
    return this.withLock(workflowId, async () => {
      const controlled = await this.loadControlled(workflowId);
      if (!controlled) throw new Error(`Multi review workflow not found: ${workflowId}`);
      const { workflow, token } = controlled;
      if (workflow.phase !== "failed") return workflow;
      const failedReviewer = workflow.reviewers.find((reviewer) => reviewer.status === "failed");
      if (failedReviewer) {
        failedReviewer.status = "pending";
        delete failedReviewer.error;
        delete failedReviewer.providerSessionId;
        delete failedReviewer.sessionKey;
        delete failedReviewer.requestId;
        delete failedReviewer.dispatchState;
        delete failedReviewer.idleResultPolls;
        workflow.phase = "reviewing";
      } else if (workflow.consolidatedReport && workflow.fixSession) {
        workflow.phase = "ready";
        workflow.fixSession.status = "idle";
        delete workflow.activeRequest;
      } else {
        workflow.phase = "consolidating";
        delete workflow.fixSession;
        delete workflow.activeRequest;
      }
      delete workflow.error;
      const saved = await this.save(workflow, token);
      void this.advanceNow(workflowId);
      return saved;
    });
  }

  async cancel(workflowId: string): Promise<MultiReviewWorkflow> {
    return this.withLock(workflowId, async () => {
      const controlled = await this.loadControlled(workflowId);
      if (!controlled) throw new Error(`Multi review workflow not found: ${workflowId}`);
      const { workflow, token } = controlled;
      if (isMultiReviewTerminalPhase(workflow.phase)) return workflow;
      workflow.phase = "cancelling";
      const sessions = [
        ...workflow.reviewers.flatMap((reviewer) => reviewer.providerSessionId
          ? [{ id: reviewer.providerSessionId, selection: reviewer }] : []),
        ...(workflow.fixSession
          ? [{ id: workflow.fixSession.providerSessionId, selection: workflow.fixModel }]
          : []),
      ];
      await Promise.allSettled(sessions.map(async ({ id, selection }) => {
        const provider = await this.provider(workflow, selection);
        await provider.abort(id);
      }));
      for (const reviewer of workflow.reviewers) {
        if (reviewer.status === "pending" || reviewer.status === "running") reviewer.status = "cancelled";
      }
      if (workflow.fixSession?.status === "running") workflow.fixSession.status = "cancelled";
      workflow.phase = "cancelled";
      delete workflow.activeRequest;
      const saved = await this.save(workflow, token);
      await this.release(workflow, token);
      return saved;
    });
  }

  advanceNow(workflowId: string): Promise<void> {
    return this.withLock(workflowId, async () => {
      try {
        await this.advance(workflowId);
      } catch (error) {
        await this.fail(workflowId, error);
      }
    }).then(() => undefined);
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    const records = await this.storage.listAllMultiReviewWorkflows();
    await Promise.all(records.flatMap((record) => {
      if (!isMultiReviewWorkflow(record.snapshot)) return [];
      const phase = record.snapshot.phase;
      return phase === "reviewing" || phase === "consolidating" || phase === "fixing"
        ? [this.advanceNow(record.id)] : [];
    }));
  }

  private withLock<T>(workflowId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(workflowId) ?? Promise.resolve();
    let resolveResult!: (value: T | PromiseLike<T>) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const run = previous.then(operation, operation);
    run.then(resolveResult, rejectResult);
    const settled = run.then(() => undefined, () => undefined);
    this.locks.set(workflowId, settled);
    void settled.finally(() => {
      if (this.locks.get(workflowId) === settled) this.locks.delete(workflowId);
    });
    return result;
  }

  private async loadControlled(
    workflowId: string,
  ): Promise<{ workflow: MultiReviewWorkflow; token: string } | null> {
    const claimed = await this.storage.claimMultiReviewController(
      workflowId, this.ownerId, CONTROLLER_LEASE_MS,
    );
    if (!claimed.granted) return null;
    const record = await this.storage.getMultiReviewWorkflow(workflowId);
    if (!record || !isMultiReviewWorkflow(record.snapshot)) return null;
    return {
      workflow: { ...record.snapshot, controllerFence: claimed.token, backendRevision: record.revision },
      token: claimed.token,
    };
  }

  private async save(workflow: MultiReviewWorkflow, token: string): Promise<MultiReviewWorkflow> {
    workflow.updatedAt = nowIso();
    workflow.controllerFence = token;
    const saved = await this.storage.saveMultiReviewWorkflow(
      workflow.id, workflow.environmentId, MULTI_REVIEW_WORKFLOW_VERSION,
      workflow, workflow.backendRevision, { ownerId: this.ownerId, token },
    );
    workflow.backendRevision = saved.revision;
    return workflow;
  }

  private async advance(workflowId: string): Promise<void> {
    const controlled = await this.loadControlled(workflowId);
    if (!controlled) return;
    const { workflow, token } = controlled;
    if (workflow.phase === "reviewing") {
      await this.advanceReviewers(workflow, token);
    } else if (workflow.phase === "consolidating" || workflow.phase === "fixing") {
      await this.advanceFixModel(workflow, token);
    }
  }

  private async advanceReviewers(workflow: MultiReviewWorkflow, token: string): Promise<void> {
    for (let index = 0; index < workflow.reviewers.length; index++) {
      const reviewer = workflow.reviewers[index]!;
      if (reviewer.status === "completed" || reviewer.status === "failed"
        || reviewer.status === "cancelled") continue;
      const provider = await this.provider(workflow, reviewer);
      if (reviewer.status === "pending") {
        const sessionKey = `multi-review:${workflow.id}:reviewer:${reviewer.id}`;
        const providerSessionId = await provider.createSession("review", `Multi Review · Reviewer ${index + 1}`, {
          clientSessionKey: sessionKey,
          mode: "build",
          model: reviewer.model === "default" ? undefined : reviewer.model,
          effort: reviewer.reasoningEffort,
          interaction: {
            origin: "looped-review",
            interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
            phase: "review",
            workflowId: workflow.id,
            provider: reviewer.agent,
            fence: sessionKey,
          },
        });
        reviewer.sessionKey = sessionKey;
        reviewer.providerSessionId = providerSessionId;
        reviewer.requestId = randomUUID();
        reviewer.dispatchState = "prepared";
        reviewer.status = "running";
        reviewer.startedAt = nowIso();
        await this.save(workflow, token);
      }
      if (!reviewer.providerSessionId || !reviewer.requestId) continue;
      provider.registerSession?.(reviewer.providerSessionId, {
        origin: "looped-review",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
        phase: "review",
        workflowId: workflow.id,
        provider: reviewer.agent,
        fence: reviewer.sessionKey,
      });
      if (reviewer.dispatchState === "prepared") {
        reviewer.dispatchState = "dispatching";
        await this.save(workflow, token);
        await provider.send(
          reviewer.providerSessionId,
          createMultiReviewerPrompt({
            targetBranch: workflow.targetBranch,
            reviewInstruction: workflow.reviewInstruction,
            reviewerNumber: index + 1,
            reviewerCount: workflow.reviewers.length,
          }),
          {
            requestId: reviewer.requestId,
            schema: STRUCTURED_REVIEW_REPORT_JSON_SCHEMA as JsonSchema,
            mode: "build",
            model: reviewer.model === "default" ? undefined : reviewer.model,
            effort: reviewer.reasoningEffort,
          },
        );
        reviewer.dispatchState = "sent";
        await this.save(workflow, token);
      }
      if (reviewer.dispatchState === "dispatching") {
        // Dispatch acceptance is ambiguous after a crash. The stable request id
        // makes provider reconciliation authoritative; never send it twice.
        reviewer.dispatchState = "sent";
        await this.save(workflow, token);
      }
      if (reviewer.status !== "running") continue;
      await this.resolveUnattendedInteractions(provider, reviewer.providerSessionId);
      const status = await provider.status(reviewer.providerSessionId);
      if (status === "running" || status === "blocked") continue;
      if (status === "error" || status === "missing") {
        reviewer.status = "failed";
        reviewer.error = status === "missing"
          ? "The reviewer session no longer exists"
          : "The reviewer session failed";
        workflow.phase = "failed";
        workflow.error = reviewer.error;
        await this.save(workflow, token);
        return;
      }
      const result = await provider.structured<unknown>(reviewer.providerSessionId, reviewer.requestId);
      if (!result) {
        reviewer.idleResultPolls = (reviewer.idleResultPolls ?? 0) + 1;
        if (reviewer.idleResultPolls >= MAX_IDLE_RESULT_POLLS) {
          reviewer.status = "failed";
          reviewer.error = "The reviewer became idle without returning its structured report";
          workflow.phase = "failed";
          workflow.error = reviewer.error;
        }
        await this.save(workflow, token);
        if (reviewer.status === "failed") return;
        continue;
      }
      reviewer.report = this.parseReportResult(result);
      reviewer.status = "completed";
      reviewer.completedAt = nowIso();
      delete reviewer.idleResultPolls;
      await this.save(workflow, token);
    }
    if (workflow.reviewers.every((reviewer) => reviewer.status === "completed")) {
      workflow.phase = "consolidating";
      await this.save(workflow, token);
    }
  }

  private async advanceFixModel(workflow: MultiReviewWorkflow, token: string): Promise<void> {
    const provider = await this.provider(workflow, workflow.fixModel);
    if (!workflow.fixSession) {
      const sessionKey = `multi-review:${workflow.id}:fix`;
      const providerSessionId = await provider.createSession("review", "Multi Review · Consolidation", {
        clientSessionKey: sessionKey,
        mode: "plan",
        model: workflow.fixModel.model === "default" ? undefined : workflow.fixModel.model,
        effort: workflow.fixModel.reasoningEffort,
        interaction: {
          origin: "looped-review",
          interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
          phase: "review",
          workflowId: workflow.id,
          provider: workflow.fixModel.agent,
          fence: sessionKey,
        },
      });
      workflow.fixSession = {
        ...workflow.fixModel,
        sessionKey,
        providerSessionId,
        requestIds: [],
        status: "running",
        startedAt: nowIso(),
      };
      await this.save(workflow, token);
    }
    const session = workflow.fixSession;
    provider.registerSession?.(session.providerSessionId, {
      origin: "looped-review",
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      phase: workflow.phase === "fixing" ? "fix" : "review",
      workflowId: workflow.id,
      provider: workflow.fixModel.agent,
      fence: session.sessionKey,
    });
    if (!workflow.activeRequest) {
      const requestId = randomUUID();
      workflow.activeRequest = {
        kind: "consolidate", requestId, state: "prepared", createdAt: nowIso(),
      };
      session.requestIds.push(requestId);
      await this.save(workflow, token);
    }
    const request = workflow.activeRequest;
    if (request.state === "prepared") {
      request.state = "dispatching";
      await this.save(workflow, token);
      const prompt = request.kind === "consolidate"
        ? createMultiReviewConsolidationPrompt({
            targetBranch: workflow.targetBranch,
            reports: workflow.reviewers.map((reviewer) => ({
              reviewerId: reviewer.id,
              agent: reviewer.agent,
              model: reviewer.model,
              report: reviewer.report!,
            })),
          })
        : addressPrompt(workflow.consolidatedReport!);
      await provider.send(session.providerSessionId, prompt, {
        requestId: request.requestId,
        schema: request.kind === "consolidate"
          ? STRUCTURED_REVIEW_REPORT_JSON_SCHEMA as JsonSchema
          : REVIEW_FIX_RESULT_JSON_SCHEMA,
        mode: request.kind === "consolidate" ? "plan" : "build",
        model: workflow.fixModel.model === "default" ? undefined : workflow.fixModel.model,
        effort: workflow.fixModel.reasoningEffort,
      });
      request.state = "sent";
      await this.save(workflow, token);
    }
    if (request.state === "dispatching") {
      request.state = "sent";
      await this.save(workflow, token);
    }
    await this.resolveUnattendedInteractions(provider, session.providerSessionId);
    const status = await provider.status(session.providerSessionId);
    if (status === "running" || status === "blocked") return;
    if (status === "error" || status === "missing") {
      throw new Error(status === "missing"
        ? "The consolidation session no longer exists"
        : "The consolidation session failed");
    }
    const result = await provider.structured<unknown>(session.providerSessionId, request.requestId);
    if (!result) {
      request.idleResultPolls = (request.idleResultPolls ?? 0) + 1;
      await this.save(workflow, token);
      if (request.idleResultPolls >= MAX_IDLE_RESULT_POLLS) {
        throw new Error(`The fix model became idle without returning its ${request.kind === "fix" ? "fix result" : "consolidated report"}`);
      }
      return;
    }
    if (request.kind === "consolidate") {
      workflow.consolidatedReport = this.parseReportResult(result);
      workflow.phase = "ready";
      session.status = "idle";
      session.completedAt = nowIso();
      delete workflow.activeRequest;
      await this.save(workflow, token);
      await this.release(workflow, token);
      return;
    }
    if (!result.ok) throw new Error(result.error.message);
    const fixed = parseFixResult(result.value);
    workflow.fixResult = fixed;
    session.completedAt = nowIso();
    delete workflow.activeRequest;
    if (!fixed.complete) {
      session.status = "failed";
      workflow.phase = "failed";
      workflow.error = `The fix model could not address every finding: ${fixed.summary}`;
    } else {
      session.status = "idle";
      workflow.phase = "completed";
    }
    await this.save(workflow, token);
    await this.release(workflow, token);
  }

  private parseReportResult(result: StructuredOutputResult<unknown>) {
    if (!result.ok) throw new Error(result.error.message);
    return parseStructuredReviewReport(result.value);
  }

  private async resolveUnattendedInteractions(
    provider: BuildPipelineProvider,
    providerSessionId: string,
  ): Promise<void> {
    if (!provider.interactions) return;
    const snapshot = await provider.interactions.listPendingInteractions(providerSessionId);
    for (const request of snapshot.requests) {
      const action = request.kind === "question" || request.kind === "mcp-form"
        || request.kind === "elicitation" || request.kind === "terminal-selection"
        ? "decline" as const
        : "deny" as const;
      await provider.interactions.resolveInteraction(providerSessionId, request.id, {
        version: 1,
        interactionId: request.id,
        sessionId: providerSessionId,
        action,
        resolvedAt: Date.now(),
      });
    }
  }

  private async fail(workflowId: string, error: unknown): Promise<void> {
    const controlled = await this.loadControlled(workflowId).catch(() => null);
    if (!controlled) return;
    const { workflow, token } = controlled;
    if (isMultiReviewTerminalPhase(workflow.phase)) return;
    const failedDuringReview = workflow.phase === "reviewing";
    workflow.phase = "failed";
    workflow.error = errorMessage(error).slice(0, 4_096);
    if (failedDuringReview) {
      const reviewer = workflow.reviewers.find((entry) => entry.status === "running")
        ?? workflow.reviewers.find((entry) => entry.status === "pending");
      if (reviewer) {
        reviewer.status = "failed";
        reviewer.error = workflow.error;
      }
    }
    if (workflow.fixSession?.status === "running") {
      workflow.fixSession.status = "failed";
      workflow.fixSession.error = workflow.error;
    }
    await this.save(workflow, token).catch(() => undefined);
    await this.release(workflow, token);
  }

  private async release(workflow: MultiReviewWorkflow, token: string): Promise<void> {
    await this.storage.releaseMultiReviewController(workflow.id, this.ownerId, token)
      .catch(() => undefined);
    const keys = new Set([
      ...workflow.reviewers.map((reviewer) => this.providerKey(workflow, reviewer)),
      this.providerKey(workflow, workflow.fixModel),
    ]);
    await Promise.allSettled([...keys].map(async (key) => {
      const users = this.providerUsers.get(key);
      users?.delete(workflow.id);
      if (users && users.size > 0) return;
      this.providerUsers.delete(key);
      const provider = this.providers.get(key);
      this.providers.delete(key);
      await provider?.dispose?.();
    }));
  }

  private providerKey(
    workflow: MultiReviewWorkflow,
    selection: MultiReviewModelSelection,
  ): string {
    return `${workflow.environmentId}:${selection.agent}`;
  }

  private async provider(
    workflow: MultiReviewWorkflow,
    selection: MultiReviewModelSelection,
  ): Promise<BuildPipelineProvider> {
    const key = this.providerKey(workflow, selection);
    const users = this.providerUsers.get(key) ?? new Set<string>();
    users.add(workflow.id);
    this.providerUsers.set(key, users);
    const cached = this.providers.get(key);
    if (cached) return cached;
    if (this.options.provider) {
      const provider = await this.options.provider(workflow, selection);
      this.providers.set(key, provider);
      return provider;
    }
    const environment = await this.storage.getEnvironment(workflow.environmentId);
    if (!environment) throw new Error("Review environment no longer exists");
    const connection = await this.bridgeConnection(selection.agent, environment);
    const provider = createBuildPipelineProvider(connection, {
      ...this.options.providerDependencies,
      autoAnswerRequests: false,
    });
    this.providers.set(key, provider);
    return provider;
  }

  private async bridgeConnection(
    agent: MultiReviewModelSelection["agent"],
    environment: Environment,
  ): Promise<BridgeConnection> {
    const suffix = agent === "opencode" ? "opencode" : agent;
    if (environment.environmentType === "local") {
      const result = await this.invoke<{ port: number; authToken?: string }>(
        `start_local_${suffix}_server_cmd`, { environmentId: environment.id },
      );
      if (!result.authToken) throw new Error(`${agent} bridge authentication is unavailable`);
      return {
        agent, baseUrl: `http://127.0.0.1:${result.port}`,
        authToken: result.authToken, directory: environment.worktreePath,
      };
    }
    if (!environment.containerId) throw new Error("Review container is unavailable");
    const result = await this.invoke<{ hostPort: number; authToken?: string }>(
      `start_${suffix}_server`, { containerId: environment.containerId },
    );
    if (!result.authToken) throw new Error(`${agent} bridge authentication is unavailable`);
    return {
      agent, baseUrl: `http://127.0.0.1:${result.hostPort}`,
      authToken: result.authToken,
    };
  }
}
