import { useEffect, useLayoutEffect, useState } from "react";
import { cn } from "@/lib/utils";
import {
  startRemoteWorkspaceSelectionSync,
  useRemoteWorkspaceStore,
} from "@/stores/remoteWorkspaceStore";
import { useFederation } from "./FederationProvider";
import { InTreeWorkspace } from "./InTreeWorkspace";

type Rect = { x: number; y: number; width: number; height: number };

/**
 * The central region's workspaces of other nodes, each in this window's own
 * tree (`InTreeWorkspace`, in the node's scope). It is rendered once, outside
 * the window's layouts, and placed over `anchor` (the central region of the
 * current layout), so a node's workspace keeps its state when the window
 * switches between the desktop and phone layouts. Nodes that are not shown
 * stay held behind it, hidden, as their scope's tier allows (plan item 4002).
 */
export function RemoteWorkspaceRegion({ anchor }: { anchor: HTMLElement | null }) {
  const { kind, portalState } = useFederation();
  const openNodes = useRemoteWorkspaceStore((state) => state.openNodes);
  const activeNodeId = useRemoteWorkspaceStore((state) => state.active?.nodeId ?? null);
  const rect = useAnchorRect(activeNodeId ? anchor : null);

  // While another node's workspace may be shown, a selection of the window's
  // own brings the central region back to it.
  const anyOpen = openNodes.length > 0;
  useEffect(() => (anyOpen ? startRemoteWorkspaceSelectionSync() : undefined), [anyOpen]);
  // A machine removed from the command node takes its workspace with it.
  useEffect(() => {
    if (!portalState.loaded) return;
    for (const nodeId of openNodes) {
      if (!portalState.nodes.some((node) => node.nodeId === nodeId)) {
        useRemoteWorkspaceStore.getState().closeNode(nodeId);
      }
    }
  }, [portalState.loaded, portalState.nodes, openNodes]);

  if (kind === "none" || openNodes.length === 0) return null;
  const shown = activeNodeId !== null && rect !== null;
  return (
    <div
      className={cn("fixed z-10 bg-background", !shown && "hidden")}
      style={rect ? { left: rect.x, top: rect.y, width: rect.width, height: rect.height } : {}}
      data-testid="remote-workspace-region"
      data-node={activeNodeId ?? undefined}
    >
      {openNodes.map((nodeId) => (
        <InTreeWorkspace key={nodeId} nodeId={nodeId} shown={shown && nodeId === activeNodeId} />
      ))}
    </div>
  );
}

/** The anchor's viewport rect, following resizes of the window and its panels. */
function useAnchorRect(anchor: HTMLElement | null): Rect | null {
  const [measured, setMeasured] = useState<{ anchor: HTMLElement; rect: Rect } | null>(null);
  useLayoutEffect(() => {
    if (!anchor) return;
    let frame = 0;
    const measure = () => {
      const next = anchor.getBoundingClientRect();
      setMeasured((current) =>
        current?.anchor === anchor &&
        current.rect.x === next.left &&
        current.rect.y === next.top &&
        current.rect.width === next.width &&
        current.rect.height === next.height
          ? current
          : {
              anchor,
              rect: { x: next.left, y: next.top, width: next.width, height: next.height },
            },
      );
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    const observer = new ResizeObserver(schedule);
    observer.observe(anchor);
    // Panels to its left change its position without changing its size.
    if (anchor.parentElement) observer.observe(anchor.parentElement);
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [anchor]);
  return anchor && measured?.anchor === anchor ? measured.rect : null;
}
