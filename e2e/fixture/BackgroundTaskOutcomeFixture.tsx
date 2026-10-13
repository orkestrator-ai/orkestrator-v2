import { useState } from "react";
import { NativeMessage } from "../../apps/web/src/components/chat/NativeMessage";
import { rowlessBackgroundTaskMessages } from "../../apps/web/src/lib/chat/native-message-adapters";
import type {
  NativeBackgroundTask,
  NativeMessage as Message,
} from "../../apps/web/src/lib/chat/native-message-types";

const outcomeTask = {
  id: "outcome-task",
  description: "Review validation",
  status: "failed",
  settledAt: "2026-08-16T10:02:00.000Z",
  error: "Validation failed",
  summary: "Two checks failed",
  outputFile: "/tmp/tasks/shared.output",
  usage: { totalTokens: 12_000, toolUses: 7, durationMs: 1_000 },
} satisfies NativeBackgroundTask;

export function BackgroundTaskOutcomeFixture() {
  const params = new URLSearchParams(window.location.search);
  const [loaded, setLoaded] = useState(params.has("loaded"));
  const [away, setAway] = useState(false);
  const [stopped, setStopped] = useState(params.has("stopped"));
  const [startedAt] = useState(() => new Date(Date.now() - 125_000).toISOString());
  const running = params.has("running");
  const task = (
    running
      ? {
          id: "running-task",
          description: "Review validation",
          status: stopped ? "killed" : "running",
          startedAt,
          usage: { totalTokens: 12_000, toolUses: 7, durationMs: 1_000 },
        }
      : outcomeTask
  ) satisfies NativeBackgroundTask;
  const toolName = params.get("tool") ?? "Agent";
  const containerId = params.has("container") ? "fixture-container" : undefined;
  const launch: Message = {
    id: "loaded-outcome",
    role: "assistant",
    content: "",
    createdAt: "2026-08-16T10:00:00.000Z",
    parts: [
      {
        type: "task-group",
        content: toolName,
        childTools: [],
        task: {
          type: "tool-invocation",
          content: toolName,
          toolName,
          toolTitle: toolName,
          toolUseId: "loaded-launch",
          toolState: "success",
          toolArgs: { description: task.description, run_in_background: true },
          backgroundTask: task,
        },
      },
    ],
  };
  const loadLaunch = () => {
    params.set("loaded", "1");
    window.history.replaceState(null, "", `?${params}`);
    setLoaded(true);
  };
  return (
    <main className="min-h-screen bg-background p-4 text-foreground">
      <div className="mb-4 flex gap-4">
        <button onClick={loadLaunch}>Load launch</button>
        <button onClick={() => setAway(!away)}>
          {away ? "Return to task" : "Switch environment"}
        </button>
      </div>
      {away ? (
        <p>Other environment</p>
      ) : (
        <NativeMessage
          platform="claude"
          stopBackgroundTask={
            running
              ? async () => {
                  params.set("stopped", "1");
                  window.history.replaceState(null, "", `?${params}`);
                  setStopped(true);
                  return true;
                }
              : undefined
          }
          containerId={containerId}
          message={
            loaded ? launch : rowlessBackgroundTaskMessages([task], [{ ...launch, parts: [] }])[0]!
          }
        />
      )}
    </main>
  );
}
