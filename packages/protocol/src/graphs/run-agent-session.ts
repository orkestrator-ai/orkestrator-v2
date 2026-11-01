/**
 * The agent branch state a graph agent activation keeps in its session
 * (item 204, report §8.1, §8.3), and the `ask_human` question it may pause on
 * (D15, report §6.5).
 *
 * An agent activation runs on the shared agent branch runner: the dispatch
 * journal, the bounded schema repair, the one result reminder, the one
 * restart continuation and the stall clocks all have to survive a backend
 * restart, because the turn they describe keeps running inside the
 * environment. They live here, beside the session identity in
 * `GraphActivationSession`, so the run record stays the one authority
 * (invariant 1) and every field is bounded (invariant 6).
 *
 * A question is the only part a person writes: the answer is untrusted text,
 * bounded, and reaches the agent inside an evidence frame. A malformed answer
 * is refused, never delivered (root invariant 10).
 *
 * Browser-safe.
 */
import {
  FieldErrorCollector,
  checkArray,
  checkEnum,
  checkFiniteNumber,
  checkString,
  isPlainRecord,
  joinPath,
} from "../field-validation.js";
import { isWorkflowResultSubmissionState } from "../workflow-results.js";
import { checkBoundedJson } from "./grammar.js";
import { parseUtcTimestamp } from "../workflow-snapshot.js";
import type { WorkflowResultSubmissionState } from "../workflow-results.js";

const KIB = 1024;

export const GRAPH_AGENT_SESSION_BOUNDS = Object.freeze({
  /** A schema repair prompt quotes the port schemas and bounded issues. */
  maxRepairPromptChars: 192 * KIB,
  /** Reminders, restart continuations and answers stay well below this. */
  maxContinuationPromptChars: 16 * KIB,
  maxRepairAttempts: 16,
  maxPolls: 64,
  maxShortTextChars: 256,
  maxSandboxReasonChars: 1_024,
} as const);

/** Provisional `report_progress` entries (report §5.5): progress, never consumed downstream. */
export const GRAPH_AGENT_PROGRESS_BOUNDS = Object.freeze({
  maxItems: 50,
  /** Canonical JSON bytes of one entry's item. */
  maxItemBytes: 8 * KIB,
  maxItemDepth: 16,
} as const);

export const GRAPH_AGENT_QUESTION_BOUNDS = Object.freeze({
  /** Questions one activation may ask, over its whole life. */
  maxQuestions: 8,
  maxQuestionChars: 4_000,
  maxChoices: 8,
  maxChoiceChars: 200,
  maxAnswerChars: 8_000,
} as const);

/** How a turn was dispatched: read-only turns hold each provider's strongest boundary. */
export const GRAPH_AGENT_TURN_MODES = ["read-only", "build"] as const;
export type GraphAgentTurnMode = (typeof GRAPH_AGENT_TURN_MODES)[number];

export const GRAPH_AGENT_ANSWER_KINDS = ["answered", "declined"] as const;
export type GraphAgentAnswerKind = (typeof GRAPH_AGENT_ANSWER_KINDS)[number];
export const GRAPH_AGENT_ANSWERERS = ["user", "coordinator"] as const;
export type GraphAgentAnswerer = (typeof GRAPH_AGENT_ANSWERERS)[number];
/** `tool`: the waiting `ask_human` call returned it; `turn`: a new turn in the same session carried it. */
export const GRAPH_AGENT_ANSWER_DELIVERIES = ["tool", "turn"] as const;
export type GraphAgentAnswerDelivery = (typeof GRAPH_AGENT_ANSWER_DELIVERIES)[number];

export interface GraphAgentAnswer {
  /** `declined`: the person chose not to answer; the agent decides and says what it assumed. */
  kind: GraphAgentAnswerKind;
  /** The answer, untrusted, at most {@link GRAPH_AGENT_QUESTION_BOUNDS.maxAnswerChars}. */
  text?: string;
  /** One of the question's `choices`, when it offered some. */
  choice?: string;
  at: string;
  by: GraphAgentAnswerer;
}

/** An `ask_human` question (D15). The activation is `awaiting-human` until it is answered. */
export interface GraphAgentQuestion {
  /** A UUID; the answer names it, so a stale answer cannot reach a newer question. */
  id: string;
  text: string;
  choices?: string[];
  askedAt: string;
  /** The request (turn) the question was asked in. */
  requestId: string;
  answer?: GraphAgentAnswer;
  delivered?: GraphAgentAnswerDelivery;
}

/**
 * One entry an agent reported with `report_progress`: an element of an output
 * type's `items` list, shown as provisional progress and replaced by the
 * accepted result.
 */
export interface GraphAgentProgressItem {
  /** Digest of port and item, so a retried call cannot add it twice. */
  id: string;
  port: string;
  reportedAt: string;
  item: unknown;
}

/** The agent branch fields of a graph activation's session (all optional). */
export interface GraphAgentSessionState {
  /** The provider session key; stable across restarts. */
  sessionKey?: string;
  agentStarted?: boolean;
  /** The activation whose provider session this one continues (`session: "continue"`). */
  continuedFrom?: string;
  turnMode?: GraphAgentTurnMode;
  startedAt?: string;
  resultSubmission?: WorkflowResultSubmissionState;
  repairAttempts?: number;
  repairPrompt?: string;
  continuationPrompt?: string;
  reminderSent?: boolean;
  restartContinuationSent?: boolean;
  idlePolls?: number;
  usagePolls?: number;
  progressAt?: string;
  progressDigest?: string;
  stalledSince?: string;
  /** Why the turn's commands ran without the provider's sandbox, as reported. */
  commandSandboxOff?: string;
  question?: GraphAgentQuestion;
  /** Questions asked so far (≤ {@link GRAPH_AGENT_QUESTION_BOUNDS.maxQuestions}). */
  questionsAsked?: number;
  /** Provisional entries reported so far, oldest first (≤ {@link GRAPH_AGENT_PROGRESS_BOUNDS.maxItems}). */
  progress?: GraphAgentProgressItem[];
}

export const GRAPH_AGENT_SESSION_FIELDS = [
  "sessionKey",
  "agentStarted",
  "continuedFrom",
  "turnMode",
  "startedAt",
  "resultSubmission",
  "repairAttempts",
  "repairPrompt",
  "continuationPrompt",
  "reminderSent",
  "restartContinuationSent",
  "idlePolls",
  "usagePolls",
  "progressAt",
  "progressDigest",
  "stalledSince",
  "commandSandboxOff",
  "question",
  "questionsAsked",
  "progress",
] as const satisfies readonly (keyof GraphAgentSessionState)[];

const QUESTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Control characters other than tab, line feed and carriage return. */
const PROSE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const LINE_CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

function checkProse(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  max: number,
): value is string {
  if (!checkString(value, path, errors, { min: 1, max })) return false;
  if (PROSE_CONTROL.test(value)) {
    errors.add(path, "control_character", "Must not contain control characters");
    return false;
  }
  return true;
}

function checkLine(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  max: number,
): value is string {
  if (!checkString(value, path, errors, { min: 1, max })) return false;
  if (LINE_CONTROL.test(value)) {
    errors.add(path, "control_character", "Must not contain control characters");
    return false;
  }
  return true;
}

function checkWhen(value: unknown, path: string, errors: FieldErrorCollector): void {
  if (typeof value !== "string" || value.length > 40 || parseUtcTimestamp(value) === null) {
    errors.add(path, "timestamp", "Expected an RFC 3339 UTC timestamp");
  }
}

function checkPolls(value: unknown, path: string, errors: FieldErrorCollector, max: number): void {
  checkFiniteNumber(value, path, errors, { integer: true, min: 0, max });
}

function checkAnswer(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  choices: readonly string[] | undefined,
): void {
  if (!isPlainRecord(value)) {
    errors.add(path, "type", "Expected an object");
    return;
  }
  for (const key of Object.keys(value)) {
    if (!["kind", "text", "choice", "at", "by"].includes(key)) {
      errors.add(joinPath(path, key), "unknown_field", "Unknown field");
    }
  }
  checkEnum(value.kind, joinPath(path, "kind"), errors, GRAPH_AGENT_ANSWER_KINDS);
  if (value.text !== undefined) {
    checkProse(
      value.text,
      joinPath(path, "text"),
      errors,
      GRAPH_AGENT_QUESTION_BOUNDS.maxAnswerChars,
    );
  }
  if (value.choice !== undefined) {
    if (
      checkLine(
        value.choice,
        joinPath(path, "choice"),
        errors,
        GRAPH_AGENT_QUESTION_BOUNDS.maxChoiceChars,
      ) &&
      !(choices ?? []).includes(value.choice)
    ) {
      errors.add(joinPath(path, "choice"), "mismatch", "Must be one of the question's choices");
    }
  }
  if (value.kind === "answered" && value.text === undefined && value.choice === undefined) {
    errors.add(joinPath(path, "text"), "required", "An answer needs text or a choice");
  }
  checkWhen(value.at, joinPath(path, "at"), errors);
  checkEnum(value.by, joinPath(path, "by"), errors, GRAPH_AGENT_ANSWERERS);
}

function checkQuestion(value: unknown, path: string, errors: FieldErrorCollector): void {
  if (!isPlainRecord(value)) {
    errors.add(path, "type", "Expected an object");
    return;
  }
  for (const key of Object.keys(value)) {
    if (!["id", "text", "choices", "askedAt", "requestId", "answer", "delivered"].includes(key)) {
      errors.add(joinPath(path, key), "unknown_field", "Unknown field");
    }
  }
  if (typeof value.id !== "string" || !QUESTION_ID.test(value.id)) {
    errors.add(joinPath(path, "id"), "pattern", "Must be a UUID");
  }
  checkProse(
    value.text,
    joinPath(path, "text"),
    errors,
    GRAPH_AGENT_QUESTION_BOUNDS.maxQuestionChars,
  );
  let choices: string[] | undefined;
  if (value.choices !== undefined) {
    const choicesPath = joinPath(path, "choices");
    if (
      checkArray(value.choices, choicesPath, errors, {
        min: 1,
        max: GRAPH_AGENT_QUESTION_BOUNDS.maxChoices,
      })
    ) {
      const seen = new Set<string>();
      value.choices.forEach((choice, index) => {
        const choicePath = joinPath(choicesPath, index);
        if (!checkLine(choice, choicePath, errors, GRAPH_AGENT_QUESTION_BOUNDS.maxChoiceChars))
          return;
        if (seen.has(choice)) errors.add(choicePath, "duplicate", "Duplicate choice");
        seen.add(choice);
      });
      choices = value.choices as string[];
    }
  }
  checkWhen(value.askedAt, joinPath(path, "askedAt"), errors);
  checkLine(value.requestId, joinPath(path, "requestId"), errors, 128);
  if (value.answer !== undefined)
    checkAnswer(value.answer, joinPath(path, "answer"), errors, choices);
  if (value.delivered !== undefined) {
    checkEnum(value.delivered, joinPath(path, "delivered"), errors, GRAPH_AGENT_ANSWER_DELIVERIES);
    if (value.answer === undefined) {
      errors.add(joinPath(path, "delivered"), "mismatch", "Only an answered question is delivered");
    }
  }
}

/** Checks the agent branch fields of a session object (unknown fields are the caller's). */
export function checkGraphAgentSessionFields(
  value: Record<string, unknown>,
  path: string,
  errors: FieldErrorCollector,
): void {
  if (value.agentStarted !== undefined && typeof value.agentStarted !== "boolean") {
    errors.add(joinPath(path, "agentStarted"), "type", "Expected a boolean");
  }
  const B = GRAPH_AGENT_SESSION_BOUNDS;
  const field = (name: string) => joinPath(path, name);
  if (value.sessionKey !== undefined) {
    checkLine(value.sessionKey, field("sessionKey"), errors, B.maxShortTextChars);
  }
  if (value.continuedFrom !== undefined) {
    checkLine(value.continuedFrom, field("continuedFrom"), errors, B.maxShortTextChars);
  }
  if (value.turnMode !== undefined) {
    checkEnum(value.turnMode, field("turnMode"), errors, GRAPH_AGENT_TURN_MODES);
  }
  for (const name of ["startedAt", "progressAt", "stalledSince"] as const) {
    if (value[name] !== undefined) checkWhen(value[name], field(name), errors);
  }
  if (
    value.resultSubmission !== undefined &&
    !isWorkflowResultSubmissionState(value.resultSubmission)
  ) {
    errors.add(field("resultSubmission"), "enum", "Expected a result submission state");
  }
  if (value.repairAttempts !== undefined) {
    checkPolls(value.repairAttempts, field("repairAttempts"), errors, B.maxRepairAttempts);
  }
  if (value.repairPrompt !== undefined) {
    checkProse(value.repairPrompt, field("repairPrompt"), errors, B.maxRepairPromptChars);
  }
  if (value.continuationPrompt !== undefined) {
    checkProse(
      value.continuationPrompt,
      field("continuationPrompt"),
      errors,
      B.maxContinuationPromptChars,
    );
  }
  for (const name of ["reminderSent", "restartContinuationSent"] as const) {
    if (value[name] !== undefined && typeof value[name] !== "boolean") {
      errors.add(field(name), "type", "Expected a boolean");
    }
  }
  for (const name of ["idlePolls", "usagePolls"] as const) {
    if (value[name] !== undefined) checkPolls(value[name], field(name), errors, B.maxPolls);
  }
  if (value.progressDigest !== undefined) {
    checkLine(value.progressDigest, field("progressDigest"), errors, B.maxShortTextChars);
  }
  if (value.commandSandboxOff !== undefined) {
    checkProse(
      value.commandSandboxOff,
      field("commandSandboxOff"),
      errors,
      B.maxSandboxReasonChars,
    );
  }
  if (value.question !== undefined) checkQuestion(value.question, field("question"), errors);
  if (value.progress !== undefined) checkProgress(value.progress, field("progress"), errors);
  if (value.questionsAsked !== undefined) {
    checkPolls(
      value.questionsAsked,
      field("questionsAsked"),
      errors,
      GRAPH_AGENT_QUESTION_BOUNDS.maxQuestions,
    );
  }
}

function checkProgress(value: unknown, path: string, errors: FieldErrorCollector): void {
  if (!checkArray(value, path, errors, { max: GRAPH_AGENT_PROGRESS_BOUNDS.maxItems })) return;
  value.forEach((entry, index) => {
    const entryPath = joinPath(path, index);
    if (!isPlainRecord(entry)) {
      errors.add(entryPath, "type", "Expected an object");
      return;
    }
    for (const key of Object.keys(entry)) {
      if (!["id", "port", "reportedAt", "item"].includes(key)) {
        errors.add(joinPath(entryPath, key), "unknown_field", "Unknown field");
      }
    }
    checkLine(entry.id, joinPath(entryPath, "id"), errors, 128);
    checkLine(entry.port, joinPath(entryPath, "port"), errors, 64);
    checkWhen(entry.reportedAt, joinPath(entryPath, "reportedAt"), errors);
    checkBoundedJson(entry.item, joinPath(entryPath, "item"), errors, {
      maxBytes: GRAPH_AGENT_PROGRESS_BOUNDS.maxItemBytes,
      maxDepth: GRAPH_AGENT_PROGRESS_BOUNDS.maxItemDepth,
    });
  });
}

/** A question waiting for its answer. */
export function isGraphAgentQuestionOpen(question: GraphAgentQuestion | undefined): boolean {
  return question !== undefined && question.answer === undefined;
}

/** An answered question the agent has not received yet. */
export function isGraphAgentAnswerUndelivered(question: GraphAgentQuestion | undefined): boolean {
  return question?.answer !== undefined && question.delivered === undefined;
}

/**
 * Why `answer` cannot answer `question`, or null. The answer command uses it,
 * so a malformed, oversized or stale answer is refused and never delivered.
 */
export function graphAgentAnswerProblem(
  question: GraphAgentQuestion | undefined,
  questionId: unknown,
  answer: unknown,
): string | null {
  if (!question) return "The activation has no question waiting";
  if (questionId !== question.id) return "The answer names another question";
  if (question.answer !== undefined) return "The question was already answered";
  const errors = new FieldErrorCollector();
  checkAnswer(answer, "answer", errors, question.choices);
  const first = errors.errors[0];
  return first ? `${first.path}: ${first.message}` : null;
}
