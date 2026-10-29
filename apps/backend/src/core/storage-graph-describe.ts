import {
  GRAPH_DESCRIBE_JOB_STATUSES,
  type GraphDescribeJobStatus,
  type GraphTemplateResultContext,
} from "@orkestrator/protocol/graphs/describe";
import type { GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import type { AgentBranchRecord } from "./agent-branch-types.js";
import type { StorageContext } from "./storage-context.js";
import { isRecord, nowIso } from "./storage-shared.js";

export const GRAPH_DESCRIBE_JOB_VERSION = 1;

/**
 * One environment's "Describe a graph" job (item 215), as stored. The agent
 * session's durable state is the shared branch runner's record (`branch`);
 * everything the job needs after a restart (the description, the draft to
 * modify, the compile context) is kept beside it.
 */
export interface PersistedGraphDescribeJob {
  version: typeof GRAPH_DESCRIBE_JOB_VERSION;
  id: string;
  environmentId: string;
  projectId: string;
  status: GraphDescribeJobStatus;
  description: string;
  baseDraft?: GraphTemplateV1;
  /** What drafts are compiled against (the slot's trusted context). */
  context: GraphTemplateResultContext;
  branch: AgentBranchRecord;
  /** The accepted draft, once completed. */
  template?: GraphTemplateV1;
  error?: string;
  /** Compare-and-swap revision; 1 on the first save. */
  revision: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

/** A refused write: the stored job moved on (cancelled, replaced) or is still running. */
export class GraphDescribeStorageError extends Error {
  constructor(
    readonly code: "revision-conflict" | "already-running",
    message: string,
  ) {
    super(message);
    this.name = "GraphDescribeStorageError";
  }
}

function isPersistedGraphDescribeJob(
  value: unknown,
  environmentId?: string,
): value is PersistedGraphDescribeJob {
  return (
    isRecord(value) &&
    value.version === GRAPH_DESCRIBE_JOB_VERSION &&
    typeof value.id === "string" &&
    typeof value.environmentId === "string" &&
    (environmentId === undefined || value.environmentId === environmentId) &&
    typeof value.projectId === "string" &&
    (GRAPH_DESCRIBE_JOB_STATUSES as readonly unknown[]).includes(value.status) &&
    typeof value.description === "string" &&
    isRecord(value.context) &&
    isRecord(value.branch) &&
    Number.isSafeInteger(value.revision) &&
    (value.revision as number) > 0 &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

/**
 * The `graph-describe` store: one row per environment holding its latest
 * describe job, owned by the environment. Every write is one `updateStoreRow`
 * transaction that checks the stored revision against the caller's (or, for a
 * new job, that no job is running), and announces `graph-describe` with the
 * environment id. Terminal jobs stay until the user dismisses them or starts
 * another, so a client that was away still sees the result.
 */
export class GraphDescribeRepository {
  constructor(private readonly context: StorageContext) {}

  private graphDescribeFile(): string {
    return this.context.file("graph-describe.json");
  }

  getGraphDescribeJob(environmentId: string): PersistedGraphDescribeJob | null {
    const stored = this.context.loadStoreRow(this.graphDescribeFile(), environmentId);
    return isPersistedGraphDescribeJob(stored, environmentId) ? stored : null;
  }

  /** Every readable job (startup recovery). */
  async listGraphDescribeJobs(): Promise<PersistedGraphDescribeJob[]> {
    const stored = await this.context.loadJson<Record<string, unknown>>(
      this.graphDescribeFile(),
      () => ({}),
    );
    return Object.entries(stored)
      .filter((entry): entry is [string, PersistedGraphDescribeJob] =>
        isPersistedGraphDescribeJob(entry[1], entry[0]),
      )
      .map(([, job]) => job);
  }

  /**
   * Stores a new job (its `revision` is ignored; it is stored at 1), replacing
   * a finished one. Refuses while the environment's job is still running.
   */
  createGraphDescribeJob(job: PersistedGraphDescribeJob): PersistedGraphDescribeJob {
    const saved = this.context.updateStoreRow<PersistedGraphDescribeJob>(
      this.graphDescribeFile(),
      job.environmentId,
      (current) => {
        if (isPersistedGraphDescribeJob(current) && current.status === "running") {
          throw new GraphDescribeStorageError(
            "already-running",
            "A graph is already being described in this environment",
          );
        }
        const now = nowIso();
        const next: PersistedGraphDescribeJob = {
          ...job,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        return { result: next, value: next };
      },
    );
    this.context.changes.announce("graph-describe", job.environmentId, job.projectId);
    return saved;
  }

  /** Saves `job` when the stored one is the same job at `job.revision`; returns it at the next revision. */
  saveGraphDescribeJob(job: PersistedGraphDescribeJob): PersistedGraphDescribeJob {
    const saved = this.context.updateStoreRow<PersistedGraphDescribeJob>(
      this.graphDescribeFile(),
      job.environmentId,
      (current) => {
        if (
          !isPersistedGraphDescribeJob(current) ||
          current.id !== job.id ||
          current.revision !== job.revision
        ) {
          throw new GraphDescribeStorageError(
            "revision-conflict",
            "The describe job changed since it was read",
          );
        }
        const next: PersistedGraphDescribeJob = {
          ...job,
          revision: job.revision + 1,
          updatedAt: nowIso(),
        };
        return { result: next, value: next };
      },
    );
    this.context.changes.announce("graph-describe", job.environmentId, job.projectId);
    return saved;
  }

  /** Removes the environment's job when it is `jobId` (any job when omitted); whether one was removed. */
  deleteGraphDescribeJob(environmentId: string, jobId?: string): boolean {
    const deleted = this.context.updateStoreRow<boolean>(
      this.graphDescribeFile(),
      environmentId,
      (current) => {
        if (current === undefined) return { result: false };
        if (jobId !== undefined && isRecord(current) && current.id !== jobId) {
          return { result: false };
        }
        return { result: true, delete: true };
      },
    );
    if (deleted) {
      this.context.changes.announce("graph-describe", environmentId, undefined, undefined, true);
    }
    return deleted;
  }
}

/**
 * The describe job store: what callers reach as `storage.graphDescribe`.
 * Every name here is an entry point `storage-writer-guards.test.ts` follows
 * store writes back to.
 */
export type GraphDescribeStorage = Pick<
  GraphDescribeRepository,
  | "getGraphDescribeJob"
  | "listGraphDescribeJobs"
  | "createGraphDescribeJob"
  | "saveGraphDescribeJob"
  | "deleteGraphDescribeJob"
>;
