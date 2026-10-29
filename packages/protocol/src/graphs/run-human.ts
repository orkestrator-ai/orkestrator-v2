/**
 * Human nodes (plan P2.8, D15, report §6.8): the wait a `human` activation
 * keeps in its record, the answer a person gives, and the pending-interaction
 * snapshot every surface that shows "waiting for you" reads.
 *
 * A human activation is `awaiting-human` from its first executor call. Its
 * {@link GraphHumanWait} is in the run record, so the wait survives a backend
 * restart and a view that mounts later rehydrates it (invariant 1). The
 * answer names the wait's id, so an answer meant for a superseded attempt (a
 * restart, a retry) can never reach its replacement. Fail closed (root
 * invariant 10): a malformed, stale or mismatched answer is refused and never
 * recorded; a timeout or a cancelled run settles the activation without one,
 * so nothing downstream of its outlets runs.
 *
 * Forms:
 *
 * - `approve`: `approve` takes the `approved` outlet, `reject` the `rejected`.
 * - `edit`: as `approve`; an approval may carry an edited value of the
 *   `edit` input. The backend validates it against the input's type, stores
 *   it as a new artifact whose lineage is the original, and the `approved`
 *   outlet forwards it in the original's place.
 * - `choose`: `choose` with one of the options' outlets.
 *
 * A note is optional, bounded, and stays in the record (the run view shows
 * it); it reaches no agent.
 *
 * ## Pending interactions
 *
 * {@link graphRunPendingInteractions} lists what a run waits on: every open
 * human wait and every open `ask_human` question, in record order. It is a
 * pure function of the run record, so the run view, the sidebar badge, the
 * coordinator notice and the CLI all agree, and each derives it again from
 * the stored run rather than from an event it may have missed.
 *
 * Browser-safe.
 */
import {
  FieldErrorCollector,
  checkEnum,
  checkString,
  isPlainRecord,
  joinPath,
} from "../field-validation.js";
import { canonicalJson } from "../canonical-json.js";
import { parseUtcTimestamp } from "../workflow-snapshot.js";
import type { GraphPlanHumanNode, GraphPlanNode } from "./plan.js";
import {
  GRAPH_AGENT_ANSWERERS,
  isGraphAgentQuestionOpen,
  type GraphAgentAnswerer,
} from "./run-agent-session.js";
import { GRAPH_SHA256_PATTERN } from "./run-identity.js";
import type { GraphRun, NodeActivation } from "./run-model.js";
import {
  GRAPH_HUMAN_APPROVAL_OUTLETS,
  GRAPH_HUMAN_FORMS,
  type GraphHumanChoice,
  type GraphHumanFormKind,
} from "./template-model.js";

const KIB = 1024;

export const GRAPH_HUMAN_BOUNDS = Object.freeze({
  maxNoteChars: 2_000,
  /** Canonical JSON bytes of an edited value (the run view's inline artifact bound). */
  maxEditBytes: 512 * KIB,
  maxEditDepth: 32,
  /** Pending interactions one snapshot lists. */
  maxPendingInteractions: 64,
} as const);

/** `approve`/`reject` on `approve` and `edit` forms; `choose` on `choose`. */
export const GRAPH_HUMAN_DECISIONS = ["approve", "reject", "choose"] as const;
export type GraphHumanDecision = (typeof GRAPH_HUMAN_DECISIONS)[number];

export interface GraphHumanAnswer {
  decision: GraphHumanDecision;
  /** The outlet the answer takes. */
  outlet: string;
  /** An `edit` form's approval with a changed value: the new artifact on the edited input. */
  edited?: { port: string; artifactId: string };
  /** Untrusted, at most {@link GRAPH_HUMAN_BOUNDS.maxNoteChars}; never sent to an agent. */
  note?: string;
  at: string;
  by: GraphAgentAnswerer;
}

/** A human activation's wait. Absent until the executor's first call records it. */
export interface GraphHumanWait {
  /** A UUID; the answer names it, so an answer for another attempt is refused. */
  id: string;
  form: GraphHumanFormKind;
  openedAt: string;
  answer?: GraphHumanAnswer;
}

/** What a person sends (`graph_run_answer`'s human-node form, without the location). */
export interface GraphHumanAnswerInput {
  waitId: string;
  decision: GraphHumanDecision;
  /** `choose`: the option's outlet. */
  outlet?: string;
  /** `edit` with `approve`: the edited value of the `edit` input. Omitted: approved unchanged. */
  value?: unknown;
  note?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** Control characters other than tab, line feed and carriage return. */
const PROSE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;

function checkWhen(value: unknown, path: string, errors: FieldErrorCollector): void {
  if (typeof value !== "string" || value.length > 40 || parseUtcTimestamp(value) === null) {
    errors.add(path, "timestamp", "Expected an RFC 3339 UTC timestamp");
  }
}

function checkNote(value: unknown, path: string, errors: FieldErrorCollector): void {
  if (value === undefined) return;
  if (!checkString(value, path, errors, { min: 1, max: GRAPH_HUMAN_BOUNDS.maxNoteChars })) return;
  if (PROSE_CONTROL.test(value as string)) {
    errors.add(path, "control_character", "Must not contain control characters");
  }
}

function unknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  errors: FieldErrorCollector,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.add(joinPath(path, key), "unknown_field", "Unknown field");
  }
}

function checkAnswer(value: unknown, path: string, errors: FieldErrorCollector): void {
  if (!isPlainRecord(value)) {
    errors.add(path, "type", "Expected an object");
    return;
  }
  unknownKeys(value, ["decision", "outlet", "edited", "note", "at", "by"], path, errors);
  checkEnum(value.decision, joinPath(path, "decision"), errors, GRAPH_HUMAN_DECISIONS);
  if (typeof value.outlet !== "string" || !KEY.test(value.outlet)) {
    errors.add(joinPath(path, "outlet"), "pattern", "Expected an outlet name");
  }
  if (value.edited !== undefined) {
    const editedPath = joinPath(path, "edited");
    if (!isPlainRecord(value.edited)) {
      errors.add(editedPath, "type", "Expected an object");
    } else {
      unknownKeys(value.edited, ["port", "artifactId"], editedPath, errors);
      if (typeof value.edited.port !== "string" || !KEY.test(value.edited.port)) {
        errors.add(joinPath(editedPath, "port"), "pattern", "Expected a port name");
      }
      if (
        typeof value.edited.artifactId !== "string" ||
        !GRAPH_SHA256_PATTERN.test(value.edited.artifactId)
      ) {
        errors.add(joinPath(editedPath, "artifactId"), "pattern", "Expected an artifact id");
      }
      if (value.decision !== "approve") {
        errors.add(editedPath, "mismatch", "Only an approval carries an edit");
      }
    }
  }
  checkNote(value.note, joinPath(path, "note"), errors);
  checkWhen(value.at, joinPath(path, "at"), errors);
  checkEnum(value.by, joinPath(path, "by"), errors, GRAPH_AGENT_ANSWERERS);
}

/** Checks an activation's `human` field (the run record's validator calls it). */
export function checkGraphHumanWait(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
): void {
  if (!isPlainRecord(value)) {
    errors.add(path, "type", "Expected an object");
    return;
  }
  unknownKeys(value, ["id", "form", "openedAt", "answer"], path, errors);
  if (typeof value.id !== "string" || !UUID.test(value.id)) {
    errors.add(joinPath(path, "id"), "pattern", "Must be a UUID");
  }
  checkEnum(value.form, joinPath(path, "form"), errors, GRAPH_HUMAN_FORMS);
  checkWhen(value.openedAt, joinPath(path, "openedAt"), errors);
  if (value.answer !== undefined) {
    checkAnswer(value.answer, joinPath(path, "answer"), errors);
    if (isPlainRecord(value.answer) && value.answer.edited !== undefined && value.form !== "edit") {
      errors.add(
        joinPath(joinPath(path, "answer"), "edited"),
        "mismatch",
        "Only an edit form edits",
      );
    }
  }
}

/** A wait that has no answer yet. */
export function isGraphHumanWaitOpen(wait: GraphHumanWait | undefined): boolean {
  return wait !== undefined && wait.answer === undefined;
}

function editedValueProblem(value: unknown): string | null {
  let text: string;
  try {
    text = canonicalJson(value, GRAPH_HUMAN_BOUNDS.maxEditDepth);
  } catch {
    return "The edited value is not plain JSON or nests too deeply";
  }
  if (new TextEncoder().encode(text).byteLength > GRAPH_HUMAN_BOUNDS.maxEditBytes) {
    return `The edited value exceeds ${GRAPH_HUMAN_BOUNDS.maxEditBytes} bytes`;
  }
  return null;
}

/** The outlet an answer takes: `approved`/`rejected`, or the chosen option's. */
export function graphHumanAnswerOutlet(
  node: Pick<GraphPlanHumanNode, "form">,
  input: Pick<GraphHumanAnswerInput, "decision" | "outlet">,
): string | null {
  if (node.form.kind === "choose") {
    if (input.decision !== "choose") return null;
    return node.form.options.some((option) => option.to === input.outlet) ? input.outlet! : null;
  }
  if (input.decision === "approve") return GRAPH_HUMAN_APPROVAL_OUTLETS[0];
  if (input.decision === "reject") return GRAPH_HUMAN_APPROVAL_OUTLETS[1];
  return null;
}

/**
 * Why `input` cannot answer the wait of `activation` (a human node's), or
 * null. The answer command checks it before storing an edited value and again
 * under the run's lock, so a stale, malformed or mismatched answer is refused
 * and never recorded.
 */
export function graphHumanAnswerProblem(
  node: GraphPlanNode | undefined,
  activation: Pick<NodeActivation, "state" | "human" | "inputs"> | undefined,
  input: GraphHumanAnswerInput,
): string | null {
  if (!activation) return "The run has no such activation";
  if (!node || node.kind !== "human") return "The activation is not a human step";
  const wait = activation.human;
  if (activation.state !== "awaiting-human" || !wait) {
    return activation.state === "admitting" && !wait
      ? "The step is still opening; try again in a moment"
      : `The step is ${activation.state}, not waiting for an answer`;
  }
  if (input.waitId !== wait.id) return "The answer is for another attempt of this step";
  if (wait.answer !== undefined) return "The step was already answered";
  if (!(GRAPH_HUMAN_DECISIONS as readonly string[]).includes(input.decision)) {
    return `decision must be one of ${GRAPH_HUMAN_DECISIONS.join(", ")}`;
  }
  const errors = new FieldErrorCollector();
  checkNote(input.note, "note", errors);
  const first = errors.errors[0];
  if (first) return `${first.path}: ${first.message}`;
  const form = node.form;
  if (form.kind === "choose") {
    if (input.decision !== "choose") return "This step takes a choice";
    if (graphHumanAnswerOutlet(node, input) === null) {
      return "The choice must be one of the step's options";
    }
  } else {
    if (input.decision === "choose") return "This step takes an approval or a rejection";
    if (input.outlet !== undefined) return "Only a choice names an outlet";
  }
  if (input.value !== undefined) {
    if (form.kind !== "edit") return "Only an edit step takes an edited value";
    if (input.decision !== "approve") return "Only an approval carries an edited value";
    if (typeof activation.inputs[form.edit] !== "string") {
      return "The edited input has no single value to replace";
    }
    const valueProblem = editedValueProblem(input.value);
    if (valueProblem) return valueProblem;
  }
  return null;
}

/**
 * What a decided human activation forwards (as a gate does): its
 * single-value inputs on their own ports, with an edited value in place of
 * the original. The ready set falls back to the input for list ports.
 */
export function graphHumanForwardedOutputs(
  activation: Pick<NodeActivation, "inputs">,
  answer: Pick<GraphHumanAnswer, "edited">,
): Record<string, string> {
  const outputs: Record<string, string> = {};
  for (const [port, ids] of Object.entries(activation.inputs)) {
    if (typeof ids === "string") outputs[port] = ids;
  }
  if (answer.edited) outputs[answer.edited.port] = answer.edited.artifactId;
  return outputs;
}

// ---------------------------------------------------------------- pending interactions

interface GraphRunPendingBase {
  runId: string;
  activationKey: string;
  nodeId: string;
  /** The node's label, else its id. */
  title: string;
  /** When the wait or question opened. */
  openedAt: string;
}

/** An open human wait. */
export interface GraphRunPendingHumanWait extends GraphRunPendingBase {
  kind: "human";
  waitId: string;
  form: GraphHumanFormKind;
  instructions?: string;
  /** `edit`: the input the person may edit, its type and the artifact it holds. */
  edit?: { port: string; type: string; artifactId: string };
  /** `choose`: the options. */
  options?: GraphHumanChoice[];
  /** When a node with `timeoutMs` stops waiting (its `error` port then fires). */
  timeoutAt?: string;
}

/** An agent's open `ask_human` question. */
export interface GraphRunPendingQuestion extends GraphRunPendingBase {
  kind: "question";
  questionId: string;
  text: string;
  choices?: string[];
}

export type GraphRunPendingInteraction = GraphRunPendingHumanWait | GraphRunPendingQuestion;

function addMs(iso: string, ms: number): string | undefined {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? new Date(at + ms).toISOString() : undefined;
}

/**
 * Everything `run` waits on a person for, in record order (at most
 * {@link GRAPH_HUMAN_BOUNDS.maxPendingInteractions}). A finished or stopping
 * run waits on nobody.
 */
export function graphRunPendingInteractions(run: GraphRun): GraphRunPendingInteraction[] {
  if (
    run.status === "complete" ||
    run.status === "failed" ||
    run.status === "cancelled" ||
    run.status === "cancelling"
  ) {
    return [];
  }
  const nodes = new Map(run.plan.nodes.map((node) => [node.id, node]));
  const pending: GraphRunPendingInteraction[] = [];
  for (const activation of run.activations) {
    if (pending.length >= GRAPH_HUMAN_BOUNDS.maxPendingInteractions) break;
    if (activation.state !== "awaiting-human") continue;
    const node = nodes.get(activation.nodeId);
    const base = {
      runId: run.id,
      activationKey: activation.key,
      nodeId: activation.nodeId,
      title: node?.label ?? activation.nodeId,
    };
    const wait = activation.human;
    if (node?.kind === "human" && wait && isGraphHumanWaitOpen(wait)) {
      const form = node.form;
      const editId = form.kind === "edit" ? activation.inputs[form.edit] : undefined;
      const editType =
        form.kind === "edit"
          ? node.inputs.find((port) => port.name === form.edit)?.type
          : undefined;
      const timeoutAt =
        node.timeoutMs !== undefined
          ? addMs(activation.startedAt ?? wait.openedAt, node.timeoutMs)
          : undefined;
      pending.push({
        ...base,
        kind: "human",
        openedAt: wait.openedAt,
        waitId: wait.id,
        form: form.kind,
        ...(form.instructions ? { instructions: form.instructions } : {}),
        ...(form.kind === "edit" && typeof editId === "string" && editType
          ? { edit: { port: form.edit, type: editType, artifactId: editId } }
          : {}),
        ...(form.kind === "choose"
          ? { options: form.options.map((option) => ({ ...option })) }
          : {}),
        ...(timeoutAt ? { timeoutAt } : {}),
      });
      continue;
    }
    const question = activation.session?.question;
    if (question && isGraphAgentQuestionOpen(question)) {
      pending.push({
        ...base,
        kind: "question",
        openedAt: question.askedAt,
        questionId: question.id,
        text: question.text,
        ...(question.choices ? { choices: [...question.choices] } : {}),
      });
    }
  }
  return pending;
}

/** The id of a pending interaction: its wait's or its question's. */
export function graphPendingInteractionId(interaction: GraphRunPendingInteraction): string {
  return interaction.kind === "human" ? interaction.waitId : interaction.questionId;
}
