/**
 * Recognizes a transcript text block that is nothing but a JSON document.
 *
 * Schema-constrained agents (the build pipeline's review turn especially) emit
 * their contract payload as an ordinary assistant message, so a transcript that
 * renders text verbatim shows the user a wall of raw JSON. Detected payloads are
 * handed to a structured renderer instead — never dropped, and never treated as
 * a validation result: this is classification only.
 *
 * Shared by every client so the desktop, web and any other transcript reader
 * classify the same block the same way; how a payload is drawn stays with the
 * client.
 */

import { isVerificationVerdict, type VerificationVerdict } from "./build-pipeline.js";
import {
  safeParseStructuredReviewFindings,
  safeParseStructuredReviewReport,
  type StructuredReviewFindings,
  type StructuredReviewReport,
} from "./structured-review.js";

export type JsonContainer = Record<string, unknown> | unknown[];

export type JsonPayload = (
  | { kind: "structured-review"; report: StructuredReviewReport }
  /**
   * Only a report's issues and coverage gaps: what the build pipeline's
   * address prompt frames for the fix turn. Rendered with the report's own
   * finding sections rather than the generic tree.
   */
  | { kind: "review-findings"; findings: StructuredReviewFindings }
  | { kind: "verification"; verdict: VerificationVerdict }
  | { kind: "json"; value: JsonContainer }
) & {
  /**
   * The exact bounded JSON document the agent wrote, excluding only an outer
   * Markdown fence. Parsed values cannot preserve duplicate keys, escapes, or
   * numeric notation, so the raw disclosure must render this source directly.
   */
  source: string;
};

/**
 * Above this, the parse is not worth paying on every render of every text part.
 * A payload this large is also past the point where a fold-out is the readable
 * presentation, so it stays as text.
 */
export const MAX_JSON_PAYLOAD_LENGTH = 262_144;

const JSON_FENCE = /^```(?:json[5c]?)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/i;

export interface JsonPayloadSource {
  source: string;
  /** The document was written as a fenced code block rather than bare. */
  fenced: boolean;
}

/**
 * The JSON source inside `content`, or null if the block is not one document.
 *
 * A message that merely *contains* JSON — prose around a snippet — is left to
 * Markdown, which already renders fenced code sensibly. Only a block that is
 * entirely one document is a payload the agent meant as data.
 *
 * Whether it was fenced is reported rather than discarded: an agent that fenced
 * its JSON asked for it to be read as source, which decides whether an
 * unrecognized document is worth folding at all.
 */
export function jsonPayloadSource(content: string): JsonPayloadSource | null {
  const trimmed = content.trim();
  const fencedBody = JSON_FENCE.exec(trimmed)?.[1];
  const candidate = (fencedBody ?? trimmed).trim();
  if (candidate.length === 0 || candidate.length > MAX_JSON_PAYLOAD_LENGTH) {
    return null;
  }
  const first = candidate[0];
  const last = candidate.at(-1);
  const balanced = (first === "{" && last === "}") || (first === "[" && last === "]");
  if (!balanced) return null;
  return { source: candidate, fenced: fencedBody !== undefined };
}

/** Build the transcript payload a Fix tab pins above its opening prompt. */
export function structuredReviewJsonPayload(
  report: StructuredReviewReport,
): Extract<JsonPayload, { kind: "structured-review" }> {
  return {
    kind: "structured-review",
    report,
    source: JSON.stringify(report, null, 2),
  };
}

export function parseJsonPayload(content: string): JsonPayload | null {
  const detected = jsonPayloadSource(content);
  if (detected === null) return null;

  let value: unknown;
  try {
    value = JSON.parse(detected.source);
  } catch {
    return null;
  }
  // `JSON.parse("null")` is an object by `typeof`, and a scalar document has no
  // structure to fold out, so both fall back to text.
  if (value === null || typeof value !== "object") return null;

  // Parsed rather than merely tested, so the report carried out of here is the
  // normalized one. The legacy allowance matches every other reader of a
  // persisted report — a pipeline recorded before `testResults.notRun` existed
  // must still render — and it materializes that field, which a bare type
  // guard would have validated against a copy and then thrown away.
  const report = safeParseStructuredReviewReport(value, {
    allowLegacyTestResults: true,
  });
  if (report.success) {
    return {
      kind: "structured-review",
      report: report.data,
      source: detected.source,
    };
  }
  const findings = safeParseStructuredReviewFindings(value);
  if (findings.success) {
    return { kind: "review-findings", findings: findings.data, source: detected.source };
  }
  if (isVerificationVerdict(value)) {
    return { kind: "verification", verdict: value, source: detected.source };
  }
  // A fenced block of arbitrary JSON was written as code and stays code.
  // Markdown renders it verbatim, whereas the labelled tree humanizes keys and
  // so cannot show the document the agent actually wrote. Only the
  // recognized contracts — which have renderers that say more than the source
  // does — are worth folding out of a code block.
  if (detected.fenced) return null;
  return {
    kind: "json",
    value: value as JsonContainer,
    source: detected.source,
  };
}
