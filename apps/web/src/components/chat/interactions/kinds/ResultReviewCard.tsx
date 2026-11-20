import { useState } from "react";
import type { ResultReviewResult, ResultReviewSpec } from "@orkestrator/protocol/rich-interactions";
import { cn } from "@/lib/utils";
import {
  ActionBar,
  ContentRefPreview,
  ProvenanceBadge,
  Section,
  textareaClass,
  useReferencedPublications,
  type KindProps,
} from "../shared";

interface ReviewDraft {
  criterionIds: string[];
  comment?: string;
}

/**
 * Feature 7: before-and-after result review. Reported checks and observed
 * evidence are labelled apart; a visual difference is evidence, never a pass.
 * Acceptance records a human judgement of this exact result revision and
 * merges, deploys or closes nothing.
 */
export function ResultReviewCard({
  view,
  spec,
  draft,
  setDraft,
  act,
  disabled,
  actions,
}: KindProps<ResultReviewSpec>) {
  const value = (draft as ReviewDraft | undefined) ?? { criterionIds: [] };
  const [layout, setLayout] = useState<"side" | "stacked">("side");
  const afterReferences = spec.comparisons.flatMap((comparison) =>
    comparison.after?.kind === "artifact" ? [comparison.after] : [],
  );
  const { publications, loaded } = useReferencedPublications(afterReferences);
  const canAccept = afterReferences.every((ref) =>
    publications.some(
      (publication) =>
        publication.ref.artifactId === ref.artifactId &&
        publication.ref.revision === ref.revision &&
        publication.availability === "available",
    ),
  );
  const reviewActions = actions.map((action) =>
    action.id.startsWith("accept") && !canAccept
      ? {
          ...action,
          available: false,
          unavailableReason: loaded
            ? "A reviewed artifact revision is unavailable."
            : "Checking reviewed artifact revisions…",
        }
      : action,
  );
  const decisions = new Map<number, (typeof view.receipts)[number]>();
  for (const receipt of view.receipts) {
    if (["accept", "accept-selected", "request-changes"].includes(receipt.actionId)) {
      const revision = (receipt.result as ResultReviewResult).expectedResultRevision;
      if (Number.isSafeInteger(revision)) decisions.set(revision, receipt);
    }
  }
  const result = (decision: ResultReviewResult["decision"]): ResultReviewResult => ({
    expectedResultRevision: spec.resultRevision,
    decision,
    criterionIds: value.criterionIds,
    ...(value.comment?.trim() ? { comment: value.comment.trim() } : {}),
  });
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">{spec.requestSummary}</p>
      <p className="text-xs text-muted-foreground">
        Result revision {spec.resultRevision} · source revision {spec.sourceRevision}
      </p>
      {spec.comparisons.map((comparison) => (
        <Section key={comparison.id} title={comparison.label}>
          <div className="flex justify-end">
            <button
              type="button"
              className="text-[11px] text-primary focus-hairline"
              onClick={() => setLayout((l) => (l === "side" ? "stacked" : "side"))}
            >
              {layout === "side" ? "Stack" : "Side by side"}
            </button>
          </div>
          <div className={cn("grid gap-2", layout === "side" ? "sm:grid-cols-2" : "grid-cols-1")}>
            {(["before", "after"] as const).map((side) => {
              const reference = comparison[side];
              const text = side === "before" ? comparison.beforeText : comparison.afterText;
              return (
                <figure key={side} className="min-w-0">
                  <figcaption className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {side}
                  </figcaption>
                  {reference ? (
                    <ContentRefPreview
                      reference={reference}
                      description={`${comparison.label}, ${side}`}
                      compact
                    />
                  ) : text !== undefined ? (
                    <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-muted/30 p-2 text-xs">
                      {text}
                    </pre>
                  ) : (
                    <p className="rounded border border-dashed border-border/60 p-2 text-xs text-muted-foreground">
                      No {side} evidence was captured.
                    </p>
                  )}
                </figure>
              );
            })}
          </div>
          {comparison.comparabilityNote ? (
            <p className="text-xs text-muted-foreground">{comparison.comparabilityNote}</p>
          ) : null}
        </Section>
      ))}
      {spec.checks.length ? (
        <Section title="Checks">
          <ul className="flex flex-col gap-1 text-xs">
            {spec.checks.map((check) => (
              <li key={check.id} className="flex flex-wrap items-center gap-2">
                <span
                  className={cn(
                    "font-medium",
                    check.status === "passed"
                      ? "text-success"
                      : check.status === "failed"
                        ? "text-failure"
                        : "text-muted-foreground",
                  )}
                >
                  {check.status}
                </span>
                <span>{check.label}</span>
                <ProvenanceBadge provenance={check.provenance} />
                {check.detail ? (
                  <span className="text-muted-foreground">— {check.detail}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {spec.criteria.length ? (
        <Section title="Criteria">
          <ul className="flex flex-col gap-1 text-sm">
            {spec.criteria.map((criterion) => (
              <li key={criterion.id}>
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1 size-4 accent-primary"
                    disabled={disabled}
                    checked={value.criterionIds.includes(criterion.id)}
                    onChange={(e) =>
                      setDraft({
                        ...value,
                        criterionIds: e.target.checked
                          ? [...value.criterionIds, criterion.id]
                          : value.criterionIds.filter((id) => id !== criterion.id),
                      })
                    }
                  />
                  {criterion.text}
                </label>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {spec.limitations.length ? (
        <Section title="Known limitations">
          <ul className="list-disc pl-5 text-xs text-muted-foreground">
            {spec.limitations.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </Section>
      ) : null}
      {[...decisions.entries()].reverse().map(([revision, decision]) => (
        <p key={revision} className="text-xs text-muted-foreground">
          Your decision: {decision.actionLabel} (result revision {revision}).
        </p>
      ))}
      {!disabled ? (
        <>
          <textarea
            className={textareaClass}
            rows={2}
            aria-label="Comment"
            placeholder="What should change? (needed to request another change)"
            value={value.comment ?? ""}
            onChange={(e) => setDraft({ ...value, comment: e.target.value })}
          />
          <ActionBar
            actions={reviewActions}
            disabled={disabled}
            onAction={(a) => {
              if (a.id === "accept-selected" && value.criterionIds.length === 0) return;
              if (a.id === "request-changes" && !value.comment?.trim()) return;
              act(a.id, result(a.id as ResultReviewResult["decision"]));
            }}
          />
          <p className="text-[11px] text-muted-foreground">
            Accept selected criteria needs at least one criterion checked; requesting a change needs
            a comment.
          </p>
        </>
      ) : null}
    </div>
  );
}
