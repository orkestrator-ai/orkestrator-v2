/**
 * Git source-control scopes: `uncommitted-net`, `committed-net`, `staged`,
 * `unstaged`, `commit` and `pull-request`.
 *
 * `committed-net` is the environment's base commit to `HEAD`: what its
 * commits changed, without the working tree. Its base is the one the
 * environment's own measurement (`environment-net`) compares against, so it
 * and `uncommitted-net` split that measurement at `HEAD`.
 *
 * Each answers its own question with Git semantics and is never derived by
 * adding another scope's numbers: staged + unstaged is not uncommitted-net.
 * Endpoints are resolved to immutable object ids before measuring (HEAD, the
 * commit and its first parent, the pull request's merge base), and an unborn
 * HEAD compares against the empty tree. Results are computed on demand,
 * through the shared admission pool, and recomputed when the environment's
 * scan settles while someone has read them recently.
 *
 * Views read a resource once and then follow its events, so a read says nothing
 * about how long a view stays open. Demand therefore lasts
 * `gitScopeDemandTtlMs` from the last read. The first scan after that does not
 * recompute: it marks the resource stale and sends a `reset` event. A view still
 * open reads again, which recomputes it and renews the demand; with no view open
 * nothing answers, so no later scan pays for the scope. Every read recomputes,
 * so a view opened after expiry never shows the old answer as current.
 */

import {
  addLineCounts,
  exactCount,
  notApplicableCount,
  partialCount,
  unknownCount,
  type LineCount,
  type MeasurementScope,
} from "@orkestrator/protocol/change-measurements";
import {
  changeResourceKey,
  environmentChangeResourceKey,
  parseChangeResourceKey,
} from "@orkestrator/protocol/change-resources";
import {
  GIT_REPRESENTATION_ID,
  gitNumstatAlgorithmId,
} from "@orkestrator/protocol/node/change-tracking/count-policy";
import { mapWithConcurrency, parseGitDiffSummary, type GitFileChange } from "../commands-files.js";
import { CaptureError, captureErrorReason, type CaptureErrorReason } from "./capture-error.js";
import { UNTRACKED_SCAN_CONCURRENCY } from "../commands-validation.js";
import { gitDockerScanPool } from "../git-docker-scan-pool.js";
import { countUntrackedFileLines } from "../local-git-scan-caches.js";
import { runCommandBuffer } from "../shell.js";
import { encodePath, SAFE_GIT_CONFIG } from "./capture.js";
import type { MeasurementFileRecord } from "./change-ledger.js";
import { installedGitVersion } from "./environment-projector.js";
import type { ChangeMeasurementService } from "./measurement-service.js";
import type { ChangeProjectionService } from "./projection-service.js";
import type { WorktreeRegistry, WorktreeTarget } from "./worktree-owner.js";

export const GIT_SCOPES = [
  "uncommitted-net",
  "committed-net",
  "staged",
  "unstaged",
  "commit",
  "pull-request",
] as const;
export type GitScope = (typeof GIT_SCOPES)[number];

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const OID = /^[0-9a-f]{40,64}$/;

export function gitScopeResourceKey(
  scope: GitScope,
  environmentId: string,
  commit?: string,
): string {
  return scope === "commit"
    ? changeResourceKey({
        scope,
        ownerKind: "environment",
        ownerId: `${environmentId}@${commit}`,
        selector: "pinned",
      })
    : changeResourceKey({
        scope,
        ownerKind: "environment",
        ownerId: environmentId,
        selector: "live",
      });
}

export function isGitScope(scope: MeasurementScope): scope is GitScope {
  return (GIT_SCOPES as readonly string[]).includes(scope);
}

type GitRunner = (args: string[]) => Promise<string>;

/**
 * `committed-net`'s baseline version: `committed:<head>@<base>`. The part
 * after `@` is the before side, as for every scope; the head is the after side.
 */
export function committedBaselineVersion(head: string, base: string): string {
  return `committed:${head}@${base}`;
}

/** The after-side commit of a `committed-net` baseline version, or null. */
export function committedHead(baselineVersion: string | null | undefined): string | null {
  const match = /^committed:([0-9a-f]{40,64})@[0-9a-f]{40,64}$/.exec(baselineVersion ?? "");
  return match?.[1] ?? null;
}

/**
 * Filter drivers (clean/smudge/process) configured in any scope. Reading
 * configuration runs nothing; `neutralize` blanks every driver so a Git scope
 * never executes a repository-configured program.
 */
async function configuredFilterDrivers(
  git: GitRunner,
): Promise<{ names: Set<string>; neutralize: string[] }> {
  const output = await git(["config", "-z", "--get-regexp", "^filter\\."]).catch(() => "");
  const names = new Set<string>();
  for (const record of output.split("\0")) {
    const match = /^filter\.(.+)\.(clean|smudge|process)$/.exec(record.split("\n", 1)[0] ?? "");
    if (match?.[1]) names.add(match[1]);
  }
  const neutralize = [...names].flatMap((name) =>
    ["clean=", "smudge=", "process=", "required=false"].flatMap((setting) => [
      "-c",
      `filter.${name}.${setting}`,
    ]),
  );
  return { names, neutralize };
}

/** Paths whose `filter` attribute names a configured external driver. */
async function filteredPaths(
  git: GitRunner,
  drivers: ReadonlySet<string>,
  paths: readonly string[],
): Promise<Set<string>> {
  const filtered = new Set<string>();
  if (drivers.size === 0) return filtered;
  for (let offset = 0; offset < paths.length; offset += 200) {
    const fields = (
      await git(["check-attr", "-z", "filter", "--", ...paths.slice(offset, offset + 200)])
    ).split("\0");
    for (let index = 0; index + 2 < fields.length; index += 3) {
      if (drivers.has(fields[index + 2]!)) filtered.add(fields[index]!);
    }
  }
  return filtered;
}

/** A failed scan's `unavailableReason`: the two reasons a view explains, else `scan-failed`. */
export function scopeUnavailableReason(reason: CaptureErrorReason | undefined): string {
  return reason === "commit-not-found" || reason === "baseline-unavailable"
    ? reason
    : "scan-failed";
}

function statusOf(code: string): string {
  switch (code[0]) {
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

export class GitScopeService {
  /**
   * Live resources somebody read, by environment, with when they last did;
   * refreshed when their environment's scan settles until the demand expires.
   */
  private readonly demanded = new Map<string, Map<string, number>>();
  private readonly running = new Map<string, Promise<void>>();
  /** Asked for while running, so the answer may predate the request: run once more. */
  private readonly rerun = new Set<string>();
  private stopped = false;

  constructor(
    private readonly deps: {
      measurements: ChangeMeasurementService;
      projections: ChangeProjectionService;
      registry: WorktreeRegistry;
      environmentTarget: (environmentId: string) => Promise<WorktreeTarget | null>;
      prBaseBranch?: (environmentId: string) => Promise<string | null>;
      announce: (resourceKey: string) => void;
      /** Tell whoever shows the resource to read it again. */
      resetView: (resourceKey: string) => void;
      demandTtlMs: () => number;
    },
  ) {}

  /** A read of a Git scope resource: compute it now and renew its demand. Never throws. */
  ensure(resourceKey: string): Promise<void> {
    const parts = parseChangeResourceKey(resourceKey);
    if (!parts || !isGitScope(parts.scope) || parts.ownerKind !== "environment")
      return Promise.resolve();
    const [environmentId, commit] = parts.ownerId.split("@");
    if (!environmentId) return Promise.resolve();
    // A pinned resource never changes, so a scan has nothing to refresh.
    if (parts.selector === "live") {
      let keys = this.demanded.get(environmentId);
      if (!keys) {
        keys = new Map();
        this.demanded.set(environmentId, keys);
      }
      keys.set(resourceKey, Date.now());
    }
    return this.recompute(resourceKey, parts.scope, environmentId, commit);
  }

  private recompute(
    resourceKey: string,
    scope: GitScope,
    environmentId: string,
    commit: string | undefined,
  ): Promise<void> {
    const pending = this.running.get(resourceKey);
    if (pending) {
      this.rerun.add(resourceKey);
      return pending;
    }
    const run = this.compute(scope, environmentId, commit)
      .catch((error) => {
        this.deps.projections.setFreshness(resourceKey, {
          observationState: "degraded",
          freshness: {
            lastAttemptAt: new Date().toISOString(),
            lastSuccessfulCheckAt: null,
            lastContentChangeObservedAt: null,
            observedAt: null,
            requiredObservationEpoch: null,
            checkedObservationEpoch: null,
          },
          stale: true,
          unavailableReason: scopeUnavailableReason(captureErrorReason(error)),
        });
        this.deps.projections.bump(resourceKey);
        this.deps.announce(resourceKey);
      })
      .finally(() => {
        this.running.delete(resourceKey);
        if (!this.rerun.delete(resourceKey) || this.stopped) return;
        // Whoever joined this run waits for the one that covers their request.
        if (this.demanded.get(environmentId)?.has(resourceKey)) {
          return this.recompute(resourceKey, scope, environmentId, commit);
        }
      });
    this.running.set(resourceKey, run);
    return run;
  }

  /**
   * The environment's state moved: recompute every live Git scope read within
   * its demand window, and retire the rest (see the file comment).
   */
  invalidate(environmentId: string): void {
    const keys = this.demanded.get(environmentId);
    if (!keys) return;
    const ttlMs = this.deps.demandTtlMs();
    const now = Date.now();
    for (const [key, lastReadAt] of Array.from(keys)) {
      if (now - lastReadAt < ttlMs) {
        const parts = parseChangeResourceKey(key);
        if (parts && isGitScope(parts.scope)) {
          void this.recompute(key, parts.scope, environmentId, undefined);
        }
        continue;
      }
      keys.delete(key);
      const freshness = this.deps.projections.getFreshness(key);
      if (freshness) this.deps.projections.setFreshness(key, { ...freshness, stale: true });
      this.deps.resetView(key);
    }
    if (keys.size === 0) this.demanded.delete(environmentId);
  }

  forget(environmentId: string): void {
    this.demanded.delete(environmentId);
  }

  /** No further recompute starts on its own after this. */
  stop(): void {
    this.stopped = true;
  }

  /** Settles when no recompute is running. */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.all(this.running.values());
  }

  private async runner(target: WorktreeTarget): Promise<GitRunner> {
    return async (args) => {
      const result =
        target.kind === "local"
          ? await runCommandBuffer(
              "git",
              [...SAFE_GIT_CONFIG, "-C", target.worktreePath, ...args],
              {
                timeoutMs: 60_000,
                env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
              },
            )
          : await runCommandBuffer(
              "docker",
              [
                "exec",
                "-e",
                "GIT_OPTIONAL_LOCKS=0",
                target.containerId,
                "git",
                ...SAFE_GIT_CONFIG,
                "-C",
                target.root ?? "/workspace",
                ...args,
              ],
              { timeoutMs: 60_000 },
            );
      return result.stdout.toString("utf8");
    };
  }

  /** The immutable commit the environment's own measurement compares against, if any. */
  private environmentBase(environmentId: string): string | null {
    const version = this.deps.projections.selectedMeasurement(
      environmentChangeResourceKey(environmentId),
    )?.baselineVersion;
    const oid = version?.slice(version.lastIndexOf("@") + 1);
    return oid && version?.includes("@") && OID.test(oid) ? oid : null;
  }

  private async resolve(git: GitRunner, ref: string): Promise<string | null> {
    const value = (
      await git(["rev-parse", "--verify", "-q", `${ref}^{commit}`]).catch(() => "")
    ).trim();
    return OID.test(value) ? value : null;
  }

  private async compute(
    scope: GitScope,
    environmentId: string,
    commit: string | undefined,
  ): Promise<void> {
    const target = await this.deps.environmentTarget(environmentId);
    if (!target) throw new CaptureError("runtime-unavailable");
    const identity = await this.deps.registry.resolve(target);
    const git = await this.runner(target);
    const resourceKey = gitScopeResourceKey(scope, environmentId, commit);
    const startedAt = new Date().toISOString();
    await gitDockerScanPool.run(
      { kind: "diff-scan", priority: "interactive", target: `git-scope:${environmentId}` },
      async () => {
        const head = await this.resolve(git, "HEAD");
        let before: string;
        let after: string | null; // null: the working tree or index
        let mode: "cached" | "worktree" | "trees";
        let baselineVersion: string;
        const reasons: string[] = [];
        switch (scope) {
          case "staged":
            before = head ?? EMPTY_TREE;
            after = null;
            mode = "cached";
            baselineVersion = `HEAD@${before}`;
            if (!head) reasons.push("unborn-head");
            break;
          case "unstaged":
            before = "index";
            after = null;
            mode = "worktree";
            baselineVersion = "index";
            break;
          case "uncommitted-net":
            before = head ?? EMPTY_TREE;
            after = null;
            mode = "worktree";
            baselineVersion = `HEAD@${before}`;
            if (!head) reasons.push("unborn-head");
            break;
          case "committed-net": {
            const base = this.environmentBase(environmentId);
            if (!base) throw new CaptureError("baseline-unavailable");
            if (!head) throw new CaptureError("head-unavailable");
            before = base;
            after = head;
            mode = "trees";
            baselineVersion = committedBaselineVersion(head, base);
            break;
          }
          case "commit": {
            const sha = commit ? await this.resolve(git, commit) : null;
            if (!sha) throw new CaptureError("commit-not-found");
            before = (await this.resolve(git, `${sha}^1`)) ?? EMPTY_TREE;
            after = sha;
            mode = "trees";
            baselineVersion = `commit:${sha}^1@${before}`;
            break;
          }
          case "pull-request": {
            const branch = (await this.deps.prBaseBranch?.(environmentId)) ?? null;
            const base = branch
              ? ((await this.resolve(git, `origin/${branch}`)) ?? (await this.resolve(git, branch)))
              : null;
            if (!base || !head) throw new CaptureError("pull-request-base-unavailable");
            const mergeBase = (await git(["merge-base", base, head]).catch(() => "")).trim();
            if (!OID.test(mergeBase)) throw new CaptureError("pull-request-base-unavailable");
            before = mergeBase;
            after = head;
            mode = "trees";
            baselineVersion = `pr:${branch}@${mergeBase}`;
            // The forge's own base/head may differ; this is the local policy.
            reasons.push("local-pull-request-policy");
            break;
          }
        }
        const range =
          mode === "cached"
            ? ["--cached", before]
            : mode === "worktree"
              ? before === "index"
                ? []
                : [before]
              : [before, after!];
        // A clean/smudge/process filter is an external program: it never runs,
        // and worktree bytes it would transform are reported, not miscounted.
        const filters = await configuredFilterDrivers(git);
        const changes: GitFileChange[] = parseGitDiffSummary(
          await git(
            [
              ...filters.neutralize,
              "diff",
              "--no-ext-diff",
              "--no-textconv",
              "--raw",
              "--numstat",
              "-z",
              "-M",
            ].concat(range),
          ),
        ).changes;
        if (scope === "unstaged" || scope === "uncommitted-net") {
          const untracked = (await git(["ls-files", "-z", "--others", "--exclude-standard"]))
            .split("\0")
            .filter(Boolean);
          const listed = new Set(changes.map((change) => change.path));
          const scanned = untracked.slice(0, 2_000);
          if (scanned.some((path) => listed.has(path))) reasons.push("ambiguous-index-membership");
          const unlisted = scanned.filter((path) => !listed.has(path));
          const counts = await mapWithConcurrency(
            unlisted,
            UNTRACKED_SCAN_CONCURRENCY,
            async (path) =>
              target.kind === "local"
                ? await countUntrackedFileLines(target.worktreePath, path).catch(() => null)
                : null,
          );
          unlisted.forEach((path, index) => {
            const counted = counts[index];
            changes.push({
              path,
              filename: path,
              directory: "",
              additions: counted?.kind === "text" ? counted.lines : 0,
              deletions: 0,
              status: "?",
              ...(counted?.kind === "binary" ? { binary: true as const } : {}),
              ...(!counted || (counted.kind !== "text" && counted.kind !== "binary")
                ? { countOmitted: true as const }
                : {}),
            });
          });
          if (untracked.length > 2_000) reasons.push("untracked-scan-capped");
        }
        const filtered =
          mode === "worktree"
            ? await filteredPaths(
                git,
                filters.names,
                changes.map((change) => change.path),
              )
            : new Set<string>();
        if (filtered.size > 0) reasons.push("git-filter-unsupported");
        await this.publish({
          scope,
          environmentId,
          resourceKey,
          identity,
          changes,
          filtered,
          baselineVersion,
          reasons,
          finality: mode === "trees" ? "final" : "provisional",
        });
      },
    );
    this.deps.projections.setFreshness(resourceKey, {
      observationState: "fresh",
      checkStartedAt: startedAt,
      freshness: {
        lastAttemptAt: startedAt,
        lastSuccessfulCheckAt: new Date().toISOString(),
        lastContentChangeObservedAt: null,
        observedAt: new Date().toISOString(),
        requiredObservationEpoch: null,
        checkedObservationEpoch: null,
      },
    });
    this.deps.projections.bump(resourceKey);
    this.deps.announce(resourceKey);
  }

  private async publish(input: {
    scope: GitScope;
    environmentId: string;
    resourceKey: string;
    identity: { worktreeId: string; incarnation: string } | null;
    changes: GitFileChange[];
    /** Paths whose Git representation needs an external filter. */
    filtered: ReadonlySet<string>;
    baselineVersion: string;
    reasons: string[];
    finality: "final" | "provisional";
  }): Promise<void> {
    let additions: LineCount = exactCount(0);
    let deletions: LineCount = exactCount(0);
    const files: MeasurementFileRecord[] = input.changes.map((change) => {
      const filtered = input.filtered.has(change.path);
      const counts = filtered
        ? { additions: unknownCount(), deletions: unknownCount() }
        : change.binary
          ? { additions: notApplicableCount(), deletions: notApplicableCount() }
          : change.countOmitted
            ? { additions: unknownCount(), deletions: unknownCount() }
            : { additions: exactCount(change.additions), deletions: exactCount(change.deletions) };
      additions = addLineCounts(additions, counts.additions);
      deletions = addLineCounts(deletions, counts.deletions);
      const status = statusOf(change.status);
      const pathId = encodePath(new TextEncoder().encode(change.path));
      return {
        pathId,
        oldPath: change.originalPath
          ? encodePath(new TextEncoder().encode(change.originalPath))
          : status === "added"
            ? null
            : pathId,
        newPath: status === "deleted" ? null : pathId,
        oldBlob: null,
        newBlob: null,
        oldMode: null,
        newMode: null,
        status,
        fileKind: filtered
          ? "unknown"
          : change.binary
            ? "binary"
            : change.countOmitted
              ? "unknown"
              : "text",
        additions: counts.additions.value,
        additionsQuality: counts.additions.quality,
        deletions: counts.deletions.value,
        deletionsQuality: counts.deletions.quality,
        bodyState: "not-retained",
        reason: filtered ? "git-filter-unsupported" : change.countOmitted ? "count-omitted" : null,
      };
    });
    if (input.changes.some((change) => change.countOmitted)) input.reasons.push("count-omitted");
    const capped = input.reasons.includes("untracked-scan-capped");
    const partial =
      capped || input.reasons.includes("ambiguous-index-membership") || input.filtered.size > 0;
    if (capped) {
      if (additions.value !== null) additions = partialCount(additions.value);
      if (deletions.value !== null) deletions = partialCount(deletions.value);
    }
    const measurements = this.deps.measurements;
    const draft = {
      ...measurements.base({
        scope: input.scope,
        owner: { environmentId: input.environmentId },
        worktreeId: input.identity?.worktreeId ?? `unresolved:${input.environmentId}`,
        worktreeIncarnation: input.identity?.incarnation ?? "unknown",
      }),
      baselineVersion: input.baselineVersion,
      origin: "git-observation" as const,
      algorithmPolicyId: gitNumstatAlgorithmId(await installedGitVersion()),
      representationPolicyId: GIT_REPRESENTATION_ID,
      effectClaim: "workspace-observed" as const,
      finality: input.finality,
      boundary: {
        before: "not-applicable" as const,
        after:
          input.finality === "final"
            ? ("not-applicable" as const)
            : ("running-observation" as const),
      },
      attribution: {
        basis: "workspace-observation" as const,
        writerIsolation: "shared" as const,
        overlap: "unknown" as const,
      },
      completeness: {
        files: partial ? ("partial" as const) : ("complete" as const),
        reasons: [...new Set(input.reasons)].sort(),
        omittedFileCount: partial ? null : 0,
      },
      totals: { additions, deletions, changedFiles: input.changes.length },
    };
    const owner = { kind: `git-${input.scope}`, id: input.resourceKey };
    const cappedRows = measurements.capFileRows(draft, files);
    const { measurement } = measurements.seal(cappedRows.draft, owner, null, undefined, files);
    measurements.publish({
      measurement,
      owner,
      files: cappedRows.rows,
      identity: null,
      resourceKey: input.resourceKey,
    });
  }
}
