import { createHash } from "node:crypto";
import { canonicalJson } from "@orkestrator/protocol/canonical-json";
import type { CompiledGraphPlan } from "@orkestrator/protocol/graphs/compile";
import {
  GRAPH_ARTIFACT_BUDGETS,
  GRAPH_ARTIFACT_FORMAT_VERSION,
  GRAPH_RUN_FORMAT_VERSION,
  GRAPH_RUN_TERMINAL_STATUSES,
  graphArtifactFootprint,
  graphArtifactLimitViolation,
  graphRunLimitViolation,
  graphRunRecordBytesViolation,
  isGraphRunId,
  validateGraphArtifact,
  validateGraphRun,
  verifyGraphArtifactIdentity,
  type GraphArtifact,
  type GraphRun,
} from "@orkestrator/protocol/graphs/run";
import { GraphStorageError } from "./graph-run-errors.js";
import { isNonBlankString, isNonNegativeInteger, isRecord, nowIso } from "./storage-shared.js";
import type { StorageContext } from "./storage-context.js";
import type { StorageRepositories } from "./storage-repositories.js";

/** Native SHA-256, the same function the protocol's pure implementation computes. */
export function graphStorageHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** `verifyGraphPlanDigest` over the native hash. */
export function verifyGraphPlanDigestNative(plan: CompiledGraphPlan): boolean {
  try {
    const { digest, ...rest } = plan;
    return digest === graphStorageHash(canonicalJson(rest, 128));
  } catch {
    return false;
  }
}

/** Per-run artifact totals, kept in the run's usage row of `graph-artifacts`. */
export interface GraphArtifactUsage {
  artifacts: number;
  inlineBytes: number;
  diskBytes: number;
}

interface StoredGraphArtifactUsage {
  runId: string;
  usage: GraphArtifactUsage;
}

const EMPTY_USAGE: GraphArtifactUsage = { artifacts: 0, inlineBytes: 0, diskBytes: 0 };

function issuesOf(result: { ok: boolean; errors?: Array<{ path: string; code: string }> }) {
  return result.ok ? [] : (result.errors ?? []).map((error) => `${error.path}:${error.code}`);
}

function isStoredUsage(value: unknown): value is StoredGraphArtifactUsage {
  return (
    isRecord(value) &&
    typeof value.runId === "string" &&
    isRecord(value.usage) &&
    isNonNegativeInteger(value.usage.artifacts) &&
    isNonNegativeInteger(value.usage.inlineBytes) &&
    isNonNegativeInteger(value.usage.diskBytes)
  );
}

/**
 * A stored run's format: the upgrade hook. Format 1 is the only one so far;
 * a later shape change adds its one-shot upgrade to
 * `storage-record-upgrades.ts` and bumps `GRAPH_RUN_FORMAT_VERSION`. A record
 * a newer build wrote is refused (a downgrade fence), never rewritten.
 */
function storedFormat(value: unknown): "current" | "newer" | "invalid" {
  if (!isRecord(value) || !Number.isSafeInteger(value.formatVersion)) return "invalid";
  if ((value.formatVersion as number) > GRAPH_RUN_FORMAT_VERSION) return "newer";
  return value.formatVersion === GRAPH_RUN_FORMAT_VERSION ? "current" : "invalid";
}

/** The artifact row key: one run's artifacts never collide with another's. */
function artifactKey(runId: string, artifactId: string): string {
  return `${runId}/${artifactId}`;
}

/** The fields an artifact's identity does not cover, left out of an equality check. */
function immutablePart(artifact: GraphArtifact): string {
  const { createdAt: _createdAt, state: _state, supersededBy: _supersededBy, ...rest } = artifact;
  return canonicalJson(rest, 128);
}

/**
 * Graph runs (plan P2.1, report §8.1) and their artifacts (§5.4).
 *
 * `graph-runs` is a record store, one row per run, owned by its environment.
 * Every write is a single-row `updateStoreRow` that checks the caller's
 * revision inside its own transaction (compare-and-swap). `graph-artifacts`
 * is a record store owned by run: one row per artifact (`<run>/<id>`), never
 * overwritten, plus one usage row per run (`<run>`) whose totals enforce the
 * per-run budgets in the same transaction as the insert.
 *
 * Writers of both stores serialize on one lease, because a write first awaits
 * its environment check (no write for an environment that is being deleted)
 * and environment deletion removes both stores' rows under the same lease.
 * Reads take no lease.
 */
export class GraphRunsRepository {
  constructor(
    private readonly context: StorageContext,
    private readonly repos: StorageRepositories,
  ) {}

  private graphRunsFile(): string {
    return this.context.file("graph-runs.json");
  }

  private graphArtifactsFile(): string {
    return this.context.file("graph-artifacts.json");
  }

  private enqueueGraphRunMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.context.serialize(this.graphRunsFile(), "graph run storage", operation);
  }

  /** The environment must exist and not be marked for deletion. */
  private async assertEnvironmentWritable(environmentId: string | undefined): Promise<void> {
    if (environmentId === undefined) return;
    const environment = await this.repos.projects.getEnvironment(environmentId);
    if (!environment) {
      throw new GraphStorageError("environment-not-found", "The run's environment does not exist");
    }
    if (environment.deletionRequestedAt || environment.lifecycleOperation === "deleting") {
      throw new GraphStorageError("environment-deleting", "The run's environment is being deleted");
    }
  }

  /** A run that passes its guard and every bound, or a typed refusal. */
  private checkedRun(run: GraphRun): string {
    const violation = graphRunLimitViolation(run);
    if (violation) throw GraphStorageError.limit(violation);
    const validation = validateGraphRun(run, { verifyPlan: verifyGraphPlanDigestNative });
    if (!validation.ok) {
      throw new GraphStorageError("invalid-run", "The graph run record is invalid", {
        issues: issuesOf(validation),
      });
    }
    const serialized = JSON.stringify(run);
    const bytes = Buffer.byteLength(serialized, "utf8");
    const tooLarge = graphRunRecordBytesViolation(bytes);
    if (tooLarge) throw GraphStorageError.limit(tooLarge);
    return serialized;
  }

  private parseStoredRun(value: unknown, runId: string): GraphRun | null {
    if (value === undefined) return null;
    const format = storedFormat(value);
    if (format === "newer") {
      throw new GraphStorageError(
        "newer-format",
        "This graph run was written by a newer version of Orkestrator",
      );
    }
    const validation =
      format === "current"
        ? validateGraphRun(value, { verifyPlan: verifyGraphPlanDigestNative })
        : null;
    if (!validation?.ok || validation.value.id !== runId) {
      throw new GraphStorageError(
        "invalid-run",
        "The stored graph run record is invalid",
        validation ? { issues: issuesOf(validation) } : {},
      );
    }
    return validation.value;
  }

  /** One run; null when absent. Throws `newer-format` or `invalid-run` for a record it cannot read. */
  async getGraphRun(runId: string): Promise<GraphRun | null> {
    if (!isGraphRunId(runId)) throw new GraphStorageError("run-not-found", "Invalid run id");
    return this.parseStoredRun(this.context.loadStoreRow(this.graphRunsFile(), runId), runId);
  }

  /** An environment's runs, oldest first. Records this build cannot read are left out. */
  async listGraphRuns(environmentId: string): Promise<GraphRun[]> {
    if (!isNonBlankString(environmentId)) throw new Error("Environment ID must not be blank");
    return this.readable(
      this.context.loadStoreRowsByOwner<unknown>(this.graphRunsFile(), environmentId),
    );
  }

  /**
   * The ids of an environment's runs, attributed by the stored environment
   * field alone, so records this build cannot read are included (deletion).
   */
  async listGraphRunIds(environmentId: string): Promise<string[]> {
    if (!isNonBlankString(environmentId)) throw new Error("Environment ID must not be blank");
    return this.context
      .loadStoreRowsByOwner<unknown>(this.graphRunsFile(), environmentId)
      .flatMap((run) => (isRecord(run) && isGraphRunId(run.id) ? [run.id] : []));
  }

  /** Every run, oldest first (startup recovery). Records this build cannot read are left out. */
  async listAllGraphRuns(): Promise<GraphRun[]> {
    const stored = await this.context.loadJson<Record<string, unknown>>(
      this.graphRunsFile(),
      () => ({}),
    );
    return this.readable(Object.values(stored));
  }

  private readable(values: unknown[]): GraphRun[] {
    const runs: GraphRun[] = [];
    for (const value of values) {
      if (storedFormat(value) !== "current") continue;
      const validation = validateGraphRun(value, { verifyPlan: verifyGraphPlanDigestNative });
      if (validation.ok) runs.push(validation.value);
    }
    return runs.sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    );
  }

  /**
   * Stores a new run at revision 1. The caller passes revision 0. Refuses an
   * existing id, an environment that is missing or being deleted, an invalid
   * record and any overrun.
   */
  async createGraphRun(run: GraphRun): Promise<GraphRun> {
    if (run.revision !== 0) {
      throw new GraphStorageError("revision-conflict", "A new run starts at revision 0", {
        actual: run.revision,
      });
    }
    const now = nowIso();
    const next: GraphRun = { ...run, revision: 1, updatedAt: now };
    this.checkedRun(next);
    return this.enqueueGraphRunMutation(async () => {
      await this.assertEnvironmentWritable(next.environmentId);
      const created = this.context.updateStoreRow<GraphRun>(
        this.graphRunsFile(),
        next.id,
        (current) => {
          if (current !== undefined) {
            throw new GraphStorageError("run-exists", "A graph run with this id already exists");
          }
          return { result: next, value: next };
        },
      );
      this.context.changes.announce("graph-run", next.id, next.projectId);
      return created;
    });
  }

  /**
   * Saves `run` if the stored record is still at `expectedRevision`, bumping
   * the revision. The plan is frozen, the project fixed, and the environment
   * may only be set once. With `supersede`, the listed artifacts are marked
   * superseded by that rewind in the same transaction, so a rewind's record
   * and its artifact marks commit together.
   */
  async saveGraphRun(
    run: GraphRun,
    expectedRevision: number,
    options: { supersede?: { rewindId: string; artifactIds: readonly string[] } } = {},
  ): Promise<GraphRun> {
    if (!isNonNegativeInteger(expectedRevision)) {
      throw new Error("Graph run expected revision must be a non-negative integer");
    }
    if (
      options.supersede &&
      options.supersede.artifactIds.length > GRAPH_ARTIFACT_BUDGETS.maxArtifactsPerRun
    ) {
      throw new GraphStorageError("artifact-count", "Too many artifacts to supersede at once", {
        limit: GRAPH_ARTIFACT_BUDGETS.maxArtifactsPerRun,
        actual: options.supersede.artifactIds.length,
      });
    }
    const candidate: GraphRun = { ...run, revision: expectedRevision + 1, updatedAt: nowIso() };
    this.checkedRun(candidate);
    return this.enqueueGraphRunMutation(async () => {
      await this.assertEnvironmentWritable(candidate.environmentId);
      return this.context.database.transaction(() => {
        const saved = this.context.updateStoreRow<GraphRun>(
          this.graphRunsFile(),
          candidate.id,
          (current) => {
            if (current === undefined) {
              throw new GraphStorageError("run-not-found", "The graph run does not exist");
            }
            if (storedFormat(current) === "newer") {
              throw new GraphStorageError(
                "newer-format",
                "This graph run was written by a newer version of Orkestrator",
              );
            }
            const previous = current as Partial<GraphRun>;
            if (previous.revision !== expectedRevision) {
              throw new GraphStorageError("revision-conflict", "Graph run revision conflict", {
                limit: expectedRevision,
                ...(typeof previous.revision === "number" ? { actual: previous.revision } : {}),
              });
            }
            if (previous.plan?.digest !== candidate.plan.digest) {
              throw new GraphStorageError("plan-changed", "A run's plan is frozen at launch");
            }
            if (
              previous.projectId !== candidate.projectId ||
              (previous.environmentId !== undefined &&
                previous.environmentId !== candidate.environmentId)
            ) {
              throw new GraphStorageError(
                "invalid-run",
                "A run never moves to another environment",
              );
            }
            return { result: candidate, value: candidate };
          },
        );
        if (options.supersede) {
          this.markSuperseded(
            candidate.id,
            options.supersede.artifactIds,
            options.supersede.rewindId,
          );
        }
        this.context.changes.announce("graph-run", candidate.id, candidate.projectId);
        return saved;
      });
    });
  }

  /** Inside a transaction: marks each listed artifact superseded by the rewind. */
  private markSuperseded(runId: string, artifactIds: readonly string[], rewindId: string): number {
    let changed = 0;
    for (const id of artifactIds) {
      changed += this.context.updateStoreRow<number>(
        this.graphArtifactsFile(),
        artifactKey(runId, id),
        (current) => {
          if (!isRecord(current) || current.runId !== runId) {
            throw new GraphStorageError("artifact-not-found", "The run has no such artifact");
          }
          // Superseded is final: a repeated or later rewind leaves the mark.
          if (current.state === "superseded") return { result: 0 };
          return {
            result: 1,
            value: { ...current, state: "superseded", supersededBy: rewindId },
          };
        },
      );
    }
    return changed;
  }

  /**
   * Stores an artifact. Idempotent for the same envelope; an id already
   * stored with other content is refused (artifacts are never overwritten).
   * Enforces the per-artifact bounds and, in the same transaction as the
   * insert, the run's count, inline and disk budgets.
   */
  async putGraphArtifact(artifact: GraphArtifact): Promise<GraphArtifact> {
    const violation = graphArtifactLimitViolation(artifact);
    if (violation) throw GraphStorageError.limit(violation);
    const validation = validateGraphArtifact(artifact);
    if (!validation.ok) {
      throw new GraphStorageError("invalid-artifact", "The graph artifact is invalid", {
        issues: issuesOf(validation),
      });
    }
    const identity = verifyGraphArtifactIdentity(artifact, graphStorageHash);
    if (!identity.ok) {
      throw new GraphStorageError(
        "invalid-artifact",
        `The graph artifact's ${identity.field} does not follow from its content`,
      );
    }
    if (artifact.state !== "live" || artifact.supersededBy !== undefined) {
      throw new GraphStorageError("invalid-artifact", "A new artifact is live");
    }
    const footprint = graphArtifactFootprint(artifact.body);
    return this.enqueueGraphRunMutation(async () => {
      const run = this.context.loadStoreRow(this.graphRunsFile(), artifact.runId);
      if (!isRecord(run)) {
        throw new GraphStorageError("run-not-found", "The artifact's run does not exist");
      }
      await this.assertEnvironmentWritable(
        typeof run.environmentId === "string" ? run.environmentId : undefined,
      );
      return this.context.database.transaction(() => {
        const existing = this.context.loadStoreRow(
          this.graphArtifactsFile(),
          artifactKey(artifact.runId, artifact.id),
        );
        if (existing !== undefined) {
          const stored = validateGraphArtifact(existing);
          if (stored.ok && immutablePart(stored.value) === immutablePart(artifact)) {
            return stored.value;
          }
          throw new GraphStorageError(
            "artifact-conflict",
            "An artifact with this id is already stored with other content",
          );
        }
        this.context.updateStoreRow<void>(this.graphArtifactsFile(), artifact.runId, (current) => {
          const usage = isStoredUsage(current) ? current.usage : EMPTY_USAGE;
          const next: GraphArtifactUsage = {
            artifacts: usage.artifacts + 1,
            inlineBytes: usage.inlineBytes + footprint.inline,
            diskBytes: usage.diskBytes + footprint.disk,
          };
          const budget = GRAPH_ARTIFACT_BUDGETS;
          if (next.artifacts > budget.maxArtifactsPerRun) {
            throw new GraphStorageError(
              "artifact-count",
              `A run keeps at most ${budget.maxArtifactsPerRun} artifacts`,
              { limit: budget.maxArtifactsPerRun, actual: next.artifacts },
            );
          }
          if (next.inlineBytes > budget.maxInlineBytesPerRun) {
            throw new GraphStorageError(
              "inline-budget",
              `A run's inline artifacts are bounded to ${budget.maxInlineBytesPerRun} bytes`,
              { limit: budget.maxInlineBytesPerRun, actual: next.inlineBytes },
            );
          }
          if (next.diskBytes > budget.maxDiskBytesPerRun) {
            throw new GraphStorageError(
              "disk-budget",
              `A run's reference artifacts are bounded to ${budget.maxDiskBytesPerRun} bytes on disk`,
              { limit: budget.maxDiskBytesPerRun, actual: next.diskBytes },
            );
          }
          const value: StoredGraphArtifactUsage = { runId: artifact.runId, usage: next };
          return { result: undefined, value };
        });
        this.context.updateStoreRow<void>(
          this.graphArtifactsFile(),
          artifactKey(artifact.runId, artifact.id),
          () => ({ result: undefined, value: artifact }),
        );
        return artifact;
      });
    });
  }

  /** One artifact of a run; null when absent or unreadable. */
  async getGraphArtifact(runId: string, artifactId: string): Promise<GraphArtifact | null> {
    if (!isGraphRunId(runId) || !/^[a-f0-9]{64}$/.test(artifactId)) return null;
    const stored = this.context.loadStoreRow(
      this.graphArtifactsFile(),
      artifactKey(runId, artifactId),
    );
    if (stored === undefined) return null;
    const validation = validateGraphArtifact(stored);
    return validation.ok && validation.value.runId === runId && validation.value.id === artifactId
      ? validation.value
      : null;
  }

  /** Every artifact of a run (the per-run index), oldest first. */
  async listGraphArtifacts(runId: string): Promise<GraphArtifact[]> {
    if (!isGraphRunId(runId)) return [];
    const artifacts: GraphArtifact[] = [];
    for (const row of this.context.loadStoreRowsByOwner<unknown>(
      this.graphArtifactsFile(),
      runId,
    )) {
      if (!isRecord(row) || row.formatVersion !== GRAPH_ARTIFACT_FORMAT_VERSION) continue;
      const validation = validateGraphArtifact(row);
      if (validation.ok && validation.value.runId === runId) artifacts.push(validation.value);
    }
    return artifacts.sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    );
  }

  /** The run's budget totals. */
  async graphArtifactUsage(runId: string): Promise<GraphArtifactUsage> {
    if (!isGraphRunId(runId)) return { ...EMPTY_USAGE };
    const stored = this.context.loadStoreRow(this.graphArtifactsFile(), runId);
    return isStoredUsage(stored) ? { ...stored.usage } : { ...EMPTY_USAGE };
  }

  /**
   * Marks artifacts superseded by a rewind (when the run record was saved
   * separately). Returns how many changed; already superseded ones keep their
   * mark. Refuses an unknown id.
   */
  async supersedeGraphArtifacts(
    runId: string,
    artifactIds: readonly string[],
    rewindId: string,
  ): Promise<number> {
    if (!isGraphRunId(runId) || !isGraphRunId(rewindId)) {
      throw new GraphStorageError("artifact-not-found", "Invalid run or rewind id");
    }
    if (artifactIds.length > GRAPH_ARTIFACT_BUDGETS.maxArtifactsPerRun) {
      throw new GraphStorageError("artifact-count", "Too many artifacts to supersede at once", {
        limit: GRAPH_ARTIFACT_BUDGETS.maxArtifactsPerRun,
        actual: artifactIds.length,
      });
    }
    return this.enqueueGraphRunMutation(async () =>
      this.context.database.transaction(() => this.markSuperseded(runId, artifactIds, rewindId)),
    );
  }

  /**
   * Removes one finished run that has no environment, with every artifact and
   * effect row of it: the retention of environment-less mock runs (item 213),
   * which environment deletion never reaches. Refuses a run with an
   * environment (environment deletion owns those) and an unfinished one.
   * Returns whether a run was removed.
   */
  async deleteEnvironmentlessGraphRun(runId: string): Promise<boolean> {
    if (!isGraphRunId(runId)) return false;
    return this.enqueueGraphRunMutation(async () => {
      const stored = this.context.loadStoreRow(this.graphRunsFile(), runId);
      if (!isRecord(stored)) return false;
      if (stored.environmentId !== undefined) {
        throw new GraphStorageError(
          "invalid-run",
          "A run with an environment leaves with its environment",
        );
      }
      if (
        typeof stored.status !== "string" ||
        !(GRAPH_RUN_TERMINAL_STATUSES as readonly string[]).includes(stored.status)
      ) {
        throw new GraphStorageError("invalid-run", "Only a finished run can be removed");
      }
      const rows = this.context.loadStoreRowsByOwner<unknown>(this.graphArtifactsFile(), runId);
      this.context.database.transaction(() => {
        for (const row of rows) {
          if (!isRecord(row) || typeof row.id !== "string") continue;
          this.context.updateStoreRow<void>(
            this.graphArtifactsFile(),
            artifactKey(runId, row.id),
            () => ({ result: undefined, delete: true }),
          );
        }
        this.context.updateStoreRow<void>(this.graphRunsFile(), runId, () => ({
          result: undefined,
          delete: true,
        }));
      });
      this.context.changes.announce(
        "graph-run",
        runId,
        typeof stored.projectId === "string" ? stored.projectId : undefined,
        undefined,
        true,
      );
      return true;
    });
  }

  /**
   * Environment deletion: removes the environment's runs and every artifact
   * row of those runs. Attributed by the stored environment field alone, so
   * a record this build cannot otherwise read still leaves with its
   * environment. Their activation transcripts are removed after. Returns the
   * removed run ids.
   */
  async deleteGraphRunsByEnvironment(environmentId: string): Promise<string[]> {
    if (!isNonBlankString(environmentId)) throw new Error("Environment ID must not be blank");
    const removed = await this.enqueueGraphRunMutation(async () => {
      const runIds = this.context
        .loadStoreRowsByOwner<unknown>(this.graphRunsFile(), environmentId)
        .flatMap((run) => (isRecord(run) && typeof run.id === "string" ? [run.id] : []));
      for (const runId of runIds) {
        const rows = this.context.loadStoreRowsByOwner<unknown>(this.graphArtifactsFile(), runId);
        this.context.database.transaction(() => {
          for (const row of rows) {
            if (!isRecord(row)) continue;
            const key = typeof row.id === "string" ? artifactKey(runId, row.id) : runId;
            this.context.updateStoreRow<void>(this.graphArtifactsFile(), key, () => ({
              result: undefined,
              delete: true,
            }));
          }
          this.context.updateStoreRow<void>(this.graphRunsFile(), runId, () => ({
            result: undefined,
            delete: true,
          }));
        });
        this.context.changes.announce("graph-run", runId, undefined, undefined, true);
      }
      return runIds;
    });
    // Then their activation transcripts (item 211). Best-effort: a manifest
    // left behind has no live owner, so the startup sweep removes it.
    for (const runId of removed) {
      await this.repos.buildPipelines.deleteGraphRunTranscripts(runId).catch(() => undefined);
    }
    return removed;
  }
}

/** The graph-run entry points code outside the storage files calls. */
export type GraphRunsStorage = Pick<
  GraphRunsRepository,
  | "getGraphRun"
  | "listGraphRuns"
  | "listGraphRunIds"
  | "listAllGraphRuns"
  | "createGraphRun"
  | "saveGraphRun"
  | "putGraphArtifact"
  | "getGraphArtifact"
  | "listGraphArtifacts"
  | "graphArtifactUsage"
  | "supersedeGraphArtifacts"
  | "deleteGraphRunsByEnvironment"
  | "deleteEnvironmentlessGraphRun"
>;
