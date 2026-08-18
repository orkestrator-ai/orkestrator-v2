/**
 * The shared "Inherit" affordance for the repository and environment tiers.
 *
 * Every settings control at a narrower tier offers Inherit as its first option
 * and is on it by default. The label names both the value that would apply and
 * where it comes from, so a user can tell a deliberate parent choice from a
 * shipped default before deciding to override it. Before this, the three
 * dialogs each phrased inheritance differently ("Use App Default", "Global
 * (Native)", "Default (Agent SDK)") and none of them said which tier answered.
 */
import { cn } from "@/lib/utils";
import { TIER_LABELS, type AgentSettingsTierName } from "@/lib/agent-settings";

export const INHERIT = "__inherit__";

export function inheritLabel(value: string | undefined, from: AgentSettingsTierName): string {
  if (!value) return `Inherit (from ${TIER_LABELS[from]})`;
  return `Inherit — ${value} (from ${TIER_LABELS[from]})`;
}

interface OptionCardsProps<T extends string> {
  ariaLabel: string;
  value: T | typeof INHERIT;
  onChange: (value: T | typeof INHERIT) => void;
  /** Omitted at the widest tier, which has nothing above it to inherit from. */
  inherit?: { label: string };
  options: Array<{ value: T; label: string; hint?: string; icon?: React.ReactNode }>;
  disabled?: boolean;
  columns?: string;
}

/** A radio group of cards, with Inherit first when the tier has a parent. */
export function OptionCards<T extends string>({
  ariaLabel,
  value,
  onChange,
  inherit,
  options,
  disabled,
  columns = "sm:grid-cols-3",
}: OptionCardsProps<T>) {
  type Entry = { value: T | typeof INHERIT; label: string; hint?: string; icon?: React.ReactNode };
  const entries: Entry[] = [
    ...(inherit ? [{ value: INHERIT, label: inherit.label } as Entry] : []),
    ...options,
  ];
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cn("grid grid-cols-1 gap-2", columns)}>
      {entries.map((entry) => (
        <button
          key={entry.value}
          type="button"
          role="radio"
          aria-checked={value === entry.value}
          disabled={disabled}
          onClick={() => onChange(entry.value)}
          className={cn(
            "rounded-lg border-2 p-3 text-left transition-colors",
            value === entry.value
              ? "border-primary bg-primary/5"
              : "border-transparent bg-zinc-900 hover:border-zinc-600",
            disabled && "cursor-not-allowed opacity-50",
          )}
        >
          <div className="flex items-center gap-2 text-sm font-medium">
            {entry.icon}
            <span>{entry.label}</span>
          </div>
          {entry.hint && <div className="mt-1 text-xs text-muted-foreground">{entry.hint}</div>}
        </button>
      ))}
    </div>
  );
}
