/**
 * Recognizes a transcript text block that is nothing but a JSON document.
 *
 * Schema-constrained agents (the build pipeline's review turn especially) emit
 * their contract payload as an ordinary assistant message, so a transcript that
 * renders text verbatim shows the user a wall of raw JSON. Detected payloads are
 * handed to a structured renderer instead — never dropped, and never treated as
 * a validation result: this is presentation only.
 */

import {
  isVerificationVerdict,
  type VerificationVerdict,
} from "@orkestrator/protocol/build-pipeline";
import {
  safeParseStructuredReviewReport,
  type StructuredReviewReport,
} from "@orkestrator/protocol/structured-review";
import { structuredReviewVerdictSummary } from "@/lib/review/structured-review-summary";

export type JsonContainer = Record<string, unknown> | unknown[];

export type JsonPayload =
  | { kind: "structured-review"; report: StructuredReviewReport }
  | { kind: "verification"; verdict: VerificationVerdict }
  | { kind: "json"; value: JsonContainer };

/**
 * Above this, the parse is not worth paying on every render of every text part.
 * A payload this large is also past the point where a fold-out is the readable
 * presentation, so it stays as text.
 */
export const MAX_JSON_PAYLOAD_LENGTH = 262_144;

/** Rendering deeper than this costs more than the raw JSON is worth reading. */
export const MAX_JSON_RENDER_DEPTH = 10;

/** Entries rendered per container before the remainder is summarized. */
export const MAX_JSON_RENDER_ENTRIES = 100;

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
  const balanced = (first === "{" && last === "}")
    || (first === "[" && last === "]");
  if (!balanced) return null;
  return { source: candidate, fenced: fencedBody !== undefined };
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
    return { kind: "structured-review", report: report.data };
  }
  if (isVerificationVerdict(value)) {
    return { kind: "verification", verdict: value };
  }
  // A fenced block of arbitrary JSON was written as code and stays code.
  // Markdown renders it verbatim, whereas the labelled tree humanizes keys and
  // so cannot show the document the agent actually wrote. Only the two
  // recognized contracts — which have renderers that say more than the source
  // does — are worth folding out of a code block.
  if (detected.fenced) return null;
  return { kind: "json", value: value as JsonContainer };
}

function isAcronym(word: string): boolean {
  return /^[A-Z0-9]{2,}$/.test(word);
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * `filesLeftUncommitted` → `Files left uncommitted`.
 *
 * Sentence case rather than title case: a field label sits next to a value and
 * reads as prose. Acronyms keep their own casing (`SDKVersion` → `SDK version`),
 * and a trailing plural is not mistaken for one (`URLs` stays `URLs`).
 */
export function humanizeJsonKey(key: string): string {
  const spaced = key
    .replace(/[_\-.]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z]{2,})/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
  if (spaced.length === 0) return key;

  return spaced
    .split(" ")
    .map((word, index) => {
      if (isAcronym(word)) return word;
      return index === 0 ? capitalize(word) : word.toLowerCase();
    })
    .join(" ");
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The one-line summary a collapsed container shows in place of its contents. */
export function describeJsonValue(value: unknown): string {
  if (Array.isArray(value)) return plural(value.length, "item");
  if (value !== null && typeof value === "object") {
    return plural(Object.keys(value).length, "field");
  }
  return "";
}

/** The name a collapsed payload goes by. */
export function jsonPayloadTitle(payload: JsonPayload): string {
  switch (payload.kind) {
    case "structured-review":
      return "Structured review report";
    case "verification":
      // The outcome is the title: a verdict the reader has to open to learn is
      // no better than the raw JSON it replaced.
      return payload.verdict.complete
        ? "Verification passed"
        : "Verification failed";
    default:
      return Array.isArray(payload.value) ? "JSON list" : "JSON payload";
  }
}

/** The single flattened line a collapsed payload shows beside its title. */
export function jsonPayloadSummary(payload: JsonPayload): string {
  switch (payload.kind) {
    case "structured-review":
      return structuredReviewVerdictSummary(payload.report);
    case "verification":
      return payload.verdict.rationale.trim().replace(/\s+/g, " ");
    default:
      return describeJsonValue(payload.value);
  }
}

/**
 * What a folded payload contributes to the transcript's find index.
 *
 * Find derives its match list from the message model but draws its highlights
 * from mounted DOM text, and a closed disclosure has unmounted everything
 * below its trigger. Indexing the raw document would therefore count matches
 * that can never be highlighted — and, worse, shift the occurrence numbering
 * of every sibling part in the same message. So the index gets exactly the
 * text the collapsed row renders, in the order it renders it.
 *
 * Concatenated with no separator because that is what the DOM holds: the
 * trigger's title and summary are adjacent elements, and JSX drops the
 * whitespace between them. `JsonPayloadPart` has a test asserting its rendered
 * search text equals this string, so the two cannot drift apart silently.
 */
export function jsonPayloadSearchText(payload: JsonPayload): string {
  return `${jsonPayloadTitle(payload)}${jsonPayloadSummary(payload)}`;
}

export function isEmptyJsonContainer(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  if (value !== null && typeof value === "object") {
    return Object.keys(value).length === 0;
  }
  return false;
}

/** Keys whose value names the record, in the order a reader would reach for. */
const LABEL_KEYS = [
  "title",
  "name",
  "label",
  "subject",
  "testName",
  "command",
  "file",
  "path",
  "description",
  "message",
  "summary",
  "id",
] as const;

const MAX_ENTRY_LABEL_LENGTH = 80;

/**
 * A short name for one element of an array of records, so a collapsed list
 * reads as its contents rather than as `1.`, `2.`, `3.`.
 */
export function jsonEntryLabel(value: unknown): string | null {
  if (Array.isArray(value) || value === null || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of LABEL_KEYS) {
    const candidate = record[key];
    if (typeof candidate !== "string") continue;
    const text = candidate.trim().replace(/\s+/g, " ");
    if (text.length === 0) continue;
    return text.length > MAX_ENTRY_LABEL_LENGTH
      ? `${text.slice(0, MAX_ENTRY_LABEL_LENGTH - 1)}…`
      : text;
  }
  return null;
}
