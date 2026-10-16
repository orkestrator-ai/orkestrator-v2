import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { HostPark, HostSlot } from "@/components/layout/HostSlot";

function createPaneHostRegistry() {
  const hosts = new Map<string, HTMLDivElement>();
  return {
    /** Idempotent, so calling it while rendering is safe. */
    hostFor(paneId: string): HTMLDivElement {
      let host = hosts.get(paneId);
      if (!host) {
        host = document.createElement("div");
        host.className = "h-full w-full";
        host.dataset.paneHost = paneId;
        hosts.set(paneId, host);
      }
      return host;
    },
    retain(paneIds: ReadonlySet<string>) {
      for (const [paneId, host] of Array.from(hosts)) {
        if (paneIds.has(paneId)) continue;
        host.remove();
        hosts.delete(paneId);
      }
    },
  };
}

export interface StablePaneHosts {
  /** Render once, in the part of the tree that does not change with the layout. */
  park: ReactNode;
  /** Shows a pane wherever the current layout renders it. */
  slot: (paneId: string) => ReactNode;
  /** Renders a pane's content into its host. Render every portal after the layout. */
  portal: (paneId: string, content: ReactNode) => ReactNode;
}

/**
 * One stable host per pane, so a split layout can change shape without
 * remounting its panes.
 *
 * The desktop split and the mobile pane switcher are different element trees,
 * and splitting a pane moves it deeper into the tree. Rendering a pane inside
 * the layout would remount it on each of those changes, closing its dialogs and
 * dropping drafts and terminal attachments. Each pane renders once into its
 * host instead (`portal`), and the layout only positions the hosts (`slot`).
 */
export function useStablePaneHosts(paneIds: readonly string[]): StablePaneHosts {
  const [registry] = useState(createPaneHostRegistry);
  const parkRef = useRef<HTMLDivElement>(null);
  const paneIdsKey = paneIds.join("\n");

  // Runs after the commit that unmounted a closed pane's portal and slot.
  useLayoutEffect(() => {
    registry.retain(new Set(paneIdsKey.split("\n")));
  }, [registry, paneIdsKey]);

  return useMemo(
    () => ({
      park: <HostPark parkRef={parkRef} />,
      slot: (paneId) => <HostSlot key={paneId} host={registry.hostFor(paneId)} parkRef={parkRef} />,
      portal: (paneId, content) => createPortal(content, registry.hostFor(paneId), paneId),
    }),
    [registry],
  );
}
