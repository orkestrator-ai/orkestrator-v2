import { useEffect, useMemo, useState } from "react";
import { Clock, UserRound } from "lucide-react";
import type { GraphPlanNode } from "@orkestrator/protocol/graphs/compile";
import type {
  GraphAgentAnswer,
  GraphHumanAnswer,
  GraphHumanAnswerInput,
  GraphRun,
  NodeActivation,
} from "@orkestrator/protocol/graphs/run";
import { graphRunCacheKey, useGraphRunStore } from "@/stores/graphRunStore";
import { graphArtifactTypeDefinition } from "./GraphArtifactView";
import { GraphArtifactValueEditor, type GraphArtifactEditState } from "./GraphArtifactValueEditor";
import { GraphQuestionAnswerForm, type GraphQuestionAnswer } from "./GraphQuestionAnswerForm";

/**
 * The inspector slot of a human node (P2.8, item 208): approve, edit or
 * choose. The prompt and controls are the shared `GraphQuestionAnswerForm`
 * (as for an agent's `ask_human` question): a choice (approve or reject, or
 * one of the node's options) and an optional note. An `edit` form adds the
 * edited input's value, through its type's form or as JSON, checked live
 * against the type; an approval sends the edited value only when it changed,
 * and the backend stores it as a new artifact whose lineage is the original.
 *
 * Everything shown comes from the run record (`activation.human`), so a view
 * that mounts later, after a tab switch or a backend restart, shows the same
 * wait and the same answer. A refused answer (a stale wait, a value its type
 * rejects) keeps the draft and shows the backend's message.
 */
export type GraphHumanNodeAnswer = Omit<GraphHumanAnswerInput, "waitId">;

export interface GraphHumanNodePanelProps {
  run: GraphRun;
  node: Extract<GraphPlanNode, { kind: "human" }>;
  activation: NodeActivation | undefined;
  /** The run takes no input now (cancelling or finished). */
  disabled: boolean;
  /** Sends the answer for the activation's open wait; rejects with the backend's message. */
  onAnswer?: (activation: NodeActivation, answer: GraphHumanNodeAnswer) => Promise<void>;
}

const FORM_WORDS = {
  approve: "an approval",
  edit: "an edit and an approval",
  choose: "a choice",
} as const;

const APPROVE = "Approve";
const REJECT = "Reject";

/** Unique labels for a choose form's options (a duplicate label shows its outlet). */
function optionLabels(node: GraphHumanNodePanelProps["node"]): Map<string, string> {
  const labels = new Map<string, string>();
  if (node.form.kind !== "choose") return labels;
  const counts = new Map<string, number>();
  for (const option of node.form.options) {
    counts.set(option.label, (counts.get(option.label) ?? 0) + 1);
  }
  for (const option of node.form.options) {
    labels.set(
      (counts.get(option.label) ?? 0) > 1 ? `${option.label} (${option.to})` : option.label,
      option.to,
    );
  }
  return labels;
}

/** A recorded answer in the shared form's shape, so it renders as "asked / answered". */
function shownAnswer(answer: GraphHumanAnswer, labels: Map<string, string>): GraphAgentAnswer {
  const choice =
    answer.decision === "approve"
      ? answer.edited
        ? `${APPROVE} (edited)`
        : APPROVE
      : answer.decision === "reject"
        ? REJECT
        : ([...labels.entries()].find(([, outlet]) => outlet === answer.outlet)?.[0] ??
          answer.outlet);
  return {
    kind: "answered",
    choice,
    ...(answer.note ? { text: answer.note } : {}),
    at: answer.at,
    by: answer.by,
  };
}

function formatTime(iso: string | undefined): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? new Date(at).toLocaleString() : null;
}

/** The edited input's value, read through the run store, and an editor for it. */
function useEditTarget(
  run: GraphRun,
  node: GraphHumanNodePanelProps["node"],
  activation?: NodeActivation,
) {
  const port = node.form.kind === "edit" ? node.form.edit : undefined;
  const bound = port ? activation?.inputs[port] : undefined;
  const artifactId = typeof bound === "string" ? bound : undefined;
  const entry = useGraphRunStore((state) =>
    artifactId ? state.artifacts.get(graphRunCacheKey(run.id, artifactId)) : undefined,
  );
  const loadArtifact = useGraphRunStore((state) => state.loadArtifact);
  useEffect(() => {
    if (artifactId) void loadArtifact(run.id, artifactId);
  }, [artifactId, run.id, loadArtifact]);
  const view = entry?.view ?? null;
  const definition = useMemo(
    () => (view ? graphArtifactTypeDefinition(run.plan, view.artifact.type) : null),
    [run.plan, view],
  );
  const choices = useMemo(() => {
    if (!view) return undefined;
    const producer = run.plan.nodes.find(
      (candidate) => candidate.id === view.artifact.producer.nodeId,
    );
    return producer?.outputs.find((output) => output.name === view.artifact.producer.port)?.choices;
  }, [run.plan, view]);
  return { port, artifactId, entry, view, definition, choices };
}

export function GraphHumanNodePanel({
  run,
  node,
  activation,
  disabled,
  onAnswer,
}: GraphHumanNodePanelProps) {
  const wait = activation?.human;
  const waiting = activation?.state === "awaiting-human" && wait !== undefined && !wait.answer;
  const instructions = node.form.instructions?.trim();
  const labels = useMemo(() => optionLabels(node), [node]);
  const edit = useEditTarget(run, node, waiting ? activation : undefined);
  const [draft, setDraft] = useState<GraphArtifactEditState | null>(null);
  const timeoutAt =
    waiting && node.timeoutMs !== undefined && activation?.startedAt
      ? new Date(Date.parse(activation.startedAt) + node.timeoutMs).toISOString()
      : undefined;

  const submit = async (reply: GraphQuestionAnswer) => {
    if (!activation || !onAnswer) return;
    const note = reply.text?.trim() ? { note: reply.text.trim() } : {};
    if (node.form.kind === "choose") {
      const outlet = reply.choice ? labels.get(reply.choice) : undefined;
      if (!outlet) throw new Error("Choose one of the options.");
      await onAnswer(activation, { decision: "choose", outlet, ...note });
      return;
    }
    if (reply.choice === REJECT) {
      await onAnswer(activation, { decision: "reject", ...note });
      return;
    }
    if (draft?.problem) throw new Error(`Fix the edited value first: ${draft.problem}`);
    await onAnswer(activation, {
      decision: "approve",
      ...(draft ? { value: draft.value } : {}),
      ...note,
    });
  };

  const question = wait
    ? {
        id: wait.id,
        text:
          instructions ??
          (node.form.kind === "choose"
            ? "Choose how the run continues."
            : node.form.kind === "edit"
              ? "Check the value, edit it if needed, then approve or reject it."
              : "Approve to continue, or reject."),
        choices: node.form.kind === "choose" ? [...labels.keys()] : [APPROVE, REJECT],
        ...(wait.answer ? { answer: shownAnswer(wait.answer, labels) } : {}),
      }
    : null;

  return (
    <section
      data-graph-human-node={node.id}
      data-graph-human-waiting={waiting ? "" : undefined}
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-border p-3 text-sm"
    >
      <h3 className="flex items-center gap-1.5 text-xs font-semibold">
        <UserRound className="size-3.5 text-amber-300" aria-hidden />
        {waiting ? `Waiting for ${FORM_WORDS[node.form.kind]}` : "Human step"}
      </h3>
      {timeoutAt ? (
        <p
          className="flex items-center gap-1.5 text-xs text-muted-foreground"
          data-graph-human-timeout=""
        >
          <Clock className="size-3.5" aria-hidden />
          Stops waiting at {formatTime(timeoutAt)}; the run then takes the step's error path.
        </p>
      ) : null}
      {question && activation ? (
        <GraphQuestionAnswerForm
          question={question}
          asker={node.label ?? node.id}
          allowDecline={false}
          requireChoice
          submitLabel="Send"
          textLabel="Note (optional)"
          disabled={disabled || !waiting || !onAnswer}
          onSubmit={submit}
        >
          {waiting && node.form.kind === "edit" ? (
            edit.entry?.status === "error" || edit.entry?.status === "missing" ? (
              <p role="alert" className="text-xs text-failure">
                Could not read the value to edit: {edit.entry.error}
              </p>
            ) : !edit.artifactId ? (
              <p className="text-xs text-muted-foreground">
                The edited input has no single value; approve or reject it as it is.
              </p>
            ) : edit.view && edit.definition ? (
              edit.view.file || edit.view.value === undefined ? (
                <p className="text-xs text-muted-foreground">
                  {edit.view.valueOmitted === "too-large"
                    ? "The value is too large to edit here; approve or reject it as it is."
                    : `${edit.view.artifact.type} is a file reference and cannot be edited; approve or reject it.`}
                </p>
              ) : (
                <GraphArtifactValueEditor
                  key={`${wait!.id}:${edit.artifactId}`}
                  definition={edit.definition}
                  initial={edit.view.value}
                  {...(edit.choices ? { choices: edit.choices } : {})}
                  disabled={disabled}
                  onChange={setDraft}
                />
              )
            ) : (
              <p className="text-xs text-muted-foreground">Reading the value…</p>
            )
          ) : null}
        </GraphQuestionAnswerForm>
      ) : (
        <>
          {instructions ? <p className="break-words whitespace-pre-wrap">{instructions}</p> : null}
          {node.form.kind === "choose" ? (
            <ul className="ml-4 list-disc text-xs text-muted-foreground">
              {node.form.options.map((option) => (
                <li key={option.to}>
                  {option.label} <span className="font-mono">→ {option.to}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
      {activation?.outlet ? (
        <p className="text-xs text-muted-foreground" data-graph-human-outlet="">
          Decided: {activation.outlet}
        </p>
      ) : activation?.state === "failed" && activation.errorCause === "timeout" ? (
        <p className="text-xs text-muted-foreground">Nobody answered in time.</p>
      ) : null}
    </section>
  );
}
