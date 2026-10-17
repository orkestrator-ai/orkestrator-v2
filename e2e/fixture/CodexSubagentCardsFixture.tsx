import { useCallback, useEffect, useMemo, useState } from "react";
import { NativeMessage } from "../../apps/web/src/components/chat/NativeMessage";
import { pinNativeAgentParts } from "../../apps/web/src/lib/chat/native-agent-pinning";
import { normalizeNativeMessages } from "../../apps/web/src/lib/chat/native-message-adapters";
import type { NativeMessage as Message } from "../../apps/web/src/lib/chat/native-message-types";

interface Projection {
  messages: Message[];
  turn: { phase: string };
}

/**
 * A Codex tab's transcript, read from a real backend projection over the real
 * codex-bridge (`e2e/fixtures/codex-subagent-host.ts`), and presented the way
 * `AgentNativeTab` presents it: normalized, then pinned.
 *
 * The page keeps nothing of its own: a reload, or "Refresh transcript", reads
 * the projection again, so what it shows is whatever the backend serves.
 */
export function CodexSubagentCardsFixture() {
  const stack = new URLSearchParams(window.location.search).get("stack") ?? "";
  const [projection, setProjection] = useState<Projection | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(
    () =>
      fetch(`/__codex-subagents/projection?stack=${stack}`)
        .then(async (response) => {
          if (!response.ok) throw new Error(`projection read failed: ${response.status}`);
          setProjection((await response.json()) as Projection);
          setError(null);
        })
        .catch((reason: unknown) => {
          setError(reason instanceof Error ? reason.message : String(reason));
        }),
    [stack],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const messages = useMemo(() => {
    const normalized = normalizeNativeMessages(projection?.messages ?? []);
    return pinNativeAgentParts(normalized);
  }, [projection]);

  return (
    <main className="dark min-h-screen bg-background p-4 text-foreground">
      <div className="mb-3 flex items-center gap-3 text-xs">
        <button type="button" onClick={() => void refresh()}>
          Refresh transcript
        </button>
        <span data-testid="turn-phase">{projection?.turn.phase ?? "loading"}</span>
        {error ? <span role="alert">{error}</span> : null}
      </div>
      <div data-testid="transcript">
        {messages.map((message, index) => (
          <div key={message.id} data-testid="transcript-row" data-message-id={message.id}>
            <NativeMessage
              message={message}
              previousMessage={messages[index - 1] ?? null}
              platform="codex"
            />
          </div>
        ))}
      </div>
    </main>
  );
}
