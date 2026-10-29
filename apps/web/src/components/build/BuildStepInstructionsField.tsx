import { useState } from "react";
import { ChevronRight } from "lucide-react";
import {
  MAX_BUILD_STEP_INSTRUCTIONS_BYTES,
  buildStepInstructionsBytes,
} from "@orkestrator/protocol/build-pipeline-stage-instructions";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const byteCount = new Intl.NumberFormat("en-US");

/** True when a step's instructions are over the protocol bound and cannot be sent. */
export function buildStepInstructionsTooLong(value: string): boolean {
  return buildStepInstructionsBytes(value) > MAX_BUILD_STEP_INSTRUCTIONS_BYTES;
}

/**
 * The collapsible "Instructions" field on a build step card.
 *
 * The text is added to that step's prompt after the stage's own contract. It
 * starts collapsed; a card whose field holds text says so while collapsed, and
 * the byte counter turns red over the 16 KiB bound.
 */
export function BuildStepInstructionsField({
  id,
  stepTitle,
  value,
  hint,
  onChange,
}: {
  id: string;
  stepTitle: string;
  value: string;
  /** Extra sentence under the field, e.g. that Fix reuses Build's. */
  hint?: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const bytes = buildStepInstructionsBytes(value);
  const tooLong = bytes > MAX_BUILD_STEP_INSTRUCTIONS_BYTES;
  const hasText = value.trim().length > 0;
  const panelId = `${id}-panel`;
  const countId = `${id}-count`;

  return (
    <div className="mt-2.5">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((current) => !current)}
        className="flex min-h-8 items-center gap-1.5 rounded-md px-1 text-xs font-medium text-zinc-400 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn("size-3.5 transition-transform", open && "rotate-90")}
        />
        {`${stepTitle} instructions`}
        {!open && hasText && (
          <span className={cn("font-normal", tooLong ? "text-red-400" : "text-cyan-300/80")}>
            {tooLong ? "· too long" : "· added"}
          </span>
        )}
      </button>
      {open && (
        <div id={panelId} className="mt-1.5">
          <Textarea
            id={id}
            aria-label={`${stepTitle} instructions`}
            aria-describedby={countId}
            aria-invalid={tooLong || undefined}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder="Optional. Added to this step's prompt after its own instructions."
            rows={3}
            className="max-h-48 border-zinc-700/80 bg-zinc-900 text-xs"
          />
          <p
            id={countId}
            className={cn(
              "mt-1 text-[11px] leading-snug",
              tooLong ? "text-red-400" : "text-zinc-500",
            )}
          >
            {`${byteCount.format(bytes)} / ${byteCount.format(MAX_BUILD_STEP_INSTRUCTIONS_BYTES)} bytes`}
            {tooLong ? ". Shorten them to start the build." : ""}
            {hint ? ` ${hint}` : ""}
          </p>
        </div>
      )}
    </div>
  );
}
