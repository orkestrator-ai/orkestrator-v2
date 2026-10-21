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

function sizedImage(width: number, height: number): string {
  return `data:image/svg+xml;base64,${btoa(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#2563eb"/><rect x="1" y="1" width="${width - 2}" height="${height - 2}" fill="none" stroke="white" stroke-width="2"/></svg>`,
  )}`;
}

const geometryMessage: Message = {
  id: "attachment-geometry-fixture",
  role: "user",
  content: "Inspect image sizing",
  createdAt: message.createdAt,
  parts: [
    { type: "file", content: "wide.svg", fileUrl: sizedImage(1920, 1080) },
    { type: "file", content: "tall.svg", fileUrl: sizedImage(400, 1600) },
    { type: "file", content: "delayed.svg", detailRef: "attachment-delayed" },
  ],
};

async function loadToolDetails(detailRef: string): Promise<NativeAgentToolDetails> {
  const response = await fetch(
    detailRef === "attachment-delayed" ? "/fixture-delayed-detail" : "/fixture-attachment-detail",
  );
  if (!response.ok) throw new Error("Preview unavailable");
  return { detailRef, fileDataUrl: await response.text() };
}

export function NativeAttachmentsFixture() {
  const [visible, setVisible] = useState(true);
  const geometry = new URLSearchParams(window.location.search).has("geometry");
  return (
    <main className="mx-auto max-w-3xl p-4">
      <button onClick={() => setVisible((value) => !value)}>Switch transcript</button>
      {visible ? (
        <section aria-label="Attachments">
          <NativeMessage
            message={geometry ? geometryMessage : message}
            loadToolDetails={loadToolDetails}
          />
        </section>
      ) : (
        <p>Other environment</p>
      )}
    </main>
  );
}
