import { useEffect, useId, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
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

export function DesignStyleField({
  property,
  value,
  onChange,
  scopeKey,
}: {
  property: DesignStyleProperty;
  value: string;
  onChange: (value: string) => void;
  scopeKey?: string;
}) {
  const id = useId();
  const scope = scopeKey ?? property.name;
  const [customScope, setCustomScope] = useState<string | null>(null);
  const custom = customScope === scope;
  useEffect(() => setCustomScope(null), [scope]);
  const color = useMemo(
    () => (property.color ? pickerColor(value) : null),
    [property.color, value],
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
  return (
    <div className={`min-w-0 space-y-1 ${property.wide ? "col-span-2" : ""}`}>
      <label htmlFor={id} className="block text-[11px] text-muted-foreground">
        {property.label}
      </label>
      <div className="flex min-w-0 items-center gap-1.5">
        {property.color && (
          <div className="design-color-swatch relative size-7 shrink-0 overflow-hidden rounded-md border border-border/70">
            <span className="absolute inset-0" style={{ backgroundColor: value }} />
            <input
              type="color"
              aria-label={`Pick ${property.name}`}
              title={`Pick ${property.label.toLowerCase()}`}
              className="absolute inset-0 size-full cursor-pointer opacity-0"
              value={color?.hex ?? "#000000"}
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
            onValueChange={(next) => {
              if (next === customValue) setCustomScope(scope);
              else onChange(next === stylesheetValue ? "" : next);
            }}
          >
            <SelectTrigger
              id={id}
              aria-label={property.name}
              size="sm"
              className="w-full min-w-0 gap-1 px-2 text-xs data-[size=sm]:h-7 [&_svg]:size-3"
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
                Use stylesheet
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
              className={inputClass}
              value={value}
              placeholder="Use stylesheet"
              onChange={(event) => onChange(event.target.value)}
            />
            {property.options && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label={`Choose ${property.name} preset`}
                onClick={() => setCustomScope(null)}
              >
                <ChevronDown className="size-3" />
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
