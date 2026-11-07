/**
 * `git` events: the change projection, diff stats and worktree snapshots.
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import { CHANGE_PROJECTION_CHANGED_EVENT } from "../../../change-resources.js";
import { DIFF_STATS_CHANGED_EVENT } from "../../../diff-stats.js";
import { WORKTREE_SNAPSHOT_CHANGED_EVENT } from "../../../worktree-snapshots.js";
import { defineEvent } from "../../event.js";
import { gitDomain } from "./domain.js";

/**
 * A change projection, its deletion or reset, or a content invalidation
 * (`ChangeProjectionEvent`, discriminated by `kind`).
 */
export const changeProjectionChangedEvent = defineEvent({
  domain: gitDomain,
  name: CHANGE_PROJECTION_CHANGED_EVENT,
  payload: Schema.Struct({
    kind: Schema.String,
    projection: Schema.optional(Schema.ObjectKeyword),
    resourceKey: Schema.optional(Schema.String),
    ownerGeneration: Schema.optional(Schema.String),
    revision: Schema.optional(Schema.Finite),
    contentGeneration: Schema.optional(Schema.Finite),
    pathIds: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  }),
});

/** An environment's diff counts, or their removal (`EnvironmentDiffStatsEvent`). */
export const environmentDiffStatsChangedEvent = defineEvent({
  domain: gitDomain,
  name: DIFF_STATS_CHANGED_EVENT,
  payload: Schema.Struct({
    environmentId: Schema.String,
    comparisonRef: Schema.String,
    computedAt: Schema.String,
    stats: Schema.optional(Schema.ObjectKeyword),
    removed: Schema.optional(Schema.Boolean),
    generation: Schema.optional(Schema.String),
    revision: Schema.optional(Schema.Finite),
  }),
});

/** An environment's worktree snapshot state, or its removal (`WorktreeSnapshotEvent`). */
export const worktreeSnapshotChangedEvent = defineEvent({
  domain: gitDomain,
  name: WORKTREE_SNAPSHOT_CHANGED_EVENT,
  payload: Schema.Struct({
    environmentId: Schema.String,
    removed: Schema.optional(Schema.Boolean),
    generation: Schema.optional(Schema.String),
    revision: Schema.optional(Schema.Finite),
  }),
});

export const GIT_EVENTS = [
  changeProjectionChangedEvent,
  environmentDiffStatsChangedEvent,
  worktreeSnapshotChangedEvent,
] as const;
