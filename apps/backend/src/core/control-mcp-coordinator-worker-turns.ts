import type { McpServer } from "@modelcontextprotocol/server";
import { PUBLIC_API_LIMITS } from "@orkestrator/protocol/public-api";
import { z } from "zod";
import type { CoordinatorControlScope } from "./control-mcp-tools.js";
import type { ControlMcpInvoker } from "./control-shared-actions.js";
import { readAnnotations, toolResult, type JsonRecord } from "./control-mcp-tool-support.js";

/**
 * The main coordinator's controls over one worker tab's turn: stop the
 * running turn, list the tab's slash commands, run one. Each calls one
 * `*_coordinator_*` backend command (`coordinator-worker-turn-actions.ts`)
 * with the authenticated scope, which revalidates it and refuses the project
 * home. All three take `nodeId` for a worker on a connected node.
 */

export const WORKER_TURN_TOOL_CAPABILITIES: ReadonlyArray<readonly [string, string]> = [
  // Main coordinator only, like send_prompt_to_tab: side agents lack `jobs`.
  ["stop_worker_turn", "jobs"],
  ["list_worker_commands", "jobs"],
  ["run_worker_command", "jobs"],
];

const requestId = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .describe("Stable key for this action; reuse it only to retry the same call.");
const environmentId = z.string().trim().min(1).max(200);
const tabId = z.string().trim().min(1).max(200).describe("A native agent tab (list_tabs).");
const nodeId = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .optional()
  .describe("The worker's nodeId from list_nodes; omit for this node.");

const ASYNC_COMMAND = {
  delivery: "async",
  wake: "This conversation will be woken with a message when the worker's turn ends. Progress the worker sends before then is held and delivered with that wake, so silence means it is still working.",
  nextStep: "Finish your turn now. Do not poll.",
};

export function registerCoordinatorWorkerTurnTools(
  server: McpServer,
  invoke: ControlMcpInvoker,
  scope: CoordinatorControlScope,
): void {
  const call = async (command: string, input: JsonRecord) =>
    invoke<JsonRecord>(command, {
      scope: {
        projectId: scope.projectId,
        coordinatorId: scope.coordinatorId,
        conversationId: scope.conversationId,
      },
      input,
    });

  server.registerTool(
    "stop_worker_turn",
    {
      title: "Stop a worker tab's running turn",
      description:
        "Stop the turn that is running in one native agent tab of a worker environment of this project, as the tab's Stop button does. The environment keeps running and the tab keeps its conversation; to stop the whole environment use stop_environment. Use it for a runaway or wrong-direction turn; to change what a busy worker is doing without ending its turn, prefer send_message with deliverNow. An idle tab answers stopped: false (not an error; do not retry). Terminal and tmux tabs are refused. If you were waiting on that tab's report, you are still woken once when the turn ends, with whatever the worker had sent, and the notice says you stopped it. Pass nodeId for a worker on another connected node.",
      inputSchema: z.object({ requestId, environmentId, tabId, nodeId }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const result = await call("stop_coordinator_worker_turn", input);
      if (result.stopped !== true) return toolResult(result);
      return toolResult({
        ...result,
        ...(result.delegationOpen === true
          ? {
              delivery: "async",
              wake: "You were waiting on this tab's report: you will be woken once with what the worker had sent, and the notice says you stopped the turn.",
              nextStep: "Finish your turn now. Do not poll.",
            }
          : {
              nextStep:
                "Nothing will wake you about this tab. Give it its next instruction with send_prompt_to_tab when you are ready.",
            }),
      });
    },
  );

  server.registerTool(
    "list_worker_commands",
    {
      title: "List a worker tab's slash commands",
      description:
        "List the slash commands one native agent tab of a worker offers (its agent's own commands, skills and templates, and Orkestrator's session actions), with each one's id, arguments policy, whether it runs only when idle, and its availability. Commands that act on a running turn (/steer) are not listed: use send_message with deliverNow for those. If catalogue.status is unknown or stale, call again with refresh: true. Run one with run_worker_command. Pass nodeId for a worker on another connected node.",
      inputSchema: z
        .object({
          environmentId,
          tabId,
          refresh: z.boolean().optional().describe("Ask the agent to re-read its commands first."),
          nodeId,
        })
        .strict(),
      annotations: readAnnotations(),
    },
    async (input) => toolResult(await call("list_coordinator_worker_commands", input)),
  );

  server.registerTool(
    "run_worker_command",
    {
      title: "Run a slash command in a worker tab",
      description:
        "Run one slash command (from list_worker_commands) in an idle native agent tab of a worker, exactly as if it were picked from that tab's / menu: name it by id or by name, with its arguments verbatim. A command that is missing, ambiguous, unavailable, changed since you listed it (expectedBindingRevision), or given the wrong arguments is refused, and is never sent as an ordinary prompt instead. A busy tab is refused, like send_prompt_to_tab; /steer is refused (use send_message with deliverNow). A command that starts an agent turn is a delegation: you are woken once when that turn ends. One that answers without a turn (a local command, /compact) returns at once and wakes nothing; read its output with get_tab_transcript. Pass nodeId for a worker on another connected node; if its answer is lost, retry with the same requestId, which the node replays.",
      inputSchema: z
        .object({
          requestId,
          environmentId,
          tabId,
          command: z
            .string()
            .trim()
            .min(1)
            .max(500)
            .describe(
              'The command id, or its name with or without the sigil ("review", "/review").',
            ),
          arguments: z
            .string()
            .max(PUBLIC_API_LIMITS.commandArgumentsMaxBytes)
            .optional()
            .describe("The command's arguments, verbatim."),
          expectedBindingRevision: z
            .string()
            .trim()
            .min(1)
            .max(200)
            .optional()
            .describe(
              "The bindingRevision list_worker_commands gave; refuses a command that changed since.",
            ),
          nodeId,
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) => {
      const result = await call("run_coordinator_worker_command", input);
      if (result.delegationOpened === true) return toolResult({ ...result, ...ASYNC_COMMAND });
      return toolResult({
        ...result,
        ...(result.startsTurn === true
          ? {}
          : {
              nextStep:
                "This command ran without an agent turn and wakes nothing. Read its output with get_tab_transcript on the same tab.",
            }),
      });
    },
  );
}
