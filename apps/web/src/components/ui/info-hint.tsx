import { useRef, useState, type ReactNode } from "react";
import { Info } from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * A small info icon whose explanation opens on hover or focus, and stays open
 * when clicked (which is also how touch reaches it) until clicked again,
 * Escape or a click elsewhere. For settings whose title says enough on its own.
 */
export function InfoHint({
  label,
  children,
  className,
}: {
  /** Accessible name of the icon button, e.g. "About automatic switching". */
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  // Dismissal wins over an ongoing hover/focus. Re-arm on leaving the trigger.
  const [dismissed, setDismissed] = useState(false);
  const open = !dismissed && (hovered || pinned);
  const dismiss = () => {
    setHovered(false);
    setPinned(false);
    setDismissed(true);
  };
  return (
    <Tooltip open={open} onOpenChange={setHovered} delayDuration={150}>
      <TooltipTrigger asChild>
        <button
          ref={trigger}
          type="button"
          aria-label={label}
          aria-expanded={open}
          className={cn(
            "inline-flex shrink-0 items-center rounded-sm text-muted-foreground hover:text-foreground focus-hairline focus-hairline-outset",
            className,
          )}
          onPointerLeave={() => setDismissed(false)}
          onBlur={() => setDismissed(false)}
          onClick={() => {
            if (pinned) dismiss();
            else {
              setDismissed(false);
              setPinned(true);
            }
          }}
        >
          <Info className="h-3.5 w-3.5" aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        align="start"
        sideOffset={4}
        className="max-w-sm space-y-1.5 py-2 text-left leading-relaxed text-pretty"
        onPointerDownOutside={(event) => {
          // The trigger is outside the portaled content. Its click owns toggling;
          // clearing pinned on pointerdown would make that click pin it again.
          if (event.target instanceof Node && trigger.current?.contains(event.target)) {
            event.preventDefault();
            return;
          }
          dismiss();
        }}
        onEscapeKeyDown={dismiss}
      >
        {children}
      </TooltipContent>
    </Tooltip>
  );
}
