import { NativeMessage } from "../../apps/web/src/components/chat/NativeMessage";
import type { NativeMessagePart } from "../../apps/web/src/lib/chat/native-message-types";

export function AgentUsageFixture() {
  const path = new URLSearchParams(window.location.search).get("path") ?? "subagent";
  const scenarios = [
    { id: "full", tokenCountText: "1.2m tokens", toolUseCount: 8 },
    { id: "updates" },
    { id: "cursor", platform: "cursor" as const, tokenCountText: "980 tokens", toolUseCount: 8 },
    {
      id: "token-only",
      agentUsageDisplay: "token-only" as const,
      tokenCountText: "1 token",
      toolUseCount: 8,
    },
    { id: "auto", tokenCountText: "auto" },
    { id: "bare", tokenCountText: "980" },
    { id: "empty", empty: true },
  ];
  return (
    <main className="min-h-screen bg-background p-4 text-foreground">
      <div className="mx-auto max-w-3xl space-y-4">
        {scenarios.map(({ id, platform, empty, ...usage }) => {
          const actions: NativeMessagePart[] = empty
            ? []
            : [
                {
                  type: "tool-invocation",
                  content: "Read source",
                  toolName: "Read",
                  toolState: "success",
                },
                { type: "text", content: "Checking compact usage layout and accessible labels." },
              ];
          const fields = {
            toolState: "success" as const,
            toolArgs: {
              description: "Review the compact usage presentation with a long descriptive header",
              durationMs: 125_000,
            },
            ...usage,
          };
          const part: NativeMessagePart =
            path === "subagent"
              ? {
                  type: "subagent",
                  content: "Reviewer",
                  subagentName: fields.toolArgs.description,
                  subagentActions: actions,
                  subagentActionCount: actions.filter((part) => part.type === "tool-invocation")
                    .length,
                  ...fields,
                }
              : {
                  type: "task-group",
                  content: "Agent",
                  childTools: actions,
                  task: { type: "tool-invocation", content: "Agent", toolName: "Agent", ...fields },
                };
          return (
            <section key={id} aria-label={id}>
              <NativeMessage
                platform={platform ?? "claude"}
                message={{
                  id: `usage-${id}`,
                  role: "assistant",
                  content: "",
                  createdAt: "2026-03-21T10:00:00.000Z",
                  parts: [part],
                }}
              />
            </section>
          );
        })}
      </div>
    </main>
  );
}
