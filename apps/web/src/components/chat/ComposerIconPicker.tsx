import {
  Bot,
  FilePen,
  Hammer,
  Hand,
  MapIcon,
  ShieldCheck,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { NativeAgentApprovalModeKind } from "@orkestrator/protocol/native-agent";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface ComposerIconOption {
  id: string;
  label: string;
  description?: string;
  icon: LucideIcon;
  iconClassName: string;
  disabled?: boolean;
  /** Shown beside the icon when selected: a choice the user should be able to read, not decode. */
  showLabel?: boolean;
}

/** Build and plan keep their own icons; any other agent profile gets a generic one. */
export function conversationModeIconOption(
  id: string,
  label: string,
  description?: string,
): ComposerIconOption {
  const visual =
    id === "build"
      ? { icon: Hammer, iconClassName: "text-yellow-500" }
      : id === "plan"
        ? { icon: MapIcon, iconClassName: "text-green-500" }
        : { icon: Bot, iconClassName: "text-muted-foreground" };
  return { id, label, ...(description ? { description } : {}), ...visual };
}

const APPROVAL_MODE_VISUALS: Record<
  NativeAgentApprovalModeKind,
  Pick<ComposerIconOption, "icon" | "iconClassName">
> = {
  ask: { icon: Hand, iconClassName: "text-sky-500" },
  "auto-edits": { icon: FilePen, iconClassName: "text-violet-500" },
  "auto-review": { icon: ShieldCheck, iconClassName: "text-teal-500" },
  // Red, the risk colour: the one mode in which commands run without asking.
  "auto-approve": { icon: Zap, iconClassName: "text-red-500" },
};

export function approvalModeIconOption(mode: {
  id: string;
  label: string;
  description?: string;
  kind: NativeAgentApprovalModeKind;
  disabled?: boolean;
}): ComposerIconOption {
  return {
    id: mode.id,
    label: mode.label,
    ...(mode.description ? { description: mode.description } : {}),
    ...(mode.disabled ? { disabled: true } : {}),
    // Any mode that skips asking says so in words on the composer.
    ...(mode.kind === "ask" ? {} : { showLabel: true }),
    ...APPROVAL_MODE_VISUALS[mode.kind],
  };
}

interface ComposerIconPickerProps {
  /** What the control chooses, e.g. "Mode"; announced with the current choice. */
  label: string;
  options: readonly ComposerIconOption[];
  value: string | undefined;
  onValueChange: (id: string) => void;
  disabled?: boolean;
  testId?: string;
  /**
   * The keyboard shortcut that cycles this control from the prompt input, so
   * the tooltip and assistive technology both say how it is reached.
   */
  shortcut?: string;
}

/**
 * A compose-bar control that shows only the current choice's icon. Opening it
 * lists every choice above the bar with its icon and name.
 */
export function ComposerIconPicker({
  label,
  options,
  value,
  onValueChange,
  disabled = false,
  testId,
  shortcut,
}: ComposerIconPickerProps) {
  const selected = options.find((option) => option.id === value) ?? options[0];
  if (!selected) return null;
  const SelectedIcon = selected.icon;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid={testId}
          disabled={disabled}
          aria-label={`${label}: ${selected.label}`}
          title={`${label}: ${selected.label}${shortcut ? ` (${shortcut} in the prompt to switch)` : ""}`}
          aria-keyshortcuts={shortcut}
          className={cn(
            "flex h-7 items-center justify-center gap-1.5 rounded-lg bg-elevated transition-colors hover:bg-elevated-hover disabled:cursor-not-allowed disabled:opacity-50",
            selected.showLabel ? "min-w-7 shrink-0 @md:px-2" : "w-7",
          )}
        >
          <SelectedIcon className={cn("h-4 w-4 shrink-0", selected.iconClassName)} />
          {selected.showLabel ? (
            <span
              aria-hidden="true"
              className="hidden whitespace-nowrap text-xs text-foreground @md:inline"
            >
              {selected.label}
            </span>
          ) : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" collisionPadding={8} className="min-w-40">
        <DropdownMenuRadioGroup value={selected.id} onValueChange={onValueChange}>
          {options.map((option) => {
            const Icon = option.icon;
            return (
              <DropdownMenuRadioItem
                key={option.id}
                value={option.id}
                disabled={option.disabled}
                title={option.description}
              >
                <Icon className={option.iconClassName} />
                {option.label}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
