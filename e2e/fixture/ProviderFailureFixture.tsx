import { useRef } from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import { NativeMessage } from "../../apps/web/src/components/chat/NativeMessage";
import { VirtualizedMessageList } from "../../apps/web/src/components/chat/VirtualizedMessageList";
import { getNativeMessageSearchText } from "../../apps/web/src/components/chat/native-message-search";
import type { NativeMessage as NativeMessageRow } from "../../apps/web/src/lib/chat/native-message-types";

const rows: NativeMessageRow[] = [
  {
    id: "error-fixture-credential",
    role: "assistant",
    content: "Model request failed (HTTP 403): API key not valid. Please pass a valid API key.",
    modelId: "openai/fixture",
    createdAt: "2026-11-19T10:00:00.000Z",
    parts: [],
  },
  {
    id: "native-terminal:error:fixture-quota",
    role: "system",
    content: "usage limit reached|1795084200",
    failure: { reason: "usage-limit", resetsAt: "2026-11-19T10:30:00.000Z" },
    createdAt: "2026-11-19T10:00:01.000Z",
    parts: [],
  },
];

export function ProviderFailureFixture() {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  return (
    <main className="@container mx-auto flex h-dvh w-full max-w-3xl flex-col bg-background text-foreground">
      <VirtualizedMessageList
        messages={rows}
        computeItemKey={(_, row) => row.id}
        renderMessage={(_, row) => <NativeMessage message={row} platform="opencode" />}
        virtuosoRef={virtuosoRef}
        scrollProps={{
          followOutput: () => false,
          atBottomStateChange: () => undefined,
          atBottomThreshold: 50,
          restoreStateFrom: undefined,
        }}
        find={{ isActive: true, getSearchText: getNativeMessageSearchText }}
      />
    </main>
  );
}
