import { createHash } from "node:crypto";
import {
  STRUCTURED_REVIEW_MAX_LIST_ITEMS,
  STRUCTURED_REVIEW_MAX_REPORT_BYTES,
  utf8Bytes,
  type StructuredReviewReport,
  type ReviewContractValidationIssue,
} from "@orkestrator/protocol/structured-review";

export const DISPUTED_CHECK_REASON =
  "Review reports disagree. No approved rerun on the reviewed snapshot is available.";

const CHECK_LIMITATION =
  "Disputed validation outcomes remain unverified. Consolidation has no approved runner on the reviewed snapshot.";

/** Compare exact command text, including whitespace within shell arguments. */
export function disputedReviewChecks(
  reports: readonly Pick<StructuredReviewReport, "reviewScope">[],
): Set<string> {
  const results = new Map<string, "passed" | "failed">();
  const disputed = new Set<string>();
  for (const report of reports) {
    for (const { command, result } of report.reviewScope?.commandsRun ?? []) {
      const previous = results.get(command);
      if (previous !== undefined && previous !== result) disputed.add(command);
      results.set(command, result);
    }
  }
  return disputed;
}

/**
 * Reviewer and consolidator text carry no execution authority. Resolve the
 * representation in the backend, using the same rule regardless of transport.
 * Preserve an explicit count if the report schema cannot fit every entry.
 */
export function recordDisputedChecks(
  report: StructuredReviewReport,
  disputes: ReadonlySet<string>,
) {
  if (disputes.size === 0) return report;
  const { reviewScope } = report;
  const commandsRun = reviewScope.commandsRun.filter((entry) => !disputes.has(entry.command));
  const commandsNotRun = reviewScope.commandsNotRun.filter((entry) => !disputes.has(entry.command));
  const limitations = reviewScope.limitations.filter(
    (entry) => !entry.startsWith(CHECK_LIMITATION),
  );
  const scope = { ...reviewScope, commandsRun, commandsNotRun, limitations };
  const pending: typeof commandsNotRun = [];
  // Leave room for the limitation and its omitted count in the final report.
  let remaining =
    STRUCTURED_REVIEW_MAX_REPORT_BYTES -
    utf8Bytes(JSON.stringify({ ...report, reviewScope: scope })) -
    512;
  for (const command of disputes) {
    if (pending.length + commandsNotRun.length >= STRUCTURED_REVIEW_MAX_LIST_ITEMS) break;
    const entry = { command, reason: DISPUTED_CHECK_REASON };
    const bytes = utf8Bytes(JSON.stringify(entry)) + 1;
    if (bytes > remaining) continue;
    pending.push(entry);
    remaining -= bytes;
  }
  const omitted = disputes.size - pending.length;
  const limitation = omitted
    ? `${CHECK_LIMITATION} ${omitted} further disputed checks exceeded the report limit.`
    : CHECK_LIMITATION;
  return {
    ...report,
    reviewScope: {
      ...scope,
      commandsNotRun: [...pending, ...commandsNotRun],
      limitations: [limitation, ...limitations].slice(0, STRUCTURED_REVIEW_MAX_LIST_ITEMS),
    },
  };
}

function commandDigest(command: string): string {
  return createHash("sha256").update(command).digest("hex");
}

export function disputedCheckDigests(disputes: ReadonlySet<string>): string[] {
  return Array.from(disputes, commandDigest);
}

/** Refuse claims before the result becomes final. Pending entries are backend-owned. */
export function disputedCheckSubmissionIssues(
  value: unknown,
  digests: readonly string[] | undefined,
): ReviewContractValidationIssue[] {
  if (!digests?.length) return [];
  const scope = (value as Partial<StructuredReviewReport>).reviewScope;
  if (!Array.isArray(scope?.commandsRun)) return [];
  const disputed = new Set(digests);
  return scope.commandsRun.flatMap((entry, index) =>
    typeof entry?.command === "string" && disputed.has(commandDigest(entry.command))
      ? [
          {
            path: `$.reviewScope.commandsRun[${index}]`,
            code: "invalid_value",
            message:
              "Remove this disputed outcome from commandsRun. The backend records it as unverified.",
          },
        ]
      : [],
  );
}
