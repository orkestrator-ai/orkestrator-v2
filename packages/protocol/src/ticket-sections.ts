/**
 * Structured ticket content: a ticket kind, typed optional sections, and a
 * lossless markdown form for editing.
 *
 * The sections are the stored, authoritative form. Two plain-text mirrors are
 * derived from them and kept on every ticket so that every reader written
 * before sections existed (pipeline prompts, Linear, the CLI, older backends
 * sharing the data directory) still sees the whole ticket:
 *
 * - `description` is the markdown of every section except the acceptance
 *   criteria;
 * - `acceptanceCriteria` is the criteria as a markdown list.
 *
 * The markdown form uses `## Heading` lines (outside code fences) as section
 * boundaries. Text before the first heading is the summary. A heading that
 * names no known section becomes a custom section with its own title, so
 * freeform text always survives a round trip. `###` and deeper headings stay
 * inside the section they appear in.
 *
 * Acceptance criteria are items with a stable id. Whether Verify found an item
 * passed, failed or not checkable is stored on the item (`check`) and never
 * written into the markdown, so editing the text cannot forge a result. A
 * hand-ticked `- [x]` is the one exception: it records a manual pass.
 *
 * This module is shared with the browser; it must stay free of Node APIs.
 */

export const TICKET_KINDS = ["feature", "work-brief"] as const;
export type TicketKind = (typeof TICKET_KINDS)[number];
/** What a ticket without a stored kind is: every ticket written before kinds existed. */
export const DEFAULT_TICKET_KIND: TicketKind = "feature";

export const TICKET_KIND_LABELS: Record<TicketKind, string> = {
  feature: "Feature ticket",
  "work-brief": "Work brief",
};

export function isTicketKind(value: unknown): value is TicketKind {
  return typeof value === "string" && (TICKET_KINDS as readonly string[]).includes(value);
}

export const ACCEPTANCE_CRITERION_STATUSES = ["passed", "failed", "not-checked"] as const;
export type AcceptanceCriterionStatus = (typeof ACCEPTANCE_CRITERION_STATUSES)[number];

export function isAcceptanceCriterionStatus(value: unknown): value is AcceptanceCriterionStatus {
  return (
    typeof value === "string" &&
    (ACCEPTANCE_CRITERION_STATUSES as readonly string[]).includes(value)
  );
}

/** Bounds shared by storage, tools and the Verify contract. */
export const TICKET_SECTION_LIMITS = {
  /**
   * Criteria a tool may set and Verify judges. Parsed text keeps every
   * criterion (the text is bounded); only the first this many are checked.
   */
  maxAcceptanceCriteria: 100,
  maxCriterionLength: 10_000,
  maxEvidenceLength: 2_000,
  maxChecks: 50,
  maxCheckLength: 1_000,
  maxCustomSections: 50,
  maxCustomTitleLength: 200,
} as const;

/** One recorded judgement of a criterion. Absent means it was never checked. */
export interface AcceptanceCriterionCheck {
  status: AcceptanceCriterionStatus;
  /** Short reason or proof: the command, test or observation behind the status. */
  evidence: string;
  checkedAt: string;
  /** `verify` for a Build pipeline Verify step; `manual` for a hand-ticked box. */
  source: "verify" | "manual";
  /** The pipeline whose Verify step recorded it. */
  pipelineId?: string;
}

export interface AcceptanceCriterion {
  /** Stable within the ticket (`ac-1`, `ac-2`, …); never reused after an edit. */
  id: string;
  text: string;
  check?: AcceptanceCriterionCheck;
}

export const DELIVERY_POLICIES = ["commit-only", "push-no-pr", "open-pr"] as const;
export type DeliveryPolicy = (typeof DELIVERY_POLICIES)[number];

export const DELIVERY_POLICY_LABELS: Record<DeliveryPolicy, string> = {
  "commit-only": "Commit, don't push",
  "push-no-pr": "Push, no PR (Multi Review next)",
  "open-pr": "Open a PR, don't merge",
};

export function isDeliveryPolicy(value: unknown): value is DeliveryPolicy {
  return typeof value === "string" && (DELIVERY_POLICIES as readonly string[]).includes(value);
}

export interface TicketDelivery {
  policy?: DeliveryPolicy;
  /** Anything the policy does not say: the branch, who runs Multi Review, … */
  note?: string;
}

export interface TicketCustomSection {
  title: string;
  body: string;
}

/** Every field is optional; an absent field is an empty section. */
export interface TicketSections {
  /** What this ticket is, in a paragraph or two. The text before any heading. */
  summary?: string;
  problem?: string;
  context?: string;
  /** Choices the user has already made, which the worker must not reopen. */
  decisions?: string;
  constraints?: string;
  acceptanceCriteria?: AcceptanceCriterion[];
  /** Standard checks (lint, typecheck, tests) kept out of the criteria list. */
  checks?: string[];
  delivery?: TicketDelivery;
  /** Report fields this ticket needs beyond the project's standard report. */
  reporting?: string;
  outOfScope?: string;
  /** Sections whose heading names none of the above, in their original order. */
  custom?: TicketCustomSection[];
  notes?: string;
}

export type TicketTextSectionKey =
  | "summary"
  | "problem"
  | "context"
  | "decisions"
  | "constraints"
  | "reporting"
  | "outOfScope"
  | "notes";

export type TicketSectionKey =
  TicketTextSectionKey | "acceptanceCriteria" | "checks" | "delivery" | "custom";

export interface TicketSectionDefinition {
  key: Exclude<TicketSectionKey, "custom">;
  heading: string;
  /** Other headings that mean this section; matched case-insensitively. */
  aliases: readonly string[];
  /** One line shown to someone choosing what to write. */
  hint: string;
  /** Kinds that usually carry this section; the editor template offers these. */
  kinds: readonly TicketKind[];
}

/**
 * The known sections in render order. Custom sections render after
 * `outOfScope` and before `notes`.
 */
export const TICKET_SECTION_DEFINITIONS: readonly TicketSectionDefinition[] = [
  {
    key: "summary",
    heading: "Summary",
    aliases: ["description", "goal", "overview", "task", "feature", "what"],
    hint: "What this ticket is about.",
    kinds: ["feature", "work-brief"],
  },
  {
    key: "problem",
    heading: "Problem",
    aliases: ["bug", "symptom", "symptoms", "issue"],
    hint: "What is wrong today, and how it shows.",
    kinds: ["work-brief"],
  },
  {
    key: "context",
    heading: "Context",
    aliases: ["background", "why", "evidence", "where to start", "code pointers"],
    hint: "Background, evidence and where to look.",
    kinds: ["feature", "work-brief"],
  },
  {
    key: "decisions",
    heading: "Decisions",
    aliases: ["decisions taken", "user decisions", "what the user decided"],
    hint: "Choices already made that the work must follow.",
    kinds: ["work-brief"],
  },
  {
    key: "constraints",
    heading: "Constraints",
    aliases: ["rules", "ground rules", "guard rails", "guardrails"],
    hint: "Limits on how the work is done. Standing project rules belong in AGENTS.md.",
    kinds: ["work-brief"],
  },
  {
    key: "acceptanceCriteria",
    heading: "Acceptance criteria",
    aliases: ["acceptance", "done when", "definition of done", "ac"],
    hint: "One checkable item per line; Verify marks each passed, failed or not checked.",
    kinds: ["feature", "work-brief"],
  },
  {
    key: "checks",
    heading: "Checks",
    aliases: ["standard checks", "validation", "required checks"],
    hint: "Commands that must pass (lint, typecheck, tests), one per line.",
    kinds: ["work-brief"],
  },
  {
    key: "delivery",
    heading: "Delivery",
    aliases: ["delivery policy", "git workflow", "pr policy", "git"],
    hint: `"Policy: commit-only", "push-no-pr" or "open-pr", then any note.`,
    kinds: ["work-brief"],
  },
  {
    key: "reporting",
    heading: "Reporting",
    aliases: ["report", "report back", "final report", "deliverables"],
    hint: "Report fields beyond the project's standard report.",
    kinds: ["work-brief"],
  },
  {
    key: "outOfScope",
    heading: "Out of scope",
    aliases: ["not in scope", "non-goals", "non goals", "out-of-scope"],
    hint: "What this ticket deliberately leaves alone.",
    kinds: ["feature", "work-brief"],
  },
  {
    key: "notes",
    heading: "Notes",
    aliases: ["freeform", "other", "misc", "additional notes"],
    hint: "Anything else.",
    kinds: ["feature", "work-brief"],
  },
];

const DEFINITION_BY_KEY = new Map(
  TICKET_SECTION_DEFINITIONS.map((definition) => [definition.key, definition]),
);

export function ticketSectionHeading(key: Exclude<TicketSectionKey, "custom">): string {
  return DEFINITION_BY_KEY.get(key)?.heading ?? key;
}

function normalizedHeading(text: string): string {
  return text
    .replace(/\*\*|__/g, "")
    .replace(/[:.]+\s*$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const KEY_BY_HEADING = new Map<string, Exclude<TicketSectionKey, "custom">>();
for (const definition of TICKET_SECTION_DEFINITIONS) {
  KEY_BY_HEADING.set(normalizedHeading(definition.heading), definition.key);
  for (const alias of definition.aliases)
    KEY_BY_HEADING.set(normalizedHeading(alias), definition.key);
}

/** The known section a `##` heading names, or undefined for a custom section. */
export function ticketSectionKeyForHeading(
  heading: string,
): Exclude<TicketSectionKey, "custom"> | undefined {
  return KEY_BY_HEADING.get(normalizedHeading(heading));
}

const TEXT_SECTION_KEYS: readonly TicketTextSectionKey[] = [
  "summary",
  "problem",
  "context",
  "decisions",
  "constraints",
  "reporting",
  "outOfScope",
  "notes",
];

function isTextSectionKey(key: string): key is TicketTextSectionKey {
  return (TEXT_SECTION_KEYS as readonly string[]).includes(key);
}

// ---------------------------------------------------------------------------
// Markdown parsing
// ---------------------------------------------------------------------------

const HEADING = /^##(?!#)[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** A top-level list item: at most one space of indent, so nested items stay in their parent. */
const LIST_ITEM = /^( ?)([-*+]|\d{1,9}[.)])[ \t]+(?:\[([ xX])\][ \t]+)?(.*)$/;
const DELIVERY_POLICY_LINE = /^\s*(?:\*\*)?policy(?:\*\*)?\s*:\s*(.+?)\s*$/i;

interface FenceState {
  marker: string | null;
}

/** Advances fence state over one line; returns whether the line is inside or opens/closes a fence. */
function stepFence(state: FenceState, line: string): boolean {
  const match = FENCE.exec(line);
  if (state.marker !== null) {
    if (
      match &&
      match[1]![0] === state.marker[0] &&
      match[1]!.length >= state.marker.length &&
      line.slice(line.indexOf(match[1]!) + match[1]!.length).trim() === ""
    ) {
      state.marker = null;
    }
    return true;
  }
  if (match) {
    state.marker = match[1]!;
    return true;
  }
  return false;
}

function splitLines(markdown: string): string[] {
  return markdown.replace(/\r\n?/g, "\n").split("\n");
}

/** Drops blank lines at both ends and trailing whitespace; keeps inner text exactly. */
function trimBlock(text: string): string {
  return text.replace(/^(?:[ \t]*\n)+/, "").replace(/\s+$/, "");
}

interface RawBlock {
  heading: string | null;
  lines: string[];
}

function splitBlocks(markdown: string): RawBlock[] {
  const blocks: RawBlock[] = [{ heading: null, lines: [] }];
  const fence: FenceState = { marker: null };
  for (const line of splitLines(markdown)) {
    const inFence = stepFence(fence, line);
    const heading = inFence ? null : HEADING.exec(line);
    if (heading) {
      blocks.push({ heading: heading[1]!, lines: [] });
    } else {
      blocks[blocks.length - 1]!.lines.push(line);
    }
  }
  return blocks;
}

export interface ParsedListItem {
  text: string;
  /** The item was written with a ticked box (`- [x]`). */
  ticked: boolean;
}

/**
 * Splits a list body into items. Lines that are not top-level items continue
 * the item above them, with up to its marker's width of indent removed. Text
 * before the first item is an item of its own, and a body with no list markers
 * is split into paragraphs, so no text is dropped.
 */
export function parseListItems(body: string): ParsedListItem[] {
  const lines = splitLines(body);
  const items: Array<{ lines: string[]; ticked: boolean; indent: number }> = [];
  let preface: string[] = [];
  const fence: FenceState = { marker: null };
  let sawItem = false;
  for (const line of lines) {
    const wasInFence = fence.marker !== null;
    stepFence(fence, line);
    const item = wasInFence ? null : LIST_ITEM.exec(line);
    if (item) {
      sawItem = true;
      const markerWidth = item[1]!.length + item[2]!.length + 1;
      items.push({
        lines: [item[4]!],
        ticked: item[3] === "x" || item[3] === "X",
        indent: Math.min(markerWidth, 4),
      });
      continue;
    }
    const current = items[items.length - 1];
    if (!current) {
      preface.push(line);
      continue;
    }
    let stripped = line;
    let removed = 0;
    while (removed < current.indent && stripped.startsWith(" ")) {
      stripped = stripped.slice(1);
      removed += 1;
    }
    current.lines.push(stripped);
  }
  const result: ParsedListItem[] = [];
  const prefaceText = trimBlock(preface.join("\n"));
  if (!sawItem) {
    for (const paragraph of prefaceText.split(/\n[ \t]*\n/)) {
      const text = trimBlock(paragraph);
      if (text) result.push({ text, ticked: false });
    }
    return result;
  }
  if (prefaceText) result.push({ text: prefaceText, ticked: false });
  for (const item of items) {
    const text = trimBlock(item.lines.join("\n"));
    if (text) result.push({ text, ticked: item.ticked });
  }
  return result;
}

function parseDelivery(body: string): TicketDelivery | undefined {
  const text = trimBlock(body);
  if (!text) return undefined;
  const lines = text.split("\n");
  const policyLine = DELIVERY_POLICY_LINE.exec(lines[0]!);
  const policy = policyLine ? deliveryPolicyFromText(policyLine[1]!) : undefined;
  if (!policy) return { note: text };
  const note = trimBlock(lines.slice(1).join("\n"));
  return note ? { policy, note } : { policy };
}

function deliveryPolicyFromText(value: string): DeliveryPolicy | undefined {
  const normalized = value.replace(/[`*_]/g, "").trim().toLowerCase();
  for (const policy of DELIVERY_POLICIES) {
    if (normalized === policy || normalized === DELIVERY_POLICY_LABELS[policy].toLowerCase()) {
      return policy;
    }
  }
  return undefined;
}

export interface ParseTicketOptions {
  /** The criteria stored before this edit; matching items keep their id and check. */
  previousCriteria?: readonly AcceptanceCriterion[];
  /** Timestamp for checks a hand-ticked box records. */
  now?: string;
}

interface RawTicketSections {
  sections: Omit<TicketSections, "acceptanceCriteria">;
  /** Present when the markdown had an acceptance criteria heading. */
  criteria?: ParsedListItem[];
}

function parseTicketMarkdownRaw(markdown: string): RawTicketSections {
  const sections: TicketSections = {};
  let criteria: ParsedListItem[] | undefined;
  for (const block of splitBlocks(markdown)) {
    const body = trimBlock(block.lines.join("\n"));
    if (block.heading === null) {
      if (body) sections.summary = body;
      continue;
    }
    const key = ticketSectionKeyForHeading(block.heading);
    if (key === undefined) {
      (sections.custom ??= []).push({ title: block.heading.trim(), body });
      continue;
    }
    if (key === "acceptanceCriteria") {
      criteria = [...(criteria ?? []), ...parseListItems(body)];
      continue;
    }
    if (key === "checks") {
      const checks = parseListItems(body).map((item) => item.text);
      if (checks.length) sections.checks = [...(sections.checks ?? []), ...checks];
      continue;
    }
    if (key === "delivery") {
      const delivery = parseDelivery(body);
      if (delivery) sections.delivery = mergeDelivery(sections.delivery, delivery);
      continue;
    }
    if (isTextSectionKey(key) && body) {
      const existing = sections[key];
      sections[key] = existing ? `${existing}\n\n${body}` : body;
    }
  }
  return criteria ? { sections, criteria } : { sections };
}

function withCriteria(
  sections: Omit<TicketSections, "acceptanceCriteria">,
  criteria: readonly ParsedListItem[],
  options: ParseTicketOptions,
): TicketSections {
  const items = reconcileAcceptanceCriteria(criteria, options);
  return items.length ? { ...sections, acceptanceCriteria: items } : { ...sections };
}

/** Parses ticket markdown into sections. Lossless for text; see the module comment. */
export function parseTicketMarkdown(
  markdown: string,
  options: ParseTicketOptions = {},
): TicketSections {
  const raw = parseTicketMarkdownRaw(markdown);
  return withCriteria(raw.sections, raw.criteria ?? [], options);
}

function mergeDelivery(existing: TicketDelivery | undefined, next: TicketDelivery): TicketDelivery {
  if (!existing) return next;
  const policy = existing.policy ?? next.policy;
  const notes = [
    existing.note,
    next.policy && existing.policy ? `Policy: ${next.policy}` : "",
    next.note,
  ]
    .filter(Boolean)
    .join("\n\n");
  return { ...(policy ? { policy } : {}), ...(notes ? { note: notes } : {}) };
}

/** Parses an acceptance criteria text field (a list or paragraphs) into items. */
export function parseAcceptanceCriteriaText(
  text: string,
  options: ParseTicketOptions = {},
): AcceptanceCriterion[] {
  return reconcileAcceptanceCriteria(parseListItems(text), options);
}

function criterionNumber(id: string): number {
  const match = /^ac-(\d+)$/.exec(id);
  return match ? Number(match[1]) : 0;
}

export function manualCheck(now: string): AcceptanceCriterionCheck {
  return {
    status: "passed",
    evidence: "Ticked by hand in the ticket text.",
    checkedAt: now,
    source: "manual",
  };
}

/**
 * Gives parsed items their ids. An item whose text matches a previous item
 * exactly keeps that item's id and check; any other item is new, with a fresh
 * id and no check, because changing a criterion's text invalidates its result.
 */
export function reconcileAcceptanceCriteria(
  parsed: ReadonlyArray<ParsedListItem | { text: string; ticked?: boolean; id?: string }>,
  options: ParseTicketOptions = {},
): AcceptanceCriterion[] {
  const previous = options.previousCriteria ?? [];
  const used = new Set<string>();
  let next = Math.max(0, ...previous.map((item) => criterionNumber(item.id)));
  const now = options.now ?? new Date().toISOString();
  const result: AcceptanceCriterion[] = [];
  const pending: Array<{ index: number; ticked: boolean }> = [];
  for (const item of parsed) {
    const text = trimBlock(item.text);
    if (!text) continue;
    const requestedId = "id" in item ? item.id : undefined;
    const match =
      previous.find(
        (candidate) =>
          candidate.id === requestedId && candidate.text === text && !used.has(candidate.id),
      ) ?? previous.find((candidate) => candidate.text === text && !used.has(candidate.id));
    if (match) {
      used.add(match.id);
      const check = match.check ?? (item.ticked ? manualCheck(now) : undefined);
      result.push({ id: match.id, text, ...(check ? { check } : {}) });
      continue;
    }
    pending.push({ index: result.length, ticked: item.ticked === true });
    result.push({ id: "", text });
  }
  for (const { index, ticked } of pending) {
    next += 1;
    while (used.has(`ac-${next}`) || previous.some((candidate) => candidate.id === `ac-${next}`)) {
      next += 1;
    }
    const id = `ac-${next}`;
    used.add(id);
    result[index] = {
      id,
      text: result[index]!.text,
      ...(ticked ? { check: manualCheck(now) } : {}),
    };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function renderListItem(text: string): string {
  const [first, ...rest] = text.split("\n");
  return [`- ${first}`, ...rest.map((line) => (line ? `  ${line}` : ""))].join("\n");
}

export function renderList(items: readonly string[]): string {
  return items.map(renderListItem).join("\n");
}

function renderDelivery(delivery: TicketDelivery): string {
  return [delivery.policy ? `Policy: ${delivery.policy}` : "", delivery.note ?? ""]
    .filter(Boolean)
    .join("\n\n");
}

export interface RenderTicketOptions {
  /** Leave out the acceptance criteria (the `description` mirror). */
  omitAcceptanceCriteria?: boolean;
}

/** Renders sections as markdown; `parseTicketMarkdown` reads it back unchanged. */
export function renderTicketMarkdown(
  sections: TicketSections,
  options: RenderTicketOptions = {},
): string {
  const blocks: string[] = [];
  const push = (heading: string, body: string) => {
    blocks.push(body ? `## ${heading}\n\n${body}` : `## ${heading}`);
  };
  for (const definition of TICKET_SECTION_DEFINITIONS) {
    const key = definition.key;
    if (key === "notes") {
      for (const custom of sections.custom ?? []) push(custom.title, trimBlock(custom.body));
    }
    if (key === "summary") {
      const summary = trimBlock(sections.summary ?? "");
      if (summary) blocks.push(summary);
      continue;
    }
    if (key === "acceptanceCriteria") {
      if (options.omitAcceptanceCriteria || !sections.acceptanceCriteria?.length) continue;
      push(definition.heading, renderList(sections.acceptanceCriteria.map((item) => item.text)));
      continue;
    }
    if (key === "checks") {
      if (sections.checks?.length) push(definition.heading, renderList(sections.checks));
      continue;
    }
    if (key === "delivery") {
      const body = sections.delivery ? renderDelivery(sections.delivery) : "";
      if (body) push(definition.heading, body);
      continue;
    }
    const text = trimBlock(sections[key] ?? "");
    if (text) push(definition.heading, text);
  }
  return blocks.join("\n\n");
}

// ---------------------------------------------------------------------------
// Ticket content: sections plus the plain-text mirrors
// ---------------------------------------------------------------------------

/**
 * Brings sections to the form the markdown reads back as, so stored sections
 * are always a fixed point of render → parse. Criteria keep their ids and
 * checks by position (rendering never adds or merges items).
 */
export function canonicalTicketSections(sections: TicketSections): TicketSections {
  const previous = sections.acceptanceCriteria ?? [];
  const reparsed = parseTicketMarkdown(renderTicketMarkdown(sections), {
    previousCriteria: previous,
  });
  const items = reparsed.acceptanceCriteria;
  if (items && items.length === previous.length) {
    reparsed.acceptanceCriteria = items.map((item, index) => {
      const before = previous[index]!;
      return {
        id: before.id || item.id,
        text: item.text,
        ...(before.check ? { check: before.check } : {}),
      };
    });
  }
  return reparsed;
}

/** The `description` mirror: every section except the acceptance criteria. */
export function ticketDescriptionMirror(sections: TicketSections): string {
  return renderTicketMarkdown(sections, { omitAcceptanceCriteria: true });
}

/** The `acceptanceCriteria` mirror: the criteria as a markdown list, without results. */
export function ticketAcceptanceCriteriaMirror(sections: TicketSections): string {
  return renderList((sections.acceptanceCriteria ?? []).map((item) => item.text));
}

/** 32-bit FNV-1a over UTF-16 code units; a change detector, not a security hash. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Fingerprint of the two mirrors the sections were last written with. A
 * ticket whose mirrors no longer match was edited by a writer that knows only
 * the text fields (an older backend or client), so its sections are rebuilt
 * from the text.
 */
export function ticketSectionsBasis(description: string, acceptanceCriteria: string): string {
  return `v1:${fnv1a(`${description}\u0000${acceptanceCriteria}`)}`;
}

/** The parts of a stored ticket this module reads and writes. */
export interface TicketContentFields {
  kind?: TicketKind;
  description: string;
  acceptanceCriteria: string;
  sections?: TicketSections;
  sectionsBasis?: string;
}

export interface TicketContent {
  kind: TicketKind;
  description: string;
  acceptanceCriteria: string;
  sections: TicketSections;
  sectionsBasis: string;
}

/**
 * Sections for a ticket that has only the text fields. The description is
 * parsed as ticket markdown; the acceptance criteria field adds its items
 * after any the description itself listed. A legacy `- [x]` is kept as a
 * manual pass so its meaning is not lost.
 */
export function sectionsFromTicketText(
  description: string,
  acceptanceCriteria: string,
  options: ParseTicketOptions = {},
): TicketSections {
  const raw = parseTicketMarkdownRaw(description);
  return withCriteria(
    raw.sections,
    [...(raw.criteria ?? []), ...parseListItems(acceptanceCriteria)],
    options,
  );
}

/**
 * A stored ticket as current content. Legacy rows (no sections) and rows an
 * older writer changed (stale basis) get sections derived from their text;
 * their text fields are kept exactly as stored, so nothing is rewritten until
 * the ticket is next edited.
 */
export function normalizeTicketContent(
  ticket: TicketContentFields,
  options: Pick<ParseTicketOptions, "now"> = {},
): TicketContent {
  const kind = isTicketKind(ticket.kind) ? ticket.kind : DEFAULT_TICKET_KIND;
  const description = typeof ticket.description === "string" ? ticket.description : "";
  const acceptanceCriteria =
    typeof ticket.acceptanceCriteria === "string" ? ticket.acceptanceCriteria : "";
  const basis = ticketSectionsBasis(description, acceptanceCriteria);
  if (isTicketSections(ticket.sections) && ticket.sectionsBasis === basis) {
    return {
      kind,
      description,
      acceptanceCriteria,
      sections: ticket.sections,
      sectionsBasis: basis,
    };
  }
  const sections = sectionsFromTicketText(description, acceptanceCriteria, {
    ...options,
    previousCriteria: isTicketSections(ticket.sections)
      ? (ticket.sections.acceptanceCriteria ?? [])
      : [],
  });
  return { kind, description, acceptanceCriteria, sections, sectionsBasis: basis };
}

/** Content whose mirrors are rendered from the given sections. */
export function ticketContentFromSections(
  kind: TicketKind,
  sections: TicketSections,
): TicketContent {
  const canonical = canonicalTicketSections(sections);
  const description = ticketDescriptionMirror(canonical);
  const acceptanceCriteria = ticketAcceptanceCriteriaMirror(canonical);
  return {
    kind,
    description,
    acceptanceCriteria,
    sections: canonical,
    sectionsBasis: ticketSectionsBasis(description, acceptanceCriteria),
  };
}

/** A criterion as a tool or client may supply it: text, optionally naming the id it edits. */
export type AcceptanceCriterionInput = string | { id?: string; text: string };

/** Per-key section changes: a value replaces the section, `null` clears it. */
export type TicketSectionsPatch = {
  [Key in Exclude<keyof TicketSections, "acceptanceCriteria">]?: TicketSections[Key] | null;
} & { acceptanceCriteria?: AcceptanceCriterionInput[] | null };

export interface TicketContentUpdate {
  kind?: TicketKind;
  /** The whole ticket as edited markdown; replaces every section. */
  markdown?: string;
  /** Legacy: replaces every section except the criteria (unless it lists criteria). */
  description?: string;
  /** Legacy: replaces the criteria from list text. */
  acceptanceCriteria?: string;
  sections?: TicketSectionsPatch;
}

export function hasTicketContentUpdate(update: TicketContentUpdate): boolean {
  return (
    update.kind !== undefined ||
    update.markdown !== undefined ||
    update.description !== undefined ||
    update.acceptanceCriteria !== undefined ||
    update.sections !== undefined
  );
}

/**
 * Applies a content update. Unchanged criteria keep their ids and Verify
 * results throughout.
 *
 * An update of only the text fields (and perhaps the kind) is how every
 * writer that predates sections changes a ticket, so it is stored exactly as
 * written and the sections are derived from it, as for a legacy row. An update
 * with `markdown` or `sections` is structured: it is applied in a fixed order
 * (`markdown`, `description`, `acceptanceCriteria`, then the `sections` patch)
 * and both mirrors are rendered from the result.
 */
export function applyTicketContentUpdate(
  current: TicketContentFields | null,
  update: TicketContentUpdate,
  options: Pick<ParseTicketOptions, "now"> = {},
): TicketContent {
  const base = current
    ? normalizeTicketContent(current, options)
    : ticketContentFromSections(DEFAULT_TICKET_KIND, {});
  if (update.markdown === undefined && update.sections === undefined) {
    return normalizeTicketContent(
      {
        kind: update.kind ?? base.kind,
        description: update.description ?? base.description,
        acceptanceCriteria: update.acceptanceCriteria ?? base.acceptanceCriteria,
        sections: base.sections,
        sectionsBasis: base.sectionsBasis,
      },
      options,
    );
  }
  let sections: TicketSections = { ...base.sections };
  const previousCriteria = () => sections.acceptanceCriteria ?? [];
  if (update.markdown !== undefined) {
    sections = parseTicketMarkdown(update.markdown, {
      ...options,
      previousCriteria: previousCriteria(),
    });
  }
  if (update.description !== undefined) {
    const parsed = parseTicketMarkdown(update.description, {
      ...options,
      previousCriteria: previousCriteria(),
    });
    sections = {
      ...parsed,
      ...(parsed.acceptanceCriteria
        ? {}
        : sections.acceptanceCriteria
          ? { acceptanceCriteria: sections.acceptanceCriteria }
          : {}),
    };
  }
  if (update.acceptanceCriteria !== undefined) {
    const items = parseAcceptanceCriteriaText(update.acceptanceCriteria, {
      ...options,
      previousCriteria: previousCriteria(),
    });
    if (items.length) sections.acceptanceCriteria = items;
    else delete sections.acceptanceCriteria;
  }
  if (update.sections !== undefined) {
    sections = applySectionsPatch(sections, update.sections, options);
  }
  return ticketContentFromSections(update.kind ?? base.kind, sections);
}

function applySectionsPatch(
  sections: TicketSections,
  patch: TicketSectionsPatch,
  options: Pick<ParseTicketOptions, "now">,
): TicketSections {
  const next: TicketSections = { ...sections };
  for (const [key, value] of Object.entries(patch) as Array<[keyof TicketSectionsPatch, unknown]>) {
    if (value === undefined) continue;
    if (value === null) {
      delete next[key];
      continue;
    }
    if (key === "acceptanceCriteria") {
      const items = (value as AcceptanceCriterionInput[]).map((item) =>
        typeof item === "string" ? { text: item } : item,
      );
      const reconciled = reconcileAcceptanceCriteria(items, {
        ...options,
        previousCriteria: sections.acceptanceCriteria ?? [],
      });
      if (reconciled.length) next.acceptanceCriteria = reconciled;
      else delete next.acceptanceCriteria;
      continue;
    }
    (next as Record<string, unknown>)[key] = value;
  }
  return next;
}

/** The whole ticket as editable markdown (sections and criteria, no results). */
export function ticketMarkdown(sections: TicketSections): string {
  return renderTicketMarkdown(sections);
}

/** A starting template for an empty ticket of this kind. */
export function ticketMarkdownTemplate(kind: TicketKind): string {
  return TICKET_SECTION_DEFINITIONS.filter(
    (definition) =>
      definition.key !== "summary" && definition.kinds.includes(kind) && definition.key !== "notes",
  )
    .map((definition) => `## ${definition.heading}\n\n`)
    .join("")
    .trimEnd();
}

/** Results of the newest check, counted for a compact badge. */
export function acceptanceCriteriaTally(
  items: readonly AcceptanceCriterion[],
): Record<AcceptanceCriterionStatus | "unchecked", number> {
  const tally = { passed: 0, failed: 0, "not-checked": 0, unchecked: 0 };
  for (const item of items) tally[item.check?.status ?? "unchecked"] += 1;
  return tally;
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

export function isAcceptanceCriterionCheck(value: unknown): value is AcceptanceCriterionCheck {
  return (
    isRecord(value) &&
    isAcceptanceCriterionStatus(value.status) &&
    typeof value.evidence === "string" &&
    value.evidence.length <= TICKET_SECTION_LIMITS.maxEvidenceLength &&
    typeof value.checkedAt === "string" &&
    (value.source === "verify" || value.source === "manual") &&
    isOptionalString(value.pipelineId)
  );
}

export function isAcceptanceCriterion(value: unknown): value is AcceptanceCriterion {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    value.id.length <= 64 &&
    typeof value.text === "string" &&
    (value.check === undefined || isAcceptanceCriterionCheck(value.check))
  );
}

export function isTicketSections(value: unknown): value is TicketSections {
  if (!isRecord(value)) return false;
  for (const key of TEXT_SECTION_KEYS) if (!isOptionalString(value[key])) return false;
  if (
    value.acceptanceCriteria !== undefined &&
    !(
      Array.isArray(value.acceptanceCriteria) &&
      value.acceptanceCriteria.every(isAcceptanceCriterion)
    )
  ) {
    return false;
  }
  if (
    value.checks !== undefined &&
    !(Array.isArray(value.checks) && value.checks.every((check) => typeof check === "string"))
  ) {
    return false;
  }
  if (
    value.delivery !== undefined &&
    !(
      isRecord(value.delivery) &&
      (value.delivery.policy === undefined || isDeliveryPolicy(value.delivery.policy)) &&
      isOptionalString(value.delivery.note)
    )
  ) {
    return false;
  }
  if (
    value.custom !== undefined &&
    !(
      Array.isArray(value.custom) &&
      value.custom.every(
        (section) =>
          isRecord(section) &&
          typeof section.title === "string" &&
          typeof section.body === "string",
      )
    )
  ) {
    return false;
  }
  return true;
}

/**
 * Validates a sections patch from a command or tool argument. Throws a
 * message naming the bad field.
 */
export function parseTicketSectionsPatch(value: unknown, name = "sections"): TicketSectionsPatch {
  if (!isRecord(value)) throw new Error(`${name} must be an object`);
  const patch: TicketSectionsPatch = {};
  const known = new Set<string>([
    ...TEXT_SECTION_KEYS,
    "acceptanceCriteria",
    "checks",
    "delivery",
    "custom",
  ]);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) throw new Error(`${name}.${key} is not a ticket section`);
  }
  for (const key of TEXT_SECTION_KEYS) {
    const field = value[key];
    if (field === undefined) continue;
    if (field !== null && typeof field !== "string")
      throw new Error(`${name}.${key} must be a string or null`);
    patch[key] = field as string | null;
  }
  if (value.acceptanceCriteria !== undefined) {
    const field = value.acceptanceCriteria;
    if (field === null) patch.acceptanceCriteria = null;
    else {
      if (!Array.isArray(field) || field.length > TICKET_SECTION_LIMITS.maxAcceptanceCriteria) {
        throw new Error(
          `${name}.acceptanceCriteria must be an array of at most ${TICKET_SECTION_LIMITS.maxAcceptanceCriteria} items`,
        );
      }
      patch.acceptanceCriteria = field.map((item, index) => {
        if (typeof item === "string")
          return boundedCriterion(item, `${name}.acceptanceCriteria[${index}]`);
        if (isRecord(item) && typeof item.text === "string" && isOptionalString(item.id)) {
          const text = boundedCriterion(item.text, `${name}.acceptanceCriteria[${index}].text`);
          return typeof item.id === "string" && item.id ? { id: item.id, text } : { text };
        }
        throw new Error(`${name}.acceptanceCriteria[${index}] must be a string or { id?, text }`);
      });
    }
  }
  if (value.checks !== undefined) {
    const field = value.checks;
    if (field === null) patch.checks = null;
    else if (
      Array.isArray(field) &&
      field.length <= TICKET_SECTION_LIMITS.maxChecks &&
      field.every(
        (check) =>
          typeof check === "string" && check.length <= TICKET_SECTION_LIMITS.maxCheckLength,
      )
    ) {
      patch.checks = field as string[];
    } else {
      throw new Error(
        `${name}.checks must be an array of at most ${TICKET_SECTION_LIMITS.maxChecks} strings`,
      );
    }
  }
  if (value.delivery !== undefined) {
    const field = value.delivery;
    if (field === null) patch.delivery = null;
    else if (
      isRecord(field) &&
      (field.policy === undefined || isDeliveryPolicy(field.policy)) &&
      isOptionalString(field.note)
    ) {
      patch.delivery = {
        ...(field.policy ? { policy: field.policy as DeliveryPolicy } : {}),
        ...(typeof field.note === "string" && field.note ? { note: field.note } : {}),
      };
    } else {
      throw new Error(
        `${name}.delivery must be { policy?: ${DELIVERY_POLICIES.join(" | ")}, note? }`,
      );
    }
  }
  if (value.custom !== undefined) {
    const field = value.custom;
    if (field === null) patch.custom = null;
    else if (
      Array.isArray(field) &&
      field.length <= TICKET_SECTION_LIMITS.maxCustomSections &&
      field.every(
        (section) =>
          isRecord(section) &&
          typeof section.title === "string" &&
          section.title.trim().length > 0 &&
          section.title.length <= TICKET_SECTION_LIMITS.maxCustomTitleLength &&
          !section.title.includes("\n") &&
          typeof section.body === "string",
      )
    ) {
      patch.custom = (field as Array<{ title: string; body: string }>).map((section) => ({
        title: section.title.trim(),
        body: section.body,
      }));
    } else {
      throw new Error(`${name}.custom must be an array of { title, body } with one-line titles`);
    }
  }
  return patch;
}

function boundedCriterion(text: string, name: string): string {
  if (text.length > TICKET_SECTION_LIMITS.maxCriterionLength) {
    throw new Error(
      `${name} must be at most ${TICKET_SECTION_LIMITS.maxCriterionLength} characters`,
    );
  }
  return text;
}

// ---------------------------------------------------------------------------
// Tool-facing summaries and guidance
// ---------------------------------------------------------------------------

/** A criterion as tools report it: its newest result flattened beside the text. */
export interface TicketCriterionSummary {
  id: string;
  text: string;
  status?: AcceptanceCriterionStatus;
  evidence?: string;
}

export function ticketCriteriaSummary(
  sections: TicketSections | undefined,
): TicketCriterionSummary[] {
  return (sections?.acceptanceCriteria ?? []).map((item) => ({
    id: item.id,
    text: item.text,
    ...(item.check ? { status: item.check.status, evidence: item.check.evidence } : {}),
  }));
}

/** What a tool's `kind` field says; models read it when they choose. */
export const TICKET_KIND_GUIDANCE =
  "feature (default): what to build, for the board — summary plus acceptance criteria. work-brief: a coordinator's instructions for one worker on how to do the work — problem, context, decisions, constraints, delivery and reporting. Follow-up steers to a running worker are messages, not tickets.";

/** What a tool's `sections` field says. */
export const TICKET_SECTIONS_GUIDANCE =
  "Structured ticket sections; each is optional and replaces only that section (an empty value clears it). acceptanceCriteria: one checkable item per entry; Verify marks each passed, failed or not checked. checks: standard commands (lint, typecheck, tests) that must pass, kept out of acceptanceCriteria. delivery.policy: commit-only, push-no-pr or open-pr. custom: extra titled sections. Do not repeat standing project rules (report format, checks every change runs, PR flow, safety rules); they live in AGENTS.md's Orkestrator section.";
