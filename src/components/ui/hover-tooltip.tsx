import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

type TooltipSide = "bottom" | "right";
type TooltipAlign = "center" | "start";

type TooltipPosition = {
  left: number;
  top: number;
  transform?: string;
};

function getTooltipPosition(
  rect: DOMRect,
  side: TooltipSide,
  align: TooltipAlign,
  sideOffset: number,
): TooltipPosition {
  if (side === "right") {
    return {
      left: rect.right + sideOffset,
      top: align === "center" ? rect.top + rect.height / 2 : rect.top,
      transform: align === "center" ? "translateY(-50%)" : undefined,
    };
  }

  return {
    left: align === "center" ? rect.left + rect.width / 2 : rect.left,
    top: rect.bottom + sideOffset,
    transform: align === "center" ? "translateX(-50%)" : undefined,
  };
}

export function useHoverTooltip(openDelay = 500, closeDelay = 100) {
  const [open, setOpen] = useState(false);
  const openTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  const clearOpenTimer = useCallback(() => {
    if (openTimerRef.current) {
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
  }, []);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const show = useCallback(() => {
    clearCloseTimer();
    // Keep the tooltip visible if it's already open (e.g. moving onto its content),
    // but otherwise wait for the open delay so a new tooltip doesn't appear instantly
    // when dragging the cursor between adjacent hover targets.
    if (open || openTimerRef.current) return;
    openTimerRef.current = window.setTimeout(() => {
      setOpen(true);
      openTimerRef.current = null;
    }, openDelay);
  }, [clearCloseTimer, open, openDelay]);

  const hide = useCallback(() => {
    clearOpenTimer();
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => {
      setOpen(false);
      closeTimerRef.current = null;
    }, closeDelay);
  }, [clearOpenTimer, clearCloseTimer, closeDelay]);

  useEffect(() => {
    return () => {
      clearOpenTimer();
      clearCloseTimer();
    };
  }, [clearOpenTimer, clearCloseTimer]);

  return { open, show, hide };
}

export function HoverTooltipContent({
  anchorRef,
  open,
  side = "bottom",
  align = "center",
  sideOffset = 4,
  className,
  children,
  onMouseEnter,
  onMouseLeave,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  side?: TooltipSide;
  align?: TooltipAlign;
  sideOffset?: number;
  className?: string;
  children: ReactNode;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}) {
  const [position, setPosition] = useState<TooltipPosition | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }

    const updatePosition = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      setPosition(getTooltipPosition(anchor.getBoundingClientRect(), side, align, sideOffset));
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);

    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [align, anchorRef, open, side, sideOffset]);

  if (!open || !position) return null;

  return createPortal(
    <div
      className={cn(
        "fixed z-50 w-fit rounded-md bg-foreground px-3 py-1.5 text-xs text-background text-balance shadow-md [&_.text-muted-foreground]:text-zinc-600",
        className,
      )}
      style={{
        left: position.left,
        top: position.top,
        transform: position.transform,
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {children}
      <div
        className={cn(
          "absolute size-2.5 rotate-45 rounded-[2px] bg-foreground",
          side === "right" && "left-0 top-1/2 -translate-x-1/2 -translate-y-1/2",
          side === "bottom" && "left-4 top-0 -translate-y-1/2",
        )}
      />
    </div>,
    document.body,
  );
}
