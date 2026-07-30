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
  isStructuredReviewReport,
  type StructuredReviewReport,
} from "@orkestrator/protocol/structured-review";

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

/**
 * The JSON source inside `content`, or null if the block is not one document.
 *
 * A message that merely *contains* JSON — prose around a snippet — is left to
 * Markdown, which already renders fenced code sensibly. Only a block that is
 * entirely one document is a payload the agent meant as data.
 */
export function jsonPayloadSource(content: string): string | null {
  const trimmed = content.trim();
  const candidate = (JSON_FENCE.exec(trimmed)?.[1] ?? trimmed).trim();
  if (candidate.length === 0 || candidate.length > MAX_JSON_PAYLOAD_LENGTH) {
    return null;
  }
  const first = candidate[0];
  const last = candidate.at(-1);
  const balanced = (first === "{" && last === "}")
    || (first === "[" && last === "]");
  return balanced ? candidate : null;
}

export function parseJsonPayload(content: string): JsonPayload | null {
  const source = jsonPayloadSource(content);
  if (source === null) return null;

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return null;
  }
  // `JSON.parse("null")` is an object by `typeof`, and a scalar document has no
  // structure to fold out, so both fall back to text.
  if (value === null || typeof value !== "object") return null;

  // The legacy allowance matches every other reader of a persisted report: a
  // pipeline recorded before `testResults.notRun` existed must still render.
  if (isStructuredReviewReport(value, { allowLegacyTestResults: true })) {
    return { kind: "structured-review", report: value };
  }
  if (isVerificationVerdict(value)) {
    return { kind: "verification", verdict: value };
  }
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
