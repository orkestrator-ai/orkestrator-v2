/**
 * "Rewind code to here": resets a build pipeline's worktree to the commit a
 * step started from, then restarts the pipeline from that step.
 *
 * A plain restart keeps the code. This is the separate, explicit action: the
 * renderer first reads a preview naming every commit the reset drops, and the
 * confirmed request carries the HEAD that preview saw, so a branch that moved
 * in between is refused rather than reset blind.
 *
 * Safety rules, all enforced here rather than in the renderer:
 * - the pipeline must not be running a step (pause it first), so no agent or
 *   validation command writes to the worktree during the reset;
 * - the worktree must have no uncommitted changes, because a hard reset would
 *   destroy them and nothing could bring them back;
 * - the target must be an ancestor of HEAD;
 * - the old tip is kept at a ref under `refs/orkestrator/`, so the dropped
 *   commits stay recoverable;
 * - when the upstream branch already has commits the reset drops, the next
 *   Ship is told to force-push with lease instead of a plain push.
 *
 * The Git inspection and reset live in `workspace-code-rewind.ts`, shared
 * with graph runs' code rewinds (item 210); this module keeps the
 * pipeline's rules.
 */
import {
  isActiveBuildPhase,
  isSupersededPipelineSession,
  type BuildPipeline,
  type PipelineCodeRewind,
  type PipelineSession,
} from "@orkestrator/protocol/build-pipeline";
import { codeRewindRefComponent, type CodeRewindInspection } from "./workspace-code-rewind.js";

// The Git side is shared with graph runs' code rewinds (item 210).
export {
  inspectCodeRewind,
  resetWorktreeToCommit,
  type CodeRewindInspection,
  type EnvironmentGit,
} from "./workspace-code-rewind.js";

/**
 * Why the pipeline's state forbids a code rewind to `session` right now, or
 * undefined when it allows one. The worktree itself is checked separately.
 */
export function codeRewindStateBlocker(
  pipeline: Pick<BuildPipeline, "phase" | "validationRun" | "sessions">,
  session: Pick<PipelineSession, "headAtStart">,
): string | undefined {
  if (!session.headAtStart) {
    return "This step's starting commit was not recorded, so its code cannot be rewound.";
  }
  if (isActiveBuildPhase(pipeline.phase)) {
    return "Pause the pipeline first: a running step could write to the worktree during the reset.";
  }
  if (pipeline.sessions.some((entry) => entry.status === "running")) {
    return "Stopping every agent must be confirmed before rewinding code.";
  }
  if (
    pipeline.validationRun &&
    (pipeline.validationRun.status === "planned" || pipeline.validationRun.status === "running")
  ) {
    return "Validation checks are still running. Pause the pipeline first.";
  }
  return undefined;
}

/** The ref that keeps the pre-rewind tip reachable. */
export function codeRewindBackupRef(pipelineId: string, rewindId: string): string {
  const component = (value: string) => codeRewindRefComponent(value, "pipeline");
  return `refs/orkestrator/build-pipeline-rewinds/${component(pipelineId)}/${component(rewindId)}`;
}

/**
 * The upstream a Ship must force-push to, when the newest code rewind dropped
 * commits the upstream already had and no live Ship has completed since.
 */
export function forcePushUpstream(
  pipeline: Pick<BuildPipeline, "rewinds" | "sessions">,
): string | undefined {
  const rewind = (pipeline.rewinds ?? []).findLast((entry) => entry.code !== undefined);
  const code = rewind?.code;
  if (!rewind || !code?.upstream || !code.upstreamCommitsDropped) return undefined;
  const shippedSince = pipeline.sessions.some(
    (session) =>
      session.phase === "pr" &&
      !isSupersededPipelineSession(session) &&
      session.status === "idle" &&
      session.skipped !== true &&
      Date.parse(session.startedAt) >= Date.parse(rewind.at),
  );
  return shippedSince ? undefined : code.upstream;
}

/** Builds reset metadata to journal before changing Git. */
export function codeRewindRecord(
  reset: { from: string; to: string; backupRef: string },
  inspection: CodeRewindInspection,
): PipelineCodeRewind {
  return {
    from: reset.from,
    to: reset.to,
    droppedCommits: inspection.commitCount,
    backupRef: reset.backupRef,
    ...(inspection.upstream
      ? {
          upstream: inspection.upstream.ref,
          upstreamCommitsDropped: inspection.upstream.droppedCommits,
        }
      : {}),
  };
}
