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
 * scan settles while someone has asked for them.
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
import {
  countLocalFileLinesDetailed,
  parseGitFileChanges,
  type GitFileChange,
} from "../commands-files.js";
import { gitDockerScanPool } from "../git-docker-scan-pool.js";
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
  /** Resources somebody asked for; refreshed when their environment's scan settles. */
  private readonly demanded = new Map<string, Set<string>>();
  private readonly running = new Map<string, Promise<void>>();

  constructor(
    private readonly deps: {
      measurements: ChangeMeasurementService;
      projections: ChangeProjectionService;
      registry: WorktreeRegistry;
      environmentTarget: (environmentId: string) => Promise<WorktreeTarget | null>;
      prBaseBranch?: (environmentId: string) => Promise<string | null>;
      announce: (resourceKey: string) => void;
    },
  ) {}

  /** Compute (or recompute) a Git scope resource. Never throws. */
  ensure(resourceKey: string): Promise<void> {
    const parts = parseChangeResourceKey(resourceKey);
    if (!parts || !isGitScope(parts.scope) || parts.ownerKind !== "environment")
      return Promise.resolve();
    const [environmentId, commit] = parts.ownerId.split("@");
    if (!environmentId) return Promise.resolve();
    let keys = this.demanded.get(environmentId);
    if (!keys) {
      keys = new Set();
      this.demanded.set(environmentId, keys);
    }
    keys.add(resourceKey);
    const pending = this.running.get(resourceKey);
    if (pending) return pending;
    const run = this.compute(parts.scope, environmentId, commit)
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
          unavailableReason:
            error instanceof Error &&
            (error.message === "commit-not-found" || error.message === "baseline-unavailable")
              ? error.message
              : "scan-failed",
        });
        this.deps.projections.bump(resourceKey);
        this.deps.announce(resourceKey);
      })
      .finally(() => this.running.delete(resourceKey));
    this.running.set(resourceKey, run);
    return run;
  }

  /** The environment's state moved: recompute every live Git scope someone asked for. */
  invalidate(environmentId: string): void {
    for (const key of this.demanded.get(environmentId) ?? []) {
      if (parseChangeResourceKey(key)?.selector === "live") void this.ensure(key);
    }
  }

  forget(environmentId: string): void {
    this.demanded.delete(environmentId);
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
    if (!target) throw new Error("runtime-unavailable");
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
            if (!base) throw new Error("baseline-unavailable");
            if (!head) throw new Error("head-unavailable");
            before = base;
            after = head;
            mode = "trees";
            baselineVersion = committedBaselineVersion(head, base);
            break;
          }
          case "commit": {
            const sha = commit ? await this.resolve(git, commit) : null;
            if (!sha) throw new Error("commit-not-found");
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
            if (!base || !head) throw new Error("pull-request-base-unavailable");
            const mergeBase = (await git(["merge-base", base, head]).catch(() => "")).trim();
            if (!OID.test(mergeBase)) throw new Error("pull-request-base-unavailable");
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
        const diff = (format: string) =>
          git(
            [
              ...filters.neutralize,
              "diff",
              "--no-ext-diff",
              "--no-textconv",
              format,
              "-z",
              "-M",
            ].concat(range),
          );
        const [nameStatus, numstat] = await Promise.all([diff("--name-status"), diff("--numstat")]);
        const changes: GitFileChange[] = parseGitFileChanges(nameStatus, numstat);
        if (scope === "unstaged" || scope === "uncommitted-net") {
          const untracked = (await git(["ls-files", "-z", "--others", "--exclude-standard"]))
            .split("\0")
            .filter(Boolean);
          const listed = new Set(changes.map((change) => change.path));
          for (const path of untracked.slice(0, 2_000)) {
            if (listed.has(path)) {
              reasons.push("ambiguous-index-membership");
              continue;
            }
            const counted =
              target.kind === "local"
                ? await countLocalFileLinesDetailed(target.worktreePath, path).catch(() => null)
                : null;
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
          }
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
    const { measurement } = measurements.seal(draft, owner, null, undefined, files);
    measurements.publish({
      measurement,
      owner,
      files,
      identity: null,
      resourceKey: input.resourceKey,
    });
  }
}
