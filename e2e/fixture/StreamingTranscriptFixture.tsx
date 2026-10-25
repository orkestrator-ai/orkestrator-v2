import { useLayoutEffect, useMemo, useState } from "react";
import type { StateSnapshot } from "react-virtuoso";
import { VirtualizedMessageList } from "../../apps/web/src/components/chat/VirtualizedMessageList";
import { NativeMessage } from "../../apps/web/src/components/chat/NativeMessage";
import { normalizeNativeMessages } from "../../apps/web/src/lib/chat/native-message-adapters";
import type {
  NativeMessage as Message,
  NativeMessagePart,
} from "../../apps/web/src/lib/chat/native-message-types";
import { getNativeMessageSearchText } from "../../apps/web/src/components/chat/native-message-search";
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
    // Separate turns preserve the append-row virtualization scenario.
    turnId: `appended-turn-${index}`,
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

  return (
    <NativeMessage
      message={message}
      previousMessage={previousMessage}
      platform={message.id.startsWith("native-terminal:error:") ? "claude" : "codex"}
    />
  );
}

/** One finished tool run of `count` calls: the bounded-rendering stress case. */
function bigGroupMessage(count: number, live: boolean): Message {
  return {
    id: "big-tool-group",
    role: "assistant",
    content: "",
    createdAt: "2026-09-21T09:00:00Z",
    parts: Array.from({ length: count }, (_, index) => ({
      ...command(5_000 + index),
      toolState: live && index === count - 1 ? "pending" : "success",
    })),
  };
}

export function StreamingTranscriptFixture() {
  const query = new URLSearchParams(window.location.search);
  const longTranscript = query.has("long");
  const folding = query.has("fold");
  // The native tab's live-arrival entrance (`animateArrivals`).
  const animateArrivals = query.has("arrivals");
  const shortGroup = query.has("shortGroup");
  const bigGroup = Number(query.get("bigGroup") ?? 0);
  const [messages, setMessages] = useState(() =>
    bigGroup > 0
      ? [...initialMessages(longTranscript), bigGroupMessage(bigGroup, query.has("liveGroup"))]
      : folding
        ? [
            ...initialMessages(longTranscript),
            // Prose in between keeps a one-call group from joining the run above.
            ...(shortGroup ? [textMessage(99)] : []),
            {
              id: "live-fold",
              role: "assistant" as const,
              content: "",
              createdAt: "2026-09-21T11:00:00Z",
              parts: shortGroup ? [command(3_000)] : [command(3_000), command(3_001)],
            },
            ...(query.has("foldAbove")
              ? Array.from({ length: 20 }, (_, index) => textMessage(100 + index))
              : []),
          ]
        : initialMessages(longTranscript),
  );
  const [listGeneration, setListGeneration] = useState(0);
  const [restoreStateFrom, setRestoreStateFrom] = useState<StateSnapshot>();
  const { scrollProps, virtuosoRef, scrollToIndex, scrollToBottom } = useVirtuosoScrollState();
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

  const updateTurn = () => {
    setMessages((current) => {
      const last = current.at(-1)!;
      const content = `${last.content}\n\nMore streamed content in the arriving response.`;
      return [...current.slice(0, -1), { ...last, content, parts: [{ type: "text", content }] }];
    });
  };

  const appendAuthError = () => {
    setMessages((current) => [
      ...current,
      {
        id: `native-terminal:error:${current.length}`,
        role: "system",
        content: "API error: 401 — failed to authenticate",
        createdAt: new Date().toISOString(),
        parts: [],
      },
    ]);
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

  // Navigation goes through the scroll controller like the product's own
  // jumps: one bounded operation that measured convergence settles.
  const scrollToToolHistory = () => {
    scrollToIndex(historicToolIndex, { rowKey: toolHeavyMessage.id, offset: 0 });
  };

  return (
    <main>
      <button
        type="button"
        onClick={() =>
          setMessages((current) => {
            const index = current.findIndex((message) => message.id === "live-fold");
            return [
              ...current.slice(0, index + 1),
              {
                id: "live-fold-update",
                role: "assistant",
                content: "",
                createdAt: "2026-09-21T11:02:00Z",
                parts: [command(3_002)],
              },
              ...current.slice(index + 1).filter((message) => message.id !== "live-fold-update"),
            ];
          })
        }
      >
        Grow tool group
      </button>
      <button
        type="button"
        onClick={() =>
          setMessages((current) => current.filter((message) => message.id !== "live-fold-update"))
        }
      >
        Shrink tool group
      </button>
      {bigGroup > 0 ? (
        <>
          <button
            type="button"
            onClick={() =>
              setMessages((current) => {
                const last = current.at(-1)!;
                return [
                  ...current.slice(0, -1),
                  { ...last, parts: [...last.parts, command(5_000 + last.parts.length)] },
                ];
              })
            }
          >
            Append group call
          </button>
          <button
            type="button"
            onClick={() =>
              setMessages((current) => {
                const last = current.at(-1)!;
                const settled = last.parts.map((part) => ({
                  ...part,
                  toolState: "success" as const,
                }));
                const appended = Array.from({ length: 8 }, (_, index) => ({
                  ...command(5_000 + last.parts.length + index),
                  toolState: index === 7 ? ("pending" as const) : ("success" as const),
                }));
                return [...current.slice(0, -1), { ...last, parts: [...settled, ...appended] }];
              })
            }
          >
            Append group calls
          </button>
          <button
            type="button"
            onClick={() =>
              setMessages((current) => {
                const last = current.at(-1)!;
                return [
                  ...current.slice(0, -1),
                  {
                    ...last,
                    parts: [
                      ...Array.from({ length: 10 }, (_, index) => command(4_900 + index)),
                      ...last.parts,
                    ],
                  },
                ];
              })
            }
          >
            Prepend group calls
          </button>
        </>
      ) : null}
      <button type="button" onClick={appendTool}>
        Append tool
      </button>
      <button type="button" onClick={appendSection}>
        Append section
      </button>
      <button type="button" onClick={appendTurn}>
        Append turn
      </button>
      <button type="button" onClick={updateTurn}>
        Update turn
      </button>
      <button type="button" onClick={appendAuthError}>
        Append authentication error
      </button>
      <button type="button" onClick={scrollToToolHistory}>
        Scroll to tool history
      </button>
      <button type="button" onClick={saveAndRemount}>
        Save and remount
      </button>
      <button type="button" onClick={scrollToBottom}>
        Jump to latest
      </button>
      <output data-testid="transcript-row-count">{rows.length}</output>
      <output data-testid="list-generation">{listGeneration}</output>
      <div className="flex flex-col" style={{ height: 800 }}>
        <VirtualizedMessageList
          key={listGeneration}
          messages={rows}
          computeItemKey={(_, row) => row.id}
          animateArrivals={animateArrivals}
          renderMessage={(_, row, previous) => (
            <TrackedNativeMessage message={row} previousMessage={previous} />
          )}
          scrollProps={{ ...scrollProps, restoreStateFrom }}
          virtuosoRef={virtuosoRef}
          find={{ isActive: true, getSearchText: getNativeMessageSearchText }}
        />
      </div>
    </main>
  );
}
