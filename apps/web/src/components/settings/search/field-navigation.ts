/**
 * Finding a catalogued field on its page once its section has rendered, then
 * scrolling to it, highlighting it briefly and focusing it. Focus lands on
 * the field's control (or its anchor) and never activates it, so the value is
 * unchanged.
 */
import type { SettingDescriptor } from "@/lib/settings-catalog/types";

/** Classes the highlighted anchor carries for {@link HIGHLIGHT_MS}. */
export const SETTING_HIGHLIGHT_CLASSES = [
  "rounded-md",
  "ring-2",
  "ring-ring/70",
  "ring-offset-4",
  "ring-offset-background",
  "transition-shadow",
];
export const HIGHLIGHT_MS = 2000;

const FOCUSABLE =
  'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [role="switch"], [role="radio"], [role="combobox"], a[href], [tabindex]:not([tabindex="-1"])';

function byAccessibleName(root: ParentNode, name: string): HTMLElement | null {
  for (const element of Array.from(root.querySelectorAll<HTMLElement>("[aria-label]"))) {
    if (element.getAttribute("aria-label") === name) return element;
  }
  return null;
}

function byHeading(root: ParentNode, text: string): HTMLElement | null {
  for (const heading of Array.from(root.querySelectorAll<HTMLElement>("h2, h3"))) {
    if (heading.textContent?.trim() === text) return heading;
  }
  return null;
}

export interface LocatedField {
  /** The block to scroll to and highlight. */
  readonly anchor: HTMLElement;
  /** What receives focus. */
  readonly focus: HTMLElement;
}

/** The field for `descriptor` under `root`, or `null` when it is not rendered. */
export function locateSettingField(
  root: ParentNode,
  descriptor: SettingDescriptor,
): LocatedField | null {
  const anchor = root.querySelector<HTMLElement>(
    `[data-setting-anchor="${CSS.escape(descriptor.id)}"]`,
  );
  const locate = descriptor.locate;
  const locatedControl = locate?.id
    ? root.querySelector<HTMLElement>(`#${CSS.escape(locate.id)}`)
    : locate?.ariaLabel
      ? byAccessibleName(anchor ?? root, locate.ariaLabel)
      : null;
  const control =
    locatedControl?.getAttribute("role") === "radiogroup"
      ? (locatedControl.querySelector<HTMLElement>(
          '[role="radio"][aria-checked="true"]:not([disabled])',
        ) ?? locatedControl.querySelector<HTMLElement>('[role="radio"]:not([disabled])'))
      : locatedControl;
  if (anchor) {
    const focus =
      (control && anchor.contains(control) ? control : null) ??
      Array.from(anchor.querySelectorAll<HTMLElement>(FOCUSABLE)).find(
        (element) => !element.closest("[data-setting-explanation]") && isShown(element),
      ) ??
      anchor;
    return { anchor, focus };
  }
  if (control) {
    // The smallest block holding the control and its label reads as the field.
    const label = control.id
      ? root.querySelector<HTMLElement>(`label[for="${CSS.escape(control.id)}"]`)
      : null;
    let block: HTMLElement = control.parentElement ?? control;
    while (label && !block.contains(label) && block.parentElement) block = block.parentElement;
    return { anchor: block, focus: control };
  }
  const heading = locate?.heading ? byHeading(root, locate.heading) : null;
  if (heading) return { anchor: heading.parentElement ?? heading, focus: heading };
  return null;
}

function isShown(element: HTMLElement): boolean {
  return !element.closest("[hidden]") && element.getAttribute("aria-hidden") !== "true";
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Scroll to, highlight and focus a located field. Returns a stop for the highlight timer. */
export function revealSettingField(field: LocatedField): () => void {
  field.anchor.scrollIntoView?.({
    block: "center",
    behavior: prefersReducedMotion() ? "auto" : "smooth",
  });
  field.anchor.classList.add(...SETTING_HIGHLIGHT_CLASSES);
  field.anchor.setAttribute("data-setting-highlighted", "true");
  if (field.focus === field.anchor || field.focus.tabIndex < 0) {
    if (!field.focus.hasAttribute("tabindex")) field.focus.setAttribute("tabindex", "-1");
  }
  field.focus.focus({ preventScroll: true });
  const timer = setTimeout(() => {
    field.anchor.classList.remove(...SETTING_HIGHLIGHT_CLASSES);
    field.anchor.removeAttribute("data-setting-highlighted");
  }, HIGHLIGHT_MS);
  return () => {
    clearTimeout(timer);
    field.anchor.classList.remove(...SETTING_HIGHLIGHT_CLASSES);
    field.anchor.removeAttribute("data-setting-highlighted");
  };
}

/**
 * Poll for the field while its section loads (a remote machine's settings, a
 * form that shows a spinner first), for at most `attempts` × `intervalMs`.
 * Calls `onResult` once, with the field or `null`. The returned function stops
 * the polling; the owner calls it on unmount (AGENTS.md invariant 15).
 */
export function waitForSettingField(
  root: () => ParentNode | null,
  descriptor: SettingDescriptor,
  onResult: (field: LocatedField | null) => void,
  { attempts = 60, intervalMs = 50 }: { attempts?: number; intervalMs?: number } = {},
): () => void {
  let remaining = attempts;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    const container = root();
    const field = container ? locateSettingField(container, descriptor) : null;
    if (field || --remaining <= 0) {
      stopped = true;
      onResult(field);
      return;
    }
    timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, 0);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
