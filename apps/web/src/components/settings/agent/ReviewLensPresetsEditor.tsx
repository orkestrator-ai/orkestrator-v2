import { ArrowDown, ArrowUp, Plus, RotateCcw, Trash2 } from "lucide-react";
import {
  REVIEW_LENS_INSTRUCTION_MAX_BYTES,
  REVIEW_LENS_LABEL_MAX_CHARS,
  REVIEW_LENS_PRESETS_MAX,
  isShippedReviewLensPresetList,
  restoreShippedReviewLensPresets,
  reviewLensInstructionBytes,
  reviewLensInstructionError,
  reviewLensLabelError,
  type ReviewLensPreset,
} from "@orkestrator/protocol/review-lens";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { createUuid } from "@/lib/uuid";
import { SettingsSectionHeader } from "../SettingsPageLayout";

const byteCount = new Intl.NumberFormat("en-US");

/** The first problem with an edited preset list, or null when it can be saved. */
export function reviewLensPresetsError(presets: readonly ReviewLensPreset[]): string | null {
  if (presets.length > REVIEW_LENS_PRESETS_MAX) {
    return `Keep at most ${REVIEW_LENS_PRESETS_MAX} review focus presets.`;
  }
  for (const [index, preset] of presets.entries()) {
    const error =
      reviewLensLabelError(preset.label) ?? reviewLensInstructionError(preset.instruction);
    if (error) return `Review focus preset ${index + 1}: ${error}`;
  }
  return null;
}

function move<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

/**
 * The review focus presets the launchers offer (`reviewLensPresets`).
 *
 * Every change is the whole list, which the settings form saves like any other
 * field. A launch copies a preset's text into the reviewer it starts, so
 * editing or deleting a preset here never changes a running or recorded review.
 */
export function ReviewLensPresetsEditor({
  presets,
  onChange,
  disabled,
}: {
  presets: readonly ReviewLensPreset[];
  onChange: (presets: ReviewLensPreset[]) => void;
  disabled?: boolean;
}) {
  const restored = restoreShippedReviewLensPresets(presets);
  const unchanged = isShippedReviewLensPresetList(presets);
  const update = (index: number, patch: Partial<ReviewLensPreset>) =>
    onChange(presets.map((preset, i) => (i === index ? { ...preset, ...patch } : preset)));

  return (
    <section className="space-y-3" aria-labelledby="review-lens-presets-heading">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <SettingsSectionHeader title="Review focus presets" headingId="review-lens-presets-heading">
          Offered as a reviewer&apos;s Focus when you launch a Multi Review or a build. A launch
          copies the text, so editing or deleting a preset never changes a review that already
          started. A reviewer with a focus still reports critical issues outside it.
        </SettingsSectionHeader>
        <div className="flex shrink-0 gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={disabled || unchanged || restored === null}
            title={
              restored === null
                ? `Delete presets until the shipped five fit within ${REVIEW_LENS_PRESETS_MAX}.`
                : undefined
            }
            onClick={() => restored && onChange(restored)}
          >
            <RotateCcw className="size-3.5" /> Restore shipped presets
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={disabled || presets.length >= REVIEW_LENS_PRESETS_MAX}
            onClick={() => onChange([...presets, { id: createUuid(), label: "", instruction: "" }])}
          >
            <Plus className="size-3.5" /> Add preset
          </Button>
        </div>
      </div>

      {presets.length === 0 && (
        <p className="rounded-lg border border-dashed border-zinc-800 px-3 py-4 text-xs text-muted-foreground">
          No presets. Launchers still accept a custom focus.
        </p>
      )}

      <ol className="space-y-2" aria-label="Review focus presets">
        {presets.map((preset, index) => {
          const labelError = reviewLensLabelError(preset.label);
          const instructionError = reviewLensInstructionError(preset.instruction);
          const bytes = reviewLensInstructionBytes(preset.instruction);
          const name = preset.label.trim() || `Preset ${index + 1}`;
          const statusId = `review-lens-preset-${preset.id}-status`;
          return (
            <li
              key={preset.id}
              data-review-lens-preset={preset.id}
              className="rounded-lg border border-zinc-800/90 bg-zinc-950/40 p-3"
            >
              <div className="flex items-center gap-2">
                <Input
                  aria-label={`Preset ${index + 1} label`}
                  value={preset.label}
                  disabled={disabled}
                  maxLength={REVIEW_LENS_LABEL_MAX_CHARS * 2}
                  aria-invalid={Boolean(labelError) || undefined}
                  aria-describedby={statusId}
                  onChange={(event) => update(index, { label: event.target.value })}
                  className="h-8 flex-1 border-zinc-700/80 bg-zinc-900 text-sm"
                  placeholder="Label"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  aria-label={`Move ${name} up`}
                  disabled={disabled || index === 0}
                  onClick={() => onChange(move(presets, index, index - 1))}
                >
                  <ArrowUp className="size-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  aria-label={`Move ${name} down`}
                  disabled={disabled || index === presets.length - 1}
                  onClick={() => onChange(move(presets, index, index + 1))}
                >
                  <ArrowDown className="size-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  aria-label={`Delete ${name}`}
                  disabled={disabled}
                  onClick={() => onChange(presets.filter((_, i) => i !== index))}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
              <Textarea
                aria-label={`Preset ${index + 1} instruction`}
                value={preset.instruction}
                disabled={disabled}
                aria-invalid={Boolean(instructionError) || undefined}
                aria-describedby={statusId}
                onChange={(event) => update(index, { instruction: event.target.value })}
                rows={3}
                className="mt-2 max-h-48 border-zinc-700/80 bg-zinc-900 text-xs"
                placeholder="What a reviewer with this focus should look at hardest."
              />
              <p
                id={statusId}
                className={cn(
                  "mt-1 text-[11px] leading-snug",
                  labelError || instructionError ? "text-red-400" : "text-zinc-500",
                )}
              >
                {labelError ??
                  instructionError ??
                  `${byteCount.format(bytes)} / ${byteCount.format(REVIEW_LENS_INSTRUCTION_MAX_BYTES)} bytes`}
              </p>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
