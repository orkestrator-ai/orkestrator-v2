/**
 * Presentation of a transcript text block that is nothing but a JSON document.
 *
 * Which blocks are payloads, and of which contract, is decided by the shared
 * protocol classifier (`@orkestrator/protocol/transcript-json-payload`) so
 * every client agrees; this module only names, summarizes and labels them for
 * the renderer.
 */

import type { JsonPayload } from "@orkestrator/protocol/transcript-json-payload";
import {
  structuredReviewFindingsSummary,
  structuredReviewVerdictSummary,
} from "@orkestrator/protocol/structured-review-summary";

export {
  jsonPayloadSource,
  MAX_JSON_PAYLOAD_LENGTH,
  parseJsonPayload,
  structuredReviewJsonPayload,
  type JsonContainer,
  type JsonPayload,
  type JsonPayloadSource,
} from "@orkestrator/protocol/transcript-json-payload";

/** Rendering deeper than this costs more than the raw JSON is worth reading. */
export const MAX_JSON_RENDER_DEPTH = 10;

/** Entries rendered per container before the remainder is summarized. */
export const MAX_JSON_RENDER_ENTRIES = 100;

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
    case "review-findings":
      return "Review findings";
    case "verification":
      // The outcome is the title: a verdict the reader has to open to learn is
      // no better than the raw JSON it replaced.
      return payload.verdict.complete ? "Verification passed" : "Verification failed";
    default:
      return Array.isArray(payload.value) ? "JSON list" : "JSON payload";
  }
}

/** The single flattened line a collapsed payload shows beside its title. */
export function jsonPayloadSummary(payload: JsonPayload): string {
  switch (payload.kind) {
    case "structured-review":
      return structuredReviewVerdictSummary(payload.report);
    case "review-findings":
      return structuredReviewFindingsSummary(payload.findings);
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
