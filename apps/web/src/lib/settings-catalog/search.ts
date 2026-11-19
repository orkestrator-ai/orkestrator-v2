/**
 * Deterministic settings search over the catalog: names, curated aliases,
 * section names and descriptions, never values. Every word of the query has
 * to match somewhere; results rank by where the words matched, then by
 * catalog order, so the same query always gives the same list.
 */
import { SETTINGS_SECTION_LABELS } from "./sections";
import type { SettingDescriptor } from "./types";

export type SettingMatchField = "label" | "alias" | "section" | "description";

export interface SettingSearchResult {
  readonly descriptor: SettingDescriptor;
  readonly score: number;
  /** Where the strongest match was, for the result's hint. */
  readonly matchedIn: SettingMatchField;
  /** The alias that matched, when the label did not. */
  readonly matchedAlias?: string;
}

/** Bound on a query; longer input is cut, never rejected. */
export const MAX_SETTINGS_QUERY_CHARS = 120;

export function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9.+#]+/g, " ")
    .trim();
}

export function searchTerms(query: string): string[] {
  const normalized = normalizeSearchText(query.slice(0, MAX_SETTINGS_QUERY_CHARS));
  return normalized ? [...new Set(normalized.split(" "))] : [];
}

function wordStarts(haystack: string, term: string): boolean {
  return haystack.startsWith(term) || haystack.includes(` ${term}`);
}

interface TermMatch {
  score: number;
  field: SettingMatchField;
  alias?: string;
}

function matchTerm(
  term: string,
  label: string,
  aliases: readonly { raw: string; text: string }[],
  section: string,
  description: string,
): TermMatch | null {
  if (label === term) return { score: 100, field: "label" };
  if (wordStarts(label, term)) return { score: 80, field: "label" };
  for (const alias of aliases) {
    if (alias.text === term) return { score: 70, field: "alias", alias: alias.raw };
  }
  for (const alias of aliases) {
    if (wordStarts(alias.text, term)) return { score: 55, field: "alias", alias: alias.raw };
  }
  if (label.includes(term)) return { score: 45, field: "label" };
  if (wordStarts(section, term)) return { score: 30, field: "section" };
  if (wordStarts(description, term)) return { score: 15, field: "description" };
  for (const alias of aliases) {
    if (term.length >= 3 && alias.text.includes(term)) {
      return { score: 12, field: "alias", alias: alias.raw };
    }
  }
  if (term.length >= 4 && description.includes(term)) return { score: 5, field: "description" };
  return null;
}

const FIELD_ORDER: SettingMatchField[] = ["label", "alias", "section", "description"];

/** Search `catalog`; an empty query matches nothing. */
export function searchSettings(
  catalog: readonly SettingDescriptor[],
  query: string,
): SettingSearchResult[] {
  const terms = searchTerms(query);
  if (terms.length === 0) return [];
  const results: Array<SettingSearchResult & { order: number }> = [];
  catalog.forEach((descriptor, order) => {
    const label = normalizeSearchText(descriptor.label);
    const aliases = (descriptor.aliases ?? []).map((raw) => ({
      raw,
      text: normalizeSearchText(raw),
    }));
    const section = normalizeSearchText(SETTINGS_SECTION_LABELS[descriptor.section]);
    const description = normalizeSearchText(descriptor.description);
    let score = 0;
    let best: TermMatch | null = null;
    for (const term of terms) {
      const match = matchTerm(term, label, aliases, section, description);
      if (!match) return;
      score += match.score;
      if (
        !best ||
        FIELD_ORDER.indexOf(match.field) < FIELD_ORDER.indexOf(best.field) ||
        (match.field === best.field && match.score > best.score)
      ) {
        best = match;
      }
    }
    // A whole-phrase hit on the label outranks the same words scattered.
    const phrase = terms.join(" ");
    if (terms.length > 1 && label.includes(phrase)) score += 40;
    results.push({
      descriptor,
      score,
      matchedIn: best!.field,
      ...(best!.field === "alias" && best!.alias ? { matchedAlias: best!.alias } : {}),
      order,
    });
  });
  return results
    .sort((left, right) => right.score - left.score || left.order - right.order)
    .map(({ order: _order, ...result }) => result);
}
