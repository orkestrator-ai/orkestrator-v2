import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The selected segment. A selector row can scroll and clip an outset line, so its
 * focus hairline stays inset and takes the text colour, clear of the blue fill.
 */
export const SEGMENT_SELECTED_CLASS_NAME =
  "bg-primary-fill font-bold text-primary-foreground shadow-sm [--focus-hairline-color:currentColor]";

export interface SegmentedSelectorOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  /**
   * Painted over the option's button, which positions it. It must be
   * out of flow and take no pointer events or focus; the selector only hosts it.
   */
  overlay?: ReactNode;
  /** Classes for this option's button alone, applied after `buttonClassName`. */
  className?: string;
  disabled?: boolean;
  panelId?: string;
}

export interface SegmentedSelectorProps<T extends string> {
  value: T;
  options: readonly SegmentedSelectorOption<T>[];
  onValueChange: (value: T) => void;
  disabled?: boolean;
  semantics?: "buttons" | "tabs";
  ariaLabel: string;
  className?: string;
  buttonClassName?: string;
}

export function SegmentedSelector<T extends string>({
  value,
  options,
  onValueChange,
  disabled = false,
  semantics = "buttons",
  ariaLabel,
  className,
  buttonClassName,
}: SegmentedSelectorProps<T>) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const enabled = options
      .map((option, optionIndex) => ({ option, optionIndex }))
      .filter(({ option }) => !disabled && !option.disabled);
    const current = enabled.findIndex(({ optionIndex }) => optionIndex === index);
    if (current < 0) return;
    let target = current;
    if (event.key === "ArrowRight" || event.key === "ArrowDown")
      target = (current + 1) % enabled.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp")
      target = (current - 1 + enabled.length) % enabled.length;
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = enabled.length - 1;
    else return;
    event.preventDefault();
    const optionIndex = enabled[target]!.optionIndex;
    buttons.current[optionIndex]?.focus();
    if (semantics === "tabs") onValueChange(options[optionIndex]!.value);
  };

  return (
    <div
      role={semantics === "tabs" ? "tablist" : "group"}
      aria-label={ariaLabel}
      className={cn(
        "inline-flex min-w-0 items-center rounded-lg border border-divider bg-input-surface p-0.5",
        className,
      )}
    >
      {options.map((option, index) => {
        const selected = value === option.value;
        const isDisabled = disabled || option.disabled;
        return (
          <button
            key={option.value}
            ref={(element) => {
              buttons.current[index] = element;
            }}
            type="button"
            role={semantics === "tabs" ? "tab" : undefined}
            aria-selected={semantics === "tabs" ? selected : undefined}
            aria-controls={semantics === "tabs" ? option.panelId : undefined}
            aria-pressed={semantics === "buttons" ? selected : undefined}
            tabIndex={semantics === "tabs" ? (selected ? 0 : -1) : undefined}
            disabled={isDisabled}
            onKeyDown={(event) => moveFocus(event, index)}
            onClick={() => onValueChange(option.value)}
            className={cn(
              "flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-md px-3 text-sm transition-[background-color,color,box-shadow] focus-hairline disabled:cursor-not-allowed disabled:opacity-50",
              selected
                ? SEGMENT_SELECTED_CLASS_NAME
                : "font-normal text-muted-foreground hover:bg-elevated hover:text-foreground",
              option.overlay && "relative",
              buttonClassName,
              option.className,
            )}
          >
            {option.icon}
            <span className="truncate">{option.label}</span>
            {option.overlay}
          </button>
        );
      })}
    </div>
  );
}
