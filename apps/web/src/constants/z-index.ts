/**
 * Stacking layers for surfaces that portal to `document.body`.
 *
 * Radix portals every overlay, dialog, popover and select to the body, so DOM
 * order carries no information: the only thing separating two portalled
 * surfaces is their z-index. The shadcn defaults put all of them at `z-50`,
 * which is correct until a *fullscreen* surface is opened at a higher layer —
 * anything launched from inside it then renders behind an opaque panel while
 * Radix sets `pointer-events: none` on the body, so the app looks frozen.
 *
 * Each constant is the Tailwind class rather than a number, because that is
 * what call sites need and it keeps `tailwind-merge` able to collapse the
 * component default it overrides.
 */

/** Fullscreen settings and similar full-viewport panels. */
export const Z_FULLSCREEN_SURFACE = "z-[60]";

/** Popovers and selects belonging to a fullscreen surface's own chrome. */
export const Z_FULLSCREEN_POPOVER = "z-[70]";

/** Dialogs launched from inside a fullscreen surface. */
export const Z_FULLSCREEN_DIALOG = "z-[80]";

/**
 * Popovers nested inside such a dialog.
 *
 * A raised dialog establishes its own stacking context, so a `z-50` popover
 * portalled to the body would render behind it.
 */
export const Z_FULLSCREEN_DIALOG_POPOVER = "z-[90]";
