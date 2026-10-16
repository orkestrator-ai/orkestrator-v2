/**
 * Findings a Multi Review reviewer reports while it is still running.
 *
 * A reviewer's report arrives whole, when its result is accepted, so the flow
 * graph's "Findings so far" used to fill in one reviewer at a time. The
 * reviewer's own attempt capability now also carries `report_finding`: one
 * finding per call, validated against the structured-review issue contract and
 * its budgets, and bounded per reviewer and per finding.
 *
 * Findings are progress, not results. The inbox stages each call in memory and
 * the next review pass moves the staged findings onto the reviewer record as
 * an observation, so they cost no write of their own and never contend for the
 * workflow's lock with the pass that owns it. The accepted report replaces
 * them; consolidation never reads them; a reviewer that fails or is stopped
 * keeps them, shown as unconfirmed. A finding staged when the backend stops is
 * lost, which is acceptable for progress: the report still carries it.
 *
 * Only a reviewer the inbox has seen running in a live review, whose result
 * slot is still open, may report, and only for its own slot: the MCP layer
 * checks the attempt capability before it reaches here.
 */
import { createHash } from "node:crypto";
import {
  REVIEW_PROVISIONAL_FINDINGS_MAX,
  REVIEW_PROVISIONAL_FINDING_MAX_BYTES,
  isProvisionalReviewIssue,
  type ReviewerProvisionalFinding,
  type ReviewerRecord,
} from "@orkestrator/protocol/review-fanout";
import {
  safeParseStructuredReviewFindings,
  structuredReviewReportBudgetIssues,
  utf8Bytes,
  type ReviewContractValidationIssue,
  type ReviewIssue,
} from "@orkestrator/protocol/structured-review";
import type { MultiReviewWorkflow } from "@orkestrator/protocol/multi-review";

export interface ProvisionalFindingScope {
  environmentId: string;
  projectId: string;
}

export type ReportFindingErrorCode =
  | "capability_denied"
  | "not_accepting"
  | "attempt_closed"
  | "invalid_finding"
  | "limit_reached"
  | "storage_unavailable";

export type ReportFindingResult =
  | {
      ok: true;
      findingId: string;
      /** The same finding was already reported; nothing changed. */
      duplicate: boolean;
      provisionalCount: number;
      limit: number;
    }
  | {
      ok: false;
      error: {
        code: ReportFindingErrorCode;
        /** `correct` fixes the call; `continue` keeps reviewing; `stop` stops calling. */
        nextAction: "correct" | "continue" | "stop";
        message: string;
        issues?: ReviewContractValidationIssue[];
      };
    };

/** Bounds a list of correctable problems returned to the model. */
const MAX_REPORTED_ISSUES = 20;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(source)
      .sort()
      .map((key) => [key, canonical(source[key])]),
  );
}

/**
 * One `report_finding` payload as a provisional issue, or what is wrong with
 * it. Provenance is the backend's to assign, so a provider's own `reviewModels`
 * or `reviewSourceIds` are dropped rather than trusted. The id is a digest of
 * the normalized issue, which is what makes a retried call idempotent.
 */
export function parseReportedFinding(
  value: unknown,
):
  | { ok: true; issue: ReviewIssue; id: string }
  | { ok: false; issues: ReviewContractValidationIssue[] } {
  const parsed = safeParseStructuredReviewFindings({ issues: [value], testCoverageGaps: [] });
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues
        .slice(0, MAX_REPORTED_ISSUES)
        .map((issue) => ({ ...issue, path: issue.path.replace(/^\$\.issues\[0\]/, "$.finding") })),
    };
  }
  const { reviewModels: _models, reviewSourceIds: _sources, ...issue } = parsed.data.issues[0]!;
  const budget = structuredReviewReportBudgetIssues({ issues: [issue] })
    .slice(0, MAX_REPORTED_ISSUES)
    .map((entry) => ({ ...entry, path: entry.path.replace(/^\$\.issues\[0\]/, "$.finding") }));
  if (budget.length > 0) return { ok: false, issues: budget };
  const encoded = JSON.stringify(canonical(issue));
  const bytes = utf8Bytes(encoded);
  if (bytes > REVIEW_PROVISIONAL_FINDING_MAX_BYTES || !isProvisionalReviewIssue(issue)) {
    return {
      ok: false,
      issues: [
        {
          path: "$.finding",
          code: "invalid_value",
          message: `This finding is ${bytes} bytes; the limit is ${REVIEW_PROVISIONAL_FINDING_MAX_BYTES}. Shorten its prose; the full detail belongs in your report.`,
        },
      ],
    };
  }
  return { ok: true, issue, id: createHash("sha256").update(encoded).digest("hex").slice(0, 24) };
}

/**
 * Appends findings a pass collected to the reviewer's own, oldest first,
 * skipping any it already holds and stopping at the per-reviewer bound.
 * Returns whether anything changed.
 */
export function appendProvisionalFindings(
  reviewer: ReviewerRecord,
  incoming: readonly ReviewerProvisionalFinding[],
): boolean {
  if (incoming.length === 0) return false;
  const findings = reviewer.provisionalFindings ?? [];
  const held = new Set(findings.map((finding) => finding.id));
  let changed = false;
  for (const finding of incoming) {
    if (findings.length >= REVIEW_PROVISIONAL_FINDINGS_MAX) break;
    if (held.has(finding.id)) continue;
    held.add(finding.id);
    findings.push(finding);
    changed = true;
  }
  if (changed) reviewer.provisionalFindings = findings;
  return changed;
}

/** Drops a reviewer's provisional findings; true when there were any. */
export function dropProvisionalFindings(reviewer: ReviewerRecord): boolean {
  if (reviewer.provisionalFindings === undefined) return false;
  delete reviewer.provisionalFindings;
  return true;
}

interface InboxEntry extends ProvisionalFindingScope {
  workflowId: string;
  reviewerId: string;
  /** Ids already on the reviewer record when it was last saved or handed to a pass. */
  recorded: Set<string>;
  /** Reported since the last pass collected them; at most the remaining bound. */
  staged: ReviewerProvisionalFinding[];
}

export interface ProvisionalFindingSink {
  /** Whether this attempt takes `report_finding` now; decides if the tool is listed. */
  accepts(scope: ProvisionalFindingScope, resultKey: string): boolean;
  report(
    scope: ProvisionalFindingScope,
    resultKey: string,
    finding: unknown,
  ): Promise<ReportFindingResult>;
}

/**
 * The live reviewers that may report findings, and what they have reported
 * since the last pass. Keyed by the reviewer's result key (its request id),
 * which the attempt capability is bound to. Bounded by the live reviewers and,
 * for each, by {@link REVIEW_PROVISIONAL_FINDINGS_MAX}.
 */
export class ProvisionalFindingInbox implements ProvisionalFindingSink {
  private readonly entries = new Map<string, InboxEntry>();
  private readonly keysByWorkflow = new Map<string, Set<string>>();

  constructor(
    private readonly options: {
      /** Whether the attempt's result slot still takes submissions. */
      slotOpen(scope: ProvisionalFindingScope, resultKey: string): Promise<boolean>;
      /** A finding is waiting for the workflow's next pass. */
      wake(environmentId: string, workflowId: string): void;
      now?: () => Date;
    },
  ) {}

  /**
   * Follow a saved workflow. A reviewer takes findings while it is running in
   * tool mode during the review stage; anything else of this workflow's is
   * forgotten, with whatever it had staged.
   */
  track(workflow: MultiReviewWorkflow): void {
    const live = new Set<string>();
    if (workflow.phase === "reviewing") {
      for (const reviewer of workflow.reviewers) {
        if (
          reviewer.status !== "running" ||
          reviewer.resultTransport !== "tool-v1" ||
          !reviewer.requestId
        ) {
          continue;
        }
        live.add(reviewer.requestId);
        const recorded = new Set((reviewer.provisionalFindings ?? []).map((finding) => finding.id));
        const entry = this.entries.get(reviewer.requestId);
        if (entry && entry.workflowId === workflow.id && entry.reviewerId === reviewer.id) {
          entry.recorded = recorded;
          entry.staged = entry.staged.filter((finding) => !recorded.has(finding.id));
          continue;
        }
        this.entries.set(reviewer.requestId, {
          environmentId: workflow.environmentId,
          projectId: workflow.projectId,
          workflowId: workflow.id,
          reviewerId: reviewer.id,
          recorded,
          staged: [],
        });
      }
    }
    for (const key of this.keysByWorkflow.get(workflow.id) ?? []) {
      if (!live.has(key)) this.entries.delete(key);
    }
    if (live.size > 0) this.keysByWorkflow.set(workflow.id, live);
    else this.keysByWorkflow.delete(workflow.id);
  }

  forget(workflowId: string): void {
    for (const key of this.keysByWorkflow.get(workflowId) ?? []) this.entries.delete(key);
    this.keysByWorkflow.delete(workflowId);
  }

  private entryFor(scope: ProvisionalFindingScope, resultKey: string): InboxEntry | undefined {
    const entry = this.entries.get(resultKey);
    return entry?.environmentId === scope.environmentId && entry.projectId === scope.projectId
      ? entry
      : undefined;
  }

  accepts(scope: ProvisionalFindingScope, resultKey: string): boolean {
    return this.entryFor(scope, resultKey) !== undefined;
  }

  async report(
    scope: ProvisionalFindingScope,
    resultKey: string,
    finding: unknown,
  ): Promise<ReportFindingResult> {
    if (!this.entryFor(scope, resultKey)) return notAccepting();
    let open: boolean;
    try {
      open = await this.options.slotOpen(scope, resultKey);
    } catch {
      return {
        ok: false,
        error: {
          code: "storage_unavailable",
          nextAction: "continue",
          message:
            "The backend could not check this review attempt. Keep reviewing; the finding still belongs in your report.",
        },
      };
    }
    if (!open) return attemptClosed();
    // The reviewer may have settled while the slot was read.
    const entry = this.entryFor(scope, resultKey);
    if (!entry) return attemptClosed();
    const parsed = parseReportedFinding(finding);
    if (!parsed.ok) {
      return {
        ok: false,
        error: {
          code: "invalid_finding",
          nextAction: "correct",
          message:
            "The finding does not match one entry of the report's `issues`. Correct the listed fields and call again.",
          issues: parsed.issues,
        },
      };
    }
    const count = entry.recorded.size + entry.staged.length;
    if (entry.recorded.has(parsed.id) || entry.staged.some((staged) => staged.id === parsed.id)) {
      return {
        ok: true,
        findingId: parsed.id,
        duplicate: true,
        provisionalCount: count,
        limit: REVIEW_PROVISIONAL_FINDINGS_MAX,
      };
    }
    if (count >= REVIEW_PROVISIONAL_FINDINGS_MAX) {
      return {
        ok: false,
        error: {
          code: "limit_reached",
          nextAction: "continue",
          message: `This review already holds ${REVIEW_PROVISIONAL_FINDINGS_MAX} provisional findings. Stop reporting them one by one; every finding still belongs in your report.`,
        },
      };
    }
    entry.staged.push({
      id: parsed.id,
      reportedAt: (this.options.now?.() ?? new Date()).toISOString(),
      issue: parsed.issue,
    });
    this.options.wake(entry.environmentId, entry.workflowId);
    return {
      ok: true,
      findingId: parsed.id,
      duplicate: false,
      provisionalCount: count + 1,
      limit: REVIEW_PROVISIONAL_FINDINGS_MAX,
    };
  }

  /** The findings staged for a reviewer since the last pass, handed to that pass. */
  take(resultKey: string): ReviewerProvisionalFinding[] {
    const entry = this.entries.get(resultKey);
    if (!entry || entry.staged.length === 0) return [];
    const staged = entry.staged;
    entry.staged = [];
    for (const finding of staged) entry.recorded.add(finding.id);
    return staged;
  }
}

function notAccepting(): ReportFindingResult {
  return {
    ok: false,
    error: {
      code: "not_accepting",
      nextAction: "stop",
      message:
        "This review attempt does not take provisional findings. Put every finding in your report.",
    },
  };
}

function attemptClosed(): ReportFindingResult {
  return {
    ok: false,
    error: {
      code: "attempt_closed",
      nextAction: "stop",
      message:
        "This review attempt is finished or no longer running, so it takes no more findings.",
    },
  };
}
