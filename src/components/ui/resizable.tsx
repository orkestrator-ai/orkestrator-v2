import * as React from "react"
import { Group, Panel, Separator } from "react-resizable-panels"

import { cn } from "@/lib/utils"

function ResizablePanelGroup({
  className,
  ...props
}: React.ComponentProps<typeof Group>) {
  return (
    <Group
      data-slot="resizable-panel-group"
      className={cn("h-full w-full", className)}
      {...props}
    />
  )
}

function ResizablePanel({
  ...props
}: React.ComponentProps<typeof Panel>) {
  return <Panel data-slot="resizable-panel" {...props} />
}

interface ResizableHandleProps extends React.ComponentProps<typeof Separator> {
  /** Explicitly set orientation when auto-detection doesn't work */
  orientation?: "horizontal" | "vertical"
}

function ResizableHandle({
  className,
  orientation,
  style,
  ...props
}: ResizableHandleProps) {
  const isVertical = orientation === "vertical"

  // Use inline styles to ensure dimensions are set correctly and avoid
  // specificity issues with the library's inline styles
  const handleStyle: React.CSSProperties = {
    ...style,
    // Keep the divider visually exact; wider transparent hit areas read as gaps
    // against headers with a different surface color.
    ...(isVertical
      ? { height: "1px", width: "100%" }
      : { width: "1px", height: "100%" }),
  }

  return (
    <Separator
      data-slot="resizable-handle"
      style={handleStyle}
      className={cn(
        // Base styles - always applied
        "focus-visible:ring-ring relative z-30 flex items-center justify-center bg-zinc-900 transition-colors after:absolute after:bg-border/80 hover:after:bg-primary/50",
        // Prevent flex from collapsing the handle
        "shrink-0",
        // Focus styles
        "focus-visible:ring-1 focus-visible:ring-offset-1 focus-visible:outline-hidden",
        // Orientation-specific cursor
        isVertical
          ? "cursor-row-resize after:h-px after:w-full"
          : "cursor-col-resize after:h-full after:w-px",
        className
      )}
      {...props}
    />
  )
}

export { ResizablePanelGroup, ResizablePanel, ResizableHandle }
