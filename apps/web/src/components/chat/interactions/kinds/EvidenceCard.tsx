import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { EvidenceSpec } from "@orkestrator/protocol/rich-interactions";
import { cn } from "@/lib/utils";
import {
  ActionBar,
  ContentRefPreview,
  ProvenanceBadge,
  RefChip,
  textareaClass,
  type KindProps,
} from "../shared";

interface EvidenceDraft {
  claimId?: string;
  evidenceIds: string[];
  question?: string;
}

/**
 * Feature 14: inspectable evidence. Each card separates the source content,
 * the relevance the agent asserted, and who produced it. Opening evidence is
 * local; a challenge targets stable claim and evidence ids.
 */
export function EvidenceCard({
  spec,
  draft,
  setDraft,
  act,
  disabled,
  actions,
}: KindProps<EvidenceSpec>) {
  const value = (draft as EvidenceDraft | undefined) ?? { evidenceIds: [] };
  const [open, setOpen] = useState<string | null>(null);
  const toggle = (id: string) =>
    setDraft({
      ...value,
      evidenceIds: value.evidenceIds.includes(id)
        ? value.evidenceIds.filter((x) => x !== id)
        : [...value.evidenceIds, id],
    });
  return (
    <div className="flex flex-col gap-3">
      {spec.recommendation ? <p className="text-sm font-medium">{spec.recommendation}</p> : null}
      <fieldset className="flex flex-col gap-1" disabled={disabled}>
        <legend className="text-xs font-medium text-muted-foreground">Claims</legend>
        {spec.claims.map((claim) => (
          <label
            key={claim.id}
            className={cn(
              "flex items-start gap-2 rounded px-1 py-0.5 text-sm",
              value.claimId === claim.id && "bg-primary/10",
            )}
          >
            <input
              type="radio"
              name="evidence-claim"
              className="mt-1 accent-primary"
              checked={value.claimId === claim.id}
              onChange={() => setDraft({ ...value, claimId: claim.id })}
            />
            <span>
              <span className="mr-1 rounded bg-muted px-1 text-[10px] uppercase text-muted-foreground">
                {claim.kind}
              </span>
              {claim.text}
            </span>
          </label>
        ))}
      </fieldset>
      <ul className="flex flex-col gap-2" aria-label="Evidence">
        {spec.evidence.map((item) => {
          const links = spec.links.filter(
            (l) => l.evidenceId === item.id && (!value.claimId || l.claimId === value.claimId),
          );
          return (
            <li
              key={item.id}
              className={cn(
                "rounded border px-2 py-1.5",
                value.evidenceIds.includes(item.id)
                  ? "border-primary/50 bg-primary/[0.05]"
                  : "border-border/60",
              )}
            >
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  aria-label={`Select evidence ${item.label}`}
                  disabled={disabled}
                  checked={value.evidenceIds.includes(item.id)}
                  onChange={() => toggle(item.id)}
                />
                <span className="font-medium">{item.label}</span>
                <ProvenanceBadge provenance={item.provenance} />
                <RefChip reference={item.source} />
                {item.capturedAt ? (
                  <span className="text-muted-foreground">captured {item.capturedAt}</span>
                ) : item.source.kind === "file" && item.source.live ? (
                  <span className="text-amber-300">live file: may have changed</span>
                ) : null}
                <button
                  type="button"
                  className="ml-auto flex items-center gap-0.5 text-primary focus-hairline"
                  aria-expanded={open === item.id}
                  onClick={() => setOpen(open === item.id ? null : item.id)}
                >
                  {open === item.id ? (
                    <ChevronDown className="size-3" />
                  ) : (
                    <ChevronRight className="size-3" />
                  )}
                  {open === item.id ? "Hide source" : "Open source"}
                </button>
              </div>
              {links.map((l) => (
                <p key={l.claimId} className="mt-1 text-xs text-muted-foreground">
                  Asserted relevance ({l.assertedBy}): {l.relevance}
                </p>
              ))}
              {item.excerpt ? (
                <blockquote className="mt-1 border-l-2 border-border pl-2 text-xs whitespace-pre-wrap">
                  {item.excerpt}
                </blockquote>
              ) : null}
              {open === item.id ? (
                <div className="mt-2">
                  <ContentRefPreview reference={item.source} description={item.label} compact />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {!disabled ? (
        <>
          <textarea
            className={textareaClass}
            rows={2}
            aria-label="Question"
            placeholder="Your question or challenge"
            value={value.question ?? ""}
            onChange={(e) => setDraft({ ...value, question: e.target.value })}
          />
          <ActionBar
            actions={actions}
            disabled={disabled}
            primaryDisabledReason={
              value.evidenceIds.length ? null : "Select the evidence you mean."
            }
            onAction={(a) =>
              act(a.id, {
                evidenceIds: value.evidenceIds,
                ...(value.claimId ? { claimId: value.claimId } : {}),
                ...(value.question?.trim() ? { question: value.question.trim() } : {}),
              })
            }
          />
        </>
      ) : null}
    </div>
  );
}
