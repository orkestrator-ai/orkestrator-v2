/**
 * After a search result opens its section, finds the field, scrolls it into
 * view, highlights it and focuses it, and says what happened in a live
 * region. A field that is not on the page (hidden by another setting, or not
 * offered on this machine) is reported rather than silently skipped.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { GlobalSettingsSection } from "@/lib/settings-navigation";
import { createLogger } from "@orkestrator/protocol/logger";
import { waitForSettingField, revealSettingField } from "./field-navigation";
import type { PendingOpen } from "./SettingsSearch";

const log = createLogger("web.settings");

export interface PendingField extends PendingOpen {
  /** Distinguishes two requests for the same field. */
  readonly seq: number;
}

function contentRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-slot="settings-content-scrollport"]');
}

function focusPageHeading(root: HTMLElement | null): void {
  const heading = root?.querySelector<HTMLElement>("h2");
  if (!heading) return;
  if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
  heading.scrollIntoView?.({ block: "start" });
  heading.focus({ preventScroll: true });
}

export function SettingFieldNavigator({
  activeSection,
  pending,
  onSettled,
}: {
  activeSection: GlobalSettingsSection | "";
  pending: PendingField | null;
  onSettled: () => void;
}) {
  const [announcement, setAnnouncement] = useState("");
  const onSettledRef = useRef(onSettled);
  useLayoutEffect(() => {
    onSettledRef.current = onSettled;
  });
  // The highlight outlives the request (it clears itself); unmount stops it.
  const stopHighlightRef = useRef<(() => void) | null>(null);
  useEffect(() => () => stopHighlightRef.current?.(), []);

  useEffect(() => {
    if (!pending || pending.descriptor.section !== activeSection) return;
    const { descriptor, original } = pending;
    if (descriptor.id.startsWith("section:")) {
      // A request for the section itself (fixing an unsaved change there).
      const timer = setTimeout(() => {
        focusPageHeading(contentRoot());
        setAnnouncement(`Opened ${descriptor.label}.`);
        onSettledRef.current();
      }, 0);
      return () => clearTimeout(timer);
    }
    return waitForSettingField(contentRoot, descriptor, (field) => {
      const redirected = original
        ? `${original.label} is not shown now: ${original.availability?.reason ?? ""} `
        : "";
      if (field) {
        stopHighlightRef.current?.();
        stopHighlightRef.current = revealSettingField(field);
        setAnnouncement(`${redirected}Showing ${descriptor.label}.`);
      } else {
        log.info("search.field-missing", { section: descriptor.section });
        focusPageHeading(contentRoot());
        setAnnouncement(
          `${redirected}${descriptor.label} is not shown on this page right now${
            descriptor.availability ? `: ${descriptor.availability.reason}` : "."
          }`,
        );
      }
      onSettledRef.current();
    });
  }, [pending, activeSection]);

  return (
    <div
      role="status"
      aria-live="polite"
      className="sr-only"
      data-testid="settings-navigation-status"
    >
      {announcement}
    </div>
  );
}
