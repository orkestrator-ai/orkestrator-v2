import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { incompatibility } from "@orkestrator/protocol/contract/errors";
import { webAnnotationQueueOrigin } from "@orkestrator/protocol/web-annotations";
import { QueuedPromptEditor } from "@/components/chat/QueuedPromptEditor";
import type { NativeAttachmentFileSearch } from "@/components/chat/NativeAttachmentMenu";
import { usePromptQueueEdit, type PromptQueueEditApi } from "@/hooks/usePromptQueueEdit";
import { describePromptQueueActionError } from "@/lib/prompt-queue-errors";
import {
  resolveWorkspaceAttachment,
  type WorkspaceAttachmentContext,
} from "@/lib/chat/workspace-attachments";
import {
  queuedPromptEditStates,
  type PromptQueueEditView,
  type QueuedPromptEditState,
} from "@/lib/prompt-queue-edit";

const BEGIN_COMMAND = "begin_prompt_queue_message_edit";

interface QueuedMessage {
  id: string;
  text: string;
}

export interface NativeQueuedPromptEditingInput extends PromptQueueEditApi {
  /** Queued prompts in run order. */
  messages: readonly QueuedMessage[];
  /** The projection's `queue.editing`. */
  editing: readonly PromptQueueEditView[] | undefined;
  filePicker?: {
    search: NativeAttachmentFileSearch;
    context: (messageId: string) => WorkspaceAttachmentContext;
  };
}

/**
 * The composer edit (remove the prompt, load it into the draft), for items an
 * in-place edit cannot hold — slash commands, annotation requests — and for a
 * node too old to know in-place edits.
 */
export type EditInComposer = (message: QueuedMessage) => Promise<void>;

export interface NativeQueuedPromptEditing {
  /** Edit a queued prompt: in place when the node can, otherwise in the composer. */
  edit: (message: QueuedMessage, editInComposer: EditInComposer) => Promise<void>;
  /** This row's edit state, when an edit holds it. */
  editState: (messageId: string) => QueuedPromptEditState | undefined;
  /** Release an unfinished edit, for a row in review. */
  release: (messageId: string) => Promise<void>;
  /** The editor to show above the queue, while this client edits a prompt there. */
  editor: ReactNode | undefined;
}

function isSlashCommand(message: QueuedMessage): boolean {
  return (message as { command?: unknown }).command !== undefined;
}

/**
 * The native tab's in-place editing of queued prompts
 * (`@orkestrator/protocol/prompt-queue-edit`): which rows an edit holds, the
 * editor for the one this client is editing, and the choice between editing
 * in place and the older composer edit.
 */
export function useNativeQueuedPromptEditing(
  input: NativeQueuedPromptEditingInput,
): NativeQueuedPromptEditing {
  const controller = usePromptQueueEdit(input);
  // Set once this node answers that it does not know in-place edits.
  const [composerOnly, setComposerOnly] = useState(false);
  const { session } = controller;
  // After a conflict the session still names the last lease it held: still
  // this client's after `changed`, another's id in the projection after
  // `lease-lost`, so each row reads correctly either way.
  const localLeaseId = session?.leaseId;
  const [, refreshExpiry] = useState(0);
  const states = queuedPromptEditStates(input.editing, localLeaseId);
  const deadline = Math.min(
    Infinity,
    ...(input.editing ?? [])
      .filter(({ messageId }) => states.get(messageId) === "elsewhere")
      .map(({ expiresAt }) => Date.parse(expiresAt)),
  );
  useEffect(() => {
    if (!Number.isFinite(deadline)) return;
    let timer: ReturnType<typeof setTimeout>;
    const expire = () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) refreshExpiry((count) => count + 1);
      else timer = setTimeout(expire, Math.min(remaining, 2_147_483_647));
    };
    timer = setTimeout(expire, Math.min(Math.max(0, deadline - Date.now()), 2_147_483_647));
    return () => clearTimeout(timer);
  }, [deadline]);

  const edit = async (message: QueuedMessage, editInComposer: EditInComposer) => {
    if (composerOnly || isSlashCommand(message) || webAnnotationQueueOrigin(message)) {
      await editInComposer(message);
      return;
    }
    const state = states.get(message.id);
    try {
      await controller.begin(message.id, { takeOver: state === "elsewhere" });
    } catch (error) {
      if (incompatibility(error, BEGIN_COMMAND)?.code === "unknown-command") {
        setComposerOnly(true);
        await editInComposer(message);
        return;
      }
      throw error;
    }
  };

  const report = (action: () => Promise<void>) => () => {
    void action().catch((error: unknown) => toast.error(describePromptQueueActionError(error)));
  };

  let editor: ReactNode | undefined;
  const index = session
    ? input.messages.findIndex((message) => message.id === session.messageId)
    : -1;
  if (session) {
    const picker = input.filePicker;
    editor = (
      <QueuedPromptEditor
        key={session.messageId}
        position={index >= 0 ? index + 1 : undefined}
        length={input.messages.length}
        text={session.text}
        attachments={session.attachments}
        conflict={index < 0 ? "missing" : session.conflict}
        busy={session.busy}
        onTextChange={controller.setText}
        onRemoveAttachment={controller.removeAttachment}
        filePicker={
          picker && {
            search: picker.search,
            select: (file) => {
              const resolved = resolveWorkspaceAttachment(file, {
                ...picker.context(session.messageId),
                attachedCount: session.attachments.length,
              });
              if ("error" in resolved) {
                toast.error(resolved.error, { description: resolved.description });
                return;
              }
              const { type, path, name } = resolved.attachment;
              controller.addAttachment({ type, path, filename: name });
            },
          }
        }
        onSave={report(controller.save)}
        onCancel={report(controller.cancel)}
        onOverwrite={report(controller.overwrite)}
        onDiscard={report(controller.discard)}
      />
    );
  }

  return {
    edit,
    editState: (messageId) => states.get(messageId),
    release: async (messageId) => {
      const observed = input.editing?.find((lease) => lease.messageId === messageId);
      if (observed && states.get(messageId) === "review") {
        await controller.release(messageId, observed.leaseId);
      }
    },
    editor,
  };
}
