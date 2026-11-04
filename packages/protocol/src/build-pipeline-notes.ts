/**
 * A Build Pipeline's follow-ups: what a person still has to do or look at
 * once the pipeline has finished. The Notes step leads with them and the Ship
 * step lists them in the pull request.
 *
 * Everything here is a pure reading of the pipeline record, so no agent has to
 * remember to report it and a reload reads the same list.
 */
import {
  isSupersededPipelineSession,
  taskSnapshotCriteria,
  type BuildPipeline,
} from "./build-pipeline.js";

export const PIPELINE_FOLLOW_UP_KINDS = ["not-checked", "not-done", "open-issue", "test"] as const;
export type PipelineFollowUpKind = (typeof PIPELINE_FOLLOW_UP_KINDS)[number];

export interface PipelineFollowUp {
  kind: PipelineFollowUpKind;
  text: string;
  /** Why it is listed: what Verify could not establish, a test's result. */
  detail?: string;
}

/** Everything still outstanding, in the order a reader should take it. */
export function pipelineFollowUps(
  pipeline: Pick<BuildPipeline, "sessions" | "taskSnapshot" | "keyInformation">,
): PipelineFollowUp[] {
  const followUps: PipelineFollowUp[] = [];
  // Only the newest verdict counts: an earlier round's gap may have been closed.
  const verify = pipeline.sessions.findLast(
    (session) =>
      session.phase === "verify" &&
      !isSupersededPipelineSession(session) &&
      session.acceptanceCriteriaResults !== undefined,
  );
  if (verify?.acceptanceCriteriaResults) {
    const criteria = pipeline.taskSnapshot ? taskSnapshotCriteria(pipeline.taskSnapshot) : [];
    const textOf = new Map(criteria.map(({ id, text }) => [id, text]));
    for (const result of verify.acceptanceCriteriaResults) {
      if (result.status !== "not-checked") continue;
      followUps.push({
        kind: "not-checked",
        text: textOf.get(result.id) ?? result.id,
        ...(result.evidence ? { detail: result.evidence } : {}),
      });
    }
  }
  const info = pipeline.keyInformation;
  if (!info) return followUps;
  for (const item of info.notDone) followUps.push({ kind: "not-done", text: item });
  for (const issue of info.issues) {
    if (issue.status !== "open" && issue.status !== "partially-resolved") continue;
    followUps.push({
      kind: "open-issue",
      text: issue.issue,
      ...(issue.resolution ? { detail: issue.resolution } : {}),
    });
  }
  for (const test of info.tests) {
    if (test.result === "passed") continue;
    followUps.push({
      kind: "test",
      text: test.name,
      detail: test.details ? `${test.result}: ${test.details}` : test.result,
    });
  }
  return followUps;
}
