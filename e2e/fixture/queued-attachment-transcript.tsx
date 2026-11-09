import { NativeMessage } from "../../apps/web/src/components/chat/NativeMessage";
import type { NativeMessage as Message } from "../../apps/web/src/lib/chat/native-message-types";

const storageKey = "fixture-queued-attachment-transcript";

// A disposable, per-browser-tab fake provider snapshot. Persist the raw text
// echo rather than rendered parts so reload exercises production normalization.
export function readQueuedAttachmentTranscript(): Message[] {
  return JSON.parse(sessionStorage.getItem(storageKey) ?? "[]") as Message[];
}

export function recordQueuedAttachmentSteer(prompt: { id: string; text: string }): Message[] {
  const messages: Message[] = [
    ...readQueuedAttachmentTranscript(),
    {
      id: prompt.id,
      role: "user",
      content: prompt.text,
      parts: [{ type: "text", content: prompt.text }],
      createdAt: "2026-11-09T12:00:00Z",
    },
  ];
  sessionStorage.setItem(storageKey, JSON.stringify(messages));
  return messages;
}

export function QueuedAttachmentTranscript({ messages }: { messages: Message[] }) {
  return (
    <section aria-label="Steered messages" className="mx-auto max-w-3xl p-4">
      {messages.map((message) => (
        <NativeMessage key={message.id} message={message} platform="codex" />
      ))}
    </section>
  );
}
