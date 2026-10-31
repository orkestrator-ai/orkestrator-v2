/**
 * The user-confirmed answer relay: a coordinator proposes an answer to a
 * question a delegated worker is waiting on, and only the user's approval in
 * Orkestrator sends it (`answer_worker_question`, node action request kind
 * `answer-worker-question`; see `docs/architecture/coordinator.md`,
 * "Answering a worker's question").
 *
 * Only `question` interactions are relayed. Approvals and permissions
 * (commands, files, plans, tool permissions) stay with the person in the
 * worker's tab, and so do MCP forms, URLs, elicitations, terminal selections
 * and any question that asks for a secret.
 *
 * The request record carries a bounded copy of the question, which the user
 * reads in the dialog, and the proposed answer the user may edit. Nothing
 * else (receipts, logs, notices) carries the answer.
 */

import type {
  AgentInteractionQuestionAnswer,
  AgentInteractionRequest,
} from "./agent-interactions.js";

/** The one interaction kind a coordinator may propose an answer to. */
export const WORKER_QUESTION_RELAY_KIND = "question" as const;

export const WORKER_QUESTION_RELAY_LIMITS = Object.freeze({
  questions: 16,
  options: 32,
  titleChars: 500,
  promptChars: 2_000,
  descriptionChars: 500,
  labelChars: 200,
  idChars: 512,
  freeTextChars: 16_384,
  /** Total answer text across every question, matching the provider limit. */
  answerTextChars: 16_384,
  tabNameChars: 200,
} as const);

export interface WorkerQuestionOptionView {
  id: string;
  label: string;
  description?: string;
}

export interface WorkerQuestionView {
  id: string;
  prompt: string;
  description?: string;
  required: boolean;
  multiple: boolean;
  allowFreeText: boolean;
  options: WorkerQuestionOptionView[];
}

/**
 * The question a request asks the user to answer, as it was when the
 * coordinator proposed its answer, and that proposal. `revision` is the
 * interaction's revision then: an approval answers only that revision.
 */
export interface WorkerQuestionRelay {
  tabId: string;
  tabName?: string;
  interactionId: string;
  revision: number;
  title: string;
  questions: WorkerQuestionView[];
  proposed: AgentInteractionQuestionAnswer[];
}

/** Why a pending interaction cannot be relayed, or null when it can. */
export function workerQuestionRefusal(request: AgentInteractionRequest): string | null {
  if (request.kind !== WORKER_QUESTION_RELAY_KIND) {
    return ["plan-approval", "command-approval", "file-approval", "permission"].includes(
      request.kind,
    )
      ? `That is a ${request.kind} request. Only the user approves or denies it, in the worker's tab; answer_worker_question relays answers to questions only.`
      : `That is a ${request.kind} request, which the user completes in the worker's tab; answer_worker_question relays answers to questions only.`;
  }
  if (request.presentation.questions.some((question) => question.secret))
    return "That question asks for a secret value. The user answers it in the worker's tab; never ask them to send it through chat.";
  if (request.presentation.questions.length === 0)
    return "That question has nothing to answer; the user handles it in the worker's tab.";
  if (request.presentation.questions.length > WORKER_QUESTION_RELAY_LIMITS.questions)
    return "That question has too many parts to relay; the user answers it in the worker's tab.";
  return null;
}

/** The bounded copy of a relayable question the user reads while approving. */
export function workerQuestionViews(request: AgentInteractionRequest): WorkerQuestionView[] {
  const limits = WORKER_QUESTION_RELAY_LIMITS;
  return request.presentation.questions.slice(0, limits.questions).map((question) => ({
    id: question.id,
    prompt: question.prompt.slice(0, limits.promptChars),
    ...(question.description
      ? { description: question.description.slice(0, limits.descriptionChars) }
      : {}),
    required: question.required,
    multiple: question.multiple,
    allowFreeText: question.allowFreeText,
    options: question.options.slice(0, limits.options).map((option) => ({
      id: option.id,
      label: option.label.slice(0, limits.labelChars),
      ...(option.description
        ? { description: option.description.slice(0, limits.descriptionChars) }
        : {}),
    })),
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedId(value: unknown, name: string): string {
  if (typeof value !== "string" || !value || value.length > WORKER_QUESTION_RELAY_LIMITS.idChars)
    throw new Error(`Expected ${name}.`);
  return value;
}

/**
 * Bounded, shape-checked answers; unknown fields are refused. This checks
 * the shape only; `workerQuestionAnswerProblem` checks them against the
 * question.
 */
export function parseWorkerQuestionAnswers(value: unknown): AgentInteractionQuestionAnswer[] {
  const limits = WORKER_QUESTION_RELAY_LIMITS;
  if (!Array.isArray(value) || value.length === 0 || value.length > limits.questions)
    throw new Error(`Expected answers for 1-${limits.questions} questions.`);
  let textChars = 0;
  return value.map((raw) => {
    if (!isRecord(raw)) throw new Error("Each answer is an object.");
    for (const key of Object.keys(raw)) {
      if (!["questionId", "optionIds", "freeText"].includes(key))
        throw new Error(`Unknown answer field: ${key.slice(0, 64)}.`);
    }
    const questionId = boundedId(raw.questionId, "questionId");
    let optionIds: string[] | undefined;
    if (raw.optionIds !== undefined) {
      if (!Array.isArray(raw.optionIds) || raw.optionIds.length > limits.options)
        throw new Error(`optionIds lists at most ${limits.options} options.`);
      optionIds = raw.optionIds.map((id) => boundedId(id, "an option id"));
    }
    let freeText: string | undefined;
    if (raw.freeText !== undefined) {
      if (typeof raw.freeText !== "string" || raw.freeText.length > limits.freeTextChars)
        throw new Error(`freeText is at most ${limits.freeTextChars} characters.`);
      freeText = raw.freeText;
      textChars += freeText.length;
    }
    if (textChars > limits.answerTextChars)
      throw new Error(`The answer text is at most ${limits.answerTextChars} characters in all.`);
    return {
      questionId,
      ...(optionIds ? { optionIds } : {}),
      ...(freeText !== undefined ? { freeText } : {}),
    };
  });
}

/**
 * Why `answers` does not answer `questions`, or null when it does: every
 * required question has a chosen option or text, options exist, a
 * single-choice question has at most one, free text only where the question
 * accepts it, and no answer for a question that is not asked.
 */
export function workerQuestionAnswerProblem(
  questions: readonly WorkerQuestionView[],
  answers: readonly AgentInteractionQuestionAnswer[],
): string | null {
  const byId = new Map(questions.map((question) => [question.id, question]));
  const seen = new Set<string>();
  for (const answer of answers) {
    const question = byId.get(answer.questionId);
    if (!question) return `There is no question ${answer.questionId.slice(0, 80)}.`;
    if (seen.has(answer.questionId))
      return `Question ${answer.questionId.slice(0, 80)} is answered twice.`;
    seen.add(answer.questionId);
    const options = new Set(question.options.map((option) => option.id));
    const unknown = answer.optionIds?.find((id) => !options.has(id));
    if (unknown !== undefined)
      return `Question ${question.id.slice(0, 80)} has no option ${unknown.slice(0, 80)}.`;
    if (!question.multiple && (answer.optionIds?.length ?? 0) > 1)
      return `Question ${question.id.slice(0, 80)} takes one option.`;
    if (answer.freeText !== undefined && !question.allowFreeText)
      return `Question ${question.id.slice(0, 80)} takes one of its options, not free text.`;
  }
  for (const question of questions) {
    if (!question.required) continue;
    const answer = answers.find((entry) => entry.questionId === question.id);
    if (!answer || ((answer.optionIds?.length ?? 0) === 0 && !answer.freeText?.trim()))
      return `Question ${question.id.slice(0, 80)} needs an answer.`;
  }
  return null;
}

/** A stored relay read back from a request record, bounded; null when malformed. */
export function parseWorkerQuestionRelay(value: unknown): WorkerQuestionRelay | null {
  const limits = WORKER_QUESTION_RELAY_LIMITS;
  if (!isRecord(value)) return null;
  try {
    const tabId = boundedId(value.tabId, "tabId");
    const interactionId = boundedId(value.interactionId, "interactionId");
    if (
      typeof value.revision !== "number" ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 0
    )
      return null;
    if (typeof value.title !== "string") return null;
    if (
      !Array.isArray(value.questions) ||
      value.questions.length === 0 ||
      value.questions.length > limits.questions
    )
      return null;
    const questions: WorkerQuestionView[] = value.questions.map((raw) => {
      if (!isRecord(raw) || typeof raw.prompt !== "string" || !Array.isArray(raw.options))
        throw new Error("question");
      if (raw.options.length > limits.options) throw new Error("options");
      return {
        id: boundedId(raw.id, "a question id"),
        prompt: raw.prompt.slice(0, limits.promptChars),
        ...(typeof raw.description === "string" && raw.description
          ? { description: raw.description.slice(0, limits.descriptionChars) }
          : {}),
        required: raw.required === true,
        multiple: raw.multiple === true,
        allowFreeText: raw.allowFreeText === true,
        options: raw.options.map((option) => {
          if (!isRecord(option) || typeof option.label !== "string") throw new Error("option");
          return {
            id: boundedId(option.id, "an option id"),
            label: option.label.slice(0, limits.labelChars),
            ...(typeof option.description === "string" && option.description
              ? { description: option.description.slice(0, limits.descriptionChars) }
              : {}),
          };
        }),
      };
    });
    const proposed = parseWorkerQuestionAnswers(value.proposed);
    if (workerQuestionAnswerProblem(questions, proposed)) return null;
    return {
      tabId,
      ...(typeof value.tabName === "string" && value.tabName
        ? { tabName: value.tabName.slice(0, limits.tabNameChars) }
        : {}),
      interactionId,
      revision: value.revision,
      title: value.title.slice(0, limits.titleChars),
      questions,
      proposed,
    };
  } catch {
    return null;
  }
}
