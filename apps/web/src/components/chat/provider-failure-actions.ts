import { createContext, useContext } from "react";

/**
 * The recovery actions the transcript's host can perform for a failed turn.
 *
 * A host provides only what it can honour, and `actionableFailureId` names
 * the one failure row they apply to (the latest failure still eligible for
 * recovery): an older failure, or one the user has since moved past, shows its
 * explanation without buttons. Absent context, failures render with no
 * actions at all, which is right for read-only transcripts (history viewers,
 * review panes).
 */
export interface ProviderFailureActions {
  actionableFailureId?: string;
  /**
   * Sends a retry for the failure row `failureId` (created at `occurredAt`).
   * Absent when the host cannot send a prompt now.
   */
  retry?: (failureId: string, occurredAt: string) => void;
  /** The check is pending, so Retry stays focusable but cannot be activated. */
  retryPending?: boolean;
  /** Why Retry is shown disabled, when the host could retry but not right now. */
  retryUnavailableReason?: string;
  /** Opens the composer's model picker. Absent when the model cannot change. */
  changeModel?: () => void;
}

export const ProviderFailureActionsContext = createContext<ProviderFailureActions | null>(null);

export function useProviderFailureActions(failureId: string | undefined): ProviderFailureActions {
  const actions = useContext(ProviderFailureActionsContext);
  if (!actions || !failureId || actions.actionableFailureId !== failureId) return {};
  return actions;
}
