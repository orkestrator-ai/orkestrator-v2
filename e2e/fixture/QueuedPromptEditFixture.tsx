import { useMemo, useRef, useState } from "react";
import { buildInitialPromptWithAttachmentReferences } from "@orkestrator/protocol/initial-prompt-attachments";
import { NativeComposeBar } from "../../apps/web/src/components/chat/NativeComposeBar";
import { QueuedPromptEditor } from "../../apps/web/src/components/chat/QueuedPromptEditor";
import type { MentionableInputRef } from "../../apps/web/src/components/chat/MentionableInput";
import { usePromptQueueEdit } from "../../apps/web/src/hooks/usePromptQueueEdit";
import { queuedPromptAttachments } from "../../apps/web/src/lib/chat/queued-prompt-text";
import {
  queuedPromptEditNote,
  queuedPromptEditStates,
  type PromptQueueEditFinishResult,
  type PromptQueueEditView,
} from "../../apps/web/src/lib/prompt-queue-edit";

const shotPath = "/workspace/.orkestrator/attachments/7f3c/header-spacing.png";

interface QueuedItem {
  id: string;
  text: string;
  attachments?: Array<{ type: "image" | "file"; path: string; filename: string }>;
}

const initialQueue: QueuedItem[] = [
  { id: "queued-1", text: "Run the focused tests for the queue store" },
  {
    id: "queued-2",
    text: buildInitialPromptWithAttachmentReferences(
      "Match the header spacing in this screenshot",
      [{ name: "header-spacing.png", path: shotPath }],
    ),
    attachments: [{ type: "image", path: shotPath, filename: "header-spacing.png" }],
  },
  { id: "queued-3", text: "Then update the architecture notes" },
];

const minutes = (count: number) => new Date(Date.now() + count * 60_000).toISOString();

/**
 * In-place editing of a queued prompt (`/queued-prompt-edit`), with the real
 * composer, queue strip, editor and edit hook over an in-memory queue. The
 * composer holds a draft the edit must leave alone.
 *
 * - `?elsewhere`: the third prompt is being edited on another device.
 * - `?review`: an edit of the first prompt was left unfinished.
 * - `?conflict`: saving finds the prompt changed elsewhere.
 */
export function QueuedPromptEditFixture() {
  const params = new URLSearchParams(window.location.search);
  const [queued, setQueued] = useState(initialQueue);
  const [text, setText] = useState("Desktop draft: refactor the auth middleware so that");
  const [editing, setEditing] = useState<PromptQueueEditView[]>(() => [
    ...(params.has("review")
      ? [{ messageId: "queued-1", leaseId: "lease-stale", expiresAt: minutes(-2) }]
      : []),
    ...(params.has("elsewhere")
      ? [{ messageId: "queued-3", leaseId: "lease-phone", expiresAt: minutes(1) }]
      : []),
  ]);
  const leases = useRef(0);
  const inputRef = useRef<MentionableInputRef | null>(null);
  const inputContainerRef = useRef<HTMLDivElement | null>(null);

  const api = useMemo(
    () => ({
      begin: async (messageId: string) => {
        const message = queued.find((item) => item.id === messageId);
        if (!message)
          return { status: "refused" as const, reason: "missing" as const, queue: null };
        const lease = {
          messageId,
          leaseId: `lease-${++leases.current}`,
          acquiredAt: new Date().toISOString(),
          expiresAt: minutes(1),
          baseFingerprint: "0".repeat(64),
        };
        setEditing((current) => [
          ...current.filter((view) => view.messageId !== messageId),
          { messageId, leaseId: lease.leaseId, expiresAt: lease.expiresAt },
        ]);
        return { status: "editing" as const, lease, message, queue: null };
      },
      renew: async () => ({ status: "renewed" as const, expiresAt: minutes(1) }),
      finish: async (
        messageId: string,
        _leaseId: string,
        finish:
          | { outcome: "cancel" }
          | { outcome: "commit"; text: string; attachments?: readonly unknown[] },
      ): Promise<PromptQueueEditFinishResult> => {
        if (finish.outcome === "commit" && params.has("conflict")) {
          return { status: "conflict", reason: "changed", queue: null };
        }
        setEditing((current) => current.filter((view) => view.messageId !== messageId));
        if (finish.outcome === "commit") {
          setQueued((current) =>
            current.map((item) =>
              item.id === messageId
                ? {
                    id: item.id,
                    text: finish.text,
                    ...(finish.attachments?.length
                      ? { attachments: finish.attachments as QueuedItem["attachments"] }
                      : {}),
                  }
                : item,
            ),
          );
          return { status: "committed", queue: null };
        }
        return { status: "released", queue: null };
      },
    }),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the fixture's params never change
    [queued],
  );
  const controller = usePromptQueueEdit(api);
  const session = controller.session;
  const states = queuedPromptEditStates(editing, session?.leaseId);
  const index = session ? queued.findIndex((item) => item.id === session.messageId) : -1;

  return (
    <main className="min-h-screen bg-background pt-4 text-foreground">
      <section data-testid="queued-prompt-edit-fixture" className="w-full pb-4">
        <NativeComposeBar
          attachments={[]}
          onRemoveAttachment={() => {}}
          inputRef={inputRef}
          inputContainerRef={inputContainerRef}
          text={text}
          mentions={[]}
          onTextAndMentionsChange={(nextText) => setText(nextText)}
          onCursorPositionChange={() => {}}
          onKeyDown={() => {}}
          placeholder="Send a message"
          isLoading
          queue={{
            length: queued.length,
            onOpen: () => {},
            editor: session ? (
              <QueuedPromptEditor
                key={session.messageId}
                position={index + 1}
                length={queued.length}
                text={session.text}
                attachments={session.attachments}
                conflict={session.conflict}
                busy={session.busy}
                onTextChange={controller.setText}
                onRemoveAttachment={controller.removeAttachment}
                onSave={() => void controller.save()}
                onCancel={() => void controller.cancel()}
                onOverwrite={() => void controller.overwrite()}
                onDiscard={controller.discard}
              />
            ) : undefined,
            items: queued.map((item) => {
              const editState = states.get(item.id);
              const attachments = queuedPromptAttachments(item);
              return {
                id: item.id,
                text: item.text,
                ...(attachments.length > 0 ? { attachments } : {}),
                ...(editState ? { editState, note: queuedPromptEditNote(editState) } : {}),
                onEdit:
                  editState === "local"
                    ? undefined
                    : () =>
                        controller.begin(item.id, {
                          takeOver: editState === "elsewhere",
                        }),
                onRelease:
                  editState === "review"
                    ? () =>
                        setEditing((current) =>
                          current.filter((view) => view.messageId !== item.id),
                        )
                    : undefined,
                onRemove: () =>
                  setQueued((current) => current.filter((candidate) => candidate.id !== item.id)),
              };
            }),
          }}
          onSend={() => {}}
          onStop={async () => {}}
          primaryControls={<span className="text-xs text-muted-foreground">Codex · GPT-5</span>}
        />
        <output data-testid="queued-order" className="sr-only">
          {queued.map((item) => item.id).join(",")}
        </output>
        <output data-testid="queued-texts" className="sr-only">
          {JSON.stringify(queued.map((item) => item.text))}
        </output>
      </section>
    </main>
  );
}
