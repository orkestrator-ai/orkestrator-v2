import { useState } from "react";
import { NativeMessage } from "../../apps/web/src/components/chat/NativeMessage";
import {
  applyClaudeBackgroundTaskStates,
  normalizeNativeMessages,
} from "../../apps/web/src/lib/chat/native-message-adapters";
import { pinNativeAgentParts } from "../../apps/web/src/lib/chat/native-agent-pinning";
import type { NativeMessage as Message } from "../../apps/web/src/lib/chat/native-message-types";

const launch: Message = {
  id: "old-launch",
  createdAt: "2026-08-16T10:00:00.000Z",
  role: "assistant",
  content: "",
  parts: [
    {
      type: "tool-invocation",
      content: "Agent",
      toolName: "Agent",
      toolUseId: "orphan",
      toolState: "pending",
      toolArgs: { description: "Review the bridge" },
    },
  ],
};

export function EndedAgentFixture() {
  const [phase, setPhase] = useState(
    new URLSearchParams(location.search).get("phase") ?? "running",
  );
  const [away, setAway] = useState(false);
  const changePhase = (value: string) => {
    history.replaceState(null, "", `?phase=${value}`);
    setPhase(value);
  };
  const source: Message[] =
    phase === "later"
      ? [
          launch,
          {
            id: "new-prompt",
            createdAt: "2026-08-16T11:00:00.000Z",
            role: "user",
            content: "Continue",
            parts: [{ type: "text", content: "Continue" }],
          },
        ]
      : [launch];
  const messages = pinNativeAgentParts(
    normalizeNativeMessages(
      applyClaudeBackgroundTaskStates(
        source,
        phase === "later" ? { shell: { id: "shell", kind: "shell", status: "running" } } : {},
        { turnSettled: phase === "settled" },
      ),
    ),
  );
  return (
    <main className="bg-background text-foreground p-4">
      <div className="flex flex-wrap gap-4 mb-4">
        <button onClick={() => changePhase("settled")}>Settle turn</button>
        <button onClick={() => changePhase("later")}>Start unrelated turn</button>
        <button onClick={() => setAway(!away)}>{away ? "Return" : "Switch environment"}</button>
      </div>
      {away ? (
        <p>Other environment</p>
      ) : (
        messages.map((message) => (
          <NativeMessage key={message.id} message={message} platform="claude" />
        ))
      )}
    </main>
  );
}
