import { useState } from "react";
import {
  currentAssessment,
  type CriteriaSpec,
  type Criterion,
  type CriterionAssessment,
} from "@orkestrator/protocol/rich-interactions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  ActionBar,
  ContentRefPreview,
  ProvenanceBadge,
  inputClass,
  textareaClass,
  type KindProps,
} from "../shared";

interface CriteriaDraft {
  edits: Record<string, string>;
  added: string[];
  decisions: Record<
    string,
    { decision: CriterionAssessment["decision"]; rationale?: string; observations: string[] }
  >;
}

const DECISION_LABEL: Record<CriterionAssessment["decision"], string> = {
  accepted: "Accepted",
  "changes-requested": "Changes requested",
  waived: "Waived",
};

/**
 * Feature 16: acceptance criteria with evidence and guided review. Agreeing
 * freezes the set; the agent attaches evidence; only the person records
 * accepted, waived or changes-requested, each bound to the criterion text it
 * judged. Evidence status and human acceptance are shown apart.
 */
export function CriteriaCard({
  spec,
  draft,
  setDraft,
  act,
  disabled,
  actions,
}: KindProps<CriteriaSpec>) {
  const value = (draft as CriteriaDraft | undefined) ?? { edits: {}, added: [], decisions: {} };
  const [walk, setWalk] = useState<string | null>(null);
  const [newCriterion, setNewCriterion] = useState("");
  const proposed = spec.phase === "proposed";
  const editsPayload = Object.entries(value.edits)
    .filter(
      ([id, text]) => text.trim() && text !== spec.criteria.find((c) => c.id === id)?.requirement,
    )
    .map(([criterionId, requirement]) => ({ criterionId, requirement }));
  const decisionsPayload = Object.entries(value.decisions).map(([criterionId, d]) => ({
    criterionId,
    decision: d.decision,
    observations: d.observations.filter((o) => o.trim()),
    ...(d.rationale?.trim() ? { rationale: d.rationale.trim() } : {}),
  }));
  const setDecision = (criterionId: string, patch: Partial<CriteriaDraft["decisions"][string]>) => {
    const previous = value.decisions[criterionId] as CriteriaDraft["decisions"][string] | undefined;
    setDraft({
      ...value,
      decisions: {
        ...value.decisions,
        [criterionId]: {
          ...previous,
          decision: patch.decision ?? previous?.decision ?? "accepted",
          observations: patch.observations ?? previous?.observations ?? [],
          ...(patch.rationale !== undefined ? { rationale: patch.rationale } : {}),
        },
      },
    });
  };
  const counts = spec.criteria.reduce(
    (acc, c) => {
      const a = currentAssessment(spec, c.id);
      const bucket = a?.decision ?? "unresolved";
      acc[bucket] = (acc[bucket] ?? 0) + 1;
      return acc;
    },
    { accepted: 0, "changes-requested": 0, waived: 0, unresolved: 0 } as Record<string, number>,
  );
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        {proposed
          ? "Proposed criteria — edit them, then agree the set the work will be judged against."
          : `Agreed set ${spec.setId}: ${counts.accepted} accepted, ${counts.waived} waived, ${counts["changes-requested"]} changes requested, ${counts.unresolved} unresolved.`}
      </p>
      <ol className="flex flex-col gap-2">
        {spec.criteria.map((criterion) => {
          const assessment = currentAssessment(spec, criterion.id);
          const history = (spec.assessments[criterion.id] ?? []).filter((a) => a.historical);
          const pending = value.decisions[criterion.id];
          return (
            <li key={criterion.id} className="rounded border border-border/60 px-3 py-2">
              {proposed && !disabled ? (
                <input
                  className={inputClass}
                  aria-label={`Criterion ${criterion.id}`}
                  value={value.edits[criterion.id] ?? criterion.requirement}
                  onChange={(e) =>
                    setDraft({
                      ...value,
                      edits: { ...value.edits, [criterion.id]: e.target.value },
                    })
                  }
                />
              ) : (
                <p className="text-sm font-medium">{criterion.requirement}</p>
              )}
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Verify by {criterion.verification.kind.replace("-", " ")}
                {criterion.threshold ? ` · threshold: ${criterion.threshold}` : ""}
              </p>
              {criterion.agentReport ? (
                <p className="mt-1 text-xs">
                  Agent report: {criterion.agentReport.status.replace("-", " ")}
                  {criterion.agentReport.note ? ` — ${criterion.agentReport.note}` : ""}
                </p>
              ) : null}
              {criterion.evidence.length ? (
                <ul className="mt-1 flex flex-col gap-1 text-xs">
                  {criterion.evidence.map((e) => (
                    <li key={e.evidenceId} className="flex flex-wrap items-center gap-2">
                      <span
                        className={cn(
                          e.status === "supports"
                            ? "text-success"
                            : e.status === "contradicts"
                              ? "text-failure"
                              : "text-muted-foreground",
                        )}
                      >
                        {e.status}
                      </span>
                      <span>{e.label}</span>
                      <ProvenanceBadge provenance={e.provenance} />
                      {e.commit ? (
                        <code className="text-muted-foreground">{e.commit.slice(0, 10)}</code>
                      ) : null}
                      {e.environmentLabel ? (
                        <span className="text-muted-foreground">{e.environmentLabel}</span>
                      ) : null}
                      {e.note ? <span className="text-muted-foreground">— {e.note}</span> : null}
                    </li>
                  ))}
                </ul>
              ) : !proposed ? (
                <p className="mt-1 text-xs text-muted-foreground">No evidence attached yet.</p>
              ) : null}
              {assessment ? (
                <p className="mt-1 text-xs">
                  Your decision:{" "}
                  <span className="font-medium">{DECISION_LABEL[assessment.decision]}</span>
                  {assessment.rationale ? ` — ${assessment.rationale}` : ""}
                </p>
              ) : null}
              {history.length ? (
                <p className="text-[11px] text-muted-foreground">
                  {history.length} earlier decision(s) on a previous wording are kept as history.
                </p>
              ) : null}
              {!proposed && !disabled ? (
                <div className="mt-2 flex flex-col gap-2">
                  <div
                    className="flex flex-wrap gap-1"
                    role="radiogroup"
                    aria-label={`Decision for ${criterion.requirement}`}
                  >
                    {(["accepted", "changes-requested", "waived"] as const).map((d) => (
                      <Button
                        key={d}
                        size="sm"
                        variant={pending?.decision === d ? "default" : "outline"}
                        role="radio"
                        aria-checked={pending?.decision === d}
                        onClick={() => setDecision(criterion.id, { decision: d })}
                      >
                        {DECISION_LABEL[d]}
                      </Button>
                    ))}
                    {pending ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          const { [criterion.id]: _removed, ...rest } = value.decisions;
                          setDraft({ ...value, decisions: rest });
                        }}
                      >
                        Clear
                      </Button>
                    ) : null}
                    {criterion.verification.steps.length ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setWalk(walk === criterion.id ? null : criterion.id)}
                      >
                        {walk === criterion.id ? "Close walkthrough" : "Guided walkthrough"}
                      </Button>
                    ) : null}
                  </div>
                  {pending && pending.decision !== "accepted" ? (
                    <input
                      className={inputClass}
                      aria-label="Reason"
                      placeholder={
                        pending.decision === "waived"
                          ? "Why is this waived? (required)"
                          : "What needs to change?"
                      }
                      value={pending.rationale ?? ""}
                      onChange={(e) => setDecision(criterion.id, { rationale: e.target.value })}
                    />
                  ) : null}
                  {walk === criterion.id ? (
                    <Walkthrough
                      criterion={criterion}
                      completed={spec.walkthrough[criterion.id] ?? []}
                      onSave={(steps) =>
                        act(
                          "walkthrough",
                          { walkthrough: { criterionId: criterion.id, completedSteps: steps } },
                          { keepDraft: true },
                        )
                      }
                      onObserve={(text) =>
                        setDecision(criterion.id, {
                          observations: [...(pending?.observations ?? []), text],
                        })
                      }
                    />
                  ) : null}
                  {pending?.observations.length ? (
                    <ul className="list-disc pl-5 text-xs">
                      {pending.observations.map((o, i) => (
                        <li key={i}>{o}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
      {proposed && !disabled ? (
        <div className="flex gap-2">
          <input
            className={inputClass}
            aria-label="New criterion"
            placeholder="Add a criterion"
            value={newCriterion}
            onChange={(e) => setNewCriterion(e.target.value)}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={!newCriterion.trim()}
            onClick={() => {
              setDraft({ ...value, added: [...value.added, newCriterion.trim()] });
              setNewCriterion("");
            }}
          >
            Add
          </Button>
        </div>
      ) : null}
      {value.added.length ? (
        <ul className="list-disc pl-5 text-xs">
          {value.added.map((a, i) => (
            <li key={i}>{a} (new)</li>
          ))}
        </ul>
      ) : null}
      {!disabled ? (
        proposed ? (
          <ActionBar
            actions={actions}
            only={["edit", "agree"]}
            disabled={disabled}
            onAction={(a) =>
              act(a.id, {
                edits: editsPayload,
                added: value.added.map((requirement) => ({
                  requirement,
                  verification: "inspection",
                })),
                decisions: [],
              })
            }
          />
        ) : (
          <ActionBar
            actions={actions}
            only={["review", "request-pass"]}
            disabled={disabled}
            primaryDisabledReason={
              decisionsPayload.length ? null : "Record a decision on at least one criterion."
            }
            onAction={(a) =>
              act(a.id, {
                edits: [],
                added: [],
                decisions:
                  a.id === "request-pass"
                    ? decisionsPayload.filter((d) => d.decision === "changes-requested")
                    : decisionsPayload,
              })
            }
          />
        )
      ) : null}
    </div>
  );
}

function Walkthrough({
  criterion,
  completed,
  onSave,
  onObserve,
}: {
  criterion: Criterion;
  completed: number[];
  onSave: (steps: number[]) => void;
  onObserve: (text: string) => void;
}) {
  const [done, setDone] = useState<number[]>(completed);
  const [index, setIndex] = useState(() => {
    const first = criterion.verification.steps.findIndex((_, i) => !completed.includes(i));
    return first < 0 ? 0 : first;
  });
  const [note, setNote] = useState("");
  const step = criterion.verification.steps[index];
  return (
    <div
      className="rounded border border-primary/30 bg-primary/[0.04] p-2 text-xs"
      role="group"
      aria-label="Guided walkthrough"
    >
      <p className="font-medium">
        Step {index + 1} of {criterion.verification.steps.length}: {step}
      </p>
      {criterion.evidence[0] ? (
        <div className="mt-1">
          <ContentRefPreview
            reference={criterion.evidence[0].ref}
            description={criterion.evidence[0].label}
            compact
          />
        </div>
      ) : null}
      <textarea
        className={cn(textareaClass, "mt-1")}
        rows={2}
        aria-label="Observation"
        placeholder="What did you observe?"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="mt-1 flex flex-wrap justify-end gap-1">
        <Button
          size="sm"
          variant="ghost"
          disabled={index === 0}
          onClick={() => setIndex(index - 1)}
        >
          Back
        </Button>
        <Button
          size="sm"
          onClick={() => {
            if (note.trim()) onObserve(`Step ${index + 1}: ${note.trim()}`);
            const next = [...new Set([...done, index])];
            setDone(next);
            setNote("");
            onSave(next);
            if (index < criterion.verification.steps.length - 1) setIndex(index + 1);
          }}
        >
          {index < criterion.verification.steps.length - 1 ? "Done, next step" : "Done"}
        </Button>
      </div>
      <p className="mt-1 text-muted-foreground">
        {done.length} of {criterion.verification.steps.length} steps completed (saved; resumes after
        you leave).
      </p>
    </div>
  );
}
