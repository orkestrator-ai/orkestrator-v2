import { useLayoutEffect, useMemo, useState } from "react";
import type { StateSnapshot } from "react-virtuoso";
import { VirtualizedMessageList } from "../../apps/web/src/components/chat/VirtualizedMessageList";
import { NativeMessage } from "../../apps/web/src/components/chat/NativeMessage";
import { normalizeNativeMessages } from "../../apps/web/src/lib/chat/native-message-adapters";
import type {
  NativeMessage as Message,
  NativeMessagePart,
} from "../../apps/web/src/lib/chat/native-message-types";
import { useVirtuosoScrollState } from "../../apps/web/src/hooks/useVirtuosoScrollState";

declare global {
  interface Window {
    transcriptRenderProbe?: {
      mounted: number;
      maxMounted: number;
      firstFrameMounted: number | null;
      restoredRangeCount: number;
    };
  }
}

const command = (index: number): NativeMessagePart => ({
  type: "tool-invocation",
  content: "",
  toolName: "exec_command",
  toolUseId: `tool-${index}`,
  toolArgs: { cmd: `echo check-${index}` },
  toolState: "success",
  toolOutput: "ok",
});

const toolHeavyMessage: Message = {
  id: "historic-tool-turn",
  role: "assistant",
  content: "The live app check matches the expected behavior.",
  createdAt: "2026-09-21T08:24:00Z",
  parts: [
    ...Array.from({ length: 16 }, (_, i) => command(i)),
    { type: "text", content: "The live app check matches the expected behavior." },
    ...Array.from({ length: 7 }, (_, i) => command(i + 16)),
  ],
};

function textMessage(index: number): Message {
  const role = index % 2 === 0 ? "user" : "assistant";
  const content = `History message ${index}: a representative transcript row for virtualization.`;
  return {
    id: `history-${index}`,
    role,
    content,
    createdAt: new Date(Date.UTC(2026, 8, 21, 6, index)).toISOString(),
    parts: [{ type: "text", content }],
  };
}

function initialMessages(longTranscript: boolean): Message[] {
  if (!longTranscript) return [toolHeavyMessage];
  return [
    ...Array.from({ length: 40 }, (_, index) => textMessage(index)),
    toolHeavyMessage,
    ...Array.from({ length: 40 }, (_, index) => textMessage(index + 40)),
  ];
}

function appendedToolMessage(index: number): Message {
  return {
    id: `appended-tool-turn-${index}`,
    role: "assistant",
    content: "",
    // Keep standalone tool messages in separate minute buckets so the display
    // normalizer cannot coalesce them into the preceding tool-only row.
    createdAt: new Date(Date.UTC(2026, 8, 21, 10, index)).toISOString(),
    parts: [command(1_000 + index)],
  };
}

function TrackedNativeMessage({
  message,
  previousMessage,
}: {
  message: Message;
  previousMessage: Message | null;
}) {
  useLayoutEffect(() => {
    const probe = (window.transcriptRenderProbe ??= {
      mounted: 0,
      maxMounted: 0,
      firstFrameMounted: null,
      restoredRangeCount: 0,
    });
    probe.mounted += 1;
    probe.maxMounted = Math.max(probe.maxMounted, probe.mounted);
    if (probe.firstFrameMounted === null) {
      requestAnimationFrame(() => {
        if (probe.firstFrameMounted === null) probe.firstFrameMounted = probe.mounted;
      });
    }
    return () => {
      probe.mounted -= 1;
    };
  }, []);

  return <NativeMessage message={message} previousMessage={previousMessage} platform="codex" />;
}

export function StreamingTranscriptFixture() {
  const longTranscript = new URLSearchParams(window.location.search).has("long");
  const [messages, setMessages] = useState(() => initialMessages(longTranscript));
  const [listGeneration, setListGeneration] = useState(0);
  const [restoreStateFrom, setRestoreStateFrom] = useState<StateSnapshot>();
  const { scrollProps, virtuosoRef } = useVirtuosoScrollState();
  const rows = useMemo(() => normalizeNativeMessages(messages), [messages]);
  const historicToolIndex = rows.findIndex((row) => row.id === toolHeavyMessage.id);

  const appendSection = () => {
    setMessages((current) => {
      const last = current.at(-1)!;
      return [
        ...current.slice(0, -1),
        {
          ...last,
          parts: [
            ...last.parts,
            { type: "text", content: "Another update" },
            command(2_000 + last.parts.length),
          ],
        },
      ];
    });
  };

  const appendTool = () => {
    setMessages((current) => [...current, appendedToolMessage(current.length)]);
  };

  const appendTurn = () => {
    setMessages((current) => {
      const index = current.length;
      const content = `Streamed follow-up turn ${index}`;
      return [
        ...current,
        {
          id: `streamed-turn-${index}`,
          role: "assistant",
          content,
          createdAt: new Date(Date.UTC(2026, 8, 21, 12, index)).toISOString(),
          parts: [{ type: "text", content }],
        },
      ];
    });
  };

  const saveAndRemount = () => {
    virtuosoRef.current?.getState((snapshot) => {
      window.transcriptRenderProbe ??= {
        mounted: 0,
        maxMounted: 0,
        firstFrameMounted: null,
        restoredRangeCount: 0,
      };
      window.transcriptRenderProbe.restoredRangeCount = snapshot.ranges.length;
      setRestoreStateFrom(snapshot);
      setListGeneration((generation) => generation + 1);
    });
  };

  const scrollToToolHistory = () => {
    const scroll = () =>
      virtuosoRef.current?.scrollToIndex({
        index: historicToolIndex,
        align: "start",
        behavior: "auto",
      });
    scroll();
    requestAnimationFrame(() => {
      scroll();
      requestAnimationFrame(scroll);
    });
  };

  return (
    <main>
      <button type="button" onClick={appendTool}>
        Append tool
      </button>
      <button type="button" onClick={appendSection}>
        Append section
      </button>
      <button type="button" onClick={appendTurn}>
        Append turn
      </button>
      <button type="button" onClick={scrollToToolHistory}>
        Scroll to tool history
      </button>
      <button type="button" onClick={saveAndRemount}>
        Save and remount
      </button>
      <button
        type="button"
        onClick={() =>
          virtuosoRef.current?.scrollToIndex({
            index: rows.length - 1,
            align: "end",
            behavior: "auto",
          })
        }
      >
        Jump to latest
      </button>
      <output data-testid="transcript-row-count">{rows.length}</output>
      <output data-testid="list-generation">{listGeneration}</output>
      <div className="flex flex-col" style={{ height: 800 }}>
        <VirtualizedMessageList
          key={listGeneration}
          messages={rows}
          computeItemKey={(_, row) => row.id}
          renderMessage={(_, row, previous) => (
            <TrackedNativeMessage message={row} previousMessage={previous} />
          )}
          scrollProps={{ ...scrollProps, restoreStateFrom }}
          virtuosoRef={virtuosoRef}
        />
      </div>
    </main>
  );
}
