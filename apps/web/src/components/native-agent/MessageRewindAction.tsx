import { memo, useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Undo2 } from "lucide-react";
import { toast } from "sonner";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type {
  NativeAgentSessionAction,
  NativeAgentSessionActionOutcome,
} from "@orkestrator/protocol/native-agent";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import type { TranscriptAnnotation } from "@/lib/chat/transcript-annotations";
import {
  buildMessageRewindPlan,
  describeNativeAgentRewind,
  type MessageRewindPlanEntry,
} from "./native-agent-rewind";

interface MessageRewindActionProps {
  messageId: string;
  label: string;
  disabled: boolean;
  onRewind: (messageId: string) => void;
}

/**
 * The per-prompt "rewind to before this prompt" control. Memoised for the
 * same reason as `MessageForkAction`: it reaches `memo(NativeMessage)` through
 * its `actions` prop.
 */
export const MessageRewindAction = memo(function MessageRewindAction({
  messageId,
  label,
  disabled,
  onRewind,
}: MessageRewindActionProps) {
  const handleClick = useCallback(() => onRewind(messageId), [messageId, onRewind]);
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-6 w-6"
      title="Rewind to before this prompt"
      aria-label={label}
      disabled={disabled}
      onClick={handleClick}
    >
      <Undo2 className="h-3.5 w-3.5" />
    </Button>
  );
});

interface MessageRewindDialogProps {
  platform: AgentPlatform;
  agentLabel: string;
  pending: MessageRewindPlanEntry | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/** Confirms a rewind, naming how many turns it drops and whether they come back. */
export function MessageRewindDialog({
  platform,
  agentLabel,
  pending,
  busy,
  onCancel,
  onConfirm,
}: MessageRewindDialogProps) {
  const copy = pending ? describeNativeAgentRewind(platform, agentLabel, pending) : null;
  return (
    <AlertDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
    >
      <AlertDialogContent data-testid="message-rewind-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{copy?.title}</AlertDialogTitle>
          <AlertDialogDescription>{copy?.description[0]}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2 text-sm text-muted-foreground">
          {copy?.description.slice(1).map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            onClick={(event) => {
              // Stay open until the provider answers, so a failure is shown here.
              event.preventDefault();
              onConfirm();
            }}
          >
            {busy ? "Rewinding…" : "Rewind"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * One element per row id, memoised in a cache private to this factory, so a
 * row keeps the same `actions` prop while a turn streams (see
 * `createMessageForkActionFactory`). Rebuilt whenever an input changes, so a
 * cached element never carries a stale `disabled` state.
 */
function createMessageRewindActionFactory(
  agentLabel: string,
  disabled: boolean,
  onRewind: (rowId: string) => void,
): (rowId: string) => ReactNode {
  const cache = new Map<string, ReactNode>();
  return (rowId) => {
    const cached = cache.get(rowId);
    if (cached !== undefined) return cached;
    const element = (
      <MessageRewindAction
        messageId={rowId}
        label={`Rewind ${agentLabel} session to before this prompt`}
        disabled={disabled}
        onRewind={onRewind}
      />
    );
    cache.set(rowId, element);
    return element;
  };
}

export interface MessageRewindController {
  /** The row's rewind button, or null when the row offers none. Referentially stable per row. */
  renderRewindAction: (messageId: string) => ReactNode | null;
  /** The confirmation dialog; render it once beside the transcript. */
  dialog: ReactNode;
  inFlight: boolean;
}

/**
 * Message rewind for one native tab: the plan, the per-row actions, the
 * confirmation and the call to the `rewind-messages` session action.
 *
 * After a rewind the prompt's text is restored into the composer, as Pi's own
 * tree navigation does, unless the composer already holds a draft: that is
 * the user's newer work and is never overwritten.
 */
export function useMessageRewind(options: {
  platform: AgentPlatform;
  agentLabel: string;
  enabled: boolean;
  messages: NativeMessage[];
  responseInProgress: boolean;
  disabled: boolean;
  performAction: (action: NativeAgentSessionAction) => Promise<NativeAgentSessionActionOutcome>;
  composerHasDraft: () => boolean;
  restoreDraft: (draft: { text: string; annotations: TranscriptAnnotation[] }) => void;
}): MessageRewindController {
  const {
    platform,
    agentLabel,
    enabled,
    messages,
    responseInProgress,
    disabled,
    performAction,
    composerHasDraft,
    restoreDraft,
  } = options;
  const plan = useMemo(
    () =>
      enabled
        ? buildMessageRewindPlan(messages, { platform, responseInProgress })
        : new Map<string, MessageRewindPlanEntry>(),
    [enabled, messages, platform, responseInProgress],
  );
  // The row, not a copy of its plan entry: the dialog always describes the
  // transcript as it is now, and closes if that prompt leaves it.
  const [pendingRowId, setPendingRowId] = useState<string | null>(null);
  const [inFlight, setInFlight] = useState(false);
  const pending = pendingRowId ? (plan.get(pendingRowId) ?? null) : null;

  const handleRewind = useCallback((rowId: string) => setPendingRowId(rowId), []);

  const confirm = useCallback(async () => {
    if (!pending || inFlight) return;
    setInFlight(true);
    try {
      await performAction({ kind: "rewind-messages", messageId: pending.messageId });
      const keptDraft = composerHasDraft();
      if (!keptDraft) {
        restoreDraft({ text: pending.draftText, annotations: pending.draftAnnotations });
      }
      setPendingRowId(null);
      toast.success(
        pending.droppedTurns === 1
          ? `Rewound ${agentLabel} by 1 turn`
          : `Rewound ${agentLabel} by ${pending.droppedTurns} turns`,
        keptDraft
          ? { description: "Your draft was kept; the removed prompt was not restored." }
          : undefined,
      );
      const attachments = keptDraft ? 0 : pending.droppedAttachmentCount;
      if (attachments > 0) {
        toast.warning(
          attachments === 1
            ? "1 attachment was not restored with the prompt. Re-attach it before sending."
            : `${attachments} attachments were not restored with the prompt. Re-attach them before sending.`,
        );
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Failed to rewind ${agentLabel}`);
    } finally {
      setInFlight(false);
    }
  }, [agentLabel, composerHasDraft, inFlight, pending, performAction, restoreDraft]);

  const actionsDisabled = disabled || inFlight;
  const factory = useMemo(
    () => createMessageRewindActionFactory(agentLabel, actionsDisabled, handleRewind),
    [actionsDisabled, agentLabel, handleRewind],
  );

  const renderRewindAction = useCallback(
    (rowId: string) => (plan.has(rowId) ? factory(rowId) : null),
    [factory, plan],
  );

  const dialog = (
    <MessageRewindDialog
      platform={platform}
      agentLabel={agentLabel}
      pending={pending}
      busy={inFlight}
      onCancel={() => setPendingRowId(null)}
      onConfirm={() => void confirm()}
    />
  );

  return { renderRewindAction, dialog, inFlight };
}

/**
 * Joins two per-row action elements without breaking `memo(NativeMessage)`:
 * the joined element is reused for as long as both parts are the same
 * elements, so an old row keeps the same `actions` prop while a turn streams.
 */
export function useJoinedMessageActions(): (
  rowId: string,
  first: ReactNode | null,
  second: ReactNode | null,
) => ReactNode | null {
  const cacheRef = useRef(
    new Map<string, { first: ReactNode; second: ReactNode; joined: ReactNode }>(),
  );
  return useCallback((rowId, first, second) => {
    if (first == null) return second;
    if (second == null) return first;
    const cache = cacheRef.current;
    const cached = cache.get(rowId);
    if (cached && cached.first === first && cached.second === second) return cached.joined;
    const joined = (
      <>
        {first}
        {second}
      </>
    );
    cache.set(rowId, { first, second, joined });
    return joined;
  }, []);
}
