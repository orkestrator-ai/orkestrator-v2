/**
 * Structured view of a question tool call (Claude's `AskUserQuestion`, and any
 * provider tool sharing its `{ questions: [{ question, options }] }` shape),
 * so a transcript row can show the questions and the chosen answers instead of
 * the raw JSON arguments.
 */

export interface QuestionToolOption {
  label: string;
  description?: string;
}

export interface QuestionToolQuestion {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: QuestionToolOption[];
}

export interface QuestionToolAnsweredQuestion extends QuestionToolQuestion {
  /** Labels of the options the answer picked, in option order. */
  selectedLabels: string[];
  /** Answer values that match no option: an "Other" reply typed by the user. */
  customAnswers: string[];
  /** Whether an answer was recovered for this question at all. */
  answered: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * The questions carried by a tool call's arguments, or `null` when the
 * arguments are not question-shaped. Malformed entries are skipped rather than
 * failing the whole call, so one odd question still lets the rest render.
 */
export function parseQuestionToolArgs(
  toolArgs?: Record<string, unknown>,
): QuestionToolQuestion[] | null {
  if (!toolArgs || !Array.isArray(toolArgs.questions)) return null;
  const questions: QuestionToolQuestion[] = [];
  for (const candidate of toolArgs.questions) {
    if (!isRecord(candidate)) continue;
    const question = nonEmptyString(candidate.question);
    if (!question) continue;
    const options: QuestionToolOption[] = [];
    if (Array.isArray(candidate.options)) {
      for (const option of candidate.options) {
        if (typeof option === "string" && option.trim()) {
          options.push({ label: option });
          continue;
        }
        if (!isRecord(option)) continue;
        const label = nonEmptyString(option.label);
        if (!label) continue;
        const description = nonEmptyString(option.description);
        options.push(description ? { label, description } : { label });
      }
    }
    const header = nonEmptyString(candidate.header);
    questions.push({
      question,
      ...(header ? { header } : {}),
      // OpenCode spells the flag `multiple`.
      multiSelect: candidate.multiSelect === true || candidate.multiple === true,
      options,
    });
  }
  return questions.length > 0 ? questions : null;
}

const CONTINUE_SUFFIX = /"\s*\.\s*You can now continue/;
const ANNOTATION_SUFFIX = /"\s+(?:selected preview|user notes):/;

/**
 * Recover per-question answers from Claude's tool result, which reads
 * `…answered: "Question"="Answer", "Next"="Answer". You can now continue…`.
 *
 * Questions and answers are free text that may themselves contain quotes, so
 * each answer is bounded by the next question's marker rather than by the
 * first closing quote.
 */
export function parseQuestionToolOutput(
  questions: readonly QuestionToolQuestion[],
  output?: string,
): Map<string, string> {
  const answers = new Map<string, string>();
  if (!output) return answers;

  let cursor = 0;
  for (let index = 0; index < questions.length; index += 1) {
    const marker = `"${questions[index]!.question}"="`;
    const markerAt = output.indexOf(marker, cursor);
    if (markerAt === -1) continue;
    const start = markerAt + marker.length;

    let end = -1;
    for (let next = index + 1; next < questions.length && end === -1; next += 1) {
      end = output.indexOf(`"${questions[next]!.question}"="`, start);
    }
    let raw: string;
    if (end !== -1) {
      raw = output.slice(start, end).replace(/[\s,]+$/, "");
    } else {
      const tail = output.slice(start);
      const suffix = CONTINUE_SUFFIX.exec(tail);
      raw = suffix ? tail.slice(0, suffix.index + 1) : tail.trimEnd();
    }
    const annotation = ANNOTATION_SUFFIX.exec(raw);
    if (annotation) raw = raw.slice(0, annotation.index + 1);
    if (raw.endsWith('"')) raw = raw.slice(0, -1);

    answers.set(questions[index]!.question, raw);
    cursor = start + raw.length;
  }
  return answers;
}

/**
 * Split one recorded answer into the values it names. Multi-select answers are
 * either a JSON array (Orkestrator's own serializer) or comma-joined labels
 * (Claude's terminal UI); a comma inside a single option label or a custom
 * reply keeps the answer whole.
 */
function answerValues(answer: string, options: readonly QuestionToolOption[]): string[] {
  const trimmed = answer.trim();
  if (!trimmed) return [];
  const labels = new Set(options.map((option) => option.label));
  if (labels.has(trimmed)) return [trimmed];
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.every((value) => typeof value === "string")) {
        return parsed.filter((value) => value.trim());
      }
    } catch {
      // A custom reply that merely starts with a bracket.
    }
  }
  const parts = trimmed.split(", ");
  if (parts.length > 1 && parts.every((part) => labels.has(part))) return parts;
  return [trimmed];
}

/**
 * Pair each question with the answer recorded for it — `answers` in the
 * arguments when the provider kept them there, otherwise the tool result.
 */
export function resolveQuestionToolAnswers(
  questions: readonly QuestionToolQuestion[],
  toolArgs?: Record<string, unknown>,
  toolOutput?: string,
): QuestionToolAnsweredQuestion[] {
  const argAnswers = isRecord(toolArgs?.answers) ? toolArgs.answers : undefined;
  const outputAnswers = parseQuestionToolOutput(questions, toolOutput);

  return questions.map((question) => {
    const argAnswer = argAnswers?.[question.question];
    const answer = typeof argAnswer === "string" ? argAnswer : outputAnswers.get(question.question);
    if (answer === undefined) {
      return {
        ...question,
        selectedLabels: [],
        customAnswers: [],
        answered: false,
      };
    }
    const values = answerValues(answer, question.options);
    const labels = new Set(question.options.map((option) => option.label));
    const picked = new Set(values.filter((value) => labels.has(value)));
    return {
      ...question,
      selectedLabels: question.options
        .map((option) => option.label)
        .filter((label) => picked.has(label)),
      customAnswers: values.filter((value) => !labels.has(value)),
      answered: values.length > 0,
    };
  });
}

/** One-line summary for the collapsed tool row. */
export function questionToolPreview(questions: readonly QuestionToolQuestion[]): string {
  const first = questions[0]!.question;
  return questions.length === 1 ? first : `${questions.length} questions · ${first}`;
}
