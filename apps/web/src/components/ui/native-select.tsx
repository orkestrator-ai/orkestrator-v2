import * as React from "react";
import { ChevronDownIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * A native `<select>` drawn with the same surface as `SelectTrigger`, `Input`
 * and the model picker trigger: the input surface, a soft border, the focus
 * hairline and a trailing chevron. Use it wherever a plain select sits next to
 * those controls so a form's dropdowns read as one family; the element stays a
 * real `<select>`, so keyboard, form and accessibility behaviour are native.
 */
const NativeSelect = React.forwardRef<
  HTMLSelectElement,
  Omit<React.ComponentProps<"select">, "size"> & {
    /** Control height, as on `SelectTrigger`; replaces the native list-box `size`. */
    size?: "sm" | "default";
    /** Classes for the wrapper, which controls width and layout. */
    wrapperClassName?: string;
  }
>(({ className, wrapperClassName, size = "default", children, ...props }, ref) => (
  <div
    data-slot="native-select-wrapper"
    className={cn("relative inline-flex min-w-0", wrapperClassName)}
  >
    <select
      ref={ref}
      data-slot="native-select"
      data-size={size}
      className={cn(
        "border-border/70 bg-input-surface text-foreground w-full min-w-0 cursor-pointer appearance-none truncate rounded-md border pr-8 pl-3 shadow-xs transition-[color,box-shadow] outline-none",
        "focus-hairline aria-invalid:[--focus-hairline-color:var(--color-destructive)] aria-invalid:border-destructive",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "data-[size=default]:h-9 data-[size=default]:text-sm data-[size=sm]:h-8 data-[size=sm]:text-xs",
        "[&>option]:bg-zinc-900 [&>option]:text-zinc-200",
        className,
      )}
      {...props}
    >
      {children}
    </select>
    <ChevronDownIcon
      aria-hidden="true"
      className="text-muted-foreground pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 opacity-70"
    />
  </div>
));

NativeSelect.displayName = "NativeSelect";

export { NativeSelect };
