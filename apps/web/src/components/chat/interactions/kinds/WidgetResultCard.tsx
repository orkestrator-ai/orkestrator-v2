import { useEffect, useMemo, useState } from "react";
import {
  formErrors,
  summarizeFormValues,
  type FormValues,
  type WidgetResultSpec,
} from "@orkestrator/protocol/rich-interactions";
import { Button } from "@/components/ui/button";
import {
  latestArtifactResultCandidate,
  subscribeArtifactResultCandidates,
  type ArtifactResultCandidate,
} from "@/lib/chat/artifact-result-candidates";
import { ContentRefPreview, type KindProps } from "../shared";
import { FormFields } from "./FormFields";

/** FNV-1a over the canonical JSON of the reviewed value: binds the receipt to what was shown. */
export function candidateHash(value: unknown): string {
  const text = JSON.stringify(value, Object.keys(value as object).sort());
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a:${hash.toString(16).padStart(8, "0")}`;
}

/**
 * Feature 12: an explorer's result submission. The authored frame may only
 * propose values (`orkestratorArtifact.proposeResult`); this host-owned card
 * shows the latest candidate for the exact bound revision, checks it against
 * the declared output, lets the person adjust it with ordinary fields, and
 * freezes what they reviewed. Only the "Send result" click here submits; a
 * newer candidate never replaces values under an open review.
 */
export function WidgetResultCard({
  view,
  spec,
  act,
  disabled,
  actions,
}: KindProps<WidgetResultSpec>) {
  const [candidate, setCandidate] = useState<ArtifactResultCandidate | null>(() =>
    latestArtifactResultCandidate(spec.artifactId, spec.revision),
  );
  const [review, setReview] = useState<{
    candidate: ArtifactResultCandidate;
    values: FormValues;
  } | null>(null);
  useEffect(
    () => subscribeArtifactResultCandidates(spec.artifactId, spec.revision, setCandidate),
    [spec.artifactId, spec.revision],
  );
  const candidateErrors = useMemo(
    () => (candidate ? formErrors(spec.output, candidate.value) : {}),
    [candidate, spec.output],
  );
  const reviewErrors = useMemo(
    () => (review ? formErrors(spec.output, review.values) : {}),
    [review, spec.output],
  );
  const send = actions[0];
  const changedSinceReview =
    review && candidate && candidate.candidateId !== review.candidate.candidateId;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">{spec.intent}</p>
      <ContentRefPreview
        reference={{ kind: "artifact", artifactId: spec.artifactId, revision: spec.revision }}
        description="The explorer. Activate it, adjust the inputs, and its proposed result appears below."
      />
      {spec.assumptions.length ? (
        <ul className="list-disc pl-5 text-xs text-muted-foreground">
          {spec.assumptions.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      ) : null}
      <div className="rounded border border-border/60 p-2">
        <p className="mb-1 text-xs font-medium">Proposed by the explorer</p>
        {!candidate ? (
          <p className="text-xs text-muted-foreground">
            No result proposed yet. Exploring in the viewer costs no model call.
          </p>
        ) : Object.keys(candidateErrors).length ? (
          <p className="text-xs text-failure" role="alert">
            The explorer proposed values that do not match its declared output (
            {Object.values(candidateErrors)[0]}). They cannot be sent.
          </p>
        ) : (
          <pre className="whitespace-pre-wrap text-xs">
            {summarizeFormValues(spec.output.fields, candidate.value as FormValues).join("\n")}
          </pre>
        )}
        {candidate && !Object.keys(candidateErrors).length && !review && !disabled ? (
          <Button
            size="sm"
            variant="outline"
            className="mt-2"
            onClick={() => setReview({ candidate, values: candidate.value as FormValues })}
          >
            Review these values
          </Button>
        ) : null}
      </div>
      {review ? (
        <div
          className="flex flex-col gap-2 rounded border border-primary/30 bg-primary/[0.04] p-2"
          role="group"
          aria-label="Review result"
        >
          <p className="text-xs font-medium">
            Values to send (frozen from candidate {review.candidate.candidateId}; adjust if needed)
          </p>
          {changedSinceReview ? (
            <p className="text-xs text-amber-300">
              The explorer proposed newer values. This review keeps the values you are looking at;
              start a new review to use the newer ones.
            </p>
          ) : null}
          <FormFields
            fields={spec.output.fields}
            values={review.values}
            onChange={(values) => setReview({ ...review, values })}
            errors={reviewErrors}
            disabled={disabled}
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setReview(null)}>
              Cancel
            </Button>
            {send ? (
              <Button
                size="sm"
                disabled={disabled || Object.keys(reviewErrors).length > 0}
                onClick={() => {
                  act(send.id, {
                    candidateId: review.candidate.candidateId,
                    candidateHash: candidateHash(review.values),
                    generation: review.candidate.generation,
                    value: review.values,
                  });
                  setReview(null);
                }}
              >
                {send.label}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {view.receipts.length ? (
        <p className="text-[11px] text-muted-foreground">
          {view.receipts.length} result(s) sent from this explorer.
        </p>
      ) : null}
    </div>
  );
}
