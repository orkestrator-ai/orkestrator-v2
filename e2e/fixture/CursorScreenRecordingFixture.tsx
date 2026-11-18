import { useEffect, useState } from "react";
import type { BackendId } from "@orkestrator/protocol/federation";
import { NativeMessage } from "../../apps/web/src/components/chat/NativeMessage";
import type { NativeMessage as Message } from "../../apps/web/src/lib/chat/native-message-types";
import { createBrowserNodeClient } from "../../apps/web/src/lib/node-scope/browser-node-client";
import type { NodeScope } from "../../apps/web/src/lib/node-scope/node-scope";
import { NodeScopeProvider, useWindowScope } from "../../apps/web/src/lib/node-scope/providers";

export function CursorScreenRecordingFixture() {
  const windowScope = useWindowScope();
  const [fixture, setFixture] = useState<{ scope: NodeScope; messages: Message[] }>();
  const [error, setError] = useState<string>();
  const params = new URLSearchParams(window.location.search);
  const owner = params.get("owner");
  const container = params.has("container");

  useEffect(() => {
    if (!owner) return;
    const client = createBrowserNodeClient({
      nodeId: "bk_cursor-recording-owner" as BackendId,
      transport: { baseUrl: owner },
    });
    const scope = windowScope.open({ role: "leaf", client });
    let cancelled = false;
    void client.invokeRaw<Message[]>("cursor_recording_fixture", { container }).then(
      (messages) => {
        if (!cancelled) setFixture({ scope, messages });
      },
      (failure: unknown) => {
        if (!cancelled) setError(String(failure));
      },
    );
    return () => {
      cancelled = true;
      scope.dispose();
    };
  }, [windowScope, owner, container]);

  return (
    <main className="mx-auto max-w-3xl p-4">
      <section aria-label="Recordings">
        {error && <p role="alert">{error}</p>}
        {fixture && (
          <NodeScopeProvider scope={fixture.scope}>
            {fixture.messages.map((message) => (
              <NativeMessage
                key={message.id}
                message={message}
                platform="cursor"
                containerId={container ? "fixture-container" : undefined}
              />
            ))}
          </NodeScopeProvider>
        )}
      </section>
    </main>
  );
}
