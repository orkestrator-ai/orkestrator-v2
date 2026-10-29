/**
 * "Describe a graph" (plan P2.15, report §7.1 point 2; D1, D6): the backend
 * owns the job from start to result.
 *
 * `start` stores a job for the designer's environment and returns; the job
 * then advances on its own timer, one pass at a time per environment, on the
 * shared agent branch runner (`graph-describe-host.ts`): a read-only,
 * unattended session with the user's chosen model, whose result slot is a
 * `graph-template` checked by the template guard and the compiler. A client
 * that switches tabs, reloads or reconnects reads the job back with `status`
 * (and hears `graph-describe` change hints); nothing depends on a mounted
 * component (root `AGENTS.md`, invariants 1-3).
 *
 * A completed job holds the draft. The web opens it in the designer as an
 * unsaved draft; nothing here saves or launches it, and a run can only be
 * launched from a saved template (`GraphTemplateService.compileForLaunch`).
 * These commands are registered for the app only: no public action and no
 * Control MCP tool reaches them, so a coordinator cannot author templates
 * (D6).
 */
import { randomUUID } from "node:crypto";
import {
  AGENT_PLATFORMS,
  normalizeAgentPlatforms,
  type AgentPlatform,
} from "@orkestrator/protocol/agent-platforms";
import type { GraphCapabilityCeiling } from "@orkestrator/protocol/graphs/capability-profiles";
import {
  GRAPH_DESCRIBE_BOUNDS,
  GRAPH_TEMPLATE_RESULT_KIND,
  type GraphDescribeJobView,
  type GraphDescribeProgress,
  type GraphDescribeStartInput,
} from "@orkestrator/protocol/graphs/describe";
import type { GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import type { WorkflowResultKind } from "@orkestrator/protocol/workflow-results";
import { isAgentBranchFenceError } from "./agent-branch-commits.js";
import { AgentBranchRunner } from "./agent-branch-runner.js";
import { agentBranchSettled, type AgentBranchPollGate } from "./agent-branch-types.js";
import type { GraphAgentProviders } from "./graph-agent-providers.js";
import {
  GraphDescribeBranchHost,
  GraphDescribeFenceError,
  type GraphDescribeHostDependencies,
} from "./graph-describe-host.js";
import type { AppConfig, Environment } from "./models.js";
import { MultiReviewProgressTracker } from "./multi-review-progress.js";
import {
  GRAPH_DESCRIBE_JOB_VERSION,
  GraphDescribeStorageError,
  type GraphDescribeStorage,
  type PersistedGraphDescribeJob,
} from "./storage-graph-describe.js";
import { ElapsedPollGate } from "./workflow-poll-gate.js";

/** Default spacing between passes of a running job. */
export const GRAPH_DESCRIBE_POLL_MS = 3_000;
/** Consecutive failed passes (not the agent's failures) before a job is failed. */
const MAX_PASS_FAILURES = 20;
/** Result slots whose consumption failed, retried on later passes (bounded). */
const MAX_PENDING_CONSUMPTIONS = 64;

export type GraphDescribeErrorCode = "invalid-request" | "not-found" | "unavailable" | "conflict";

/** A refused describe command; the gateway forwards the message. */
export class GraphDescribeError extends Error {
  constructor(
    readonly code: GraphDescribeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GraphDescribeError";
  }
}

export interface GraphDescribeServiceOptions {
  storage: {
    getEnvironment(environmentId: string): Promise<Environment | null>;
    loadConfig(): Promise<AppConfig>;
    graphDescribe: GraphDescribeStorage;
  };
  providers: GraphAgentProviders;
  workflowResults?: GraphDescribeHostDependencies["workflowResults"];
  agentTools?: GraphDescribeHostDependencies["agentTools"];
  assertAgentToolsReachable?(environmentId: string, stage: string): Promise<void>;
  /** The result-tool rollout: a job starts only when it admits `graph-template` for the agent. */
  rollout?: {
    refresh(): Promise<void>;
    allows(provider: AgentPlatform, kind: WorkflowResultKind): boolean;
  };
  /** The project's capability ceiling (D18), compiled against. */
  ceiling?(projectId: string): Promise<GraphCapabilityCeiling | undefined>;
  /** Spacing between passes; default {@link GRAPH_DESCRIBE_POLL_MS}. */
  pollIntervalMs?: number;
  /** Tests drive passes by hand with {@link GraphDescribeService.advanceNow}. */
  autoAdvance?: boolean;
  stallWarningMs?: number;
  stallAbandonMs?: number;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalid(text: string): never {
  throw new GraphDescribeError("invalid-request", text);
}

function nowIso(): string {
  return new Date().toISOString();
}

function progressOf(job: PersistedGraphDescribeJob): GraphDescribeProgress | undefined {
  if (job.status !== "running") return undefined;
  const branch = job.branch;
  if (branch.status === "pending" || !branch.providerSessionId) return "starting";
  if (branch.resultSubmission === "received" || agentBranchSettled(branch)) return "finishing";
  if (branch.resultSubmission === "correcting" || branch.resultSubmission === "needs-attention")
    return "correcting";
  if (branch.schemaRepairPrompt !== undefined) return "correcting";
  return "drafting";
}

/** The web's view of a stored job. */
export function graphDescribeJobView(job: PersistedGraphDescribeJob): GraphDescribeJobView {
  const progress = progressOf(job);
  return {
    id: job.id,
    environmentId: job.environmentId,
    projectId: job.projectId,
    status: job.status,
    ...(progress ? { progress } : {}),
    repairs: job.branch.schemaRepairAttempts ?? 0,
    agent: job.branch.agent,
    ...(job.branch.model && !job.branch.modelUnpinned ? { model: job.branch.model } : {}),
    description: job.description,
    modifying: job.baseDraft !== undefined,
    ...(job.status === "completed" && job.template ? { template: job.template } : {}),
    ...(job.error ? { error: job.error } : {}),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.completedAt ? { completedAt: job.completedAt } : {}),
  };
}

function optionalString(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    invalid(`${name} must be a string of 1 to ${max} characters`);
  }
  return value;
}

/** Checks a start request's shape; the environment and the rollout are checked by `start`. */
export function parseGraphDescribeStartInput(
  args: Record<string, unknown>,
): GraphDescribeStartInput {
  const allowed = [
    "environmentId",
    "description",
    "agent",
    "model",
    "reasoningEffort",
    "fastMode",
    "baseDraft",
  ];
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) invalid(`Unknown arguments: ${unknown.slice(0, 5).join(", ")}`);
  const environmentId = optionalString(args.environmentId, "environmentId", 200);
  if (!environmentId) invalid("environmentId is required");
  if (typeof args.description !== "string" || !args.description.trim()) {
    invalid("Describe the graph you want");
  }
  const description = args.description.trim();
  if (description.length > GRAPH_DESCRIBE_BOUNDS.maxDescriptionChars) {
    invalid(
      `The description is limited to ${GRAPH_DESCRIBE_BOUNDS.maxDescriptionChars} characters`,
    );
  }
  if (!(AGENT_PLATFORMS as readonly unknown[]).includes(args.agent)) {
    invalid(`agent must be one of ${AGENT_PLATFORMS.join(", ")}`);
  }
  const model = optionalString(args.model, "model", 200);
  const reasoningEffort = optionalString(args.reasoningEffort, "reasoningEffort", 64);
  if (args.fastMode !== undefined && typeof args.fastMode !== "boolean") {
    invalid("fastMode must be a boolean");
  }
  let baseDraft: GraphTemplateV1 | undefined;
  if (args.baseDraft !== undefined && args.baseDraft !== null) {
    if (typeof args.baseDraft !== "object" || Array.isArray(args.baseDraft)) {
      invalid("baseDraft must be a template object");
    }
    // A draft being edited may be incomplete: the agent's job includes
    // finishing it, so only its size is bounded here.
    const bytes = Buffer.byteLength(JSON.stringify(args.baseDraft), "utf8");
    if (bytes > GRAPH_DESCRIBE_BOUNDS.maxBaseDraftBytes) {
      invalid(
        `The draft to modify is larger than ${GRAPH_DESCRIBE_BOUNDS.maxBaseDraftBytes} bytes`,
      );
    }
    baseDraft = args.baseDraft as GraphTemplateV1;
  }
  return {
    environmentId,
    description,
    agent: args.agent as AgentPlatform,
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(typeof args.fastMode === "boolean" ? { fastMode: args.fastMode } : {}),
    ...(baseDraft ? { baseDraft } : {}),
  };
}

export class GraphDescribeService {
  private readonly locks = new Map<string, Promise<void>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly passFailures = new Map<string, number>();
  private readonly cancelling = new Set<string>();
  private readonly pendingConsumptions = new Set<string>();
  private readonly progress = new MultiReviewProgressTracker();
  private readonly pollGate: AgentBranchPollGate;
  private stopped = false;

  constructor(private readonly options: GraphDescribeServiceOptions) {
    const gate = new ElapsedPollGate(this.pollIntervalMs);
    this.pollGate = {
      count: (scope) => gate.count(scope, "explicit"),
      exhausted: (scope, count, limit) => gate.exhausted(scope, count, limit),
      clear: (scope) => gate.clear(scope),
    };
  }

  private get pollIntervalMs(): number {
    return this.options.pollIntervalMs ?? GRAPH_DESCRIBE_POLL_MS;
  }

  private get jobs(): GraphDescribeStorage {
    return this.options.storage.graphDescribe;
  }

  /** Resumes every running job (a backend restart in the middle of a describe). */
  async init(): Promise<void> {
    this.stopped = false;
    for (const job of await this.jobs.listGraphDescribeJobs()) {
      if (job.status === "running") this.schedule(job.environmentId, 0);
    }
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.allSettled(this.locks.values());
  }

  /** The environment's latest job, or null. */
  status(environmentId: string): GraphDescribeJobView | null {
    const job = this.jobs.getGraphDescribeJob(environmentId);
    return job ? graphDescribeJobView(job) : null;
  }

  /** Stores a new job and starts advancing it; returns at once. */
  async start(input: GraphDescribeStartInput): Promise<GraphDescribeJobView> {
    if (this.stopped) throw new GraphDescribeError("unavailable", "The backend is stopping");
    const { workflowResults, agentTools, rollout } = this.options;
    if (!workflowResults || !agentTools) {
      throw new GraphDescribeError("unavailable", "Result tools are unavailable on this backend");
    }
    const environment = await this.options.storage.getEnvironment(input.environmentId);
    if (!environment || environment.deletionRequestedAt) {
      throw new GraphDescribeError("not-found", "The environment no longer exists");
    }
    if (environment.status !== "running") {
      throw new GraphDescribeError(
        "unavailable",
        "Start the environment first: the designer agent runs in it",
      );
    }
    if (rollout) {
      await rollout.refresh();
      if (!rollout.allows(input.agent, GRAPH_TEMPLATE_RESULT_KIND)) {
        throw new GraphDescribeError(
          "unavailable",
          `Result tools are not enabled for ${input.agent}, and Describe a graph submits through them. Choose another agent.`,
        );
      }
    }
    const config = await this.options.storage.loadConfig();
    const ceiling = await this.options.ceiling?.(environment.projectId);
    const id = randomUUID();
    const now = nowIso();
    const job: PersistedGraphDescribeJob = {
      version: GRAPH_DESCRIBE_JOB_VERSION,
      id,
      environmentId: environment.id,
      projectId: environment.projectId,
      status: "running",
      description: input.description,
      ...(input.baseDraft ? { baseDraft: input.baseDraft } : {}),
      context: {
        type: "graph-template",
        providers: normalizeAgentPlatforms(config.global.enabledAgentPlatforms, []),
        ...(ceiling ? { ceiling } : {}),
      },
      branch: {
        id,
        agent: input.agent,
        ...(input.model ? { model: input.model } : { model: "default", modelUnpinned: true }),
        ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
        ...(input.fastMode !== undefined ? { fastMode: input.fastMode } : {}),
        status: "pending",
      },
      revision: 0,
      createdAt: now,
      updatedAt: now,
    };
    let created: PersistedGraphDescribeJob;
    try {
      created = this.jobs.createGraphDescribeJob(job);
    } catch (error) {
      if (error instanceof GraphDescribeStorageError) {
        throw new GraphDescribeError("conflict", error.message);
      }
      throw error;
    }
    this.passFailures.delete(environment.id);
    this.schedule(environment.id, 0);
    return graphDescribeJobView(created);
  }

  /** Stops the environment's running job: aborts its turn and closes its slot. */
  async cancel(environmentId: string): Promise<GraphDescribeJobView | null> {
    const job = this.jobs.getGraphDescribeJob(environmentId);
    if (!job || job.status !== "running") return job ? graphDescribeJobView(job) : null;
    // A pass in flight stops at its next fence check; the abort does not wait for it.
    this.cancelling.add(job.id);
    try {
      await this.abortSession(job);
      await this.withLock(environmentId, async () => {
        const current = this.jobs.getGraphDescribeJob(environmentId);
        if (!current || current.id !== job.id || current.status !== "running") return;
        await this.finish(current, "cancelled");
      });
    } finally {
      this.cancelling.delete(job.id);
    }
    return this.status(environmentId);
  }

  /** Forgets the environment's finished job (the draft was opened, or the user dismissed it). */
  dismiss(environmentId: string, jobId: string): boolean {
    const job = this.jobs.getGraphDescribeJob(environmentId);
    if (!job || job.id !== jobId) return false;
    if (job.status === "running") {
      throw new GraphDescribeError("conflict", "Cancel the running request before dismissing it");
    }
    return this.jobs.deleteGraphDescribeJob(environmentId, jobId);
  }

  /** One pass over the environment's job, serialized with every other (tests and the timer). */
  async advanceNow(environmentId: string): Promise<GraphDescribeJobView | null> {
    await this.withLock(environmentId, () => this.pass(environmentId));
    return this.status(environmentId);
  }

  // ------------------------------------------------------------ passes

  private schedule(environmentId: string, delayMs: number): void {
    if (this.stopped || this.options.autoAdvance === false) return;
    const existing = this.timers.get(environmentId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(environmentId);
      void this.withLock(environmentId, () => this.pass(environmentId)).finally(() => {
        const job = this.jobs.getGraphDescribeJob(environmentId);
        if (job?.status !== "running") return;
        this.schedule(
          environmentId,
          job.branch.status === "pending" || job.branch.dispatchState === "prepared"
            ? 0
            : this.pollIntervalMs,
        );
      });
    }, delayMs);
    timer.unref?.();
    this.timers.set(environmentId, timer);
  }

  private async withLock(environmentId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.locks.get(environmentId) ?? Promise.resolve();
    const run = previous.then(work, work);
    const settled = run.catch(() => undefined);
    this.locks.set(environmentId, settled);
    try {
      await run;
    } finally {
      if (this.locks.get(environmentId) === settled) this.locks.delete(environmentId);
    }
  }

  private async pass(environmentId: string): Promise<void> {
    if (this.stopped) return;
    const job = this.jobs.getGraphDescribeJob(environmentId);
    if (!job || job.status !== "running") return;
    try {
      await this.retryConsumptions();
      await this.advance(job);
      this.passFailures.delete(environmentId);
    } catch (error) {
      if (isAgentBranchFenceError(error)) return;
      const failures = (this.passFailures.get(environmentId) ?? 0) + 1;
      this.passFailures.set(environmentId, failures);
      // Content-free: the message never carries the description or the draft.
      console.warn(`[graph-describe] A pass failed (${failures}/${MAX_PASS_FAILURES})`);
      if (failures < MAX_PASS_FAILURES) return;
      this.passFailures.delete(environmentId);
      const current = this.jobs.getGraphDescribeJob(environmentId);
      if (current?.id === job.id && current.status === "running") {
        await this.finish(current, "failed", `The request kept failing: ${message(error)}`);
      }
    }
  }

  private async advance(job: PersistedGraphDescribeJob): Promise<void> {
    const environment = await this.options.storage.getEnvironment(job.environmentId);
    if (!environment || environment.deletionRequestedAt) {
      await this.finish(job, "failed", "The environment no longer exists");
      return;
    }
    if (!agentBranchSettled(job.branch)) {
      const host = new GraphDescribeBranchHost(this.hostDependencies(), job, environment);
      const runner = new AgentBranchRunner(host);
      runner.beginPass();
      await runner.advanceIsolated(job.branch, 0, 1);
      await runner.flushObservations();
    }
    switch (job.branch.status) {
      case "completed":
        if (!job.template) {
          await this.finish(job, "failed", "The designer agent's draft was lost");
          return;
        }
        await this.finish(job, "completed");
        return;
      case "failed":
        await this.finish(job, "failed", job.branch.error ?? "The designer agent failed");
        return;
      case "cancelled":
        await this.finish(job, "cancelled");
        return;
      default:
        return;
    }
  }

  /** Commits a terminal job, then lets go of its session's resources. */
  private async finish(
    job: PersistedGraphDescribeJob,
    status: "completed" | "failed" | "cancelled",
    error?: string,
  ): Promise<void> {
    const next: PersistedGraphDescribeJob = {
      ...job,
      status,
      completedAt: nowIso(),
      ...(error ? { error: error.slice(0, GRAPH_DESCRIBE_BOUNDS.maxErrorChars) } : {}),
    };
    if (status !== "completed") delete next.template;
    this.jobs.saveGraphDescribeJob(next);
    if (status !== "completed") {
      const requestId = job.branch.requestId;
      if (requestId && job.branch.resultTransport === "tool-v1") {
        await this.options.workflowResults
          ?.close(requestId, status === "cancelled" ? "cancelled" : "superseded")
          .catch(() => undefined);
      }
    }
    if (job.branch.providerSessionId) this.progress.forget(job.branch.providerSessionId);
    this.options.providers.release(job.environmentId, job.branch.agent, job.id);
  }

  private async abortSession(job: PersistedGraphDescribeJob): Promise<void> {
    const sessionId = job.branch.providerSessionId;
    if (!sessionId) return;
    try {
      const environment = await this.options.storage.getEnvironment(job.environmentId);
      if (!environment) return;
      const provider = await this.options.providers.get(environment, job.branch.agent, job.id);
      await provider.abort(sessionId);
    } catch {
      // Best-effort: the job is cancelled either way, and its slot is closed.
    }
  }

  private async retryConsumptions(): Promise<void> {
    for (const requestId of [...this.pendingConsumptions].slice(0, 8)) {
      try {
        await this.options.workflowResults?.consume(requestId);
        this.pendingConsumptions.delete(requestId);
      } catch {
        // Kept for a later pass; bounded.
      }
    }
  }

  private hostDependencies(): GraphDescribeHostDependencies {
    const { workflowResults, agentTools } = this.options;
    if (!workflowResults || !agentTools) {
      throw new GraphDescribeError("unavailable", "Result tools are unavailable on this backend");
    }
    return {
      providers: this.options.providers,
      workflowResults,
      agentTools,
      ...(this.options.assertAgentToolsReachable
        ? { assertAgentToolsReachable: this.options.assertAgentToolsReachable }
        : {}),
      save: (job) => {
        if (this.stopped || this.cancelling.has(job.id)) throw new GraphDescribeFenceError();
        try {
          return this.jobs.saveGraphDescribeJob(job);
        } catch (error) {
          if (error instanceof GraphDescribeStorageError) throw new GraphDescribeFenceError();
          throw error;
        }
      },
      assertCurrent: (job) => {
        if (this.stopped) throw new GraphDescribeFenceError("The backend is stopping");
        if (this.cancelling.has(job.id))
          throw new GraphDescribeFenceError("The request was cancelled");
        const stored = this.jobs.getGraphDescribeJob(job.environmentId);
        if (
          stored?.id !== job.id ||
          stored.revision !== job.revision ||
          stored.status !== "running"
        ) {
          throw new GraphDescribeFenceError();
        }
      },
      deferConsumption: (requestId) => {
        if (this.pendingConsumptions.size < MAX_PENDING_CONSUMPTIONS) {
          this.pendingConsumptions.add(requestId);
        }
      },
      finishConsumption: (requestId) => {
        this.pendingConsumptions.delete(requestId);
      },
      progress: this.progress,
      pollGate: this.pollGate,
      ...(this.options.stallWarningMs !== undefined
        ? { stallWarningMs: this.options.stallWarningMs }
        : {}),
      ...(this.options.stallAbandonMs !== undefined
        ? { stallAbandonMs: this.options.stallAbandonMs }
        : {}),
    };
  }
}
