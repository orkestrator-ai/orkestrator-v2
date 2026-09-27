import { useEffect, useId, useMemo, useState } from "react";
import { ChevronDown, RotateCcw, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface DesignStyleProperty {
  name: string;
  label: string;
  options?: string[];
  color?: boolean;
  wide?: boolean;
}

// The browser resolves named colors and modern CSS color spaces to the native
// picker's sRGB value. The original CSS stays untouched until the user edits it.
export function pickerColor(value: string): { hex: string; alpha: number } | null {
  try {
    if (
      !CSS.supports("color", value) ||
      /^(currentcolor|inherit|initial|unset|revert)/i.test(value) ||
      value.includes("var(")
    )
      return null;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const pixels = context.getImageData(0, 0, 1, 1).data;
    return {
      hex: `#${Array.from(pixels.subarray(0, 3), (channel) => channel.toString(16).padStart(2, "0")).join("")}`,
      alpha: pixels[3]! / 255,
    };
  } catch {
    return null;
  }
}

const inputClass = "h-7 px-2 text-xs md:text-xs";
const customValue = "__custom__";
const stylesheetValue = "__stylesheet__";

export interface DesignStyleFieldProps {
  property: DesignStyleProperty;
  /** Editable value: the draft, else the authored inline value ("" = none). */
  value: string;
  onChange: (value: string) => void;
  scopeKey?: string;
  /** Resolved value from the cascade, shown as the placeholder/stylesheet choice. */
  computed?: string;
  /** The element has an authored inline declaration for this property. */
  inline?: boolean;
  /** The draft differs from the authored baseline. */
  changed?: boolean;
  error?: string;
  note?: string;
  disabled?: boolean;
  /** Removes the inline declaration (returns the property to the cascade). */
  onReset?: () => void;
  /** Discards the unsent draft value for this property. */
  onRevert?: () => void;
}

export function DesignStyleField({
  property,
  value,
  onChange,
  scopeKey,
  computed,
  inline = false,
  changed = false,
  error,
  note,
  disabled = false,
  onReset,
  onRevert,
}: DesignStyleFieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  const noteId = `${id}-note`;
  const stateId = `${id}-state`;
  const scope = scopeKey ?? property.name;
  const [customScope, setCustomScope] = useState<string | null>(null);
  const custom = customScope === scope;
  useEffect(() => setCustomScope(null), [scope]);
  // The picker starts from what the user sees: the draft/inline value, else the cascade.
  const colorBase = value || computed || "";
  const color = useMemo(
    () => (property.color ? pickerColor(colorBase) : null),
    [property.color, colorBase],
  );
  const options = property.options
    ? Array.from(
        new Set([
          ...property.options,
          "inherit",
          "initial",
          "unset",
          "revert",
          ...(value ? [value] : []),
        ]),
      )
    : [];
  const showComputed = Boolean(computed && value && computed !== value);
  const describedBy =
    [
      error ? errorId : null,
      note && !error ? noteId : null,
      changed || showComputed ? stateId : null,
    ]
      .filter(Boolean)
      .join(" ") || undefined;
  const fieldState = {
    "aria-invalid": error ? (true as const) : undefined,
    "aria-describedby": describedBy,
    "data-changed": changed ? "true" : undefined,
  };
  const changedClass = changed ? "border-primary ring-1 ring-primary/40" : "";
  return (
    <div
      className={`min-w-0 space-y-1 ${property.wide ? "col-span-2" : ""}`}
      data-property={property.name}
    >
      <div className="flex min-w-0 items-center gap-1">
        <label htmlFor={id} className="min-w-0 truncate text-[11px] text-muted-foreground">
          {property.label}
        </label>
        {inline && (
          <span
            className="shrink-0 rounded-sm bg-muted px-1 text-[9px] leading-4 text-foreground"
            title="Authored inline declaration on this element"
          >
            inline
          </span>
        )}
        {changed && (
          <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
        )}
        <span className="ml-auto flex shrink-0 items-center">
          {onRevert && (
            <button
              type="button"
              className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-ring disabled:opacity-50"
              aria-label={`Revert ${property.name}`}
              title="Discard the unsent value"
              disabled={disabled}
              onClick={onRevert}
            >
              <Undo2 className="size-3" />
            </button>
          )}
          {onReset && (
            <button
              type="button"
              className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-ring disabled:opacity-50"
              aria-label={`Reset ${property.name}`}
              title="Remove the inline declaration and use the stylesheet"
              disabled={disabled}
              onClick={onReset}
            >
              <RotateCcw className="size-3" />
            </button>
          )}
        </span>
      </div>
      <div className="flex min-w-0 items-center gap-1.5">
        {property.color && (
          <div className="design-color-swatch relative size-7 shrink-0 overflow-hidden rounded-md border border-border/70">
            <span className="absolute inset-0" style={{ backgroundColor: colorBase }} />
            <input
              type="color"
              aria-label={`Pick ${property.name}`}
              title={`Pick ${property.label.toLowerCase()}`}
              className="absolute inset-0 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
              value={color?.hex ?? "#000000"}
              disabled={disabled}
              onChange={(event) => {
                const hex = event.target.value;
                // Keep partial transparency when changing hue. A transparent
                // swatch becomes visible when the user explicitly picks a color.
                if (color && color.alpha > 0 && color.alpha < 1) {
                  const channels = [1, 3, 5].map((offset) =>
                    parseInt(hex.slice(offset, offset + 2), 16),
                  );
                  onChange(`rgba(${channels.join(", ")}, ${Number(color.alpha.toFixed(3))})`);
                } else onChange(hex);
              }}
            />
          </div>
        )}
        {property.options && !custom ? (
          <Select
            value={value || stylesheetValue}
            disabled={disabled}
            onValueChange={(next) => {
              if (next === customValue) setCustomScope(scope);
              else onChange(next === stylesheetValue ? "" : next);
            }}
          >
            <SelectTrigger
              id={id}
              aria-label={property.name}
              size="sm"
              className={`w-full min-w-0 gap-1 px-2 text-xs data-[size=sm]:h-7 [&_svg]:size-3 ${changedClass}`}
              {...fieldState}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.map((option) => (
                <SelectItem key={option} value={option} className="text-xs">
                  {option}
                </SelectItem>
              ))}
              <SelectItem value={stylesheetValue} className="text-xs">
                {computed ? `Use stylesheet (${computed})` : "Use stylesheet"}
              </SelectItem>
              <SelectItem value={customValue} className="text-xs">
                Custom…
              </SelectItem>
            </SelectContent>
          </Select>
        ) : (
          <>
            <Input
              id={id}
              aria-label={property.name}
              className={`${inputClass} ${changedClass}`}
              value={value}
              placeholder={computed || "Use stylesheet"}
              disabled={disabled}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => onChange(event.target.value)}
              {...fieldState}
            />
            {property.options && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label={`Choose ${property.name} preset`}
                disabled={disabled}
                onClick={() => setCustomScope(null)}
              >
                <ChevronDown className="size-3" />
              </Button>
            )}
          </>
        )}
      </div>
      {(changed || showComputed) && (
        <p id={stateId} className="truncate text-[10px] text-muted-foreground" title={computed}>
          {changed ? <span className="text-primary">Changed · </span> : null}
          {computed ? `computed ${computed}` : "not applied"}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-[10px] break-words text-destructive">
          {error}
        </p>
      )}
      {note && !error && (
        <p id={noteId} className="text-[10px] break-words text-muted-foreground">
          {note}
        </p>
      )}
    </div>
  );
}
