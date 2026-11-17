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
import { canWriteImage, canWriteWebpImage } from "@/lib/clipboard-image-write";
import type {
  DesignCopyFormat,
  DesignDownloadScope,
  DesignImageFormat,
} from "./design-frame-download";

const FORMATS: ReadonlyArray<{ format: DesignImageFormat; single: string; many: string }> = [
  { format: "png", single: "Download PNG", many: "PNG images (.zip)" },
  { format: "webp", single: "Download WEBP", many: "WEBP images (.zip)" },
  { format: "pdf", single: "Download PDF", many: "PDF (one page per frame)" },
];

const COPY_FORMATS: ReadonlyArray<{ format: DesignCopyFormat; label: string }> = [
  { format: "png", label: "Copy PNG" },
  { format: "webp", label: "Copy WEBP" },
];

/** Which copy formats this client's clipboard can take. */
function copyFormatsAvailable(): ReadonlySet<DesignCopyFormat> {
  const formats = new Set<DesignCopyFormat>();
  if (canWriteImage()) formats.add("png");
  if (canWriteWebpImage()) formats.add("webp");
  return formats;
}

/** Multi-frame groups lead with PDF, the format a slide deck is usually shared in. */
const MANY_ORDER: readonly DesignImageFormat[] = ["pdf", "png", "webp"];

/**
 * The download button above a frame's top-right corner, shown while the frame
 * or an element inside it is selected. It is blue like the selection when the
 * frame itself is selected and grey otherwise. One frame: copy PNG or WEBP
 * where the clipboard accepts it, or download PNG, WEBP or PDF. With several
 * frames selected a second group downloads the
 * selection, and a last group every frame on the canvas, as a multi-page PDF
 * or a ZIP of images.
 */
export function DesignFrameDownloadMenu({
  frameName,
  frameSelected,
  selectedCount,
  frameCount,
  onDownload,
  onCopy,
  copyFormats = copyFormatsAvailable(),
}: {
  frameName: string;
  /** The frame itself (board) is selected, not just an element inside it. */
  frameSelected: boolean;
  /** Frames in the board selection (this one included). */
  selectedCount: number;
  /** Committed frames on the canvas. */
  frameCount: number;
  onDownload(scope: DesignDownloadScope, format: DesignImageFormat): Promise<void>;
  /** Starts the clipboard write synchronously: it is called from the click. */
  onCopy(format: DesignCopyFormat): Promise<void>;
  /** Copy formats to offer; defaults to what this client's clipboard accepts. */
  copyFormats?: ReadonlySet<DesignCopyFormat>;
}) {
  const [busy, setBusy] = useState(false);
  const track = (work: Promise<void>) => {
    setBusy(true);
    void work.finally(() => setBusy(false));
  };
  const run = (scope: DesignDownloadScope, format: DesignImageFormat) =>
    track(onDownload(scope, format));
  const group = (scope: DesignDownloadScope, label: string, count: number) => (
    <DropdownMenuGroup aria-label={label}>
      <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
        {label}
      </DropdownMenuLabel>
      {scope === "frame" &&
        COPY_FORMATS.filter(({ format }) => copyFormats.has(format)).map(({ format, label }) => (
          <DropdownMenuItem key={`copy-${format}`} onSelect={() => track(onCopy(format))}>
            {label}
          </DropdownMenuItem>
        ))}
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
