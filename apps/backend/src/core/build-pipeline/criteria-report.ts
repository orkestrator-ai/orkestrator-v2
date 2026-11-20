/**
 * How a build pipeline's newest Verify judged each acceptance criterion, and
 * on which commit, for the coordinator: the lines of its completion and
 * failure wakes and the `criteria` field of `get_build_pipeline`.
 *
 * Read from the pipeline's own Verify session rather than the ticket, so a
 * Linear or GitHub build, which has no Kanban ticket, reports the same facts.
 * The snapshot may come from another node, so it is read defensively.
 *
 * Criterion text and evidence are ticket and agent content: they may go to
 * the coordinator's mail and tool results, which already carry the ticket,
 * but never to logs or metrics.
 */
import type { BuildPipeline } from "@orkestrator/protocol/build-pipeline";
import {
  pipelineCriteriaView,
  verifySessionJudgedCode,
} from "@orkestrator/protocol/build-pipeline-criteria";
import type { AcceptanceCriterionStatus } from "@orkestrator/protocol/ticket-sections";

/** Each criterion's text in the report; the ticket holds the full text. */
const MAX_REPORT_TEXT_CHARS = 500;
/** The whole `criteria` list. Evidence is already bounded per criterion. */
const MAX_REPORT_BYTES = 48 * 1024;

export interface BuildCriterionReportEntry {
  id: string;
  text: string;
  textTruncated?: true;
  /** A criterion Verify reported nothing for counts as `not-checked`, never passed. */
  status: AcceptanceCriterionStatus;
  evidence: string;
}

export interface BuildCriteriaReport {
  /** The commit Verify judged; absent when it was not recorded. */
  commit?: string;
  /** Verify judged `commit` plus uncommitted changes in the worktree. */
  uncommittedChanges?: true;
  /** "commit abc1234", "commit abc1234 with uncommitted changes" or "commit not recorded". */
  judged: string;
  checkedAt?: string;
  total: number;
  passed: number;
  failed: number;
  notChecked: number;
  /** Failed first, then not checked, then passed, each in ticket order. */
  criteria: BuildCriterionReportEntry[];
  criteriaTruncated?: true;
}

const STATUS_ORDER: Record<AcceptanceCriterionStatus, number> = {
  failed: 0,
  "not-checked": 1,
  passed: 2,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The words for a judged commit, shared by the report and the wake. */
function judgedWords(judged: { commit?: string; uncommittedChanges?: boolean }): string {
  if (!judged.commit) return "commit not recorded";
  return `commit ${judged.commit.slice(0, 7)}${judged.uncommittedChanges ? " with uncommitted changes" : ""}`;
}

/**
 * The newest Verify's per-criterion results, or null when no Verify has
 * reported criteria (or the snapshot cannot be read).
 */
export function buildPipelineCriteriaReport(workflow: unknown): BuildCriteriaReport | null {
  if (!isRecord(workflow) || !Array.isArray(workflow.sessions) || !isRecord(workflow.taskSnapshot))
    return null;
  let view: ReturnType<typeof pipelineCriteriaView>;
  try {
    view = pipelineCriteriaView(workflow as unknown as BuildPipeline);
  } catch {
    return null;
  }
  const session = view.verifySession;
  if (!session || view.criteria.length === 0) return null;
  const judged = verifySessionJudgedCode(session);
  const entries = view.criteria
    .map((criterion, index) => ({
      index,
      entry: {
        id: criterion.id,
        text: criterion.text.slice(0, MAX_REPORT_TEXT_CHARS),
        ...(criterion.text.length > MAX_REPORT_TEXT_CHARS ? { textTruncated: true as const } : {}),
        status: criterion.check?.status ?? "not-checked",
        evidence: criterion.check
          ? criterion.check.evidence
          : "Verify reported no result for this criterion.",
      } satisfies BuildCriterionReportEntry,
    }))
    .sort(
      (a, b) => STATUS_ORDER[a.entry.status] - STATUS_ORDER[b.entry.status] || a.index - b.index,
    )
    .map(({ entry }) => entry);
  const counts = { passed: 0, failed: 0, notChecked: 0 };
  for (const entry of entries) {
    if (entry.status === "passed") counts.passed += 1;
    else if (entry.status === "failed") counts.failed += 1;
    else counts.notChecked += 1;
  }
  const criteria: BuildCriterionReportEntry[] = [];
  let bytes = 2;
  let truncated = false;
  for (const entry of entries) {
    const size = Buffer.byteLength(JSON.stringify(entry), "utf8") + 1;
    if (bytes + size > MAX_REPORT_BYTES) {
      truncated = true;
      break;
    }
    bytes += size;
    criteria.push(entry);
  }
  const checkedAt = session.completedAt ?? session.startedAt;
  return {
    ...(judged.commit ? { commit: judged.commit } : {}),
    ...(judged.uncommittedChanges ? { uncommittedChanges: true as const } : {}),
    judged: judgedWords(judged),
    ...(typeof checkedAt === "string" ? { checkedAt } : {}),
    total: entries.length,
    ...counts,
    criteria,
    ...(truncated ? { criteriaTruncated: true as const } : {}),
  };
}

/**
 * The wake's criteria lines within `budget` lines: a tally naming the judged
 * commit, then each failed or not-checked criterion, and a closing line for
 * any that did not fit. Passed criteria are only counted; their evidence is
 * one `get_build_pipeline` read away.
 */
export function criteriaNoticeLines(report: BuildCriteriaReport | null, budget: number): string[] {
  if (!report || budget <= 0) return [];
  const tally = [
    `${report.passed}/${report.total} passed`,
    report.failed ? `${report.failed} failed` : "",
    report.notChecked ? `${report.notChecked} not checked` : "",
  ]
    .filter(Boolean)
    .join(", ");
  const lines = [`Acceptance criteria: ${tally}; Verify judged ${report.judged}.`];
  const open = report.criteria.filter((entry) => entry.status !== "passed");
  // Entries cut from the report by its byte bound are still open.
  const unlisted = report.failed + report.notChecked - open.length;
  const room = budget - 1;
  const overflow = open.length + unlisted > room;
  const shown = open.slice(0, overflow ? Math.max(0, room - 1) : room);
  for (const entry of shown) {
    lines.push(
      `${entry.status === "failed" ? "Failed" : "Not checked"} ${entry.id}: ${entry.text}`,
    );
  }
  const rest = open.length + unlisted - shown.length;
  if (rest > 0 && lines.length < budget) {
    lines.push(
      `${rest} more not passed; get_build_pipeline lists every criterion with its evidence.`,
    );
  }
  return lines.slice(0, budget);
}
