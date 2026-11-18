import { NativeMessage } from "../../apps/web/src/components/chat/NativeMessage";
import type { NativeMessage as Message } from "../../apps/web/src/lib/chat/native-message-types";

/**
 * A Cursor turn's screen-recording rows, shaped exactly as the Cursor bridge
 * writes them (`renderRecordScreen` and `savedFilePart`): a card per call, and
 * a file row beside a save that reported a path. `?container` renders it as a
 * container environment's transcript.
 */
const message: Message = {
  id: "cursor-recording-fixture",
  role: "assistant",
  content: "",
  createdAt: "2026-11-18T12:00:00Z",
  parts: [
    {
      type: "tool-invocation",
      content: "Start screen recording",
      toolUseId: "rec-start",
      toolName: "recordScreen",
      toolTitle: "Start screen recording",
      toolArgs: { mode: "START_RECORDING" },
      toolOutput: "Recording started.",
      toolState: "success",
    },
    {
      type: "tool-invocation",
      content: "Save screen recording",
      toolUseId: "rec-save",
      toolName: "recordScreen",
      toolTitle: "Save screen recording",
      toolArgs: { mode: "SAVE_RECORDING" },
      toolOutput: "Recording saved (12.3 s) to /workspace/recordings/checkout-flow.mp4",
      toolState: "success",
    },
    {
      type: "file",
      content: "/workspace/recordings/checkout-flow.mp4",
      fileUrl: "file:///workspace/recordings/checkout-flow.mp4",
    },
    {
      type: "tool-invocation",
      content: "Save screen recording",
      toolUseId: "rec-save-outside",
      toolName: "recordScreen",
      toolTitle: "Save screen recording",
      toolArgs: { mode: "SAVE_RECORDING" },
      toolOutput: "Recording saved (3.0 s) to /home/node/.cursor/recordings/settings.mp4",
      toolState: "success",
    },
    {
      type: "file",
      content: "/home/node/.cursor/recordings/settings.mp4",
      fileUrl: "file:///home/node/.cursor/recordings/settings.mp4",
    },
    {
      type: "tool-invocation",
      content: "Discard screen recording",
      toolUseId: "rec-discard",
      toolName: "recordScreen",
      toolTitle: "Discard screen recording",
      toolArgs: { mode: "DISCARD_RECORDING" },
      toolOutput: "Recording discarded. No video was kept.",
      toolState: "success",
    },
  ],
};

export function CursorScreenRecordingFixture() {
  const containerId = new URLSearchParams(window.location.search).has("container")
    ? "fixture-container"
    : undefined;
  return (
    <main className="mx-auto max-w-3xl p-4">
      <section aria-label="Recordings">
        <NativeMessage message={message} platform="cursor" containerId={containerId} />
      </section>
    </main>
  );
}
