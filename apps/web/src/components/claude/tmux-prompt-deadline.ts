import type { BlockingPromptCardDeadline } from "@/components/chat/BlockingPromptCard";
import { usePromptHold, type PromptHoldHandler } from "@/hooks/usePromptHold";
import type { TmuxPromptTiming } from "@/stores/claudeTmuxStore";

/**
 * The countdown control of a Claude-in-tmux prompt card. The hook script owns
 * the deadline and the backend publishes its pause state beside `expiresAt`;
 * a prompt without one (an older backend) shows the plain countdown.
 */
export function useTmuxPromptDeadline(
  prompt: TmuxPromptTiming,
  onHold?: PromptHoldHandler,
): { deadline: BlockingPromptCardDeadline; error: string | null } {
  const hold = usePromptHold(prompt.hold, onHold);
  return {
    deadline: {
      hold: prompt.hold,
      held: hold.held,
      pending: hold.pending,
      onToggle: hold.toggle,
      provider: "claude",
    },
    error: hold.error,
  };
}
