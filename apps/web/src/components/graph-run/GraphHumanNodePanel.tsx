import { UserRound } from "lucide-react";
import type { GraphPlanNode } from "@orkestrator/protocol/graphs/compile";
import type { GraphRun, NodeActivation } from "@orkestrator/protocol/graphs/run";

/**
 * The inspector slot of a human node (P2.8): approve, edit or choose. Item
 * 208 fills it with the forms and the backend command they send (it reuses
 * `GraphQuestionAnswerForm` for its prompts); until then a waiting human
 * node says what it waits for, and the run view's other controls (pause,
 * cancel, skip, restart) still apply.
 */
export interface GraphHumanNodePanelProps {
  run: GraphRun;
  node: Extract<GraphPlanNode, { kind: "human" }>;
  activation: NodeActivation | undefined;
  /** The run takes no input now (cancelling or finished). */
  disabled: boolean;
}

const FORM_WORDS = {
  approve: "an approval",
  edit: "an edit and an approval",
  choose: "a choice",
} as const;

export function GraphHumanNodePanel({ node, activation }: GraphHumanNodePanelProps) {
  const waiting = activation?.state === "awaiting-human";
  const instructions = node.form.instructions?.trim();
  return (
    <section
      data-graph-human-node={node.id}
      className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border p-3 text-sm"
    >
      <h3 className="flex items-center gap-1.5 text-xs font-semibold">
        <UserRound className="size-3.5 text-amber-300" aria-hidden />
        {waiting ? `Waiting for ${FORM_WORDS[node.form.kind]}` : "Human step"}
      </h3>
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
      {activation?.outlet ? (
        <p className="text-xs text-muted-foreground">Decided: {activation.outlet}</p>
      ) : waiting ? (
        <p className="text-xs text-muted-foreground">
          Approve, edit and choose controls arrive with human nodes.
        </p>
      ) : null}
    </section>
  );
}
