/** Surfaces whose focus belongs to the user while they are open. */
const SURFACE = '[role="dialog"], [role="alertdialog"], [role="menu"]';

/** A closing Radix surface is `data-state="closed"`; a kept-mounted popover is `aria-hidden`. */
function isOpen(surface: Element): boolean {
  return (
    surface.getAttribute("data-state") !== "closed" &&
    surface.getAttribute("aria-hidden") !== "true"
  );
}

/**
 * Whether focus is in an open dialog, popover or menu that `target` is not
 * part of, so a focus move the user did not ask for must not take it.
 *
 * A chat composer moves focus on its own when it mounts and when a draft
 * syncs into it (in Chromium, placing the caret in a contenteditable focuses
 * it). That is right for a user who is not doing anything else. A composer
 * that loads late, such as a coordinator's over a slow link, must not pull
 * focus out of a panel the user has just opened. Focus on an ordinary control
 * (a tab button, a sidebar row) still yields, so opening a chat tab still
 * lands in its composer.
 */
export function isFocusHeldElsewhere(target?: Element | null): boolean {
  if (typeof document === "undefined") return false;
  const active = document.activeElement;
  if (!active || active === document.body || active === document.documentElement) return false;
  if (target && (target === active || target.contains(active))) return false;
  for (
    let surface = active.closest(SURFACE);
    surface;
    surface = surface.parentElement?.closest(SURFACE) ?? null
  ) {
    if (isOpen(surface)) return !(target && surface.contains(target));
  }
  return false;
}
