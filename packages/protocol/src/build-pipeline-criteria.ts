/**
 * Which Verify run a pipeline's acceptance criteria are judged by.
 *
 * The backend only stores each Verify session's results. Choosing the run that
 * counts (the newest one that reported, never a superseded one) and matching
 * its ids back onto the snapshot's criteria is a projection every client must
 * make identically, so the inspector, the flow graph and any other reader of a
 * pipeline agree on the ticks.
 */
import {
  isSupersededPipelineSession,
  taskSnapshotCriteria,
  type BuildPipeline,
  type PipelineSession,
} from "./build-pipeline.js";
import {
  acceptanceCriteriaTally,
  sectionsFromTicketText,
  TICKET_SECTION_LIMITS,
  type AcceptanceCriterion,
} from "./ticket-sections.js";

export interface PipelineCriteriaView {
  /** The snapshot's criteria, each with the newest live Verify result for it. */
  criteria: AcceptanceCriterion[];
  /** The verify session the results came from, if any reported criteria. */
  verifySession?: PipelineSession;
}

/**
 * The criteria a pipeline checks and how the newest Verify judged them. A
 * superseded verify session is history and never supplies the ticks.
 */
export function pipelineCriteriaView(pipeline: BuildPipeline): PipelineCriteriaView {
  const snapshot = pipeline.taskSnapshot;
  if (!snapshot) return { criteria: [] };
  const verifySession = [...pipeline.sessions]
    .reverse()
    .find(
      (session) =>
        session.phase === "verify" &&
        session.acceptanceCriteriaResults !== undefined &&
        !isSupersededPipelineSession(session),
    );
  const results = new Map(
    (verifySession?.acceptanceCriteriaResults ?? []).map((result) => [result.id, result]),
  );
  const checkedAt = verifySession?.completedAt ?? verifySession?.startedAt ?? pipeline.createdAt;
  const verifiedCriteria = taskSnapshotCriteria(snapshot);
  const reservedIds = new Set(verifiedCriteria.map(({ id }) => id));
  const allCriteria =
    sectionsFromTicketText(snapshot.description, snapshot.acceptanceCriteria, {
      now: pipeline.createdAt,
    }).acceptanceCriteria ?? [];
  const criteria = allCriteria.map((criterion, index) => {
    const verified = verifiedCriteria[index];
    // Older snapshots stored only a prefix of long criteria. Keep the full
    // original text visible while retaining the id used by that Verify turn.
    const matches =
      verified &&
      (verified.text === criterion.text ||
        (verified.text.length === TICKET_SECTION_LIMITS.maxCriterionLength &&
          criterion.text.startsWith(verified.text)));
    const id = matches
      ? verified.id
      : reservedIds.has(criterion.id)
        ? `snapshot-unverified-${index}`
        : criterion.id;
    const text = criterion.text;
    const result = matches ? results.get(id) : undefined;
    return result
      ? {
          id,
          text,
          check: {
            status: result.status,
            evidence: result.evidence,
            checkedAt,
            source: "verify" as const,
            pipelineId: pipeline.id,
          },
        }
      : { id, text };
  });
  return verifySession ? { criteria, verifySession } : { criteria };
}

/** The Ticket node's status word: how many criteria the newest Verify passed. */
export function pipelineCriteriaStatusWord(
  pipeline: BuildPipeline,
): { text: string; tone: "muted" | "warning" | "destructive" } | undefined {
  const { criteria, verifySession } = pipelineCriteriaView(pipeline);
  if (!verifySession || criteria.length === 0) return undefined;
  const tally = acceptanceCriteriaTally(criteria);
  return {
    text: `${tally.passed}/${criteria.length} criteria`,
    tone: tally.failed ? "destructive" : tally["not-checked"] ? "warning" : "muted",
  };
}
