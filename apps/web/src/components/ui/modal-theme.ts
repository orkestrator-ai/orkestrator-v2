export const MODAL_OVERLAY_CLASS_NAME = "bg-black/75 backdrop-blur-md";

export const MODAL_CONTENT_CLASS_NAME =
  "border-zinc-700/70 bg-background shadow-[0_28px_90px_rgba(0,0,0,0.72)] rounded-2xl [&_input]:bg-input-surface [&_textarea]:bg-input-surface [&_[data-slot=select-trigger]]:bg-input-surface";

export type ModalSize = "sm" | "md" | "lg" | "xl" | "2xl" | "3xl" | "4xl" | "5xl" | "6xl" | "full";

export const DEFAULT_MODAL_SIZE: ModalSize = "lg";

/**
 * Width for `DialogContent` and `AlertDialogContent`. Below `sm` a modal fills
 * the viewport less a 0.5rem gutter per side; from `sm` it is capped at
 * `--modal-max-width` inside a 1rem gutter. The breakpoint lives in the
 * `--modal-limit` variable, so the one `max-w-*` class has no prefix:
 * tailwind-merge drops it when a caller passes any unprefixed `max-w-*`, and
 * a caller's `sm:max-w-*` still wins from `sm` up.
 */
export const MODAL_WIDTH_CLASS_NAME =
  "w-full [--modal-limit:calc(100%-1rem)] sm:[--modal-limit:min(var(--modal-max-width),calc(100%-2rem))] max-w-(--modal-limit)";

/**
 * Sizes follow Tailwind's container scale. For a width outside it, pass
 * `[--modal-max-width:<length>]` in `className`; that keeps the gutters.
 */
export const MODAL_SIZE_CLASS_NAME: Record<ModalSize, string> = {
  sm: "[--modal-max-width:24rem]",
  md: "[--modal-max-width:28rem]",
  lg: "[--modal-max-width:32rem]",
  xl: "[--modal-max-width:36rem]",
  "2xl": "[--modal-max-width:42rem]",
  "3xl": "[--modal-max-width:48rem]",
  "4xl": "[--modal-max-width:56rem]",
  "5xl": "[--modal-max-width:64rem]",
  "6xl": "[--modal-max-width:72rem]",
  full: "[--modal-max-width:100%]",
};

export const MODAL_HEADER_CLASS_NAME =
  "-mx-4 -mt-4 border-b border-divider bg-background px-4 py-4 text-center sm:-mx-6 sm:-mt-6 sm:px-6 sm:text-left";

export const MODAL_HEADER_CLOSE_BUTTON_CLASS_NAME = "pr-12 sm:pr-14";

/**
 * Trigger theme for an `AgentModelPicker` rendered inside a modal, so every
 * picker in a dialog reads as the same raised input surface as the text and
 * select controls beside it. `MODAL_CONTENT_CLASS_NAME` cannot reach these:
 * the picker trigger is a plain button, not an input, textarea or select.
 */
export const MODAL_MODEL_PICKER_TRIGGER_CLASS_NAME =
  "h-9 w-full max-w-none justify-start rounded-lg border border-border/70 bg-input-surface px-3 text-sm shadow-none hover:bg-elevated md:max-w-none md:flex-1";

export const MODAL_FOOTER_CLASS_NAME =
  "-mx-4 -mb-4 flex flex-col-reverse gap-2 border-t border-divider px-4 py-3 sm:-mx-6 sm:-mb-6 sm:flex-row sm:justify-end sm:px-6";
