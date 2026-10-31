import type { MultiReviewEngine } from "@orkestrator/protocol/multi-review";
import { cn } from "@/lib/utils";
import { SETTINGS_CARD_CLASS } from "../SettingsPageLayout";

const CHOICES: { id: MultiReviewEngine; label: string; description: string }[] = [
  {
    id: "bespoke",
    label: "Multi Review engine",
    description: "The default. Multi Review runs every step itself.",
  },
  {
    id: "graph",
    label: "Graph runtime (preview)",
    description:
      "New Multi Reviews run as a graph run of the built-in Multi Review template. The review tab and every other surface show it the same way; its steps are controlled from the graph run view. Reviews already running keep their engine.",
  },
];

/**
 * Which runtime runs new Multi Reviews (item 301). The backend's
 * `ORKESTRATOR_MULTI_REVIEW_ENGINE` override, when set, wins over this.
 */
export function MultiReviewEngineSetting({
  value,
  onChange,
  disabled,
}: {
  value: MultiReviewEngine;
  onChange: (value: MultiReviewEngine) => void;
  disabled?: boolean;
}) {
  return (
    <div>
      <h3 className="text-sm font-medium text-foreground" id="multi-review-engine-heading">
        Multi Review runtime
      </h3>
      <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
        Applies to Multi Reviews started from now on, from the button, the coordinator and the CLI
        alike.
      </p>
      <div
        role="radiogroup"
        aria-labelledby="multi-review-engine-heading"
        className={cn(SETTINGS_CARD_CLASS, "mt-3 gap-0 overflow-hidden")}
      >
        {CHOICES.map((choice, index) => (
          <label
            key={choice.id}
            className={cn(
              "flex cursor-pointer items-start gap-3 px-4 py-3.5",
              index > 0 && "border-t border-zinc-800/80",
            )}
          >
            <input
              type="radio"
              name="multi-review-engine"
              value={choice.id}
              checked={value === choice.id}
              disabled={disabled}
              onChange={() => onChange(choice.id)}
              className="mt-1 size-3.5 shrink-0 accent-cyan-500"
            />
            <span className="flex min-w-0 flex-col gap-1">
              <span className="text-sm font-medium text-foreground">{choice.label}</span>
              <span className="text-xs leading-relaxed text-muted-foreground">
                {choice.description}
              </span>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}
