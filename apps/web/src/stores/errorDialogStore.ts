import { create } from "zustand";

/** Identifies what an error is about when the message alone could fit several. */
export interface ErrorContext {
  project?: string;
  environment?: string;
}

export interface ErrorDetails {
  title: string;
  message: string;
  timestamp: Date;
  /** Optional initial prompt that was lost due to the error */
  initialPrompt?: string;
  /** Optional project/environment the error belongs to */
  context?: ErrorContext;
}

interface ErrorDialogState {
  /** Currently displayed error, or null if dialog is closed */
  error: ErrorDetails | null;

  /** Show the error details dialog, optionally with an initial prompt that was lost */
  showError: (
    title: string,
    message: string,
    initialPrompt?: string,
    context?: ErrorContext,
  ) => void;

  /** Close the error details dialog */
  closeError: () => void;
}

/** "Project / Environment", or whichever half is known; empty when neither is. */
export function formatErrorContext(context: ErrorContext | undefined): string {
  return [context?.project, context?.environment].filter(Boolean).join(" / ");
}

export const useErrorDialogStore = create<ErrorDialogState>()((set) => ({
  error: null,

  showError: (title, message, initialPrompt, context) =>
    set({
      error: {
        title,
        message,
        timestamp: new Date(),
        initialPrompt,
        context,
      },
    }),

  closeError: () => set({ error: null }),
}));
