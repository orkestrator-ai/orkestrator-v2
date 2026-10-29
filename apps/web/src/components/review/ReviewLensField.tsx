import { useMemo, useState } from "react";
import {
  REVIEW_LENS_INSTRUCTION_MAX_BYTES,
  matchingReviewLensPreset,
  normalizeReviewLens,
  resolveReviewLensPresets,
  reviewLensInstructionBytes,
  reviewLensInstructionError,
  reviewLensLabelError,
  type ReviewLens,
  type ReviewLensPreset,
} from "@orkestrator/protocol/review-lens";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useConfigStore } from "@/stores/configStore";
import { cn } from "@/lib/utils";

const byteCount = new Intl.NumberFormat("en-US");
const NONE = "";
const CUSTOM = "custom:";

/** The presets this machine's launchers offer: the saved list, or the shipped five. */
export function useReviewLensPresets(): ReviewLensPreset[] {
  const stored = useConfigStore((state) => state.config.global.reviewLensPresets);
  return useMemo(() => resolveReviewLensPresets(stored), [stored]);
}

/**
 * Why a reviewer's focus cannot be launched, or null. A custom focus left
 * completely blank means no focus, not an error.
 */
export function reviewLensDraftError(draft: ReviewLens | undefined): string | null {
  if (!draft) return null;
  if (draft.label.trim() === "" && draft.instruction.trim() === "") return null;
  return reviewLensLabelError(draft.label) ?? reviewLensInstructionError(draft.instruction);
}

/** `{ lens }` for a launched row: the trimmed copy, or nothing for no focus. */
export function launchedReviewLens(draft: ReviewLens | undefined): { lens?: ReviewLens } {
  const lens = normalizeReviewLens(draft);
  return lens ? { lens } : {};
}

/**
 * A reviewer's "Focus": none, one of the saved presets, or custom text.
 *
 * Choosing a preset copies its text into the row, so the launch carries the
 * text rather than a reference, and a later edit of the preset never changes a
 * running or recorded review. Choosing Custom after a preset starts from the
 * preset's text so it can be adjusted.
 */
export function ReviewLensField({
  id,
  reviewerLabel,
  value,
  presets,
  onChange,
  className,
}: {
  id: string;
  /** "Reviewer 2", used in the accessible names. */
  reviewerLabel: string;
  value: ReviewLens | undefined;
  presets: readonly ReviewLensPreset[];
  onChange: (value: ReviewLens | undefined) => void;
  className?: string;
}) {
  const [customChosen, setCustomChosen] = useState(false);
  const matching = matchingReviewLensPreset(value, presets);
  const custom = value !== undefined && (customChosen || !matching);
  const selected = value === undefined ? NONE : custom ? CUSTOM : `preset:${matching!.id}`;
  const error = custom ? reviewLensDraftError(value) : null;
  const bytes = value ? reviewLensInstructionBytes(value.instruction) : 0;
  const errorId = `${id}-error`;

  return (
    <div className={cn("mt-2", className)} data-review-lens-field>
      <div className="flex min-w-0 items-center gap-2">
        <label htmlFor={id} className="shrink-0 text-xs font-medium text-zinc-400">
          Focus
        </label>
        <select
          id={id}
          aria-label={`${reviewerLabel} focus`}
          value={selected}
          onChange={(event) => {
            const next = event.target.value;
            if (next === NONE) {
              setCustomChosen(false);
              onChange(undefined);
            } else if (next === CUSTOM) {
              setCustomChosen(true);
              onChange(value ? { ...value } : { label: "", instruction: "" });
            } else {
              const preset = presets.find((entry) => `preset:${entry.id}` === next);
              setCustomChosen(false);
              if (preset) onChange({ label: preset.label, instruction: preset.instruction });
            }
          }}
          className="h-8 min-w-0 flex-1 rounded-md border border-zinc-700/80 bg-zinc-900 px-2 text-xs text-zinc-200"
        >
          <option value={NONE}>No focus</option>
          {presets.map((preset) => (
            <option key={preset.id} value={`preset:${preset.id}`}>
              {preset.label}
            </option>
          ))}
          <option value={CUSTOM}>Custom…</option>
        </select>
      </div>
      {value && !custom && (
        <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-zinc-500">
          {value.instruction}
        </p>
      )}
      {custom && value && (
        <div className="mt-1.5 space-y-1.5">
          <Input
            aria-label={`${reviewerLabel} focus label`}
            value={value.label}
            onChange={(event) => onChange({ ...value, label: event.target.value })}
            placeholder="Label, e.g. Migrations"
            aria-invalid={Boolean(error && reviewLensLabelError(value.label)) || undefined}
            aria-describedby={errorId}
            className="h-8 border-zinc-700/80 bg-zinc-900 text-xs"
          />
          <Textarea
            aria-label={`${reviewerLabel} focus instruction`}
            value={value.instruction}
            onChange={(event) => onChange({ ...value, instruction: event.target.value })}
            placeholder="What this reviewer should look at hardest."
            rows={3}
            aria-invalid={
              Boolean(error && reviewLensInstructionError(value.instruction)) || undefined
            }
            aria-describedby={errorId}
            className="max-h-40 border-zinc-700/80 bg-zinc-900 text-xs"
          />
          <p
            id={errorId}
            className={cn("text-[11px] leading-snug", error ? "text-red-400" : "text-zinc-500")}
          >
            {error ??
              `${byteCount.format(bytes)} / ${byteCount.format(REVIEW_LENS_INSTRUCTION_MAX_BYTES)} bytes`}
          </p>
        </div>
      )}
    </div>
  );
}
