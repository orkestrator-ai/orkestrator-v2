/**
 * `pull-requests` commands of an environment's pull request (plan item
 * 7006): detection and verification, the merge paths, the backend PR
 * monitor, auto-merge, the post-agent-turn recheck, and the build
 * pipeline's review packages.
 *
 * Argument schemas declare every key the handler reads and decode tolerantly
 * (§11.4); `generate_review_package`, `verify_review_package`,
 * `set_environment_auto_merge`, the recheck arm/disarm and
 * `pr_monitor_probe_environment` were strict (`assertOnlyKeys` on the
 * arguments) and now drop unknown keys. The review package's nested
 * `preparation` stays strict (a value whose unknown parts the handler
 * refuses). A key the handler required with `asString` is `Schema.String`
 * (same text); a key read leniently (a merge method that defaults to
 * squash, `deleteBranch` that defaults to `true`) or checked with its own
 * message stays `optionalKey(Unknown)`.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import { defineCommand } from "../../command.js";
import { ClientEnvironmentSchema } from "../environments/models.js";
import { pullRequestsDomain } from "./domain.js";
import {
  MergeEnvironmentPrResultSchema,
  MergePrResultSchema,
  PrDetectionSchema,
  PrMonitorReadSchema,
  PrRefreshArmSchema,
  ReviewPackageReferenceSchema,
  ReviewPackageVerificationSchema,
} from "./schemas.js";

const optionalUnknown = Schema.optionalKey(Schema.Unknown);

// --- Detection and verification -----------------------------------------------

/** The PR of a local environment's branch (a project home follows its own checkout). */
export const detectPrLocalCommand = defineCommand({
  domain: pullRequestsDomain,
  name: "detect_pr_local",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Schema.String,
    // Not read for a project home; otherwise a non-blank branch.
    branch: optionalUnknown,
  }),
  result: PrDetectionSchema,
  critical: [],
});

/** The PR of a container's branch. */
export const detectPrCommand = defineCommand({
  domain: pullRequestsDomain,
  name: "detect_pr",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ containerId: Schema.String, branch: Schema.String }),
  result: PrDetectionSchema,
  critical: [],
});

// --- Merge ----------------------------------------------------------------------

/** `squash` (absent, `null` or empty), `merge` or `rebase`; anything else is refused by the handler. */
const mergeMethod = optionalUnknown;
/** Read leniently; anything but a boolean is `true`. */
const deleteBranch = optionalUnknown;

export const mergePrLocalCommand = defineCommand({
  domain: pullRequestsDomain,
  name: "merge_pr_local",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ environmentId: Schema.String, method: mergeMethod, deleteBranch }),
  result: MergePrResultSchema,
  // Ignored, the merge squashes and deletes the branch (both defaults).
  critical: ["method", "deleteBranch"],
});

export const mergePrCommand = defineCommand({
  domain: pullRequestsDomain,
  name: "merge_pr",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ containerId: Schema.String, method: mergeMethod, deleteBranch }),
  result: MergePrResultSchema,
  critical: ["method", "deleteBranch"],
});

/** The backend-owned merge of an environment's PR, with an optional cleanup afterwards. */
export const mergeEnvironmentPrCommand = defineCommand({
  domain: pullRequestsDomain,
  name: "merge_environment_pr",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Schema.String,
    // A full commit SHA, checked with the handler's own text.
    expectedHeadSha: optionalUnknown,
    cleanupAfterMerge: optionalUnknown,
    expectedPrUrl: optionalUnknown,
    deleteBranch,
    // Compared with the stored value as sent.
    autoMergeEnabledAt: optionalUnknown,
    method: mergeMethod,
  }),
  result: MergeEnvironmentPrResultSchema,
  // `expectedHeadSha`, `expectedPrUrl`, `autoMergeEnabledAt`: compare-and-swap
  // guards; ignored, a newer head, another PR or withdrawn options merge.
  // `method`, `deleteBranch`: ignored, the merge squashes and deletes the branch.
  critical: ["expectedHeadSha", "expectedPrUrl", "autoMergeEnabledAt", "method", "deleteBranch"],
});

// --- PR monitor ------------------------------------------------------------------

/** Authoritative PR-monitor snapshot; arms monitoring on a freshly started backend. */
export const getPrMonitorStateCommand = defineCommand({
  domain: pullRequestsDomain,
  name: "get_pr_monitor_state",
  since: 1,
  access: "workspace",
  read: true,
  // Checked together by `parseViewSnapshotRequest`: a malformed pair answers
  // a `reset`, never an error.
  args: Schema.Struct({ knownGeneration: optionalUnknown, knownRevision: optionalUnknown }),
  result: PrMonitorReadSchema,
  critical: [],
});

/** Poll an environment faster (`create-pending`, `merge-pending`) until the outcome shows. */
export const prMonitorWatchCommand = defineCommand({
  domain: pullRequestsDomain,
  name: "pr_monitor_watch",
  since: 1,
  access: "workspace",
  read: false,
  // `mode` is checked against the monitor's modes with the handler's own text.
  args: Schema.Struct({ environmentId: Schema.String, mode: Schema.String }),
  result: Schema.Void,
  critical: [],
});

/** Turns auto-merge on or off; every call restates `cleanupAfterMerge`. */
export const setEnvironmentAutoMergeCommand = defineCommand({
  domain: pullRequestsDomain,
  name: "set_environment_auto_merge",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Schema.String,
    enabled: Schema.Boolean,
    cleanupAfterMerge: optionalUnknown,
  }),
  result: ClientEnvironmentSchema,
  critical: [],
});

/** Durably arm the next completed agent turn to re-check a conflicting PR. */
export const armPrRefreshAfterAgentCompletionCommand = defineCommand({
  domain: pullRequestsDomain,
  name: "arm_pr_refresh_after_agent_completion",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ environmentId: Schema.String }),
  result: PrRefreshArmSchema,
  critical: [],
});

/** Rolls back one exact arm (`armedAt`) when its agent launch failed. */
export const disarmPrRefreshAfterAgentCompletionCommand = defineCommand({
  domain: pullRequestsDomain,
  name: "disarm_pr_refresh_after_agent_completion",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ environmentId: Schema.String, armedAt: Schema.String }),
  result: Schema.Void,
  critical: [],
});

/** The completion edge from native, tmux or terminal supervision. Backend-internal. */
export const prMonitorAgentTurnCompletedCommand = defineCommand({
  domain: pullRequestsDomain,
  name: "pr_monitor_agent_turn_completed",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({ environmentId: Schema.String }),
  result: Schema.Void,
  critical: [],
});

/** One-shot PR discovery on an agent's working-to-idle edge. Backend-internal. */
export const prMonitorProbeEnvironmentCommand = defineCommand({
  domain: pullRequestsDomain,
  name: "pr_monitor_probe_environment",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({ environmentId: Schema.String }),
  result: Schema.Void,
  critical: [],
});

// --- Review packages ---------------------------------------------------------------

/** Writes the build pipeline's review package for one round and returns its reference. */
export const generateReviewPackageCommand = defineCommand({
  domain: pullRequestsDomain,
  name: "generate_review_package",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    // Checked by the handler in this order, with its own text.
    packageId: optionalUnknown,
    preparation: optionalUnknown,
    additionalLimitations: optionalUnknown,
    environmentId: Schema.String,
    round: optionalUnknown,
    targetBranch: Schema.String,
    validationPlan: optionalUnknown,
    expectedHead: optionalUnknown,
  }),
  result: ReviewPackageReferenceSchema,
  // `expectedHead`: ignored, a package of a newer head is reviewed as this one.
  // `validationPlan`, `additionalLimitations`: ignored, the package drops what
  // the reviewers were told to check and what they were told it cannot show.
  critical: ["expectedHead", "validationPlan", "additionalLimitations"],
});

export const verifyReviewPackageCommand = defineCommand({
  domain: pullRequestsDomain,
  name: "verify_review_package",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Schema.String,
    // A `ReviewPackageReference`, checked with the handler's own text.
    reviewPackage: optionalUnknown,
  }),
  result: ReviewPackageVerificationSchema,
  critical: [],
});

export const ENVIRONMENT_PR_COMMANDS = [
  detectPrLocalCommand,
  detectPrCommand,
  mergePrLocalCommand,
  mergePrCommand,
  mergeEnvironmentPrCommand,
  getPrMonitorStateCommand,
  prMonitorWatchCommand,
  setEnvironmentAutoMergeCommand,
  armPrRefreshAfterAgentCompletionCommand,
  disarmPrRefreshAfterAgentCompletionCommand,
  prMonitorAgentTurnCompletedCommand,
  prMonitorProbeEnvironmentCommand,
  generateReviewPackageCommand,
  verifyReviewPackageCommand,
] as const;
