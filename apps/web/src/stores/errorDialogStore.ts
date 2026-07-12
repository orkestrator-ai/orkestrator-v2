import { create } from "zustand";

export interface ErrorDetails {
  title: string;
  message: string;
  timestamp: Date;
  /** Optional initial prompt that was lost due to the error */
  initialPrompt?: string;
}

interface ErrorDialogState {
  /** Currently displayed error, or null if dialog is closed */
  error: ErrorDetails | null;

  /** Show the error details dialog, optionally with an initial prompt that was lost */
  showError: (title: string, message: string, initialPrompt?: string) => void;

  /** Close the error details dialog */
  closeError: () => void;
}

export const useErrorDialogStore = create<ErrorDialogState>()((set) => ({
  error: null,

  showError: (title, message, initialPrompt) =>
    set({
      error: {
        title,
        message,
        timestamp: new Date(),
        initialPrompt,
      },
    }),

  closeError: () => set({ error: null }),
}));
