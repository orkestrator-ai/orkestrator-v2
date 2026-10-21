import { useState } from "react";
import type { NativeAgentToolDetails } from "@orkestrator/protocol/native-agent";
import { buildInitialPromptWithAttachmentReferences } from "@orkestrator/protocol/initial-prompt-attachments";
import { NativeMessage } from "../../apps/web/src/components/chat/NativeMessage";
import type { NativeMessage as Message } from "../../apps/web/src/lib/chat/native-message-types";

const content = buildInitialPromptWithAttachmentReferences("Inspect these attachments", [
  { name: "loading.png", path: "/workspace/loading.png" },
  { name: "broken.png", path: "/workspace/broken.png" },
  { name: "notes.md", path: "/workspace/notes.md" },
]);
const message: Message = {
  id: "attachment-caption-fixture",
  role: "user",
  content,
  createdAt: "2026-10-21T12:00:00Z",
  parts: [
    { type: "text", content },
    {
      type: "file",
      content: "/workspace/loading.png",
      detailRef: "attachment-loading",
    },
    { type: "file", content: "/workspace/broken.png", fileUrl: "data:image/png;base64,QUJD" },
    { type: "file", content: "remote.png", fileUrl: "https://attachment.example/remote.png" },
    { type: "file", content: "/workspace/notes.md", filename: "notes.md" },
  ],
};
async function loadToolDetails(detailRef: string): Promise<NativeAgentToolDetails> {
  const response = await fetch("/fixture-attachment-detail");
  if (!response.ok) throw new Error("Preview unavailable");
  return { detailRef, fileDataUrl: await response.text() };
}

export function NativeAttachmentsFixture() {
  const [visible, setVisible] = useState(true);
  return (
    <main className="mx-auto max-w-3xl p-4">
      <button onClick={() => setVisible((value) => !value)}>Switch transcript</button>
      {visible ? (
        <section aria-label="Attachments">
          <NativeMessage message={message} loadToolDetails={loadToolDetails} />
        </section>
      ) : (
        <p>Other environment</p>
      )}
    </main>
  );
}
