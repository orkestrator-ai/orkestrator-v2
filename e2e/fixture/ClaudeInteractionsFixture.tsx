import { useEffect, useState } from "react";
import type {
  AgentInteractionSnapshot,
  AgentInteractionResolution,
} from "@orkestrator/protocol/agent-interactions";
import { NativeAgentInteractionCard } from "../../apps/web/src/components/native-agent/NativeAgentInteractionCard";
import { NativeAgentQuestionCard } from "../../apps/web/src/components/native-agent/NativeAgentQuestionCard";

function ActiveInteractions({ session }: { session: string }) {
  const [snapshot, setSnapshot] = useState<AgentInteractionSnapshot>();
  const [activity, setActivity] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const response = await fetch(`/__claude-test/snapshot?session=${session}`, {
          signal: controller.signal,
        });
        const value = await response.json();
        if (!controller.signal.aborted) {
          setSnapshot(value.snapshot);
          setActivity(value.activity);
        }
      } catch {
        if (!controller.signal.aborted) setError("Could not refresh interactions");
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 200);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [session]);
  const resolve = async (resolution: AgentInteractionResolution) => {
    const response = await fetch(`/__claude-test/resolve?session=${session}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(resolution),
    });
    return response.json();
  };
  const hold = async (interactionId: string, held: boolean) => {
    const response = await fetch(`/__claude-test/hold?session=${session}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ interactionId, held }),
    });
    return response.json();
  };
  return (
    <main className="mx-auto max-w-xl p-4">
      <p role="status">{activity}</p>
      {error ? <p role="alert">{error}</p> : null}
      {snapshot?.requests.map((interaction) =>
        interaction.kind === "question" ? (
          <NativeAgentQuestionCard
            key={interaction.id}
            interaction={interaction}
            onResolve={resolve}
            onHold={(held) => hold(interaction.id, held)}
          />
        ) : (
          <NativeAgentInteractionCard
            key={interaction.id}
            interaction={interaction}
            onResolve={resolve}
            onApproveAndRemember={
              session === "codex-host"
                ? async (choice) => {
                    const response = await fetch("/__claude-test/remember", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ id: interaction.id, choice }),
                    });
                    return response.json();
                  }
                : undefined
            }
            onHold={(held) => hold(interaction.id, held)}
          />
        ),
      )}
    </main>
  );
}

export function ClaudeInteractionsFixture() {
  const [away, setAway] = useState(false);
  const session = new URLSearchParams(window.location.search).get("session") ?? "";
  return (
    <>
      <button onClick={() => setAway(!away)}>
        {away ? "Return to environment" : "Switch environment"}
      </button>
      {away ? <p>Other environment</p> : <ActiveInteractions session={session} />}
    </>
  );
}
