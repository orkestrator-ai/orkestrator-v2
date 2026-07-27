import { memo, useCallback, useMemo, type ReactNode } from "react";
import { GitFork } from "lucide-react";
import { Button } from "@/components/ui/button";

interface MessageForkActionProps {
  messageId: string;
  /** Provider-specific accessible name, e.g. "Fork Codex session from this message". */
  label: string;
  disabled: boolean;
  onFork: (messageId: string) => void;
}

/**
 * The per-message "fork from here" control.
 *
 * Memoised because it is handed to `NativeMessage` through its `actions` prop,
 * and `NativeMessage` is itself `memo`ised with the default shallow compare.
 */
export const MessageForkAction = memo(function MessageForkAction({
  messageId,
  label,
  disabled,
  onFork,
}: MessageForkActionProps) {
  const handleClick = useCallback(() => {
    onFork(messageId);
  }, [messageId, onFork]);

  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-6 w-6"
      title="Fork from here"
      aria-label={label}
      disabled={disabled}
      onClick={handleClick}
    >
      <GitFork className="h-3.5 w-3.5" />
    </Button>
  );
});

/**
 * Returns a per-message-id factory whose elements are referentially stable.
 *
 * Every chat tab renders its transcript through `VirtualizedMessageList`, whose
 * `renderMessage` callback runs on each parent render — once per streaming
 * tick. Building `actions={<Button …/>}` inline there produced a fresh element
 * object every time, so the shallow compare behind `memo(NativeMessage)` failed
 * for *every visible user message* on *every* tick, re-normalising and
 * re-rendering the whole transcript while an answer streamed in.
 *
 * The cache is rebuilt whenever the inputs that shape the button change, so a
 * cached element can never carry a stale `disabled` state or a stale callback.
 * It is bounded by the number of messages in one transcript.
 */
export function useMessageForkAction(options: {
  label: string;
  disabled: boolean;
  onFork: (messageId: string) => void;
}): (messageId: string) => ReactNode {
  const { label, disabled, onFork } = options;
  return useMemo(() => {
    const cache = new Map<string, ReactNode>();
    return (messageId: string): ReactNode => {
      const cached = cache.get(messageId);
      if (cached !== undefined) return cached;
      const element = (
        <MessageForkAction
          messageId={messageId}
          label={label}
          disabled={disabled}
          onFork={onFork}
        />
      );
      cache.set(messageId, element);
      return element;
    };
  }, [disabled, label, onFork]);
}
