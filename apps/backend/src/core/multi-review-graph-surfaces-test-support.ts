/**
 * A graph-engine Multi Review world with the coordinator surfaces wired over
 * the same store (item 301): the real command registry, a real coordinator
 * workspace and status wakes, and the real control MCP server, so a test
 * drives `launch_multi_review`, `get_multi_review` and the wakes exactly as a
 * coordinator conversation does. Only the agents and the graph clock are
 * simulated (`multi-review-graph-test-support.ts`).
 */
import { coordinatorRuntimeId } from "@orkestrator/protocol/coordinator";
import type { MultiReviewWorkflow } from "@orkestrator/protocol/multi-review";
import type { CommandContext } from "./commands-context.js";
import { createCommandRegistry } from "./commands-registry.js";
import { ControlMcpServer } from "./control-mcp-server.js";
import { CoordinatorService } from "./coordinator-service.js";
import {
  graphReviewGap,
  graphReviewIssue,
  graphReviewReport,
  graphReviewWorld,
  type GraphReviewWorld,
} from "./multi-review-graph-test-support.js";
import type { MultiReviewServiceOptions } from "./multi-review-service.js";
import { runCommand } from "./shell.js";

/**
 * Reviewer N reports one issue and one gap; consolidation cites both
 * reviewers' issues and the second reviewer's gap. The Fix completes unless
 * `complete` is false.
 */
export function scriptGraphReview(
  w: GraphReviewWorld,
  options: { findings: boolean; complete?: boolean },
): void {
  w.fakes.scripts.set("review", ({ port, branchKey }) =>
    port === "report"
      ? graphReviewReport(
          options.findings
            ? {
                issues: [graphReviewIssue(`Issue from ${branchKey}`)],
                testCoverageGaps: [graphReviewGap("Failure branch")],
                verdict: { ready: "with-fixes", reasoning: "Fix first" },
              }
            : {},
        )
      : undefined,
  );
  w.fakes.scripts.set("consolidate", ({ port }) =>
    port === "report"
      ? graphReviewReport(
          options.findings
            ? {
                issues: [
                  {
                    ...graphReviewIssue("Merged issue"),
                    reviewSourceIds: ["review/panel.1/issue-1", "review/panel.2/issue-1"],
                  },
                ],
                testCoverageGaps: [
                  {
                    ...graphReviewGap("Failure branch"),
                    reviewSourceIds: ["review/panel.2/coverage-gap-1"],
                  },
                ],
                verdict: { ready: "with-fixes", reasoning: "Fix first" },
              }
            : {},
        )
      : undefined,
  );
  const complete = options.complete ?? true;
  w.fakes.scripts.set("fix", ({ port }) =>
    port === "result"
      ? {
          complete,
          summary: complete ? "Fixed" : "One finding remains",
          filesChanged: ["src/a.ts"],
          commandsRun: [],
          notes: [],
          limitations: complete ? [] : ["One finding needs a design decision"],
        }
      : undefined,
  );
}

export interface GraphCoordinatorWorld {
  w: GraphReviewWorld;
  context: CommandContext;
  commands: ReturnType<typeof createCommandRegistry>;
  coordinators: CoordinatorService;
  scope: { projectId: string; coordinatorId: string; conversationId: string };
  /** Calls a control MCP tool with this conversation's coordinator credential. */
  tool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  /** The notice states in the coordinator's inbox, oldest first. */
  notices(): Promise<string[]>;
  /** One Multi Review pass, one wake reconciliation, then one graph pass. */
  drive(
    workflowId: string,
    until: (workflow: MultiReviewWorkflow) => boolean,
    passes?: number,
  ): Promise<MultiReviewWorkflow>;
  close(): Promise<void>;
}

export interface ToolResult {
  isError?: boolean;
  structuredContent: Record<string, unknown>;
}

export async function graphCoordinatorWorld(
  options: { serviceOptions?: Partial<MultiReviewServiceOptions> } = {},
): Promise<GraphCoordinatorWorld> {
  const w = await graphReviewWorld(options);
  const storage = w.fixture.storage;
  // The Multi Review tab opens only on an environment that finished setup.
  await storage.updateEnvironment(w.environmentId, { setupPhase: "ready" });
  // A coordinator workspace needs the project's checkout to be a repository.
  await runCommand("git", ["init", "-q", "-b", "main", w.fixture.checkout]);
  const coordinators = new CoordinatorService(
    storage,
    () => ({ enabled: true, running: true, error: null }),
    undefined,
    undefined,
    // Every notice is its own message, so a test counts wakes, not merges.
    { coalesceMs: 0 },
  );
  const snapshot = await coordinators.ensure(w.projectId);
  const scope = {
    projectId: w.projectId,
    coordinatorId: snapshot.workspace.id,
    conversationId: snapshot.workspace.conversations[0]!.id,
  };
  const context = {
    storage,
    coordinators,
    multiReviews: w.service,
    emit: () => undefined,
  } as unknown as CommandContext;
  const commands = createCommandRegistry();
  let server: ControlMcpServer | null = null;
  let credential: { url: string; token: string } | null = null;
  const conversationTab = async () => {
    const workspace = (await storage.coordinators.getCoordinatorWorkspace(scope.projectId))!;
    return workspace.conversations.find((item) => item.id === scope.conversationId)!;
  };
  const world: GraphCoordinatorWorld = {
    w,
    context,
    commands,
    coordinators,
    scope,
    async tool(name, args) {
      if (!server) {
        server = new ControlMcpServer(
          storage.getDataDir(),
          async <T>(command: string, commandArgs: Record<string, unknown> = {}) => {
            const handler = commands.get(command);
            if (!handler) throw new Error(`unexpected command ${command}`);
            return (await handler(commandArgs, context)) as T;
          },
          { port: 0 },
        );
        await server.start();
        credential = server.issueCoordinatorCredential({
          role: "coordinator",
          ...scope,
          mailboxIncarnationId: (await conversationTab()).mailboxIncarnationId!,
          capabilities: ["multi-review"],
        });
      }
      const response = await fetch(credential!.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credential!.token}`,
          Accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });
      const payload = await response.text();
      const json = response.headers.get("content-type")?.startsWith("text/event-stream")
        ? payload
            .split("\n")
            .find((line) => line.startsWith("data: "))!
            .slice(6)
        : payload;
      const parsed = JSON.parse(json) as { result?: ToolResult; error?: { message: string } };
      if (!parsed.result) throw new Error(parsed.error?.message ?? "no tool result");
      return parsed.result;
    },
    async notices() {
      const conversation = await conversationTab();
      const inbox = await storage.getAgentMailMailbox(
        coordinatorRuntimeId(scope.coordinatorId, scope.conversationId),
        conversation.tabId,
      );
      return inbox.messages.flatMap((message) =>
        message.notice?.state ? [message.notice.state] : [],
      );
    },
    async drive(workflowId, until, passes = 120) {
      for (let index = 0; index < passes; index++) {
        await w.service.advanceNow(workflowId);
        const current = await w.workflow(workflowId);
        const runId = current.graphRun?.runId;
        // What the save listeners would trigger: the review's own
        // observation, then the graph run's (which no coordinator owns).
        await coordinators.statusWakes.observeWorkflow("multi-review", workflowId);
        if (runId) await coordinators.statusWakes.observeWorkflow("graph-run", runId);
        await coordinators.reconcileWorkflowNotifications();
        if (until(current)) return current;
        if (runId) {
          w.time.jump(3_000);
          await w.graphRuns.advanceNow(runId);
        }
      }
      throw new Error("the review did not reach the expected state");
    },
    async close() {
      if (server) await (server as ControlMcpServer).stop();
      coordinators.stopStatusWakes();
      await w.close();
    },
  };
  return world;
}
