import { useState } from "react";
import { VirtualizedMessageList } from "../../apps/web/src/components/chat/VirtualizedMessageList";
import { NativeMessage } from "../../apps/web/src/components/chat/NativeMessage";
import { normalizeNativeMessages } from "../../apps/web/src/lib/chat/native-message-adapters";
import type {
  NativeMessage as Message,
  NativeMessagePart,
} from "../../apps/web/src/lib/chat/native-message-types";
import { useVirtuosoScrollState } from "../../apps/web/src/hooks/useVirtuosoScrollState";

const command = (index: number): NativeMessagePart => ({
  type: "tool-invocation",
  content: "",
  toolName: "exec_command",
  toolUseId: `tool-${index}`,
  toolArgs: { cmd: `echo check-${index}` },
  toolState: "success",
  toolOutput: "ok",
});
const initial: Message = {
  id: "turn",
  role: "assistant",
  content: "The live app check matches the expected behavior.",
  createdAt: "2026-09-21T08:24:00Z",
  parts: [
    ...Array.from({ length: 16 }, (_, i) => command(i)),
    { type: "text", content: "The live app check matches the expected behavior." },
    ...Array.from({ length: 7 }, (_, i) => command(i + 16)),
  ],
};

export function StreamingTranscriptFixture() {
  const [message, setMessage] = useState(initial);
  const { scrollProps, virtuosoRef } = useVirtuosoScrollState();
  return (
    <main>
      <button
        onClick={() =>
          setMessage((current) => ({
            ...current,
            parts: [...current.parts, command(current.parts.length)],
          }))
        }
      >
        Append tool
      </button>
      <button
        onClick={() =>
          setMessage((current) => ({
            ...current,
            parts: [
              ...current.parts,
              { type: "text", content: "Another update" },
              command(current.parts.length),
            ],
          }))
        }
      >
        Append section
      </button>
      <div className="flex flex-col" style={{ height: 800 }}>
        <VirtualizedMessageList
          messages={normalizeNativeMessages([message])}
          computeItemKey={(_, row) => row.id}
          renderMessage={(_, row, previous) => (
            <NativeMessage message={row} previousMessage={previous} platform="codex" />
          )}
          scrollProps={scrollProps}
          virtuosoRef={virtuosoRef}
        />
      </div>
    </main>
  );
}
