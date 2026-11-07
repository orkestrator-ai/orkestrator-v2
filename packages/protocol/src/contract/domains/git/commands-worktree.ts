/**
 * `git` commands of an environment's worktree (plan item 7006): diff-stat
 * snapshots, the Files panel's git status, the Changes tab's "Compare
 * against" base, and the build pipeline's uncommitted-path and ancestry
 * probes.
 *
 * Argument schemas declare every key the handler reads and decode tolerantly
 * (§11.4); the three diff-base commands and the two pipeline probes were
 * strict (`assertOnlyKeys`) and now drop unknown keys. A key the handler
 * required with `asString` is `Schema.String` (the same "Expected
 * environmentId to be a string" text); a key read leniently (`refresh ===
 * true`, `includeUncommitted !== false`, a digest compared for equality, a
 * limit with a fallback) or checked with its own message stays
 * `optionalKey(Unknown)`. Fields are listed in the order the handler checks
 * them, because a decode reports the first failure.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import { defineCommand } from "../../command.js";
import { ClientEnvironmentSchema } from "../environments/models.js";
import { gitDomain } from "./domain.js";
import {
  CommitAncestrySchema,
  DiffBaseBranchSchema,
  DiffBaseCommitSchema,
  EnvironmentDiffStatsReadSchema,
  GitStatusReadSchema,
  UncommittedPathsSchema,
} from "./schemas.js";

const optionalUnknown = Schema.optionalKey(Schema.Unknown);

/** Authoritative diff-stat snapshot of every tracked environment; arms tracking. */
export const getEnvironmentDiffStatsCommand = defineCommand({
  domain: gitDomain,
  name: "get_environment_diff_stats",
  since: 1,
  access: "workspace",
  read: true,
  // Checked together by `parseViewSnapshotRequest`: a malformed pair answers
  // a `reset`, never an error.
  args: Schema.Struct({ knownGeneration: optionalUnknown, knownRevision: optionalUnknown }),
  result: EnvironmentDiffStatsReadSchema,
  critical: [],
});

export const refreshEnvironmentDiffStatsCommand = defineCommand({
  domain: gitDomain,
  name: "refresh_environment_diff_stats",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ environmentId: Schema.String }),
  result: Schema.Void,
  critical: [],
});

/** A container's changed files against `targetBranch`. */
export const getGitStatusCommand = defineCommand({
  domain: gitDomain,
  name: "get_git_status",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    // Validated as a git ref name by the handler first.
    targetBranch: Schema.String,
    containerId: Schema.String,
    includeUncommitted: optionalUnknown,
    knownDigest: optionalUnknown,
    refresh: optionalUnknown,
  }),
  result: GitStatusReadSchema,
  critical: [],
});

/** A local worktree's changed files against `targetBranch`. */
export const getLocalGitStatusCommand = defineCommand({
  domain: gitDomain,
  name: "get_local_git_status",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    worktreePath: Schema.String,
    targetBranch: Schema.String,
    includeUncommitted: optionalUnknown,
    knownDigest: optionalUnknown,
    refresh: optionalUnknown,
  }),
  result: GitStatusReadSchema,
  critical: [],
});

export const listEnvironmentDiffBaseBranchesCommand = defineCommand({
  domain: gitDomain,
  name: "list_environment_diff_base_branches",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ environmentId: Schema.String }),
  result: Schema.mutable(Schema.Array(DiffBaseBranchSchema)),
  critical: [],
});

export const listEnvironmentDiffBaseCommitsCommand = defineCommand({
  domain: gitDomain,
  name: "list_environment_diff_base_commits",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    environmentId: Schema.String,
    // Read leniently: anything but a positive safe integer is the default.
    limit: optionalUnknown,
    ref: Schema.String,
  }),
  result: Schema.mutable(Schema.Array(DiffBaseCommitSchema)),
  critical: [],
});

/** `{ ref, commit }` sets the base; both `null` (or absent) clears it. */
export const setEnvironmentDiffBaseCommand = defineCommand({
  domain: gitDomain,
  name: "set_environment_diff_base",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Schema.String,
    // Validated together by `resolveDiffBaseOverride`, with its own text.
    ref: optionalUnknown,
    commit: optionalUnknown,
  }),
  result: ClientEnvironmentSchema,
  critical: [],
});

/** HEAD and the uncommitted paths of an environment (the build pipeline's guard). */
export const getEnvironmentUncommittedPathsCommand = defineCommand({
  domain: gitDomain,
  name: "get_environment_uncommitted_paths",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    environmentId: Schema.String,
    // `asRequiredBoolean` when present.
    fingerprint: optionalUnknown,
  }),
  result: UncommittedPathsSchema,
  critical: [],
});

/** Whether commit `ancestor` is `descendant` or one of its ancestors. */
export const getEnvironmentCommitAncestryCommand = defineCommand({
  domain: gitDomain,
  name: "get_environment_commit_ancestry",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    // Full commit ids, checked with the handler's own text.
    ancestor: Schema.String,
    descendant: Schema.String,
    environmentId: Schema.String,
  }),
  result: CommitAncestrySchema,
  critical: [],
});

export const WORKTREE_GIT_COMMANDS = [
  getEnvironmentDiffStatsCommand,
  refreshEnvironmentDiffStatsCommand,
  getGitStatusCommand,
  getLocalGitStatusCommand,
  listEnvironmentDiffBaseBranchesCommand,
  listEnvironmentDiffBaseCommitsCommand,
  setEnvironmentDiffBaseCommand,
  getEnvironmentUncommittedPathsCommand,
  getEnvironmentCommitAncestryCommand,
] as const;
