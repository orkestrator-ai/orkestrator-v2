import { useLayoutEffect, useRef, type RefObject } from "react";
import { parkHost, placeHost } from "@/lib/stable-host";

/**
 * Stable hosts let content survive a layout switch.
 *
 * Content renders once, through a portal, into a host element that the owner
 * creates and keeps. Each layout renders a `HostSlot` where the content belongs,
 * and the slot moves the host in. A layout switch then moves DOM nodes instead
 * of unmounting React trees, so dialogs, drafts and subscriptions survive it.
 * The owner renders the portals after the layouts, so a slot holds its host
 * before the content's own layout effects measure anything.
 */

interface HostSlotProps {
  host: HTMLElement;
  /** The owner's `HostPark`, which holds the host while no slot does. */
  parkRef: RefObject<HTMLElement | null>;
  className?: string;
}

/** Shows `host` wherever the current layout renders this slot. */
export function HostSlot({ host, parkRef, className = "h-full w-full" }: HostSlotProps) {
  const slotRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const slot = slotRef.current;
    // The park renders before the layouts, so its ref is attached by now.
    const park = parkRef.current;
    if (!slot) return;
    placeHost(host, slot);
    return () => {
      if (host.parentNode !== slot) return;
      if (park) parkHost(host, park);
      else slot.removeChild(host);
    };
  }, [host, parkRef]);
  return <div ref={slotRef} className={className} />;
}

/**
 * Keeps hosts connected between the old layout's slot and the new one's.
 *
 * Render it in the part of the owner that does not change with the layout, and
 * before the layouts, so its ref is attached when their slots mount. It is
 * invisible but laid out at viewport size, so content parked for the length of
 * a commit keeps its scroll offsets and focus.
 */
export function HostPark({ parkRef }: { parkRef: RefObject<HTMLDivElement | null> }) {
  return (
    <div
      ref={parkRef}
      aria-hidden="true"
      data-host-park=""
      className="pointer-events-none invisible fixed inset-0 overflow-hidden"
    />
  );
}
