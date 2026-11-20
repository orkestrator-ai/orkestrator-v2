import { MessagePart } from "@/components/chat/NativeMessage.renderer";
import { NativeMessagePartRendererContext } from "@/components/chat/NativeMessage.shared";
import { ToolGroupPart } from "@/components/chat/NativeMessage.tool-group";
import { SetupPendingOverlay } from "@/components/setup/SetupPendingOverlay";
import { CriterionStatusIcon } from "@/components/tickets/criterion-status";
import { TodoToolPart } from "@/components/todo/TodoToolPart";
import { environmentStore, useEnvironmentStore } from "@/stores/environmentStore";
import { appCommandStore } from "@/test/app-command-store";
import type { Environment } from "@/types";

const environment: Environment = {
  id: "status-readability",
  projectId: "fixture",
  name: "Setup fixture",
  branch: "fixture",
  containerId: null,
  status: "error",
  environmentType: "local",
  setupPhase: "failed",
  setupScriptsComplete: false,
  order: 0,
  createdAt: "2026-10-20T10:00:00.000Z",
  networkAccessMode: "restricted",
  prUrl: null,
  prState: null,
  hasMergeConflicts: null,
};

export function installStatusReadabilityFixture() {
  appCommandStore(environmentStore).setState({ environments: [environment] });
  window.orkestrator = {
    ...window.orkestrator!,
    invoke: async <T,>(command: string) => {
      if (command !== "run_environment_setup") throw new Error(command);
      return new Promise<T>((resolve) => {
        window.addEventListener(
          "finish-fixture-retry",
          () => {
            resolve({ ...environment, setupPhase: "running" } as T);
          },
          { once: true },
        );
      });
    },
  };
}

export function StatusReadabilityFixture() {
  const phase = useEnvironmentStore((state) => state.environments[0]?.setupPhase);
  return (
    <main className="mx-auto grid max-w-3xl gap-4 bg-background p-3 text-foreground">
      <div className="min-w-0" data-testid="status-readability">
        <TodoToolPart
          toolName="TodoWrite"
          toolState="success"
          toolArgs={{
            todos: [
              { id: "1", content: "Gather requirements", status: "completed" },
              { id: "2", content: "Draft implementation", status: "in_progress" },
              { id: "3", content: "Retire obsolete fixture", status: "cancelled" },
              { id: "4", content: "Verify results", status: "pending" },
            ],
          }}
        />
        <TodoToolPart
          toolName="TaskList"
          toolState="success"
          taskSnapshot={{
            items: [{ id: "6", subject: "Review current snapshot", status: "pending" }],
            complete: false,
            truncated: 2,
          }}
        />
        <TodoToolPart
          toolName="TaskList"
          toolState="success"
          taskSnapshot={{ items: [], complete: true }}
        />
        <NativeMessagePartRendererContext.Provider value={MessagePart}>
          <ToolGroupPart
            partKey="timed-tools"
            part={{
              type: "tool-group",
              content: "",
              parts: ["git status", "git diff", "git diff --stat HEAD~1"].map((command, index) => ({
                type: "tool-invocation",
                content: command,
                toolName: "Bash",
                toolArgs: { command },
                toolState: index === 0 ? "failure" : "success",
                toolUseId: `status-call-${index}`,
                createdAt: `2026-10-20T10:00:0${index}.000Z`,
                toolDurationMs: 250,
              })),
            }}
          />
        </NativeMessagePartRendererContext.Provider>
        <div className="flex gap-2 px-2 py-1 text-xs">
          <CriterionStatusIcon state="unchecked" />
          <span>Verify the task summary</span>
        </div>
        <SetupPendingOverlay
          environmentId={environment.id}
          setupPhase={phase}
          subtext="The agent will connect automatically"
          pendingPrompt={{ text: "Verify the fixture", createdAt: environment.createdAt }}
        />
      </div>
      <span data-testid="muted-color" className="sr-only text-muted-foreground">
        Muted color reference
      </span>
    </main>
  );
}
