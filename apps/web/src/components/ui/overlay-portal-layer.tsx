import * as React from "react";

import { cn } from "@/lib/utils";

const OverlayPortalLayerContext = React.createContext<string | undefined>(undefined);

/**
 * Raises portaled overlays (selects, dropdown menus) above a parent surface
 * that itself sits above the default `z-50` layer.
 *
 * Radix portals those overlays to `document.body`, so a fullscreen panel at
 * `z-[60]` would otherwise hide them while `pointer-events: none` on the body
 * makes the UI look frozen.
 */
export function OverlayPortalLayer({
  className,
  children,
}: {
  className: string;
  children: React.ReactNode;
}): React.ReactElement {
  const parentClassName = React.useContext(OverlayPortalLayerContext);
  return (
    <OverlayPortalLayerContext.Provider value={cn(parentClassName, className)}>
      {children}
    </OverlayPortalLayerContext.Provider>
  );
}

/** Stacking class for a portaled overlay, if an ancestor raised the layer. */
export function useOverlayPortalLayer(): string | undefined {
  return React.useContext(OverlayPortalLayerContext);
}
