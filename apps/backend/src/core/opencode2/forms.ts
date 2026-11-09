/**
 * OpenCode 2.x forms (`Form.Info`) as the shared question card, and the
 * card's answer back as a `Form.Answer` (docs/todo/agent-engines/0008-opencode-v2.md,
 * build plan phase 4).
 *
 * 2.x asks every question through a form: the `question` tool creates one
 * (`metadata.kind: "question"`, one `string` or `multiselect` field per
 * question, `custom: true`), and plugins and MCP servers can create their own
 * with any `Form.Field` kind. Each field becomes one card question:
 *
 * | Field         | Card question                                              |
 * | ------------- | ---------------------------------------------------------- |
 * | `string`      | free text; with `options`, a choice (free text if `custom`) |
 * | `multiselect` | a multiple choice (free text if `custom`)                  |
 * | `boolean`     | a Yes / No choice                                          |
 * | `number`, `integer` | free text, parsed and range-checked before sending   |
 * | `external`    | "Done" once the user has visited the field's URL          |
 * | anything else | free text, sent as a string for the server to judge        |
 *
 * Nothing is ever answered for the user: a field the card cannot express
 * well degrades to free text, a form the card cannot hold at all (too many
 * fields) is shown with its confirm disabled so it can only be declined, and
 * an answer that does not fit its field is refused here before anything is
 * sent. The server validates again (`Form.InvalidAnswerError`), and a refusal
 * there leaves the card pending.
 *
 * Hidden fields are not shown. One with a `default` is answered with it (the
 * form's own author chose that value); one without is left out, which the
 * server accepts unless it is required, in which case it is shown after all.
 * Conditional fields (`when`) are shown as optional with their condition in
 * the description; an answer to a field whose condition is not met is
 * dropped rather than sent, because the server refuses answers to inactive
 * fields.
 */
import {
  AGENT_INTERACTION_LIMITS,
  type AgentInteractionOption,
  type AgentInteractionQuestion,
  type AgentInteractionQuestionAnswer,
} from "@orkestrator/protocol/agent-interactions";
import { asRecord, nonEmptyString, opaqueOptionId } from "../agent-provider-runtime.js";

export type OpenCode2FormValue = string | number | boolean | string[];

/** How one card question becomes a form value. Adapter-only; never presented. */
type FieldBinding =
  | { kind: "string"; key: string }
  | { kind: "multiselect"; key: string }
  | { kind: "boolean"; key: string }
  | { kind: "number"; key: string; integer: boolean; minimum?: number; maximum?: number }
  | { kind: "external"; key: string };

type Condition = { key: string; op: "eq" | "neq"; value: string | number | boolean };

export interface OpenCode2FormCard {
  title: string;
  body?: string;
  url?: string;
  questions: AgentInteractionQuestion[];
  /** A form the card cannot hold: it can only be declined. */
  confirmDisabled?: true;
  /** Exact values per question id, plus the defaults of hidden fields. */
  binding: OpenCode2FormBinding;
}

export interface OpenCode2FormBinding {
  fields: Map<string, FieldBinding & { conditions: Condition[] }>;
  /** Hidden fields answered with their author's default. */
  defaults: Array<{ key: string; value: OpenCode2FormValue; conditions: Condition[] }>;
}

const MAX_TITLE = 512;
const MAX_DESCRIPTION = 4_096;
/** Options listed in a degraded free-text question's description. */
const MAX_LISTED_OPTIONS = 64;

function bounded(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function defaultValue(field: Record<string, unknown>): OpenCode2FormValue | undefined {
  const value = field.default;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (finiteNumber(value) !== undefined) return value as number;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return [...(value as string[])];
  }
  return undefined;
}

function conditions(field: Record<string, unknown>): Condition[] {
  if (!Array.isArray(field.when)) return [];
  return field.when.flatMap((entry) => {
    const when = asRecord(entry);
    const key = nonEmptyString(when?.key);
    const value = when?.value;
    if (
      !key ||
      (when?.op !== "eq" && when?.op !== "neq") ||
      (typeof value !== "string" && typeof value !== "boolean" && finiteNumber(value) === undefined)
    ) {
      return [];
    }
    return [{ key, op: when.op, value: value as string | number | boolean }];
  });
}

function conditionText(conditions: readonly Condition[], titles: ReadonlyMap<string, string>) {
  if (conditions.length === 0) return undefined;
  return `Only applies when ${conditions
    .map(
      (condition) =>
        `"${titles.get(condition.key) ?? condition.key}" ${condition.op === "eq" ? "is" : "is not"} ${String(condition.value)}`,
    )
    .join(" and ")}.`;
}

function options(raw: unknown, questionIndex: number): AgentInteractionOption[] | null {
  if (!Array.isArray(raw)) return [];
  if (raw.length > AGENT_INTERACTION_LIMITS.maxOptionsPerQuestion) return null;
  const seen = new Set<string>();
  const mapped: AgentInteractionOption[] = [];
  for (const [optionIndex, entry] of raw.entries()) {
    const option = asRecord(entry);
    const value = typeof option?.value === "string" ? option.value : undefined;
    const label = nonEmptyString(option?.label) ?? value;
    if (value === undefined || !label || seen.has(value)) return null;
    if (value.length > AGENT_INTERACTION_LIMITS.maxProviderValueLength) return null;
    seen.add(value);
    const description = nonEmptyString(option?.description);
    mapped.push({
      id: opaqueOptionId(questionIndex, optionIndex),
      label: bounded(label, MAX_TITLE),
      providerValue: value,
      ...(description ? { description: bounded(description, MAX_DESCRIPTION) } : {}),
    });
  }
  return mapped;
}

/** Option values listed in a description when there are too many to offer as choices. */
function listedValues(raw: unknown): string | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const values = raw
    .slice(0, MAX_LISTED_OPTIONS)
    .map((entry) => asRecord(entry)?.value)
    .filter((value): value is string => typeof value === "string");
  const more =
    raw.length > MAX_LISTED_OPTIONS ? `, and ${raw.length - MAX_LISTED_OPTIONS} more` : "";
  return `Allowed values: ${values.join(", ")}${more}.`;
}

function range(field: Record<string, unknown>): string | undefined {
  const minimum = finiteNumber(field.minimum);
  const maximum = finiteNumber(field.maximum);
  if (minimum !== undefined && maximum !== undefined) return `Between ${minimum} and ${maximum}.`;
  if (minimum !== undefined) return `At least ${minimum}.`;
  if (maximum !== undefined) return `At most ${maximum}.`;
  return undefined;
}

function joinDescription(parts: Array<string | null | undefined>): string | undefined {
  const text = parts.filter((part): part is string => !!part).join(" ");
  return text ? bounded(text, MAX_DESCRIPTION) : undefined;
}

/**
 * The card for one form, or null when `raw` is not a form at all (then the
 * whole interaction read fails rather than guessing). A form that is valid
 * but cannot be shown is returned with `confirmDisabled`.
 */
export function openCode2FormCard(raw: unknown): OpenCode2FormCard | null {
  const form = asRecord(raw);
  const title = nonEmptyString(form?.title);
  if (!form || !title || !Array.isArray(form.fields) || form.fields.length === 0) return null;
  const fields = form.fields.map(asRecord);
  if (fields.some((field) => !field || !nonEmptyString(field.key))) return null;
  const isQuestionTool = asRecord(form.metadata)?.kind === "question";
  const cardTitle = isQuestionTool ? "OpenCode needs input" : bounded(title, MAX_TITLE);
  const binding: OpenCode2FormBinding = { fields: new Map(), defaults: [] };
  const shown = fields.filter((field) => {
    if (field!.hidden !== true) return true;
    const value = defaultValue(field!);
    if (value !== undefined) {
      binding.defaults.push({ key: String(field!.key), value, conditions: conditions(field!) });
      return false;
    }
    return field!.required === true;
  }) as Record<string, unknown>[];
  if (shown.length > AGENT_INTERACTION_LIMITS.maxQuestionsPerRequest) {
    return refusedCard(
      cardTitle,
      `This form has ${shown.length} fields; Orkestrator can show at most ${AGENT_INTERACTION_LIMITS.maxQuestionsPerRequest}. Decline it, or stop the turn.`,
    );
  }
  const titles = new Map(
    fields.map((field) => [
      String(field!.key),
      nonEmptyString(field!.title) ?? nonEmptyString(field!.description) ?? String(field!.key),
    ]),
  );
  let url: string | undefined;
  const questions: AgentInteractionQuestion[] = [];
  for (const [index, field] of shown.entries()) {
    const key = String(field.key);
    const id = `f${index}`;
    const fieldTitle = nonEmptyString(field.title);
    const fieldDescription = nonEmptyString(field.description);
    // The question tool puts the question in `description` and its short
    // header in `title`; any other form names the field in `title`.
    const prompt = bounded(
      (isQuestionTool ? fieldDescription : fieldTitle) ?? fieldTitle ?? fieldDescription ?? key,
      MAX_DESCRIPTION,
    );
    const lead = isQuestionTool ? fieldTitle : fieldTitle ? fieldDescription : undefined;
    const when = conditions(field);
    // A question-tool question is always asked to be answered (dismissing the
    // card declines the whole form); a conditional field cannot be required
    // because the card cannot hide it when its condition is unmet.
    const required = (field.required === true || isQuestionTool) && when.length === 0;
    const condition = conditionText(when, titles);
    const base = { id, prompt, required, secret: false };
    if (field.type === "boolean") {
      questions.push({
        ...base,
        description: joinDescription([lead, condition]),
        multiple: false,
        allowFreeText: false,
        options: [
          { id: opaqueOptionId(index, 0), label: "Yes", providerValue: "true" },
          { id: opaqueOptionId(index, 1), label: "No", providerValue: "false" },
        ],
      });
      binding.fields.set(id, { kind: "boolean", key, conditions: when });
      continue;
    }
    if (field.type === "number" || field.type === "integer") {
      questions.push({
        ...base,
        description: joinDescription([
          lead,
          field.type === "integer" ? "A whole number." : "A number.",
          range(field),
          condition,
        ]),
        multiple: false,
        allowFreeText: true,
        options: [],
      });
      binding.fields.set(id, {
        kind: "number",
        key,
        integer: field.type === "integer",
        ...(finiteNumber(field.minimum) !== undefined ? { minimum: field.minimum as number } : {}),
        ...(finiteNumber(field.maximum) !== undefined ? { maximum: field.maximum as number } : {}),
        conditions: when,
      });
      continue;
    }
    if (field.type === "external") {
      const target = nonEmptyString(field.url);
      url ??= target ?? undefined;
      questions.push({
        ...base,
        // The server requires every external field to be acknowledged.
        required: true,
        description: joinDescription([
          lead,
          target ? `Open ${bounded(target, 1_024)} and finish there first.` : undefined,
        ]),
        multiple: false,
        allowFreeText: false,
        options: [{ id: opaqueOptionId(index, 0), label: "Done", providerValue: "true" }],
      });
      binding.fields.set(id, { kind: "external", key, conditions: [] });
      continue;
    }
    const multiple = field.type === "multiselect";
    const known = field.type === "string" || multiple;
    const mapped = known ? options(field.options, index) : [];
    const custom = field.custom === true || !Array.isArray(field.options);
    if (mapped === null) {
      // Too many (or malformed) choices to offer: free text, values listed.
      questions.push({
        ...base,
        description: joinDescription([
          lead,
          listedValues(field.options),
          multiple ? "Separate several values with commas or new lines." : undefined,
          condition,
        ]),
        multiple: false,
        allowFreeText: true,
        options: [],
      });
      binding.fields.set(id, { kind: multiple ? "multiselect" : "string", key, conditions: when });
      continue;
    }
    questions.push({
      ...base,
      description: joinDescription([
        lead,
        known ? undefined : "Answered as text.",
        typeof field.placeholder === "string" && mapped.length === 0
          ? `For example: ${bounded(field.placeholder, 256)}.`
          : undefined,
        condition,
      ]),
      multiple,
      allowFreeText: custom || mapped.length === 0,
      options: mapped,
    });
    binding.fields.set(id, { kind: multiple ? "multiselect" : "string", key, conditions: when });
  }
  return {
    title: cardTitle,
    ...(isQuestionTool ? {} : { body: bounded(title, MAX_DESCRIPTION) }),
    ...(url ? { url } : {}),
    questions,
    binding,
  };
}

function refusedCard(title: string, body: string): OpenCode2FormCard {
  return {
    title,
    body,
    // The card contract needs one question; it can never be submitted.
    questions: [
      {
        id: "f0",
        prompt: "This form cannot be answered here.",
        required: false,
        multiple: false,
        secret: false,
        allowFreeText: true,
        options: [],
      },
    ],
    confirmDisabled: true,
    binding: { fields: new Map(), defaults: [] },
  };
}

export type OpenCode2FormAnswerResult =
  { ok: true; answer: Record<string, OpenCode2FormValue> } | { ok: false; reason: string };

function matches(condition: Condition, value: OpenCode2FormValue | undefined): boolean {
  if (value === undefined) return false;
  const hit = Array.isArray(value)
    ? value.some((item) => item === condition.value)
    : value === condition.value;
  return condition.op === "eq" ? hit : !hit;
}

/**
 * Encode validated card answers (already checked against the card by
 * `isAgentInteractionResolution`) as a `Form.Answer`. Refuses anything that
 * does not fit its field instead of sending a guess.
 */
export function openCode2FormAnswer(
  card: Pick<OpenCode2FormCard, "questions" | "binding" | "confirmDisabled">,
  answers: readonly AgentInteractionQuestionAnswer[],
): OpenCode2FormAnswerResult {
  if (card.confirmDisabled) return { ok: false, reason: "form cannot be answered here" };
  const byQuestion = new Map(answers.map((answer) => [answer.questionId, answer]));
  const answer: Record<string, OpenCode2FormValue> = {};
  const pending: Array<{ key: string; value: OpenCode2FormValue; conditions: Condition[] }> = [
    ...card.binding.defaults,
  ];
  for (const question of card.questions) {
    const binding = card.binding.fields.get(question.id);
    const given = byQuestion.get(question.id);
    if (!binding) return { ok: false, reason: "unknown question" };
    if (!given) continue;
    const values = new Map(question.options.map((option) => [option.id, option.providerValue]));
    const chosen = (given.optionIds ?? []).map((id) => values.get(id));
    if (chosen.some((value) => value === undefined)) return { ok: false, reason: "unknown option" };
    const text = given.freeText;
    let value: OpenCode2FormValue | undefined;
    switch (binding.kind) {
      case "boolean":
      case "external":
        if (chosen.length !== 1 || text !== undefined) return { ok: false, reason: "one choice" };
        value = binding.kind === "external" ? true : chosen[0] === "true";
        break;
      case "number": {
        if (chosen.length > 0 || text === undefined) return { ok: false, reason: "a number" };
        const trimmed = text.trim();
        const parsed = trimmed === "" ? Number.NaN : Number(trimmed);
        if (!Number.isFinite(parsed)) return { ok: false, reason: "not a number" };
        if (binding.integer && !Number.isInteger(parsed)) return { ok: false, reason: "integer" };
        if (binding.minimum !== undefined && parsed < binding.minimum) {
          return { ok: false, reason: "too small" };
        }
        if (binding.maximum !== undefined && parsed > binding.maximum) {
          return { ok: false, reason: "too large" };
        }
        value = parsed;
        break;
      }
      case "multiselect": {
        const typed =
          text === undefined
            ? []
            : question.options.length === 0
              ? text
                  .split(/[\n,]/)
                  .map((item) => item.trim())
                  .filter((item) => item.length > 0)
              : [text];
        value = [...(chosen as string[]), ...typed];
        break;
      }
      case "string":
        if (chosen.length > 1 || (chosen.length === 1 && text !== undefined)) {
          return { ok: false, reason: "one value" };
        }
        value = chosen.length === 1 ? (chosen[0] as string) : (text ?? "");
        break;
    }
    pending.push({ key: binding.key, value, conditions: binding.conditions });
  }
  for (const entry of pending) answer[entry.key] = entry.value;
  // An answer to a field whose condition is unmet is refused by the server.
  // Dropping one can only make more conditions unmet (an absent value matches
  // neither `eq` nor `neq`), so repeating until nothing changes settles them.
  for (let changed = true; changed;) {
    changed = false;
    for (const entry of pending) {
      if (!(entry.key in answer)) continue;
      if (!entry.conditions.every((condition) => matches(condition, answer[condition.key]))) {
        delete answer[entry.key];
        changed = true;
      }
    }
  }
  return { ok: true, answer };
}
