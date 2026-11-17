import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { DesignDownloadScope, DesignImageFormat } from "./design-frame-download";

const FORMATS: ReadonlyArray<{ format: DesignImageFormat; single: string; many: string }> = [
  { format: "png", single: "PNG image", many: "PNG images (.zip)" },
  { format: "webp", single: "WEBP image", many: "WEBP images (.zip)" },
  { format: "pdf", single: "PDF document", many: "PDF (one page per frame)" },
];

/** Multi-frame groups lead with PDF, the format a slide deck is usually shared in. */
const MANY_ORDER: readonly DesignImageFormat[] = ["pdf", "png", "webp"];

/**
 * The download button above a frame's top-right corner, shown while the frame
 * or an element inside it is selected. It is blue like the selection when the
 * frame itself is selected and grey otherwise. One frame:
 * PNG, WEBP or PDF. With several frames selected a second group downloads the
 * selection, and a last group every frame on the canvas, as a multi-page PDF
 * or a ZIP of images.
 */
export function DesignFrameDownloadMenu({
  frameName,
  frameSelected,
  selectedCount,
  frameCount,
  onDownload,
}: {
  frameName: string;
  /** The frame itself (board) is selected, not just an element inside it. */
  frameSelected: boolean;
  /** Frames in the board selection (this one included). */
  selectedCount: number;
  /** Committed frames on the canvas. */
  frameCount: number;
  onDownload(scope: DesignDownloadScope, format: DesignImageFormat): Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const run = (scope: DesignDownloadScope, format: DesignImageFormat) => {
    setBusy(true);
    void onDownload(scope, format).finally(() => setBusy(false));
  };
  const group = (scope: DesignDownloadScope, label: string, count: number) => (
    <DropdownMenuGroup aria-label={label}>
      <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
        {label}
      </DropdownMenuLabel>
      {count === 1
        ? FORMATS.map(({ format, single }) => (
            <DropdownMenuItem key={format} onSelect={() => run(scope, format)}>
              {single}
            </DropdownMenuItem>
          ))
        : MANY_ORDER.map((format) => (
            <DropdownMenuItem key={format} onSelect={() => run(scope, format)}>
              {FORMATS.find((entry) => entry.format === format)!.many}
            </DropdownMenuItem>
          ))}
    </DropdownMenuGroup>
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Download ${frameName}`}
          aria-busy={busy || undefined}
          disabled={busy}
          data-testid="frame-download"
          data-frame-selected={frameSelected || undefined}
          // Blue like the selection outline and title it sits beside; grey while
          // only an element inside the frame is selected.
          className={`shrink-0 rounded-sm p-0.5 focus-hairline disabled:opacity-70 ${
            frameSelected
              ? "text-blue-500 hover:bg-blue-500/15"
              : "text-muted-foreground hover:bg-muted hover:text-foreground"
          }`}
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        {group("frame", "This frame", 1)}
        {selectedCount > 1 && (
          <>
            <DropdownMenuSeparator />
            {group("selected", `Selected frames (${selectedCount})`, selectedCount)}
          </>
        )}
        {frameCount > 1 && (
          <>
            <DropdownMenuSeparator />
            {group("all", `All frames (${frameCount})`, frameCount)}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
