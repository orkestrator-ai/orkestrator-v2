import {
  forwardRef,
  type CSSProperties,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from "react";
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

/** Responsive height shared by adjacent workspace chrome rows. */
export const WORKSPACE_BAR_HEIGHT_CLASS = "min-h-[40px] md:min-h-[32px]";

/** The row that holds the tabs. */
export const TAB_STRIP_CLASS = `flex ${WORKSPACE_BAR_HEIGHT_CLASS} items-center gap-0.5 overflow-x-auto border-b border-border/80 bg-background [scrollbar-width:none] [&::-webkit-scrollbar]:hidden`;

/** Every brand mark or type glyph in a tab strip is drawn at this size. */
export const TAB_ICON_CLASS = "h-3 w-3 shrink-0";

/** Arrow keys, Home and End move focus between a strip's tabs, without selecting one. */
export function moveTabFocus(event: KeyboardEvent<HTMLElement>) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'));
  const current = tabs.findIndex((tab) => tab === event.target);
  if (current < 0) return;
  event.preventDefault();
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next]?.focus();
}

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
  /** Keep the close control mounted and focused while actions are blocked. */
  closeDisabled?: boolean;
  /** -1 when the shell is itself the tab, so the tab keeps a single tab stop. */
  closeTabIndex?: number;
  /** Rendered after the close button, e.g. the per-tab mail button. */
  trailing?: ReactNode;
}

export const TabShell = forwardRef<HTMLDivElement, TabShellProps>(function TabShell(
  {
    isActive,
    isFocused = true,
    className,
    children,
    onClose,
    closeLabel,
    closeDisabled = false,
    closeTabIndex,
    trailing,
    ...rest
  },
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
          data-tab-close=""
          aria-label={closeLabel}
          aria-disabled={closeDisabled || undefined}
          tabIndex={closeTabIndex}
          className="ml-1 flex h-7 w-7 items-center justify-center text-muted-foreground opacity-100 transition-opacity hover:text-foreground focus-hairline aria-disabled:opacity-40 md:h-auto md:w-auto md:hover-fine:opacity-0 md:hover-fine:group-focus-within:opacity-100 md:hover-fine:group-hover:opacity-100 md:hover-fine:focus-visible:opacity-100"
          onClick={(event) => {
            event.stopPropagation();
            if (!closeDisabled) onClose();
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
