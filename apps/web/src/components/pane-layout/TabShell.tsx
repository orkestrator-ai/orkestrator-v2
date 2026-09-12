import { forwardRef, type CSSProperties, type HTMLAttributes, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Chrome shared by every tab strip in the app.
 *
 * Pane tabs are the original tab style, so any other surface that shows tabs —
 * the coordinator conversation strip, for one — renders through here instead of
 * inventing its own look. Only the strip's contents differ between surfaces;
 * the row, the tab shell, and the close affordance do not.
 */

/** The row that holds the tabs. */
export const TAB_STRIP_CLASS =
  "flex min-h-[40px] items-center gap-0.5 overflow-x-auto border-b border-border/80 bg-background [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:min-h-[32px]";

/** Every brand mark or type glyph in a tab strip is drawn at this size. */
export const TAB_ICON_CLASS = "h-3 w-3 shrink-0";

interface TabShellProps extends HTMLAttributes<HTMLDivElement> {
  isActive: boolean;
  /** Dims the active marker when the owning pane is not the focused one. */
  isFocused?: boolean;
  style?: CSSProperties;
  /** Icon, title, and any status badges. */
  children: ReactNode;
  /** Omit to render a tab that cannot be closed. */
  onClose?: () => void;
  closeLabel?: string;
  /** Rendered after the close button, e.g. the per-tab mail button. */
  trailing?: ReactNode;
}

export const TabShell = forwardRef<HTMLDivElement, TabShellProps>(function TabShell(
  { isActive, isFocused = true, className, children, onClose, closeLabel, trailing, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        "group relative flex shrink-0 select-none items-center gap-1.5 self-stretch bg-background px-3 text-xs",
        isActive ? "text-foreground" : "text-muted-foreground hover:text-foreground",
        className,
      )}
      {...rest}
    >
      {/* Keep the active tab identifiable when it shares the pane background. */}
      {isActive && (
        <div
          aria-hidden="true"
          className={cn("absolute inset-x-0 bottom-0 h-0.5 bg-primary", !isFocused && "opacity-60")}
        />
      )}
      {children}
      {onClose && (
        <button
          type="button"
          aria-label={closeLabel}
          className="ml-1 flex h-7 w-7 items-center justify-center text-muted-foreground opacity-100 transition-opacity hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60 md:h-auto md:w-auto md:hover-fine:opacity-0 md:hover-fine:group-focus-within:opacity-100 md:hover-fine:group-hover:opacity-100 md:hover-fine:focus-visible:opacity-100"
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <X className="h-3 w-3" />
        </button>
      )}
      {trailing}
    </div>
  );
});
