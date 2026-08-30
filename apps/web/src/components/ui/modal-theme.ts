export const MODAL_OVERLAY_CLASS_NAME = "bg-black/75 backdrop-blur-md";

export const MODAL_CONTENT_CLASS_NAME =
  "border-zinc-700/70 bg-background shadow-[0_28px_90px_rgba(0,0,0,0.72)] rounded-2xl [&_input]:bg-input-surface [&_textarea]:bg-input-surface [&_[data-slot=select-trigger]]:bg-input-surface";

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
