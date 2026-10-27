/**
 * Environment-net projections from the shared environment scan.
 *
 * The existing scan owner (`DiffStatsService`) still decides when to scan;
 * this projector turns every settled outcome into the canonical
 * `environment-net` measurement and its projection, so the sidebar badge and
 * the Changes rows are two views of one measurement. Binary rows keep their
 * identity with not-applicable counts, uncounted rows are unknown, and the
 * comparison names the immutable commit its ref resolved to. A failed scan
 * keeps the last measurement and marks it stale; it never publishes zero.
 */

import { runCommand } from "../shell.js";
import {
  addLineCounts,
  exactCount,
  notApplicableCount,
  unknownCount,
  type LineCount,
} from "@orkestrator/protocol/change-measurements";
import { environmentChangeResourceKey } from "@orkestrator/protocol/change-resources";
import {
  GIT_REPRESENTATION_ID,
  gitNumstatAlgorithmId,
} from "@orkestrator/protocol/node/change-tracking/count-policy";
import type { DiffScanEvent, DiffStatsTarget } from "../diff-stats-service.js";
import type { GitFileChange } from "../commands-files.js";
import { encodePath } from "./capture.js";
import type { MeasurementFileRecord } from "./change-ledger.js";
import type { ChangeMeasurementService } from "./measurement-service.js";
import type { ChangeProjectionService } from "./projection-service.js";
import type { WorktreeRegistry } from "./worktree-owner.js";

export interface ProjectionAnnouncer {
  announce(resourceKey: string): void;
  contentInvalidated(resourceKey: string, pathIds: string[] | null, generation: number): void;
}

/** Process-wide on purpose: the host's Git binary is the same for every backend. */
let gitVersionPromise: Promise<string> | null = null;

export function installedGitVersion(): Promise<string> {
  gitVersionPromise ??= runCommand("git", ["--version"], { timeoutMs: 10_000 }).then(
    (result) => /(\d+\.\d+(?:\.\d+)?)/.exec(result.stdout)?.[1] ?? "unknown",
    () => "unknown",
  );
  return gitVersionPromise;
}

function statusOf(status: string): string {
  const code = status[0] ?? "";
  switch (code) {
    case "A":
    case "?":
      return "added";
    case "D":
      return "deleted";
    case "M":
      return "modified";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "type-changed";
    default:
      return "unknown";
  }
}

function isGitFileChange(value: unknown): value is GitFileChange {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as GitFileChange).path === "string" &&
    typeof (value as GitFileChange).additions === "number" &&
    typeof (value as GitFileChange).deletions === "number"
  );
}

export class EnvironmentChangeProjector {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly contentGenerations = new Map<string, number>();
  private readonly hintTimers = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; paths: Set<string> | null }
  >();
  private readonly onWorktreeActivity:
    | ((environmentId: string, paths: readonly string[] | null) => void)
    | undefined;

  constructor(
    private readonly deps: {
      measurements: ChangeMeasurementService;
      projections: ChangeProjectionService;
      registry: WorktreeRegistry;
      announcer: ProjectionAnnouncer;
      liveBodyCoalesceMs: number;
      onWorktreeActivity?: (environmentId: string, paths: readonly string[] | null) => void;
    },
  ) {
    this.onWorktreeActivity = deps.onWorktreeActivity;
  }

  /** Synchronous listener for {@link DiffScanEvent}; work runs serialized per environment. */
  readonly handle = (event: DiffScanEvent): void => {
    const environmentId =
      event.kind === "removed" ? event.environmentId : event.target.environmentId;
    if (event.kind === "hint") {
      this.coalesceHint(environmentId, event.paths);
      this.onWorktreeActivity?.(environmentId, event.paths);
      return;
    }
    const previous = this.chains.get(environmentId) ?? Promise.resolve();
    const next = previous
      .then(() => this.apply(event))
      .catch((error) => {
        console.warn(
          "[change-tracking] environment projection failed:",
          error instanceof Error ? error.message : error,
        );
      })
      .finally(() => {
        if (this.chains.get(environmentId) === next) this.chains.delete(environmentId);
      });
    this.chains.set(environmentId, next);
  };

  /** Settle pending work (tests and shutdown). */
  async idle(): Promise<void> {
    while (this.chains.size > 0) await Promise.all(this.chains.values());
  }

  contentGeneration(environmentId: string): number {
    return this.contentGenerations.get(environmentId) ?? 0;
  }

  private coalesceHint(environmentId: string, paths: readonly string[] | null): void {
    const key = environmentChangeResourceKey(environmentId);
    const pending = this.hintTimers.get(environmentId);
    if (pending) {
      if (pending.paths && paths)
        for (const path of paths) pending.paths.add(encodePath(new TextEncoder().encode(path)));
      else pending.paths = null;
      return;
    }
    const entry = {
      paths: paths
        ? new Set(paths.map((path) => encodePath(new TextEncoder().encode(path))))
        : null,
      timer: setTimeout(() => {
        this.hintTimers.delete(environmentId);
        const generation = (this.contentGenerations.get(environmentId) ?? 0) + 1;
        this.contentGenerations.set(environmentId, generation);
        const freshness = this.deps.projections.getFreshness(key);
        if (freshness) {
          this.deps.projections.setFreshness(key, {
            ...freshness,
            freshness: {
              ...freshness.freshness,
              lastContentChangeObservedAt: new Date().toISOString(),
            },
          });
        }
        this.deps.announcer.contentInvalidated(
          key,
          entry.paths ? [...entry.paths] : null,
          generation,
        );
      }, this.deps.liveBodyCoalesceMs),
    };
    entry.timer.unref?.();
    this.hintTimers.set(environmentId, entry);
  }

  private async apply(event: Exclude<DiffScanEvent, { kind: "hint" }>): Promise<void> {
    const environmentId =
      event.kind === "removed" ? event.environmentId : event.target.environmentId;
    const key = environmentChangeResourceKey(environmentId);
    const projections = this.deps.projections;
    const previous = projections.getFreshness(key);
    const base = previous?.freshness ?? {
      lastAttemptAt: null,
      lastSuccessfulCheckAt: null,
      lastContentChangeObservedAt: null,
      observedAt: null,
      requiredObservationEpoch: null,
      checkedObservationEpoch: null,
    };
    if (event.kind === "removed") {
      projections.setFreshness(key, {
        observationState: "unknown",
        freshness: base,
        deleted: true,
      });
      projections.bump(key);
      this.deps.announcer.announce(key);
      return;
    }
    if (event.kind === "failed" || event.kind === "paused") {
      projections.setFreshness(key, {
        observationState: event.kind === "failed" ? "degraded" : "stale",
        freshness: { ...base, lastAttemptAt: event.at },
        stale: true,
        unavailableReason: event.kind === "failed" ? "scan-failed" : "runtime-stopped",
      });
      projections.bump(key);
      this.deps.announcer.announce(key);
      return;
    }
    const outcome = await this.publishScan(event.target, event.result.changes, {
      truncated: event.result.stats.truncated,
      baseOid: event.result.baseOid,
      ambiguousPaths: event.result.ambiguousPaths ?? [],
    });
    const contentChanged = event.changed || outcome.created;
    projections.setFreshness(key, {
      observationState: "fresh",
      checkStartedAt: event.startedAt,
      freshness: {
        ...base,
        lastAttemptAt: event.at,
        lastSuccessfulCheckAt: event.at,
        observedAt: event.at,
        lastContentChangeObservedAt: contentChanged ? event.at : base.lastContentChangeObservedAt,
      },
    });
    projections.bump(key);
    this.deps.announcer.announce(key);
  }

  private async publishScan(
    target: DiffStatsTarget,
    rawChanges: readonly unknown[],
    scan: { truncated: boolean; baseOid?: string; ambiguousPaths: string[] },
  ) {
    const identity = await this.deps.registry.resolve(
      target.kind === "local"
        ? { kind: "local", worktreePath: target.worktreePath! }
        : { kind: "container", containerId: target.containerId! },
    );
    const changes = rawChanges.filter(isGitFileChange);
    const reasons: string[] = [];
    if (scan.truncated) reasons.push("untracked-scan-capped");
    if (scan.ambiguousPaths.length > 0) reasons.push("ambiguous-index-membership");
    if (!scan.baseOid) reasons.push("baseline-mutable-ref");
    let additions: LineCount = exactCount(0);
    let deletions: LineCount = exactCount(0);
    const files: MeasurementFileRecord[] = changes.map((change) => {
      const counts = change.binary
        ? { additions: notApplicableCount(), deletions: notApplicableCount() }
        : change.countOmitted
          ? { additions: unknownCount(), deletions: unknownCount() }
          : { additions: exactCount(change.additions), deletions: exactCount(change.deletions) };
      additions = addLineCounts(additions, counts.additions);
      deletions = addLineCounts(deletions, counts.deletions);
      const status = statusOf(change.status);
      return {
        pathId: encodePath(new TextEncoder().encode(change.path)),
        oldPath: change.originalPath
          ? encodePath(new TextEncoder().encode(change.originalPath))
          : status === "added"
            ? null
            : encodePath(new TextEncoder().encode(change.path)),
        newPath: status === "deleted" ? null : encodePath(new TextEncoder().encode(change.path)),
        oldBlob: null,
        newBlob: null,
        oldMode: null,
        newMode: null,
        status,
        fileKind: change.binary ? "binary" : change.countOmitted ? "unknown" : "text",
        additions: counts.additions.value,
        additionsQuality: counts.additions.quality,
        deletions: counts.deletions.value,
        deletionsQuality: counts.deletions.quality,
        bodyState: "pending",
        reason: change.countOmitted
          ? "count-omitted"
          : scan.ambiguousPaths.includes(change.path)
            ? "ambiguous-index-membership"
            : null,
      };
    });
    if (changes.some((change) => change.countOmitted)) reasons.push("count-omitted");
    const partial = scan.ambiguousPaths.length > 0;
    const gitVersion = await installedGitVersion();
    const measurements = this.deps.measurements;
    const draft = {
      ...measurements.base({
        scope: "environment-net",
        owner: { environmentId: target.environmentId },
        worktreeId: identity?.worktreeId ?? `unresolved:${target.environmentId}`,
        worktreeIncarnation: identity?.incarnation ?? "unknown",
      }),
      baselineVersion: scan.baseOid
        ? `${target.comparisonRef}@${scan.baseOid}`
        : `ref:${target.comparisonRef}`,
      origin: "git-observation" as const,
      algorithmPolicyId: `${gitNumstatAlgorithmId(gitVersion)}+untracked-lines-v0`,
      representationPolicyId: GIT_REPRESENTATION_ID,
      effectClaim: "workspace-observed" as const,
      finality: "provisional" as const,
      boundary: { before: "not-applicable" as const, after: "running-observation" as const },
      attribution: {
        basis: "workspace-observation" as const,
        writerIsolation: "shared" as const,
        overlap: "unknown" as const,
      },
      completeness: {
        files: partial ? ("partial" as const) : ("complete" as const),
        reasons,
        omittedFileCount: partial ? null : 0,
      },
      totals: { additions, deletions, changedFiles: changes.length },
    };
    const owner = { kind: "environment", id: target.environmentId };
    const { measurement } = measurements.seal(draft, owner, null, undefined, files);
    return measurements.publish({
      measurement,
      owner,
      files,
      identity: null,
      resourceKey: environmentChangeResourceKey(target.environmentId),
    });
  }
}
