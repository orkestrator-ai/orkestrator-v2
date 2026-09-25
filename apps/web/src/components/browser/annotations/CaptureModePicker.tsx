import type { BrowserPreviewCaptureMode } from "@orkestrator/protocol/browser-preview";
import { cn } from "@/lib/utils";
import { CAPTURE_MODE_LABELS } from "./format";

/**
 * Compact selection-mode picker. Only modes both the backend and the desktop
 * support are offered; the choice lasts for this tab's review session.
 */
export function CaptureModePicker({
  modes,
  value,
  onChange,
  disabled,
}: {
  modes: BrowserPreviewCaptureMode[];
  value: BrowserPreviewCaptureMode;
  onChange: (mode: BrowserPreviewCaptureMode) => void;
  disabled?: boolean;
}) {
  if (modes.length <= 1) return null;
  return (
    <div
      role="radiogroup"
      aria-label="Selection mode"
      className="flex items-center gap-0.5 rounded-md border border-border/70 p-0.5"
    >
      {modes.map((mode) => (
        <button
          key={mode}
          type="button"
          role="radio"
          aria-checked={value === mode}
          disabled={disabled}
          onClick={() => onChange(mode)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
            event.preventDefault();
            const index = modes.indexOf(value);
            const next =
              modes[(index + (event.key === "ArrowRight" ? 1 : modes.length - 1)) % modes.length];
            if (next) onChange(next);
          }}
          className={cn(
            "rounded px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
            value === mode && "bg-primary/15 text-foreground",
          )}
        >
          {CAPTURE_MODE_LABELS[mode]}
        </button>
      ))}
    </div>
  );
}
