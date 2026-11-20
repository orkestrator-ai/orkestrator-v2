import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, MessageSquare } from "lucide-react";
import {
  applyPlanChanges,
  planDependencyProblems,
  type PlanChange,
  type PlanSpec,
} from "@orkestrator/protocol/rich-interactions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ActionBar, inputClass, textareaClass, type KindProps } from "../shared";

interface PlanDraft {
  changes: PlanChange[];
  comment?: string;
}

/**
 * Feature 3: editable plans. Edits are an ordered change set against the
 * revision shown (stable step ids, never list positions). The difference from
 * the agent's plan and any dependency problem are visible before submitting.
 * Agreeing to a scope records it; it never grants execution permissions.
 */
export function PlanCard({
  view,
  spec,
  draft,
  setDraft,
  act,
  disabled,
  actions,
}: KindProps<PlanSpec>) {
  const value = (draft as PlanDraft | undefined) ?? { changes: [] };
  const next = useMemo(() => applyPlanChanges(spec, value.changes), [spec, value.changes]);
  const problems = useMemo(() => planDependencyProblems(next.steps), [next.steps]);
  const [editing, setEditing] = useState<string | null>(null);
  const [commenting, setCommenting] = useState<string | null>(null);
  const [noteText, setNoteText] = useState("");
  const [constraint, setConstraint] = useState("");
  const push = (change: PlanChange) => setDraft({ ...value, changes: [...value.changes, change] });
  const title = (stepId: string) => next.steps.find((s) => s.id === stepId)?.title ?? stepId;

  return (
    <div className="flex flex-col gap-3">
      {spec.executing ? (
        <p className="rounded bg-amber-500/10 px-2 py-1 text-xs text-amber-300">
          Work is under way: scope edits become a pending amendment; excluding a running step does
          not stop it.
        </p>
      ) : null}
      <ol className="flex flex-col gap-1.5" aria-label="Plan steps">
        {next.steps.map((step, index) => {
          const original = spec.steps.find((s) => s.id === step.id);
          const changed =
            original &&
            (original.included !== step.included ||
              original.title !== step.title ||
              original.description !== step.description ||
              spec.steps.indexOf(original) !== index);
          const problem = problems.find((p) => p.stepId === step.id);
          return (
            <li
              key={step.id}
              className={cn(
                "rounded-md border px-3 py-2",
                step.included ? "border-border/60" : "border-dashed border-border/50 opacity-70",
                changed && "border-primary/40",
              )}
            >
              <div className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1 size-4 accent-primary"
                  checked={step.included}
                  disabled={disabled}
                  aria-label={`Include step ${step.title}`}
                  onChange={(e) =>
                    push({ op: "setIncluded", stepId: step.id, value: e.target.checked })
                  }
                />
                <div className="min-w-0 flex-1">
                  {editing === step.id ? (
                    <input
                      className={inputClass}
                      aria-label={`Title of step ${index + 1}`}
                      defaultValue={step.title}
                      autoFocus
                      onBlur={(e) => {
                        setEditing(null);
                        if (e.target.value.trim() && e.target.value !== step.title)
                          push({ op: "editStep", stepId: step.id, title: e.target.value });
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setEditing(null);
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="text-left text-sm font-medium focus-hairline"
                      disabled={disabled}
                      onClick={() => setEditing(step.id)}
                      title="Edit title"
                    >
                      {index + 1}. {step.title}
                      {step.optional ? (
                        <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                          (optional)
                        </span>
                      ) : null}
                      {step.status && step.status !== "pending" ? (
                        <span className="ml-1.5 rounded bg-muted px-1 text-[10px] uppercase text-muted-foreground">
                          {step.status}
                        </span>
                      ) : null}
                    </button>
                  )}
                  {step.description ? (
                    <p className="text-xs text-muted-foreground">{step.description}</p>
                  ) : null}
                  {step.rationale ? (
                    <p className="text-xs text-muted-foreground italic">Why: {step.rationale}</p>
                  ) : null}
                  {step.dependsOn.length ? (
                    <p className="text-[11px] text-muted-foreground">
                      Needs: {step.dependsOn.map(title).join(", ")}
                    </p>
                  ) : null}
                  {problem ? (
                    <p className="text-xs text-failure" role="alert">
                      Depends on excluded step “{title(problem.missing)}”. Include it, or exclude
                      this step too.
                    </p>
                  ) : null}
                  {step.comments?.map((c) => (
                    <p key={c.id} className="mt-1 rounded bg-muted/30 px-2 py-1 text-xs">
                      <span className="text-muted-foreground">
                        {c.author === "user" ? "You" : "Agent"}:
                      </span>{" "}
                      {c.text}
                    </p>
                  ))}
                  {commenting === step.id ? (
                    <div className="mt-1 flex gap-2">
                      <input
                        className={inputClass}
                        aria-label={`Comment on ${step.title}`}
                        value={noteText}
                        onChange={(e) => setNoteText(e.target.value)}
                      />
                      <Button
                        size="sm"
                        disabled={!noteText.trim()}
                        onClick={() => {
                          push({ op: "addComment", stepId: step.id, text: noteText.trim() });
                          setNoteText("");
                          setCommenting(null);
                        }}
                      >
                        Add
                      </Button>
                    </div>
                  ) : null}
                </div>
                <div className="flex shrink-0 gap-0.5">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    aria-label={`Comment on ${step.title}`}
                    disabled={disabled}
                    onClick={() => setCommenting(commenting === step.id ? null : step.id)}
                  >
                    <MessageSquare className="size-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    aria-label={`Move ${step.title} up`}
                    disabled={disabled || index === 0}
                    onClick={() =>
                      push({
                        op: "moveBefore",
                        stepId: step.id,
                        beforeStepId: next.steps[index - 1]!.id,
                      })
                    }
                  >
                    <ArrowUp className="size-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    aria-label={`Move ${step.title} down`}
                    disabled={disabled || index === next.steps.length - 1}
                    onClick={() =>
                      push({
                        op: "moveBefore",
                        stepId: step.id,
                        beforeStepId: next.steps[index + 2]?.id ?? null,
                      })
                    }
                  >
                    <ArrowDown className="size-3.5" />
                  </Button>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      {next.constraints.length || !disabled ? (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium text-muted-foreground">Constraints</p>
          {next.constraints.map((c) => (
            <div key={c.id} className="flex items-center gap-2 text-xs">
              <span className="flex-1">{c.text}</span>
              <span className="text-muted-foreground">{c.author === "user" ? "you" : "agent"}</span>
              {!disabled ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-xs"
                  onClick={() => push({ op: "removeConstraint", constraintId: c.id })}
                  disabled={!spec.constraints.some((x) => x.id === c.id)}
                >
                  Remove
                </Button>
              ) : null}
            </div>
          ))}
          {!disabled ? (
            <div className="flex gap-2">
              <input
                className={inputClass}
                placeholder="Add a constraint"
                aria-label="New constraint"
                value={constraint}
                onChange={(e) => setConstraint(e.target.value)}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={!constraint.trim()}
                onClick={() => {
                  push({ op: "addConstraint", text: constraint.trim() });
                  setConstraint("");
                }}
              >
                Add
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {next.criteria.length ? (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium text-muted-foreground">Acceptance criteria</p>
          <ul className="list-disc pl-5 text-xs">
            {next.criteria.map((c) => (
              <li key={c.id}>{c.text}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {value.changes.length ? (
        <details className="rounded bg-muted/20 px-2 py-1 text-xs" open>
          <summary className="cursor-pointer text-muted-foreground">
            {value.changes.length} change(s) from the agent's revision {view.request.revision}
          </summary>
          <Button
            size="sm"
            variant="ghost"
            className="mt-1 h-6 px-2 text-xs"
            onClick={() => setDraft({ ...value, changes: value.changes.slice(0, -1) })}
          >
            Undo last change
          </Button>
        </details>
      ) : null}
      {!disabled ? (
        <>
          <textarea
            className={textareaClass}
            rows={2}
            placeholder="Comment for the agent (optional)"
            aria-label="Plan comment"
            value={value.comment ?? ""}
            onChange={(e) => setDraft({ ...value, comment: e.target.value })}
          />
          {(() => {
            const result = {
              baseRevision: view.request.revision,
              changes: value.changes,
              ...(value.comment?.trim() ? { comment: value.comment.trim() } : {}),
            };
            const others = actions.filter((a) => a.id !== "accept-scope").map((a) => a.id);
            return (
              <div className="flex flex-col gap-2">
                <ActionBar
                  actions={actions}
                  only={others}
                  disabled={disabled}
                  onAction={(a) => act(a.id, result)}
                />
                <ActionBar
                  actions={actions}
                  only={["accept-scope"]}
                  disabled={disabled}
                  primaryDisabledReason={
                    problems.length
                      ? "Resolve the dependency problems before agreeing to a scope."
                      : null
                  }
                  onAction={(a) => act(a.id, result)}
                />
              </div>
            );
          })()}
        </>
      ) : null}
    </div>
  );
}
