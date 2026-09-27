import { useState } from "react";
import { MonitorSmartphone } from "lucide-react";
import type { BrowserPreviewCaptureCapabilities } from "@orkestrator/protocol/browser-preview";
import { Button } from "@/components/ui/button";

/** Common widths offered for a responsive set; filtered to the desktop's bounds. */
export const RESPONSIVE_PRESET_WIDTHS = [375, 768, 1024, 1440] as const;

export function responsiveWidthOptions(
  limits: NonNullable<BrowserPreviewCaptureCapabilities["features"]["responsiveSets"]>,
): number[] {
  return RESPONSIVE_PRESET_WIDTHS.filter(
    (width) => width >= limits.minWidth && width <= limits.maxWidth,
  );
}

/**
 * Explicit, bounded responsive capture: the preview is resized to each chosen
 * width in turn and restored afterwards. Nothing happens until the user
 * presses Capture.
 */
export function ResponsiveCaptureControl({
  limits,
  disabled,
  onCapture,
}: {
  limits: NonNullable<BrowserPreviewCaptureCapabilities["features"]["responsiveSets"]>;
  disabled?: boolean;
  onCapture: (widths: number[]) => Promise<unknown>;
}) {
  const options = responsiveWidthOptions(limits);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(options.slice(0, Math.min(2, limits.maxWidths))),
  );
  const [busy, setBusy] = useState(false);
  if (options.length === 0) return null;
  const atLimit = selected.size >= limits.maxWidths;
  return (
    <div className="relative">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-7 gap-1 px-2 text-xs"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <MonitorSmartphone className="h-3 w-3" aria-hidden />
        Widths…
      </Button>
      {open && (
        <fieldset
          className="absolute right-0 top-8 z-10 w-64 space-y-1.5 rounded-md border border-border/80 bg-popover p-2 text-[11px] shadow-md"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              setOpen(false);
            }
          }}
        >
          <legend className="sr-only">Responsive capture widths</legend>
          <p className="font-medium">Capture this page at several widths</p>
          <p className="text-muted-foreground">
            The preview is resized to each width in turn, one after another, then restored. Images
            are not simultaneous. Up to {limits.maxWidths} widths.
          </p>
          <div className="flex flex-wrap gap-2">
            {options.map((width) => {
              const checked = selected.has(width);
              return (
                <label key={width} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!checked && atLimit}
                    onChange={(event) => {
                      const next = new Set(selected);
                      if (event.target.checked) next.add(width);
                      else next.delete(width);
                      setSelected(next);
                    }}
                  />
                  {width} px
                </label>
              );
            })}
          </div>
          <div className="flex gap-1.5">
            <Button
              type="button"
              size="sm"
              className="h-6 px-2 text-[11px]"
              disabled={busy || selected.size === 0}
              onClick={() => {
                setBusy(true);
                void onCapture(Array.from(selected).sort((a, b) => a - b)).finally(() => {
                  setBusy(false);
                  setOpen(false);
                });
              }}
            >
              {busy
                ? "Capturing…"
                : `Capture ${selected.size} width${selected.size === 1 ? "" : "s"}`}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px]"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
          </div>
        </fieldset>
      )}
    </div>
  );
}
