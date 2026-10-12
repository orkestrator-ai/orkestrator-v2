import { useCallback, useRef, useState, type MouseEvent } from "react";
import { CheckCircle2, History } from "lucide-react";
import { cn } from "@/lib/utils";

const HISTORY_HOVER_ZONE_WIDTH_PX = 96;
const HISTORY_HOVER_ZONE_HEIGHT_PX = 56;

export function useTerminalCornerHover() {
  const [historyCornerHovered, setHistoryCornerHovered] = useState(false);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const handleTerminalPointerMove = useCallback((event: MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setHistoryCornerHovered(
      event.clientX >= rect.right - HISTORY_HOVER_ZONE_WIDTH_PX &&
        event.clientY <= rect.top + HISTORY_HOVER_ZONE_HEIGHT_PX,
    );
  }, []);
  const handleTerminalPointerLeave = useCallback((event: MouseEvent<HTMLDivElement>) => {
    // The toolbar is a sibling of xterm. Keep it revealed during the leave/enter
    // handoff or disabling pointer events can send the pointer back to xterm.
    if (event.relatedTarget instanceof Node && toolbarRef.current?.contains(event.relatedTarget)) {
      return;
    }
    setHistoryCornerHovered(false);
  }, []);

  return {
    historyCornerHovered,
    terminalHoverProps: {
      // Capture movement so xterm's mouse-reporting handlers cannot swallow it.
      onMouseMoveCapture: handleTerminalPointerMove,
      onMouseEnter: handleTerminalPointerMove,
      onMouseLeave: handleTerminalPointerLeave,
    },
    toolbarHoverProps: {
      ref: toolbarRef,
      onMouseEnter: () => setHistoryCornerHovered(true),
      onMouseLeave: () => setHistoryCornerHovered(false),
    },
  };
}

export function TerminalCornerToolbar({
  showHistoryButton,
  showMarkSetupComplete,
  onOpenHistory,
  onMarkSetupComplete,
  hover,
}: {
  showHistoryButton: boolean;
  showMarkSetupComplete: boolean;
  onOpenHistory: () => void;
  onMarkSetupComplete: () => void;
  hover: ReturnType<typeof useTerminalCornerHover>;
}) {
  if (!showHistoryButton && !showMarkSetupComplete) return null;

  return (
    // Banners at z-30 own overlapping dismissal/recovery controls. The toolbar
    // itself never catches input; only its visible buttons do.
    <div
      {...hover.toolbarHoverProps}
      className="pointer-events-none absolute top-1 right-2 z-20 flex items-center gap-1.5"
    >
      {showMarkSetupComplete && (
        <button
          type="button"
          onClick={onMarkSetupComplete}
          className="pointer-events-auto flex items-center gap-1.5 rounded-md bg-zinc-800/90 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100 border border-zinc-700/50 transition-colors shadow-md backdrop-blur-sm"
        >
          <CheckCircle2 className="h-3.5 w-3.5" />
          Mark setup complete
        </button>
      )}
      {showHistoryButton && (
        <button
          type="button"
          aria-label="Open earlier terminal output"
          title="Earlier output"
          onClick={onOpenHistory}
          className={cn(
            "pointer-events-auto rounded-md border border-zinc-700/50 bg-zinc-800/90 p-1.5 text-zinc-400 shadow-md backdrop-blur-sm transition-opacity hover:bg-zinc-700 hover:text-zinc-100 opacity-100",
            // Touch-only screens need a visible affordance at every width.
            !hover.historyCornerHovered &&
              "hover-fine:opacity-0 hover-fine:pointer-events-none hover-fine:focus-visible:opacity-100 hover-fine:focus-visible:pointer-events-auto",
          )}
        >
          <History className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
