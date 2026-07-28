import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowRightToLine,
  ArrowUp,
  CircleStop,
  X,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type TerminalKey = {
  label: string;
  data: string;
  icon: LucideIcon;
};

const TERMINAL_KEYS: TerminalKey[] = [
  { label: "Escape", data: "\u001b", icon: X },
  { label: "Tab", data: "\t", icon: ArrowRightToLine },
  { label: "Control C", data: "\u0003", icon: CircleStop },
  { label: "Up arrow", data: "\u001b[A", icon: ArrowUp },
  { label: "Down arrow", data: "\u001b[B", icon: ArrowDown },
  { label: "Left arrow", data: "\u001b[D", icon: ArrowLeft },
  { label: "Right arrow", data: "\u001b[C", icon: ArrowRight },
];

export function resolveTerminalKeyData(
  data: string,
  applicationCursorKeysMode: boolean,
): string {
  if (
    applicationCursorKeysMode
    && data.length === 3
    && data.startsWith("\u001b[")
    && "ABCD".includes(data[2] ?? "")
  ) {
    return `\u001bO${data[2]}`;
  }
  return data;
}

interface MobileTerminalKeyBarProps {
  onInput: (data: string) => void;
  disabled?: boolean;
  /** Keep the bar in normal layout flow instead of pinning it over a portal. */
  contained?: boolean;
  className?: string;
}

export function MobileTerminalKeyBar({
  onInput,
  disabled = false,
  contained = false,
  className,
}: MobileTerminalKeyBarProps) {
  return (
    <div
      className={cn(
        "z-30 border-t border-white/10 bg-zinc-950/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-sm",
        contained ? "relative shrink-0" : "absolute inset-x-0 bottom-0",
        className,
      )}
    >
      <div
        role="toolbar"
        aria-label="Terminal keys"
        className="grid h-12 grid-cols-7 gap-1 px-1.5 py-1"
      >
        {TERMINAL_KEYS.map(({ label, data, icon: Icon }) => (
          <Button
            key={label}
            type="button"
            variant="ghost"
            size="icon"
            aria-label={label}
            title={label}
            disabled={disabled}
            className="h-10 w-full touch-manipulation rounded-md border border-white/10 bg-white/[0.06] text-zinc-200 shadow-sm active:bg-white/15 active:text-white"
            onPointerDown={(event) => {
              // Do not steal focus from xterm's hidden textarea or dismiss the
              // software keyboard before the key reaches the PTY.
              event.preventDefault();
            }}
            onClick={() => onInput(data)}
          >
            <Icon className="size-4.5" strokeWidth={2} aria-hidden="true" />
          </Button>
        ))}
      </div>
    </div>
  );
}
